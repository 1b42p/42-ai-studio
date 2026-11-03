/** Тики Edge TTS: 10 000 000 на секунду, то есть 10 000 на миллисекунду. */
export function ticksToMs(ticks: number): number {
  return Math.round(ticks / 10_000);
}

/**
 * Длительность mp3 с постоянным битрейтом 96 кбит/с.
 * `байт * 8 / 96_000` секунд — это `байт / 12` миллисекунд.
 */
export function mp3DurationMs(sizeBytes: number): number {
  return Math.round(sizeBytes / 12);
}
