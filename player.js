/* ストリーミング再生（ブラウザ専用、Web Audio）
   届いた音声の断片（Int16、24kHz）を、すき間なく順に鳴らす。
   - 断片は細かい（1回の生成で200個ほど）ので、0.2秒ぶん貯めてから1つの AudioBuffer にして予約する
   - 最初は lead 秒（既定0.3秒）ぶん先に予約して、届くのが少し遅れても途切れにくくする
   - 届くのが再生に追いつかなかったら、そこから続きを鳴らす（その分を stall に足して、再生位置の計算からずらす）
   AudioContext は「生成する」を押したときに作る（ブラウザは、ユーザーの操作なしに音を出させないため）。 */

export function createStreamPlayer({ rate = 24000, lead = 0.3, batch = 0.2 } = {}) {
  const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
  const ctx = new Ctx();
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  const sources = new Set();
  let pending = [];
  let pendingLen = 0;
  let received = 0;
  let started = false;
  let startAt = 0;
  let nextTime = 0;
  let stall = 0;
  let stopped = false;
  let ended = false;
  let onFinish = null;

  function schedule(force) {
    if (stopped || !pendingLen) return;
    if (!force && pendingLen < rate * batch) return;
    const buf = ctx.createBuffer(1, pendingLen, rate);
    const ch = buf.getChannelData(0);
    let p = 0;
    for (const s of pending) {
      for (let i = 0; i < s.length; i++) ch[p++] = s[i] / 32768;
    }
    pending = [];
    pendingLen = 0;
    const now = ctx.currentTime;
    if (!started) {
      started = true;
      startAt = now + lead;
      nextTime = startAt;
    } else if (nextTime < now + 0.03) {
      // 届くのが遅れて、鳴らすものが切れていた
      stall += now + 0.05 - nextTime;
      nextTime = now + 0.05;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start(nextTime);
    nextTime += buf.duration;
    sources.add(src);
    src.onended = () => {
      sources.delete(src);
      if (ended && !sources.size && !stopped) finish();
    };
  }

  function finish() {
    if (stopped) return;
    stopped = true;
    ctx.close().catch(() => {});
    if (onFinish) onFinish();
  }

  return {
    push(samples) {
      if (stopped || !samples.length) return;
      pending.push(samples);
      pendingLen += samples.length;
      received += samples.length;
      schedule(false);
    },
    // 受信が終わった（残りを鳴らしきったら onFinish を呼ぶ）
    end() {
      ended = true;
      schedule(true);
      // 音を出させてもらえなかった（ctx が止まったまま）ときは、ここで終わりにする。でないと「再生中」のまま残る
      if (!sources.size || ctx.state !== "running") finish();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      for (const s of sources) {
        try { s.stop(); } catch { /* もう止まっている */ }
      }
      sources.clear();
      ctx.close().catch(() => {});
    },
    // いま鳴っている位置（届いた音声の先頭からの秒数）
    position() {
      if (!started) return 0;
      return Math.max(0, Math.min(received / rate, ctx.currentTime - startAt - stall));
    },
    receivedSec: () => received / rate,
    active: () => !stopped,
    set onFinish(fn) { onFinish = fn; },
  };
}
