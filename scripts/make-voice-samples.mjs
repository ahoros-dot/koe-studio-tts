#!/usr/bin/env node
/**
 * 試聴用の音声と声の一覧（data/voices.json）を作る。キーは環境変数 GEMINI_API_KEY。
 * （こえスタジオのディレクトリで実行する）
 *   node scripts/make-voice-samples.mjs            # 未生成の声だけ
 *   node scripts/make-voice-samples.mjs --force    # 全部作り直す
 *   node scripts/make-voice-samples.mjs --only core|library [--limit 3]
 *   node scripts/make-voice-samples.mjs --json-only # 音声は作らず voices.json だけ書き直す
 *
 * - core: 用意された30声（名前と特徴は音声生成ガイドの一覧、2026-10-04 確認）
 * - library: 拡張ボイスライブラリのうち日本語（ja-JP）の声。API の一覧（GET /v1beta/voices?language_code=ja-JP）から取り、
 *   説明文（英語）を下の辞書で日本語にする。辞書にない語は英語のまま残し、最後に一覧で知らせる
 * どの声も同じ1文を読ませ、前後の無音を切って音量をそろえ（話している所の平均 −16dB）、ffmpeg で MP3（32kbps）にする。
 * 素の音量（そろえる前）と声の高さ（中央値 Hz）も測って voices.json に書く。キーのない人も試聴できるようにするため。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createClient, buildTtsBody, MODELS } from "../gemini.js";
import { trimSilence, levelSamples, activeDb, seconds, RATE } from "../audio.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_JSON = join(ROOT, "data", "voices.json");
const argv = process.argv.slice(2);
const flag = (k) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] ?? true : null;
};
const FORCE = argv.includes("--force");
const JSON_ONLY = argv.includes("--json-only");
const ONLY = flag("only");
const LIMIT = flag("limit") ? Number(flag("limit")) : Infinity;

export const SAMPLE_TEXT = "こんにちは。今日はどんなお話を読みましょうか。";
const LEVEL_DB = -16;

// 用意された30声。trait は公式の一語、ja はその訳
const CORE = [
  ["Zephyr", "Bright", "明るい"], ["Puck", "Upbeat", "弾む"], ["Charon", "Informative", "説明上手"], ["Kore", "Firm", "きっぱり"],
  ["Fenrir", "Excitable", "興奮ぎみ"], ["Leda", "Youthful", "若々しい"], ["Orus", "Firm", "きっぱり"], ["Aoede", "Breezy", "さわやか"],
  ["Callirrhoe", "Easy-going", "おおらか"], ["Autonoe", "Bright", "明るい"], ["Enceladus", "Breathy", "息まじり"], ["Iapetus", "Clear", "くっきり"],
  ["Umbriel", "Easy-going", "おおらか"], ["Algieba", "Smooth", "なめらか"], ["Despina", "Smooth", "なめらか"], ["Erinome", "Clear", "くっきり"],
  ["Algenib", "Gravelly", "しゃがれ声"], ["Rasalgethi", "Informative", "説明上手"], ["Laomedeia", "Upbeat", "弾む"], ["Achernar", "Soft", "やわらか"],
  ["Alnilam", "Firm", "きっぱり"], ["Schedar", "Even", "むらのない"], ["Gacrux", "Mature", "大人びた"], ["Pulcherrima", "Forward", "前に出る"],
  ["Achird", "Friendly", "親しみやすい"], ["Zubenelgenubi", "Casual", "くだけた"], ["Vindemiatrix", "Gentle", "やさしい"], ["Sadachbia", "Lively", "生き生き"],
  ["Sadaltager", "Knowledgeable", "物知り"], ["Sulafat", "Warm", "あたたかい"],
];

// ---- 拡張ボイスライブラリの説明文を日本語に ----
const ACCENT = { "Tokyo Japanese": "東京", "Osaka Japanese": "大阪", "Fukuoka Japanese": "福岡" };
const GENDER = { female: "女性", male: "男性", neutral: "中性" };
const PITCH = { high: "高め", medium: "中くらい", low: "低め" };
const CONTEXT = {
  "Enterprise Agent": "業務・案内", "Content & Media": "コンテンツ・メディア", "Conversational / Edu": "会話・教育",
  "Growth & Marketing": "広告・マーケティング", "Entertainment & Gaming": "エンタメ・ゲーム", "Wellness & Culture": "ウェルネス・文化",
};
const OCC = {
  "Doctor": "医師", "Financial Advisor": "ファイナンシャルアドバイザー", "Researcher": "研究者", "Lawyer": "弁護士",
  "Parent": { male: "父親", female: "母親", _: "親" }, "Friend": "友だち", "Best Friend": "親友",
  "Grandparent": { male: "おじいちゃん", female: "おばあちゃん", _: "祖父母" }, "Sibling": "きょうだい",
  "Influencer": "インフルエンサー", "Fashion Consultant": "ファッションコンサルタント", "Executive Assistant": "秘書",
  "Event Planner": "イベントプランナー", "Concierge": "コンシェルジュ", "Hotel Concierge": "ホテルのコンシェルジュ", "Tour Guide": "ツアーガイド",
  "Sales Associate": "販売員", "Social Worker": "ソーシャルワーカー", "Customer Service Agent": "カスタマーサポート",
  "Person Giving Driving Directions": "道案内をする人", "Podcast Interviewer": "ポッドキャストの聞き手", "Radio Host": "ラジオパーソナリティ",
  "Trivia Host": "クイズ番組の司会", "Political Activist": "政治活動家", "Nature Documentary Narrator": "自然ドキュメンタリーのナレーター",
  "Storyteller": "語り手", "Philosopher": "哲学者", "Architect": "建築家", "Tech Support Agent": "テクニカルサポート",
  "Instructional Video Host": "解説動画の案内役", "Cooking Show Host": "料理番組の司会", "Librarian": "司書", "Chess Instructor": "チェスの先生",
  "Professor": "教授", "Counselor": "カウンセラー", "Therapist": "セラピスト", "Teacher": "先生", "Lifestyle Coach": "ライフコーチ",
  "Writing Tutor": "文章の先生",
};
const WORD = {
  "objective": "客観的", "direct": "率直", "helpful": "頼りになる", "warm": "あたたかい", "engaging": "引き込まれる", "cool": "クール",
  "confident": "自信がある", "collaborative": "協調的", "natural": "自然", "clear": "はっきり", "relaxed": "リラックス", "medium-pitch": "中くらいの高さ",
  "friendly": "親しみやすい", "textured": "味がある", "resonant": "よく響く", "soothing": "癒やし系", "bright": "明るい", "breezy": "さわやか",
  "youthful": "若々しい", "light": "軽やか", "airy": "ふんわり", "precise": "正確", "crisp": "歯切れがよい", "eager": "意欲的",
  "professional": "プロらしい", "approachable": "話しかけやすい", "laid-back": "のんびり", "encouraging": "励ましてくれる", "chill": "ゆるい",
  "witty": "気が利いている", "deep": "深い", "velvety": "なめらか", "unhurried": "急がない", "highly approachable": "とても話しかけやすい",
  "empathic": "共感的", "reflective": "思慮深い", "calm": "落ち着いている", "reassuring": "安心できる", "energetic": "元気", "colorful": "表情豊か",
  "fast": "速い", "intimate talkshow": "親密なトーク番組風", "comforting someone who is stressed": "不安な人をなだめるよう", "peer-to-peer": "対等",
  "curious": "好奇心旺盛", "conversational": "会話的", "slightly dry humor": "少しドライなユーモア",
};
const SITUATION = {
  "on podcast": "ポッドキャストに出演中", "sitting next to you on the bus": "バスで隣に座っている", "on npr": "公共ラジオに出演中",
  "brainstorming in a meeting": "会議でアイデア出し中", "sitting on couch": "ソファでくつろぎ中", "in an indie film": "インディー映画の一場面",
  "in an oscar winning film": "アカデミー賞映画の一場面", "at an appointment": "面談中", "at a meditation retreat": "瞑想合宿中",
  "on the phone": "電話中", "in a bookstore": "書店にいる",
};
const unknown = new Set();
const tr = (dict, key, gender) => {
  const v = dict[key];
  if (v == null) {
    unknown.add(key);
    return key;
  }
  return typeof v === "object" ? v[gender] || v._ : v;
};

function describeLibrary(v) {
  const d = v.description || "";
  const m = d.match(/^(\d+)-year-old (.+?) from (\w+)\./);
  const tones = [];
  let situation = "";
  for (const s of d.split(/\.\s*/)) {
    const t = s.match(/^(?:Tone|Voice) is (.+)$/) || s.match(/^Sounds (.+)$/);
    if (t) for (const w of t[1].split(/,\s*(?:and\s+)?|\s+and\s+|\s+yet\s+/)) if (w.trim()) tones.push(tr(WORD, w.trim()));
    const c = s.match(/^Currently (.+)$/);
    if (c) situation = tr(SITUATION, c[1].trim());
  }
  return {
    age: m ? Number(m[1]) : null,
    role: m ? tr(OCC, m[2], v.gender) : "",
    tones,
    situation,
  };
}

// ---- 声の高さ（自己相関で 70〜400Hz を探し、有声のフレームの中央値） ----
function medianF0(samples, rate = RATE) {
  const frame = Math.round(rate * 0.04);
  const hop = Math.round(rate * 0.01);
  const minLag = Math.floor(rate / 400);
  const maxLag = Math.ceil(rate / 70);
  const f0s = [];
  const x = Float32Array.from(samples, (v) => v / 32768);
  for (let s = 0; s + frame + maxLag < x.length; s += hop) {
    let e = 0;
    for (let i = 0; i < frame; i++) e += x[s + i] * x[s + i];
    if (Math.sqrt(e / frame) < 0.03) continue;
    let best = 0;
    let bestLag = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let c = 0;
      let e2 = 0;
      for (let i = 0; i < frame; i++) {
        c += x[s + i] * x[s + i + lag];
        e2 += x[s + i + lag] * x[s + i + lag];
      }
      const r = c / Math.sqrt(e * e2 + 1e-12);
      if (r > best) {
        best = r;
        bestLag = lag;
      }
    }
    if (best > 0.6) f0s.push(rate / bestLag);
  }
  if (!f0s.length) return null;
  f0s.sort((a, b) => a - b);
  return Math.round(f0s[f0s.length >> 1]);
}

function toMp3(samples, out) {
  const r = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "s16le", "-ar", String(RATE), "-ac", "1", "-i", "pipe:0", "-codec:a", "libmp3lame", "-b:a", "32k", out], {
    input: Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength),
  });
  if (r.status !== 0) throw new Error(`ffmpeg 失敗: ${r.stderr}`);
}

// ---- 本体 ----
const KEY = process.env.GEMINI_API_KEY;
if (!KEY) {
  console.error("✗ GEMINI_API_KEY が未設定です");
  process.exit(1);
}
const client = createClient({
  getKey: () => KEY,
  onStatus: (s) => {
    if (s.type === "retry") console.log(`  … ${s.message}（${s.wait.toFixed(1)}秒待って再試行）`);
  },
});
const prev = existsSync(OUT_JSON) ? JSON.parse(readFileSync(OUT_JSON, "utf8")) : { core: [], library: [] };
const prevById = new Map([...prev.core, ...prev.library].map((v) => [v.id, v]));

const core = CORE.map(([name, trait, ja]) => ({ id: name, name, trait, ja, file: `data/voices/${name}.mp3` }));
let library = [];
if (ONLY !== "core") {
  let tok = null;
  do {
    const r = await client.listVoices({ languageCode: "ja-JP", pageSize: 100, pageToken: tok });
    library.push(...r.voices);
    tok = r.nextPageToken;
  } while (tok);
  library = library
    .filter((v) => v.type === "prebuilt")
    .map((v) => ({
      id: v.id,
      name: v.display_name,
      accent: ACCENT[v.accent] || v.accent,
      gender: v.gender,
      genderJa: GENDER[v.gender] || v.gender,
      pitch: v.pitch,
      pitchJa: PITCH[v.pitch] || v.pitch,
      context: CONTEXT[v.context] || v.context,
      ...describeLibrary(v),
      description: v.description,
      file: `data/voices/lib/${v.id}.mp3`,
    }))
    .sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
  console.log(`拡張ボイスライブラリ（ja-JP）: ${library.length}声`);
} else {
  library = prev.library.map((v) => ({ ...v, file: `data/voices/lib/${v.id}.mp3` }));
}
if (ONLY === "library") prev.core = prev.core.map((v) => ({ ...v, file: `data/voices/${v.id}.mp3` }));

mkdirSync(join(ROOT, "data/voices/lib"), { recursive: true });
const targets = [...(ONLY === "library" ? [] : core), ...(ONLY === "core" ? [] : library)];
// file は試聴音声がある声にだけ書く（ない声は、画面がキーを使ってその場で作る）
const writeJson = () => {
  const strip = (list) => list.map((v) => (v.rawDb != null && existsSync(join(ROOT, v.file)) ? v : { ...v, file: undefined }));
  writeFileSync(OUT_JSON, JSON.stringify({ sampleText: SAMPLE_TEXT, levelDb: LEVEL_DB, core: strip(ONLY === "library" ? prev.core : core), library: strip(library) }, null, 1) + "\n");
};
for (const v of targets) {
  const old = prevById.get(v.id);
  if (old && old.rawDb != null) {
    v.rawDb = old.rawDb;
    v.f0 = old.f0;
    v.sec = old.sec;
  }
}
let made = 0;
let stopped = null;
for (const v of targets) {
  if (JSON_ONLY) break;
  if (!FORCE && existsSync(join(ROOT, v.file)) && v.rawDb != null) continue;
  if (made >= LIMIT) continue;
  let a;
  try {
    a = await client.tts(buildTtsBody({ model: MODELS[0].id, mode: "solo", voice: v.id, parts: [{ text: SAMPLE_TEXT }] }), { label: v.id });
  } catch (e) {
    // 1日の上限（Tier 1 はモデルごとに100回/日）に当たったら、ここまでの分を書いて止める。次に流すと続きから作る
    if (e.daily) {
      stopped = e.message;
      break;
    }
    console.log(`✗ ${v.id}: ${e.message}${e.detail ? `（${e.detail}）` : ""}`);
    continue;
  }
  const trimmed = trimSilence(a.samples, a.rate);
  const lv = levelSamples(trimmed, a.rate, LEVEL_DB);
  toMp3(lv.samples, join(ROOT, v.file));
  v.rawDb = +activeDb(trimmed).toFixed(1);
  v.f0 = medianF0(trimmed, a.rate);
  v.sec = +seconds(trimmed, a.rate).toFixed(2);
  made++;
  console.log(`✓ ${v.id.padEnd(22)} ${v.sec}s  素の音量 ${v.rawDb}dB  高さ ${v.f0 ?? "?"}Hz`);
  writeJson();
}
writeJson();
const missing = targets.filter((v) => v.rawDb == null).length;
console.log(`voices.json: 用意された声 ${core.length}・ライブラリ ${library.length}（今回生成 ${made}、試聴音声なし ${missing}）`);
if (stopped) console.log(`… 止めました: ${stopped}\n   上限が戻ったら同じコマンドで続きから作れます`);
if (unknown.size) console.log(`辞書にない語（英語のまま）: ${[...unknown].join(" / ")}`);
