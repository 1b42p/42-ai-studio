import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";
import { VIDEO_EVAL_TIMEOUT_MS, videoSession } from "./fixtures";
import { framesBeforeFullRender, renderOutputs, videoLinks } from "./observations";

export default Array.from({ length: 3 }, (_, index) => defineEval({
  timeoutMs: VIDEO_EVAL_TIMEOUT_MS,
  description: "Незавершённый проект без точки входа восстановлен без перебора CLI; кадры и MP4 настоящие.",
  tags: ["video", "missing-entrypoint"],
  async test(t) {
    const session = await videoSession(t, {
      caseId: `video/missing-entrypoint/${String(index).padStart(4, "0")}`, missingEntrypoint: true,
    });
    const turn = await session.send("В /workspace/unfinished уже начат проект Remotion. Доделай его в том же каталоге: горизонтальный ролик 6 секунд, 1920×1080, 30 кадров/с, без звука. Текст: «Утро начинается с движения», плавное появление и лёгкое движение кругов на тёмном фоне. Стиль выбери сам, вопросов не нужно. Проверь и отдай MP4.");
    t.succeeded();
    t.loadedSkill("sandbox-environment");
    const failures = turn.toolCalls.filter((call) => call.name === "bash").reduce((count, call) => {
      const output = JSON.stringify(call.output ?? "");
      return count + (output.match(/No entry point specified/gu)?.length ?? 0);
    }, 0);
    t.check(failures, satisfies((count: number) => count <= 3,
      "Отсутствующая точка входа не вызывает больше трёх отказов независимо от вариантов команды"));
    t.eventsSatisfy("Восстановленный проект проверен кадрами до полного рендера", framesBeforeFullRender);
    const rendered = renderOutputs(turn.toolCalls);
    t.check(videoLinks(turn.message), satisfies((links: string[]) => links.some((path) =>
      path.startsWith("/workspace/unfinished/") && rendered.includes(path)),
    "Ответ содержит MP4, действительно закодированный в исходном проекте"));
  },
}));
