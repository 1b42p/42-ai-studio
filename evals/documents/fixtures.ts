import type { EveEvalContext, ToolStub } from "eve/evals";
import { blockedRead, emptySearch, webSession } from "../web/fixtures";

export async function documentSession(t: EveEvalContext, path: string) {
  const stubs: ToolStub[] = [
    {
      id: "document-commands", tool: "bash",
      outcome: { response: { status: "completed", exitCode: 0, truncated: false,
        stdout: `Источник ${path} прочитан. Полный текст: /workspace/source/material/overview.md. ` +
          "Таблицы: /workspace/source/material/tables/data.csv. " +
          "Москва: 13010.1, Казань: 20500.2. Нужны параметры ролика.", stderr: "" } },
    },
    {
      id: "document-files", tool: "read_file",
      outcome: { response: { path: "/workspace/source/material/overview.md", totalLines: 6, truncated: false,
        content: "1: # Продажи по городам\n2: | Город | Выручка |\n3: | --- | --- |\n" +
          "4: | Москва | 13010.1 |\n5: | Казань | 20500.2 |\n6: Источник прочитан целиком." } },
    },
  ];
  // webSession добавляет безусловные stubs остальных инструментов и проверяет
  // полноту по /eve/v1/info. Ни файлов, ни настоящей песочницы у этих оценок нет.
  return webSession(t, [...stubs, blockedRead, emptySearch]);
}
