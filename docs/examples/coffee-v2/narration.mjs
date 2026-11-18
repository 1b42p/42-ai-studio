import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { EdgeTTS } from "@andresaya/edge-tts";

const directory = path.resolve(process.argv[2]);
const text = "Хорошее утро начинается с кофе. А второй кофе — в подарок. По будням до одиннадцати, в кофейне на углу. Возьмите кофе для того, с кем хочется разделить утро.";
const voice = "ru-RU-DmitryNeural";
const result = await new EdgeTTS({ timeout: 30_000 }).generate(text, voice, {
  rate: -5,
  pitch: "-2Hz",
  outputFormat: "audio-24khz-96kbitrate-mono-mp3",
});

await mkdir(directory, { recursive: true });
await writeFile(path.join(directory, "narration.mp3"), result.audio);
await writeFile(path.join(directory, "narration.json"), JSON.stringify({
  text,
  voice,
  captions: result.wordBoundaries.map((word, index) => ({
    text: `${index ? " " : ""}${word.text}`,
    startMs: word.offset / 10_000,
    endMs: (word.offset + word.duration) / 10_000,
    timestampMs: word.offset / 10_000,
    confidence: null,
  })),
  sentences: result.sentenceBoundaries.map((sentence) => ({
    text: sentence.text,
    startMs: sentence.offset / 10_000,
    endMs: (sentence.offset + sentence.duration) / 10_000,
  })),
}, null, 2));
console.log(JSON.stringify({ voice, seconds: result.audio.byteLength / 12_000, words: result.wordBoundaries.length }));
