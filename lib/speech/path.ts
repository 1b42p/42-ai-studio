import { resolveSandboxFilePath } from "@/lib/media/sandbox-path";

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export type SpeechPathResult =
  | { readonly ok: true; readonly basePath: string }
  | { readonly ok: false; readonly path: string };

/**
 * Путь озвучки без расширения внутри `/workspace`.
 * Пустой путь, завершающая косая черта и расширение — та же ошибка, что и выход наружу.
 */
export function resolveSpeechOutputPath(
  raw: string | undefined,
  callId: string,
): SpeechPathResult {
  const input = raw ?? `voiceover/speech-${callId.slice(0, 8)}`;
  if (raw !== undefined && (raw.length === 0 || raw.endsWith("/") || raw.endsWith("\\"))) {
    return { ok: false, path: raw };
  }
  if (CONTROL_CHARACTERS.test(input) || input.includes("\\")) {
    return { ok: false, path: input };
  }
  const hasExtension = input.split("/").some((segment) => {
    return segment.includes(".") && segment !== "." && segment !== "..";
  });
  if (hasExtension) return { ok: false, path: input };

  const resolved = resolveSandboxFilePath(input);
  if (resolved.kind !== "file") return { ok: false, path: input };
  return { ok: true, basePath: resolved.path };
}
