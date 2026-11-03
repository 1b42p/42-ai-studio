import { defineTool } from "eve/tools";
import { z } from "zod";

import {
  applyEditFile,
  formatEditFileModelOutput,
  type EditFileApplyResult,
} from "@/lib/edit-file/apply";
import { assertEditFilePath } from "@/lib/edit-file/path";
import { readTextFileLimited } from "@/lib/edit-file/read";

export interface EditFileResult extends EditFileApplyResult {
  readonly path: string;
}

export default defineTool({
  description:
    "Создаёт или изменяет текстовый файл в песочнице точной заменой фрагмента. " +
    "Для нового файла не передавай oldString. Не используй bash (sed, echo >) для правок.",
  inputSchema: z.object({
    filePath: z.string().describe("Абсолютный путь или путь от /workspace"),
    oldString: z
      .string()
      .optional()
      .describe("Точный фрагмент для замены; пустой или отсутствует — создание/перезапись"),
    newString: z.string().describe("Новый фрагмент или полное содержимое файла"),
    replaceAll: z
      .boolean()
      .optional()
      .describe("Заменить все вхождения oldString"),
    overwrite: z
      .boolean()
      .optional()
      .describe("Разрешить перезапись непустого файла без oldString"),
  }),
  label: {
    start: ({ filePath }) => `Правка ${filePath}`,
  },
  async execute(input, ctx): Promise<EditFileResult> {
    assertEditFilePath(input.filePath);
    const sandbox = await ctx.getSandbox();
    const path = sandbox.resolvePath(input.filePath);

    const read = await readTextFileLimited(sandbox, path, {
      abortSignal: ctx.abortSignal,
    });
    // too_large / not_text / is_directory уже брошены при чтении.
    const existing = read.kind === "missing" ? null : read.text;

    const applied = applyEditFile(path, existing, {
      oldString: input.oldString,
      newString: input.newString,
      replaceAll: input.replaceAll,
      overwrite: input.overwrite,
    });

    await sandbox.writeTextFile({
      path,
      content: applied.newContent,
      abortSignal: ctx.abortSignal,
    });

    return { path, ...applied };
  },
  toModelOutput(output) {
    return { type: "text", value: formatEditFileModelOutput(output) };
  },
});
