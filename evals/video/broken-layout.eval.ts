import { defineEval, type EveEvalToolCall } from "eve/evals";
import { satisfies } from "eve/evals/expect";
import { VIDEO_EVAL_TIMEOUT_MS, videoSession } from "./fixtures";
import { distinctFrameViews, isFramePath } from "./observations";

const REQUEST = "В /workspace/broken лежит почти готовый ролик. Проверь его перед публикацией: " +
  "кадры, отступы и анимации. Если есть нарушения — перечисли их и исправь. Вопросов не нужно.";

/** Последняя запись проверки кадров: отчёт, который видит пользователь в NOTES.md. */
function latestNotes(calls: readonly EveEvalToolCall[]): string {
  const texts = calls.flatMap((call) => {
    if (call.name !== "edit_file" || typeof call.output !== "object" || call.output === null) return [];
    const output = call.output as { path?: unknown; newContent?: unknown };
    return typeof output.path === "string" && output.path.endsWith("/NOTES.md") &&
      typeof output.newContent === "string" ? [output.newContent] : [];
  });
  return texts.at(-1) ?? "";
}

export default Array.from({ length: 3 }, (_, index) => defineEval({
  timeoutMs: VIDEO_EVAL_TIMEOUT_MS,
  description: "Готовый проект с нарушениями отступов и анимации проверен, нарушения названы, а не объявлены отсутствующими.",
  tags: ["video", "broken-layout"],
  async test(t) {
    const session = await videoSession(t, {
      caseId: `video/broken-layout/${String(index).padStart(4, "0")}`, brokenLayout: true,
    });
    const turn = await session.send(REQUEST);
    t.succeeded();
    t.loadedSkill("frame-review");
    t.calledTool("read_file", { input: { filePath: isFramePath }, count: (count) => count >= 4 });
    t.eventsSatisfy("Четыре разных кадра просмотрены до выводов", distinctFrameViews);
    t.judge("В поле notes — последняя запись проверки кадров, в поле response — итоговый ответ. " +
      "В проекте /workspace/broken были нарушения: заголовок первой сцены 64 px при норме около 149 px " +
      "для ширины 1920, отступ сверху 80 px при норме около 178 px, и масштабная анимация без ограничения, " +
      "которая обрезала текст к концу первой сцены. Засчитай работу, если записи или ответ называют хотя бы " +
      "одно из этих нарушений как найденный дефект. Работа, утверждающая, что дефектов не было или проект " +
      "соответствовал правилам, считается провалом.",
    { on: { response: turn.message ?? "", notes: latestNotes(turn.toolCalls) } }).gate(0.8);
  },
}));
