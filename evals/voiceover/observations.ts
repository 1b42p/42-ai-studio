import { posix } from "node:path";
import type { EveEvalStreamEvent } from "eve/evals";
import { isFullRender } from "../video/observations";
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
    const hasExpectedStreams =
      stdout.includes("codec_type=video") &&
      stdout.includes("codec_type=audio") &&
      stdout.includes(`width=${target.width}`) &&
      stdout.includes(`height=${target.height}`);
    if (!hasExpectedStreams) {
      return false;
    }

    const durations = [...stdout.matchAll(/^duration=([\d.]+)$/gmu)].map(
      (match) => Number(match[1]) * 1000,
    );
    [videoDuration, audioDuration] = durations;
  }
  const hasExpectedDuration = Math.abs(videoDuration - target.durationMs) <= 34;
  const audioMatchesVideo = Math.abs(audioDuration - videoDuration) <= 100;
  return hasExpectedDuration && audioMatchesVideo;
}

function confirmsNonemptyVideo(
  command: string,
  stdout: string,
  target: EvidenceTarget,
): boolean {
  const argument = String.raw`("[^"]+"|'[^']+'|[^\s"';&|<>]+)`;
  const operation = [
    String.raw`test\s+-s`,
    String.raw`stat(?:\s+(?:-c\s*|--format(?:=|\s+))["']?(?:%s(?: bytes)?|%n %s bytes)["']?)?`,
    String.raw`wc\s+(?:-c|--bytes)(?:\s*<)?`,
  ].join("|");
  const check = new RegExp(
    String.raw`^\s*(?:cd\s+${argument}\s*&&\s*)?` +
      String.raw`(?:ls\s+-l\s+${argument}\s*&&\s*)?(${operation})` +
      String.raw`\s+(?:--\s+)?${argument}` +
      String.raw`(?:\s*&&\s*(?:npx\s+)?remotion\s+ffprobe\s+[^;&\n]*)?\s*$`,
    "u",
  ).exec(command);
  if (!check) {
    return false;
  }

  const unquote = (value: string) => value.replace(/^["']|["']$/gu, "");
  const cwd = check[1]
    ? posix.resolve("/workspace", unquote(check[1]))
    : "/workspace";
  const path = posix.resolve(cwd, unquote(check[4]));
  if (path !== posix.resolve("/workspace", target.video)) {
    return false;
  }
  if (check[2] && posix.resolve(cwd, unquote(check[2])) !== path) {
    return false;
  }

  if (check[3].startsWith("test")) {
    return true;
  }

  const output = stdout.trim();
  const size = check[3].startsWith("wc")
    ? /^(\d+)(?:[\t ]+(.+))?$/u.exec(output)
    : (/^([0-9]+)$/mu.exec(output) ??
      /(?:^|\s)(\d+)\s+bytes$/u.exec(output) ??
      /\bSize:\s*(\d+)\b/u.exec(output));
  if (!size || !Number.isSafeInteger(Number(size[1])) || Number(size[1]) <= 0) {
    return false;
  }

  // wc может вернуть и имя файла; оно должно указывать на тот же результат.
  return !size[2] || posix.resolve(cwd, unquote(size[2])) === path;
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

  if (
    request.fileSizeReady &&
    confirmsNonemptyVideo(command, output.stdout, target)
  ) {
    state.nonemptyVideo = true;
  }

  const isVideoProbe =
    /\bffprobe\b/u.test(command) &&
    command.includes(videoName) &&
    request.probeReady &&
    validProbe(output.stdout, target);
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
