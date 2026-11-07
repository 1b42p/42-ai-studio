import { Client, type ClientSession } from "eve/client";
import type { EveEvalContext, EveEvalStreamEvent, ToolStub } from "eve/evals";
import { afterAll, beforeAll, expect, test } from "vitest";

import fixture from "../../evals/fixtures/voiceover/project.json";
import {
  FRAME_NAMES,
  framePaths,
  PROJECT,
  REVIEW_FRAMES,
  SCENES,
  VOICE,
  voiceoverSession,
} from "../../evals/voiceover/fixtures";
import { voiceoverEvidence } from "../../evals/voiceover/observations";
import { loadConfig } from "../../lib/config";
import { startEveDev, type EveDevServer } from "./support/eve-dev";
import { fakeSandbox } from "./support/fake-sandbox";

let eve: EveDevServer;
let client: Client;
const histories = new WeakMap<ClientSession, EveEvalStreamEvent[]>();

beforeAll(async () => {
  eve = await startEveDev({
    APP_STUB_EVAL_SANDBOX: "1",
    EVE_DEV_STATE_DIR: `.tmp/eve-voiceover-contract-${process.pid}`,
  });
  client = new Client({
    host: eve.url,
    auth: { bearer: loadConfig().eveEvalAuthToken! },
    redirect: "manual",
  });
}, 240_000);

afterAll(async () => {
  await eve?.stop();
});

async function session(fallback: boolean) {
  let stubs: readonly ToolStub[] = [];
  const context = {
    target: { fetch: async () => Response.json(await client.info()) },
    session: async (options: { stubs: readonly ToolStub[] }) => {
      stubs = options.stubs;
      return {};
    },
  } as unknown as EveEvalContext;
  await voiceoverSession(context, fallback);
  const { session: created } = await client.sessions.create({ stubs });
  histories.set(created, []);
  return created;
}

async function tool(target: ClientSession, name: string, input: object) {
  const sent = await target.send(`/tool ${name} ${JSON.stringify(input)}`);
  const turn = await sent.result();
  histories.get(target)!.push(...turn.events);
  const event = turn.events.find(
    (item) =>
      item.type === "action.result" &&
      item.data.result.kind === "tool-result" &&
      item.data.result.toolName === name,
  );
  if (
    event?.type !== "action.result" ||
    event.data.result.kind !== "tool-result"
  ) {
    throw new Error(`Не получен результат ${name}`);
  }
  return event.data;
}

type ToolResult = Awaited<ReturnType<typeof tool>>;
type RequestedActionsEvent = Extract<
  EveEvalStreamEvent,
  { type: "actions.requested" }
>;
type ActionResultEvent = Extract<EveEvalStreamEvent, { type: "action.result" }>;

function piperCommand(suffix: string, scenes = [1, 2, 3]) {
  return scenes
    .map(
      (number) =>
        `python3 "$HOME/.agents/skills/voiceover/scripts/piper_speak.py" ` +
        `--text-file ${PROJECT}/voice/scene-0${number}.txt ` +
        `--voice ru_RU-denis-medium --out ${PROJECT}/public/voice/scene-0${number}${suffix}`,
    )
    .join(" && ");
}

function expectPiperReceipts(
  result: ToolResult,
  suffix: string,
  scenes = [1, 2, 3],
) {
  const { stdout } = result.result.output as { stdout: string };
  const receipts = stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { timingsPath: string });
  const expectedPaths = scenes.map(
    (number) => `${PROJECT}/public/voice/scene-0${number}${suffix}.words.json`,
  );

  expect(receipts.map(({ timingsPath }) => timingsPath)).toEqual(expectedPaths);
  return receipts;
}

function readFileJson<T>(result: ToolResult): T {
  const { content } = result.result.output as { content: string };
  return JSON.parse(content.replace(/^\d+: ?/gmu, ""));
}

function readStdoutJson<T>(result: ToolResult): T {
  const { stdout } = result.result.output as { stdout: string };
  return JSON.parse(stdout);
}

async function inspectProject(target: ClientSession) {
  const root = await tool(target, "read_file", {
    filePath: `${PROJECT}/src/Root.tsx`,
  });
  expect(root).toMatchObject({
    status: "completed",
    result: {
      output: {
        path: `${PROJECT}/src/Root.tsx`,
        content: expect.stringContaining("loadTiming"),
      },
    },
  });

  const listing = await tool(target, "bash", { command: `ls -la ${PROJECT}` });
  expect(JSON.stringify(listing)).not.toContain(".words.json");

  for (let index = 0; index < SCENES.length; index++) {
    const path = `${PROJECT}/voice/scene-0${index + 1}.txt`;
    const scene = await tool(target, "read_file", { filePath: path });
    expect(scene).toMatchObject({
      status: "completed",
      result: {
        output: {
          path,
          content: expect.stringContaining(SCENES[index]),
        },
      },
    });
  }

  return root;
}

async function synthesizeScenes(
  target: ClientSession,
  fallback: boolean,
  parallel: boolean,
) {
  if (fallback) {
    const failedSpeech = await tool(target, "speak", {
      text: SCENES[0],
      voice: VOICE,
      outputPath: `${PROJECT}/public/voice/scene-01`,
    });
    expect(failedSpeech).toMatchObject({ status: "failed" });

    const batches = parallel ? [[1], [2], [3]] : [[1, 2, 3]];
    for (const scenes of batches) {
      const result = await tool(target, "bash", {
        command: piperCommand("-piper", scenes),
      });
      expect(result).toMatchObject({
        status: "completed",
        result: { output: { exitCode: 0 } },
      });
      expectPiperReceipts(result, "-piper", scenes);
    }
  } else {
    const projectPaths = [PROJECT, "calm-morning", "./calm-morning"];
    for (let index = 0; index < SCENES.length; index++) {
      const absolutePath = `${PROJECT}/public/voice/scene-0${index + 1}`;
      const result = await tool(target, "speak", {
        text: SCENES[index],
        voice: VOICE,
        outputPath: `${projectPaths[index]}/public/voice/scene-0${index + 1}`,
      });
      expect(result).toMatchObject({
        status: "completed",
        result: {
          output: {
            audioPath: `${absolutePath}.mp3`,
            timingsPath: `${absolutePath}.words.json`,
            durationMs: fixture.scenes[index].durationMs,
          },
        },
      });
    }
  }
}

async function checkSceneTimings(target: ClientSession, fallback: boolean) {
  for (let index = 0; index < SCENES.length; index++) {
    const suffix = fallback ? "-piper" : "";
    const path = `${PROJECT}/public/voice/scene-0${index + 1}${suffix}.words.json`;
    const result = await tool(target, "read_file", { filePath: path });
    expect(result).toMatchObject({
      status: "completed",
      result: { output: { path } },
    });

    const timing = readFileJson<(typeof fixture.scenes)[number]>(result);
    expect(timing.durationMs).toBe(fixture.scenes[index].durationMs);
    expect(timing.words).toEqual(fixture.scenes[index].words);
    expect(timing.format).toBe(fallback ? "wav" : "mp3");
  }
}

async function reviewFrames(target: ClientSession) {
  const review = await tool(target, "bash", {
    command:
      `cd ${PROJECT} && npx remotion render src/index.ts ${fixture.composition} ` +
      `out/frames-1 --frames=${REVIEW_FRAMES.join(",")} --image-format=jpeg ` +
      "&& ls -lh out/frames-1",
  });
  expect(review).toMatchObject({
    status: "completed",
    result: {
      output: {
        stdout: expect.stringContaining(
          `${PROJECT}/out/frames-1/${FRAME_NAMES.at(-1)}`,
        ),
      },
    },
  });

  const pixels = await tool(target, "bash", {
    command:
      `cd ${PROJECT} && python3 ` +
      '"$HOME/.agents/skills/frame-review/scripts/check-frames.py" out/frames-1/*.jpeg',
  });
  expect(pixels).toMatchObject({
    status: "completed",
    result: { output: { exitCode: 0 } },
  });

  for (const name of FRAME_NAMES) {
    const path = `${PROJECT}/out/frames-1/${name}`;
    const frame = await tool(target, "read_file", { filePath: path });
    expect(frame).toMatchObject({
      status: "completed",
      result: { output: { path, file: { mediaType: "image/jpeg" } } },
    });
  }
}

async function renderVideo(target: ClientSession) {
  const render = await tool(target, "bash", {
    command:
      `cd ${PROJECT} && npx remotion render src/index.ts ` +
      `${fixture.composition} out/calm-morning.mp4`,
  });
  expect(render).toMatchObject({
    status: "completed",
    result: { output: { stdout: expect.stringContaining("546/546") } },
  });
}

async function checkMp4(target: ClientSession) {
  const size = await tool(target, "bash", {
    command:
      `cd ${PROJECT} && ls -l out/calm-morning.mp4 ` +
      "&& stat -c '%s bytes' out/calm-morning.mp4",
  });
  expect(size).toMatchObject({
    status: "completed",
    result: {
      output: {
        exitCode: 0,
        stdout: expect.stringContaining(`${fixture.probe.format.size} bytes\n`),
      },
    },
  });

  const probe = await tool(target, "bash", {
    command:
      `cd ${PROJECT} && npx remotion ffprobe -v error ` +
      "-show_entries stream=duration,codec_type:format=duration -of json out/calm-morning.mp4",
  });
  const metadata = readStdoutJson<{ streams: { duration: string }[] }>(probe);
  const durations = metadata.streams.map(
    ({ duration }) => Number(duration) * 1000,
  );
  expect(durations).toEqual([fixture.videoDurationMs, fixture.audioDurationMs]);
}

function isPixelCheckResult(event: EveEvalStreamEvent) {
  if (
    event.type !== "action.result" ||
    event.data.result.kind !== "tool-result"
  ) {
    return false;
  }

  const output = event.data.result.output;
  return (
    typeof output === "object" &&
    output !== null &&
    "stdout" in output &&
    String(output.stdout).includes('"suspect":null')
  );
}

function synthesisCallIds(events: readonly EveEvalStreamEvent[]) {
  const ids = new Set<string>();
  for (const event of events) {
    if (event.type !== "actions.requested") {
      continue;
    }

    for (const action of event.data.actions) {
      if (action.kind !== "tool-call") {
        continue;
      }

      const isSpeech = action.toolName === "speak";
      const isPiper =
        action.toolName === "bash" &&
        String(action.input.command).includes("piper_speak.py");
      const isTimingRead =
        action.toolName === "read_file" &&
        String(action.input.filePath).endsWith(".words.json");
      if (isSpeech || isPiper || isTimingRead) {
        ids.add(action.callId);
      }
    }
  }
  return ids;
}

function partitionSynthesisEvents(events: readonly EveEvalStreamEvent[]) {
  const ids = synthesisCallIds(events);
  const synthesisEvents: EveEvalStreamEvent[] = [];
  const remainingEvents: EveEvalStreamEvent[] = [];

  for (const event of events) {
    const isRequest =
      event.type === "actions.requested" &&
      event.data.actions.some((action) => ids.has(action.callId));
    const isResult =
      event.type === "action.result" && ids.has(event.data.result.callId);

    if (isRequest || isResult) {
      synthesisEvents.push(event);
    } else {
      remainingEvents.push(event);
    }
  }

  return { synthesisEvents, remainingEvents };
}

function parallelPiperStep(
  events: readonly EveEvalStreamEvent[],
): EveEvalStreamEvent[] {
  const requests = events.filter(
    (event): event is RequestedActionsEvent =>
      event.type === "actions.requested" &&
      event.data.actions.some(
        (action) =>
          action.kind === "tool-call" &&
          action.toolName === "bash" &&
          String(action.input.command).includes("piper_speak.py"),
      ),
  );
  expect(requests).toHaveLength(3);
  expect(requests.map((event) => event.data.actions.length)).toEqual([1, 1, 1]);

  const { turnId, stepIndex, sequence } = requests[0].data;
  const step = { turnId, stepIndex, sequence };
  const ids = new Set(
    requests.flatMap((event) =>
      event.data.actions.map((action) => action.callId),
    ),
  );
  const results = events.filter(
    (event): event is ActionResultEvent =>
      event.type === "action.result" && ids.has(event.data.result.callId),
  );
  expect(results).toHaveLength(3);

  const synthesisEvents = new Set<EveEvalStreamEvent>([
    ...requests,
    ...results,
  ]);
  const remaining = events.filter((event) => !synthesisEvents.has(event));
  const firstRequestAt = events.indexOf(requests[0]);

  // Отдельные события одного шага; JSON остаётся после всех результатов Piper.
  return [
    ...remaining.slice(0, firstRequestAt),
    ...requests.map((event) => ({
      ...event,
      data: { ...event.data, ...step },
    })),
    ...results.toReversed().map((event) => ({
      ...event,
      data: { ...event.data, ...step },
    })),
    ...remaining.slice(firstRequestAt),
  ];
}

function repeatInNextSteps(
  events: readonly EveEvalStreamEvent[],
  repeatedEvents: readonly EveEvalStreamEvent[],
): EveEvalStreamEvent[] {
  const requests = events.filter(
    (event): event is RequestedActionsEvent =>
      event.type === "actions.requested",
  );
  const stepOffset =
    Math.max(...requests.map((event) => event.data.stepIndex)) + 1;
  const sequenceOffset =
    Math.max(...requests.map((event) => event.data.sequence)) + 1;

  return repeatedEvents.map((event) => {
    if (event.type !== "actions.requested" && event.type !== "action.result") {
      return event;
    }

    const meta = { ...event.meta, id: `${event.meta.id}:resynthesis` };
    const step = {
      turnId: event.data.turnId,
      stepIndex: event.data.stepIndex + stepOffset,
      sequence: event.data.sequence + sequenceOffset,
    };
    if (event.type === "actions.requested") {
      return {
        ...event,
        meta,
        data: {
          ...event.data,
          ...step,
          actions: event.data.actions.map((action) => ({
            ...action,
            callId: `resynthesis:${action.callId}`,
          })),
        },
      };
    }

    return {
      ...event,
      meta,
      data: {
        ...event.data,
        ...step,
        result: {
          ...event.data.result,
          callId: `resynthesis:${event.data.result.callId}`,
        },
      },
    };
  });
}

function moveBeforeFullRender(
  remainingEvents: readonly EveEvalStreamEvent[],
  movedEvents: readonly EveEvalStreamEvent[],
) {
  const fullRenderAt = remainingEvents.findIndex((event) => {
    if (event.type !== "actions.requested") {
      return false;
    }

    return event.data.actions.some((action) => {
      if (action.kind !== "tool-call" || action.toolName !== "bash") {
        return false;
      }

      const command = String(action.input.command);
      return (
        command.includes("render src/index.ts") &&
        command.includes("out/calm-morning.mp4")
      );
    });
  });

  return [
    ...remainingEvents.slice(0, fullRenderAt),
    ...movedEvents,
    ...remainingEvents.slice(fullRenderAt),
  ];
}

function moveViewRequestsBeforePixels(
  events: readonly EveEvalStreamEvent[],
): EveEvalStreamEvent[] {
  const requests = events.filter(
    (event) =>
      event.type === "actions.requested" &&
      event.data.actions.some(
        (action) =>
          action.kind === "tool-call" &&
          action.toolName === "read_file" &&
          framePaths.some((path) => path === action.input.filePath),
      ),
  );
  expect(requests).toHaveLength(8);

  const requestSet = new Set<EveEvalStreamEvent>(requests);
  const remaining = events.filter((event) => !requestSet.has(event));
  const pixelsAt = remaining.findIndex(isPixelCheckResult);
  expect(pixelsAt).toBeGreaterThanOrEqual(0);

  // Результаты картинок остаются после пикселей, но запросы уже преждевременны.
  return [
    ...remaining.slice(0, pixelsAt),
    ...requests,
    ...remaining.slice(pixelsAt),
  ];
}

function checkFileSizeEvidence(
  events: readonly EveEvalStreamEvent[],
  evidenceTarget: Parameters<typeof voiceoverEvidence>[1],
) {
  const sizeCallIds = new Set(
    events.flatMap((event) =>
      event.type === "actions.requested"
        ? event.data.actions
            .filter(
              (action) =>
                action.kind === "tool-call" &&
                action.toolName === "bash" &&
                /\bstat\s+-c\s+['"]%s(?: bytes)?['"]/u.test(
                  String(action.input.command),
                ),
            )
            .map((action) => action.callId)
        : [],
    ),
  );
  expect(sizeCallIds.size).toBe(1);
  const withoutFileSize = events.filter(
    (event) =>
      event.type !== "action.result" ||
      !sizeCallIds.has(event.data.result.callId),
  );
  expect(voiceoverEvidence(withoutFileSize, evidenceTarget)).toEqual({
    frameRender: true,
    pixels: true,
    views: true,
    fullRender: true,
    fileSize: false,
    probe: true,
  });

  const sizeRequests = events.filter(
    (event) =>
      event.type === "actions.requested" &&
      event.data.actions.some((action) => sizeCallIds.has(action.callId)),
  );
  const requestSet = new Set<EveEvalStreamEvent>(sizeRequests);
  const sizeBeforeRender = moveBeforeFullRender(
    events.filter((event) => !requestSet.has(event)),
    sizeRequests,
  );
  expect(voiceoverEvidence(sizeBeforeRender, evidenceTarget).fileSize).toBe(
    false,
  );

  const path = `${PROJECT}/out/calm-morning.mp4`;
  const stat = `cd ${PROJECT} && stat -c '%s' out/calm-morning.mp4`;
  const wc = `cd ${PROJECT} && wc -c out/calm-morning.mp4`;
  const checks = [
    [`test -s ${path}`, "", 0, true],
    [`test -s ${path} && npx remotion ffprobe -of json ${path}`, "{}", 0, true],
    [`stat -c '%n %s bytes' ${path}`, `${path} 12345 bytes\n`, 0, true],
    [
      `cd ${PROJECT} && ls -l out/calm-morning.mp4 && stat -c '%s bytes' out/calm-morning.mp4`,
      "-rw-r--r-- 1 user user 12345 out/calm-morning.mp4\n12345 bytes\n",
      0,
      true,
    ],
    [`ls -l ${path} && stat -c '%s bytes' ${path}`, "1052620\n", 0, true],
    [
      `ls -l ${PROJECT}/out/other.mp4 && stat -c '%s bytes' ${path}`,
      "12345 bytes\n",
      0,
      false,
    ],
    [`ls -l ${path} && stat -c '%s bytes' ${path}`, "0 bytes\n", 0, false],
    [wc, "12345 out/calm-morning.mp4\n", 0, true],
    [`wc -c < ${path}`, "12345\n", 0, true],
    [`stat ${path}`, `File: ${path}\n Size: 12345\n`, 0, true],
    [stat, "0\n", 0, false],
    [wc, "0 out/calm-morning.mp4\n", 0, false],
    [stat.replace("out/", "wrong/out/"), "12345\n", 0, false],
    [`test -s ${path}`, "", 1, false],
    [`ls -lh ${PROJECT}/out/frames-1`, "12345\n", 0, false],
  ] as const;
  for (const [command, stdout, exitCode, expected] of checks) {
    const changed = events.map((event): EveEvalStreamEvent => {
      if (event.type === "actions.requested") {
        return {
          ...event,
          data: {
            ...event.data,
            actions: event.data.actions.map((action) =>
              action.kind === "tool-call" && sizeCallIds.has(action.callId)
                ? { ...action, input: { ...action.input, command } }
                : action,
            ),
          },
        };
      }
      if (
        event.type === "action.result" &&
        event.data.result.kind === "tool-result" &&
        sizeCallIds.has(event.data.result.callId)
      ) {
        return {
          ...event,
          data: {
            ...event.data,
            result: {
              ...event.data.result,
              output: { stdout, exitCode },
            },
          },
        };
      }
      return event;
    });
    expect(voiceoverEvidence(changed, evidenceTarget).fileSize, command).toBe(
      expected,
    );
  }
}

function checkEvidenceSequence(events: readonly EveEvalStreamEvent[]) {
  const evidenceTarget = {
    frames: framePaths,
    video: `${PROJECT}/out/calm-morning.mp4`,
    width: fixture.width,
    height: fixture.height,
    durationMs: fixture.videoDurationMs,
  };
  expect(voiceoverEvidence(events, evidenceTarget)).toEqual({
    frameRender: true,
    pixels: true,
    views: true,
    fullRender: true,
    fileSize: true,
    probe: true,
  });
  checkFileSizeEvidence(events, evidenceTarget);

  const withoutPixels = events.filter((event) => !isPixelCheckResult(event));
  expect(voiceoverEvidence(withoutPixels, evidenceTarget)).toMatchObject({
    pixels: false,
    views: false,
    fullRender: false,
    fileSize: false,
    probe: false,
  });

  const viewsBeforePixels = moveViewRequestsBeforePixels(events);
  expect(voiceoverEvidence(viewsBeforePixels, evidenceTarget)).toEqual({
    frameRender: true,
    pixels: true,
    views: false,
    fullRender: false,
    fileSize: false,
    probe: false,
  });

  const withoutLastView = events.filter(
    (event) =>
      event.type !== "action.result" ||
      event.data.result.kind !== "tool-result" ||
      event.data.result.toolName !== "read_file" ||
      (event.data.result.output as { path?: string } | null)?.path !==
        framePaths.at(-1),
  );
  expect(voiceoverEvidence(withoutLastView, evidenceTarget)).toEqual({
    frameRender: true,
    pixels: true,
    views: false,
    fullRender: false,
    fileSize: false,
    probe: false,
  });

  const { synthesisEvents, remainingEvents } = partitionSynthesisEvents(events);
  const framesBeforeSynthesis = moveBeforeFullRender(
    remainingEvents,
    synthesisEvents,
  );
  const noEvidence = {
    frameRender: false,
    pixels: false,
    views: false,
    fullRender: false,
    fileSize: false,
    probe: false,
  };
  expect(voiceoverEvidence(framesBeforeSynthesis, evidenceTarget)).toEqual(
    noEvidence,
  );
  const nextSynthesis = repeatInNextSteps(events, synthesisEvents);
  expect(
    voiceoverEvidence([...events, ...nextSynthesis], evidenceTarget),
  ).toEqual(noEvidence);

  const nextRequests = nextSynthesis.filter(
    (event) => event.type === "actions.requested",
  );
  const staleResults = events.filter((event) => event.type === "action.result");
  expect(
    voiceoverEvidence(
      [...events, ...nextRequests, ...staleResults],
      evidenceTarget,
    ),
  ).toEqual(noEvidence);
}

test.each([
  { fallback: false, parallel: false },
  { fallback: true, parallel: false },
  { fallback: true, parallel: true },
])(
  "согласованный путь от проекта до MP4 без исполнения инструментов (fallback=$fallback, parallel=$parallel)",
  async ({ fallback, parallel }) => {
    const before = await fakeSandbox.counters();
    const target = await session(fallback);
    try {
      const root = await inspectProject(target);
      await synthesizeScenes(target, fallback, parallel);
      await checkSceneTimings(target, fallback);
      await reviewFrames(target);
      await renderVideo(target);
      await checkMp4(target);

      const reread = await tool(target, "read_file", {
        filePath: `${PROJECT}/src/Root.tsx`,
      });
      expect(reread.result.output).toEqual(root.result.output);
      const events = histories.get(target)!;
      checkEvidenceSequence(parallel ? parallelPiperStep(events) : events);

      if (!fallback) {
        const invalidSpeech = await tool(target, "speak", {
          text: SCENES[0],
          voice: VOICE,
          outputPath: `${PROJECT}/public/voice/wrong-scene`,
        });
        expect(invalidSpeech).toMatchObject({
          status: "failed",
          error: { message: expect.stringContaining("speak_bad_input") },
        });
      }

      const after = await fakeSandbox.counters();
      expect(after).toEqual(before);
    } finally {
      await target.reset();
    }
  },
  120_000,
);

test("версионный Piper возвращает новые пути, а неподдержанные операции не подтверждают успех", async () => {
  const target = await session(true);
  try {
    const result = await tool(target, "bash", {
      command: piperCommand("-piper-v2"),
    });
    const receipts = expectPiperReceipts(result, "-piper-v2");
    for (const receipt of receipts) {
      const read = await tool(target, "read_file", {
        filePath: receipt.timingsPath,
      });
      expect(read).toMatchObject({
        status: "completed",
        result: { output: { path: receipt.timingsPath } },
      });
    }

    const missingTiming = await tool(target, "read_file", {
      filePath: `${PROJECT}/public/voice/scene-01.words.json`,
    });
    expect(missingTiming).toMatchObject({ status: "failed" });

    const unknownCommand = await tool(target, "bash", {
      command: "unrecorded_command",
    });
    expect(unknownCommand).toMatchObject({ status: "failed" });

    const invalidProbe = await tool(target, "bash", {
      command:
        `npx remotion ffprobe ${PROJECT}/public/voice/scene-01-piper.wav ` +
        `${PROJECT}/public/voice/scene-02-piper.wav`,
    });
    expect(invalidProbe).toMatchObject({
      status: "completed",
      result: { output: { exitCode: 1 } },
    });

    const edit = await tool(target, "edit_file", {
      filePath: `${PROJECT}/src/Root.tsx`,
      newString: "другая композиция",
    });
    expect(edit).toMatchObject({ status: "failed" });

    for (const command of [
      `cd ${PROJECT} && npx remotion render missing.ts NotMain out/calm-morning.mp4`,
      `cd ${PROJECT} && npx remotion render missing.ts NotMain ` +
        `out/frames-1 --frames=${REVIEW_FRAMES.join(",")}`,
      `cd ${PROJECT} && npx remotion still src/index.ts Main out/wrong.jpeg --frame=309`,
      `cd ${PROJECT} && npx remotion render src/index.ts Main wrong/out/calm-morning.mp4`,
      `cd ${PROJECT} && npx remotion render src/index.ts Main wrong/out/frames-1 --frames=${REVIEW_FRAMES.join(",")}`,
      `cd ${PROJECT} && npx remotion still src/index.ts Main wrong/out/frames-1/element-309.jpeg --frame=309`,
      `cd ${PROJECT} && stat -c '%s' out/calm-morning.mp4 && npx remotion ffprobe -of json out/calm-morning.mp4`,
      `cd ${PROJECT} && wc -c out/calm-morning.mp4 && npx remotion ffprobe out/calm-morning.mp4`,
      `cd ${PROJECT} && npx remotion ffprobe -of json out/calm-morning.mp4 && stat -c '%s' out/calm-morning.mp4`,
      `python3 /skills/piper_speak.py --text-file ${PROJECT}/voice/scene-01.txt ` +
        `--voice en_US-ryan-medium --out ${PROJECT}/public/voice/scene-01-piper`,
      `python3 /skills/piper_speak.py --text-file ${PROJECT}/voice/scene-01.txt ` +
        `--voice ru_RU-denis-medium --out ${PROJECT}/public/voice/scene-02-piper`,
    ]) {
      const rejected = await tool(target, "bash", { command });
      const failed =
        rejected.status === "failed" ||
        (rejected.result.output as { exitCode: number }).exitCode !== 0;
      expect(failed, command).toBe(true);
    }

    const loop = await tool(target, "bash", {
      command:
        `cd ${PROJECT} && for i in 01 02 03; do python3 /skills/piper_speak.py ` +
        '--text-file "voice/scene-$i.txt" ' +
        `--voice ru_RU-denis-medium --out "public/voice/scene-$i-piper"; done`,
    });
    expect(loop).toMatchObject({
      status: "completed",
      result: { output: { exitCode: 0 } },
    });
  } finally {
    await target.reset();
  }
}, 120_000);
