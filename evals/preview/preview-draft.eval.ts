import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";
import { previewSession, request, TIMEOUT } from "./fixtures";
import { inspectedVideo, previewEvidence, reviewedBeforeVideo } from "./observations";
import { videoLinkPattern } from "./commands";

export default Array.from({ length: 3 }, () => defineEval({
  description: "После уменьшенного 120-секундного черновика агент не меняет превью и ждёт согласования.",
  tags: ["preview", "preview-draft"],
  timeoutMs: TIMEOUT,
  async test(t) {
    const session = await previewSession(t, 120);
    try {
      const turn = await session.send(request(120));
      const evidence = previewEvidence(turn.events, 120);
      turn.loadedSkill("frame-review");
      turn.notCalledTool("set_session_preview");
      t.check(evidence.draftWithoutPreview, satisfies(Boolean, "завершённый черновик без публикации превью и попыток финала"));
      t.check(reviewedBeforeVideo(turn.events, 120), satisfies(Boolean, "проверенные реальные кадры перед черновиком"));
      t.check(inspectedVideo(turn.events, 120), satisfies(Boolean, "черновик имеет размер, 960×540 и длительность 120 секунд"));
      // Inspect completed text, not the last (possibly empty) question step.
      const linkedDraft = turn.events.some((event, index) => event.type === "message.completed" &&
        index > evidence.draftCompleted && evidence.draftCompleted >= 0 &&
        typeof event.data.message === "string" && videoLinkPattern(120, true).test(event.data.message) &&
        inspectedVideo(turn.events.slice(0, index), 120));
      t.check(linkedDraft, satisfies(Boolean, "ссылка на текущий проверенный черновик отправлена завершённым сообщением"));

      const questions = turn.toolCalls.filter(call => call.name === "ask_question");
      turn.parked();
      t.check(questions.length, satisfies(count => count === 1, "ровно один вызов ask_question"));
      turn.calledTool("ask_question", { status: "pending", count: 1 });
      t.check(evidence.questionAfterDraft, satisfies(Boolean, "согласование запрошено после завершения черновика"));
      t.check(evidence.draftLinkBeforeQuestion, satisfies(Boolean, "ссылка на черновик отправлена отдельным текстом до запроса согласования"));
      session.requireInputRequest({ toolName: "ask_question" });
    } finally {
      await session.cancel();
    }
  },
}));
