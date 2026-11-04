import { attachPunctuation } from "./punctuation";
import { ticksToMs } from "./time";

export interface SpeechBoundary {
  readonly text: string;
  readonly offset: number;
  readonly duration: number;
}

export interface TimingSpan {
  readonly text: string;
  readonly startMs: number;
  readonly endMs: number;
}

export interface TimingsFile {
  readonly version: 1;
  readonly voice: string;
  readonly language: string;
  readonly format: "mp3";
  readonly durationMs: number;
  readonly text: string;
  readonly words: TimingSpan[];
  readonly sentences: TimingSpan[];
}

function span(text: string, offset: number, duration: number): TimingSpan {
  return {
    text,
    startMs: ticksToMs(offset),
    endMs: ticksToMs(offset + duration),
  };
}

/**
 * Файл таймингов версии 1.
 * Конец предложения включает паузу до начала следующего; у последнего остаётся свой конец.
 */
export function buildTimings(input: {
  readonly source: string;
  readonly voice: string;
  readonly language: string;
  readonly durationMs: number;
  readonly words: readonly SpeechBoundary[];
  readonly sentences: readonly SpeechBoundary[];
}): TimingsFile {
  const wordTexts = attachPunctuation(
    input.source,
    input.words.map((word) => word.text),
  );
  const sentenceTexts = attachPunctuation(
    input.source,
    input.sentences.map((sentence) => sentence.text),
  );
  const sentences = input.sentences.map((sentence, index) =>
    span(sentenceTexts[index] ?? sentence.text, sentence.offset, sentence.duration),
  );
  for (let index = 0; index < sentences.length - 1; index++) {
    const next = sentences[index + 1];
    const current = sentences[index];
    if (next === undefined || current === undefined) continue;
    sentences[index] = { ...current, endMs: next.startMs };
  }
  return {
    version: 1,
    voice: input.voice,
    language: input.language,
    format: "mp3",
    durationMs: input.durationMs,
    text: input.source,
    words: input.words.map((word, index) =>
      span(wordTexts[index] ?? word.text, word.offset, word.duration),
    ),
    sentences,
  };
}

/**
 * Обрыв: есть предложения, но последнее кончается раньше, чем длительность минус 500 мс.
 * Границ предложений нет — проверку пропускаем (её заменяет проверка букв).
 */
export function speechIsComplete(
  sentences: readonly { readonly endMs: number }[],
  durationMs: number,
): boolean {
  const last = sentences[sentences.length - 1];
  if (last === undefined) return true;
  return last.endMs >= durationMs - 500;
}
