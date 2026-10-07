/* Gemini API（TTS と声のデザイン）の呼び出し。ブラウザと Node の両方で動く。
   リクエストの形は、作者の動画ナレーション用スクリプト（make-narration.mjs）の tts() と同じ。
   キーは x-goog-api-key ヘッダで送るだけで、URL にもログにも出さない。
   CORS は実測済み（2026-10-04、https://example.com から interactions / voices とも JS でレスポンスを読めた）。 */

import { base64ToBytes, decodeAudioBytes, isWav, parseWav, RATE } from "./audio.js";

export const API_BASE = "https://generativelanguage.googleapis.com/v1beta";

export const MODELS = [
  { id: "gemini-3.8-flash-tts", label: "Gemini 3.8 Flash TTS", note: "表現力が高い。掛け合い・長い文・声のデザインに" },
  { id: "gemini-3.8-flash-lite-tts", label: "Gemini 3.8 Flash-Lite TTS", note: "速くて安い。読み上げ向き" },
];

// 料金: 音声1秒＝25トークン。Flash TTS は $9/100万トークン（料金ページ、2026年末までの価格。2026-10-03 確認）。
// Flash-Lite の料金はまだ確かめていないので null（画面には「—」と出す）
export const TOKENS_PER_SEC = 25;
export const USD_PER_MTOK = { "gemini-3.8-flash-tts": 9, "gemini-3.8-flash-lite-tts": null };
export const YEN_PER_USD = 150;

export function costUsd(model, sec) {
  const p = USD_PER_MTOK[model];
  return p == null ? null : (sec * TOKENS_PER_SEC * p) / 1e6;
}

// mode: "solo"（1人）| "duo"（2人の掛け合い）
// parts: [{ text, style, speaker? }]、voice: 1人のときの声、speakers: [{ speaker, voice }]（2人のとき）
// keepLog: true なら、やりとりを Google 側のログに残す（設定画面の「Google 側の記録」。既定は残さない）
export function buildTtsBody({ model, mode, parts, voice, speakers, keepLog = false }) {
  const content = parts
    .filter((p) => p.text.trim())
    .map((p) => {
      const meta = { type: "speech_metadata" };
      if (mode === "duo") meta.speaker = p.speaker;
      if (p.style && p.style.trim()) meta.style = p.style.trim();
      return { type: "text", text: p.text, annotations: Object.keys(meta).length > 1 ? [meta] : [] };
    });
  return {
    model,
    input: [{ type: "user_input", content }],
    // Interactions API は既定で、やりとり（台本と作った音声）をプロジェクトのログに保存する（有料なら55日、AI Studio の Logs に出る）。
    // こえスタジオは会話の続き（previous_interaction_id）も background も使わないので、既定では保存しない（2026-10-07 に TTS でも通ることを確認）。
    // AI Studio で見返したい人は設定画面で残せる（keepLog）
    store: !!keepLog,
    response_format: { type: "audio" },
    generation_config: {
      speech_config: mode === "duo" ? { mode: "conversational", speakers: speakers.map(({ speaker, voice }) => ({ speaker, voice })) } : [{ voice }],
    },
  };
}

export class ApiError extends Error {
  constructor(message, { status = 0, apiStatus = "", retryAfter = null, detail = "", daily = false } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.apiStatus = apiStatus;
    this.retryAfter = retryAfter;
    this.detail = detail;
    this.daily = daily;
  }
}

// 「retry in 25s」「retry in 1m30s」「retry in 14h24m47s」を秒に
export function parseRetry(text) {
  const m = String(text).match(/retry in ((?:\d+h)?(?:\d+m(?!s))?(?:[\d.]+s)?)/i);
  if (!m || !m[1]) return null;
  const h = m[1].match(/(\d+)h/);
  const mi = m[1].match(/(\d+)m(?!s)/);
  const s = m[1].match(/([\d.]+)s/);
  return (h ? Number(h[1]) * 3600 : 0) + (mi ? Number(mi[1]) * 60 : 0) + (s ? Number(s[1]) : 0);
}

// 1日の回数は太平洋時間の0時に数え直される（日本時間の16時、冬時間なら17時）。
// 2026-10-05 に確かめた: 前日16時以降の97回＋当日13時の3回で上限、16時を過ぎたら通った。
// 429 の本文の「retry in 14h24m47s」は UTC の0時（日本時間の9時）を指していて、当てにならない。
export function secondsUntilPacificMidnight(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hourCycle: "h23", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(now)
      .map((p) => [p.type, p.value])
  );
  const elapsed = Number(parts.hour) * 3600 + Number(parts.minute) * 60 + Number(parts.second);
  return 24 * 3600 - elapsed;
}

// エラーの本文は {error:{…}} のことも、[{error:{…}}] と配列で包まれていることもある（interactions は配列だった）
export function parseError(status, raw, now = new Date()) {
  let j = null;
  try { j = JSON.parse(raw); } catch { /* JSON でなければ本文をそのまま使う */ }
  if (Array.isArray(j)) j = j[0];
  const e = (j && j.error) || {};
  const detail = e.message || String(raw || "").slice(0, 300);
  let retryAfter = parseRetry(detail);
  const ri = Array.isArray(e.details) ? e.details.find((d) => String(d["@type"] || "").includes("RetryInfo")) : null;
  if (retryAfter == null && ri && ri.retryDelay) retryAfter = parseFloat(ri.retryDelay);
  // Tier 1 は1分10回に加えて、モデルごとに1日100回まで（2026-10-04 に 429 で判明。"limit: 100 requests per day on Tier 1"）
  const daily = status === 429 && /per day/i.test(detail);
  const limit = (detail.match(/limit: ([^)]+)\)/) || [])[1];
  let resetAt = "";
  if (daily) {
    retryAfter = secondsUntilPacificMidnight(now);
    resetAt = new Date(now.getTime() + retryAfter * 1000).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
  }

  let msg;
  if (/API key not valid|API_KEY_INVALID/i.test(detail)) msg = "API キーが正しくありません。設定画面で確かめてください";
  else if (status === 401 || status === 403) msg = "このキーでは使えません（権限がないか、Gemini API が有効になっていません）";
  else if (status === 404) msg = "モデルまたは声が見つかりません";
  else if (daily) msg = `このモデルの1日の回数の上限に達しました${limit ? `（${limit}）` : ""}。${resetAt} ごろ（太平洋時間の0時）に数え直されます。もう一方のモデルは別に数えられるはずです`;
  else if (status === 429) msg = "回数の上限（1分あたり）に達しました";
  else if (status >= 500) msg = "Google 側でエラーが起きました。少し待ってからもう一度試してください";
  else if (status === 0) msg = "通信できませんでした（オフラインか、ブラウザが通信を止めました）";
  else msg = `エラー（${status}）: ${detail}`;
  return new ApiError(msg, { status, apiStatus: e.status || "", retryAfter, detail, daily });
}

// 応答のどこに音声が入っていても拾えるよう、base64 の音声データを再帰的に探す（make-narration.mjs と同じ）
export function findAudio(node) {
  if (!node || typeof node !== "object") return null;
  const mime = node.mime_type || node.mimeType || "";
  if (typeof node.data === "string" && node.data.length > 1000 && (/audio/.test(mime) || node.type === "audio" || !mime)) {
    return { data: node.data, mime };
  }
  for (const v of Object.values(node)) {
    const hit = findAudio(v);
    if (hit) return hit;
  }
  return null;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(new DOMException("中止しました", "AbortError"));
    const id = setTimeout(done, ms);
    function done() {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    }
    function onAbort() {
      clearTimeout(id);
      reject(new DOMException("中止しました", "AbortError"));
    }
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}

function withTimeout(signal, ms) {
  if (typeof AbortSignal !== "undefined" && AbortSignal.any && AbortSignal.timeout) {
    return signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
  }
  return signal;
}

// 通信そのものが失敗したとき（中止・時間切れ・オフライン）のエラーにそろえる
function fetchFailure(e, signal) {
  if (signal && signal.aborted) return e;
  if (e && e.name === "TimeoutError") return new ApiError("時間がかかりすぎたので打ち切りました。台本を短くしてみてください", { status: 0 });
  return parseError(0, String(e && e.message));
}

// SSE（server-sent events）を読み取る。push(text) に届いた文字列をそのまま渡すと、
// 空行で区切られたイベントごとに data: の JSON を onEvent に渡す。行の途中で切れていても、CRLF でもよい。
// 「data: [DONE]」と、JSON でない行は読み飛ばす（公式: 知らないイベントは飛ばす）
export function sseParser(onEvent) {
  let buf = "";
  return {
    push(text) {
      buf += text;
      for (;;) {
        const m = buf.match(/\r?\n\r?\n/);
        if (!m) break;
        const block = buf.slice(0, m.index);
        buf = buf.slice(m.index + m[0].length);
        const data = block
          .split(/\r?\n/)
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).replace(/^ /, ""))
          .join("\n");
        if (!data || data === "[DONE]") continue;
        let ev;
        try {
          ev = JSON.parse(data);
        } catch {
          continue;
        }
        onEvent(ev);
      }
    },
  };
}

// 音声の断片（バイト列）を Int16 の標本にして onChunk に渡し、全体も貯める。
// 断片の境目で1バイト余ることがあっても次につなぐ。WAV で届いた場合（mime_type を指定したとき）は先頭のヘッダーを外す
export function pcmCollector(onChunk = () => {}) {
  const parts = [];
  let total = 0;
  let carry = null;
  let first = true;
  return {
    push(bytes) {
      if (first) {
        first = false;
        if (isWav(bytes)) {
          const { samples } = parseWav(bytes);
          parts.push(samples);
          total += samples.length;
          onChunk(samples);
          return;
        }
      }
      if (carry) {
        const merged = new Uint8Array(bytes.length + 1);
        merged[0] = carry;
        merged.set(bytes, 1);
        bytes = merged;
        carry = null;
      }
      if (bytes.length % 2) {
        carry = bytes[bytes.length - 1];
        bytes = bytes.subarray(0, bytes.length - 1);
      }
      if (!bytes.length) return;
      const { samples } = decodeAudioBytes(bytes);
      parts.push(samples);
      total += samples.length;
      onChunk(samples);
    },
    finish() {
      const out = new Int16Array(total);
      let p = 0;
      for (const s of parts) {
        out.set(s, p);
        p += s.length;
      }
      return out;
    },
  };
}

/* getKey: () => string、getInterval: () => ミリ秒（Tier 1 は1分10回までなので既定 6500）
   onStatus: ({ type: "wait"|"start"|"retry"|"done", label, until?, wait?, pending }) => void  画面の進み具合用 */
export function createClient({ getKey, getInterval = () => 6500, onStatus = () => {} }) {
  let lastCall = 0;
  let chain = Promise.resolve();
  let pending = 0;

  // 送って、成功した Response を返す（本文はまだ読まない。ストリーミングでも使うため）。429・5xx は待って送り直す
  async function send(method, path, body, { signal, timeoutMs = 180000, label = "", retries = 5 } = {}) {
    const key = getKey();
    if (!key) throw new ApiError("API キーが設定されていません。設定画面で入れてください", { status: 401 });
    for (let attempt = 1; ; attempt++) {
      let res;
      try {
        res = await fetch(API_BASE + path, {
          method,
          headers: { "x-goog-api-key": key, ...(body ? { "Content-Type": "application/json" } : {}) },
          body: body ? JSON.stringify(body) : undefined,
          signal: withTimeout(signal, timeoutMs),
        });
      } catch (e) {
        throw fetchFailure(e, signal);
      }
      if (res.ok) return res;
      const raw = await res.text();
      const err = parseError(res.status, raw);
      // 1日の上限や、90秒より長く待てと言われたときは、待たずにすぐ知らせる
      const longWait = err.daily || (err.retryAfter != null && err.retryAfter > 90);
      if ((res.status === 429 || res.status >= 500) && attempt < retries && !longWait) {
        const wait = err.retryAfter != null ? err.retryAfter + 1.5 : 4 * attempt;
        onStatus({ type: "retry", label, wait, attempt, message: err.message, pending });
        await sleep(wait * 1000, signal);
        continue;
      }
      throw err;
    }
  }

  async function call(method, path, body, opts = {}) {
    const res = await send(method, path, body, opts);
    let raw;
    try {
      raw = await res.text();
    } catch (e) {
      throw fetchFailure(e, opts.signal);
    }
    return raw ? JSON.parse(raw) : {};
  }

  // 音声を作るリクエストは1本の列に並べ、前のリクエストから getInterval() ミリ秒あけて送る
  function enqueue(label, signal, fn) {
    pending++;
    const job = chain.then(async () => {
      try {
        const wait = lastCall + getInterval() - Date.now();
        if (wait > 0) {
          onStatus({ type: "wait", label, until: Date.now() + wait, pending });
          await sleep(wait, signal);
        }
        if (signal && signal.aborted) throw new DOMException("中止しました", "AbortError");
        lastCall = Date.now();
        onStatus({ type: "start", label, pending });
        return await fn();
      } finally {
        pending--;
        onStatus({ type: "done", label, pending });
      }
    });
    chain = job.catch(() => {});
    return job;
  }

  // 返す: { samples: Int16Array, rate }（24kHz・モノラル）
  async function tts(body, { signal, label = "音声を生成" } = {}) {
    return enqueue(label, signal, async () => {
      const json = await call("POST", "/interactions", body, { signal, label });
      const hit = findAudio(json);
      if (!hit) throw new ApiError("応答に音声が入っていませんでした（台本が空か、安全のために止められた可能性があります）", { detail: JSON.stringify(json).slice(0, 300) });
      return decodeAudioBytes(base64ToBytes(hit.data));
    });
  }

  // ストリーミング。作られた音声を断片ごとに onChunk(Int16Array) へ渡し、最後に全体を返す（{ samples, rate }）。
  // 断片はヘッダーなしの PCM（audio/l16、24kHz・モノラル・16bit）。送り直すのは、音声が届き始める前の 429・5xx だけ
  async function ttsStream(body, { signal, label = "音声を生成", onChunk = () => {} } = {}) {
    return enqueue(label, signal, async () => {
      const res = await send("POST", "/interactions", { ...body, stream: true }, { signal, label, timeoutMs: 600000 });
      const pcm = pcmCollector(onChunk);
      const sse = sseParser((ev) => {
        if (ev.event_type === "error" || (ev.error && !ev.event_type)) {
          const e = ev.error || {};
          throw new ApiError(`生成の途中でエラーになりました: ${e.message || "不明なエラー"}`, { detail: JSON.stringify(e).slice(0, 300) });
        }
        if (ev.event_type === "step.delta" && ev.delta && ev.delta.type === "audio" && ev.delta.data) pcm.push(base64ToBytes(ev.delta.data));
      });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          sse.push(dec.decode(value, { stream: true }));
        }
      } catch (e) {
        if (e instanceof ApiError) throw e;
        throw fetchFailure(e, signal);
      } finally {
        reader.releaseLock();
      }
      sse.push(dec.decode() + "\n\n");
      const samples = pcm.finish();
      if (!samples.length) throw new ApiError("応答に音声が入っていませんでした（台本が空か、安全のために止められた可能性があります）");
      return { samples, rate: RATE };
    });
  }

  // 声のデザイン。返す: API の voice（id は "voice_…"）と、お試しの声 { samples, rate }
  async function createVoice({ displayName, description, gender, languageCode, model = MODELS[0].id }, { signal } = {}) {
    const voice = { model, type: "prompted", display_name: displayName, prompted: { input: description } };
    if (gender) voice.gender = gender;
    if (languageCode) voice.language_code = languageCode;
    return enqueue("声を作成", signal, async () => {
      const json = await call("POST", "/voices", { store: true, voice }, { signal, label: "声を作成", retries: 3 });
      const v = json.voice || json;
      const hit = v.sample_audio && v.sample_audio.data ? v.sample_audio : findAudio(json);
      return { voice: v, sample: hit ? decodeAudioBytes(base64ToBytes(hit.data)) : null };
    });
  }

  async function listVoices({ type, languageCode, pageSize = 100, pageToken } = {}, { signal } = {}) {
    const q = new URLSearchParams();
    if (type) q.set("type", type);
    if (languageCode) q.set("language_code", languageCode);
    if (pageSize) q.set("page_size", String(pageSize));
    if (pageToken) q.set("page_token", pageToken);
    const json = await call("GET", `/voices${q.toString() ? "?" + q : ""}`, null, { signal, retries: 2 });
    return { voices: json.voices || [], nextPageToken: json.next_page_token || json.nextPageToken || null };
  }

  // 自分で作った声（prompted）は GET でお試し音声（sample_audio）が返る。一覧（voices.list）には付いてこない。
  // 音声の生成ではないので、試聴のために TTS の回数を使わずに済む（録音からまねた声には付いていない）
  async function getVoice(id, { signal } = {}) {
    const v = await call("GET", `/voices/${encodeURIComponent(voiceId(id))}`, null, { signal, retries: 2 });
    const s = v.sample_audio && v.sample_audio.data ? v.sample_audio : null;
    return { voice: v, sample: s ? decodeAudioBytes(base64ToBytes(s.data)) : null };
  }

  async function deleteVoice(id, { signal } = {}) {
    return call("DELETE", `/voices/${encodeURIComponent(voiceId(id))}`, null, { signal, retries: 2 });
  }

  return { tts, ttsStream, createVoice, listVoices, getVoice, deleteVoice, pending: () => pending };
}

// API が "voices/voice_…" と資源名で返しても、"voice_…" だけで返しても使えるようにする
export function voiceId(v) {
  return String(v || "").replace(/^voices\//, "");
}

// 「コードを表示」用。キーは必ず環境変数の置き換え文字にする（本物のキーは絶対に入れない）
export function codeSnippets(body) {
  const json = JSON.stringify(body, null, 2);
  const curl = [
    `curl -s -X POST "${API_BASE}/interactions" \\`,
    `  -H "x-goog-api-key: $GEMINI_API_KEY" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d @- <<'EOF' > response.json`,
    json,
    "EOF",
    "",
    "# 音声は base64 の WAV（24kHz・モノラル・16bit）。取り出す例:",
    `# jq -r '.. | .data? // empty | select(length > 1000)' response.json | head -1 | base64 -d > out.wav`,
  ].join("\n");
  const js = [
    `// tts.mjs として保存し、node tts.mjs で実行（Node 18 以上）`,
    `import { writeFileSync } from "node:fs";`,
    ``,
    `const res = await fetch("${API_BASE}/interactions", {`,
    `  method: "POST",`,
    `  headers: { "x-goog-api-key": process.env.GEMINI_API_KEY, "Content-Type": "application/json" },`,
    `  body: JSON.stringify(${json.replace(/\n/g, "\n  ")}),`,
    `});`,
    `const json = await res.json();`,
    `// 応答の中の base64 の音声（WAV）を探して保存する`,
    `const find = (n) => n && typeof n === "object" && (typeof n.data === "string" && n.data.length > 1000 ? n.data : Object.values(n).map(find).find(Boolean));`,
    `writeFileSync("out.wav", Buffer.from(find(json), "base64"));`,
  ].join("\n");
  return { curl, js, json };
}
