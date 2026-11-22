import { readFileSync } from "node:fs";
import { defineEval, type EveEvalContext, type ToolStub } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { blockedRead, emptySearch, webSession } from "../web/fixtures";
import { documentImages, documentPaths, type DocumentName } from "./media-fixture";
import recordings from "./recordings.json";

export { documentPaths } from "./media-fixture";

const PACKAGED = ["references/formats.md", "references/charts.md", "scripts/inspect_document.py"];
const SKILL = "reading-documents";
const HOME = String.raw`(?:echo\s+["']?\$HOME["']?|printenv\s+HOME|printf\s+'%s\\n'\s+"\$HOME")`;
const LABELED_HOME = String.raw`printf\s+'HOME=%s\\n'\s+"\$HOME"`;
const IMPORTS = String.raw`python3?\s+-c\s+["']import\s+pdfplumber,\s*pptx,\s*openpyxl,\s*charset_normalizer["']`;
const NEXT_COMMAND = "\\s*(?:&&|;|\\n)\\s*";

function escapePattern(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function pathForms(path: string) {
  const relative = path.replace(/^\/workspace\//, "");
  return [path, relative, `./${relative}`];
}

function shellPath(path: string) {
  const paths = pathForms(path).map(escapePattern).join("|");
  return `["']?(?:${paths})["']?`;
}

function bashFixture(id: string, pattern: string, stdout: string): ToolStub {
  return {
    id,
    tool: "bash",
    match: { command: { pattern } },
    outcome: { response: { status: "completed", exitCode: 0, stdout, stderr: "", truncated: false } },
  };
}

function readResponse(path: string, text: string) {
  const lines = text.trimEnd().split("\n");
  return {
    path,
    content: lines.map((line, index) => `${index + 1}: ${line}`).join("\n"),
    totalLines: lines.length,
    truncated: false,
  };
}

function withBootstrap(id: string, command: string, stdout: string): ToolStub[] {
  return [
    { pattern: "", stdout: "" },
    { pattern: `${IMPORTS}${NEXT_COMMAND}`, stdout: "" },
    { pattern: `${HOME}${NEXT_COMMAND}(?:${IMPORTS}${NEXT_COMMAND})?`, stdout: "/root\n" },
    { pattern: `${LABELED_HOME}${NEXT_COMMAND}(?:${IMPORTS}${NEXT_COMMAND})?`, stdout: "HOME=/root\n" },
  ].map((prefix, index) => bashFixture(
    `${id}-${index}`,
    `^\\s*${prefix.pattern}${command}\\s*$`,
    prefix.stdout + stdout,
  ));
}

export async function documentSession(t: EveEvalContext, name: DocumentName) {
  const { input, output } = documentPaths(name);
  const recording = recordings[name];
  const skillDirectory = `(?:(?:/root|~|\\$HOME|\\$\\{HOME\\})/\\.agents/)?skills/${SKILL}`;
  const createDirectory = `mkdir\\s+-p\\s+${shellPath(output)}`;
  const extract = `(?:${createDirectory}${NEXT_COMMAND})?` +
    `python3?\\s+["']?${skillDirectory}/scripts/inspect_document\\.py["']?\\s+${shellPath(input)}` +
    `(?:\\s+--out(?:=|\\s+)${shellPath(output)})?`;
  const references: ToolStub[] = PACKAGED.map((relative, index) => ({
    id: `document-package-${index}`,
    tool: "read_file",
    match: { filePath: { pattern: `(?:^|/)skills/${SKILL}/${escapePattern(relative)}$` } },
    outcome: {
      response: readResponse(`/root/.agents/skills/${SKILL}/${relative}`, readFileSync(`agent/skills/${SKILL}/${relative}`, "utf8")),
    },
  }));
  const files: ToolStub[] = Object.entries(recording.files).map(([relative, content], index) => ({
    id: `document-extract-${index}`,
    tool: "read_file",
    match: { filePath: { enum: pathForms(`${output}/${relative}`) } },
    outcome: { response: readResponse(`${output}/${relative}`, content) },
  }));
  const images: ToolStub[] = documentImages(name).map(({ path, size, width, height }, index) => ({
    id: `document-image-${index}`,
    tool: "read_file",
    match: { filePath: { enum: pathForms(path) } },
    outcome: { response: {
      path, content: `Image ${width}x${height}`, totalLines: 1, truncated: false,
      file: { mediaType: "image/png", size, width, height },
    } },
  }));

  return webSession(t, [
    ...references,
    ...files,
    ...images,
    { id: "document-other-files", tool: "read_file", outcome: { throw: { message: "Файл не найден или не является текстовым." } } },
    ...withBootstrap("document-commands", extract, recording.stdout.replace("{output}", output)),
    bashFixture("document-home", `^\\s*${HOME}\\s*$`, "/root\n"),
    bashFixture("document-labeled-home", `^\\s*${LABELED_HOME}\\s*$`, "HOME=/root\n"),
    ...withBootstrap("document-dependencies", IMPORTS, ""),
    ...withBootstrap(
      "document-skill-list",
      `rg\\s+--files\\s+["']?${skillDirectory}["']?`,
      ["SKILL.md", ...PACKAGED].map((path) => `/root/.agents/skills/${SKILL}/${path}\n`).join(""),
    ),
    ...PACKAGED.map((relative, index) => bashFixture(
      `document-reference-cat-${index}`,
      `^\\s*cat\\s+["']?${skillDirectory}/${escapePattern(relative)}["']?\\s*$`,
      readFileSync(`agent/skills/${SKILL}/${relative}`, "utf8"),
    )),
    ...withBootstrap(
      "document-input-list",
      `ls(?:\\s+-[alh]+)?\\s+${shellPath(input)}(?:\\s+${shellPath("/workspace/.eve/attachments/ab12")})?`,
      `${input}\n`,
    ),
    bashFixture("document-create-output", `^\\s*${createDirectory}\\s*$`, ""),
    bashFixture("document-output-list", `^\\s*ls(?:\\s+-[alh]+)?\\s+${shellPath(output)}\\s*$`, `${Object.keys(recording.files).join("\n")}\n`),
    { id: "document-other-commands", tool: "bash", outcome: { throw: { message: "Для этапа чтения эта команда не предусмотрена." } } },
    blockedRead,
    emptySearch,
  ]);
}

export function documentCases(name: DocumentName, kind: string, mediaType: string) {
  const { input, output } = documentPaths(name);
  const overview = pathForms(`${output}/overview.md`);
  const kazan = name === "data.csv" ? /1\s*318[.,]6/u : /20\s*500[.,]2/u;

  return Array.from({ length: 3 }, () => defineEval({
    description: `Агент читает приложенный ${kind} перед подготовкой ролика.`,
    tags: ["documents", "loads-skill", kind.toLowerCase()],
    async test(t) {
      const session = await documentSession(t, name);
      const turn = await session.send(
        `Хочу сделать ролик по приложенному файлу. Пока только прочитай текст и выпиши показатели по Москве и Казани. Если единицы в документе не указаны, так и скажи; ` +
        `картинки и сам ролик пока не нужны.\nAttached file ${input} (${mediaType})`,
      );
      t.succeeded();
      const attachmentReads = new Set(turn.events.flatMap((event) =>
        event.type === "actions.requested" ? event.data.actions.flatMap((action) =>
          action.kind === "tool-call" && action.toolName === "read_file" &&
          typeof action.input === "object" && action.input !== null && "filePath" in action.input &&
          action.input.filePath === input ? [action.callId] : []) : []));
      const unexpectedFailure = turn.events.some((event) =>
        event.type === "action.result" && event.data.status === "failed" &&
        !attachmentReads.has(event.data.result.callId));
      t.check(unexpectedFailure, satisfies((value) => value === false, "нет ошибок обязательных действий"));
      t.loadedSkill(SKILL);
      t.calledTool("bash", { input: { command: (value: unknown) =>
        typeof value === "string" && value.includes("inspect_document.py") && value.includes(input) } });
      t.calledTool("read_file", { input: { filePath: (value: unknown) =>
        typeof value === "string" && overview.includes(value) } });
      const extractAt = turn.events.findIndex((event) => {
        if (event.type !== "action.result" || event.data.status !== "completed") return false;
        const result = event.data.result;
        const value = result.kind === "tool-result" && result.toolName === "bash" ? result.output : null;
        return typeof value === "object" && value !== null && "stdout" in value &&
          typeof value.stdout === "string" && value.stdout.includes(`Результаты: ${output}\n`);
      });
      const overviewAt = turn.events.findIndex((event) => {
        if (event.type !== "action.result" || event.data.status !== "completed") return false;
        const result = event.data.result;
        const value = result.kind === "tool-result" && result.toolName === "read_file" ? result.output : null;
        return typeof value === "object" && value !== null && "path" in value && value.path === `${output}/overview.md`;
      });
      t.check(extractAt >= 0 && overviewAt > extractAt, satisfies(Boolean, "обзор прочитан после извлечения"));
      t.notCalledTool("edit_file");
      t.messageIncludes(/москв/i);
      t.messageIncludes(/казан/i);
      t.messageIncludes(/13\s*010[.,]1/u);
      t.messageIncludes(kazan);
    },
  }));
}
