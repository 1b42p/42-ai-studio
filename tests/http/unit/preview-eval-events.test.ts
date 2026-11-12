import type { EveEvalStreamEvent } from "eve/evals";
import { expect, test } from "vitest";
import { inspectedVideo, previewEvidence } from "../../../evals/preview/observations";
import { videoLinkPattern } from "../../../evals/preview/commands";
import { resolveSandboxPath } from "../../../lib/media/sandbox-path";

const event = (type: string, data: unknown) => ({ type, data }) as EveEvalStreamEvent;
const ok = { status: "completed", exitCode: 0, stdout: "Rendered out/final.mp4", stderr: "" };
function call(id: string, toolName: string, input: Record<string, unknown>, output: unknown = ok) {
  return [
    event("actions.requested", { actions: [{ kind: "tool-call", callId: id, toolName, input }] }),
    event("action.result", { status: "completed", result: { kind: "tool-result", callId: id, toolName, output } }),
  ];
}
const render = (id = "render") => call(id, "bash", { command: "npx remotion render src/index.tsx Main out/final.mp4 --props=props-30.json" });
const preview = (id = "preview", path = "/workspace/preview-coffee/out/key.jpeg") => call(id, "set_session_preview", { path }, { path, size: 42000, contentType: "image/jpeg" });

test("превью запрошено ровно один раз после завершения последнего успешного полного рендера", () => {
  expect(previewEvidence([...render(), ...preview()], 30).publishedAfterFinal).toBe(true);
});

test.each(["before", "stale", "repeated", "running", "nonzero", "partial", "parallel", "failed", "orphan", "compound", "draft"])("не засчитывает %s как публикацию после готового финала", fault => {
  let events = [...render(), ...preview()];
  if (fault === "before") events = [...preview(), ...render()];
  if (fault === "stale") events.push(...render("later"));
  if (fault === "repeated") events.push(...preview("again"));
  if (fault === "running" || fault === "nonzero") events = [...call("render", "bash", { command: "npx remotion render src/index.tsx Main out/final.mp4 --props=props-30.json" }, fault === "running" ? { status: "running", jobId: "0123abcd" } : { ...ok, exitCode: 1 }), ...preview()];
  if (fault === "partial") events[1] = event("action.partial", (events[1] as { data: unknown }).data);
  if (fault === "parallel") events = [events[0], events[2], events[1], events[3]];
  if (fault === "failed") events[1] = event("action.result", { ...(events[1] as { data: object }).data, status: "failed" });
  if (fault === "orphan") events.shift();
  if (fault === "compound") events = [...call("render", "bash", { command: "npx remotion render src/index.tsx Main out/final.mp4 --props=props-30.json && false" }), ...preview()];
  if (fault === "draft") events = [...call("render", "bash", { command: "npx remotion render src/index.tsx Main out/draft.mp4 --props=props-120.json --scale=0.5 --x264-preset=superfast --crf=32" }), ...preview()];
  expect(previewEvidence(events, 30).publishedAfterFinal).toBe(false);
});

test.each(["out/key.png", "../../tmp/key.jpg", "/tmp/key.jpg", "https://example.com/p.jpg", "out/key.jpg?x=1"])("отвергает неподходящий путь %s", path => {
  expect(previewEvidence([...render(), ...preview("p", path)], 30).publishedAfterFinal).toBe(false);
});

test("любой JPEG внутри рабочей области допустим; имя превью не фиксируется", () => {
  expect(previewEvidence([...render(), ...preview("p", "preview-coffee/out/other.jpg")], 30).publishedAfterFinal).toBe(true);
});

test("для длинного ролика нужен завершённый черновик, но ни одного запроса публикации", () => {
  const draft = call("draft", "bash", { command: "npx remotion render src/index.tsx Main out/draft.mp4 --props=props-120.json --scale=0.5 --x264-preset=superfast --crf=32" });
  expect(previewEvidence(draft, 120).draftWithoutPreview).toBe(true);
  expect(previewEvidence([], 120).draftWithoutPreview).toBe(false);
  expect(previewEvidence([...draft, preview()[0]], 120).draftWithoutPreview).toBe(false);
});

test.each([[30, false], [120, true]] as const)("ссылка на ролик %s разрешается от /workspace, включая каталог проекта", (seconds, draft) => {
  const filename = draft ? "draft" : "final";
  const target = `/workspace/preview-coffee-${seconds}/out/${filename}.mp4`;
  for (const path of [target, target.slice("/workspace/".length)]) {
    expect(resolveSandboxPath(path)).toEqual({ kind: "file", path: target });
    expect(`[Ролик](${path})`).toMatch(videoLinkPattern(seconds, draft));
  }
  const wrongRelative = `out/${filename}.mp4`;
  expect(resolveSandboxPath(wrongRelative)).toEqual({ kind: "file", path: `/workspace/${wrongRelative}` });
  for (const path of [wrongRelative, `/workspace/${wrongRelative}`, `another-project/${wrongRelative}`, `https://example.com/${wrongRelative}`]) {
    expect(`[Ролик](${path})`).not.toMatch(videoLinkPattern(seconds, draft));
  }
});

test.each(["width", "height", "duration", "audio", "missing-field", "running", "nonzero", "compound"])("production ffprobe не доказывает готовность черновика при %s", fault => {
  let command = "npx remotion ffprobe -v error -show_entries stream=codec_name,codec_type,width,height,duration:format=duration -of default=nw=1 out/draft.mp4";
  let stdout = "codec_name=h264\ncodec_type=video\nwidth=960\nheight=540\nduration=120.000000\nduration=120.000000\n";
  if (fault === "width") stdout = stdout.replace("width=960", "width=1920");
  if (fault === "height") stdout = stdout.replace("height=540", "height=1080");
  if (fault === "duration") stdout = stdout.replace("duration=120.000000", "duration=30.000000");
  if (fault === "audio") stdout += "codec_name=aac\ncodec_type=audio\nduration=120.000000\n";
  if (fault === "missing-field") stdout = stdout.replace("codec_type=video\n", "");
  if (fault === "compound") command += " && false";
  const output = fault === "running" ? { status: "running", jobId: "0123abcd" } : { ...ok, stdout, exitCode: fault === "nonzero" ? 1 : 0 };
  const events = [
    ...call("draft", "bash", { command: "npx remotion render src/index.tsx Main out/draft.mp4 --props=props-120.json --scale=0.5 --x264-preset=superfast --crf=32" }),
    ...call("size", "bash", { command: "test -s out/draft.mp4" }),
    ...call("probe", "bash", { command }, output),
  ];
  expect(inspectedVideo(events, 120)).toBe(false);
});
