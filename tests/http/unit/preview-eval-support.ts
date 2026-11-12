import type { EveEvalContext, EveEvalStreamEvent, ToolStub } from "eve/evals";
import { parseToolStubs } from "../../../node_modules/eve/dist/src/tool-stubs/rules.js";
import { StubPlayback } from "../../../node_modules/eve/dist/src/tool-stubs/playback.js";
import { previewSession } from "../../../evals/preview/fixtures";
import { frameName, frameNumbers, projectPath } from "../../../evals/preview/commands";

export const event = (type: string, data: unknown) => ({ type, data }) as EveEvalStreamEvent;
export async function previewHistory(seconds = 30) {
  let stubs: readonly ToolStub[] = [];
  await previewSession({ target: { async fetch(path: string) {
    return path === "/api/health" ? new Response(null, { headers: { "x-studio-eval-runtime": "stub" } })
      : Response.json({ tools: { static: ["bash", "read_file", "edit_file", "agent", "ask_question", "speak", "list_voices", "download_video", "read_page", "web_search", "set_session_preview"].map(name => ({ name })), dynamic: [] } });
  } }, session: async (options: { stubs: readonly ToolStub[] }) => { stubs = options.stubs; return {}; } } as unknown as EveEvalContext, seconds);
  const playback = new StubPlayback(parseToolStubs(stubs));
  const events: EveEvalStreamEvent[] = [];
  let sequence = 0;
  function request(tool: string, input: Record<string, unknown>) {
    const callId = `unit-${sequence++}`;
    const at = events.length;
    events.push(event("actions.requested", { sequence: at, stepIndex: at, turnId: "turn_0", actions: [{ kind: "tool-call", callId, toolName: tool, input }] }));
    const answer = playback.call({ callId, tool, input });
    if (answer.kind !== "stub") throw new Error(`Live tool escaped: ${tool}`);
    const failed = "throw" in answer.outcome;
    const output = failed ? answer.outcome.throw!.message : answer.outcome.response;
    return { callId, at, tool, failed, output, ruleId: answer.ruleId };
  }
  function complete(call: ReturnType<typeof request>, override?: { output?: unknown; status?: "completed" | "failed" }) {
    events.push(event("action.result", { status: override?.status ?? (call.failed ? "failed" : "completed"),
      result: { kind: "tool-result", callId: call.callId, toolName: call.tool, output: override?.output ?? call.output } }));
    return call;
  }
  const call = (tool: string, input: Record<string, unknown>) => complete(request(tool, input));
  const bash = (command: string) => call("bash", { command });
  const framesCommand = `npx remotion render src/index.tsx Main out/frames-1 --props=props-${seconds}.json --frames=${frameNumbers(seconds).join(",")} --image-format=jpeg --jpeg-quality=90`;
  const pixelCommand = 'python3 "$HOME/.agents/skills/frame-review/scripts/check-frames.py" out/frames-1/*.jpeg';
  const readFrames = () => frameNumbers(seconds).map(frame => call("read_file", { filePath: `${projectPath(seconds)}/out/frames-1/${frameName(frame)}` }));
  function review(fresh = false) { if (fresh) bash(framesCommand); bash(pixelCommand); readFrames(); }
  const renderCommand = (draft = seconds > 60) => `npx remotion render src/index.tsx Main out/${draft ? "draft" : "final"}.mp4 --props=props-${seconds}.json${draft ? " --scale=0.5 --x264-preset=superfast --crf=32" : ""}`;
  const render = (draft = seconds > 60) => bash(renderCommand(draft));
  function inspect(draft = seconds > 60) {
    const file = `out/${draft ? "draft" : "final"}.mp4`;
    bash(`stat -c %s ${file}`);
    bash(`npx remotion ffprobe -v error -show_streams -show_format -of json ${file}`);
  }
  const stillCommand = (frame = frameNumbers(seconds)[4], destination = "out/preview.jpg") => `npx remotion still src/index.tsx Main ${destination} --props=props-${seconds}.json --frame=${frame} --image-format=jpeg --jpeg-quality=85 --scale=0.5`;
  const still = (frame?: number, destination?: string) => bash(stillCommand(frame, destination));
  const publish = (destination = "out/preview.jpg") => call("set_session_preview", { path: `${projectPath(seconds)}/${destination}` });
  const message = (message: string) => events.push(event("message.completed", { message, sequence: 0, stepIndex: 0, turnId: "turn_0" }));
  return { stubs, events, request, complete, call, bash, framesCommand, pixelCommand, readFrames, review, renderCommand, render, inspect, stillCommand, still, publish, message };
}
