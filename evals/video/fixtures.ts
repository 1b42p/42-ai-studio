import type { EveEvalContext, ToolStub } from "eve/evals";
import { blockedRead, emptySearch, isolateDownload } from "../web/fixtures";
import { resumableSession } from "../support/resumable-session";

export const VIDEO_REQUEST = "Сделай 30-секундный вертикальный ролик 9:16 о пользе утренней зарядки, без озвучки, три сцены.";
export const VIDEO_EVAL_TIMEOUT_MS = 60 * 60 * 1000;

const PROJECT = "/workspace/morning-exercise";
function videoStubs(): readonly ToolStub[] {
  return [
    { id: "isolate-question", tool: "ask_question", outcome: { response: { status: "unavailable" } } },
    // Persistent-инструмент требует безусловной подмены, иначе может стартовать копия.
    { id: "isolate-agent", tool: "agent", outcome: { throw: { message: "Этот короткий ролик собери основным агентом; делегирование в оценке отключено." } } },
    {
      id: "isolate-speak", tool: "speak",
      outcome: { response: { audioPath: `${PROJECT}/voiceover/stub.mp3`, timingsPath: `${PROJECT}/voiceover/stub.words.json`,
        voice: "ru-RU-SvetlanaNeural", language: "ru-RU", format: "mp3", durationMs: 1000,
        wordCount: 1, text: "Подмена", media: { audioId: "00000000-0000-4000-8000-000000000001" } } },
    },
    { id: "isolate-voices", tool: "list_voices", outcome: { response: { voices: [] } } },
    isolateDownload,
    blockedRead, emptySearch,
  ];
}

/** Файлы исполняются в выделенной виртуальной среде; внешние инструменты изолированы. */
export async function videoSession(t: EveEvalContext, { caseId, renderFails = false, missingEntrypoint = false }: {
  caseId: string; renderFails?: boolean; missingEntrypoint?: boolean;
}) {
  if (renderFails && missingEntrypoint) throw new Error("Choose one video eval fixture");
  const health = await t.target.fetch("/api/health");
  if (health.headers.get("x-studio-video-eval") !== "1") {
    throw new Error("Оценкам видео нужен выделенный локальный сервер с APP_VIDEO_EVAL_SANDBOX=1.");
  }
  const stubs = videoStubs();
  const response = await t.target.fetch("/eve/v1/info");
  if (!response.ok) throw new Error(`Не удалось получить инструменты для изоляции: ${response.status}`);
  const info = await response.json() as { tools?: { static?: { name: string }[]; dynamic?: unknown[] } };
  const tools = info.tools?.static;
  if (!Array.isArray(tools) || !Array.isArray(info.tools?.dynamic) ||
    !["bash", "read_file", "edit_file"].every((name) => tools.some((tool) => tool.name === name))) {
    throw new Error("Не удалось проверить инструменты целевого агента.");
  }
  const covered = new Set(stubs.filter((stub) => stub.match === undefined).map((stub) => stub.tool));
  for (const name of ["bash", "read_file", "edit_file"]) covered.add(name);
  const uncovered = tools.filter(({ name }) => !covered.has(name));
  if (uncovered.length > 0 || info.tools.dynamic.length > 0) {
    throw new Error(`Не все инструменты изолированы подменами: ${uncovered.map(({ name }) => name).join(", ")}; dynamic: ${info.tools.dynamic.length}`);
  }
  // eve__skill не подменяется: инструкции загружаются из настоящих навыков агента.
  const headers = {
    "x-studio-video-eval": renderFails ? "render-failure" : missingEntrypoint ? "missing-entrypoint" : "standard",
  };
  const session = await resumableSession(t, caseId, { stubs, headers });
  // The initiator is initialized by the first message, not session creation.
  return { send: (message: string, options?: Parameters<typeof session.send>[1]) =>
    session.send(message, { ...options, headers: { ...headers, ...options?.headers } }) };
}
