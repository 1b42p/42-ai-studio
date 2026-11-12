import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";
import { previewSession, request, TIMEOUT } from "./fixtures";
import { inspectedVideo, previewEvidence, reviewedBeforeVideo, workspaceJpeg } from "./observations";
import { videoLinkPattern } from "./commands";

export default Array.from({ length: 3 }, () => defineEval({
  description: "После 30-секундного готового ролика агент один раз публикует JPEG выразительного кадра.",
  tags: ["preview", "preview-final"],
  timeoutMs: TIMEOUT,
  async test(t) {
    const session = await previewSession(t, 30);
    const turn = await session.send(request(30));
    t.succeeded();
    t.loadedSkill("frame-review");
    t.calledTool("set_session_preview", { count: 1, input: { path: value => workspaceJpeg(value) !== null }, output: { contentType: "image/jpeg" } });
    t.check(previewEvidence(turn.events, 30).publishedAfterFinal, satisfies(Boolean, "JPEG запрошен после завершения последнего полного рендера, ровно один раз"));
    t.check(previewEvidence(turn.events, 30).stillAfterVerifiedFinal, satisfies(Boolean, "выбранный JPEG отрендерен после проверенного финала и до запроса публикации"));
    t.check(reviewedBeforeVideo(turn.events, 30), satisfies(Boolean, "шесть настоящих JPEG проверены и просмотрены до рендера"));
    t.check(inspectedVideo(turn.events, 30), satisfies(Boolean, "размер и метаданные последнего финала проверены до публикации превью"));
    turn.messageIncludes(videoLinkPattern(30));
  },
}));
