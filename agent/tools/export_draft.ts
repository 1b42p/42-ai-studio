import { defineWorkflowTool, type WorkflowStepToolContext } from "eve/tools";
import { z } from "zod";

import { draftExportFilePattern, draftExportFinalPath, draftExportProjectPattern } from "@/lib/media/draft-export";
import { publishToolMedia } from "@/lib/media/publish-tool-media";

const approve = "Рендерить финал";
const revise = "Хочу поправить";

const projectFile = /^(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/;
const inputSchema = z.strictObject({
  project: z.string().regex(draftExportProjectPattern).max(100),
  draft: z.string().regex(draftExportFilePattern).max(160),
  entry: z.string().regex(projectFile).max(200).describe("Точка входа из команды чернового экспорта, относительно проекта"),
  composition: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/).max(100),
  props: z.string().regex(projectFile).max(200).optional().describe("Тот же JSON-файл props, если он использовался при экспорте черновика"),
  durationSeconds: z.number().gt(60).lte(3600).describe("Точная длительность видеопотока черновика по ffprobe, без округления"),
  width: z.number().int().min(2).max(7680),
  height: z.number().int().min(2).max(7680),
});

type ExportInput = z.infer<typeof inputSchema>;

async function runExport(input: ExportInput, ctx: WorkflowStepToolContext, render: boolean) {
  "use step";
  if (ctx.session.parent) return { status: "unavailable" as const };
  const sandbox = await ctx.getSandbox();
  const path = draftExportFinalPath(input.draft);
  const props = input.props ? ` --props=${input.props}` : "";
  const approval = `${path}.approved`;
  const command = `
set -eu
test -s ${input.draft} || exit 21
verify_video() {
  test -s "$1" &&
    npx --no-install remotion ffprobe -v error -select_streams v:0 \
      -show_entries stream=width,height,duration -of csv=p=0 "$1" |
      awk -F, -v w=${input.width} -v h=${input.height} -v duration=${input.durationSeconds} \
        '$1 == w && $2 == h && $3 >= duration - 0.2 && $3 <= duration + 0.2 { ok=1 } END { exit !ok }'
}
${render ? `
exec 9>out/.final-export.lock
flock -x 9
: > ${approval}
if ! verify_video ${path}; then
  temp=$(mktemp --suffix=.mp4 out/.final-XXXXXXXX)
  trap 'rm -f -- "$temp"' EXIT
  timeout --kill-after=15s 1800s npx --no-install remotion render ${input.entry} ${input.composition} "$temp"${props} --scale=1 --concurrency="$(sandbox-vcpu)" --overwrite
  verify_video "$temp"
  mv -f -- "$temp" ${path}
fi` : `if ! verify_video ${path}; then
  if test -f ${approval}; then exit 23; fi
  exit 22
fi`}
`;
  const result = await sandbox.run({
    workingDirectory: `/workspace/${input.project}`,
    command,
    abortSignal: ctx.abortSignal,
  });
  if (result.exitCode === 21) return { status: "missing_draft" as const };
  if (!render && result.exitCode === 23) return { status: "approved" as const };
  if (result.exitCode === 0 || (!render && result.exitCode === 22)) {
    const ready = result.exitCode === 0;
    const publishedPath = `${input.project}/${ready ? path : input.draft}`;
    try {
      await publishToolMedia({
        session: ctx.session,
        callId: ctx.callId,
        getSandbox: async () => sandbox,
      }, { path: publishedPath, contentType: "video/mp4" });
    } catch {
      return { status: "publish_failed" as const };
    }
    return ready ? { status: "rendered" as const, path: publishedPath } : { status: "waiting" as const };
  }
  return { status: "render_failed" as const };
}

export default defineWorkflowTool({
  description: "Публикует проверенный черновик длинного ролика и запрашивает согласование. " +
    "Передай путь версии и точные параметры той же Remotion-композиции. " +
    "Инструмент сам показывает видео и варианты, после согласия выполняет и публикует полный экспорт. " +
    "При выборе правок вернёт revision; свободный ответ вернёт текст. После rendered не повторяй экспорт.",
  inputSchema,
  label: {
    start: () => "Финальный экспорт",
    complete: () => "Согласование и экспорт",
  },
  async execute(input, ctx) {
    "use workflow";
    const existing = await runExport(input, ctx, false);
    if (existing.status === "approved") return runExport(input, ctx, true);
    if (existing.status !== "waiting") return existing;
    const minutes = Math.max(1, Math.ceil(input.durationSeconds * 2.2 / 60));
    const answer = await ctx.ask({
      display: "select",
      prompt: `Рендерить финал в полном качестве? Это займёт около ${minutes} мин.`,
      allowFreeform: true,
      options: [
        { id: approve, label: approve, description: "Выполнить полный экспорт этой версии." },
        { id: revise, label: revise, description: "Изменить проект перед полным экспортом." },
      ],
    });
    if (answer.status !== "answered") return { status: answer.status };
    if (answer.optionId === approve || (!answer.optionId && answer.text?.trim() === approve)) {
      return runExport(input, ctx, true);
    }
    return { status: "revision" as const, text: answer.text ?? "" };
  },
});
