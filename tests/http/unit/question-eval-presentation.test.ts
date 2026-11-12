import type { EveEvalStreamEvent } from "eve/evals";
import { expect, test } from "vitest";
import { questionVideoContracts } from "../../../evals/questions/fixtures";
import { verifiedFinalPreview, verifiedVideoLinkBeforeQuestion, type VideoPresentationContract } from "../../../evals/questions/observations";

const render = "npx remotion render src/index.ts Main out/coffee-draft-v2.mp4 --props=props-v2.json --scale=0.5";
const size = "stat -c %s out/coffee-draft-v2.mp4";
const probe = "npx remotion ffprobe -v error -show_streams -show_format -of json out/coffee-draft-v2.mp4";
const selectedProbe = "npx remotion ffprobe -v error -show_entries stream=codec_name,codec_type,width,height,duration:format=duration -of default=nw=1 out/coffee-draft-v2.mp4";
const exact = (value: string) => new RegExp(`^${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
const contract: VideoPresentationContract = {
  path: "/workspace/calm-morning/out/coffee-draft-v2.mp4",
  seconds: 120, width: 960, height: 540,
  render: exact(render), size: exact(size), nonempty: exact("test -s out/coffee-draft-v2.mp4"),
  probe: new RegExp(`${exact(probe).source}|${exact(selectedProbe).source}`),
};
const metadata = () => ({ streams: [{ codec_type: "video", codec_name: "h264", width: 960, height: 540, duration: "120.000000" }] });
const event = (type: string, data: unknown) => ({ type, data }) as EveEvalStreamEvent;

function history(mode = "valid", href = "calm-morning/out/coffee-draft-v2.mp4") {
  const events: EveEvalStreamEvent[] = [];
  let serial = 0;
  const action = (command: string) => ({ kind: "tool-call", toolName: "bash", callId: `bash-${serial++}`, input: { command } });
  const start = (call: ReturnType<typeof action>) => events.push(event("actions.requested", { actions: [call] }));
  const finish = (call: ReturnType<typeof action>, stdout = "", status = "completed", exitCode = 0) => events.push(event("action.result", {
    status: "completed", result: { kind: "tool-result", callId: call.callId, toolName: "bash", output: { status, exitCode, stdout } },
  }));
  const link = () => events.push(event("message.completed", { message: `[Черновик](${href})` }));
  const first = action(render);
  start(first);
  const earlySize = action(size);
  if (mode === "early-proof") start(earlySize);
  if (mode === "overlapping") { const other = action(render); start(other); finish(other); }
  finish(first, "", mode === "background" ? "running" : "completed", mode === "failed-render" ? 1 : 0);
  if (mode === "early-link") link();
  const measured = mode === "early-proof" ? earlySize : action(mode === "nonempty" ? "test -s out/coffee-draft-v2.mp4" : size);
  if (mode !== "early-proof") start(measured);
  finish(measured, mode === "zero-size" ? "0\n" : "1000000\n");
  const inspected = action(mode.startsWith("selected-") ? selectedProbe : probe);
  start(inspected);
  const data = metadata();
  if (mode === "wrong-dimensions") data.streams[0].width = 1920;
  if (mode === "wrong-duration") data.streams[0].duration = "30.000000";
  if (mode === "audio") data.streams.push({ ...data.streams[0], codec_type: "audio" });
  const selected = `codec_name=h264\ncodec_type=video\nwidth=960\nheight=540\nduration=${mode === "selected-na" ? "N/A" : "120.000000"}\nduration=120.000000\n`;
  finish(inspected, mode.startsWith("selected-") ? selected : mode === "invalid-probe" ? "not JSON" : JSON.stringify(data));
  if (!["early-link", "late-link", "question-only", "no-link"].includes(mode)) link();
  if (mode === "new-write") { const rewrite = action(render); start(rewrite); finish(rewrite); }
  if (mode === "failed-new-write") { const rewrite = action(render); start(rewrite); finish(rewrite, "", "completed", 1); }
  if (mode === "unsupported-write") { const rewrite = action(`${render} --crf=1`); start(rewrite); finish(rewrite); }
  const question = { kind: "tool-call", toolName: "ask_question", callId: "ask-current", input: {
    question: mode === "question-only" ? `[Черновик](${href}) Рендерить финал?` : "Рендерить финал?",
  } };
  const writer = action(render);
  events.push(event("actions.requested", { actions: mode === "same-batch" ? [question, writer] : [question] }));
  if (mode === "late-link") link();
  if (mode !== "missing-input") events.push(event("input.requested", { requests: [{ requestId: "question-current", action: question }] }));
  return events;
}

test.each([
  "calm-morning/out/coffee-draft-v2.mp4",
  "/workspace/calm-morning/out/coffee-draft-v2.mp4",
  "calm-morning/out/coffee-draft-v2.mp4?download=1",
])("проверенное исправленное видео показано до точного вызова вопроса: %s", href => {
  expect(verifiedVideoLinkBeforeQuestion(history("valid", href), contract, "question-current")).toBe(true);
});

test.each(["nonempty", "selected-default", "selected-na"])("поддержанное доказательство размера и метаданных: %s", mode => {
  expect(verifiedVideoLinkBeforeQuestion(history(mode), contract, "question-current")).toBe(true);
});

test.each([
  "early-proof", "overlapping", "background", "failed-render", "early-link", "zero-size",
  "wrong-dimensions", "wrong-duration", "audio", "invalid-probe", "late-link", "question-only",
  "no-link", "new-write", "failed-new-write", "unsupported-write", "same-batch", "missing-input",
])("ссылка нового черновика не получает ложное подтверждение: %s", mode => {
  expect(verifiedVideoLinkBeforeQuestion(history(mode), contract, "question-current")).toBe(false);
});

test.each(["calm-morning/out/coffee-draft-v1.mp4", "another-project/out/coffee-draft-v2.mp4", "https://example.com/coffee-draft-v2.mp4"])("чужой или прежний MP4 не выдаёт новую версию: %s", href => {
  expect(verifiedVideoLinkBeforeQuestion(history("valid", href), contract, "question-current")).toBe(false);
});

test("чужой ожидающий вопрос не заменяет нужный запрос", () => {
  expect(verifiedVideoLinkBeforeQuestion(history(), contract, "question-another")).toBe(false);
});

test.each([
  ["valid", true], ["missing", false], ["late", false], ["pending", false],
  ["failed", false], ["wrong-input", false], ["wrong-output", false],
])("новая версия требует завершённой поддержанной правки до рендера: %s", (mode, accepted) => {
  const requiredEdit = { path: "/workspace/calm-morning/props-v2.json", content: '{"title":"Утро начинается с кофе"}' };
  const events = history();
  const action = { kind: "tool-call", toolName: "edit_file", callId: "edit-current", input: {
    filePath: requiredEdit.path, newString: mode === "wrong-input" ? '{"title":"Другой заголовок"}' : requiredEdit.content,
  } };
  const start = event("actions.requested", { actions: [action] });
  const finish = event("action.result", { status: mode === "failed" ? "failed" : "completed", result: {
    kind: "tool-result", toolName: "edit_file", callId: action.callId,
    output: { path: requiredEdit.path, newContent: mode === "wrong-output" ? "" : requiredEdit.content },
  } });
  if (mode === "late") events.splice(events.findIndex(row => row.type === "input.requested") - 1, 0, start, finish);
  else if (mode === "pending") { events.unshift(start); events.splice(3, 0, finish); }
  else if (mode !== "missing") events.unshift(start, finish);
  expect(verifiedVideoLinkBeforeQuestion(events, { ...contract, requiredEdit }, "question-current")).toBe(accepted);
});

const finalVideo = questionVideoContracts(120).find(video => video.version === 1 && !video.draft)!;

function finalHistory(mode = "valid") {
  const events: EveEvalStreamEvent[] = [];
  const root = "/workspace/calm-morning-120";
  const call = (id: string, toolName: string, input: unknown) => event("actions.requested", {
    actions: [{ kind: "tool-call", toolName, callId: id, input }],
  });
  const result = (id: string, toolName: string, output: unknown, status = "completed") => event("action.result", {
    status, result: { kind: "tool-result", toolName, callId: id, output },
  });
  const bash = (id: string, command: string, stdout = "", exitCode = 0) => [
    call(id, "bash", { command: `cd ${root} && ${command}` }),
    result(id, "bash", { status: "completed", exitCode, stdout }),
  ];
  const renderCommand = "npx remotion render src/index.ts Main out/coffee-v1.mp4 --props=props-v1.json --crf=18 --x264-preset=medium";
  const stillCommand = `npx remotion still src/index.ts Main out/preview-v1.jpg --props=props-v1.json --frame=0 --image-format=jpeg --jpeg-quality=85 --scale=0.5`;
  events.push(...bash("render", renderCommand, "Rendered", mode === "failed-render" ? 1 : 0));
  events.push(...bash("size", "stat -c %s out/coffee-v1.mp4", "4000000\n"));
  const metadata = structuredClone(finalVideo.metadata);
  if (mode === "wrong-dimensions") metadata.streams[0].width = 960;
  const probe = bash("probe", "npx remotion ffprobe -v error -show_streams -show_format -of json out/coffee-v1.mp4", JSON.stringify(metadata));
  const still = bash("still", mode === "wrong-props" ? stillCommand.replace("props-v1", "props-v2") : stillCommand,
    "Nominal still", mode === "failed-still" ? 1 : 0);
  if (mode === "early-still") events.push(...still, ...probe);
  else events.push(...probe, ...(mode === "missing-still" ? [] : still));
  const publish = call("publish", "set_session_preview", { path: mode === "wrong-path" ? `${root}/out/wrong.jpg` : finalVideo.previewPath });
  const published = result("publish", "set_session_preview", {
    path: finalVideo.previewPath, contentType: "image/jpeg", size: finalVideo.previewSizeBytes,
  }, mode === "failed-publish" ? "failed" : "completed");
  if (mode === "same-batch") {
    const start = events.findIndex(row => row.type === "actions.requested" && row.data.actions.some(action => action.callId === "still"));
    if (events[start].type === "actions.requested" && publish.type === "actions.requested") {
      events[start] = event("actions.requested", { actions: [...events[start].data.actions, ...publish.data.actions] });
    }
    events.push(published);
  } else events.push(publish, ...(mode === "pending-publish" ? [] : [published]));
  if (mode === "rewrite") events.push(...bash("rewrite", renderCommand, "Rendered"));
  if (mode === "wrong-new-still") events.push(...bash("wrong-new-still", stillCommand.replace("preview-v1", "preview-v2"), "Rendered"));
  events.push(event("message.completed", { message: `[Видео](${mode === "old-link" ? "calm-morning-120/out/coffee-v1-draft.mp4" : finalVideo.path})` }));
  return events;
}

test("после согласия финал проверен, затем создано превью, публикация завершена и отправлена ссылка", () => {
  expect(verifiedFinalPreview(finalHistory(), finalVideo)).toBe(true);
});

test.each([
  "failed-render", "wrong-dimensions", "wrong-props", "failed-still", "early-still", "missing-still",
  "wrong-path", "failed-publish", "same-batch", "pending-publish", "rewrite", "wrong-new-still", "old-link",
])("превью не подтверждает незавершённый финал: %s", mode => {
  expect(verifiedFinalPreview(finalHistory(mode), finalVideo)).toBe(false);
});
