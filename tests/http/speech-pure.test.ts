/** Чистые функции озвучки: тики, знаки, длительность, сессия копии, повтор и пауза. */
import { EdgeTTSError } from "@andresaya/edge-tts";
import { describe, expect, test } from "vitest";

import { textCoverage } from "../../lib/speech/coverage";
import { SpeechIncompleteError, isRetryableSpeechError, mapSpeechFailure } from "../../lib/speech/errors";
import { withSpeechPace } from "../../lib/speech/pace";
import { resolveSpeechOutputPath } from "../../lib/speech/path";
import { attachPunctuation } from "../../lib/speech/punctuation";
import { retrySpeech, sleepAbortable } from "../../lib/speech/retry";
import { speechEveSessionId } from "../../lib/speech/session";
import { mp3DurationMs, ticksToMs } from "../../lib/speech/time";
import { buildTimings } from "../../lib/speech/timings";
import { resolveVoiceChoice, selectVoices, type CatalogVoice } from "../../lib/speech/voices";
import { formatClock, languageLabel, voiceDisplayName } from "../../lib/speech/format";

const catalog: CatalogVoice[] = [
  { name: "de-DE-KatjaNeural", locale: "de-DE", gender: "Female" },
  { name: "de-AT-IngridNeural", locale: "de-AT", gender: "Female" },
  { name: "de-DE-ConradNeural", locale: "de-DE", gender: "Male" },
];

describe("тайминги и путь", () => {
  test("тики и длительность mp3", () => {
    expect(ticksToMs(500_000)).toBe(50);
    expect(ticksToMs(10_000_000)).toBe(1000);
    expect(mp3DurationMs(12_000)).toBe(1000);
    expect(mp3DurationMs(90_000)).toBe(7500);
  });

  test("знаки препинания возвращаются к единицам речи", () => {
    expect(attachPunctuation("Привет, мир", ["Привет", "мир"])).toEqual(["Привет,", "мир"]);
    expect(attachPunctuation("(мир)", ["мир"])).toEqual(["(мир)"]);
    expect(attachPunctuation("«привет»", ["привет"])).toEqual(["«привет»"]);
    expect(attachPunctuation("¿Hola?", ["Hola"])).toEqual(["¿Hola?"]);
    expect(attachPunctuation('"привет"', ["привет"])).toEqual(['"привет"']);
    expect(attachPunctuation("слово — следующее", ["слово", "следующее"])).toEqual([
      "слово —",
      "следующее",
    ]);
    expect(
      attachPunctuation("Сегодня 24 октября 2026 года.", ["Сегодня", "24 октября 2026 года"]),
    ).toEqual(["Сегодня", "24 октября 2026 года."]);
    expect(attachPunctuation("Привет,\nмир", ["Привет", "мир"])).toEqual(["Привет,", "мир"]);
    expect(attachPunctuation("Привет", ["нет в тексте"])).toEqual(["нет в тексте"]);
    expect(attachPunctuation("Привет, мир. Как дела?", ["Привет", "мир", "Как", "дела"])).toEqual([
      "Привет,",
      "мир.",
      "Как",
      "дела?",
    ]);
  });

  test("конец предложения включает паузу до следующего", () => {
    const timings = buildTimings({
      source: "Раз. Два.",
      voice: "ru-RU-SvetlanaNeural",
      language: "ru-RU",
      durationMs: 1000,
      words: [],
      sentences: [
        { text: "Раз.", offset: 0, duration: 4_000_000 },
        { text: "Два.", offset: 5_000_000, duration: 4_000_000 },
      ],
    });
    expect(timings.sentences[0]).toMatchObject({ text: "Раз.", startMs: 0, endMs: 500 });
    expect(timings.sentences[1]).toMatchObject({ text: "Два.", startMs: 500, endMs: 900 });
    expect(timings.version).toBe(1);
    expect(timings.format).toBe("mp3");
  });

  test("копия агента ищет сессию по корневому идентификатору", () => {
    expect(speechEveSessionId({ id: "child", parent: { rootSessionId: "root" } })).toBe("root");
    expect(speechEveSessionId({ id: "root" })).toBe("root");
  });

  test("путь без расширения остаётся внутри рабочей области", () => {
    expect(resolveSpeechOutputPath("voice/hello", "call-abcdef12")).toEqual({
      ok: true,
      basePath: "/workspace/voice/hello",
    });
    expect(resolveSpeechOutputPath(undefined, "abcdef123456")).toEqual({
      ok: true,
      basePath: "/workspace/voiceover/speech-abcdef12",
    });
    expect(resolveSpeechOutputPath("voice/hello.mp3", "id").ok).toBe(false);
    expect(resolveSpeechOutputPath("v1.0/scene", "id")).toEqual({
      ok: true,
      basePath: "/workspace/v1.0/scene",
    });
    expect(resolveSpeechOutputPath("../../etc/x", "id").ok).toBe(false);
    expect(resolveSpeechOutputPath("/etc/passwd", "id").ok).toBe(false);
    expect(resolveSpeechOutputPath("", "id").ok).toBe(false);
    expect(resolveSpeechOutputPath("voice/", "id").ok).toBe(false);
  });
});

function chosen(input: { voice?: string; language: string }, voices: readonly CatalogVoice[] = []) {
  const result = resolveVoiceChoice(input, voices);
  if (!result.ok) throw new Error(`голос не выбран: ${input.language}`);
  return result.choice;
}

describe("голоса и повтор", () => {
  test("голый язык и явный голос", () => {
    expect(chosen({ language: "ru" })).toMatchObject({
      voice: "ru-RU-SvetlanaNeural",
      language: "ru-RU",
    });
    expect(chosen({ language: "en-us" })).toMatchObject({
      voice: "en-US-AvaNeural",
      language: "en-US",
    });
    expect(chosen({ language: "de" }, catalog)).toMatchObject({
      voice: "de-AT-IngridNeural",
      language: "de-AT",
    });
    expect(resolveVoiceChoice({ language: "xx" }, catalog).ok).toBe(false);
    expect(chosen({ voice: "xx-XX-NobodyNeural", language: "ru-RU" })).toMatchObject({
      voice: "xx-XX-NobodyNeural",
      language: "xx-XX",
    });
  });

  test("список: пол и пустой язык", () => {
    const listed = selectVoices(
      [
        { name: "ru-RU-SvetlanaNeural", locale: "ru-RU", gender: "Female" },
        { name: "ru-RU-DmitryNeural", locale: "ru-RU", gender: "Male" },
      ],
      "ru",
      "Male",
    );
    expect(listed.voices).toEqual([
      {
        name: "ru-RU-DmitryNeural",
        locale: "ru-RU",
        gender: "Male",
        displayName: "Dmitry",
        multilingual: false,
      },
    ]);
    expect(voiceDisplayName("en-US-AvaMultilingualNeural")).toBe("Ava");
    expect(languageLabel("ru-RU")).toBe("русский");
    expect(formatClock(7000)).toBe("0:07");
    const empty = selectVoices(catalog, "xx");
    expect(empty.voices).toEqual([]);
    expect(empty.availableLocales).toEqual(["de-AT", "de-DE"]);
  });

  test("доля букв и отсутствие границ", () => {
    expect(textCoverage("Привет", ["Привет"])).toBe("ok");
    expect(textCoverage("Привет мир", ["Привет"])).toBe("unreadable");
    expect(textCoverage("Привет мир", ["123"])).toBe("unreadable");
    expect(textCoverage("2026", ["2026"])).toBe("skipped");
    expect(textCoverage("2026", [])).toBe("unreadable");
  });

  test("повтор только для 429, 5xx, таймаута и обрыва", async () => {
    let calls = 0;
    const value = await retrySpeech(
      async () => {
        calls += 1;
        if (calls < 3) throw new EdgeTTSError("handshake", "HANDSHAKE", { status: 429 });
        return "ok";
      },
      { pausesMs: [1, 1], isRetryable: isRetryableSpeechError },
    );
    expect(value).toBe("ok");
    expect(calls).toBe(3);

    await expect(
      retrySpeech(async () => {
        throw new EdgeTTSError("no", "REFUSED", { status: 1007 });
      }, { pausesMs: [1, 1], isRetryable: isRetryableSpeechError }),
    ).rejects.toMatchObject({ code: "REFUSED" });

    expect(isRetryableSpeechError(new SpeechIncompleteError())).toBe(true);
    expect(isRetryableSpeechError(new EdgeTTSError("no", "HANDSHAKE", { status: 403 }))).toBe(false);
    expect(
      mapSpeechFailure(new EdgeTTSError("connect ECONNREFUSED 127.0.0.1:9", "HANDSHAKE", { status: 429 }), {
        voiceExplicit: false,
        voiceName: "ru-RU-SvetlanaNeural",
      }).message,
    ).toMatch(/^speak_rate_limited: /);
    expect(
      mapSpeechFailure(Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9"), { code: "ECONNREFUSED" }), {
        voiceExplicit: true,
        voiceName: "ru-RU-SvetlanaNeural",
      }).message,
    ).not.toContain("127.0.0.1");
  });

  test("пауза одной сессии не держит другую", async () => {
    const marks: string[] = [];
    const first = withSpeechPace("pace-a", 40, async () => {
      marks.push("a-start");
      await sleepAbortable(15);
      marks.push("a-end");
    });
    const second = withSpeechPace("pace-a", 40, async () => {
      marks.push("b-start");
    });
    const other = withSpeechPace("pace-b", 40, async () => {
      marks.push("c-start");
    });
    await Promise.all([first, second, other]);
    expect(marks[0]).toBe("a-start");
    expect(marks.indexOf("c-start")).toBeLessThan(marks.indexOf("a-end"));
    expect(marks.indexOf("b-start")).toBeGreaterThan(marks.indexOf("a-end"));
  });
});
