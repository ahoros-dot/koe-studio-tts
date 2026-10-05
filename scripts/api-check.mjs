#!/usr/bin/env node
/**
 * gemini.js を本物の API で確かめる（ブラウザと同じモジュールを Node から使う）。キーは環境変数 GEMINI_API_KEY。
 * （こえスタジオのディレクトリで実行する）
 *   node scripts/api-check.mjs <出力先ディレクトリ> [--only solo,duo,lite,lite-duo,voices,design]
 * 作るもの: 1人・パート3つ（口調を変える）／2人の掛け合い／Flash-Lite の1人と2人／声の一覧／声のデザイン（作って読ませて消す）。
 * 生成した WAV は出力先に書く（faster-whisper で読みを確かめる用）。費用は合わせて数円。
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createClient, buildTtsBody, voiceId, MODELS } from "../gemini.js";
import { pcmToWav, seconds, activeDb } from "../audio.js";

const out = resolve(process.argv[2] || ".");
mkdirSync(out, { recursive: true });
const oi = process.argv.indexOf("--only");
const only = oi >= 0 ? process.argv[oi + 1].split(",") : null;
const want = (k) => !only || only.includes(k);

const client = createClient({
  getKey: () => process.env.GEMINI_API_KEY,
  onStatus: (s) => {
    if (s.type === "retry") console.log(`  … ${s.message}（${s.wait.toFixed(1)}秒待って再試行）`);
  },
});
const save = (name, a) => {
  writeFileSync(join(out, `${name}.wav`), pcmToWav(a.samples, a.rate));
  console.log(`✓ ${name}.wav  ${seconds(a.samples, a.rate).toFixed(2)}s  ${activeDb(a.samples).toFixed(1)}dB`);
};
const FLASH = MODELS[0].id;
const LITE = MODELS[1].id;

const soloParts = [
  { text: "みなさん、静かに。<breath> いま、すぐそこに鹿がいます。", style: "hushed, reverent wildlife documentary whisper" },
  { text: "<gasp> こっちに来ました！ 車に戻って！", style: "loud, panicked shout" },
  { text: "<pant> ふう……。自然って、すごいですね。", style: "out of breath, slightly in shock" },
];
const duo = {
  mode: "duo",
  speakers: [{ speaker: "ハル", voice: "Leda" }, { speaker: "ソラ", voice: "Puck" }],
  parts: [
    { speaker: "ハル", text: "ねえ、新しい声のAI、もう試した？ |まだ| すごく自然なんだよ。", style: "excited, sharing news with a friend" },
    { speaker: "ソラ", text: "へえ、どれくらい自然なの？", style: "curious, leaning in" },
    { speaker: "ハル", text: "<laugh> この会話も、実はAIなんだって。|えっ| ほんとだよ。", style: "playful, building up to the reveal" },
  ],
};

try {
  if (want("solo")) save("solo-3parts", await client.tts(buildTtsBody({ model: FLASH, mode: "solo", voice: "Zephyr", parts: soloParts })));
  if (want("duo")) save("duo", await client.tts(buildTtsBody({ model: FLASH, ...duo })));
  if (want("lite")) save("lite-solo", await client.tts(buildTtsBody({ model: LITE, mode: "solo", voice: "Zephyr", parts: [{ text: "こんにちは。今日はどんなお話を読みましょうか。" }] })));
  if (want("lite-duo")) {
    try {
      save("lite-duo", await client.tts(buildTtsBody({ model: LITE, ...duo })));
    } catch (e) {
      console.log(`✗ lite-duo: ${e.message}（${e.detail}）`);
    }
  }
  if (want("voices")) {
    const all = await client.listVoices({ pageSize: 5 });
    console.log(`✓ voices.list: ${all.voices.length}件（次ページ ${all.nextPageToken ? "あり" : "なし"}）`);
    if (all.voices[0]) console.log(`  例: ${JSON.stringify(all.voices[0]).slice(0, 400)}`);
    const ja = await client.listVoices({ languageCode: "ja-JP", pageSize: 5 });
    console.log(`✓ voices.list(ja-JP): ${ja.voices.length}件  ${ja.voices.map((v) => v.display_name || v.name || v.id).join(" / ")}`);
    const mine = await client.listVoices({ type: "prompted" });
    console.log(`✓ voices.list(prompted): ${mine.voices.length}件`);
  }
  if (want("design")) {
    const { voice, sample } = await client.createVoice({
      displayName: "テスト 落ち着いた案内役",
      description: "40代の落ち着いた女性アナウンサー。低めでやわらかい声、はっきりした発音、ゆったりした話し方。標準語。",
      gender: "female",
      languageCode: "ja-JP",
    });
    console.log(`✓ voices.create: ${JSON.stringify({ ...voice, sample_audio: voice.sample_audio ? "(省略)" : undefined }).slice(0, 400)}`);
    if (sample) save("design-sample", sample);
    const id = voiceId(voice.id || voice.name);
    save("design-tts", await client.tts(buildTtsBody({ model: FLASH, mode: "solo", voice: id, parts: [{ text: "本日はご来場いただき、まことにありがとうございます。まもなく開演いたします。" }] })));
    await client.deleteVoice(id);
    console.log(`✓ voices.delete: ${id}`);
  }
} catch (e) {
  console.error(`✗ ${e.message}${e.detail ? `\n  ${e.detail}` : ""}`);
  process.exit(1);
}
