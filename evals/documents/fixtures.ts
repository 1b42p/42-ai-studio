import type { EveEvalContext, ToolStub } from "eve/evals";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { blockedRead, emptySearch, webSession } from "../web/fixtures";

export async function documentSession(t: EveEvalContext, path: string) {
  const escapedPath = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const packaged = ["references/formats.md", "references/charts.md", "scripts/inspect_document.py"];
  const files: ToolStub[] = packaged.flatMap((relative, index): ToolStub[] => {
    const content = readFileSync(resolve("agent/skills/reading-documents", relative), "utf8");
    const suffix = relative.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return [
      { id: `document-package-${index}`, tool: "read_file",
        match: { filePath: { pattern: `reading-documents/${suffix}$` } },
        outcome: { response: { path: `/root/.agents/skills/reading-documents/${relative}`,
          content, totalLines: content.split("\n").length, truncated: false } } },
      { id: `document-cat-${index}`, tool: "bash",
        match: { command: { pattern: `(?:cat|head|tail)[\\s\\S]*reading-documents/${suffix}` } },
        outcome: { response: { status: "completed", exitCode: 0, stdout: content, stderr: "", truncated: false } } },
    ];
  });
  const stubs: ToolStub[] = [
    {
      id: "document-commands", tool: "bash",
      match: { command: { allOf: [{ pattern: "inspect_document\\.py" }, { pattern: escapedPath }] } },
      outcome: { response: { status: "completed", exitCode: 0, truncated: false,
        stdout: `Источник ${path} прочитан. Полный текст: /workspace/source/material/overview.md. ` +
          "Таблицы: /workspace/source/material/tables/data.csv. " +
          "Москва: 13010.1, Казань: 20500.2. Нужны параметры ролика.", stderr: "" } },
    },
    ...files,
    { id: "document-home", tool: "bash", match: { command: { pattern: "HOME|printenv|pwd" } },
      outcome: { response: { status: "completed", exitCode: 0, stdout: "/root\n", stderr: "", truncated: false } } },
    { id: "document-list", tool: "bash", match: { command: { pattern: "\\bls\\b|\\bfind\\b|rg --files" } },
      outcome: { response: { status: "completed", exitCode: 0, stderr: "", truncated: false,
        stdout: `/root/.agents/skills/reading-documents/scripts/inspect_document.py\n` +
          `/root/.agents/skills/reading-documents/references/formats.md\n${path}\n` } } },
    // Проверка импортов/установка/ls не означает, что документ разобран.
    { id: "document-environment", tool: "bash",
      outcome: { response: { status: "completed", exitCode: 0, stdout: "", stderr: "", truncated: false } } },
    {
      id: "document-files", tool: "read_file",
      match: { filePath: { const: "/workspace/source/material/overview.md" } },
      outcome: { response: { path: "/workspace/source/material/overview.md", totalLines: 6, truncated: false,
        content: "1: # Продажи по городам\n2: | Город | Выручка |\n3: | --- | --- |\n" +
          "4: | Москва | 13010.1 |\n5: | Казань | 20500.2 |\n6: Источник прочитан целиком." } },
    },
    { id: "document-table", tool: "read_file",
      match: { filePath: { const: "/workspace/source/material/tables/data.csv" } },
      outcome: { response: { path: "/workspace/source/material/tables/data.csv", totalLines: 3, truncated: false,
        content: "Город,Выручка\nМосква,13010.1\nКазань,20500.2" } } },
    { id: "document-raw-csv", tool: "read_file",
      match: { filePath: { pattern: "\\.csv$" } },
      outcome: { response: { path, totalLines: 3, truncated: false,
        content: "Город;Выручка\nМосква;13 010,1\nКазань;20 500,2" } } },
    { id: "document-other-files", tool: "read_file", outcome: { throw: { message: "Файл не найден или не является текстовым." } } },
  ];
  // webSession добавляет безусловные stubs остальных инструментов и проверяет
  // полноту по /eve/v1/info. Ни файлов, ни настоящей песочницы у этих оценок нет.
  return webSession(t, [...stubs, blockedRead, emptySearch]);
}
