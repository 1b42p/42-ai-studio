/**
 * Состояние копии агента для карточки и панели (#12).
 *
 * Копию открывает встроенный инструмент `agent`: каждый вызов — задача, а её
 * итог приходит событием `task.settled`. Подробный ход копии лежит не в потоке
 * корня, а в `data.agents[sessionId].observation` (его наполняет
 * `useEveAgent({ followSubagents: true })`). Здесь только чтение состояния —
 * без React и сети, поэтому разбор проверяется тестами отдельно.
 */
import {
  openConversationInputs,
  toolCallState,
  type AgentObservation,
  type ConversationAgentSession,
  type ConversationState,
  type ConversationTask,
  type ConversationTaskCall,
  type EveDynamicToolPart,
  type EveMessagePart,
} from "eve/react";

/** Что показывает карточка: копия запускается, работает или закончила. */
export type CopyStatus = "starting" | "running" | "completed" | "failed" | "cancelled";

export interface CopyCall {
  /** Задача вызова; у вызова без квитанции ещё пусто. */
  readonly taskId: string | null;
  readonly status: CopyStatus;
  /** Итог копии из `task.settled`; пустая строка, пока его нет. */
  readonly output: string;
  /** Текст ошибки задачи; пустая строка, если её нет. */
  readonly error: string;
  /** `input.message` вызова: что копия получила на вход. */
  readonly task: string;
  /** Сессия копии в eve; `null`, пока `agent.started` не пришёл. */
  readonly sessionId: string | null;
  /** Наблюдение за ходом копии; `null` без `followSubagents` и до `agent.started`. */
  readonly observation: AgentObservation | null;
  /** Беседа копии, пока за ней следят; `null` — ход недоступен. */
  readonly conversation: ConversationState | null;
  /** Копия задала вопрос и ждёт ответа в основном чате. */
  readonly awaitingInput: boolean;
  /** Краткое описание последнего действия копии. */
  readonly action: string | null;
}

/** Сколько символов итога видно в свёрнутой строке карточки. */
export const COPY_OUTPUT_PREVIEW = 120;
/** Сколько символов действия копии видно в поле «Сейчас». */
const COPY_ACTION_PREVIEW = 80;
/** Сколько символов команды видно в поле «Сейчас». */
const COPY_COMMAND_PREVIEW = 60;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

/** Одна строка текста не длиннее `limit` символов. */
export function shorten(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= limit) return flat;
  return `${flat.slice(0, limit).trimEnd()}…`;
}

/** Вызов задачи, к которому относится часть сообщения. */
export function findCopyTask(
  data: ConversationState,
  callId: string,
): { readonly taskId: string; readonly task: ConversationTask } | null {
  for (const [taskId, task] of Object.entries(data.tasks)) {
    if (task.calls[callId] !== undefined) return { taskId, task };
  }
  return null;
}

/** Сессия копии, открытая задачей; у продолжения задачи новая не появляется. */
export function findCopySession(
  data: ConversationState,
  taskId: string,
): ConversationAgentSession | null {
  for (const session of Object.values(data.agents)) {
    if (session.taskId === taskId) return session;
  }
  return null;
}

/** Итог задачи: текст копии или пустая строка. JSON в интерфейс не попадает. */
function textOfOutput(output: unknown): string {
  if (typeof output === "string") return output;
  if (isRecord(output) && typeof output.text === "string") return output.text;
  return "";
}

function statusOfCall(call: ConversationTaskCall): CopyStatus {
  switch (call.status) {
    case "working":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
  }
}

/** Статус без записи задачи: вызов ещё идёт или оборвался вместе с ходом. */
function statusOfPart(data: ConversationState, part: EveDynamicToolPart): CopyStatus {
  const state = toolCallState(data, part.toolCallId);
  switch (state?.status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
    case "rejected":
    case "interrupted":
      return "cancelled";
    default:
      return "running";
  }
}

/** Сообщение, которое копия получила от родителя. */
function taskOfPart(part: EveDynamicToolPart): string {
  if (!isRecord(part.input)) return "";
  const message = part.input.message;
  return typeof message === "string" ? message : "";
}

/** Имя файла из входа `edit_file`: в интерфейсе показывается только оно. */
function editedName(input: unknown): string | null {
  if (!isRecord(input)) return null;
  for (const key of ["filePath", "path", "fileName"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim().length > 0) {
      const parts = value.split("/");
      return parts.at(-1) ?? null;
    }
  }
  return null;
}

/** Описание одного вызова копии в поле «Сейчас». */
function describeToolPart(part: EveMessagePart & { type: "dynamic-tool" }): string | null {
  const name = part.toolMetadata?.eve?.name ?? part.toolName;
  const label = part.toolMetadata?.eve?.label;

  if (name === "bash" && isRecord(part.input) && typeof part.input.command === "string") {
    return `Команда: ${shorten(part.input.command, COPY_COMMAND_PREVIEW)}`;
  }

  if ((name === "edit_file" || name === "write_file") && editedName(part.input) !== null) {
    return `Правка ${editedName(part.input)}`;
  }

  return label === undefined || label.trim().length === 0 ? null : label;
}

/**
 * Беседа копии, пока за ней следят. `not-followed` и `unavailable` её не
 * показывают: тогда в панели написано «Ход копии недоступен».
 */
function copyConversation(observation: AgentObservation | null): ConversationState | null {
  if (observation === null) return null;
  if (observation.status === "following" || observation.status === "idle") {
    return observation.conversation;
  }
  return null;
}

/**
 * Краткое описание последнего действия копии: последний блок последнего
 * сообщения копии. Пока копия ничего не написала, описания нет.
 */
export function copyAction(conversation: ConversationState | null): string | null {
  if (conversation === null) return null;

  const message = conversation.messages.findLast((item) => item.role === "assistant");
  const part = message?.parts.at(-1);
  if (part === undefined) return null;

  if (part.type === "text") {
    return part.text.trim().length === 0 ? null : shorten(part.text, COPY_ACTION_PREVIEW);
  }
  if (part.type === "dynamic-tool") return describeToolPart(part);
  return null;
}

/** Всё, что нужно карточке и панели о вызове копии. */
export function readCopyCall(data: ConversationState, part: EveDynamicToolPart): CopyCall {
  const found = findCopyTask(data, part.toolCallId);
  const call = found === null ? undefined : found.task.calls[part.toolCallId];
  const session = found === null ? null : findCopySession(data, found.taskId);
  const observation = session?.observation ?? null;
  const conversation = copyConversation(observation);

  const status = call === undefined ? statusOfPart(data, part) : statusOfCall(call);
  const awaitingInput =
    found !== null &&
    openConversationInputs(data).some((input) => input.taskId === found.taskId);

  return {
    taskId: found?.taskId ?? null,
    // Пока `agent.started` не пришёл, сессии копии ещё нет: она запускается.
    status: status === "running" && session === null ? "starting" : status,
    output: call === undefined ? "" : textOfOutput(call.output),
    error: call?.error?.message ?? "",
    task: taskOfPart(part),
    sessionId: session?.sessionId ?? null,
    observation,
    conversation,
    awaitingInput,
    action: copyAction(conversation),
  };
}

/** Что написано в заголовке карточки для каждого состояния копии. */
const COPY_TITLES: Record<CopyStatus, string> = {
  starting: "Копия агента",
  running: "Копия агента",
  completed: "Копия завершила работу",
  failed: "Копия завершилась ошибкой",
  cancelled: "Копия остановлена",
};

/** Состояние копии одним словом для шапки панели. */
const COPY_STATUS_WORDS: Record<CopyStatus, string> = {
  starting: "Запускается…",
  running: "Работает",
  completed: "Завершила работу",
  failed: "Завершилась ошибкой",
  cancelled: "Остановлена",
};

/** Заголовок карточки: что делает или сделала копия. */
export function copyTitle(call: CopyCall): string {
  return COPY_TITLES[call.status];
}

/** Строка после заголовка: действие, ожидание ответа или начало итога. */
export function copyDescription(call: CopyCall): string | null {
  if (call.status === "starting") return "Запускается…";
  if (call.status === "running") {
    if (call.awaitingInput) return "Ждёт ответа";
    return call.action === null ? "Работает" : `Сейчас: ${call.action}`;
  }
  if (call.status === "completed") {
    return call.output.trim().length === 0 ? null : shorten(call.output, COPY_OUTPUT_PREVIEW);
  }
  if (call.status === "failed") {
    return call.error.trim().length === 0 ? null : shorten(call.error, COPY_OUTPUT_PREVIEW);
  }
  return null;
}

/** Слово состояния копии в шапке панели. */
export function copyStatusText(call: CopyCall): string {
  if (call.status === "running" && call.awaitingInput) return "Ждёт ответа";
  return COPY_STATUS_WORDS[call.status];
}

/**
 * Готова ли беседа копии к показу. Пока `agent.started` не пришёл, копия
 * запускается; если вызов уже завершился без сессии копии, показывать нечего.
 *
 * `idle` с пустой беседой — не загрузка: eve уже догнал поток и больше ничего
 * не пришлёт (так бывает у остановленной копии), поэтому это недоступный ход,
 * а не вечный скелет.
 */
export function copyConversationState(call: CopyCall): "loading" | "ready" | "unavailable" {
  if (call.status === "starting") return "loading";
  if (call.sessionId === null || call.observation === null) {
    return call.status === "running" ? "loading" : "unavailable";
  }
  if (call.conversation === null) return "unavailable";
  if (call.observation.status === "idle" && call.conversation.messages.length === 0) {
    return "unavailable";
  }
  return "ready";
}
