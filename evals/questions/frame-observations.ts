import type { EveEvalStreamEvent } from "eve/evals";
import { resolveSandboxFilePath } from "../../lib/media/sandbox-path";
import type { QuestionFrame } from "./media-fixture";
import type { VideoPresentationContract } from "./observations";

interface FrameReviewContract {
  render: RegExp;
  pixels: RegExp;
  frames: readonly QuestionFrame[];
}

interface Call {
  action: { toolName: string; input: Record<string, unknown> };
  start: number;
  end: number;
  status?: string;
  output?: unknown;
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const pathOf = (value: unknown) => {
  const path = typeof value === "string" ? resolveSandboxFilePath(value) : undefined;
  return path?.kind === "file" ? path.path : null;
};
const commandOf = (call: Call) => call.action.toolName === "bash" && typeof call.action.input.command === "string"
  ? call.action.input.command : "";
const completedCommand = (call: Call | undefined): call is Call & { output: Record<string, unknown> } =>
  call?.status === "completed" && record(call.output) && call.output.status === "completed" && call.output.exitCode === 0;

/** New props need newly rendered frames, not a preseeded picture of the intended revision. */
export function reviewedRevisionBeforeVideo(
  events: readonly EveEvalStreamEvent[], video: VideoPresentationContract, frames: FrameReviewContract,
): boolean {
  if (!video.requiredEdit) return false;
  const calls = new Map<string, Call>();
  for (const [index, event] of events.entries()) {
    if (event.type === "actions.requested") for (const action of event.data.actions) {
      if (action.kind === "tool-call") calls.set(action.callId, { action, start: index, end: Infinity });
    }
    if (event.type === "action.result" && event.data.result.kind === "tool-result") {
      const call = calls.get(event.data.result.callId);
      if (call) Object.assign(call, { end: index, status: event.data.status, output: event.data.result.output });
    }
  }
  const ordered = [...calls.values()];
  const render = ordered.findLast(call => video.render.test(commandOf(call)));
  if (!render) return false;
  const beforeVideo = ordered.filter(call => call.start < render.start);
  const edit = beforeVideo.findLast(call => call.action.toolName === "edit_file" &&
    pathOf(call.action.input.filePath) === video.requiredEdit!.path);
  if (!edit || edit.status !== "completed" || !record(edit.output) ||
    edit.action.input.newString !== video.requiredEdit.content || edit.action.input.oldString ||
    edit.output.path !== video.requiredEdit.path || edit.output.newContent !== video.requiredEdit.content) return false;
  const frameRender = ordered.findLast(call => call.start <= render.start &&
    /\bremotion\s+render\b/.test(commandOf(call)) && /--frames(?:=|\s)/.test(commandOf(call)));
  if (!completedCommand(frameRender) || !frames.render.test(commandOf(frameRender)) ||
    frameRender.start <= edit.end || frameRender.start >= render.start) return false;
  if (beforeVideo.some(call => call !== frameRender && /\bremotion\s+render\b/.test(commandOf(call)) &&
    /--frames(?:=|\s)/.test(commandOf(call)) &&
    (call.end >= frameRender.start || (record(call.output) && call.output.status === "running")))) return false;
  const pixels = beforeVideo.findLast(call => frames.pixels.test(commandOf(call)));
  if (!completedCommand(pixels) || pixels.start <= frameRender.end || pixels.end >= render.start || typeof pixels.output.stdout !== "string") return false;
  const reports = pixels.output.stdout.split("\n").flatMap(line => {
    try { const row: unknown = JSON.parse(line); return record(row) ? [row] : []; }
    catch { return []; }
  });
  return frames.frames.every(frame => {
    if (!reports.some(row => row.path === frame.path && row.suspect === null && JSON.stringify(row.extrema) === JSON.stringify(frame.extrema))) return false;
    return beforeVideo.some(call => {
      if (call.action.toolName !== "read_file" || pathOf(call.action.input.filePath) !== frame.path ||
        call.start <= pixels.end || call.end >= render.start || call.status !== "completed" || !record(call.output)) return false;
      const image = call.output.file;
      return call.output.path === frame.path && record(image) && image.mediaType === "image/jpeg" &&
        image.width === frame.width && image.height === frame.height && image.size === frame.size;
    });
  });
}
