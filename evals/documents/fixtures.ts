import { readFileSync } from "node:fs";
import { defineEval, type EveEvalContext, type ToolStub } from "eve/evals";

import { blockedRead, emptySearch, webSession } from "../web/fixtures";
import recordings from "./recordings.json";

type DocumentName = keyof typeof recordings;

const PACKAGED = ["references/formats.md", "references/charts.md", "scripts/inspect_document.py"];
const SKILL = "reading-documents";

function escapePattern(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function documentPaths(name: DocumentName) {
  const input = `/workspace/.eve/attachments/ab12/${name}`;
  const output = `/workspace/source/${name.replace(".", "-")}`;
  return { input, output };
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

export async function documentSession(t: EveEvalContext, name: DocumentName) {
  const { input, output } = documentPaths(name);
  const recording = recordings[name];
  const scriptPath = "(?:(?:/root|~|\\$HOME|\\$\\{HOME\\})/\\.agents/)?skills/";
  const script = `${scriptPath}${SKILL}/scripts/inspect_document\\.py`;
  const extract = `^\\s*python3?\\s+["']?${script}["']?\\s+${shellPath(input)}` +
    `(?:\\s+--out(?:=|\\s+)${shellPath(output)})?\\s*$`;
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

  return webSession(t, [
    ...references,
    ...files,
    { id: "document-other-files", tool: "read_file", outcome: { throw: { message: "Файл не найден или не является текстовым." } } },
    bashFixture("document-commands", extract, recording.stdout.replace("{output}", output)),
    bashFixture("document-home", String.raw`^\s*(?:echo\s+["']?\$HOME["']?|printenv\s+HOME|printf\s+'%s\\n'\s+"\$HOME")\s*$`, "/root\n"),
    bashFixture("document-dependencies", String.raw`^\s*python3?\s+-c\s+["']import\s+pdfplumber,\s*pptx,\s*openpyxl,\s*charset_normalizer["']\s*$`, ""),
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
      await session.send(
        `Хочу сделать ролик по приложенному файлу. Пока только прочитай текст, выпиши показатели по Москве и Казани с единицами; ` +
        `картинки и сам ролик пока не нужны.\nAttached file ${input} (${mediaType})`,
      );
      t.succeeded();
      t.noFailedActions();
      t.loadedSkill(SKILL);
      t.calledTool("bash", { input: { command: (value: unknown) =>
        typeof value === "string" && value.includes("inspect_document.py") && value.includes(input) } });
      t.calledTool("read_file", { input: { filePath: (value: unknown) =>
        typeof value === "string" && overview.includes(value) } });
      t.notCalledTool("edit_file");
      t.messageIncludes(/москв/i);
      t.messageIncludes(/казан/i);
      t.messageIncludes(/13\s*010[.,]1/u);
      t.messageIncludes(kazan);
    },
  }));
}
