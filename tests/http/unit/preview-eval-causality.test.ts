import { expect, test } from "vitest";
import { previewEvidence, reviewedBeforeVideo } from "../../../evals/preview/observations";
import { previewFrames } from "../../../evals/preview/media-fixture";
import { previewHistory } from "./preview-eval-support";
import { frameName, frameNumbers, projectPath } from "../../../evals/preview/commands";

test.each([30, 120])("актуальные предоставленные JPEG %s проходят без лишнего свежего рендера, но с проверкой и просмотром", async seconds => {
  const h = await previewHistory(seconds);
  h.review(); h.render();
  expect(reviewedBeforeVideo(h.events, seconds)).toBe(true);
});

test.each(["reads-before-pixels", "parallel-pixels", "video-before-last-read", "missing-read", "missing-pixels", "fresh-render", "pending-fresh-render", "stale-pixel-result"])("seed не оправдывает нарушение порядка %s", async fault => {
  const h = await previewHistory();
  if (fault === "reads-before-pixels") { h.readFrames(); h.bash(h.pixelCommand); }
  if (fault === "parallel-pixels") {
    const pixels = h.request("bash", { command: h.pixelCommand });
    h.readFrames(); h.complete(pixels);
  }
  if (fault === "video-before-last-read") {
    h.bash(h.pixelCommand);
    const reads = frameNumbers(30).map(frame => h.request("read_file", { filePath: `${projectPath(30)}/out/frames-1/${frameName(frame)}` }));
    reads.slice(0, -1).forEach(read => h.complete(read));
    const render = h.request("bash", { command: h.renderCommand() });
    h.complete(reads.at(-1)!); h.complete(render);
    expect(reviewedBeforeVideo(h.events, 30)).toBe(false);
    return;
  }
  if (fault === "missing-read") {
    h.bash(h.pixelCommand);
    frameNumbers(30).slice(1).forEach(frame => h.call("read_file", { filePath: `${projectPath(30)}/out/frames-1/${frameName(frame)}` }));
  }
  if (fault === "missing-pixels") h.readFrames();
  if (fault === "fresh-render") { h.review(); h.bash(h.framesCommand); }
  if (fault === "pending-fresh-render") {
    h.review();
    const frames = h.request("bash", { command: h.framesCommand });
    h.bash(h.pixelCommand); h.readFrames(); h.complete(frames);
  }
  if (fault === "stale-pixel-result") {
    const pixels = h.request("bash", { command: h.pixelCommand });
    h.bash(h.framesCommand); h.complete(pixels); h.readFrames();
  }
  h.render();
  expect(reviewedBeforeVideo(h.events, 30)).toBe(false);
});

test("после повторного рендера новые завершённые проверки и просмотры восстанавливают доказательство", async () => {
  const h = await previewHistory();
  h.review(); h.review(true); h.render();
  expect(reviewedBeforeVideo(h.events, 30)).toBe(true);
});

test("проверка каждого кадра непосредственно перед его просмотром не заменяет проверку всей выборки до первого просмотра", async () => {
  const h = await previewHistory();
  for (const frame of frameNumbers(30)) {
    const relative = `out/frames-1/${frameName(frame)}`;
    expect(h.bash(`python3 "$HOME/.agents/skills/frame-review/scripts/check-frames.py" ${relative}`).failed).toBe(false);
    h.call("read_file", { filePath: `${projectPath(30)}/${relative}` });
  }
  h.render();
  expect(reviewedBeforeVideo(h.events, 30)).toBe(false);
});

test("параллельные проверки всех кадров, завершённые до первого запроса просмотра, допустимы", async () => {
  const h = await previewHistory();
  const checks = frameNumbers(30).map(frame => h.request("bash", {
    command: `python3 "$HOME/.agents/skills/frame-review/scripts/check-frames.py" out/frames-1/${frameName(frame)}`,
  }));
  checks.toReversed().forEach(check => h.complete(check));
  h.readFrames(); h.render();
  expect(reviewedBeforeVideo(h.events, 30)).toBe(true);
});

test.each(frameNumbers(30))("канонический still кадра %s поддержан без выдуманных пикселей preview.jpg", async frame => {
  const h = await previewHistory();
  h.review(); h.render(); h.inspect();
  expect(h.still(frame).failed).toBe(false);
  const published = h.publish();
  expect(published.failed).toBe(false);
  expect(published.output).toMatchObject({ path: `${projectPath(30)}/out/preview.jpg`, contentType: "image/jpeg" });
  const size = (published.output as { size: number }).size;
  expect(size).toBeGreaterThan(0); expect(size).toBeLessThanOrEqual(1048576);
  expect(previewEvidence(h.events, 30).stillAfterVerifiedFinal).toBe(true);
  expect(previewFrames.some(frame => frame.path.endsWith("/out/preview.jpg"))).toBe(false);
  expect(h.call("read_file", { filePath: `${projectPath(30)}/out/preview.jpg` }).failed).toBe(true);
});

test.each(["no-still", "before-final", "before-file-checks", "parallel-publication", "stale-final", "failed", "running", "pending-overwrite", "failed-overwrite", "wrong-path", "wrong-props", "wrong-quality", "wrong-scale", "unknown-frame"])("публикация не наследует неподходящий still: %s", async fault => {
  const h = await previewHistory();
  h.review();
  if (fault === "before-final") h.still();
  h.render();
  if (fault === "before-file-checks") h.still();
  h.inspect();
  if (fault === "parallel-publication") {
    const still = h.request("bash", { command: h.stillCommand() });
    const publish = h.request("set_session_preview", { path: `${projectPath(30)}/out/preview.jpg` });
    h.complete(still); h.complete(publish);
  } else {
    if (fault === "stale-final" || fault === "wrong-path") h.still();
    if (fault === "stale-final") { h.render(); h.inspect(); }
    if (fault === "failed" || fault === "running") {
      const still = h.request("bash", { command: h.stillCommand() });
      h.complete(still, fault === "failed" ? { status: "failed" } : { output: { status: "running", jobId: "0123abcd" } });
    }
    if (fault === "pending-overwrite" || fault === "failed-overwrite") {
      h.still();
      const replacement = h.request("bash", { command: h.stillCommand(150) });
      if (fault === "failed-overwrite") h.complete(replacement, { status: "failed" });
    }
    if (["wrong-props", "wrong-quality", "wrong-scale", "unknown-frame"].includes(fault)) {
      const replacements: Record<string, [string, string]> = {
        "wrong-props": ["props-30.json", "props-120.json"],
        "wrong-quality": ["--jpeg-quality=85", "--jpeg-quality=90"],
        "wrong-scale": ["--scale=0.5", "--scale=1"],
        "unknown-frame": ["--frame=600", "--frame=37"],
      };
      const command = h.stillCommand().replace(...replacements[fault]);
      expect(h.bash(command).failed).toBe(true);
    }
    h.publish(fault === "wrong-path" ? "out/key-600.jpg" : undefined);
  }
  expect(previewEvidence(h.events, 30).stillAfterVerifiedFinal).toBe(false);
});

test("ранний still не мешает новому корректному still; именные экспорты тоже требуют новый рендер", async () => {
  const h = await previewHistory();
  h.still(); h.review(); h.render(); h.inspect();
  const selected = "out/key-150.jpg";
  expect(h.still(150, selected).failed).toBe(false);
  h.publish(selected);
  expect(previewEvidence(h.events, 30).stillAfterVerifiedFinal).toBe(true);
  const cached = await previewHistory();
  cached.review(); cached.render(); cached.inspect(); cached.publish(selected);
  expect(previewEvidence(cached.events, 30).stillAfterVerifiedFinal).toBe(false);
});

test.each(["late-after-publication", "both-before-publication", "same-batch"])("перекрывающиеся still в один путь не дают готовое превью: %s", async mode => {
  const h = await previewHistory();
  h.review(); h.render(); h.inspect();
  const start = h.events.length;
  const first = h.request("bash", { command: h.stillCommand(0) });
  const second = h.request("bash", { command: h.stillCommand(150) });
  if (mode === "same-batch") {
    const requests = h.events.splice(start);
    const [a, b] = requests;
    if (a.type !== "actions.requested" || b.type !== "actions.requested") throw new Error("Missing still requests");
    h.events.push({ ...a, data: { ...a.data, actions: [...a.data.actions, ...b.data.actions] } });
  }
  h.complete(second);
  if (mode !== "late-after-publication") h.complete(first);
  h.publish();
  if (mode === "late-after-publication") h.complete(first);
  expect(previewEvidence(h.events, 30).stillAfterVerifiedFinal).toBe(false);
});

test("последовательные завершённые still A, затем B, затем публикация подтверждают готовность", async () => {
  const h = await previewHistory();
  h.review(); h.render(); h.inspect();
  h.still(0); h.still(150); h.publish();
  expect(previewEvidence(h.events, 30).stillAfterVerifiedFinal).toBe(true);
});

test("после перекрытия требуется новый still без незавершённых соседних записей", async () => {
  const h = await previewHistory();
  h.review(); h.render(); h.inspect();
  const first = h.request("bash", { command: h.stillCommand(0) });
  const second = h.request("bash", { command: h.stillCommand(150) });
  h.complete(second); h.complete(first);
  h.still(600); h.publish();
  expect(previewEvidence(h.events, 30).stillAfterVerifiedFinal).toBe(true);
});

test("поздний успех старого still не исправляет завершившийся ошибкой новый вызов", async () => {
  const h = await previewHistory();
  h.review(); h.render(); h.inspect();
  const first = h.request("bash", { command: h.stillCommand(0) });
  const second = h.request("bash", { command: h.stillCommand(150) });
  h.complete(second, { status: "failed" }); h.complete(first); h.publish();
  expect(previewEvidence(h.events, 30).stillAfterVerifiedFinal).toBe(false);
});

test.each(["failed", "running"])("новый успешный still после %s учитывает реальное завершение предыдущей записи", async status => {
  const h = await previewHistory();
  h.review(); h.render(); h.inspect();
  const first = h.request("bash", { command: h.stillCommand(0) });
  const second = h.request("bash", { command: h.stillCommand(150) });
  h.complete(second, status === "failed" ? { status: "failed" } : { output: { status: "running", jobId: "0123abcd" } });
  h.complete(first);
  h.still(600); h.publish();
  expect(previewEvidence(h.events, 30).stillAfterVerifiedFinal).toBe(status === "failed");
});

test.each(["before-question", "question-only", "after-unavailable", "wrong-relative", "before-draft", "before-file-checks", "stale-draft"])("ссылка на черновик должна быть в завершённом тексте до запроса вопроса: %s", async where => {
  const h = await previewHistory(120);
  const link = "[Черновик](preview-coffee-120/out/draft.mp4)";
  h.review();
  if (where === "before-draft") h.message(link);
  h.render();
  if (where === "before-file-checks") h.message(link);
  h.inspect();
  if (where === "before-question") h.message(link);
  if (where === "wrong-relative") h.message("[Черновик](out/draft.mp4)");
  if (where === "stale-draft") { h.message(link); h.render(); h.inspect(); }
  h.call("ask_question", { question: where === "question-only" ? `${link}. Рендерить финал?` : "Рендерить финал?" });
  if (where === "after-unavailable") h.message(link);
  expect(previewEvidence(h.events, 120).draftLinkBeforeQuestion).toBe(where === "before-question");
});

test.each([30, 120])("атомарные проверки известного проекта %s не заставляют угадывать файлы", async seconds => {
  const h = await previewHistory(seconds);
  const P = projectPath(seconds);
  const keys = frameNumbers(seconds).map(frame => `out/key-${frame}.jpg`).join(" ");
  for (const command of ["pwd", "ls -la src", "ls -la out", "ls -la", "ls out/frames-1", "test -s src/index.tsx", "test -s package.json", `test -s props-${seconds}.json`, "test -d node_modules", `ls -l ${keys}`, "ls -l src/index.tsx", `ls -l ${P}/props-${seconds}.json`]) {
    expect(h.bash(`cd ${P} && ${command}`).failed, command).toBe(false);
  }
  const initialOut = h.bash("ls out").output as { stdout: string };
  expect(initialOut.stdout).not.toMatch(/(?:final|draft)\.mp4|preview\.jpg/);
  for (const command of ["test -s src/Root.tsx", "ls -l src/Root.tsx", "test -s src/index.tsx && false", "ls -la src && ls out"]) expect(h.bash(command).failed, command).toBe(true);
  expect(h.call("read_file", { filePath: `${P}/src/Root.tsx` }).failed).toBe(true);
  for (const home of ["$HOME", "/root", "", "/"]) expect(h.call("read_file", { filePath: `${home}/.agents/skills/frame-review/references/notes-template.md` }).failed).toBe(false);
  expect(h.call("read_file", { filePath: "/home/oai/.agents/skills/frame-review/references/notes-template.md" }).failed).toBe(true);
});

test.each([30, 120])("первое чтение NOTES %s — настоящий исходный снимок, а не старый текущий журнал", async seconds => {
  const h = await previewHistory(seconds);
  const path = `${projectPath(seconds)}/NOTES.md`;
  const first = h.call("read_file", { filePath: path });
  expect(first.failed).toBe(false);
  const content = (first.output as { content: string }).content;
  expect(content).toContain(`длительность ${seconds} с (${seconds * 30} кадров)`);
  expect(content).toContain("Исходный снимок");
  expect(content).toContain("не обновляемое состояние журнала");
  expect(content).not.toMatch(/превью|миниатюр|ask_question|сначала черновик/);
  expect(h.call("edit_file", { filePath: path, newString: "Новый фактический журнал", overwrite: true }).failed).toBe(false);
  expect(h.call("read_file", { filePath: path }).failed).toBe(true);
  const late = await previewHistory(seconds);
  late.call("edit_file", { filePath: path, newString: "Обновлённое состояние", overwrite: true });
  const snapshot = late.call("read_file", { filePath: path });
  expect((snapshot.output as { content: string }).content).toBe(content);
  expect((snapshot.output as { content: string }).content).not.toContain("Обновлённое состояние");
});

test.each([30, 120])("источники и props %s остаются неизменяемыми: чужая правка не получает старые JPEG как новые", async seconds => {
  const h = await previewHistory(seconds);
  for (const path of ["src/index.tsx", `props-${seconds}.json`]) {
    const filePath = `${projectPath(seconds)}/${path}`;
    const before = h.call("read_file", { filePath });
    expect(h.call("edit_file", { filePath, newString: "arbitrary new composition", overwrite: true }).failed).toBe(true);
    expect(h.call("read_file", { filePath }).output).toEqual(before.output);
  }
  expect(h.bash(h.framesCommand.replace(`props-${seconds}.json`, "unknown-props.json")).failed).toBe(true);
});
