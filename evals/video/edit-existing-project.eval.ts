import { posix } from "node:path";
import { defineEval, type EveEvalToolCall } from "eve/evals";
import { equals, satisfies } from "eve/evals/expect";
import { VIDEO_REQUEST, videoSession } from "./fixtures";
import { framesBeforeFullRender, recreatesProject, renderOutputs, videoLinks, workspacePath } from "./observations";

export default Array.from({ length: 3 }, () => defineEval({
  description: "Правка третьей сцены продолжает тот же проект и отдаёт новый файл -v2.mp4.",
  tags: ["video", "edit-existing-project"],
  async test(t) {
    const session = await videoSession(t);
    const first = await session.send(VIDEO_REQUEST);
    first.succeeded();
    const originals = await t.require(videoLinks(first.message), satisfies((paths: string[]) => paths.length > 0,
      "Первый ход вернул MP4 в /workspace"));
    const original = originals[0];
    const project = /^\/workspace\/[^/]+(?=\/)/u.exec(original)?.[0] ?? "";
    await t.require(project, satisfies((path: string) => /^\/workspace\/[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(path),
      "Исходный ролик находится в каталоге проекта"));
    t.check(renderOutputs(first.toolCalls), satisfies((paths: string[]) => paths.includes(original),
      "Исходная ссылка соответствует полному рендеру первого хода"));

    const edited = await first.session.send("Замени третью сцену: совет про воду.");
    edited.succeeded();
    t.check(edited.sessionId, equals(first.sessionId));
    edited.calledTool("edit_file", { input: { filePath: (path: unknown) =>
      typeof path === "string" && (workspacePath(path)?.startsWith(`${project}/`) ?? false) && !/NOTES\.md$/u.test(path) } });
    t.check(edited.toolCalls.filter((call) => call.name === "bash"), satisfies((calls: readonly EveEvalToolCall[]) =>
      calls.every((call) => !recreatesProject(call.input.command)),
    "Во втором ходу нет create-video и копирования из /opt/remotion"));
    edited.eventsSatisfy("Правка снова проверяет кадры до полного рендера", framesBeforeFullRender);
    const outputs = renderOutputs(edited.toolCalls);
    t.check(videoLinks(edited.message), satisfies((paths: string[]) => paths.some((path) =>
      path.startsWith(`${project}/`) && !originals.includes(path) &&
      posix.basename(path).endsWith("-v2.mp4") && outputs.includes(path)),
    "Во втором ответе новый отрендеренный MP4 с суффиксом -v2 в прежнем проекте"));
    t.succeeded();
  },
}));
