import type { EveEvalStreamEvent } from "eve/evals";
import { parseSandboxLinks, resolveSandboxFilePath } from "../../lib/media/sandbox-path";
import { isFullRender } from "../video/observations";

export interface VideoPresentationContract {
  path: string;
  seconds: number;
  width: number;
  height: number;
  render: RegExp;
  size: RegExp;
  nonempty: RegExp;
  probe: RegExp;
  requiredEdit?: { path: string; content: string };
}

interface FinalPreviewContract extends VideoPresentationContract {
  previewPath: string;
  previewSizeBytes: number;
  stillRegExp: RegExp;
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function matchesMetadata(stdout: unknown, expected: VideoPresentationContract): boolean {
  if (typeof stdout !== "string") return false;
  try {
    const data: unknown = JSON.parse(stdout);
    if (!record(data) || !Array.isArray(data.streams) || data.streams.some(stream => record(stream) && stream.codec_type === "audio")) return false;
    return data.streams.some(stream => {
      if (!record(stream) || stream.codec_name !== "h264" || (stream.codec_type !== undefined && stream.codec_type !== "video")) return false;
      const duration = stream.duration === "N/A" || stream.duration === undefined
        ? record(data.format) ? data.format.duration : undefined
        : stream.duration;
      return stream.width === expected.width && stream.height === expected.height &&
        Math.abs(Number(duration) - expected.seconds) <= 1 / 30;
    });
  } catch {
    const fields = stdout.split("\n").map(line => line.split("="));
    const value = (key: string) => fields.find(([name]) => name === key)?.[1];
    const duration = fields.filter(([key]) => key === "duration").map(([, item]) => Number(item)).find(Number.isFinite);
    return !fields.some(([key, item]) => key === "codec_type" && item === "audio") &&
      value("codec_name") === "h264" && value("codec_type") === "video" &&
      Number(value("width")) === expected.width && Number(value("height")) === expected.height &&
      duration !== undefined && Math.abs(duration - expected.seconds) <= 1 / 30;
  }
}

/** The playable message must precede the exact call that opened this native input. */
export function verifiedVideoLinkBeforeQuestion(
  events: readonly EveEvalStreamEvent[],
  expected: VideoPresentationContract,
  requestId: string,
): boolean {
  const input = events.flatMap(event => event.type === "input.requested" ? event.data.requests : [])
    .find(request => request.requestId === requestId);
  const questionCallId = input?.action?.callId;
  if (!questionCallId) return false;
  const questionIndex = events.findIndex(event => event.type === "actions.requested" &&
    event.data.actions.some(action => action.kind === "tool-call" && action.toolName === "ask_question" && action.callId === questionCallId));
  return questionIndex >= 0 && videoEvidence(events.slice(0, questionIndex + 1), expected).presented;
}

function videoEvidence(events: readonly EveEvalStreamEvent[], expected: VideoPresentationContract) {
  type Operation = "edit" | "render" | "size" | "nonempty" | "probe" | null;
  const calls = new Map<string, { operation: Operation; generation: number; ready: boolean; sourceReady: boolean }>();
  const pending = new Set<string>();
  let generation = 0;
  let rendered = false;
  let overlapping = false;
  let sized = false;
  let probed = false;
  let linked = false;
  let edited = expected.requiredEdit === undefined;
  for (const event of events) {
    if (event.type === "actions.requested") {
      for (const action of event.data.actions) {
        if (action.kind !== "tool-call" || action.toolName !== "edit_file" || !expected.requiredEdit || typeof action.input.filePath !== "string") continue;
        const path = resolveSandboxFilePath(action.input.filePath);
        if (path.kind !== "file" || path.path !== expected.requiredEdit.path) continue;
        generation++;
        edited = rendered = sized = probed = linked = false;
        calls.set(action.callId, { operation: "edit", generation, sourceReady: false,
          ready: action.input.newString === expected.requiredEdit.content && !action.input.oldString });
      }
      const writers = event.data.actions.filter(action => action.kind === "tool-call" &&
        action.toolName === "bash" && isFullRender(action.input.command));
      if (writers.length > 0) {
        generation++;
        rendered = sized = probed = linked = false;
        overlapping = pending.size > 0 || writers.length > 1;
        writers.forEach(action => pending.add(action.callId));
      }
      for (const action of event.data.actions) {
        if (action.kind !== "tool-call") continue;
        if (action.toolName !== "bash" || typeof action.input.command !== "string") continue;
        const command = action.input.command;
        const operation: Operation = expected.render.test(command) ? "render"
          : expected.size.test(command) ? "size" : expected.nonempty.test(command) ? "nonempty"
            : expected.probe.test(command) ? "probe" : null;
        calls.set(action.callId, { operation, generation, ready: rendered, sourceReady: edited });
      }
    }
    if (event.type === "message.completed" && rendered && sized && probed) {
      linked ||= parseSandboxLinks(event.data.message, { includeUnusedDefinitions: false })
        .some(link => link.kind === "file" && link.path === expected.path);
    }
    if (event.type !== "action.result" || event.data.result.kind !== "tool-result") continue;
    const callId = event.data.result.callId;
    const call = calls.get(callId);
    const output = event.data.result.output;
    const running = event.data.status === "completed" && record(output) && output.status === "running";
    if (!running) pending.delete(callId);
    if (!call || call.generation !== generation) continue;
    if (call.operation === "edit") {
      edited = call.ready && event.data.status === "completed" && record(output) &&
        output.path === expected.requiredEdit?.path && output.newContent === expected.requiredEdit?.content;
      continue;
    }
    if (event.data.status !== "completed" || !record(output) || output.status !== "completed" || output.exitCode !== 0) continue;
    if (call.operation === "render") rendered = call.sourceReady && !overlapping && pending.size === 0;
    if (!call.ready) continue;
    if (call.operation === "nonempty" || (call.operation === "size" && typeof output.stdout === "string" && /^\s*[1-9]\d*\s*$/.test(output.stdout))) sized = true;
    if (call.operation === "probe" && matchesMetadata(output.stdout, expected)) probed = true;
  }
  const verified = rendered && sized && probed;
  return { verified, presented: verified && linked };
}

/** A final is verified before its still, published successfully, then linked in a message. */
export function verifiedFinalPreview(events: readonly EveEvalStreamEvent[], expected: FinalPreviewContract): boolean {
  const calls = new Map<string, { operation: "still" | "publish"; generation: number; ready: boolean }>();
  const pendingStills = new Set<string>();
  let generation = 0;
  let overlappingStills = false;
  let stillReady = false;
  let published = false;
  let linked = false;
  for (const [index, event] of events.entries()) {
    if (event.type === "actions.requested") {
      const writesVideo = event.data.actions.some(action => action.kind === "tool-call" &&
        action.toolName === "bash" && isFullRender(action.input.command));
      const stills = event.data.actions.filter(action => action.kind === "tool-call" &&
        action.toolName === "bash" && typeof action.input.command === "string" && /\bremotion\s+still\b/.test(action.input.command));
      if (writesVideo || stills.length > 0) {
        generation++;
        stillReady = published = linked = false;
        overlappingStills = pendingStills.size > 0 || stills.length > 1;
        stills.forEach(action => pendingStills.add(action.callId));
      }
      for (const action of event.data.actions) {
        if (action.kind !== "tool-call") continue;
        if (action.toolName === "bash" && typeof action.input.command === "string" && expected.stillRegExp.test(action.input.command)) {
          calls.set(action.callId, { operation: "still", generation, ready: !overlappingStills && !writesVideo &&
            videoEvidence(events.slice(0, index + 1), expected).verified });
        }
        if (action.toolName === "set_session_preview") {
          published = linked = false;
          const path = typeof action.input.path === "string" ? resolveSandboxFilePath(action.input.path) : undefined;
          calls.set(action.callId, { operation: "publish", generation,
            ready: stillReady && !overlappingStills && pendingStills.size === 0 && path?.kind === "file" && path.path === expected.previewPath });
        }
      }
    }
    if (event.type === "action.result" && event.data.result.kind === "tool-result") {
      const call = calls.get(event.data.result.callId);
      const output = event.data.result.output;
      const running = event.data.status === "completed" && record(output) && output.status === "running";
      if (!running) pendingStills.delete(event.data.result.callId);
      if (!call || call.generation !== generation || event.data.status !== "completed" || !record(output)) continue;
      if (call.operation === "still") stillReady = call.ready && !overlappingStills && pendingStills.size === 0 &&
        output.status === "completed" && output.exitCode === 0;
      if (call.operation === "publish") {
        const path = typeof output.path === "string" ? resolveSandboxFilePath(output.path) : undefined;
        published = call.ready && path?.kind === "file" && path.path === expected.previewPath &&
          output.contentType === "image/jpeg" && output.size === expected.previewSizeBytes;
      }
    }
    if (event.type === "message.completed" && published) linked ||= parseSandboxLinks(event.data.message, { includeUnusedDefinitions: false })
      .some(link => link.kind === "file" && link.path === expected.path);
  }
  return published && linked && pendingStills.size === 0 && videoEvidence(events, expected).verified;
}
