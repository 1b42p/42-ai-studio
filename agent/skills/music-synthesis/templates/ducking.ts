/** Участок речи в миллисекундах от начала ролика. */
export interface SpeechSpan {
  readonly startMs: number;
  readonly endMs: number;
}

/** Ослабление музыки на 8 дБ во время речи. */
export const SPEECH_GAIN = 10 ** (-8 / 20);

/** За сколько миллисекунд до фразы музыка уходит вниз. */
export const DUCK_ATTACK_MS = 200;

/** За сколько миллисекунд после фразы музыка возвращается. */
export const DUCK_RELEASE_MS = 400;

/**
 * Множитель громкости музыки на кадре.
 * Вне речи 1, внутри речи {@link SPEECH_GAIN}. Соседние фразы не дают зубца:
 * берётся минимум всех огибающих.
 */
export function duckingGain(speech: readonly SpeechSpan[], fps: number, frame: number): number {
  if (!(fps > 0) || !Number.isFinite(frame)) return 1;
  const timeMs = (frame / fps) * 1000;
  let gain = 1;
  for (const span of speech) {
    if (!Number.isFinite(span.startMs) || !Number.isFinite(span.endMs) || span.endMs <= span.startMs) continue;
    gain = Math.min(gain, spanGain(span.startMs, span.endMs, timeMs));
  }
  return gain;
}

function spanGain(startMs: number, endMs: number, timeMs: number): number {
  const attackStart = startMs - DUCK_ATTACK_MS;
  const releaseEnd = endMs + DUCK_RELEASE_MS;
  if (timeMs <= attackStart || timeMs >= releaseEnd) return 1;
  if (timeMs < startMs) return mix(1, SPEECH_GAIN, (timeMs - attackStart) / DUCK_ATTACK_MS);
  if (timeMs < endMs) return SPEECH_GAIN;
  return mix(SPEECH_GAIN, 1, (timeMs - endMs) / DUCK_RELEASE_MS);
}

function mix(from: number, to: number, progress: number): number {
  return from + (to - from) * progress;
}
