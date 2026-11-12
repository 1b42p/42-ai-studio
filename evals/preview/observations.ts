import { posix } from "node:path";
import type { EveEvalStreamEvent } from "eve/evals";
import { frameName, frameNumbers, framesPattern, isPixelCommand, matchesCommand, nonemptyPattern, pathArg, probePattern, projectPath, sizePattern, stillSelection, videoLinkPattern, videoPattern } from "./commands";
import { currentReviewFrames, knownImage, previewFrames } from "./media-fixture";

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
export function workspaceJpeg(value: unknown): string | null {
  if (typeof value !== "string" || !/\.jpe?g$/i.test(value) || /[\\:\x00-\x1f?#%]/.test(value) || value.split("/").includes("..")) return null;
  const path = posix.resolve("/workspace", value);
  return path.startsWith("/workspace/") ? path : null;
}

/** Pixel inspection and actual model image reads must complete before rendering. */
export function reviewedBeforeVideo(events: readonly EveEvalStreamEvent[], seconds: number): boolean {
  const paths = frameNumbers(seconds).map(frame => `${projectPath(seconds)}/out/frames-1/${frameName(frame)}`);
  const checked = new Set<string>();
  const viewed = new Set<string>();
  const requests = new Map<string, { name: string; input: Record<string, unknown>; rendered: boolean; ready: boolean; generation: number; frames: boolean }>();
  let rendered = currentReviewFrames(seconds).length === paths.length;
  let result = false;
  let generation = 0;
  let frameFailure = false;
  const pendingFrames = new Set<string>();
  for (const event of events) {
    if (event.type === "actions.requested") {
      const writers = event.data.actions.filter(action => action.kind === "tool-call" && action.toolName === "bash" && matchesCommand(framesPattern(seconds), action.input.command));
      if (writers.length) {
        generation++; rendered = false; result = false; frameFailure = false;
        checked.clear(); viewed.clear(); pendingFrames.clear();
        writers.forEach(action => pendingFrames.add(action.callId));
      }
      for (const action of event.data.actions) {
        if (action.kind !== "tool-call") continue;
        requests.set(action.callId, { name: action.toolName, input: action.input, rendered,
          generation, frames: pendingFrames.has(action.callId),
          ready: action.toolName === "read_file"
            ? rendered && paths.every(path => checked.has(path))
            : paths.every(path => viewed.has(path)) });
      }
    }
    if (event.type !== "action.result" || event.data.result.kind !== "tool-result") continue;
    const request = requests.get(event.data.result.callId);
    const output = event.data.result.output;
    if (!request || request.generation !== generation) continue;
    if (request.frames) {
      pendingFrames.delete(event.data.result.callId);
      if (event.data.status !== "completed" || !record(output) || output.status !== "completed" || output.exitCode !== 0) frameFailure = true;
      rendered = pendingFrames.size === 0 && !frameFailure;
      continue;
    }
    if (event.data.status !== "completed" || !record(output)) continue;
    if (request.name === "read_file" && request.ready && typeof request.input.filePath === "string") {
      const path = posix.resolve("/workspace", request.input.filePath);
      if (paths.includes(path) && knownImage(output, path)) viewed.add(path);
    }
    if (request.name !== "bash" || output.status !== "completed" || output.exitCode !== 0) continue;
    if (request.rendered && isPixelCommand(request.input.command, seconds) && typeof output.stdout === "string") {
      for (const line of output.stdout.split("\n")) {
        try {
          const row: unknown = JSON.parse(line);
          const frame = record(row) && previewFrames.find(frame => frame.path === row.path);
          if (frame && "extrema" in frame && record(row) && typeof row.path === "string" && paths.includes(row.path) && row.suspect === null && JSON.stringify(row.extrema) === JSON.stringify(frame.extrema)) checked.add(row.path);
        } catch { /* Checker's final human-readable line is not pixel evidence. */ }
      }
    }
    if (matchesCommand(videoPattern(seconds), request.input.command) || matchesCommand(videoPattern(seconds, true), request.input.command)) result = request.ready;
  }
  return result;
}

export function inspectedVideo(events: readonly EveEvalStreamEvent[], seconds: number, draft = seconds > 60): boolean {
  const requests = new Map<string, { name: string; input: Record<string, unknown>; at: number }>();
  let renderedAt = -1;
  let currentRender = -1;
  let size = false;
  let probe = false;
  let previewAt = Infinity;
  for (let at = 0; at < events.length; at++) {
    const event = events[at];
    if (event.type === "actions.requested") for (const action of event.data.actions) {
      if (action.kind !== "tool-call") continue;
      requests.set(action.callId, { name: action.toolName, input: action.input, at });
      if (action.toolName === "set_session_preview") previewAt = Math.min(previewAt, at);
      if (action.toolName === "bash" && matchesCommand(videoPattern(seconds, draft), action.input.command)) {
        currentRender = at; renderedAt = -1; size = false; probe = false;
      }
    }
    if (event.type !== "action.result" || event.data.status !== "completed" || event.data.result.kind !== "tool-result") continue;
    const request = requests.get(event.data.result.callId);
    const output = event.data.result.output;
    if (!request || request.name !== "bash" || !record(output) || output.status !== "completed" || output.exitCode !== 0) continue;
    if (request.at === currentRender && matchesCommand(videoPattern(seconds, draft), request.input.command)) renderedAt = at;
    if (renderedAt < 0 || request.at <= renderedAt || at >= previewAt) continue;
    if (matchesCommand(sizePattern(seconds, draft), request.input.command) && typeof output.stdout === "string" && /^\s*[1-9]\d*\s*$/.test(output.stdout)) size = true;
    if (matchesCommand(nonemptyPattern(seconds, draft), request.input.command)) size = true;
    if (matchesCommand(probePattern(seconds, draft), request.input.command) && typeof output.stdout === "string") {
      try {
        const metadata: unknown = JSON.parse(output.stdout);
        if (!record(metadata) || !Array.isArray(metadata.streams)) continue;
        const video = metadata.streams.find(stream => record(stream) && stream.codec_type === "video");
        probe = record(video) && video.codec_name === "h264" && video.width === (draft ? 960 : 1920) && video.height === (draft ? 540 : 1080) && video.r_frame_rate === "30/1" && Math.abs(Number(video.duration) - seconds) < 0.034 && !metadata.streams.some(stream => record(stream) && stream.codec_type === "audio");
      } catch { /* Invalid metadata cannot prove readiness. */ }
    }
    if (matchesCommand(probePattern(seconds, draft, "selected-default"), request.input.command) && typeof output.stdout === "string") {
      const fields = /^codec_name=h264\ncodec_type=video\nwidth=(\d+)\nheight=(\d+)\nduration=(N\/A|\d+(?:\.\d+)?)\nduration=(\d+(?:\.\d+)?)\n?$/.exec(output.stdout);
      if (fields) {
        const duration = Number(fields[3] === "N/A" ? fields[4] : fields[3]);
        probe = Number(fields[1]) === (draft ? 960 : 1920) && Number(fields[2]) === (draft ? 540 : 1080) && Math.abs(duration - seconds) < 0.034;
      }
    }
  }
  return size && probe;
}

function completedStillFor(events: readonly EveEvalStreamEvent[], seconds: number, path: string | null, finalCompleted: number, previewRequested: number) {
  if (!path || finalCompleted < 0 || previewRequested <= finalCompleted) return false;
  type Write = { at: number; completed: boolean; overlapped: boolean };
  const writes = new Map<string, Write>();
  const pending = new Set<string>();
  let latest: Write | null = null;
  for (let at = 0; at < previewRequested; at++) {
    const event = events[at];
    if (event.type === "actions.requested") for (const action of event.data.actions) {
      if (action.kind === "tool-call" && action.toolName === "bash" && stillSelection(action.input.command, seconds)?.path === path) {
        const overlapped = pending.size > 0;
        for (const callId of pending) writes.get(callId)!.overlapped = true;
        latest = { at, completed: false, overlapped };
        writes.set(action.callId, latest);
        pending.add(action.callId);
      }
    }
    if (event.type !== "action.result" || event.data.result.kind !== "tool-result") continue;
    const write = writes.get(event.data.result.callId);
    if (!write) continue;
    const output = event.data.result.output;
    const running = event.data.status === "completed" && record(output) && output.status === "running";
    if (!running) pending.delete(event.data.result.callId);
    write.completed = event.data.status === "completed" && record(output) && output.status === "completed" && output.exitCode === 0;
  }
  return latest !== null && pending.size === 0 && !latest.overlapped && latest.at > finalCompleted && latest.completed &&
    inspectedVideo(events.slice(0, previewRequested), seconds, false);
}

/** Request positions preserve causality even when parallel calls finish out of order. */
export function previewEvidence(events: readonly EveEvalStreamEvent[], seconds: number) {
  const requests = new Map<string, { name: string; input: Record<string, unknown>; at: number }>();
  let lastRenderRequest = -1;
  let lastDraftRequest = -1;
  let lastDraftCallId: string | null = null;
  const draftTarget = new RegExp(`\\s${pathArg("out/draft.mp4", seconds)}(?:\\s|$)`);
  let finalCompleted = -1;
  let draftCompleted = -1;
  let previewRequested = -1;
  let previewCount = 0;
  let previewCompleted = false;
  let questionRequested = -1;
  let previewPath: string | null = null;
  let draftLinkAt = -1;
  let questionHasPriorLink = false;
  let finalAttempted = false;
  for (let at = 0; at < events.length; at++) {
    const event = events[at];
    if (event.type === "actions.requested") {
      for (const action of event.data.actions) {
        if (action.kind !== "tool-call") continue;
        requests.set(action.callId, { name: action.toolName, input: action.input, at });
        if (action.toolName === "set_session_preview") { previewCount++; previewRequested = at; previewPath = workspaceJpeg(action.input.path); }
        if (action.toolName === "ask_question") {
          questionRequested = at;
          questionHasPriorLink = draftCompleted >= 0 && draftLinkAt > draftCompleted && draftLinkAt < at;
        }
        if (action.toolName === "bash" && typeof action.input.command === "string" && /\bremotion\s+render\b/.test(action.input.command) && !/--frames(?:=|\s)/.test(action.input.command)) {
          lastRenderRequest = at;
          finalCompleted = -1;
          // A final writes a different file: it may violate approval policy,
          // but cannot erase a previously correct draft/question sequence.
          // Any new writer of the draft invalidates its previous proof first,
          // including an unsupported command that ultimately fails.
          if (draftTarget.test(action.input.command)) {
            lastDraftRequest = at;
            lastDraftCallId = action.callId;
            draftCompleted = -1;
            draftLinkAt = -1;
            questionHasPriorLink = false;
          } else {
            finalAttempted = true;
          }
        }
      }
    }
    if (event.type === "message.completed" && draftCompleted >= 0 && typeof event.data.message === "string" &&
      videoLinkPattern(seconds, true).test(event.data.message) && inspectedVideo(events.slice(0, at), seconds, true)) draftLinkAt = at;
    if (event.type !== "action.result" || event.data.status !== "completed" || event.data.result.kind !== "tool-result") continue;
    const request = requests.get(event.data.result.callId);
    const output = event.data.result.output;
    if (!request || !record(output)) continue;
    if (request.name === "set_session_preview") {
      const inputPath = workspaceJpeg(request.input.path);
      previewCompleted = inputPath !== null && inputPath === workspaceJpeg(output.path) && output.contentType === "image/jpeg" && typeof output.size === "number" && output.size > 0 && output.size <= 1048576;
    }
    if (request.name === "bash" && request.at === lastRenderRequest && output.status === "completed" && output.exitCode === 0) {
      if (matchesCommand(videoPattern(seconds), request.input.command)) finalCompleted = at;
    }
    if (request.name === "bash" && event.data.result.callId === lastDraftCallId && output.status === "completed" && output.exitCode === 0 &&
      matchesCommand(videoPattern(seconds, true), request.input.command)) draftCompleted = at;
  }
  return {
    publishedAfterFinal: previewCount === 1 && previewCompleted && finalCompleted >= 0 && previewRequested > finalCompleted,
    stillAfterVerifiedFinal: previewCount === 1 && previewCompleted && completedStillFor(events, seconds, previewPath, finalCompleted, previewRequested),
    draftWithoutPreview: draftCompleted >= 0 && !finalAttempted && lastRenderRequest === lastDraftRequest && previewCount === 0 && finalCompleted === -1,
    questionAfterDraft: draftCompleted >= 0 && questionRequested > draftCompleted,
    draftLinkBeforeQuestion: draftCompleted >= 0 && questionRequested > draftCompleted && questionHasPriorLink,
    finalCompleted,
    draftCompleted,
  };
}
