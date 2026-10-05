#!/usr/bin/env node
/**
 * yomi.js / audio.js / subs.js のテスト（API もブラウザも使わない）
 * （こえスタジオのディレクトリで実行する）
 *   node scripts/selftest.mjs
 */
import assert from "node:assert/strict";
import * as yomi from "../yomi.js";
import * as audio from "../audio.js";
import { buildCues, toSrt, toVtt } from "../subs.js";
import * as gemini from "../gemini.js";

let pass = 0;
let fail = 0;
function t(name, fn) {
  try {
    fn();
    pass++;
  } catch (e) {
    fail++;
    console.log(`✗ ${name}\n    ${e.message.split("\n").join("\n    ")}`);
  }
}

// ---- 数字のかな ----
const num = {
  0: "ぜろ", 7: "なな", 10: "じゅう", 11: "じゅういち", 100: "ひゃく", 300: "さんびゃく", 600: "ろっぴゃく", 800: "はっぴゃく",
  1000: "せん", 3000: "さんぜん", 8000: "はっせん", 2026: "にせんにじゅうろく", 10000: "いちまん",
  680000: "ろくじゅうはちまん", 10000000: "いっせんまん", 120000000: "いちおくにせんまん", 1e12: "いっちょう", 8e12: "はっちょう",
};
for (const [n, want] of Object.entries(num)) t(`integerToKana(${n})`, () => assert.equal(yomi.integerToKana(Number(n)), want));

const dec = { "5.5": "ごーてんご", "1.25": "いってんにーご", "3.8": "さんてんはち", "0.5": "れいてんご", "10.2": "じゅってんに" };
for (const [s, want] of Object.entries(dec)) t(`decimalToKana(${s})`, () => assert.equal(yomi.decimalToKana(s), want));

const cnt = [
  [3, "本", "さんぼん"], [1, "本", "いっぽん"], [6, "本", "ろっぽん"], [18, "本", "じゅうはっぽん"], [16, "本", "じゅうろっぽん"],
  [100, "本", "ひゃっぽん"], [300, "本", "さんびゃっぽん"], [1000, "本", "せんぼん"], [4, "本", "よんほん"],
  [600, "円", "ろっぴゃくえん"], [4, "円", "よえん"], [10000, "円", "いちまんえん"],
  [3, "分", "さんぷん"], [4, "分", "よんぷん"], [5, "分", "ごふん"], [10, "分", "じゅっぷん"],
  [3, "匹", "さんびき"], [8, "杯", "はっぱい"], [6, "回", "ろっかい"], [3, "階", "さんがい"], [8, "歳", "はっさい"],
  [1, "人", "ひとり"], [2, "人", "ふたり"], [4, "人", "よにん"], [14, "人", "じゅうよにん"], [30, "人", "さんじゅうにん"],
  [4, "時", "よじ"], [7, "時", "しちじ"], [9, "時", "くじ"], [4, "月", "しがつ"], [9, "月", "くがつ"],
  [3, "日", "みっか"], [14, "日", "じゅうよっか"], [17, "日", "じゅうしちにち"], [3, "つ", "みっつ"],
  [10, "%", "じゅっパーセント"], [2026, "年", "にせんにじゅうろくねん"], [3, "ヶ月", "さんかげつ"], [6, "ヶ月", "ろっかげつ"],
];
for (const [n, c, want] of cnt) t(`countReading(${n}${c})`, () => assert.equal(yomi.countReading(n, c)[0], want));
t("countReading(1日) は2候補", () => assert.deepEqual(yomi.countReading(1, "日"), ["いちにち", "ついたち"]));
t("countReading(13月) は対象外", () => assert.equal(yomi.countReading(13, "月"), null));

t("readNumberExpr(68万)", () => assert.equal(yomi.readNumberExpr("68万").kana, "ろくじゅうはちまん"));
t("readNumberExpr(1億2000万)", () => assert.equal(yomi.readNumberExpr("1億2000万").value, 120000000));
t("readNumberExpr(1,200)", () => assert.equal(yomi.readNumberExpr("1,200").kana, "せんにひゃく"));
t("readNumberExpr(3.5万)", () => assert.equal(yomi.readNumberExpr("3.5万").kana, "さんてんごまん"));
t("readNumberExpr(全角１２)", () => assert.equal(yomi.readNumberExpr("１２").kana, "じゅうに"));

// ---- 注意を探す ----
const pick = (text, dict) => yomi.findIssues(text, dict).map((i) => [i.text, i.kind, i.suggestions[0] ?? null]);
t("findIssues: 18本中16本", () =>
  assert.deepEqual(pick("18本中16本が合格。"), [["18本", "number", "じゅうはっぽん"], ["16本", "number", "じゅうろっぽん"]]));
t("findIssues: 68万行", () => assert.deepEqual(pick("68万行のコード"), [["68万行", "number", "ろくじゅうはちまんぎょう"]]));
t("findIssues: Gemini 3.8 Flash TTS", () =>
  assert.deepEqual(pick("Gemini 3.8 Flash TTS"), [
    ["Gemini", "latin", "ジェミニ"], ["3.8", "number", "さんてんはち"], ["Flash", "latin", "フラッシュ"], ["TTS", "latin", "ティーティーエス"],
  ]));
t("findIssues: タグは対象外", () => assert.deepEqual(pick("えっ <laugh> 本当？"), []));
t("findIssues: IPA は対象外", () => assert.deepEqual(pick("こちらは /niːv/ です"), []));
t("findIssues: かっこ", () => assert.deepEqual(pick("今日（日曜）は"), [["（日曜）", "paren", "日曜"]]));
t("findIssues: 記号", () => assert.deepEqual(pick("10時〜12時"), [["10時", "number", "じゅうじ"], ["〜", "symbol", "から"], ["12時", "number", "じゅうにじ"]]));
t("findIssues: 読み辞書", () => assert.deepEqual(pick("Claude Code を使う", { "Claude Code": "クロードコード" }), [["Claude Code", "dict", "クロードコード"]]));
t("findIssues: mp3 の 3 は英字の一部", () => assert.deepEqual(pick("mp3").map((x) => x[0]), ["mp3"]));
t("findIssues: 知らない英字は候補なし", () => assert.deepEqual(pick("Puck"), [["Puck", "latin", null]]));
t("applySuggestion", () => {
  const text = "残り5.5秒";
  const is = yomi.findIssues(text)[0];
  assert.equal(yomi.applySuggestion(text, is, is.suggestions[0]), "残りごーてんごびょう");
});

t("mora: かなと漢字", () => assert.equal(yomi.mora("きょうは晴れ"), 6));
t("mora: タグは数えない", () => assert.equal(yomi.mora("あ<laugh>い"), 2));
t("splitSentences", () =>
  assert.deepEqual(yomi.splitSentences("こんにちは。元気？ <laugh> うん|へえ|！\n次の行"), ["こんにちは。", "元気？", "うん！", "次の行"]));

// ---- 音声 ----
const R = audio.RATE;
const tone = (sec, amp = 0.3, hz = 220) => {
  const n = Math.round(R * sec);
  const s = new Int16Array(n);
  for (let i = 0; i < n; i++) s[i] = Math.round(Math.sin((2 * Math.PI * hz * i) / R) * amp * 32767);
  return s;
};
const silence = (sec) => new Int16Array(Math.round(R * sec));

t("WAV の作成と読み戻し", () => {
  const s = tone(0.5);
  const back = audio.parseWav(audio.pcmToWav(s));
  assert.equal(back.rate, R);
  assert.equal(back.samples.length, s.length);
  assert.equal(back.samples[1234], s[1234]);
});
t("生の PCM も読める", () => {
  const s = tone(0.1);
  const bytes = new Uint8Array(s.buffer.slice(0));
  assert.equal(audio.decodeAudioBytes(bytes).samples.length, s.length);
});
t("base64", () => assert.deepEqual([...audio.base64ToBytes("AQID")], [1, 2, 3]));
t("無音の切り取り", () => {
  const s = audio.concatSamples([silence(0.4), tone(1.0), silence(0.5)], R, 0);
  const out = audio.trimSilence(s);
  // 1.0s ＋ 前40ms ＋ 後150ms
  assert.ok(Math.abs(audio.seconds(out) - 1.19) < 0.01, `長さ ${audio.seconds(out)}`);
});
t("音量そろえ（±0.5dB）", () => {
  for (const amp of [0.05, 0.3, 0.6]) {
    const r = audio.levelSamples(tone(1.0, amp), R, -16);
    const got = audio.activeDb(r.samples);
    assert.ok(Math.abs(got + 16) < 0.5, `amp ${amp}: ${got.toFixed(2)}dB`);
  }
});
t("音量そろえでピークが -1dBFS を超えない", () => {
  const r = audio.levelSamples(tone(1.0, 0.1), R, -3);
  let mx = 0;
  for (const v of r.samples) mx = Math.max(mx, Math.abs(v));
  assert.ok(mx / 32767 <= 10 ** (-1 / 20) + 1e-3, `peak ${(20 * Math.log10(mx / 32767)).toFixed(2)}dB`);
});
t("無音の区間", () => {
  const s = audio.concatSamples([silence(0.2), tone(1.0), silence(0.4), tone(0.5), silence(0.3)], R, 0);
  const { silences, speechStart, speechEnd } = audio.findSilences(s);
  assert.equal(silences.length, 1);
  assert.ok(Math.abs(silences[0].start - 1.2) < 0.02 && Math.abs(silences[0].end - 1.6) < 0.02, JSON.stringify(silences));
  assert.ok(Math.abs(speechStart - 0.2) < 0.02 && Math.abs(speechEnd - 2.1) < 0.02);
});

// ---- 字幕 ----
t("字幕の境目が無音に合う", () => {
  // 3文。目安（モーラ比）からずれた位置に無音を置いても、近くの無音に合わせられるか
  const s = audio.concatSamples([tone(1.4), silence(0.35), tone(0.9), silence(0.3), tone(1.6)], R, 0);
  const cues = buildCues([{ text: "あいうえおかきくけこ。" }, { text: "さしすせそたち。" }, { text: "つてとなにぬねのはひふへ。" }], s);
  assert.equal(cues.length, 3);
  assert.ok(Math.abs(cues[0].end - 1.4) < 0.03, `1文目の終わり ${cues[0].end}`);
  assert.ok(Math.abs(cues[1].start - 1.75) < 0.03, `2文目の始まり ${cues[1].start}`);
  assert.ok(Math.abs(cues[1].end - 2.65) < 0.03, `2文目の終わり ${cues[1].end}`);
  assert.ok(Math.abs(cues[2].start - 2.95) < 0.03, `3文目の始まり ${cues[2].start}`);
});
t("SRT / VTT の書式", () => {
  const cues = [{ start: 0.04, end: 1.5, text: "こんにちは。" }, { start: 61.25, end: 3725.007, text: "ハル：またね。" }];
  assert.equal(toSrt(cues), "1\n00:00:00,040 --> 00:00:01,500\nこんにちは。\n\n2\n00:01:01,250 --> 01:02:05,007\nハル：またね。\n");
  assert.ok(toVtt(cues).startsWith("WEBVTT\n\n00:00:00.040 --> 00:00:01.500\n"));
});

// ---- API まわり（通信はしない） ----
t("parseRetry", () => {
  assert.equal(gemini.parseRetry("Please retry in 14h24m47s or upgrade"), 14 * 3600 + 24 * 60 + 47);
  assert.equal(gemini.parseRetry("Please retry in 25.5s."), 25.5);
  assert.equal(gemini.parseRetry("retry in 1m30s"), 90);
  assert.equal(gemini.parseRetry("no hint"), null);
});
t("parseError: 1日の上限（配列で包まれた本文）", () => {
  const raw = JSON.stringify([{ error: { code: 429, message: "Rate limit exceeded for model gemini-3.8-flash-tts (limit: 100 requests per day on Tier 1). Please retry in 14h24m47s or upgrade your tier." } }]);
  // 本文の「retry in 14h24m47s」は当てにならないので使わず、太平洋時間の0時までを数える
  const e = gemini.parseError(429, raw, new Date("2026-10-05T04:05:00Z")); // 日本時間 13:05 ＝ 太平洋夏時間 21:05
  assert.equal(e.daily, true);
  assert.equal(e.retryAfter, 2 * 3600 + 55 * 60);
  assert.match(e.message, /1日の回数の上限.*100 requests per day on Tier 1.*ごろ（太平洋時間の0時）に数え直されます/);
});
t("secondsUntilPacificMidnight（夏時間・冬時間）", () => {
  assert.equal(gemini.secondsUntilPacificMidnight(new Date("2026-10-05T08:11:00Z")), 24 * 3600 - 71 * 60); // 太平洋夏時間 01:11
  assert.equal(gemini.secondsUntilPacificMidnight(new Date("2026-12-01T00:00:00Z")), 8 * 3600); // 太平洋標準時 16:00
});
t("parseError: 1分の上限", () => {
  const e = gemini.parseError(429, JSON.stringify({ error: { message: "Quota exceeded. Please retry in 25s." } }));
  assert.equal(e.daily, false);
  assert.equal(e.retryAfter, 25);
});
t("parseError: キーが違う", () => {
  const e = gemini.parseError(400, '[{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT"}}]');
  assert.match(e.message, /API キーが正しくありません/);
});
t("buildTtsBody: 1人（指示なしは annotations 空）", () => {
  const b = gemini.buildTtsBody({ model: "m", mode: "solo", voice: "Zephyr", parts: [{ text: "あ", style: "" }, { text: "  " }, { text: "い", style: "calm" }] });
  assert.deepEqual(b.generation_config.speech_config, [{ voice: "Zephyr" }]);
  assert.equal(b.input[0].content.length, 2);
  assert.deepEqual(b.input[0].content[0].annotations, []);
  assert.deepEqual(b.input[0].content[1].annotations, [{ type: "speech_metadata", style: "calm" }]);
});
t("buildTtsBody: 2人", () => {
  const b = gemini.buildTtsBody({ model: "m", mode: "duo", speakers: [{ speaker: "A", voice: "Leda", extra: 1 }, { speaker: "B", voice: "Puck" }], parts: [{ speaker: "B", text: "う" }] });
  assert.deepEqual(b.generation_config.speech_config, { mode: "conversational", speakers: [{ speaker: "A", voice: "Leda" }, { speaker: "B", voice: "Puck" }] });
  assert.deepEqual(b.input[0].content[0].annotations, [{ type: "speech_metadata", speaker: "B" }]);
});
t("codeSnippets: キーは環境変数の置き換え文字だけ", () => {
  const c = gemini.codeSnippets(gemini.buildTtsBody({ model: "m", mode: "solo", voice: "Zephyr", parts: [{ text: "あ" }] }));
  assert.match(c.curl, /\$GEMINI_API_KEY/);
  assert.match(c.js, /process\.env\.GEMINI_API_KEY/);
  assert.doesNotMatch(c.curl + c.js, /AIza/);
});
t("voiceId", () => {
  assert.equal(gemini.voiceId("voices/voice_abc"), "voice_abc");
  assert.equal(gemini.voiceId("voice_abc"), "voice_abc");
});

console.log(`${fail ? "✗" : "✓"} ${pass} 件通過${fail ? `、${fail} 件失敗` : ""}`);
process.exit(fail ? 1 : 0);
