import type { EveEvalContext, ToolStub } from "eve/evals";
import { expect, test } from "vitest";
import { parseToolStubs } from "../../../node_modules/eve/dist/src/tool-stubs/rules.js";
import { StubPlayback } from "../../../node_modules/eve/dist/src/tool-stubs/playback.js";
import { previewSession, request } from "../../../evals/preview/fixtures";
import { frameName, frameNumbers, projectPath } from "../../../evals/preview/commands";
import { inspectedVideo, previewEvidence, reviewedBeforeVideo } from "../../../evals/preview/observations";
import { musicSession } from "../../../evals/music/fixtures";
import { voiceoverSession } from "../../../evals/voiceover/fixtures";
import { questionSession } from "../../../evals/questions/fixtures";
import { videoSession } from "../../../evals/video/fixtures";
import { webSession } from "../../../evals/web/fixtures";
import { documentSession } from "../../../evals/documents/fixtures";
import type { EveEvalStreamEvent } from "eve/evals";

const toolNames = ["bash", "read_file", "edit_file", "agent", "ask_question", "speak", "list_voices", "download_video", "read_page", "web_search", "set_session_preview"];

test.each([30, 120])("бриф %s не подсказывает автоматическое создание превью", seconds => {
  expect(request(seconds)).not.toMatch(/миниатюр|превью|выразительн|set_session_preview/i);
  expect(request(seconds)).toContain("out/final.mp4");
});
async function capture(create: (t: EveEvalContext) => Promise<unknown>) {
  let captured: readonly ToolStub[] = [];
  await create({ target: { fetch: async (path: string) => path === "/api/health" ? new Response(null, { headers: { "x-studio-eval-runtime": "stub", "x-studio-video-eval": "1" } }) : Response.json({ tools: { static: toolNames.map(name => ({ name })), dynamic: [] } }) },
    session: async (options: { stubs: readonly ToolStub[] }) => { captured = options.stubs; return {}; },
  } as unknown as EveEvalContext);
  return captured;
}

test.each([
  ["preview-final", (t: EveEvalContext) => previewSession(t, 30)],
  ["preview-draft", (t: EveEvalContext) => previewSession(t, 120)],
  ["music", musicSession],
  ["voiceover", (t: EveEvalContext) => voiceoverSession(t, false)],
  ["piper", (t: EveEvalContext) => voiceoverSession(t, true)],
  ["questions", (t: EveEvalContext) => questionSession(t)],
  ["video", (t: EveEvalContext) => videoSession(t, { caseId: "preview-isolation" })],
  ["web", (t: EveEvalContext) => webSession(t, [{ id: "pages", tool: "read_page", outcome: { response: {} } }, { id: "search", tool: "web_search", outcome: { response: {} } }])],
  ["documents", (t: EveEvalContext) => documentSession(t, "/workspace/source/book.pdf")],
] as const)("%s: все эффекты изолированы и не больше 100 native правил", async (name, create) => {
  const stubs = await capture(create);
  expect(stubs.length).toBeLessThanOrEqual(100);
  expect(parseToolStubs(stubs)).toHaveLength(stubs.length);
  expect(stubs.some(stub => stub.tool === "set_session_preview" && stub.match === undefined)).toBe(true);
  if (name !== "preview-draft" && name !== "questions") {
    expect(stubs.find(stub => stub.tool === "ask_question" && stub.match === undefined)?.outcome).toEqual({ response: { status: "unavailable" } });
  }
});

test.each([[30, false], [120, true], [120, false]] as const)("native playback %s, draft=%s: полный причинный путь, не эмуляция изменяемой FS", async (seconds, draft) => {
  const playback = new StubPlayback(parseToolStubs(await capture(t => previewSession(t, seconds))));
  const events: EveEvalStreamEvent[] = [];
  const event = (type: string, data: unknown) => ({ type, data }) as EveEvalStreamEvent;
  const call = (tool: string, input: Record<string, unknown>) => {
    const callId = `call-${events.length}`;
    const answer = playback.call({ callId, tool, input });
    if (answer.kind !== "stub") throw new Error(`Live tool: ${tool}`);
    const failed = "throw" in answer.outcome;
    const output = failed ? answer.outcome.throw!.message : answer.outcome.response;
    events.push(event("actions.requested", { actions: [{ kind: "tool-call", callId, toolName: tool, input }] }), event("action.result", { status: failed ? "failed" : "completed", result: { kind: "tool-result", callId, toolName: tool, output } }));
    return { answer, failed, output };
  };
  const bash = (command: string) => call("bash", { command });
  expect(bash(`npx remotion render src/index.tsx Main out/frames-1 --props=props-${seconds}.json --frames=${frameNumbers(seconds).join(",")} --image-format=jpeg --jpeg-quality=90`).failed).toBe(false);
  expect(bash('python3 "$HOME/.agents/skills/frame-review/scripts/check-frames.py" out/frames-1/*.jpeg').failed).toBe(false);
  for (const frame of frameNumbers(seconds)) expect(call("read_file", { filePath: `${projectPath(seconds)}/out/frames-1/${frameName(frame)}` }).failed).toBe(false);
  const output = draft ? "draft" : "final";
  expect(bash(`npx remotion render src/index.tsx Main out/${output}.mp4 --props=props-${seconds}.json${draft ? " --scale=0.5 --x264-preset=superfast --crf=32" : ""}`).failed).toBe(false);
  expect(reviewedBeforeVideo(events, seconds)).toBe(true);
  expect(bash(seconds === 120 ? `test -s out/${output}.mp4` : `stat -c %s out/${output}.mp4`).failed).toBe(false);
  const probe = draft
    ? `npx remotion ffprobe -v error -show_entries stream=codec_name,codec_type,width,height,duration:format=duration -of default=nw=1 out/${output}.mp4`
    : `npx remotion ffprobe -v error -show_streams -show_format -of json out/${output}.mp4`;
  const metadata = bash(probe);
  expect(metadata.failed).toBe(false);
  if (draft) expect(metadata.output).toMatchObject({ stdout: "codec_name=h264\ncodec_type=video\nwidth=960\nheight=540\nduration=120.000000\nduration=120.000000\n" });
  expect(inspectedVideo(events, seconds)).toBe(draft === (seconds > 60));
  const withoutPixels = events.filter(row => row.type !== "action.result" || row.data.result.kind !== "tool-result" || !(row.data.result.output && typeof row.data.result.output === "object" && "stdout" in row.data.result.output && String(row.data.result.output.stdout).includes('"extrema"')));
  expect(reviewedBeforeVideo(withoutPixels, seconds)).toBe(false);
  const noImages = structuredClone(events);
  for (const row of noImages) if (row.type === "action.result" && row.data.result.kind === "tool-result" && row.data.result.output && typeof row.data.result.output === "object" && "file" in row.data.result.output) row.data.result.output = { path: "/workspace/fake.jpeg", content: "Красивый кадр" };
  expect(reviewedBeforeVideo(noImages, seconds)).toBe(false);
  if (seconds === 30) {
    const frame = frameNumbers(seconds)[4];
    expect(bash(`npx remotion still src/index.tsx Main out/key-${frame}.jpg --props=props-${seconds}.json --frame=${frame} --image-format=jpeg --jpeg-quality=85 --scale=0.5`).failed).toBe(false);
    expect(call("set_session_preview", { path: `${projectPath(seconds)}/out/key-${frame}.jpg` }).failed).toBe(false);
    expect(previewEvidence(events, seconds).publishedAfterFinal).toBe(true);
  } else if (draft) {
    expect(previewEvidence(events, seconds).draftWithoutPreview).toBe(true);
    expect(playback.call({ callId: "native-question", tool: "ask_question", input: { question: "Согласуете черновик?" } }).kind).not.toBe("stub");
  } else {
    // Reproduce the model's wrong branch without manufacturing tool failures:
    // frames, full render, file checks and preview all complete successfully.
    expect(call("read_file", { filePath: `${projectPath(seconds)}/out/key-2400.jpg` }).failed).toBe(false);
    expect(call("set_session_preview", { path: `${projectPath(seconds)}/out/key-2400.jpg` }).failed).toBe(false);
    expect(previewEvidence(events, seconds).publishedAfterFinal).toBe(true);
    expect(previewEvidence(events, seconds).draftWithoutPreview).toBe(false);
    expect(previewEvidence(events, seconds).questionAfterDraft).toBe(false);
  }
  for (const command of [
    `npx remotion render src/index.tsx Main out/final.mp4 --props=props-${seconds}.json && false`,
    `echo npx remotion render src/index.tsx Main out/final.mp4 --props=props-${seconds}.json`,
    `npx remotion render src/index.tsx Main out/final.mp4 --props=props-${seconds}.json --frames=0-3`,
    `npx remotion render src/index.tsx Main out/final.mp4 --props=props-${seconds}.json --props=other.json`,
  ]) expect(bash(command).failed, command).toBe(true);
  expect(call("set_session_preview", { path: "/workspace/no-such.jpg" }).failed).toBe(true);
});

test("native matcher принимает только production-настройки черновика", async () => {
  const playback = new StubPlayback(parseToolStubs(await capture(t => previewSession(t, 120))));
  const command = "npx remotion render src/index.tsx Main out/draft.mp4 --props=props-120.json --scale=0.5 --x264-preset=superfast --crf=32";
  const answer = (command: string) => playback.call({ callId: command, tool: "bash", input: { command } });
  expect(answer(command)).toMatchObject({ kind: "stub", ruleId: "draft-render", outcome: { response: { status: "completed", exitCode: 0 } } });
  expect(answer(command.replace("--scale=0.5 --x264-preset=superfast --crf=32", "--crf 32 --x264-preset superfast --scale 0.5"))).toMatchObject({ kind: "stub", ruleId: "draft-render" });
  for (const invalid of [
    command.replace("superfast", "medium"), command.replace("superfast", "superfast-extra"),
    command.replace("--crf=32", "--crf=18"), command.replace("--crf=32", "--crf=320"),
    command.replace(" --crf=32", ""), command.replace(" --x264-preset=superfast", ""),
    command.replace("--scale=0.5", "--scale=1"), `${command} && false`, `${command}; echo done`,
  ]) expect(answer(invalid), invalid).toMatchObject({ kind: "stub", ruleId: "unsupported-command", outcome: { throw: expect.anything() } });
});

test.each([[30, false], [30, true], [120, false], [120, true]] as const)("успешный рендер %s, draft=%s имеет собственные согласованные проверки файла", async (seconds, draft) => {
  const playback = new StubPlayback(parseToolStubs(await capture(t => previewSession(t, seconds))));
  const file = `out/${draft ? "draft" : "final"}.mp4`;
  const project = projectPath(seconds);
  const events: EveEvalStreamEvent[] = [];
  const call = (tool: string, input: Record<string, unknown>) => {
    const callId = `call-${events.length}`;
    const answer = playback.call({ callId, tool, input });
    expect(answer.kind).toBe("stub");
    if (answer.kind !== "stub" || !("response" in answer.outcome)) throw new Error(`Нет успешной подмены: ${JSON.stringify(input)}`);
    const output = answer.outcome.response;
    events.push(
      { type: "actions.requested", meta: { at: "2026-11-12T00:00:00.000Z", id: `request-${callId}` }, data: { sequence: events.length / 2, stepIndex: events.length / 2, turnId: "turn_0", actions: [{ kind: "tool-call", callId, toolName: tool, input }] } } as EveEvalStreamEvent,
      { type: "action.result", data: { status: "completed", result: { kind: "tool-result", callId, toolName: tool, output } } } as EveEvalStreamEvent,
    );
    return output as { status: string; exitCode: number; stdout: string };
  };
  const bash = (command: string) => call("bash", { command });
  expect(bash(`cd ${project} && npx remotion render src/index.tsx Main ${file} --props=props-${seconds}.json${draft ? " --scale=0.5 --x264-preset=superfast --crf=32" : ""}`)).toMatchObject({ status: "completed", exitCode: 0 });
  let size: number | undefined;
  for (const path of [file, `${project}/${file}`]) {
    const prefix = path === file ? `cd ${project} && ` : "";
    const actualSize = Number(bash(`${prefix}stat -c %s ${path}`).stdout.trim());
    expect(actualSize).toBeGreaterThan(0);
    size ??= actualSize;
    expect(actualSize).toBe(size);
    expect(bash(`${prefix}test -s ${path}`)).toMatchObject({ status: "completed", exitCode: 0 });
    const probe = JSON.parse(bash(`${prefix}npx remotion ffprobe -v error -show_streams -show_format -of json ${path}`).stdout);
    expect(probe.format).toMatchObject({ filename: file, duration: `${seconds}.000000`, size: String(size) });
    expect(probe.streams).toHaveLength(1);
    expect(probe.streams[0]).toMatchObject({ codec_name: "h264", codec_type: "video", width: draft ? 960 : 1920, height: draft ? 540 : 1080, duration: `${seconds}.000000`, r_frame_rate: "30/1", nb_frames: String(seconds * 30) });
    expect(bash(`${prefix}npx remotion ffprobe -v error -show_entries stream=codec_name,codec_type,width,height,duration:format=duration -of default=nw=1 ${path}`).stdout).toBe(`codec_name=h264\ncodec_type=video\nwidth=${draft ? 960 : 1920}\nheight=${draft ? 540 : 1080}\nduration=${seconds}.000000\nduration=${seconds}.000000\n`);
  }
  if (seconds === 120 && !draft) {
    // A healthy full MP4 does not excuse skipping the required draft/approval.
    expect(previewEvidence(events, seconds).draftWithoutPreview).toBe(false);
    expect(previewEvidence(events, seconds).questionAfterDraft).toBe(false);
    call("set_session_preview", { path: `${project}/out/key-2400.jpg` });
    expect(previewEvidence(events, seconds).publishedAfterFinal).toBe(true);
    expect(previewEvidence(events, seconds).draftWithoutPreview).toBe(false);
  }
});
