/** Карточка скачивания проходит через события и штатный reducer беседы eve. */
import type { MessageStreamEvent } from "eve/client";
import { conversationReducer, type ConversationState } from "eve/react";

import { event } from "./events";

const HOST = `${"очень-длинный-хост".repeat(4)}.example.com`;
const TITLE = "А".repeat(300);

export interface DownloadScenario {
  readonly name: "running" | "ready" | "skipped" | "error" | "unavailable";
}

function frames(count: number, missing = false) {
  return Array.from({ length: count }, (_, index) => ({
    path: `/workspace/downloads/abc/frames/frame-${String(index).padStart(4, "0")}.00.jpg`,
    momentSec: index,
    mediaId: missing ? null : `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
  }));
}

function outputFor(name: DownloadScenario["name"]) {
  if (name === "error" || name === "running") return undefined;
  const count = name === "ready" ? 12 : 1;
  return {
    videoPath: "/workspace/downloads/abc/video.mp4",
    title: TITLE,
    sourceUrl: `https://${HOST}/watch?v=zoo`,
    durationSec: 19.01,
    width: 1920,
    height: 1080,
    sizeBytes: name === "ready" ? 734_003_200 : 2048,
    videoCodec: "h264",
    frames: frames(count, name === "unavailable"),
    skippedMoments: name === "skipped" ? [{ momentSec: 99, reason: "after_end" }] : [],
  };
}

export function downloadConversation(scenario: DownloadScenario): {
  data: ConversationState;
  events: MessageStreamEvent[];
  status: "ready" | "streaming";
} {
  const output = outputFor(scenario.name);
  const events = [
    event("session.started", {}),
    event("turn.started", { turnId: "turn_0", sequence: 0 }),
    event("message.received", {
      message: "Возьми кадры из ролика",
      parts: [{ text: "Возьми кадры из ролика", type: "text" }],
      sequence: 0,
      turnId: "turn_0",
    }),
    event("step.started", { modelId: "eve-mock/model", sequence: 0, stepIndex: 0, turnId: "turn_0" }),
    event("actions.requested", {
      actions: [{
        callId: "call_download",
        input: { url: `https://${HOST}/watch?v=zoo`, moments: [0, 1] },
        kind: "tool-call",
        toolName: "download_video",
      }],
      presentation: { call_download: { label: `Скачивание видео: ${HOST}` } },
      sequence: 0,
      stepIndex: 0,
      turnId: "turn_0",
    }),
  ];
  if (scenario.name === "running") {
    events.push(event("action.partial", {
      result: {
        callId: "call_download",
        kind: "tool-result",
        output: { phase: "Скачиваю" },
        toolName: "download_video",
      },
      sequence: 0,
      stepIndex: 0,
      turnId: "turn_0",
    }));
  } else {
    const error = scenario.name === "error"
      ? "download_unavailable: Видео недоступно: оно удалено, скрыто или закрыто автором."
      : undefined;
    events.push(
      event("action.result", {
        result: {
          callId: "call_download",
          kind: "tool-result",
          output: error ?? output,
          isError: error !== undefined,
          toolName: "download_video",
        },
        sequence: 0,
        status: error === undefined ? "completed" : "failed",
        stepIndex: 0,
        turnId: "turn_0",
      }),
      event("step.completed", {
        finishReason: "stop", sequence: 0, stepIndex: 0, turnId: "turn_0",
        usage: { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 10, outputTokens: 2 },
      }),
      event("turn.completed", { sequence: 0, turnId: "turn_0" }),
      event("session.waiting", {
        continuationToken: "wrun_fixture", wait: "next-user-message",
        usage: { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 10, outputTokens: 2 },
      }),
    );
  }
  return {
    data: events.reduce<ConversationState>(
      (state, item) => conversationReducer.reduce(state, item),
      conversationReducer.initial(),
    ),
    events,
    status: scenario.name === "running" ? "streaming" : "ready",
  };
}
