import { defineTool } from "eve/tools";
import { z } from "zod";

import { edgeTtsClient } from "@/lib/speech/client";
import { logSpeechFailure, speechError } from "@/lib/speech/errors";
import { selectVoices, type CatalogVoice, type ListedVoice } from "@/lib/speech/voices";

export interface ListVoicesResult {
  readonly voices: readonly ListedVoice[];
  readonly availableLocales?: readonly string[];
}

export default defineTool({
  description:
    "Список голосов Edge TTS для языка. language — язык (ru, en) или локаль (ru-RU). " +
    "gender необязателен: Female или Male. Если голосов нет, voices пуст и есть availableLocales. " +
    "Вызывай перед speak, когда нужен не голос по умолчанию.",
  inputSchema: z.object({
    language: z.string().min(1).describe("Язык (ru, en, de) или локаль (ru-RU)"),
    gender: z.enum(["Female", "Male"]).optional().describe("Female или Male"),
  }),
  label: {
    start: () => "Список голосов",
  },
  async execute(input): Promise<ListVoicesResult> {
    let catalog: CatalogVoice[];
    try {
      const voices = await edgeTtsClient().getVoices();
      catalog = voices.flatMap((voice) => {
        const name = voice.ShortName ?? "";
        const locale = voice.Locale ?? "";
        if (name.length === 0 || locale.length === 0) return [];
        return [{ name, locale, gender: voice.Gender ?? "" }];
      });
    } catch (error) {
      logSpeechFailure(error);
      throw speechError("voices_unavailable");
    }
    return selectVoices(catalog, input.language, input.gender);
  },
});
