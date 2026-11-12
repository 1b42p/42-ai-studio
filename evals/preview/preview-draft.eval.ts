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
    const turn = await session.send(request(120));
    // ask_question is explicitly unavailable in this fully stubbed suite, not a
    // simulated user approval. No response is sent and no final is authorised.
    t.succeeded();
    t.loadedSkill("frame-review");
    t.calledTool("ask_question", { output: { status: "unavailable" } });
    t.notCalledTool("set_session_preview");
    t.check(previewEvidence(turn.events, 120).draftWithoutPreview, satisfies(Boolean, "завершённый черновик без публикации превью и финала"));
    t.check(previewEvidence(turn.events, 120).questionAfterDraft, satisfies(Boolean, "согласование запрошено после завершения черновика"));
    t.check(reviewedBeforeVideo(turn.events, 120), satisfies(Boolean, "проверенные реальные кадры перед черновиком"));
    t.check(inspectedVideo(turn.events, 120), satisfies(Boolean, "черновик имеет размер, 960×540 и длительность 120 секунд"));
    turn.messageIncludes(videoLinkPattern(120, true));
  },
}));
