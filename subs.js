/* 字幕（SRT / VTT）の時刻を決める
   1回の生成でできた音声には文ごとの時刻が付いてこないので、文の境目を「無音の区間」に合わせる。
   各文の長さをモーラ数に比例させた位置を目安にし、その近くでいちばん近い無音を境目に選ぶ。
   近くに無音がなければ目安の位置をそのまま使う。だから時刻は目安（画面にもそう書く）。 */

import { findSilences, RATE } from "./audio.js";
import { mora } from "./yomi.js";

// lines: [{ text, speaker? }]（字幕に出す文）。返す: [{ start, end, text }]（秒）
export function buildCues(lines, samples, rate = RATE) {
  const items = lines.filter((l) => l.text.trim());
  if (!items.length) return [];
  const { silences, speechStart, speechEnd } = findSilences(samples, rate);
  const span = Math.max(0.01, speechEnd - speechStart);
  const w = items.map((l) => Math.max(1, mora(l.text)));
  const total = w.reduce((a, b) => a + b, 0);

  // 境目 k（k 文目の後）を、目安の位置にいちばん近い無音に合わせる。前の境目より後ろの無音だけを使う
  const bounds = [];
  let acc = 0;
  let after = speechStart;
  for (let k = 0; k < items.length - 1; k++) {
    acc += w[k];
    const target = speechStart + (span * acc) / total;
    const reach = Math.max(1.0, (0.4 * span * w[k]) / total);
    let best = null;
    for (const s of silences) {
      const mid = (s.start + s.end) / 2;
      if (mid <= after + 0.05) continue;
      const d = Math.abs(mid - target);
      if (d <= reach && (!best || d < best.d)) best = { d, start: s.start, end: s.end };
    }
    const b = best ? { start: best.start, end: best.end } : { start: target, end: target };
    bounds.push(b);
    after = (b.start + b.end) / 2;
  }

  return items.map((l, k) => ({
    start: k === 0 ? speechStart : bounds[k - 1].end,
    end: k === items.length - 1 ? speechEnd : bounds[k].start,
    text: l.speaker ? `${l.speaker}：${l.text}` : l.text,
  }));
}

function stamp(sec, sep) {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const pad = (n, k = 2) => String(n).padStart(k, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(ms % 1000, 3)}`;
}

export function toSrt(cues) {
  return cues.map((c, i) => `${i + 1}\n${stamp(c.start, ",")} --> ${stamp(c.end, ",")}\n${c.text}\n`).join("\n");
}

export function toVtt(cues) {
  return "WEBVTT\n\n" + cues.map((c) => `${stamp(c.start, ".")} --> ${stamp(c.end, ".")}\n${c.text}\n`).join("\n");
}
