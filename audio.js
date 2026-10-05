/* 音声の処理（ブラウザと Node の両方で動く。Buffer も DOM も使わない）
   Gemini TTS の返りは 24kHz・モノラル・16bit の WAV。ここでは Int16Array のサンプル列で扱う。
   無音の切り取りと音量そろえは、作者の動画ナレーション用スクリプト（make-narration.mjs）と同じやり方。 */

export const RATE = 24000;

export function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const ascii = (bytes, at, n) => String.fromCharCode(...bytes.subarray(at, at + n));

export function isWav(bytes) {
  return bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WAVE";
}

// fmt と data のチャンクを探す（fmt の後に LIST などが挟まることがある）
export function parseWav(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let rate = RATE;
  let channels = 1;
  let bits = 16;
  let p = 12;
  while (p + 8 <= bytes.length) {
    const id = ascii(bytes, p, 4);
    const size = dv.getUint32(p + 4, true);
    if (id === "fmt ") {
      channels = dv.getUint16(p + 10, true);
      rate = dv.getUint32(p + 12, true);
      bits = dv.getUint16(p + 22, true);
    } else if (id === "data") {
      const start = p + 8;
      const len = Math.min(size, bytes.length - start);
      if (bits !== 16) throw new Error(`16bit 以外の WAV は扱えません（${bits}bit）`);
      const frames = Math.floor(len / 2 / channels);
      const samples = new Int16Array(frames);
      // 2ch 以上なら1ch目だけ取る（TTS は常にモノラルなので念のため）
      for (let i = 0; i < frames; i++) samples[i] = dv.getInt16(start + i * 2 * channels, true);
      return { rate, samples };
    }
    p += 8 + size + (size % 2);
  }
  throw new Error("WAV の data チャンクが見つかりません");
}

export function pcmToWav(samples, rate = RATE) {
  const out = new Uint8Array(44 + samples.length * 2);
  const dv = new DataView(out.buffer);
  const put = (at, s) => { for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i); };
  put(0, "RIFF");
  dv.setUint32(4, 36 + samples.length * 2, true);
  put(8, "WAVE");
  put(12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, rate, true);
  dv.setUint32(28, rate * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  put(36, "data");
  dv.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) dv.setInt16(44 + i * 2, samples[i], true);
  return out;
}

// API が生の PCM（audio/l16）で返した場合も、WAV でも、同じ形にそろえる
export function decodeAudioBytes(bytes, rate = RATE) {
  if (isWav(bytes)) return parseWav(bytes);
  const n = bytes.length >> 1;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, n * 2);
  const samples = new Int16Array(n);
  for (let i = 0; i < n; i++) samples[i] = dv.getInt16(i * 2, true);
  return { rate, samples };
}

export const seconds = (samples, rate = RATE) => samples.length / rate;

// 前後の無音を詰める（TTS は前後に 0.3 秒ほど無音を付けて返す）。
// 話し始めの 40ms 手前から、話し終わりの 150ms 後までを残し、端は 10ms でフェードする。
export function trimSilence(samples, rate = RATE) {
  const n = samples.length;
  const thr = 32768 * 0.012;
  let a = 0;
  while (a < n && Math.abs(samples[a]) < thr) a++;
  if (a >= n) return samples.slice();
  let b = n - 1;
  while (b > a && Math.abs(samples[b]) < thr) b--;
  a = Math.max(0, a - Math.round(rate * 0.04));
  b = Math.min(n - 1, b + Math.round(rate * 0.15));
  const out = samples.slice(a, b + 1);
  const f = Math.min(Math.round(rate * 0.01), out.length >> 1);
  for (let i = 0; i < f; i++) {
    out[i] = Math.round((out[i] * i) / f);
    out[out.length - 1 - i] = Math.round((out[out.length - 1 - i] * i) / f);
  }
  return out;
}

// 話している所の平均の大きさ（active RMS: |x|>0.01 の所の二乗平均）を dB で
export function activeDb(samples) {
  let sum = 0;
  let cnt = 0;
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i] / 32768;
    if (Math.abs(x) > 0.01) {
      sum += x * x;
      cnt++;
    }
  }
  return cnt ? 10 * Math.log10(sum / cnt) : -Infinity;
}

// 音量をそろえる。active RMS を targetDb にし、ピークを ceilDb で抑える（先読み2ms・戻り80ms の簡単なリミッター）。
// 声ごとに素の音量が違い（Leda は Zephyr より約3dB大きい）、大きい方が良く聞こえて比べるときに歪むため。
export function levelSamples(samples, rate = RATE, targetDb = -16, ceilDb = -1) {
  const n = samples.length;
  const rmsDb = activeDb(samples);
  if (!Number.isFinite(rmsDb)) return { samples: samples.slice(), rmsDb, gainDb: 0, limitedPct: 0 };
  const gain = 10 ** ((targetDb - rmsDb) / 20);
  const ceil = 10 ** (ceilDb / 20);
  // r[i]: その標本をピーク以下に収めるのに要る倍率
  const r = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.abs((samples[i] / 32768) * gain);
    r[i] = a > ceil ? ceil / a : 1;
  }
  // 前後 L 標本の最小値（単調キューで O(n)）
  const L = Math.round(rate * 0.002);
  const m = new Float32Array(n);
  const q = new Int32Array(n);
  let head = 0;
  let tail = 0;
  let j = 0;
  for (let i = 0; i < n; i++) {
    const hi = Math.min(n - 1, i + L);
    for (; j <= hi; j++) {
      while (tail > head && r[q[tail - 1]] >= r[j]) tail--;
      q[tail++] = j;
    }
    while (q[head] < i - L) head++;
    m[i] = r[q[head]];
  }
  const rel = Math.exp(-1 / (rate * 0.08));
  const out = new Int16Array(n);
  let g = 1;
  let limited = 0;
  for (let i = 0; i < n; i++) {
    g = m[i] < g ? m[i] : m[i] - (m[i] - g) * rel;
    if (g < 0.999) limited++;
    const v = Math.max(-ceil, Math.min(ceil, (samples[i] / 32768) * gain * g));
    out[i] = Math.round(v * 32767);
  }
  return { samples: out, rmsDb, gainDb: targetDb - rmsDb, limitedPct: (100 * limited) / n };
}

export function concatSamples(list, rate = RATE, gapSec = 0.3) {
  const gap = Math.round(rate * gapSec);
  const total = list.reduce((a, s) => a + s.length, 0) + gap * Math.max(0, list.length - 1);
  const out = new Int16Array(total);
  let p = 0;
  list.forEach((s, k) => {
    out.set(s, p);
    p += s.length + (k < list.length - 1 ? gap : 0);
  });
  return out;
}

// 無音の区間（秒）。10ms ごとの大きさが閾値より小さい所が minGap 秒以上続いたら1つの無音とする。
// 返す配列の先頭・末尾には話し始め前・話し終わり後の無音も入りうる。speechStart / speechEnd も返す。
export function findSilences(samples, rate = RATE, { minGap = 0.15, thrDb = -40 } = {}) {
  const hop = Math.round(rate * 0.01);
  const frames = Math.floor(samples.length / hop);
  const thr = 10 ** (thrDb / 20);
  const loud = new Uint8Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let i = f * hop; i < (f + 1) * hop; i++) {
      const x = samples[i] / 32768;
      sum += x * x;
    }
    loud[f] = Math.sqrt(sum / hop) > thr ? 1 : 0;
  }
  const first = loud.indexOf(1);
  const last = loud.lastIndexOf(1);
  const silences = [];
  if (first < 0) return { silences, speechStart: 0, speechEnd: 0 };
  let f = first;
  while (f <= last) {
    if (loud[f]) { f++; continue; }
    let g = f;
    while (g <= last && !loud[g]) g++;
    if ((g - f) * 0.01 >= minGap) silences.push({ start: f * 0.01, end: g * 0.01 });
    f = g;
  }
  return { silences, speechStart: first * 0.01, speechEnd: (last + 1) * 0.01 };
}

// 波形の表示用。buckets 個の区間ごとの最大振幅（0〜1）
export function peaks(samples, buckets = 200) {
  const out = new Float32Array(buckets);
  const step = samples.length / buckets;
  for (let b = 0; b < buckets; b++) {
    let mx = 0;
    const end = Math.min(samples.length, Math.floor((b + 1) * step));
    for (let i = Math.floor(b * step); i < end; i++) {
      const a = Math.abs(samples[i]);
      if (a > mx) mx = a;
    }
    out[b] = mx / 32768;
  }
  return out;
}

export function floatToInt16(f32) {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) out[i] = Math.round(Math.max(-1, Math.min(1, f32[i])) * 32767);
  return out;
}
