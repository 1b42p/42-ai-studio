import type { EveEvalStreamEvent } from "eve/evals";
import { expect, test } from "vitest";
import { reviewedRevisionBeforeVideo } from "../../../evals/questions/frame-observations";
import { frameOutput, questionFramesFor, questionProps } from "../../../evals/questions/media-fixture";
import type { VideoPresentationContract } from "../../../evals/questions/observations";

const recordedFrames = questionFramesFor(120, 2, 2);
const frameCommand = "npx remotion render src/index.ts Main out/props-v2/frames-2 --props=props-v2.json --frames=0,300,1199,1200,1800,2400,3000,3599 --image-format=jpeg --jpeg-quality=90";
const pixelCommand = "python3 /root/.agents/skills/frame-review/scripts/check-frames.py out/props-v2/frames-2/*.jpeg";
const videoCommand = "npx remotion render src/index.ts Main out/coffee-v2-draft.mp4 --props=props-v2.json --scale=0.5 --x264-preset=superfast --crf=32";
const exact = (value: string) => new RegExp(`^${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
const frames = { frames: recordedFrames, render: exact(frameCommand), pixels: exact(pixelCommand) };
const video: VideoPresentationContract = {
  path: "/workspace/calm-morning-120/out/coffee-v2-draft.mp4", seconds: 120, width: 960, height: 540,
  render: exact(videoCommand), size: /^stat$/, nonempty: /^test$/, probe: /^ffprobe$/,
  requiredEdit: { path: "/workspace/calm-morning-120/props-v2.json", content: questionProps(2) },
};
const event = (type: string, data: unknown) => ({ type, data }) as EveEvalStreamEvent;

function history(mode = "valid") {
  const calls = (id: string, toolName: string, input: unknown) => event("actions.requested", {
    actions: [{ kind: "tool-call", callId: id, toolName, input }],
  });
  const result = (id: string, output: unknown, status = "completed") => event("action.result", {
    status, result: { kind: "tool-result", callId: id, output },
  });
  const bashResult = (id: string, stdout = "", status = "completed") => result(id, { status, exitCode: 0, stdout });
  const edit = [calls("edit", "edit_file", { filePath: video.requiredEdit!.path, newString: questionProps(2) }),
    result("edit", { path: video.requiredEdit!.path, newContent: questionProps(2) }, mode === "failed-edit" ? "failed" : "completed")];
  const renderFrames = [calls("frames", "bash", { command: mode === "wrong-frame-command" ? frameCommand.replace("props-v2.json", "props-v1.json") : frameCommand }),
    bashResult("frames", "Rendered", mode === "pending-frames" ? "running" : "completed")];
  const report = recordedFrames.slice(mode === "missing-pixels" ? 1 : 0).map(frame => ({ path: frame.path,
    extrema: mode === "wrong-pixels" ? [[0, 0], [0, 0], [0, 0]] : frame.extrema, suspect: null }));
  const pixels = [calls("pixels", "bash", { command: pixelCommand }),
    result("pixels", { status: "completed", exitCode: 0, stdout: report.map(row => JSON.stringify(row)).join("\n") }, mode === "failed-pixels" ? "failed" : "completed")];
  const imageCalls = recordedFrames.slice(mode === "missing-image" ? 1 : 0).map(frame =>
    calls(frame.path, "read_file", { filePath: frame.path }));
  const images = recordedFrames.map(frame => result(frame.path,
    mode === "wrong-image" ? { ...frameOutput(frame), file: { ...frameOutput(frame).file, width: 960 } } : frameOutput(frame)));
  const videoStart = calls("video", "bash", { command: videoCommand });
  const beforeReview = mode === "no-frame-render" ? edit : mode === "missing-edit" ? renderFrames : mode === "frames-before-edit" ? [...renderFrames, ...edit] : [...edit, ...renderFrames];
  if (mode === "overlapping-frames") beforeReview.splice(2, 0, calls("earlier-frames", "bash", { command: frameCommand }));
  if (mode === "background-frames") beforeReview.splice(2, 0,
    calls("earlier-frames", "bash", { command: frameCommand }), bashResult("earlier-frames", "", "running"));
  const review = mode === "images-before-pixels" ? [...imageCalls, ...images, ...pixels] : [...pixels, ...imageCalls, ...images];
  const events = mode === "pixels-before-frames" ? [...edit, ...pixels, ...renderFrames, ...imageCalls, ...images] : [...beforeReview, ...review];
  if (mode === "late-edit") events.push(...edit);
  if (mode === "frame-rewrite") events.push(...renderFrames);
  if (mode === "same-batch-frames" || mode === "same-batch-running") {
    const rewrite = calls("frames-with-video", "bash", { command: frameCommand });
    if (rewrite.type !== "actions.requested" || videoStart.type !== "actions.requested") throw new Error("Missing actions");
    events.push(event("actions.requested", { actions: [...videoStart.data.actions, ...rewrite.data.actions] }));
    events.push(bashResult("frames-with-video", "Rendered", mode === "same-batch-running" ? "running" : "completed"));
  } else if (mode === "early-video") events.splice(events.length - 1, 0, videoStart);
  else events.push(videoStart);
  events.push(bashResult("video", "Rendered"));
  return events;
}

test("новая версия кадров отрендерена после props, проверена пикселями и просмотрена до видео", () => {
  expect(reviewedRevisionBeforeVideo(history(), video, frames)).toBe(true);
});

test.each([
  "missing-edit", "failed-edit", "frames-before-edit", "pending-frames", "wrong-frame-command", "missing-pixels",
  "wrong-pixels", "failed-pixels", "missing-image", "wrong-image", "images-before-pixels", "pixels-before-frames",
  "late-edit", "frame-rewrite", "early-video", "overlapping-frames", "background-frames", "no-frame-render",
  "same-batch-frames", "same-batch-running",
])("предзаписанные картинки не заменяют проверку правки: %s", mode => {
  expect(reviewedRevisionBeforeVideo(history(mode), video, frames)).toBe(false);
});
