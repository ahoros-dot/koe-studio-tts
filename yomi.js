/* 日本語の読みの補助（DOM に触らない純粋な関数だけ）
   Gemini TTS の text は「一字一句そのまま読む台本」で、読み方の指示は書けない（かっこも読まれる）。
   実際に「5.5」「68万行」「18本中16本」で読みが揺れたので（memory: gemini-tts.md）、
   数字・英字・記号に印を付け、かなに書き換える候補を出す。 */

// ---- 長さの見積もり ----
// 1行ずつ生成したときの実測は 6.6〜8.8 モーラ/秒（make-narration.mjs の --estimate と同じく、遅い側の 6.8 で見積もる）。
// かな1字＝1モーラ（ゃゅょ等の小書きは前の字とまとめる）、漢字1字≒1.7モーラ。英字・数字はかなに直したときのおおよそ。
export const MORA_PER_SEC = 6.8;

export function stripTags(text) {
  return text.replace(/<[^>]*>/g, "");
}

export function mora(text) {
  let m = 0;
  for (const c of stripTags(text)) {
    if (/[ぁぃぅぇぉゃゅょゎァィゥェォャュョヮ]/.test(c)) continue;
    if (/[぀-ヿ]/.test(c)) m += 1;
    else if (/[一-鿿々]/.test(c)) m += 1.7;
    else if (/[A-Za-z]/.test(c)) m += 1.3;
    else if (/[0-9０-９]/.test(c)) m += 2;
  }
  return Math.round(m);
}

export const estimateSeconds = (text) => mora(text) / MORA_PER_SEC;

// ---- 数字をかなに ----
const DIGIT = ["ぜろ", "いち", "に", "さん", "よん", "ご", "ろく", "なな", "はち", "きゅう"];
const HUNDRED = ["", "ひゃく", "にひゃく", "さんびゃく", "よんひゃく", "ごひゃく", "ろっぴゃく", "ななひゃく", "はっぴゃく", "きゅうひゃく"];
const THOUSAND = ["", "せん", "にせん", "さんぜん", "よんせん", "ごせん", "ろくせん", "ななせん", "はっせん", "きゅうせん"];
const TEN = ["", "じゅう", "にじゅう", "さんじゅう", "よんじゅう", "ごじゅう", "ろくじゅう", "ななじゅう", "はちじゅう", "きゅうじゅう"];
const BIG = [["ちょう", 1e12], ["おく", 1e8], ["まん", 1e4]];

// 0〜9999 を読みの部品に分ける（最後の部品で数え方の音が変わるので、文字列ではなく配列で返す）
function groupTokens(n, beforeBig) {
  const t = [];
  const th = Math.floor(n / 1000);
  const h = Math.floor((n % 1000) / 100);
  const te = Math.floor((n % 100) / 10);
  const o = n % 10;
  // 「1000万」は いっせんまん（千の後に万・億が続くときだけ「いっ」が付く）
  if (th) t.push(th === 1 && beforeBig && !h && !te && !o ? "いっせん" : THOUSAND[th]);
  if (h) t.push(HUNDRED[h]);
  if (te) t.push(TEN[te]);
  if (o) t.push(DIGIT[o]);
  return t;
}

export function integerTokens(n) {
  if (!Number.isFinite(n) || n < 0 || n >= 1e16) return null;
  n = Math.floor(n);
  if (n === 0) return ["ぜろ"];
  const t = [];
  let rest = n;
  for (const [name, unit] of BIG) {
    const g = Math.floor(rest / unit);
    if (g) {
      const gt = groupTokens(g, true);
      // 「1兆」は いっちょう、「8兆」「10兆」は はっちょう・じゅっちょう
      if (name === "ちょう") {
        const last = gt[gt.length - 1];
        if (last === "いち") gt[gt.length - 1] = "いっ";
        else if (last === "はち") gt[gt.length - 1] = "はっ";
        else if (last === "じゅう") gt[gt.length - 1] = "じゅっ";
      }
      t.push(...gt, name);
    }
    rest %= unit;
  }
  if (rest) t.push(...groupTokens(rest, false));
  return t;
}

export function integerToKana(n) {
  const t = integerTokens(n);
  return t ? t.join("") : null;
}

// 小数: 5.5 → ごーてんご、1.25 → いってんにーご（てんの前の「いち・はち・じゅう」は促音、2と5は伸ばす）
export function decimalToKana(str) {
  const [ip, fp] = str.split(".");
  const it = Number(ip) === 0 ? ["れい"] : integerTokens(Number(ip));
  if (!it) return null;
  const last = it[it.length - 1];
  if (last === "いち") it[it.length - 1] = "いっ";
  else if (last === "はち") it[it.length - 1] = "はっ";
  else if (last === "じゅう") it[it.length - 1] = "じゅっ";
  else if (last === "に" && it.length === 1) it[0] = "にー";
  else if (last === "ご" && it.length === 1) it[0] = "ごー";
  const frac = [...fp].map((d, k) => {
    const r = DIGIT[Number(d)];
    if (k < fp.length - 1 && d === "2") return "にー";
    if (k < fp.length - 1 && d === "5") return "ごー";
    return r;
  });
  return it.join("") + "てん" + frac.join("");
}

// ---- 数え方（助数詞）による音の変化 ----
// 最後の部品の「種類」: いち〜きゅう／じゅう／ひゃく（びゃく・ぴゃく含む）／せん（ぜん含む）／まん／おく／ちょう
function tokenClass(tok) {
  if (/ゃく$/.test(tok)) return "ひゃく";
  if (/[せぜ]ん$/.test(tok)) return "せん";
  return tok;
}
// 促音にする: いち→いっ、ろく→ろっ、はち→はっ、じゅう→じゅっ、ひゃく→ひゃっ
function geminate(tok) {
  if (tok === "いち") return "いっ";
  if (tok === "ろく") return "ろっ";
  if (tok === "はち") return "はっ";
  if (tok === "じゅう") return "じゅっ";
  if (/ゃく$/.test(tok)) return tok.slice(0, -1) + "っ";
  return tok;
}

const G_KHP = ["いち", "ろく", "はち", "じゅう", "ひゃく"];
const G_ST = ["いち", "はち", "じゅう"];
// suf: ふつうの読み、gem: 促音になる数、gemSuf: 促音のあとの読み、alt: 数ごとの読み、swap: 数の読み自体が変わるもの
export const COUNTERS = {
  "本": { suf: "ほん", gem: G_KHP, gemSuf: "ぽん", alt: { "さん": "ぼん", "せん": "ぼん", "まん": "ぼん" } },
  "匹": { suf: "ひき", gem: G_KHP, gemSuf: "ぴき", alt: { "さん": "びき", "せん": "びき", "まん": "びき" } },
  "杯": { suf: "はい", gem: G_KHP, gemSuf: "ぱい", alt: { "さん": "ばい", "せん": "ばい", "まん": "ばい" } },
  "分": { suf: "ふん", gem: G_KHP, gemSuf: "ぷん", alt: { "さん": "ぷん", "よん": "ぷん", "せん": "ぷん", "まん": "ぷん" } },
  "回": { suf: "かい", gem: G_KHP, gemSuf: "かい" },
  "個": { suf: "こ", gem: G_KHP, gemSuf: "こ" },
  "階": { suf: "かい", gem: G_KHP, gemSuf: "かい", alt: { "さん": "がい" } },
  "件": { suf: "けん", gem: G_KHP, gemSuf: "けん" },
  "ヶ月": { suf: "かげつ", gem: G_KHP, gemSuf: "かげつ" },
  "か月": { suf: "かげつ", gem: G_KHP, gemSuf: "かげつ" },
  "カ月": { suf: "かげつ", gem: G_KHP, gemSuf: "かげつ" },
  "歳": { suf: "さい", gem: G_ST, gemSuf: "さい" },
  "才": { suf: "さい", gem: G_ST, gemSuf: "さい" },
  "冊": { suf: "さつ", gem: G_ST, gemSuf: "さつ" },
  "点": { suf: "てん", gem: G_ST, gemSuf: "てん" },
  "種類": { suf: "しゅるい", gem: G_ST, gemSuf: "しゅるい" },
  "週間": { suf: "しゅうかん", gem: G_ST, gemSuf: "しゅうかん" },
  "%": { suf: "パーセント", gem: ["はち", "じゅう"], gemSuf: "パーセント" },
  "％": { suf: "パーセント", gem: ["はち", "じゅう"], gemSuf: "パーセント" },
  "人": { suf: "にん", swap: { "よん": "よ" } },
  "円": { suf: "えん", swap: { "よん": "よ" } },
  "年": { suf: "ねん", swap: { "よん": "よ" } },
  "時間": { suf: "じかん", swap: { "よん": "よ", "きゅう": "く" } },
  "時": { suf: "じ", swap: { "よん": "よ", "なな": "しち", "きゅう": "く" } },
  "月": { suf: "がつ", swap: { "よん": "し", "なな": "しち", "きゅう": "く" }, max: 12 },
  "日": { suf: "にち", swap: { "なな": "しち", "きゅう": "く" } },
  "秒": { suf: "びょう" },
  "枚": { suf: "まい" },
  "台": { suf: "だい" },
  "倍": { suf: "ばい" },
  "行": { suf: "ぎょう" },
  "位": { suf: "い" },
  "割": { suf: "わり" },
  "度": { suf: "ど" },
  "つ": { max: 10 },
};
// 長い方から照合する（「時間」を「時」より先に）
const COUNTER_KEYS = Object.keys(COUNTERS).sort((a, b) => b.length - a.length);

const TSU = ["", "ひとつ", "ふたつ", "みっつ", "よっつ", "いつつ", "むっつ", "ななつ", "やっつ", "ここのつ", "とお"];
const DAYS = { 2: "ふつか", 3: "みっか", 4: "よっか", 5: "いつか", 6: "むいか", 7: "なのか", 8: "ようか", 9: "ここのか", 10: "とおか", 20: "はつか" };

// 整数 n と数え方 c から読みの候補（1つ目が既定）を返す
export function countReading(n, c) {
  const spec = COUNTERS[c];
  if (!spec || !Number.isInteger(n)) return null;
  if (spec.max && n > spec.max) return null;
  if (c === "つ") return n >= 1 ? [TSU[n]] : null;
  if (c === "人") {
    if (n === 1) return ["ひとり"];
    if (n === 2) return ["ふたり"];
  }
  if (c === "日") {
    if (n === 1) return ["いちにち", "ついたち"];
    if (DAYS[n]) return n === 20 ? ["はつか", "にじゅうにち"] : [DAYS[n]];
  }
  if ((c === "歳" || c === "才") && n === 20) return ["はたち", "にじゅっさい"];
  const t = integerTokens(n);
  if (!t) return null;
  const last = t[t.length - 1];
  const cls = tokenClass(last);
  // 「14日」「24日」は じゅうよっか・にじゅうよっか
  if (c === "日" && cls === "よん") return [t.slice(0, -1).join("") + "よっか"];
  if (spec.swap && spec.swap[cls]) return [t.slice(0, -1).join("") + spec.swap[cls] + spec.suf];
  if (spec.gem && spec.gem.includes(cls)) return [t.slice(0, -1).join("") + geminate(last) + spec.gemSuf];
  if (spec.alt && spec.alt[cls]) return [t.join("") + spec.alt[cls]];
  return [t.join("") + spec.suf];
}

// 「68万」「1億2000万」「3.5万」「1,200」などの数の表記を読む。値（整数のときだけ）と読みを返す
const BIG_KANJI = { "兆": 1e12, "億": 1e8, "万": 1e4 };
export function readNumberExpr(str) {
  const s = str.replace(/[,，]/g, "").replace(/[０-９．]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  const parts = [...s.matchAll(/(\d+(?:\.\d+)?)(兆|億|万)?/g)];
  if (!parts.length) return null;
  const hasDecimal = parts.some((p) => p[1].includes("."));
  if (!hasDecimal) {
    let v = 0;
    for (const p of parts) v += Number(p[1]) * (p[2] ? BIG_KANJI[p[2]] : 1);
    const kana = integerToKana(v);
    return kana ? { value: v, kana } : null;
  }
  // 小数を含むときは部品ごとに読んでつなぐ（3.5万 → さんてんごまん）
  const unitKana = { "兆": "ちょう", "億": "おく", "万": "まん" };
  const kana = parts.map((p) => (p[1].includes(".") ? decimalToKana(p[1]) : integerToKana(Number(p[1]))) + (p[2] ? unitKana[p[2]] : "")).join("");
  return { value: null, kana };
}

// ---- 英字 ----
export const BUILTIN_DICT = {
  "AI": "エーアイ", "API": "エーピーアイ", "Git": "ギット", "GitHub": "ギットハブ", "Gemini": "ジェミニ",
  "Google": "グーグル", "Claude": "クロード", "YouTube": "ユーチューブ", "iPhone": "アイフォーン", "Android": "アンドロイド",
  "Wi-Fi": "ワイファイ", "OK": "オーケー", "PC": "ピーシー", "URL": "ユーアールエル", "Flash": "フラッシュ",
  "Lite": "ライト", "Studio": "スタジオ", "Pro": "プロ", "SNS": "エスエヌエス", "Instagram": "インスタグラム",
  "LINE": "ライン", "Web": "ウェブ", "App": "アプリ", "iPad": "アイパッド", "Mac": "マック", "Windows": "ウィンドウズ",
};
const LETTER = {
  A: "エー", B: "ビー", C: "シー", D: "ディー", E: "イー", F: "エフ", G: "ジー", H: "エイチ", I: "アイ", J: "ジェー",
  K: "ケー", L: "エル", M: "エム", N: "エヌ", O: "オー", P: "ピー", Q: "キュー", R: "アール", S: "エス", T: "ティー",
  U: "ユー", V: "ブイ", W: "ダブリュー", X: "エックス", Y: "ワイ", Z: "ゼット",
};
export const spellOut = (word) => [...word.toUpperCase()].map((c) => LETTER[c] || "").join("");

// ---- 記号 ----
const SYMBOL = {
  "〜": ["から"], "~": ["から"], "～": ["から"], "&": ["アンド"], "＆": ["アンド"], "+": ["プラス"], "＋": ["プラス"],
  "=": ["イコール"], "＝": ["イコール"], "×": ["かける"], "÷": ["わる"], "→": [], "/": [], "／": [], "#": [], "＃": [],
  "@": ["アット"], "＠": ["アット"], ":": [], "：": [],
};

// ---- 注意を探す ----
// 返す: [{ start, end, text, kind, message, suggestions: [置き換える文字列] }]（start/end は text の位置）
// <laugh> などのタグと、/IPA/ の発音指定は読み上げの指示なので対象外にする。
export function findIssues(text, userDict = {}) {
  const issues = [];
  const skip = [];
  for (const m of text.matchAll(/<[^>]*>/g)) skip.push([m.index, m.index + m[0].length]);
  for (const m of text.matchAll(/\/[^\/\s]{1,40}\//g)) {
    if (/[ˈˌːəɪʊʃʒθðŋɛɔæʌɑɒɜɐɾʔ]/.test(m[0])) skip.push([m.index, m.index + m[0].length]);
  }
  const skipped = (a, b) => skip.some(([s, e]) => a < e && b > s);
  const taken = [];
  const free = (a, b) => !skipped(a, b) && !taken.some(([s, e]) => a < e && b > s);
  const add = (issue) => {
    issues.push(issue);
    taken.push([issue.start, issue.end]);
  };

  // ユーザーの読み辞書を先に（「Claude Code」のように数字や空白を含む語もあるので、長い語から）
  const dict = { ...BUILTIN_DICT, ...userDict };
  for (const word of Object.keys(userDict).sort((a, b) => b.length - a.length)) {
    if (!word) continue;
    let at = text.indexOf(word);
    while (at >= 0) {
      if (free(at, at + word.length)) {
        add({ start: at, end: at + word.length, text: word, kind: "dict", message: "読み辞書に登録した語", suggestions: [userDict[word]] });
      }
      at = text.indexOf(word, at + word.length);
    }
  }

  // 数（数え方つき）
  const numRe = /(?:[0-9０-９][0-9０-９,，]*(?:[.．][0-9０-９]+)?(?:兆|億|万)?)+/g;
  for (const m of text.matchAll(numRe)) {
    let start = m.index;
    let end = start + m[0].length;
    if (!free(start, end)) continue;
    // 英字に続く数字は英字の一部として扱う（「mp3」「GPT-4o」。一方「Gemini 3.8」の 3.8 は数として読む）
    if (start > 0 && /[A-Za-z]/.test(text[start - 1])) continue;
    if (start > 1 && text[start - 1] === "-" && /[A-Za-z]/.test(text[start - 2])) continue;
    const r = readNumberExpr(m[0]);
    if (!r) continue;
    const rest = text.slice(end);
    const c = COUNTER_KEYS.find((k) => rest.startsWith(k));
    let suggestions = [r.kana];
    let label = m[0];
    if (c && r.value !== null) {
      const cr = countReading(r.value, c);
      if (cr) {
        suggestions = cr;
        end += c.length;
        label = m[0] + c;
      }
    } else if (c && r.value === null && COUNTERS[c].suf) {
      // 小数のあとの数え方は音が変わらない（5.5秒 → ごーてんごびょう、2.5% → にーてんごパーセント）
      suggestions = [r.kana + COUNTERS[c].suf];
      end += c.length;
      label = m[0] + c;
    }
    add({ start, end, text: label, kind: "number", message: "数字は読みが揺れます。かなで書くと安定します", suggestions });
  }

  // 英字（辞書・頭字語のつづり読み）
  for (const m of text.matchAll(/[A-Za-z][A-Za-z0-9'’.+-]*[A-Za-z0-9+]|[A-Za-z]/g)) {
    const start = m.index;
    const end = start + m[0].length;
    if (!free(start, end)) continue;
    const w = m[0];
    const suggestions = [];
    if (dict[w]) suggestions.push(dict[w]);
    else if (/^[A-Z]{2,5}$/.test(w)) suggestions.push(spellOut(w));
    add({
      start, end, text: w, kind: "latin",
      message: suggestions.length ? "英字は読みが揺れることがあります" : "英字は読みが揺れることがあります。カタカナで書くか、読み辞書に登録してください",
      suggestions,
    });
  }

  // かっこ（中身も読まれる）
  for (const m of text.matchAll(/[（(][^（()）]*[）)]/g)) {
    const start = m.index;
    const end = start + m[0].length;
    if (skipped(start, end)) continue;
    add({ start, end, text: m[0], kind: "paren", message: "かっこの中も読み上げられます", suggestions: [m[0].slice(1, -1), ""] });
  }

  // 記号
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (!(ch in SYMBOL) || !free(i, i + 1)) continue;
    add({ start: i, end: i + 1, text: ch, kind: "symbol", message: "記号は読まれなかったり、思わぬ読み方になったりします", suggestions: SYMBOL[ch] });
  }

  return issues.sort((a, b) => a.start - b.start);
}

// 注意の1つを置き換えた台本を返す
export function applySuggestion(text, issue, replacement) {
  return text.slice(0, issue.start) + replacement + text.slice(issue.end);
}

// ---- 字幕用に文に分ける ----
// 。！？!? と改行で区切る（句読点は文に残す）。タグと |あいづち| は字幕から外す。
export function splitSentences(text) {
  const clean = stripTags(text).replace(/\|[^|]*\|/g, "");
  const out = [];
  for (const line of clean.split(/\n+/)) {
    const re = /[^。！？!?]+[。！？!?]*|[。！？!?]+/g;
    for (const m of line.matchAll(re)) {
      const s = m[0].trim();
      if (s) out.push(s);
    }
  }
  return out;
}
