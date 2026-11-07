import type { ToolStub } from "eve/evals";

import data from "../fixtures/voiceover/project.json";
import {
  duration,
  escapePattern,
  PROJECT,
  workspacePathForms,
} from "./fixture-data";

const VIDEO = "out/calm-morning.mp4";
const VIDEO_PATH = `${PROJECT}/${VIDEO}`;

function shellPath(path: string) {
  const pattern = escapePattern(path);
  return `(?:${pattern}|"${pattern}"|'${pattern}')`;
}

const ABSOLUTE_FILE = shellPath(VIDEO_PATH);
const FILE = `(?:${shellPath(VIDEO)}|${shellPath(`./${VIDEO}`)}|${ABSOLUTE_FILE})`;
const WORKSPACE_FILE = `(?:${workspacePathForms(VIDEO_PATH).map(shellPath).join("|")})`;
const DIRECTORY = shellPath(PROJECT);
const PROBE =
  "(?:npx\\s+(?:--yes\\s+)?)?remotion\\s+ffprobe\\s+-v\\s+error\\s+";

function inspection(id: string, command: string, stdout: string): ToolStub {
  const scoped = `cd\\s+${DIRECTORY}\\s*&&\\s*${command}`;
  const fromWorkspace = command.replaceAll(FILE, WORKSPACE_FILE);
  return {
    id,
    tool: "bash",
    match: { command: { pattern: `^\\s*(?:${scoped}|${fromWorkspace})\\s*$` } },
    outcome: {
      response: {
        status: "completed",
        exitCode: 0,
        stdout,
        stderr: "",
        truncated: false,
      },
    },
  };
}

function listing(size: string) {
  return `-rw-r--r-- 1 user user ${size} Nov  7 00:00 ${VIDEO_PATH}\n`;
}

function selectedProbe(includeFormat: boolean) {
  return JSON.stringify({
    streams: data.probe.streams.map(({ codec_type, duration }) => ({
      codec_type,
      duration,
    })),
    ...(includeFormat
      ? { format: { duration: data.probe.format.duration } }
      : {}),
  });
}

function probeCommand(entries: string | readonly string[], writer: string) {
  const choices = typeof entries === "string" ? [entries] : entries;
  const selection = choices.map(escapePattern).join("|");
  return `${PROBE}-show_entries\\s+["']?(?:${selection})["']?\\s+-of\\s+${writer}\\s+${FILE}`;
}

function probeStubs(): ToolStub[] {
  const detailedEntries =
    "stream=codec_name,codec_type,width,height,duration:format=duration";
  const text = [
    "codec_name=h264",
    "codec_type=video",
    `width=${data.width}`,
    `height=${data.height}`,
    `duration=${duration(data.videoDurationMs)}`,
    "codec_name=aac",
    "codec_type=audio",
    `duration=${duration(data.audioDurationMs)}`,
    `duration=${data.probe.format.duration}`,
    "",
  ].join("\n");

  return [
    inspection(
      "probe-mp4-full-json",
      `${PROBE}(?:-show_streams\\s+-show_format|-show_format\\s+-show_streams)\\s+-of\\s+json\\s+${FILE}`,
      JSON.stringify(data.probe),
    ),
    inspection(
      "probe-mp4-text",
      probeCommand(detailedEntries, "default=(?:nw|noprint_wrappers)=1"),
      text,
    ),
    inspection(
      "probe-mp4-json",
      probeCommand(
        [
          "stream=duration,codec_type:format=duration",
          "stream=codec_type,duration:format=duration",
        ],
        "json",
      ),
      selectedProbe(true),
    ),
    ...[true, false].map((includeFormat) => {
      const entries = `stream=codec_type,duration${includeFormat ? ":format=duration" : ""}`;
      return inspection(
        `listed-probe-mp4-json${includeFormat ? "-format" : ""}`,
        `ls\\s+-lh\\s+${FILE}\\s*&&\\s*${probeCommand(entries, "json")}`,
        listing("1.1M") + selectedProbe(includeFormat),
      );
    }),
    inspection(
      "probe-mp4-size-json",
      probeCommand("format=size", "json"),
      JSON.stringify({ format: { size: data.probe.format.size } }),
    ),
  ];
}

export function videoInspectionStubs(): ToolStub[] {
  const size = data.probe.format.size;
  return [
    ...probeStubs(),
    inspection("file-listing-bytes", `ls\\s+-l\\s+${FILE}`, listing(size)),
    inspection("file-listing-human", `ls\\s+-lh\\s+${FILE}`, listing("1.1M")),
    inspection("file-presence", `test\\s+-s\\s+${FILE}`, ""),
    inspection("file-size", `stat\\s+-c\\s+['"]%s['"]\\s+${FILE}`, `${size}\n`),
    inspection(
      "file-size-bytes",
      `stat\\s+-c\\s+['"]%s bytes['"]\\s+${FILE}`,
      `${size} bytes\n`,
    ),
    inspection(
      "file-size-name",
      `stat\\s+-c\\s+['"]%n %s bytes['"]\\s+${FILE}`,
      `${VIDEO_PATH} ${size} bytes\n`,
    ),
    inspection(
      "listed-file-size",
      `ls\\s+-l\\s+${FILE}\\s*&&\\s*stat\\s+-c\\s+['"]%s bytes['"]\\s+${FILE}`,
      listing(size) + `${size} bytes\n`,
    ),
    inspection(
      "file-byte-count",
      `wc\\s+-c\\s+${FILE}`,
      `${size} ${VIDEO_PATH}\n`,
    ),
  ];
}
