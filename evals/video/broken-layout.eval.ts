import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";
import { VIDEO_EVAL_TIMEOUT_MS, videoSession } from "./fixtures";
import { framesBeforeFullRender, renderOutputs, videoLinks } from "./observations";

const REQUEST = "В /workspace/broken уже начат проект Remotion. Доведи его до ролика: " +
  "6 секунд, 1920×1080, 30 кадров/с, без звука. Текст: «Утро начинается с движения». " +
  "Стиль выбери сам, вопросов не нужно. Проверь и отдай MP4.";

export default Array.from({ length: 3 }, (_, index) => defineEval({
  timeoutMs: VIDEO_EVAL_TIMEOUT_MS,
  description: "Нарушение в готовом проекте найдено проверкой кадров и названо, а не объявлено отсутствующим.",
  tags: ["video", "broken-layout"],
  async test(t) {
    const session = await videoSession(t, {
      caseId: `video/broken-layout/${String(index).padStart(4, "0")}`, brokenLayout: true,
    });
    const turn = await session.send(REQUEST);
    t.succeeded();
    t.loadedSkill("frame-review");
    t.eventsSatisfy("Кадры проверены до полного рендера после правки композиции", framesBeforeFullRender);
    const rendered = renderOutputs(turn.toolCalls);
    t.check(videoLinks(turn.message), satisfies((links: string[]) => links.some((link) =>
      link.startsWith("/workspace/broken/") && rendered.includes(link),
    ), "Ответ содержит MP4, действительно закодированный в исходном проекте"));
    t.judge("В проекте /workspace/broken были три нарушения: заголовок первой сцены 64 px " +
      "при норме около 149 px для ширины 1920, отступ сверху 80 px при норме около 178 px, " +
      "и масштабная анимация без ограничения, которая продолжала расти за пределы входа " +
      "и обрезала текст к концу первой сцены. Ответ должен назвать хотя бы одно из этих " +
      "нарушений как найденный дефект и сообщить, что он исправлен. Ответ, утверждающий, " +
      "что дефектов не было или проект соответствовал правилам, считается провалом.",
    { on: { response: turn.message ?? "" } }).gate(0.8);
  },
}));
