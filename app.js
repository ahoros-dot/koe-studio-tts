/* こえスタジオ — 画面
   生成（台本・演技の指示・タグ・声）／聞き比べ／声をつくる／履歴／設定。
   API は gemini.js、音声の処理は audio.js、読みの補助は yomi.js、字幕は subs.js、保存は store.js。
   キーは store.getKey() から取り、API へのヘッダ以外には一切出さない。 */

import { RATE, pcmToWav, parseWav, trimSilence, levelSamples, activeDb, concatSamples, peaks, floatToInt16, seconds } from "./audio.js";
import { findIssues, applySuggestion, mora, MORA_PER_SEC, splitSentences } from "./yomi.js";
import { buildCues, toSrt, toVtt } from "./subs.js";
import { createClient, buildTtsBody, codeSnippets, MODELS, costUsd, YEN_PER_USD, voiceId } from "./gemini.js";
import * as store from "./store.js";

// ===================== 定数 =====================

const LEVEL_DB = -16;
const MAX_CHARS = 5000;
const MAX_COMPARE = 6;

// 公式の35種類。日本語の名前は押しやすさのための目安
const TAGS = [
  ["呼吸", [["breath", "息"], ["heavy breath", "荒い息"], ["exhales", "息を吐く"], ["pant", "息切れ"], ["sigh", "ため息"], ["yawn", "あくび"]]],
  ["笑い", [["laugh", "笑う"], ["chuckle", "くすっ"], ["giggle", "くすくす"], ["snicker", "ふふっ"], ["cackle", "高笑い"]]],
  ["反応", [["gasp", "はっ"], ["cough", "せき"], ["sneeze", "くしゃみ"], ["throat-clearing", "せきばらい"], ["snort", "ふんっ"], ["tsk", "ちっ"], ["pff", "ぷっ"], ["argh", "うわっ"], ["cheer", "歓声"]]],
  ["泣き", [["sob", "しゃくり上げ"], ["cry", "泣く"], ["whimper", "すすり泣き"], ["groan", "うめき"], ["moan", "うなる"], ["grunt", "うっ"]]],
  ["勢い", [["whispers", "ささやく"], ["shout", "叫ぶ"], ["scream", "悲鳴"], ["shriek", "金切り声"], ["growl", "うなり声"], ["grr", "ぐるる"], ["hiss", "しっ"]]],
  ["間", [["short pause", "短い間"], ["long pause", "長い間"]]],
];

// 演技の指示の例。公式の例にならって英語で入れる（日本語で書いても読まれはする）
const STYLE_PRESETS = [
  ["大よろこび", "Ecstatic, breathless disbelief, joyful vocal smile"],
  ["ひそひそ", "Hushed whisper, speaking quietly and secretively"],
  ["がっかり", "Utterly defeated, flat monotone, zero energy"],
  ["ニュース読み", "Calm, authoritative news anchor, clear diction"],
  ["CM風", "Fast and energetic, like a TV commercial, short pauses between phrases"],
  ["ASMR", "ASMR, quietly whispered, very close to the microphone"],
  ["こわがる", "Terrified, trembling voice, backing away in fear"],
  ["眠そう", "Sleepy and drowsy, slow, yawning between words"],
  ["やさしく", "Warm, gentle and reassuring, slow pace"],
  ["怒り", "Angry, sharp and forceful, barely holding back"],
  ["読み聞かせ", "Warm storyteller reading a bedtime story to a child, slow pace"],
  ["実況", "Excited sports commentator, rapid-fire, rising intensity"],
];

const DESIGN_EXAMPLES = [
  "30代の男性ラジオDJ。明るく張りのある中くらいの高さの声で、テンポよく話す。標準語。",
  "70代のおばあさん。やわらかく少しかすれた声で、ゆっくり温かく話す。関西のなまり。",
  "10代の元気な女の子。高めの澄んだ声で、早口。よく笑う。",
  "50代の落ち着いたナレーター。低く深い声で、一語一語をはっきり、ゆったり話す。",
];

const newId = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));

const DEFAULT_STATE = () => ({
  view: "generate",
  settings: { interval: 6.5, trim: true, level: true, theme: "auto", demo: false, keyMode: "local" },
  draft: {
    model: MODELS[0].id,
    mode: "solo",
    voice: "Zephyr",
    speakers: [{ speaker: "ハル", voice: "Leda" }, { speaker: "ソラ", voice: "Puck" }],
    parts: [{ id: newId(), speaker: "ハル", text: "", style: "" }],
  },
  compare: { text: "こんにちは。今日はどんなお話を読みましょうか。", style: "", voices: ["Zephyr", "Leda", "Kore"], level: true },
  dict: {},
  myVoices: [],
});

// ===================== 状態 =====================

function mergeState(saved) {
  const d = DEFAULT_STATE();
  if (!saved || typeof saved !== "object") return d;
  return {
    ...d,
    ...saved,
    settings: { ...d.settings, ...(saved.settings || {}) },
    draft: { ...d.draft, ...(saved.draft || {}) },
    compare: { ...d.compare, ...(saved.compare || {}) },
    dict: saved.dict || {},
    myVoices: Array.isArray(saved.myVoices) ? saved.myVoices : [],
  };
}

const state = mergeState(store.loadState());
if (!state.draft.parts.length) state.draft.parts = DEFAULT_STATE().draft.parts;
state.draft.parts.forEach((p) => { if (!p.id) p.id = newId(); });

let saveTimer = 0;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (!store.saveState(state)) toast("設定を保存できませんでした（ブラウザの保存領域が使えません）");
  }, 250);
}

let catalog = { core: [], library: [], sampleText: "" };
let samples = [];

// ===================== 小道具 =====================

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

let toastTimer = 0;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

function fmtSec(sec) {
  if (!Number.isFinite(sec)) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function fmtCost(model, sec) {
  const usd = costUsd(model, sec);
  if (usd == null) return "料金 —";
  const yen = usd * YEN_PER_USD;
  return `約 ${yen < 0.1 ? yen.toFixed(2) : yen.toFixed(1)} 円（$${usd.toFixed(4)}）`;
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const wavBlob = (samplesArr, rate = RATE) => new Blob([pcmToWav(samplesArr, rate)], { type: "audio/wav" });
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function confirmDialog(title, body, okLabel = "実行する") {
  const dlg = $("#confirmDialog");
  $("#h-confirm").textContent = title;
  $("#confirmBody").textContent = body;
  $("#confirmOk").textContent = okLabel;
  return new Promise((resolve) => {
    const done = (v) => {
      dlg.close();
      $("#confirmOk").onclick = null;
      dlg.onclose = null;
      resolve(v);
    };
    $("#confirmOk").onclick = () => done(true);
    dlg.onclose = () => resolve(false);
    dlg.showModal();
  });
}

// ===================== API =====================

const statusEls = { gen: "#runStatus", cmp: "#cmpStatus", design: "#dStatus", sample: "#dStatus", test: "#keyStatus", preview: "#voiceFoot" };
let countdown = 0;
function statusFor(label) {
  return $(statusEls[String(label).split(":")[0]] || "#runStatus");
}
function setStatus(el, text, error = false) {
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("error", error);
}

const client = createClient({
  getKey: () => store.getKey(),
  getInterval: () => Math.max(0, Number(state.settings.interval) || 0) * 1000,
  onStatus: (s) => {
    const el = statusFor(s.label);
    clearInterval(countdown);
    if (s.type === "wait") {
      const tick = () => {
        const left = Math.max(0, (s.until - Date.now()) / 1000);
        setStatus(el, `順番待ち… あと ${left.toFixed(1)} 秒（リクエストの間隔 ${state.settings.interval} 秒）`);
      };
      tick();
      countdown = setInterval(tick, 200);
    } else if (s.type === "start") {
      setStatus(el, s.label.startsWith("cmp:") ? `${voiceInfo(s.label.slice(4)).title} を生成中…` : "生成中…");
    } else if (s.type === "retry") {
      setStatus(el, `${s.message}。${s.wait.toFixed(0)} 秒待って再試行します（${s.attempt} 回目）`, true);
    }
  },
});

// キーなしで試す: API を呼ばず、選んだ声の試聴音声を結果として返す
const decoded = new Map();
async function decodeFile(url) {
  if (decoded.has(url)) return decoded.get(url);
  const buf = await (await fetch(url)).arrayBuffer();
  const ctx = new OfflineAudioContext(1, 1, RATE);
  const ab = await ctx.decodeAudioData(buf);
  const s = floatToInt16(ab.getChannelData(0));
  decoded.set(url, s);
  return s;
}

async function voiceSampleSamples(id) {
  const v = voiceInfo(id);
  if (v.file) return decodeFile(v.file);
  const blob = await store.getSample(id).catch(() => null);
  if (blob) return parseWav(new Uint8Array(await blob.arrayBuffer())).samples;
  return new Int16Array(RATE);
}

async function demoTts(body, signal) {
  await new Promise((r, j) => {
    const t = setTimeout(r, 700);
    if (signal) signal.addEventListener("abort", () => { clearTimeout(t); j(new DOMException("中止しました", "AbortError")); }, { once: true });
  });
  const sc = body.generation_config.speech_config;
  const voices = Array.isArray(sc) ? sc.map((x) => x.voice) : sc.speakers.map((x) => x.voice);
  const list = [];
  for (const v of voices) list.push(await voiceSampleSamples(v));
  return { samples: concatSamples(list, RATE, 0.35), rate: RATE };
}

function tts(body, opts) {
  return state.settings.demo ? demoTts(body, opts.signal) : client.tts(body, opts);
}

// ===================== 声の情報 =====================

function voiceInfo(id) {
  const c = catalog.core.find((v) => v.id === id);
  if (c) {
    return { id, kind: "core", title: c.name, sub: `${c.ja}（${c.trait}）`, meta: c.f0 ? `高さ ${c.f0}Hz` : "", file: c.file, entry: c };
  }
  const l = catalog.library.find((v) => v.id === id);
  if (l) {
    const title = l.role ? `${l.role}${l.age ? `・${l.age}歳` : ""}` : l.name;
    return {
      id, kind: "library", title, sub: `${l.accent}のことば・${l.genderJa}・${l.pitchJa}`,
      meta: [l.tones.join("・"), l.situation].filter(Boolean).join(" ／ "), file: l.file, entry: l,
    };
  }
  const m = state.myVoices.find((v) => v.id === id);
  if (m) return { id, kind: "mine", title: m.name || id, sub: "自分の声", meta: m.desc || "", file: null, entry: m };
  if (/^voice_/.test(id)) return { id, kind: "mine", title: id, sub: "自分の声", meta: "", file: null };
  return { id, kind: "unknown", title: id || "未選択", sub: "", meta: "", file: null };
}

// ===================== 再生 =====================

const audio = new Audio();
audio.preload = "auto";
let playingKey = "";
const blobUrls = new Map();

function syncPlayButtons() {
  for (const b of $$("[data-play-key]")) {
    const on = b.dataset.playKey === playingKey && !audio.paused;
    b.classList.toggle("playing", on);
    b.textContent = on ? "■" : "▶";
    b.setAttribute("aria-label", on ? "停止" : "再生");
  }
}

async function togglePlay(key, getUrl) {
  if (playingKey === key && !audio.paused) {
    audio.pause();
    syncPlayButtons();
    return;
  }
  try {
    const url = await getUrl();
    if (!url) return;
    if (audio.src !== url) audio.src = url;
    playingKey = key;
    audio.currentTime = 0;
    await audio.play();
  } catch (e) {
    toast(`再生できませんでした: ${e.message}`);
  }
  syncPlayButtons();
}

audio.addEventListener("ended", () => { syncPlayButtons(); drawResultWave(); });
audio.addEventListener("pause", syncPlayButtons);
audio.addEventListener("play", () => { syncPlayButtons(); if (playingKey === "result") animateResult(); });

// 試聴音声を用意して、このブラウザに残す。
// 自分で作った声は GET /voices/{id} にお試し音声が付いてくるので、それを使う（音声の生成ではないので1日の回数を使わない）。
// それ以外の声と、お試し音声が付いていない声（録音からまねた声など）だけ、TTS で1回作る
const sampleNotice = (id) =>
  voiceInfo(id).kind === "mine" ? "試聴音声を読み込んでいます（生成の回数は使いません）" : "試聴音声を作っています（1回分のリクエストを使います）";

async function obtainSample(id, label) {
  if (voiceInfo(id).kind === "mine") {
    const { sample } = await client.getVoice(id);
    if (sample) {
      const blob = wavBlob(levelSamples(trimSilence(sample.samples, sample.rate), sample.rate, LEVEL_DB).samples, sample.rate);
      await store.putSample(id, blob).catch(() => {});
      return blob;
    }
  }
  const a = await client.tts(buildTtsBody({ model: MODELS[0].id, mode: "solo", voice: id, parts: [{ text: catalog.sampleText || "こんにちは。今日はどんなお話を読みましょうか。" }] }), { label });
  const blob = wavBlob(levelSamples(trimSilence(a.samples, a.rate), a.rate, LEVEL_DB).samples, a.rate);
  await store.putSample(id, blob).catch(() => {});
  return blob;
}

// 試聴: 同梱の MP3 → このブラウザに残した試聴音声 → キーがあれば obtainSample で用意する
const making = new Set();
async function previewUrl(id) {
  const v = voiceInfo(id);
  if (v.file) return v.file;
  if (blobUrls.has(id)) return blobUrls.get(id);
  let blob = await store.getSample(id).catch(() => null);
  if (!blob) {
    if (state.settings.demo || !store.getKey()) {
      toast(v.kind === "mine" ? "この声の試聴音声はまだありません（「声をつくる」の一覧で読み込めます）" : "この声の試聴音声は同梱していません。API キーがあれば、その場で作れます");
      return null;
    }
    if (making.has(id)) return null;
    making.add(id);
    toast(sampleNotice(id));
    try {
      blob = await obtainSample(id, "preview");
    } catch (e) {
      toast(e.message);
      return null;
    } finally {
      making.delete(id);
    }
  }
  const url = URL.createObjectURL(blob);
  blobUrls.set(id, url);
  return url;
}

// ===================== 画面の切り替え =====================

function switchView(view) {
  state.view = view;
  for (const v of $$(".view")) v.hidden = v.id !== `view-${view}`;
  for (const b of $$("[data-view]")) {
    if (b.dataset.view === view) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  }
  if (view === "history") renderHistory();
  if (view === "design") renderMyVoices();
  if (view === "settings") renderSettings();
  if (view === "compare") renderCompareForm();
  save();
  window.scrollTo({ top: 0 });
}

document.addEventListener("click", (e) => {
  const nav = e.target.closest("[data-view]");
  if (nav) return switchView(nav.dataset.view);
  const link = e.target.closest("[data-view-link]");
  if (link) return switchView(link.dataset.viewLink);
  const close = e.target.closest("[data-close]");
  if (close) close.closest("dialog").close();
});

function applyTheme() {
  const t = state.settings.theme;
  if (t === "auto") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  $("#themeBtn").textContent = t === "dark" ? "☾" : t === "light" ? "☀" : "◐";
  $("#themeBtn").title = `テーマ: ${{ auto: "端末に合わせる", light: "ライト", dark: "ダーク" }[t]}`;
  requestAnimationFrame(() => { drawResultWave(); redrawCompare(); });
}

$("#themeBtn").addEventListener("click", () => {
  const order = ["auto", "light", "dark"];
  state.settings.theme = order[(order.indexOf(state.settings.theme) + 1) % 3];
  applyTheme();
  save();
});

function renderKeyChip() {
  const chip = $("#keyChip");
  const has = !!store.getKey();
  chip.classList.toggle("warn", !has && !state.settings.demo);
  chip.textContent = state.settings.demo ? "キーなしで試す" : has ? "キー設定済み" : "キー未設定";
  $("#demoBanner").hidden = !state.settings.demo;
}

// ===================== 生成: 台本 =====================

const draft = () => state.draft;

function speakerNames() {
  return draft().speakers.map((s) => s.speaker);
}

function renderParts() {
  const d = draft();
  const duo = d.mode === "duo";
  const names = speakerNames();
  $("#parts").innerHTML = d.parts
    .map((p, i) => {
      const speakerSel = duo
        ? `<select class="part-speaker" data-act="speaker" aria-label="話し手">${names
            .map((n) => `<option value="${escapeHtml(n)}"${n === p.speaker ? " selected" : ""}>${escapeHtml(n)}</option>`)
            .join("")}</select>`
        : "";
      return `<li class="part" data-id="${p.id}">
        <div class="part-head">
          <span class="part-num">${String(i + 1).padStart(2, "0")}</span>
          ${speakerSel}
          <div class="part-style">
            <label class="sr-only" for="st-${p.id}">演技の指示</label>
            <input type="text" id="st-${p.id}" data-act="style" value="${escapeHtml(p.style)}" placeholder="演技の指示（例: やさしく、ゆっくり）" autocomplete="off">
          </div>
          ${d.parts.length > 1 ? `<button type="button" class="mini" data-act="remove" aria-label="パート${i + 1}を削除">削除</button>` : ""}
        </div>
        <label class="sr-only" for="tx-${p.id}">台本（パート${i + 1}）</label>
        <textarea class="part-text" id="tx-${p.id}" data-act="text" rows="3" placeholder="ここに台本を書きます">${escapeHtml(p.text)}</textarea>
        <div class="part-foot">
          <div class="part-tools">
            <button type="button" class="mini" data-act="toggle-tags" aria-expanded="false">タグ</button>
            <button type="button" class="mini" data-act="toggle-styles" aria-expanded="false">指示の例</button>
            ${duo ? `<button type="button" class="mini" data-act="backchannel" title="相手の声で入る短いあいづち">あいづち</button>` : ""}
          </div>
          <span class="part-len" data-len></span>
        </div>
        <div class="palette" data-palette="tags" hidden>
          ${TAGS.map(([g, items]) => `<div class="palette-group"><span>${g}</span>${items
            .map(([tag, ja]) => `<button type="button" class="tag-btn" data-tag="${tag}">${ja}<small>${tag}</small></button>`)
            .join("")}</div>`).join("")}
        </div>
        <div class="palette" data-palette="styles" hidden>
          <div class="palette-group">${STYLE_PRESETS.map(([ja, en]) => `<button type="button" class="tag-btn" data-style="${escapeHtml(en)}" title="${escapeHtml(en)}">${ja}</button>`).join("")}</div>
          <p class="help">まずは空欄で試すのが公式のすすめです。足りないときに指示を足します。</p>
        </div>
      </li>`;
    })
    .join("");
  updateDerived();
}

function partOf(el) {
  const li = el.closest(".part");
  return li ? draft().parts.find((p) => p.id === li.dataset.id) : null;
}

function insertAtCursor(ta, text, selectInner = 0) {
  const start = ta.selectionStart ?? ta.value.length;
  const end = ta.selectionEnd ?? ta.value.length;
  ta.value = ta.value.slice(0, start) + text + ta.value.slice(end);
  ta.focus();
  if (selectInner) ta.setSelectionRange(start + 1, start + 1 + selectInner);
  else ta.setSelectionRange(start + text.length, start + text.length);
  ta.dispatchEvent(new Event("input", { bubbles: true }));
}

$("#parts").addEventListener("input", (e) => {
  const p = partOf(e.target);
  if (!p) return;
  if (e.target.dataset.act === "text") p.text = e.target.value;
  if (e.target.dataset.act === "style") p.style = e.target.value;
  save();
  scheduleDerived();
});

$("#parts").addEventListener("change", (e) => {
  const p = partOf(e.target);
  if (p && e.target.dataset.act === "speaker") {
    p.speaker = e.target.value;
    save();
  }
});

$("#parts").addEventListener("click", (e) => {
  const li = e.target.closest(".part");
  if (!li) return;
  const p = partOf(li);
  const ta = $("textarea", li);
  const act = e.target.closest("[data-act]")?.dataset.act;
  const tagBtn = e.target.closest("[data-tag]");
  const styleBtn = e.target.closest("[data-style]");
  if (tagBtn) return insertAtCursor(ta, `<${tagBtn.dataset.tag}>`);
  if (styleBtn) {
    const input = $('[data-act="style"]', li);
    input.value = styleBtn.dataset.style;
    p.style = input.value;
    save();
    return;
  }
  if (act === "remove") {
    draft().parts = draft().parts.filter((x) => x !== p);
    save();
    renderParts();
  } else if (act === "toggle-tags" || act === "toggle-styles") {
    const which = act === "toggle-tags" ? "tags" : "styles";
    const pal = $(`[data-palette="${which}"]`, li);
    pal.hidden = !pal.hidden;
    e.target.setAttribute("aria-expanded", String(!pal.hidden));
  } else if (act === "backchannel") {
    insertAtCursor(ta, "|うん|", 2);
  }
});

$("#addPart").addEventListener("click", () => {
  const d = draft();
  const names = speakerNames();
  const last = d.parts[d.parts.length - 1];
  const next = d.mode === "duo" ? names[(names.indexOf(last?.speaker) + 1) % 2] || names[0] : names[0];
  d.parts.push({ id: newId(), speaker: next, text: "", style: "" });
  save();
  renderParts();
  $(`#tx-${d.parts[d.parts.length - 1].id}`).focus();
});

$("#clearScript").addEventListener("click", async () => {
  if (draft().parts.some((p) => p.text.trim()) && !(await confirmDialog("台本を空にしますか", "書いた台本と演技の指示が消えます。", "空にする"))) return;
  draft().parts = [{ id: newId(), speaker: speakerNames()[0], text: "", style: "" }];
  save();
  renderParts();
});

function renderSampleSelect() {
  $("#sampleSelect").innerHTML =
    `<option value="">例から始める…</option>` + samples.map((s) => `<option value="${s.id}">${escapeHtml(s.title)}（${escapeHtml(s.desc)}）</option>`).join("");
}

$("#sampleSelect").addEventListener("change", async (e) => {
  const s = samples.find((x) => x.id === e.target.value);
  e.target.value = "";
  if (!s) return;
  if (draft().parts.some((p) => p.text.trim()) && !(await confirmDialog("例を読み込みますか", "今の台本は置き換えられます（履歴に残した音声は消えません）。", "読み込む"))) return;
  const d = draft();
  d.mode = s.mode;
  if (s.voice) d.voice = s.voice;
  if (s.speakers) d.speakers = s.speakers.map((x) => ({ ...x }));
  d.parts = s.parts.map((p) => ({ id: newId(), speaker: p.speaker || speakerNames()[0], text: p.text, style: p.style || "" }));
  save();
  renderRunPanel();
  renderParts();
  toast(`「${s.title}」を読み込みました`);
});

// ---- 読みのチェックと見積もり ----
let derivedTimer = 0;
function scheduleDerived() {
  clearTimeout(derivedTimer);
  derivedTimer = setTimeout(updateDerived, 180);
}

function updateDerived() {
  const d = draft();
  let totalMora = 0;
  let chars = 0;
  const items = [];
  d.parts.forEach((p, i) => {
    const m = mora(p.text);
    totalMora += m;
    chars += p.text.length;
    const len = $(`.part[data-id="${p.id}"] [data-len]`);
    if (len) len.textContent = p.text ? `${p.text.length}字・約 ${(m / MORA_PER_SEC).toFixed(1)} 秒` : "";
    for (const is of findIssues(p.text, state.dict)) items.push({ part: p, index: i, issue: is });
  });
  const sec = totalMora / MORA_PER_SEC;
  const over = chars > MAX_CHARS;
  $("#estimate").textContent = chars
    ? `見積もり 約 ${sec.toFixed(1)} 秒・${fmtCost(d.model, sec)}${over ? `・${MAX_CHARS}字を超えています` : ""}`
    : "台本を書くと、長さと料金の見積もりが出ます";
  $("#estimate").classList.toggle("error", over);

  $("#yomiCount").textContent = items.length ? `${items.length} か所` : "";
  $("#yomiList").innerHTML = items.length
    ? items
        .map(({ part, index, issue }, k) => {
          const btns = issue.suggestions
            .map((s, j) => `<button type="button" class="chip-btn" data-fix="${k}" data-sugg="${j}">${s === "" ? "消す" : escapeHtml(s)}</button>`)
            .join("");
          const reg = issue.kind === "latin" && !issue.suggestions.length
            ? `<button type="button" class="chip-btn" data-reg="${k}">読みを登録</button>`
            : "";
          return `<li class="yomi-item">
            <div>${d.parts.length > 1 ? `パート${index + 1}: ` : ""}<span class="orig">${escapeHtml(issue.text)}</span></div>
            <div class="msg">${escapeHtml(issue.message)}</div>
            ${btns || reg ? `<div class="sugg">${btns}${reg}</div>` : ""}
          </li>`;
        })
        .join("")
    : `<li class="yomi-ok">${chars ? "読みが揺れそうな所は見つかりませんでした。" : "数字・英字・記号・かっこがあると、ここに印が付きます。"}</li>`;
  $("#yomiList")._items = items;
}

$("#yomiList").addEventListener("click", (e) => {
  const items = $("#yomiList")._items || [];
  const fix = e.target.closest("[data-fix]");
  if (fix) {
    const { part, issue } = items[Number(fix.dataset.fix)];
    part.text = applySuggestion(part.text, issue, issue.suggestions[Number(fix.dataset.sugg)]);
    const ta = $(`#tx-${part.id}`);
    if (ta) ta.value = part.text;
    save();
    updateDerived();
    return;
  }
  const reg = e.target.closest("[data-reg]");
  if (reg) {
    const { issue } = items[Number(reg.dataset.reg)];
    const li = reg.closest(".yomi-item");
    const box = reg.parentElement;
    box.innerHTML = `<input type="text" class="select-sm" placeholder="カタカナの読み" aria-label="${escapeHtml(issue.text)} の読み"><button type="button" class="chip-btn">追加</button>`;
    const input = $("input", box);
    input.focus();
    const add = () => {
      const r = input.value.trim();
      if (!r) return;
      state.dict[issue.text] = r;
      save();
      updateDerived();
      toast(`「${issue.text}」→「${r}」を読み辞書に登録しました`);
    };
    $("button", box).addEventListener("click", add);
    input.addEventListener("keydown", (ev) => { if (ev.key === "Enter") add(); });
    li.classList.add("editing");
  }
});

// ===================== 生成: 右の設定 =====================

function renderRunPanel() {
  const d = draft();
  $("#modelSelect").innerHTML = MODELS.map((m) => `<option value="${m.id}"${m.id === d.model ? " selected" : ""}>${m.label}</option>`).join("");
  $("#modelNote").textContent = MODELS.find((m) => m.id === d.model)?.note || "";
  for (const b of $$(".segmented [data-mode]")) b.setAttribute("aria-checked", String(b.dataset.mode === d.mode));
  $("#optTrim").checked = !!state.settings.trim;
  $("#optLevel").checked = !!state.settings.level;

  const voiceBtn = (id, slot) => {
    const v = voiceInfo(id);
    return `<button type="button" class="voice-btn" data-pick="${slot}">
      <span class="vmeta"><span class="vname">${escapeHtml(v.title)}</span><span class="vsub">${escapeHtml(v.sub)}</span></span>
      <span class="chev">変更</span>
    </button>`;
  };
  if (d.mode === "solo") {
    $("#voiceFields").innerHTML = `<div class="field"><span class="label">声</span>${voiceBtn(d.voice, "solo")}</div>`;
  } else {
    $("#voiceFields").innerHTML = d.speakers
      .map(
        (s, i) => `<div class="field">
          <span class="label">話し手${i === 0 ? "A" : "B"}</span>
          <div class="speaker-row">
            <input type="text" value="${escapeHtml(s.speaker)}" data-speaker-name="${i}" aria-label="話し手${i === 0 ? "A" : "B"}の名前" maxlength="20">
            ${voiceBtn(s.voice, `duo:${i}`)}
          </div>
        </div>`
      )
      .join("") + `<p class="help help-block">掛け合いで使えるのは、定番の声と日本語ライブラリの声（2人まで）です。</p>`;
  }
  const sheetToggle = $(".run-sheet-toggle");
  if (!sheetToggle) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn-ghost run-sheet-toggle";
    b.textContent = "設定";
    b.setAttribute("aria-expanded", "false");
    b.addEventListener("click", () => {
      const open = !$("#runpanel").classList.contains("open");
      $("#runpanel").classList.toggle("open", open);
      b.setAttribute("aria-expanded", String(open));
    });
    $(".run-actions").prepend(b);
  }
}

$("#modelSelect").addEventListener("change", (e) => {
  draft().model = e.target.value;
  save();
  renderRunPanel();
  updateDerived();
});

$(".segmented").addEventListener("click", (e) => {
  const b = e.target.closest("[data-mode]");
  if (!b) return;
  const d = draft();
  d.mode = b.dataset.mode;
  if (d.mode === "duo") {
    const names = speakerNames();
    d.parts.forEach((p, i) => { if (!names.includes(p.speaker)) p.speaker = names[i % 2]; });
    for (const s of d.speakers) if (voiceInfo(s.voice).kind === "mine") s.voice = "Puck";
  }
  save();
  renderRunPanel();
  renderParts();
});

$("#voiceFields").addEventListener("click", (e) => {
  const b = e.target.closest("[data-pick]");
  if (!b) return;
  const slot = b.dataset.pick;
  const d = draft();
  const current = slot === "solo" ? d.voice : d.speakers[Number(slot.split(":")[1])].voice;
  openVoiceDialog({
    current,
    allowMine: slot === "solo",
    onPick: (id) => {
      if (slot === "solo") d.voice = id;
      else d.speakers[Number(slot.split(":")[1])].voice = id;
      save();
      renderRunPanel();
    },
  });
});

$("#voiceFields").addEventListener("change", (e) => {
  const input = e.target.closest("[data-speaker-name]");
  if (!input) return;
  const i = Number(input.dataset.speakerName);
  const d = draft();
  const old = d.speakers[i].speaker;
  const name = input.value.trim() || old;
  if (d.speakers.some((s, j) => j !== i && s.speaker === name)) {
    toast("2人の名前は別にしてください");
    input.value = old;
    return;
  }
  d.speakers[i].speaker = name;
  d.parts.forEach((p) => { if (p.speaker === old) p.speaker = name; });
  save();
  renderParts();
});

$("#optTrim").addEventListener("change", (e) => { state.settings.trim = e.target.checked; save(); });
$("#optLevel").addEventListener("change", (e) => { state.settings.level = e.target.checked; save(); });

// ===================== 生成の実行 =====================

let genController = null;
let result = null;

function validateDraft() {
  const d = draft();
  const parts = d.parts.filter((p) => p.text.trim());
  if (!parts.length) return "台本を書いてください";
  if (d.parts.reduce((a, p) => a + p.text.length, 0) > MAX_CHARS) return `台本が ${MAX_CHARS} 字を超えています。分けて生成してください`;
  if (!state.settings.demo && !store.getKey()) return "API キーが設定されていません。設定画面で入れてください（キーなしで試すこともできます）";
  if (d.mode === "duo") {
    if (d.speakers.some((s) => voiceInfo(s.voice).kind === "mine")) return "掛け合いでは自分で作った声は使えません。定番かライブラリの声を選んでください";
    if (!parts.every((p) => speakerNames().includes(p.speaker))) return "話し手が決まっていないパートがあります";
  }
  return null;
}

async function runGenerate() {
  const err = validateDraft();
  if (err) {
    setStatus($("#runStatus"), err, true);
    if (err.includes("API キー")) toast(err);
    return;
  }
  const d = draft();
  const body = buildTtsBody({ model: d.model, mode: d.mode, parts: d.parts, voice: d.voice, speakers: d.speakers });
  genController = new AbortController();
  $("#runBtn").disabled = true;
  $("#stopBtn").hidden = false;
  setStatus($("#runStatus"), state.settings.demo ? "試聴音声を用意しています…" : "送信しています…");
  try {
    const a = await tts(body, { signal: genController.signal, label: "gen" });
    let s = a.samples;
    const rawDb = activeDb(s);
    if (state.settings.trim) s = trimSilence(s, a.rate);
    if (state.settings.level) s = levelSamples(s, a.rate, LEVEL_DB).samples;
    const entry = {
      id: newId(),
      createdAt: Date.now(),
      kind: "generate",
      demo: !!state.settings.demo,
      model: d.model,
      mode: d.mode,
      voice: d.voice,
      speakers: d.speakers.map((x) => ({ ...x })),
      parts: d.parts.filter((p) => p.text.trim()).map(({ speaker, text, style }) => ({ speaker, text, style })),
      sec: seconds(s, a.rate),
      rawDb,
    };
    showResult(s, a.rate, entry, body);
    try {
      await store.addHistory({ ...entry, wav: wavBlob(s, a.rate) });
    } catch {
      toast("履歴に保存できませんでした（ブラウザの保存領域が使えません）");
    }
    setStatus($("#runStatus"), `できました（${seconds(s, a.rate).toFixed(1)} 秒）${state.settings.demo ? "。キーなしで試すモードなので試聴音声です" : ""}`);
  } catch (e) {
    clearInterval(countdown);
    if (e.name === "AbortError") setStatus($("#runStatus"), "中止しました");
    else setStatus($("#runStatus"), e.message || String(e), true);
  } finally {
    $("#runBtn").disabled = false;
    $("#stopBtn").hidden = true;
    genController = null;
  }
}

$("#runBtn").addEventListener("click", runGenerate);
$("#stopBtn").addEventListener("click", () => genController && genController.abort());
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && state.view === "generate" && !genController) {
    e.preventDefault();
    runGenerate();
  }
});

function cueLines(entry) {
  return entry.parts.flatMap((p) => splitSentences(p.text).map((t) => ({ text: t, speaker: entry.mode === "duo" ? p.speaker : null })));
}

function showResult(s, rate, entry, body) {
  if (result && result.url) URL.revokeObjectURL(result.url);
  const url = URL.createObjectURL(wavBlob(s, rate));
  result = { samples: s, rate, entry, body, url, peaks: peaks(s, 600) };
  $("#result").hidden = false;
  const voices = entry.mode === "duo" ? entry.speakers.map((x) => `${x.speaker}＝${voiceInfo(x.voice).title}`).join("、") : voiceInfo(entry.voice).title;
  $("#resultMeta").textContent = `${voices}・${MODELS.find((m) => m.id === entry.model)?.label}・${fmtCost(entry.model, entry.sec)}${entry.demo ? "・試聴音声（キーなし）" : ""}`;
  $("#resultTime").textContent = `0:00 / ${fmtSec(entry.sec)}`;
  playingKey = "";
  $("#resultPlay").dataset.playKey = "result";
  syncPlayButtons();
  drawResultWave();
  if (window.matchMedia("(max-width: 860px)").matches) $("#result").scrollIntoView({ behavior: "smooth", block: "center" });
}

$("#resultPlay").addEventListener("click", () => togglePlay("result", () => result && result.url));

function drawWave(canvas, pk, progress = 0) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!w || !h) return;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  const bars = Math.max(20, Math.floor(w / 3));
  const muted = cssVar("--text-3");
  const accent = cssVar("--accent");
  for (let b = 0; b < bars; b++) {
    const i0 = Math.floor((b / bars) * pk.length);
    const i1 = Math.max(i0 + 1, Math.floor(((b + 1) / bars) * pk.length));
    let mx = 0;
    for (let i = i0; i < i1; i++) mx = Math.max(mx, pk[i]);
    const bh = Math.max(2, Math.min(1, mx * 1.25) * (h - 4));
    ctx.fillStyle = b / bars < progress ? accent : muted;
    ctx.globalAlpha = b / bars < progress ? 1 : 0.55;
    ctx.fillRect(b * 3, (h - bh) / 2, 2, bh);
  }
  ctx.globalAlpha = 1;
}

function drawResultWave() {
  if (!result) return;
  const prog = playingKey === "result" && audio.duration ? audio.currentTime / audio.duration : 0;
  drawWave($("#resultWave"), result.peaks, prog);
  $("#resultTime").textContent = `${fmtSec(playingKey === "result" ? audio.currentTime : 0)} / ${fmtSec(result.entry.sec)}`;
}

function animateResult() {
  drawResultWave();
  if (playingKey === "result" && !audio.paused) requestAnimationFrame(animateResult);
}

$("#resultWave").addEventListener("click", async (e) => {
  if (!result) return;
  const r = e.target.getBoundingClientRect();
  const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  if (playingKey !== "result" || audio.paused) await togglePlay("result", () => result.url);
  if (audio.duration) audio.currentTime = frac * audio.duration;
  drawResultWave();
});

window.addEventListener("resize", () => { drawResultWave(); redrawCompare(); });

function subtitleFor(entry, s, rate) {
  return buildCues(cueLines(entry), s, rate);
}

$("#dlWav").addEventListener("click", () => result && download(wavBlob(result.samples, result.rate), `koe-${stamp(new Date(result.entry.createdAt))}.wav`));
$("#dlSrt").addEventListener("click", () => {
  if (!result) return;
  download(new Blob([toSrt(subtitleFor(result.entry, result.samples, result.rate))], { type: "application/x-subrip" }), `koe-${stamp(new Date(result.entry.createdAt))}.srt`);
  toast("字幕の時刻は目安です（文の境目を無音の位置に合わせています）");
});
$("#dlVtt").addEventListener("click", () => {
  if (!result) return;
  download(new Blob([toVtt(subtitleFor(result.entry, result.samples, result.rate))], { type: "text/vtt" }), `koe-${stamp(new Date(result.entry.createdAt))}.vtt`);
  toast("字幕の時刻は目安です（文の境目を無音の位置に合わせています）");
});

// ---- コード ----
let codeTab = "curl";
let codeData = null;
function openCode(body) {
  codeData = codeSnippets(body);
  renderCode();
  $("#codeDialog").showModal();
}
function renderCode() {
  for (const b of $$("#codeTabs [data-tab]")) b.setAttribute("aria-selected", String(b.dataset.tab === codeTab));
  $("#codeBox").textContent = codeData ? codeData[codeTab] : "";
}
$("#codeTabs").addEventListener("click", (e) => {
  const b = e.target.closest("[data-tab]");
  if (!b) return;
  codeTab = b.dataset.tab;
  renderCode();
});
$("#showCode").addEventListener("click", () => {
  const d = draft();
  openCode(result ? result.body : buildTtsBody({ model: d.model, mode: d.mode, parts: d.parts, voice: d.voice, speakers: d.speakers }));
});
$("#codeCopy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("#codeBox").textContent);
    toast("コピーしました");
  } catch {
    toast("コピーできませんでした。選択してコピーしてください");
  }
});

// ===================== 声を選ぶ =====================

let vd = { tab: "core", current: "", allowMine: true, onPick: null, multi: false, selected: [], filters: { q: "", accent: "", gender: "", pitch: "", context: "", height: "" } };

function openVoiceDialog(opts) {
  vd = { ...vd, multi: false, selected: [], ...opts };
  const kind = voiceInfo(vd.current).kind;
  vd.tab = kind === "library" ? "library" : kind === "mine" && vd.allowMine ? "mine" : "core";
  renderVoiceDialog();
  $("#voiceDialog").showModal();
}

function voiceRows() {
  const f = vd.filters;
  const q = f.q.trim().toLowerCase();
  if (vd.tab === "core") {
    return catalog.core
      .filter((v) => !q || `${v.name} ${v.ja} ${v.trait}`.toLowerCase().includes(q))
      .filter((v) => !f.height || (f.height === "high" ? v.f0 >= 165 : v.f0 && v.f0 < 165))
      .map((v) => v.id);
  }
  if (vd.tab === "library") {
    return catalog.library
      .filter((v) => (!f.accent || v.accent === f.accent) && (!f.gender || v.gender === f.gender) && (!f.pitch || v.pitch === f.pitch) && (!f.context || v.context === f.context))
      .filter((v) => !q || `${v.role} ${v.tones.join(" ")} ${v.situation} ${v.description} ${v.accent}`.toLowerCase().includes(q))
      .map((v) => v.id);
  }
  return state.myVoices.filter((v) => !q || `${v.name} ${v.desc}`.toLowerCase().includes(q)).map((v) => v.id);
}

function renderVoiceDialog() {
  for (const b of $$("#voiceTabs [data-tab]")) {
    b.setAttribute("aria-selected", String(b.dataset.tab === vd.tab));
    b.disabled = b.dataset.tab === "mine" && !vd.allowMine;
    if (b.dataset.tab === "library") b.textContent = `日本語ライブラリ（${catalog.library.length}）`;
    if (b.dataset.tab === "mine") b.textContent = `自分の声（${state.myVoices.length}）`;
  }
  const f = vd.filters;
  const opt = (v, label, cur) => `<option value="${escapeHtml(v)}"${v === cur ? " selected" : ""}>${escapeHtml(label)}</option>`;
  const contexts = [...new Set(catalog.library.map((v) => v.context))];
  $("#voiceFilters").innerHTML =
    `<input type="text" data-f="q" value="${escapeHtml(f.q)}" placeholder="さがす（名前・特徴・職業）" aria-label="声をさがす">` +
    (vd.tab === "core"
      ? `<select data-f="height" aria-label="声の高さ">${opt("", "高さ: すべて", f.height)}${opt("high", "高め（165Hz 以上）", f.height)}${opt("low", "低め（165Hz 未満）", f.height)}</select>`
      : vd.tab === "library"
        ? `<select data-f="accent" aria-label="ことば">${opt("", "ことば: すべて", f.accent)}${opt("東京", "東京", f.accent)}${opt("大阪", "大阪", f.accent)}${opt("福岡", "福岡", f.accent)}</select>
           <select data-f="gender" aria-label="性別">${opt("", "性別: すべて", f.gender)}${opt("female", "女性", f.gender)}${opt("male", "男性", f.gender)}${opt("neutral", "中性", f.gender)}</select>
           <select data-f="pitch" aria-label="高さ">${opt("", "高さ: すべて", f.pitch)}${opt("high", "高め", f.pitch)}${opt("medium", "中くらい", f.pitch)}${opt("low", "低め", f.pitch)}</select>
           <select data-f="context" aria-label="向いている用途">${opt("", "用途: すべて", f.context)}${contexts.map((c) => opt(c, c, f.context)).join("")}</select>`
        : "");
  renderVoiceList();
  $("#voiceFoot").textContent = vd.multi
    ? `選んだ声 ${vd.selected.length} / ${MAX_COMPARE}。行を押すと選択・解除します。`
    : !vd.allowMine
      ? "掛け合い（2人）では自分で作った声は使えません。"
      : vd.tab === "library"
        ? "日本語ライブラリの説明は、API の英語の説明を日本語にしたものです。"
        : vd.tab === "core"
          ? `試聴の台本:「${catalog.sampleText}」（音量はそろえてあります）`
          : "自分の声は「声をつくる」で作れます。";
}

function renderVoiceList() {
  const ids = voiceRows();
  if (!ids.length) {
    $("#voiceList").innerHTML = `<li class="empty">${vd.tab === "mine" ? "まだ自分の声はありません。「声をつくる」で作るか、一覧を更新してください。" : "条件に合う声がありません。"}</li>`;
    return;
  }
  $("#voiceList").innerHTML = ids
    .map((id) => {
      const v = voiceInfo(id);
      const sel = vd.multi ? vd.selected.includes(id) : id === vd.current;
      const extra = v.kind === "core" && v.entry.rawDb != null
        ? `素の音量 ${v.entry.rawDb}dB`
        : v.kind === "library" && !v.file ? "試聴音声は同梱していません（キーがあれば ▶ でその場で作ります）" : "";
      return `<li class="voice-row${sel ? " selected" : ""}" data-voice="${escapeHtml(id)}">
        <button type="button" class="play-btn small" data-play-key="pv:${escapeHtml(id)}" data-preview="${escapeHtml(id)}" aria-label="試聴">▶</button>
        <div>
          <div class="vtitle">${escapeHtml(v.title)}${v.kind === "library" ? `<small>${escapeHtml(id)}</small>` : ""}</div>
          <div class="vdesc">${escapeHtml(v.sub)}${v.meta ? `・${escapeHtml(v.meta)}` : ""}</div>
          ${extra ? `<div class="vtags">${escapeHtml(extra)}</div>` : ""}
        </div>
        <button type="button" class="${sel ? "btn-primary" : "btn-ghost"} btn-sm" data-choose="${escapeHtml(id)}">${vd.multi ? (sel ? "解除" : "選ぶ") : sel ? "選択中" : "選ぶ"}</button>
      </li>`;
    })
    .join("");
  syncPlayButtons();
}

$("#voiceTabs").addEventListener("click", (e) => {
  const b = e.target.closest("[data-tab]");
  if (!b || b.disabled) return;
  vd.tab = b.dataset.tab;
  renderVoiceDialog();
});

$("#voiceFilters").addEventListener("input", (e) => {
  const k = e.target.dataset.f;
  if (!k) return;
  vd.filters[k] = e.target.value;
  renderVoiceList();
});

$("#voiceList").addEventListener("click", (e) => {
  const pv = e.target.closest("[data-preview]");
  if (pv) {
    const id = pv.dataset.preview;
    return togglePlay(`pv:${id}`, () => previewUrl(id));
  }
  const row = e.target.closest("[data-voice]");
  if (!row) return;
  const id = row.dataset.voice;
  if (vd.multi) {
    if (vd.selected.includes(id)) vd.selected = vd.selected.filter((x) => x !== id);
    else if (vd.selected.length < MAX_COMPARE) vd.selected.push(id);
    else return toast(`比べられるのは ${MAX_COMPARE} 声までです`);
    vd.onPick && vd.onPick(vd.selected.slice());
    renderVoiceDialog();
  } else {
    vd.onPick && vd.onPick(id);
    $("#voiceDialog").close();
  }
});

$("#voiceDialog").addEventListener("close", () => {
  if (playingKey.startsWith("pv:")) audio.pause();
});

// ===================== 聞き比べ =====================

let cmpController = null;
const cmpResults = new Map();

function renderCompareForm() {
  const c = state.compare;
  $("#cmpText").value = c.text;
  $("#cmpStyle").value = c.style;
  $("#cmpLevel").checked = c.level !== false;
  $("#cmpVoices").innerHTML = c.voices
    .map((id) => `<span class="chip">${escapeHtml(voiceInfo(id).title)}<button type="button" data-unvoice="${escapeHtml(id)}" aria-label="${escapeHtml(voiceInfo(id).title)} を外す">×</button></span>`)
    .join("") || `<span class="help">声を選んでください</span>`;
}

$("#cmpText").addEventListener("input", (e) => { state.compare.text = e.target.value; save(); });
$("#cmpStyle").addEventListener("input", (e) => { state.compare.style = e.target.value; save(); });
$("#cmpVoices").addEventListener("click", (e) => {
  const b = e.target.closest("[data-unvoice]");
  if (!b) return;
  state.compare.voices = state.compare.voices.filter((x) => x !== b.dataset.unvoice);
  save();
  renderCompareForm();
});
$("#cmpAddVoice").addEventListener("click", () => {
  vd = { ...vd, current: "", allowMine: true, multi: true, selected: state.compare.voices.slice(), tab: "core" };
  vd.onPick = (ids) => {
    state.compare.voices = ids;
    save();
    renderCompareForm();
  };
  renderVoiceDialog();
  $("#voiceDialog").showModal();
});
$("#cmpLevel").addEventListener("change", (e) => {
  state.compare.level = e.target.checked;
  save();
  if (playingKey.startsWith("cmp:")) audio.pause();
  renderCompareGrid();
});

function renderCompareGrid() {
  const ids = [...cmpResults.keys()];
  const lv = state.compare.level !== false;
  $("#cmpGrid").innerHTML = ids
    .map((id) => {
      const r = cmpResults.get(id);
      const v = voiceInfo(id);
      if (r.error) {
        return `<div class="cmp-card"><div class="cmp-top"><div><div class="cmp-name">${escapeHtml(v.title)}</div><div class="cmp-sub">${escapeHtml(v.sub)}</div></div></div><p class="run-status error">${escapeHtml(r.error)}</p></div>`;
      }
      if (!r.samples) {
        return `<div class="cmp-card loading"><div class="cmp-top"><div><div class="cmp-name">${escapeHtml(v.title)}</div><div class="cmp-sub">${escapeHtml(v.sub)}</div></div></div><div class="skeleton"></div><div class="cmp-stats">順番を待っています</div></div>`;
      }
      return `<div class="cmp-card" data-cmp="${escapeHtml(id)}">
        <div class="cmp-top">
          <button type="button" class="play-btn small" data-play-key="cmp:${escapeHtml(id)}:${lv ? "lv" : "raw"}" data-cmp-play="${escapeHtml(id)}" aria-label="再生">▶</button>
          <div><div class="cmp-name">${escapeHtml(v.title)}</div><div class="cmp-sub">${escapeHtml(v.sub)}</div></div>
        </div>
        <canvas data-cmp-wave="${escapeHtml(id)}" height="36"></canvas>
        <div class="cmp-stats">${r.sec.toFixed(2)} 秒・素の音量 ${r.rawDb.toFixed(1)} dB${lv ? ` → ${LEVEL_DB} dB` : ""}</div>
        <div class="cmp-actions">
          <button type="button" class="btn-ghost btn-sm" data-cmp-use="${escapeHtml(id)}">この声で生成</button>
          <button type="button" class="btn-ghost btn-sm" data-cmp-save="${escapeHtml(id)}">履歴に残す</button>
        </div>
      </div>`;
    })
    .join("");
  redrawCompare();
  syncPlayButtons();
}

function redrawCompare() {
  const lv = state.compare.level !== false;
  for (const c of $$("[data-cmp-wave]")) {
    const r = cmpResults.get(c.dataset.cmpWave);
    if (r && r.samples) drawWave(c, lv ? r.peaksLv : r.peaksRaw, 0);
  }
}

async function runCompare() {
  const c = state.compare;
  if (!c.text.trim()) return setStatus($("#cmpStatus"), "台本を書いてください", true);
  if (!c.voices.length) return setStatus($("#cmpStatus"), "比べる声を選んでください", true);
  if (!state.settings.demo && !store.getKey()) return setStatus($("#cmpStatus"), "API キーが設定されていません。設定画面で入れてください", true);
  for (const r of cmpResults.values()) { if (r.urlRaw) URL.revokeObjectURL(r.urlRaw); if (r.urlLv) URL.revokeObjectURL(r.urlLv); }
  cmpResults.clear();
  for (const id of c.voices) cmpResults.set(id, {});
  renderCompareGrid();
  cmpController = new AbortController();
  $("#cmpRun").disabled = true;
  $("#cmpStop").hidden = false;
  let done = 0;
  try {
    for (const id of c.voices) {
      try {
        const body = buildTtsBody({ model: draft().model, mode: "solo", voice: id, parts: [{ text: c.text, style: c.style }] });
        const a = await tts(body, { signal: cmpController.signal, label: `cmp:${id}` });
        const raw = trimSilence(a.samples, a.rate);
        const lv = levelSamples(raw, a.rate, LEVEL_DB).samples;
        cmpResults.set(id, {
          samples: raw, lv, rate: a.rate, rawDb: activeDb(raw), sec: seconds(raw, a.rate), body,
          urlRaw: URL.createObjectURL(wavBlob(raw, a.rate)), urlLv: URL.createObjectURL(wavBlob(lv, a.rate)),
          peaksRaw: peaks(raw, 300), peaksLv: peaks(lv, 300),
        });
      } catch (e) {
        if (e.name === "AbortError") throw e;
        cmpResults.set(id, { error: e.message });
      }
      done++;
      renderCompareGrid();
      setStatus($("#cmpStatus"), `${done} / ${c.voices.length} 声できました`);
    }
    setStatus($("#cmpStatus"), `${c.voices.length} 声そろいました。「音量をそろえて聞く」で、そろえた音と素の音を切り替えられます。`);
  } catch (e) {
    clearInterval(countdown);
    if (e.name === "AbortError") {
      for (const [id, r] of cmpResults) if (!r.samples && !r.error) cmpResults.delete(id);
      renderCompareGrid();
      setStatus($("#cmpStatus"), "中止しました");
    } else setStatus($("#cmpStatus"), e.message, true);
  } finally {
    $("#cmpRun").disabled = false;
    $("#cmpStop").hidden = true;
    cmpController = null;
  }
}

$("#cmpRun").addEventListener("click", runCompare);
$("#cmpStop").addEventListener("click", () => cmpController && cmpController.abort());

$("#cmpGrid").addEventListener("click", async (e) => {
  const play = e.target.closest("[data-cmp-play]");
  if (play) {
    const r = cmpResults.get(play.dataset.cmpPlay);
    const lv = state.compare.level !== false;
    return togglePlay(play.dataset.playKey, () => (lv ? r.urlLv : r.urlRaw));
  }
  const use = e.target.closest("[data-cmp-use]");
  if (use) {
    const d = draft();
    d.mode = "solo";
    d.voice = use.dataset.cmpUse;
    save();
    renderRunPanel();
    renderParts();
    switchView("generate");
    toast(`声を「${voiceInfo(d.voice).title}」にしました`);
    return;
  }
  const sv = e.target.closest("[data-cmp-save]");
  if (sv) {
    const id = sv.dataset.cmpSave;
    const r = cmpResults.get(id);
    const lv = state.compare.level !== false;
    const s = lv ? r.lv : r.samples;
    try {
      await store.addHistory({
        id: newId(), createdAt: Date.now(), kind: "compare", demo: !!state.settings.demo, model: draft().model, mode: "solo", voice: id,
        speakers: [], parts: [{ text: state.compare.text, style: state.compare.style }], sec: seconds(s, r.rate), rawDb: r.rawDb, wav: wavBlob(s, r.rate),
      });
      sv.disabled = true;
      sv.textContent = "残しました";
    } catch {
      toast("履歴に保存できませんでした");
    }
  }
});

// ===================== 声をつくる =====================

function renderDesignExamples() {
  $("#dExamples").innerHTML = DESIGN_EXAMPLES.map((t, i) => `<button type="button" class="chip-btn" data-ex="${i}">${escapeHtml(t.split("。")[0])}</button>`).join("");
}
$("#dExamples").addEventListener("click", (e) => {
  const b = e.target.closest("[data-ex]");
  if (!b) return;
  $("#dDesc").value = DESIGN_EXAMPLES[Number(b.dataset.ex)];
  if (!$("#dName").value.trim()) $("#dName").value = DESIGN_EXAMPLES[Number(b.dataset.ex)].split("。")[0];
});

$("#designForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("#dName").value.trim();
  const desc = $("#dDesc").value.trim();
  if (!name || !desc) return setStatus($("#dStatus"), "名前と「どんな人の声か」を書いてください", true);
  if (state.settings.demo || !store.getKey()) return setStatus($("#dStatus"), "声をつくるには API キーが要ります（キーなしで試すモードでは使えません）", true);
  $("#dRun").disabled = true;
  setStatus($("#dStatus"), "声をつくっています…（20秒ほどかかります）");
  try {
    const { voice, sample } = await client.createVoice(
      { displayName: name, description: desc, gender: $("#dGender").value, languageCode: $("#dLang").value, model: MODELS[0].id },
      {}
    );
    const id = voiceId(voice.id || voice.name);
    const entry = { id, name: voice.display_name || name, desc: voice.prompted?.input || desc, expire: voice.expire_time || "", lang: voice.language_code || $("#dLang").value, gender: voice.gender || "" };
    state.myVoices = [entry, ...state.myVoices.filter((v) => v.id !== id)];
    save();
    if (sample) {
      const blob = wavBlob(trimSilence(sample.samples, sample.rate), sample.rate);
      await store.putSample(id, blob).catch(() => {});
    }
    $("#dResult").hidden = false;
    $("#dResult").innerHTML = `<div class="cmp-top">
        <button type="button" class="play-btn small" data-play-key="pv:${escapeHtml(id)}" data-preview="${escapeHtml(id)}" aria-label="お試しの声を再生">▶</button>
        <div><div class="cmp-name">${escapeHtml(entry.name)}</div><div class="cmp-sub">${escapeHtml(id)}</div></div>
      </div>
      <div class="compare-actions"><button type="button" class="btn-ghost btn-sm" data-use-voice="${escapeHtml(id)}">この声で生成</button></div>`;
    setStatus($("#dStatus"), "できました。お試しの声を聞いてみてください");
    renderMyVoices();
  } catch (err) {
    setStatus($("#dStatus"), err.message, true);
  } finally {
    $("#dRun").disabled = false;
  }
});

function useVoice(id) {
  const d = draft();
  d.mode = "solo";
  d.voice = id;
  save();
  renderRunPanel();
  renderParts();
  switchView("generate");
  toast(`声を「${voiceInfo(id).title}」にしました`);
}

async function renderMyVoices() {
  const list = state.myVoices;
  if (!list.length) {
    $("#myVoiceList").innerHTML = `<li class="empty">${store.getKey() ? "まだありません。作るか「一覧を更新」で読み込みます。" : "API キーを設定すると、プロジェクトに保存した声の一覧を読み込めます。"}</li>`;
    return;
  }
  const has = await Promise.all(list.map((v) => store.getSample(v.id).then(Boolean).catch(() => false)));
  $("#myVoiceList").innerHTML = list
    .map((v, i) => `<li class="myvoice">
      ${has[i]
        ? `<button type="button" class="play-btn small" data-play-key="pv:${escapeHtml(v.id)}" data-preview="${escapeHtml(v.id)}" aria-label="試聴">▶</button>`
        : `<button type="button" class="play-btn small" disabled aria-label="試聴音声なし">▶</button>`}
      <div class="mv-name">${escapeHtml(v.name)}</div>
      <div class="mv-desc">${escapeHtml(v.desc)}</div>
      <div class="mv-meta">${escapeHtml(v.id)}${v.expire ? `・${new Date(v.expire).toLocaleDateString("ja-JP")} まで（使うと延びる）` : ""}</div>
      <div class="mv-actions">
        <button type="button" class="btn-ghost btn-sm" data-use-voice="${escapeHtml(v.id)}">この声で生成</button>
        ${has[i] ? "" : `<button type="button" class="btn-ghost btn-sm" data-make-sample="${escapeHtml(v.id)}">試聴を読み込む</button>`}
        <button type="button" class="btn-ghost btn-sm danger" data-del-voice="${escapeHtml(v.id)}">削除</button>
      </div>
    </li>`)
    .join("");
  syncPlayButtons();
}

$("#dRefresh").addEventListener("click", async () => {
  if (!store.getKey()) return setStatus($("#dStatus"), "API キーが設定されていません", true);
  setStatus($("#dStatus"), "一覧を読み込んでいます…");
  try {
    const all = [];
    let tok = null;
    do {
      const r = await client.listVoices({ type: "prompted", pageSize: 100, pageToken: tok });
      all.push(...r.voices);
      tok = r.nextPageToken;
    } while (tok && all.length < 400);
    state.myVoices = all
      .filter((v) => v.type === "prompted")
      .map((v) => ({ id: voiceId(v.id || v.name), name: v.display_name || v.id, desc: v.prompted?.input || "", expire: v.expire_time || "", lang: v.language_code || "", gender: v.gender || "" }));
    save();
    setStatus($("#dStatus"), `${state.myVoices.length} 声を読み込みました`);
    renderMyVoices();
  } catch (e) {
    setStatus($("#dStatus"), e.message, true);
  }
});

document.addEventListener("click", async (e) => {
  const use = e.target.closest("[data-use-voice]");
  if (use) return useVoice(use.dataset.useVoice);
  const pv = e.target.closest("#dResult [data-preview], #myVoiceList [data-preview]");
  if (pv) return togglePlay(`pv:${pv.dataset.preview}`, () => previewUrl(pv.dataset.preview));
  const mk = e.target.closest("[data-make-sample]");
  if (mk) {
    const id = mk.dataset.makeSample;
    mk.disabled = true;
    setStatus($("#dStatus"), `${sampleNotice(id)}…`);
    try {
      await obtainSample(id, "sample");
      setStatus($("#dStatus"), "試聴音声を用意しました");
      renderMyVoices();
    } catch (err) {
      setStatus($("#dStatus"), err.message, true);
      mk.disabled = false;
    }
    return;
  }
  const del = e.target.closest("[data-del-voice]");
  if (del) {
    const id = del.dataset.delVoice;
    const v = voiceInfo(id);
    if (!(await confirmDialog("この声を削除しますか", `「${v.title}」を Google のプロジェクトから削除します。元に戻せません。`, "削除する"))) return;
    try {
      await client.deleteVoice(id);
      state.myVoices = state.myVoices.filter((x) => x.id !== id);
      await store.deleteSample(id).catch(() => {});
      if (draft().voice === id) draft().voice = "Zephyr";
      save();
      renderMyVoices();
      renderRunPanel();
      toast("削除しました");
    } catch (err) {
      setStatus($("#dStatus"), err.message, true);
    }
  }
});

// ===================== 履歴 =====================

async function renderHistory() {
  let list = [];
  try {
    list = await store.listHistory();
  } catch {
    $("#histList").innerHTML = `<li class="empty">このブラウザでは履歴を保存できません（プライベートウィンドウなど）。</li>`;
    return;
  }
  const est = await store.storageEstimate();
  const total = list.reduce((a, h) => a + (h.bytes || 0), 0);
  $("#histUsage").textContent =
    `生成した音声は、このブラウザの中にだけ保存されます。${list.length} 件・${(total / 1e6).toFixed(1)} MB` +
    (est && est.quota ? `（このサイトで使える量 約 ${Math.round(est.quota / 1e6).toLocaleString()} MB）` : "") +
    (total > 300e6 ? "。多くなってきたので、古いものの削除をおすすめします。" : "");
  if (!list.length) {
    $("#histList").innerHTML = `<li class="empty">まだありません。「生成」で作った音声がここに残ります。</li>`;
    return;
  }
  $("#histList").innerHTML = list
    .map((h) => {
      const who = h.mode === "duo" ? h.speakers.map((s) => voiceInfo(s.voice).title).join("・") : voiceInfo(h.voice).title;
      const text = h.parts.map((p) => p.text).join(" ").replace(/\s+/g, " ");
      return `<li class="hist" data-hist="${h.id}">
        <button type="button" class="play-btn small" data-play-key="hist:${h.id}" data-hist-play="${h.id}" aria-label="再生">▶</button>
        <div class="h-text">${escapeHtml(text)}</div>
        <div class="h-meta">${new Date(h.createdAt).toLocaleString("ja-JP")}・${escapeHtml(who)}・${h.sec.toFixed(1)} 秒${h.kind === "compare" ? "・聞き比べ" : ""}${h.demo ? "・試聴音声" : ""}</div>
        <div class="h-actions">
          <button type="button" class="btn-ghost btn-sm" data-hist-load="${h.id}">設定を読み込む</button>
          <button type="button" class="btn-ghost btn-sm" data-hist-dl="wav" data-id="${h.id}">WAV</button>
          <button type="button" class="btn-ghost btn-sm" data-hist-dl="srt" data-id="${h.id}">SRT</button>
          <button type="button" class="btn-ghost btn-sm" data-hist-dl="vtt" data-id="${h.id}">VTT</button>
          <button type="button" class="btn-ghost btn-sm danger" data-hist-del="${h.id}">削除</button>
        </div>
      </li>`;
    })
    .join("");
  syncPlayButtons();
}

const histUrls = new Map();
$("#histList").addEventListener("click", async (e) => {
  const play = e.target.closest("[data-hist-play]");
  if (play) {
    const id = play.dataset.histPlay;
    return togglePlay(`hist:${id}`, async () => {
      if (histUrls.has(id)) return histUrls.get(id);
      const h = await store.getHistory(id);
      if (!h || !h.wav) return null;
      const url = URL.createObjectURL(h.wav);
      histUrls.set(id, url);
      return url;
    });
  }
  const load = e.target.closest("[data-hist-load]");
  if (load) {
    const h = await store.getHistory(load.dataset.histLoad);
    if (!h) return;
    const d = draft();
    d.model = h.model;
    d.mode = h.mode;
    if (h.voice) d.voice = h.voice;
    if (h.speakers && h.speakers.length) d.speakers = h.speakers.map((x) => ({ ...x }));
    d.parts = h.parts.map((p) => ({ id: newId(), speaker: p.speaker || speakerNames()[0], text: p.text, style: p.style || "" }));
    save();
    renderRunPanel();
    renderParts();
    switchView("generate");
    toast("台本と設定を読み込みました");
    return;
  }
  const dl = e.target.closest("[data-hist-dl]");
  if (dl) {
    const h = await store.getHistory(dl.dataset.id);
    if (!h || !h.wav) return;
    const base = `koe-${stamp(new Date(h.createdAt))}`;
    if (dl.dataset.histDl === "wav") return download(h.wav, `${base}.wav`);
    const { samples: s, rate } = parseWav(new Uint8Array(await h.wav.arrayBuffer()));
    const cues = subtitleFor(h, s, rate);
    if (dl.dataset.histDl === "srt") download(new Blob([toSrt(cues)], { type: "application/x-subrip" }), `${base}.srt`);
    else download(new Blob([toVtt(cues)], { type: "text/vtt" }), `${base}.vtt`);
    toast("字幕の時刻は目安です（文の境目を無音の位置に合わせています）");
    return;
  }
  const del = e.target.closest("[data-hist-del]");
  if (del) {
    const id = del.dataset.histDel;
    if (playingKey === `hist:${id}`) audio.pause();
    await store.deleteHistory(id).catch(() => {});
    if (histUrls.has(id)) { URL.revokeObjectURL(histUrls.get(id)); histUrls.delete(id); }
    renderHistory();
  }
});

$("#histClear").addEventListener("click", async () => {
  if (!(await confirmDialog("履歴をすべて削除しますか", "このブラウザに保存した音声がすべて消えます。元に戻せません。", "すべて削除"))) return;
  audio.pause();
  await store.clearHistory().catch(() => {});
  renderHistory();
});

// ===================== 設定 =====================

function renderSettings() {
  const key = store.getKey();
  $("#keyInput").value = key;
  $("#keyInput").type = "password";
  $("#keyShow").textContent = "表示";
  for (const r of $$('input[name="keyMode"]')) r.checked = r.value === state.settings.keyMode;
  $("#intervalInput").value = state.settings.interval;
  $("#demoToggle").checked = !!state.settings.demo;
  $("#themeSelect").value = state.settings.theme;
  renderDict();
}

function renderDict() {
  const entries = Object.entries(state.dict);
  $("#dictList").innerHTML = entries.length
    ? entries.map(([w, r]) => `<li class="chip">${escapeHtml(w)} → ${escapeHtml(r)}<button type="button" data-undict="${escapeHtml(w)}" aria-label="${escapeHtml(w)} を辞書から外す">×</button></li>`).join("")
    : `<li class="help">まだ登録はありません。</li>`;
}

$("#keyShow").addEventListener("click", () => {
  const input = $("#keyInput");
  input.type = input.type === "password" ? "text" : "password";
  $("#keyShow").textContent = input.type === "password" ? "表示" : "隠す";
});

$("#keyForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const key = $("#keyInput").value.trim();
  const mode = $('input[name="keyMode"]:checked')?.value || "local";
  if (!key) return setStatus($("#keyStatus"), "キーを入れてください", true);
  state.settings.keyMode = mode;
  if (!store.setKey(key, mode)) return setStatus($("#keyStatus"), "このブラウザではキーを保存できませんでした", true);
  save();
  renderKeyChip();
  setStatus($("#keyStatus"), mode === "session" ? "保存しました（このタブを閉じると消えます）" : "保存しました（この端末のブラウザに残ります）");
});

$("#keyTest").addEventListener("click", async () => {
  if (!store.getKey()) return setStatus($("#keyStatus"), "先にキーを保存してください", true);
  setStatus($("#keyStatus"), "確かめています…");
  try {
    await client.listVoices({ pageSize: 1 });
    setStatus($("#keyStatus"), "つながりました。音声を作れます（この確認では料金はかかりません）");
  } catch (err) {
    setStatus($("#keyStatus"), err.message, true);
  }
});

$("#keyClear").addEventListener("click", async () => {
  if (!(await confirmDialog("キーを消しますか", "このブラウザに保存したキーを消します。Google 側のキーは消えません。", "消す"))) return;
  store.clearKey();
  $("#keyInput").value = "";
  renderKeyChip();
  setStatus($("#keyStatus"), "消しました");
});

$("#intervalInput").addEventListener("change", (e) => {
  const v = Math.min(120, Math.max(0, Number(e.target.value) || 0));
  state.settings.interval = v;
  e.target.value = v;
  save();
});

$("#dictForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const w = $("#dictWord").value.trim();
  const r = $("#dictRead").value.trim();
  if (!w || !r) return toast("語と読みの両方を入れてください");
  state.dict[w] = r;
  $("#dictWord").value = "";
  $("#dictRead").value = "";
  save();
  renderDict();
  updateDerived();
});

$("#dictList").addEventListener("click", (e) => {
  const b = e.target.closest("[data-undict]");
  if (!b) return;
  delete state.dict[b.dataset.undict];
  save();
  renderDict();
  updateDerived();
});

$("#demoToggle").addEventListener("change", (e) => {
  state.settings.demo = e.target.checked;
  save();
  renderKeyChip();
});

$("#themeSelect").addEventListener("change", (e) => {
  state.settings.theme = e.target.value;
  applyTheme();
  save();
});

$("#resetAll").addEventListener("click", async () => {
  if (!(await confirmDialog("設定と下書きを初期化しますか", "台本・設定・読み辞書・自分の声の一覧（キャッシュ）を初期状態に戻します。API キーと履歴は残ります。", "初期化"))) return;
  store.clearState();
  location.reload();
});

// ===================== 起動 =====================

async function loadData() {
  try {
    const [v, s] = await Promise.all([fetch("data/voices.json").then((r) => r.json()), fetch("data/samples.json").then((r) => r.json())]);
    catalog = { core: v.core || [], library: v.library || [], sampleText: v.sampleText || "" };
    samples = s.samples || [];
  } catch {
    toast("声の一覧を読み込めませんでした");
  }
}

async function init() {
  applyTheme();
  renderKeyChip();
  await loadData();
  renderSampleSelect();
  renderDesignExamples();
  renderRunPanel();
  renderParts();
  renderCompareForm();
  switchView(state.view || "generate");
  if (!store.getKey() && !state.settings.demo) setStatus($("#runStatus"), "API キーを設定画面で入れると生成できます。キーなしで試すこともできます。");
  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}

init();
