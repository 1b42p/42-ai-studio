import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";
import { previewSession, request, TIMEOUT } from "./fixtures";
import { inspectedVideo, previewEvidence, reviewedBeforeVideo } from "./observations";

export default Array.from({ length: 3 }, () => defineEval({
  description: "После уменьшенного 120-секундного черновика агент не меняет превью и ждёт согласования.",
  tags: ["preview", "preview-draft"],
  timeoutMs: TIMEOUT,
  async test(t) {
    const session = await previewSession(t, 120);
    try {
      const turn = await session.send(request(120));
      turn.parked();
      turn.loadedSkill("frame-review");
      turn.calledTool("ask_question", { status: "pending", count: 1 });
      session.requireInputRequest({ toolName: "ask_question" });
      turn.notCalledTool("set_session_preview");
      t.check(previewEvidence(turn.events, 120).draftWithoutPreview, satisfies(Boolean, "завершённый черновик без публикации превью и финала"));
      t.check(previewEvidence(turn.events, 120).questionAfterDraft, satisfies(Boolean, "согласование запрошено после завершения черновика"));
      t.check(previewEvidence(turn.events, 120).draftLinkBeforeQuestion, satisfies(Boolean, "ссылка на черновик отправлена отдельным текстом до запроса согласования"));
      t.check(reviewedBeforeVideo(turn.events, 120), satisfies(Boolean, "проверенные реальные кадры перед черновиком"));
      t.check(inspectedVideo(turn.events, 120), satisfies(Boolean, "черновик имеет размер, 960×540 и длительность 120 секунд"));
      // The last text block can be empty at the native question boundary;
      // draftLinkBeforeQuestion checks the completed assistant message instead.
    } finally {
      await session.cancel();
    }
  },
}));
