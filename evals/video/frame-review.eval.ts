import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";
import { VIDEO_EVAL_TIMEOUT_MS, VIDEO_REQUEST, videoSession } from "./fixtures";
import { framesBeforeFullRender, isFramePath, planBeforeWork, renderOutputs, videoLinks } from "./observations";

export default Array.from({ length: 3 }, (_, index) => defineEval({
  timeoutMs: VIDEO_EVAL_TIMEOUT_MS,
  description: "До полного рендера загружен frame-review и просмотрены опорные кадры; в ответе MP4.",
  tags: ["video", "frame-review"],
  async test(t) {
    const session = await videoSession(t, { caseId: `video/frame-review/${String(index).padStart(4, "0")}` });
    const turn = await session.send(VIDEO_REQUEST);
    t.succeeded();
    t.loadedSkill("frame-review");
    t.eventsSatisfy("До работы опубликован план ролика", planBeforeWork);
    t.calledTool("read_file", { input: { filePath: isFramePath }, count: (count) => count >= 4 });
    t.eventsSatisfy("Четыре разных изображения прочитаны до первого полного рендера", framesBeforeFullRender);
    const rendered = renderOutputs(turn.toolCalls);
    t.check(videoLinks(turn.message), satisfies((links: string[]) =>
      links.length > 0 && links.some((link) => rendered.includes(link)),
    "Ответ содержит Markdown-ссылку на отрендеренный MP4 внутри /workspace"));
  },
}));
