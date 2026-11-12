import { describe, expect, test } from "vitest";
import {
  DUCK_ATTACK_MS,
  DUCK_RELEASE_MS,
  SPEECH_GAIN,
  duckingGain,
  type SpeechSpan,
} from "../../../agent/skills/music-synthesis/templates/ducking";

const FPS = 1000;

function samples(speech: readonly SpeechSpan[], from: number, to: number): number[] {
  const values: number[] = [];
  for (let frame = from; frame <= to; frame += 1) values.push(duckingGain(speech, FPS, frame));
  return values;
}

function isNonIncreasing(values: readonly number[]): boolean {
  for (let index = 1; index < values.length; index += 1) {
    if (values[index] > values[index - 1] + 1e-12) return false;
  }
  return true;
}

function isNonDecreasing(values: readonly number[]): boolean {
  for (let index = 1; index < values.length; index += 1) {
    if (values[index] < values[index - 1] - 1e-12) return false;
  }
  return true;
}

describe("приглушение музыки", () => {
  test("вне речи множитель равен 1, внутри речи — ослабление на 8 дБ", () => {
    const speech = [{ startMs: 1_000, endMs: 2_000 }];
    expect(SPEECH_GAIN).toBeCloseTo(10 ** (-8 / 20), 12);
    expect(duckingGain([], 30, 10)).toBe(1);
    expect(duckingGain(speech, FPS, 0)).toBe(1);
    expect(duckingGain(speech, 30, 45)).toBeCloseTo(SPEECH_GAIN, 12);
    expect(duckingGain(speech, FPS, 1_500)).toBeCloseTo(SPEECH_GAIN, 12);
    expect(duckingGain(speech, FPS, 3_000)).toBe(1);
  });

  test("спад занимает 200 мс до фразы и монотонен, возврат — 400 мс после", () => {
    const speech = [{ startMs: 1_000, endMs: 2_000 }];
    expect(duckingGain(speech, FPS, 1_000 - DUCK_ATTACK_MS - 1)).toBe(1);
    expect(duckingGain(speech, FPS, 1_000 - DUCK_ATTACK_MS)).toBe(1);
    expect(duckingGain(speech, FPS, 1_000)).toBeCloseTo(SPEECH_GAIN, 12);
    const attack = samples(speech, 1_000 - DUCK_ATTACK_MS, 1_000);
    expect(attack).toHaveLength(DUCK_ATTACK_MS + 1);
    expect(isNonIncreasing(attack)).toBe(true);

    expect(duckingGain(speech, FPS, 2_000)).toBeCloseTo(SPEECH_GAIN, 12);
    expect(duckingGain(speech, FPS, 2_000 + DUCK_RELEASE_MS)).toBe(1);
    expect(duckingGain(speech, FPS, 2_000 + DUCK_RELEASE_MS + 1)).toBe(1);
    const release = samples(speech, 2_000, 2_000 + DUCK_RELEASE_MS);
    expect(release).toHaveLength(DUCK_RELEASE_MS + 1);
    expect(isNonDecreasing(release)).toBe(true);
  });

  test("соседние фразы не поднимают множитель выше порога, дальняя пауза возвращает 1", () => {
    const touching = samples(
      [
        { startMs: 0, endMs: 1_000 },
        { startMs: 1_000, endMs: 2_000 },
      ],
      0,
      2_000,
    );
    expect(Math.max(...touching)).toBeCloseTo(SPEECH_GAIN, 12);

    const close = samples(
      [
        { startMs: 0, endMs: 1_000 },
        { startMs: 1_100, endMs: 2_000 },
      ],
      1_000,
      1_100,
    );
    expect(Math.max(...close)).toBeLessThan(0.55);
    expect(Math.min(...close)).toBeCloseTo(SPEECH_GAIN, 12);

    const gap = [
      { startMs: 0, endMs: 500 },
      { startMs: 2_500, endMs: 3_000 },
    ];
    expect(duckingGain(gap, FPS, 1_500)).toBe(1);
  });
});
