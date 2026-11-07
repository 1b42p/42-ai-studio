import { posix } from "node:path";
import type { EveEvalStreamEvent } from "eve/evals";
import { isFullRender } from "../video/observations";
import { inspectVideoFile } from "./file-inspection";
import {
  sceneTimingsAfterSynthesis,
  type ObservedCall,
  type ObservedCallResult,
} from "./piper-observations";

export {
  piperOutputPaths,
  piperScenes,
  sceneTimingsAfterSynthesis,
} from "./piper-observations";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface EvidenceTarget {
  frames: readonly string[];
  video: string;
  width: number;
  height: number;
  durationMs: number;
}

interface EvidenceRequest extends ObservedCall {
  revision: number;
  synthesisReady: boolean;
  viewReady: boolean;
  renderReady: boolean;
  fileSizeReady: boolean;
  probeReady: boolean;
}

interface EvidenceState {
  renderedFrames: Set<string>;
  checkedPixels: Set<string>;
  viewedFrames: Set<string>;
  pendingSynthesis: Set<string>;
  synthesisStep: Pick<
    RequestedActionsEvent["data"],
    "turnId" | "stepIndex" | "sequence"
  > | null;
  revision: number;
  renderedVideo: boolean;
  nonemptyVideo: boolean;
  probedVideo: boolean;
  history: ObservedCallResult[];
  requests: Map<string, EvidenceRequest>;
}

type RequestedActionsEvent = Extract<
  EveEvalStreamEvent,
  { type: "actions.requested" }
>;

function validProbe(stdout: string, target: EvidenceTarget): boolean {
  let videoDuration: number;
  let audioDuration: number;
  try {
    const probe: unknown = JSON.parse(stdout);
    if (!record(probe) || !Array.isArray(probe.streams)) {
      return false;
    }
    const video = probe.streams.find(
      (stream) => record(stream) && stream.codec_type === "video",
    );
    const audio = probe.streams.find(
      (stream) => record(stream) && stream.codec_type === "audio",
    );
    if (
      !record(video) ||
      !record(audio) ||
      video.width !== target.width ||
      video.height !== target.height
    ) {
      return false;
    }
    videoDuration = Number(video.duration) * 1000;
    audioDuration = Number(audio.duration) * 1000;
  } catch {
    const streams: Record<string, string>[] = [];
    let current: Record<string, string> | null = null;
    for (const line of stdout.split("\n")) {
      const field = /^(codec_type|width|height|duration)=(.+)$/u.exec(line);
      if (!field) {
        continue;
      }
      const [, key, value] = field;
      if (key === "codec_type") {
        current = { codec_type: value };
        streams.push(current);
      } else if (current && !(key in current)) {
        current[key] = value;
      }
    }
    const video = streams.find((stream) => stream.codec_type === "video");
    const audio = streams.find((stream) => stream.codec_type === "audio");
    if (
      !video ||
      !audio ||
      Number(video.width) !== target.width ||
      Number(video.height) !== target.height
    ) {
      return false;
    }
    videoDuration = Number(video.duration) * 1000;
    audioDuration = Number(audio.duration) * 1000;
  }
  const hasExpectedDuration = Math.abs(videoDuration - target.durationMs) <= 34;
  const audioMatchesVideo = Math.abs(audioDuration - videoDuration) <= 100;
  return hasExpectedDuration && audioMatchesVideo;
}

function isSynthesisRequest(
  name: string,
  input: ObservedCall["input"],
): boolean {
  return (
    name === "speak" ||
    (name === "bash" &&
      typeof input.command === "string" &&
      input.command.includes("piper_speak.py"))
  );
}

function beginSynthesis(
  state: EvidenceState,
  step: RequestedActionsEvent["data"],
  callId: string,
): void {
  const startsNewStep =
    state.synthesisStep?.turnId !== step.turnId ||
    state.synthesisStep?.stepIndex !== step.stepIndex ||
    state.synthesisStep?.sequence !== step.sequence;
  if (startsNewStep) {
    state.synthesisStep = step;
    state.revision += 1;
    state.pendingSynthesis.clear();
    state.renderedFrames.clear();
    state.checkedPixels.clear();
    state.viewedFrames.clear();
    state.renderedVideo = false;
    state.nonemptyVideo = false;
    state.probedVideo = false;
  }
  state.pendingSynthesis.add(callId);
}

function recordRequestedActions(
  event: RequestedActionsEvent,
  state: EvidenceState,
  target: EvidenceTarget,
): void {
  // Один шаг синтеза может поступить несколькими событиями actions.requested.
  // Сначала сбрасываем доказательства, затем фиксируем готовность запросов.
  for (const action of event.data.actions) {
    if (
      action.kind === "tool-call" &&
      isSynthesisRequest(action.toolName, action.input)
    ) {
      beginSynthesis(state, event.data, action.callId);
    }
  }

  for (const action of event.data.actions) {
    if (action.kind !== "tool-call") {
      continue;
    }

    const synthesisReady =
      state.pendingSynthesis.size === 0 &&
      sceneTimingsAfterSynthesis(state.history).length === 3;
    state.requests.set(action.callId, {
      name: action.toolName,
      input: action.input,
      status: "pending",
      revision: state.revision,
      synthesisReady,
      viewReady:
        action.toolName === "read_file" &&
        typeof action.input.filePath === "string" &&
        state.renderedFrames.has(
          posix.resolve("/workspace", action.input.filePath),
        ) &&
        state.checkedPixels.has(
          posix.resolve("/workspace", action.input.filePath),
        ),
      renderReady:
        target.frames.every((path) => state.viewedFrames.has(path)) &&
        synthesisReady,
      fileSizeReady: state.renderedVideo,
      probeReady: state.renderedVideo,
    });
  }
}

function recordViewedFrame(
  request: EvidenceRequest,
  output: Record<string, unknown>,
  state: EvidenceState,
): void {
  if (
    request.name !== "read_file" ||
    !request.viewReady ||
    typeof request.input.filePath !== "string" ||
    typeof output.path !== "string" ||
    output.path !== posix.resolve("/workspace", request.input.filePath) ||
    !record(output.file) ||
    output.file.mediaType !== "image/jpeg"
  ) {
    return;
  }

  const isCheckedFrame =
    state.renderedFrames.has(output.path) &&
    state.checkedPixels.has(output.path);
  if (isCheckedFrame) {
    state.viewedFrames.add(output.path);
  }
}

function recordCheckedPixels(stdout: string, state: EvidenceState): void {
  for (const line of stdout.split("\n")) {
    try {
      const checked: unknown = JSON.parse(line);
      if (
        record(checked) &&
        typeof checked.path === "string" &&
        checked.suspect === null &&
        state.renderedFrames.has(checked.path)
      ) {
        state.checkedPixels.add(checked.path);
      }
    } catch {
      continue;
    }
  }
}

function recordCompletedEvidence(
  request: EvidenceRequest,
  output: Record<string, unknown>,
  state: EvidenceState,
  target: EvidenceTarget,
): void {
  recordViewedFrame(request, output, state);

  if (
    request.name !== "bash" ||
    output.exitCode !== 0 ||
    typeof output.stdout !== "string" ||
    typeof request.input.command !== "string"
  ) {
    return;
  }

  const command = request.input.command;
  const videoName = `out/${posix.basename(target.video)}`;
  const isFrameRender =
    request.synthesisReady &&
    /\bremotion\s+(?:render|still)\b/u.test(command) &&
    !isFullRender(command);
  if (isFrameRender) {
    for (const path of target.frames) {
      if (output.stdout.includes(path)) {
        state.renderedFrames.add(path);
      }
    }
  }

  if (command.includes("check-frames.py")) {
    recordCheckedPixels(output.stdout, state);
  }

  const isRenderedVideo =
    isFullRender(command) &&
    request.renderReady &&
    command.includes(videoName) &&
    output.stdout.includes(videoName);
  if (isRenderedVideo) {
    state.renderedVideo = true;
  }

  const inspection = inspectVideoFile(command, output.stdout, target.video);
  if (request.fileSizeReady && inspection.nonempty) {
    state.nonemptyVideo = true;
  }

  const isVideoProbe =
    inspection.probeStdout !== null &&
    request.probeReady &&
    validProbe(inspection.probeStdout, target);
  if (isVideoProbe) {
    state.probedVideo = true;
  }
}

/** Доказательства в порядке завершения действий, а не только наличия запросов. */
export function voiceoverEvidence(
  events: readonly EveEvalStreamEvent[],
  target: EvidenceTarget,
) {
  const state: EvidenceState = {
    renderedFrames: new Set(),
    checkedPixels: new Set(),
    viewedFrames: new Set(),
    pendingSynthesis: new Set(),
    synthesisStep: null,
    revision: 0,
    renderedVideo: false,
    nonemptyVideo: false,
    probedVideo: false,
    history: [],
    requests: new Map(),
  };

  for (const event of events) {
    if (event.type === "actions.requested") {
      recordRequestedActions(event, state, target);
    }

    if (
      event.type !== "action.result" ||
      event.data.result.kind !== "tool-result"
    ) {
      continue;
    }

    const request = state.requests.get(event.data.result.callId);
    if (!request) {
      continue;
    }

    state.pendingSynthesis.delete(event.data.result.callId);
    if (request.revision !== state.revision) {
      continue;
    }
    const output = event.data.result.output;
    state.history.push({
      ...request,
      output,
      status: event.data.status === "completed" ? "completed" : "failed",
    });

    const isCurrentCompletedResult =
      event.data.status === "completed" && request.revision === state.revision;
    if (!isCurrentCompletedResult || !record(output)) {
      continue;
    }

    recordCompletedEvidence(request, output, state, target);
  }

  return {
    frameRender: target.frames.every((path) => state.renderedFrames.has(path)),
    pixels: target.frames.every((path) => state.checkedPixels.has(path)),
    views: target.frames.every((path) => state.viewedFrames.has(path)),
    fullRender: state.renderedVideo,
    fileSize: state.nonemptyVideo,
    probe: state.probedVideo,
  };
}
