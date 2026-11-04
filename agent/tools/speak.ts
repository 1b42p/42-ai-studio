import { defineTool } from "eve/tools";
import { z } from "zod";

import { publishToolMedia } from "@/lib/media/publish-tool-media";
import { findAppSessionByEveId } from "@/lib/sessions/service";
import { edgeTtsClient } from "@/lib/speech/client";
import {
  logSpeechFailure,
  mapSpeechFailure,
  speakBadPath,
  speakVoiceNotFound,
  speechError,
} from "@/lib/speech/errors";
import { withSpeechPace, SPEECH_MIN_INTERVAL_MS } from "@/lib/speech/pace";
import { resolveSpeechOutputPath } from "@/lib/speech/path";
import { speechEveSessionId } from "@/lib/speech/session";
import { synthesizeSpeech } from "@/lib/speech/synthesize";
import {
  resolveVoiceChoice,
  voiceChoiceNeedsCatalog,
  type CatalogVoice,
} from "@/lib/speech/voices";

const SPEECH_PAUSES_MS = [1_000, 4_000] as const;

export interface SpeakResult {
  readonly audioPath: string;
  readonly timingsPath: string;
  readonly voice: string;
  readonly language: string;
  readonly format: "mp3";
  readonly durationMs: number;
  readonly wordCount: number;
  readonly text: string;
  readonly media: { readonly audioId: string };
}

export function formatSpeakModelOutput(output: SpeakResult): string {
  const seconds = (output.durationMs / 1000).toLocaleString("ru-RU", {
    maximumFractionDigits: 1,
  });
  return [
    `Аудио: ${output.audioPath}`,
    `Тайминги: ${output.timingsPath}`,
    `Голос: ${output.voice}`,
    `Длительность: ${seconds} с`,
    `Слов: ${output.wordCount}`,
  ].join("\n");
}

async function loadCatalog(language: string): Promise<CatalogVoice[]> {
  try {
    const voices = await edgeTtsClient().getVoices();
    return voices.flatMap((voice) => {
      const name = voice.ShortName ?? "";
      const locale = voice.Locale ?? "";
      if (name.length === 0 || locale.length === 0) return [];
      return [{ name, locale, gender: voice.Gender ?? "" }];
    });
  } catch (error) {
    logSpeechFailure(error);
    throw mapSpeechFailure(error, { voiceExplicit: false, voiceName: language });
  }
}

export default defineTool({
  description:
    "Озвучивает закадровый текст ролика голосом Edge TTS и кладёт в песочницу два файла: " +
    "mp3 и тайминги слов (.words.json) для субтитров. Голос должен совпадать с языком текста " +
    "(или быть многоязычным), иначе часть букв будет пропущена. Текст длиннее 10 000 знаков " +
    "озвучивай по частям, по сценам. По умолчанию русский голос Светланы (ru-RU-SvetlanaNeural). " +
    "Список голосов даёт list_voices. При speak_unavailable или повторном speak_rate_limited " +
    "озвучь Piper, как в разделе «Озвучка» инструкций.",
  inputSchema: z.object({
    text: z
      .string()
      .min(1)
      .max(10_000)
      .describe("Текст для озвучки, от 1 до 10 000 знаков"),
    voice: z
      .string()
      .min(1)
      .optional()
      .describe("Короткое имя голоса, например ru-RU-SvetlanaNeural. Если задан, language игнорируется"),
    language: z
      .string()
      .min(1)
      .default("ru-RU")
      .describe("Локаль (ru-RU) или язык (ru, en). По умолчанию ru-RU"),
    rate: z
      .number()
      .int()
      .min(-50)
      .max(100)
      .default(0)
      .describe("Изменение скорости речи в процентах, от -50 до 100"),
    outputPath: z
      .string()
      .optional()
      .describe("Путь без расширения внутри рабочей области. По умолчанию voiceover/speech-<id>"),
  }),
  label: {
    start: () => "Озвучка текста",
    complete: () => "Озвучка готова",
  },
  async execute(input, ctx): Promise<SpeakResult> {
    const eveSessionId = speechEveSessionId(ctx.session);
    const session = await findAppSessionByEveId(eveSessionId);
    if (session === null) throw speechError("speak_no_session");

    const path = resolveSpeechOutputPath(input.outputPath, ctx.callId);
    if (!path.ok) throw new Error(speakBadPath(path.path));

    const text = input.text.trim();
    if (text.length === 0) throw speechError("speak_bad_input");

    const catalog = voiceChoiceNeedsCatalog(input.language, input.voice)
      ? await loadCatalog(input.language)
      : [];
    const choice = resolveVoiceChoice({ voice: input.voice, language: input.language }, catalog);
    if (!choice.ok) throw new Error(speakVoiceNotFound(choice.name));

    const client = edgeTtsClient();
    const produced = await withSpeechPace(
      eveSessionId,
      SPEECH_MIN_INTERVAL_MS,
      () =>
        synthesizeSpeech({
          text,
          voice: choice.choice.voice,
          language: choice.choice.language,
          voiceExplicit: input.voice !== undefined,
          rate: input.rate,
          signal: ctx.abortSignal,
          pausesMs: SPEECH_PAUSES_MS,
          generate: (spoken, voice, options) => client.generate(spoken, voice, options),
        }),
      ctx.abortSignal,
    );

    const audioPath = `${path.basePath}.mp3`;
    const timingsPath = `${path.basePath}.words.json`;
    const sandbox = await ctx.getSandbox();
    await sandbox.writeFiles({
      files: [
        { path: audioPath, content: new Uint8Array(produced.audio) },
        { path: timingsPath, content: new TextEncoder().encode(JSON.stringify(produced.timings)) },
      ],
      abortSignal: ctx.abortSignal,
    });

    let audioId: string;
    try {
      const published = await publishToolMedia(ctx, {
        path: audioPath,
        contentType: "audio/mpeg",
      });
      audioId = published.mediaId;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      throw speechError("speak_publish_failed");
    }

    return {
      audioPath,
      timingsPath,
      voice: choice.choice.voice,
      language: choice.choice.language,
      format: "mp3",
      durationMs: produced.durationMs,
      wordCount: produced.timings.words.length,
      text,
      media: { audioId },
    };
  },
  toModelOutput(output) {
    return { type: "text", value: formatSpeakModelOutput(output) };
  },
});
