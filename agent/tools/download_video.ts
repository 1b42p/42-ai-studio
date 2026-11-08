import { defineTool } from "eve/tools";
import { z } from "zod";

import { loadConfig } from "@/lib/config";
import { formatDownloadModelOutput } from "@/lib/download/policy";
import { type DownloadPhase, type DownloadResult, runDownload } from "@/lib/download/run";

const PHASES = new Set<DownloadPhase>(["Читаю сведения", "Скачиваю", "Достаю кадры", "Кладу в песочницу"]);

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "видео";
  }
}

function isResult(value: unknown): value is DownloadResult {
  return typeof value === "object" && value !== null && "videoPath" in value;
}

export default defineTool({
  description:
    "Скачивает одно видео по ссылке http или https и кладёт файл и кадры в песочницу. " +
    "Сначала укажи moments — секунды, на которых нужны кадры, — посмотри кадры через read_file и только потом выбирай фрагмент. " +
    "Прямые ссылки на файлы, плейлисты, трансляции и DRM не скачиваются. " +
    "yt-dlp, curl и wget из песочницы до этих сайтов не ходят: используй только этот инструмент. " +
    "Перед Remotion скопируй видео в public/ проекта. При ошибке download_* объясни причину и не повторяй тот же вызов больше двух раз.",
  inputSchema: z.object({
    url: z.string().min(1).max(2000).describe("Ссылка http или https на страницу с одним видео"),
    moments: z
      .array(z.number().finite().min(0).max(86_400))
      .max(12)
      .optional()
      .describe("Секунды кадров. Без списка берётся один кадр на 10% длительности"),
    maxHeight: z
      .union([z.literal(360), z.literal(720), z.literal(1080)])
      .optional()
      .describe("Максимальная высота кадра: 360, 720 или 1080. По умолчанию 720"),
  }),
  async *execute(input, ctx) {
    const phases: DownloadPhase[] = [];
    let notify: (() => void) | null = null;
    let settled = false;
    const done = runDownload(input, ctx, {
      config: loadConfig(),
      onPhase(phase) {
        phases.push(phase);
        notify?.();
        notify = null;
      },
    }).finally(() => {
      settled = true;
      notify?.();
      notify = null;
    });
    while (!settled || phases.length > 0) {
      if (phases.length === 0) {
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
        continue;
      }
      const phase = phases.shift();
      if (phase !== undefined) yield { phase };
    }
    yield await done;
  },
  toModelOutput(output) {
    if (!isResult(output)) return { type: "text", value: "" };
    return { type: "text", value: formatDownloadModelOutput(output) };
  },
  label: {
    start: ({ url }) => `Скачивание видео: ${hostOf(url)}`,
    delta: (_input, partial) => {
      if (typeof partial === "object" && partial !== null && "phase" in partial && typeof partial.phase === "string" && PHASES.has(partial.phase as DownloadPhase)) {
        return partial.phase;
      }
      return "";
    },
    complete: (_input, output) => isResult(output) ? `Видео скачано: ${output.title}` : "Видео скачано",
  },
});
