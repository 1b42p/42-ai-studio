import type { ToolStub } from "eve/evals";

import data from "../fixtures/voiceover/project.json";
import { voiceoverFrames } from "./media-fixture";
import { videoInspectionStubs } from "./video-inspection-fixtures";
import {
  duration,
  escapePattern,
  fixtureTimings,
  FRAME_NAMES,
  framePaths,
  PIPER_VOICE,
  PROJECT,
  readResponse,
  REVIEW_FRAMES,
  sceneBase,
  workspacePathForms,
} from "./fixture-data";

const COMMAND_PART = "(?:\\\\\\r?\\n|[^;&\\n])";
const SCENE_GROUPS = [[0, 1, 2], [1, 2], [0, 2], [0, 1], [2], [1], [0]];
const AUDIO_VERSIONS = ["", "-v2"];

function bashResponse(stdout: string, exitCode = 0, stderr = "") {
  return { status: "completed", exitCode, stdout, stderr, truncated: false };
}

function commandStub(id: string, pattern: string, stdout: string): ToolStub {
  return {
    id,
    tool: "bash",
    match: { command: { pattern } },
    outcome: { response: bashResponse(stdout) },
  };
}

function rejectedCommand(
  id: string,
  pattern: string,
  message: string,
): ToolStub {
  return {
    id,
    tool: "bash",
    match: { command: { pattern } },
    outcome: { throw: { message } },
  };
}

function shellToken(pattern: string) {
  return `["']?${pattern}["']?(?=\\s|$)`;
}

function projectPath(path: string) {
  return shellToken(`(?:${escapePattern(PROJECT)}/)?${escapePattern(path)}`);
}

function projectArgument(path: string) {
  return `(?<!\\S)${projectPath(path)}`;
}

function remotionCommand(
  operation: string,
  args: string,
  trailingCommand = "",
) {
  const changeDirectory = `(?:cd\\s+${shellToken(escapePattern(PROJECT))}\\s*&&\\s*)?`;
  const launcher = "(?:npx\\s+(?:--yes\\s+)?)?remotion";
  return `^\\s*${changeDirectory}${launcher}\\s+${operation}\\s+${args}${trailingCommand}\\s*$`;
}

function compositionArguments() {
  const entry = projectPath("src/index.ts");
  const composition = shellToken(escapePattern(data.composition));
  return `(?:${entry}\\s+)?${composition}\\s+`;
}

function piperCommand(index: number, version: string) {
  const textFile = projectPath(`voice/scene-0${index + 1}.txt`);
  const output = projectPath(
    `public/voice/scene-0${index + 1}-piper${version}`,
  );
  const voice = shellToken(escapePattern(PIPER_VOICE));
  const script = `python3?\\s+${COMMAND_PART}*piper_speak\\.py["']?`;
  const readsScene = `(?=${COMMAND_PART}*--text-file(?:=|\\s+)${textFile})`;
  const usesVoice = `(?=${COMMAND_PART}*--voice(?:=|\\s+)${voice})`;
  const writesScene = `(?=${COMMAND_PART}*--out(?:=|\\s+)${output})`;

  return script + readsScene + usesVoice + writesScene;
}

function piperReceipt(index: number, version: string) {
  return JSON.stringify({
    audioPath: `${sceneBase(index, true, version)}.wav`,
    timingsPath: `${sceneBase(index, true, version)}.words.json`,
    durationMs: data.scenes[index].durationMs,
    words: data.scenes[index].words.length,
    mode: "alignment",
  });
}

function piperBatchStubs(): ToolStub[] {
  return AUDIO_VERSIONS.flatMap((version) =>
    SCENE_GROUPS.map((indices) => {
      const clauses = [0, 1, 2].map((index) => {
        const operator = indices.includes(index) ? "=" : "!";
        return `(?${operator}[\\s\\S]*${piperCommand(index, version)})`;
      });
      const mask = indices.reduce((value, index) => value | (1 << index), 0);
      const pattern = "^(?=[\\s\\S]*piper_speak\\.py)" + clauses.join("");
      const stdout = indices
        .map((index) => piperReceipt(index, version))
        .join("\n");

      return commandStub(`piper-${mask}${version}`, pattern, stdout);
    }),
  );
}

function piperLoopStubs(): ToolStub[] {
  return AUDIO_VERSIONS.map((version) => {
    const root = escapePattern(PROJECT);
    const changeDirectory = `(?:cd\\s+${shellToken(root)}\\s*&&\\s*)?`;
    const loop =
      "for\\s+([a-zA-Z_]\\w*)\\s+in\\s+(?:01\\s+02\\s+03|\\{01\\.\\.03\\})[;\\n]\\s*do\\s+";
    const script = `python3?\\s+${COMMAND_PART}*piper_speak\\.py["']?`;
    const variable = "\\$(?:\\{\\1\\}|\\1)";
    const textFile = `["']?(?:${root}/)?voice/scene-${variable}\\.txt["']?(?:\\s|;|$)`;
    const output = `["']?(?:${root}/)?public/voice/scene-${variable}-piper${version}["']?(?:\\s|;|$)`;
    const readsScene = `(?=${COMMAND_PART}*--text-file(?:=|\\s+)${textFile})`;
    const writesScene = `(?=${COMMAND_PART}*--out(?:=|\\s+)${output})`;
    const usesVoice = `(?=${COMMAND_PART}*--voice(?:=|\\s+)${shellToken(escapePattern(PIPER_VOICE))})`;
    const end = `${COMMAND_PART}*[;\\n]\\s*done\\s*$`;
    const pattern =
      "^\\s*" +
      changeDirectory +
      loop +
      script +
      usesVoice +
      readsScene +
      writesScene +
      end;
    const stdout = [0, 1, 2]
      .map((index) => piperReceipt(index, version))
      .join("\n");

    return commandStub(`piper-loop${version}`, pattern, stdout);
  });
}

function unsupportedCommandStubs(): ToolStub[] {
  return [
    rejectedCommand(
      "unsupported-probe-writer",
      "(?:ffprobe[\\s\\S]*(?:-(?:show_packets|show_frames|select_streams|count_packets|count_frames)\\b|(?:-of|-print_format)[ =]+(?:csv|compact|xml|ini))|remotion\\s+(?:render|still|compositions|ffprobe)[\\s\\S]*remotion\\s+(?:render|still|compositions|ffprobe)|\\b(?:cat|readFile)\\s[^;&\\n]*&&\\s*[^;&\\n]*\\b(?:remotion|ffprobe)\\s|\\b(?:stat|wc)\\s[^;\\n]*&&\\s*[^;\\n]*\\bffprobe\\b|\\bffprobe\\b[\\s\\S]*&&\\s*(?:stat|wc)\\s)",
      "Записаны отдельные вызовы, метаданные двух дорожек и контейнера в json/default. Разделите составную проверку; пакеты, кадры и выбор отдельной дорожки не записаны. Для полной проверки используйте ffprobe -v error -show_streams -show_format -of json out/calm-morning.mp4.",
    ),
    rejectedCommand(
      "unsupported-mixed-audio-versions",
      "(?:^(?=[\\s\\S]*piper_speak\\.py)(?=[\\s\\S]*scene-0?[123]-piper-v2)(?=[\\s\\S]*scene-0?[123]-piper[\\s\"';&])|^(?=[\\s\\S]*(?:pip\\s+install|piper\\.download_voices))(?=[\\s\\S]*&&))",
      "Смешанные версии синтеза и составная установка не записаны. Выполняйте проверку диска, установку, скачивание голоса и синтез разных версий отдельными вызовами, чтобы получить их собственные результаты.",
    ),
    {
      id: "invalid-multiple-probe-inputs",
      tool: "bash",
      match: {
        command: {
          pattern:
            "^(?![\\s\\S]*ffprobe[\\s\\S]*ffprobe)(?=[\\s\\S]*ffprobe)(?=[\\s\\S]*\\.(?:wav|mp3)[\\s\\S]*\\.(?:wav|mp3))[\\s\\S]*$",
        },
      },
      outcome: {
        response: bashResponse(
          "",
          1,
          "ffprobe принимает один входной файл. Проверьте файлы отдельными вызовами.\n",
        ),
      },
    },
  ];
}

function audioStubs(fallback: boolean): ToolStub[] {
  return data.scenes.flatMap((_, index) => {
    const number = String(index + 1).padStart(2, "0");
    const timing = fixtureTimings(index, fallback);
    const versions = fallback ? AUDIO_VERSIONS : [""];
    return versions.map((version): ToolStub => ({
      id: `timings-${index}${version}`,
      tool: "read_file",
      match: {
        filePath: {
          enum: workspacePathForms(
            `${sceneBase(index, fallback, version)}.words.json`,
          ),
        },
      },
      outcome: {
        response: readResponse(
          `${sceneBase(index, fallback, version)}.words.json`,
          JSON.stringify(timing, null, 2),
        ),
      },
    }));
  });
}

function reviewStubs(): ToolStub[] {
  const args =
    compositionArguments() +
    `(?=[^;&\\n]*${projectArgument("out/frames-1")})` +
    `(?=[^;&\\n]*--frames[= ]["']?${REVIEW_FRAMES.join(",")}(?:[\\s"']|$))[^;&\\n]*`;
  const renderFrames = remotionCommand("render", args);
  const rendered = `Rendered frames (8/8)\n${framePaths.join("\n")}\n`;
  const detailedListing = voiceoverFrames
    .map(
      (frame, index) =>
        `-rw-r--r-- 1 user user ${Math.ceil(frame.size / 1024)}K ${FRAME_NAMES[index]}`,
    )
    .join("\n");
  const pixelResults = data.pixels
    .map((pixel) =>
      JSON.stringify({
        ...pixel,
        path: `${PROJECT}/${pixel.path}`,
      }),
    )
    .join("\n");

  return [
    commandStub(
      "render-review-with-details",
      remotionCommand(
        "render",
        args,
        `\\s*&&\\s*ls\\s+-lh\\s+${projectArgument("out/frames-1")}`,
      ),
      `${rendered}${detailedListing}\n`,
    ),
    commandStub(
      "render-review-with-listing",
      remotionCommand(
        "render",
        args,
        `\\s*&&\\s*ls\\s+${projectArgument("out/frames-1")}`,
      ),
      `${rendered}${FRAME_NAMES.join("\n")}\n`,
    ),
    commandStub("render-review", renderFrames, rendered),
    {
      id: "unrecorded-review",
      tool: "bash",
      match: {
        command: {
          pattern: "remotion[\\s\\S]*(?:\\bstill\\b|--frames|--sequence)",
        },
      },
      outcome: {
        response: bashResponse(
          "",
          1,
          `Записан только общий рендер контрольной выборки ${REVIEW_FRAMES.join(",")} в out/frames-1. Отдельные still и другие каталоги этим контрактом не подтверждаются.\n`,
        ),
      },
    },
    commandStub(
      "review-pixels",
      "check-frames\\.py(?=[^;&\\n]*(?:out/frames-1/))[^;&\\n]*$",
      pixelResults,
    ),
  ];
}

function fullRenderStub(): ToolStub {
  const render = remotionCommand(
    "render",
    compositionArguments() +
      `(?=[^;&\\n]*${projectArgument("out/calm-morning.mp4")})[^;&\\n]*`,
  );
  return commandStub(
    "render-mp4",
    render,
    `Rendered ${data.frames}/${data.frames}\nEncoded ${data.frames}/${data.frames}\nOutput: out/calm-morning.mp4 (1.0 MB)\n`,
  );
}

function piperSetupStubs(): ToolStub[] {
  const install =
    "(?:python3?\\s+-m\\s+)?pip\\s+install[^;&\\n]*piper-tts[^;&\\n]*";
  const download = `python3?\\s+-m\\s+piper\\.download_voices\\s+${escapePattern(PIPER_VOICE)}[^;&\\n]*`;

  return [
    commandStub(
      "piper-install",
      `^\\s*${install}\\s*$`,
      "Successfully installed piper-tts-1.8.0\n",
    ),
    commandStub(
      "piper-download",
      `^\\s*${download}\\s*$`,
      `${PIPER_VOICE}.onnx\n${PIPER_VOICE}.onnx.json\n`,
    ),
  ];
}

function environmentStubs(fallback: boolean): ToolStub[] {
  const metadata = `${data.composition}  ${data.fps} fps  ${data.width}×${data.height}  ${data.frames} frames (${duration(data.videoDurationMs)} sec)\n`;
  const listing = `${Object.keys(data.files).join("\n")}\npublic/voice/\nout/\nNOTES.md\n`;

  return [
    ...(fallback ? piperSetupStubs() : []),
    commandStub("composition-metadata", "remotion\\s+compositions", metadata),
    commandStub(
      "project-directories",
      "^\\s*(?:cd[^;&\\n]+&&\\s*)?mkdir\\s+-p[^;&\\n]+$",
      "",
    ),
    commandStub(
      "fonts",
      "^\\s*fc-list(?:[^;&\\n]*)$",
      "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf: DejaVu Sans:style=Book\n",
    ),
    commandStub("vcpu", "^\\s*sandbox-vcpu\\s*$", "2\n"),
    commandStub(
      "disk",
      "^\\s*df\\s+-h[^;&\\n]*$",
      "Filesystem Size Used Avail Use% Mounted on\noverlay 5.0G 120M 4.9G 3% /workspace\n",
    ),
    commandStub(
      "project-listing",
      `^\\s*(?:ls|find)(?:\\s+-[al]+)?\\s+${shellToken(escapePattern(PROJECT) + "/?")}\\s*$`,
      listing,
    ),
  ];
}

export function mediaStubs(fallback: boolean): ToolStub[] {
  return [
    ...unsupportedCommandStubs(),
    ...(fallback ? [...piperBatchStubs(), ...piperLoopStubs()] : []),
    ...audioStubs(fallback),
    ...videoInspectionStubs(),
    ...reviewStubs(),
    fullRenderStub(),
    ...environmentStubs(fallback),
  ];
}
