import { z } from "zod";

export const CUSTOM_INSTRUCTIONS_LIMIT = 4000;
export const SETTINGS_BODY_MAX_BYTES = 64 * 1024;
export const INVALID_SETTINGS_MESSAGE = "Укажите настройки в правильном формате.";

export function normalizeCustomInstructions(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/gu, (character) =>
      character === "\n" || character === "\t" || character === "\u200C" || character === "\u200D"
        ? character
        : "",
    )
    .normalize("NFC")
    .trim();
}

export function customInstructionsLength(text: string): number {
  return Array.from(normalizeCustomInstructions(text)).length;
}

const customInstructionsSchema = z
  .string({ error: INVALID_SETTINGS_MESSAGE })
  .transform(normalizeCustomInstructions)
  .refine((text) => customInstructionsLength(text) <= CUSTOM_INSTRUCTIONS_LIMIT, {
    error: (issue) =>
      `Общие указания не должны быть длиннее 4000 символов (сейчас ${customInstructionsLength(String(issue.input))}).`,
  });

export const settingsSchema = z.strictObject({
  customInstructions: customInstructionsSchema,
  memoryEnabled: z.boolean({ error: INVALID_SETTINGS_MESSAGE }),
});

export const settingsPatchSchema = settingsSchema.partial().refine(
  (patch) => Object.values(patch).some((value) => value !== undefined),
  { error: INVALID_SETTINGS_MESSAGE },
);

export type Settings = z.output<typeof settingsSchema>;
export type SettingsPatch = z.input<typeof settingsPatchSchema>;
