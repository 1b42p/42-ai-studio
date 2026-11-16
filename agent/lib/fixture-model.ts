/**
 * Детерминированная модель для HTTP- и тестов отрисовки (`APP_TEST_MODE=1`).
 *
 * Ответ зависит только от последнего сообщения пользователя:
 *
 * - `/tool <имя> <JSON>` — вызвать инструмент с этим входом (JSON необязателен);
 *   после результата инструмента модель отвечает «готово»;
 * - `/slow <секунды> <текст>` — ответ `Эхо: <текст>` через указанное время
 *   (от 1 до 120 секунд);
 * - `/prompt` — системные и пользовательские сообщения запроса;
 * - `/usage <вход> <кэш> <выход>` — явные счётчики провайдера;
 * - `/usage none` — провайдер без сведений о токенах;
 * - иначе — `Эхо: <текст>`.
 *
 * Логика вынесена в чистую функцию, чтобы проверять её без eve и сети.
 */
import type { MockModelMessage, MockModelRequest, MockModelResponse } from "eve/evals";
import { mockModel } from "eve/evals";

import { sleep } from "@/lib/sleep";

/** Префикс обычного ответа: по нему тесты отличают ответ модели от прочего текста. */
export const FIXTURE_ECHO_PREFIX = "Эхо: ";

/** Ответ после выполненного вызова инструмента. */
export const FIXTURE_TOOL_DONE = "готово";

/** Ответ на `/tool` с неразбираемым JSON. */
export const FIXTURE_INVALID_JSON = "Ошибка фикстуры: неверный JSON";

const SLOW_MIN_SECONDS = 1;
const SLOW_MAX_SECONDS = 120;

/** Разобранная команда фикстурной модели. */
export type FixtureCommand =
  | { readonly kind: "echo"; readonly text: string }
  | { readonly kind: "prompt" }
  | { readonly kind: "usage-none" }
  | {
      readonly kind: "usage";
      readonly inputTokens: number;
      readonly cacheReadTokens: number;
      readonly outputTokens: number;
    }
  | { readonly kind: "invalid-json" }
  | { readonly kind: "slow"; readonly seconds: number; readonly text: string }
  | { readonly kind: "tool"; readonly name: string; readonly input: unknown };

function startsWithCommand(message: string, command: string): boolean {
  if (!message.startsWith(command)) return false;
  const next = message.charAt(command.length);
  return next === "" || /\s/.test(next);
}

/** Разбирает `/tool`: имя — первое слово, остаток — JSON (или `{}`). */
function parseToolCommand(message: string): FixtureCommand {
  const rest = message.slice("/tool".length).trim();
  if (rest.length === 0) return { kind: "echo", text: message };

  const separator = rest.search(/\s/);
  const name = separator === -1 ? rest : rest.slice(0, separator);
  const rawInput = separator === -1 ? "" : rest.slice(separator).trim();
  if (rawInput.length === 0) return { kind: "tool", name, input: {} };

  try {
    return { kind: "tool", name, input: JSON.parse(rawInput) };
  } catch {
    return { kind: "invalid-json" };
  }
}

/** Разбирает `/slow`: секунды — первое слово от 1 до 120, остаток — текст. */
function parseSlowCommand(message: string): FixtureCommand {
  const rest = message.slice("/slow".length).trim();
  const separator = rest.search(/\s/);
  if (separator === -1) return { kind: "echo", text: message };

  const seconds = Number(rest.slice(0, separator));
  const text = rest.slice(separator).trim();
  if (!Number.isInteger(seconds) || seconds < SLOW_MIN_SECONDS || seconds > SLOW_MAX_SECONDS) {
    return { kind: "echo", text: message };
  }
  if (text.length === 0) return { kind: "echo", text: message };

  return { kind: "slow", seconds, text };
}

/** Маркер, которым eve предваряет сообщение вызывающего в копии агента. */
const SUBAGENT_MESSAGE_MARKER = /^Caller message:\r?\n/gm;

/**
 * Сообщение, которое копия получает от eve, обёрнуто в описание роли. Для
 * фикстурной модели важна только сама задача: иначе `Эхо:` повторяло бы всю
 * обёртку, а команда `/tool` внутри неё не распознавалась бы.
 */
export function unwrapSubagentMessage(message: string): string {
  let start = 0;
  for (const match of message.matchAll(SUBAGENT_MESSAGE_MARKER)) {
    start = match.index + match[0].length;
  }
  return message.slice(start);
}

/** Разбирает последнее сообщение пользователя в команду фикстуры. */
export function parseFixtureCommand(message: string): FixtureCommand {
  const text = unwrapSubagentMessage(message);
  if (text.trim() === "/usage none") return { kind: "usage-none" };
  const usage = /^\/usage\s+(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(text);
  if (usage !== null) {
    const [inputTokens, cacheReadTokens, outputTokens] = usage.slice(1).map(Number);
    if ([inputTokens, cacheReadTokens, outputTokens].every(Number.isSafeInteger)) {
      return { kind: "usage", inputTokens, cacheReadTokens, outputTokens };
    }
  }
  if (startsWithCommand(text, "/prompt")) return { kind: "prompt" };
  if (startsWithCommand(text, "/tool")) return parseToolCommand(text);
  if (startsWithCommand(text, "/slow")) return parseSlowCommand(text);
  return { kind: "echo", text };
}

/** Системный контекст целиком; история ответов не размножается при повторе команды. */
export function buildFixturePrompt(messages: readonly MockModelMessage[]): string {
  const userLimit = 8000;
  return messages
    .filter((message) => message.role === "system" || message.role === "user")
    .map((message) => {
      const text = message.role === "user" && message.text.length > userLimit
        ? `${message.text.slice(0, userLimit)}…[усечено ${message.text.length - userLimit} знаков]`
        : message.text;
      return `[${message.role}]\n${text}`;
    })
    .join("\n---\n");
}

/**
 * Есть ли результат инструмента после последнего сообщения пользователя.
 * Поле `toolResults` для этого не годится: оно содержит всю историю, и второй
 * `/tool` в той же сессии ответил бы «готово» без вызова.
 *
 * Сравнивать только роль «user» тоже нельзя: eve дописывает в историю
 * служебные сообщения от имени пользователя — результат задачи
 * (`<task_result …>`) и заметку `[Tasks]`. Настоящее сообщение ищем по тексту
 * из `userMessages`, где служебных сообщений нет.
 */
export function hasToolResultAfterLastUser(request: MockModelRequest): boolean {
  const lastIndex = lastAuthoredUserIndex(request);
  if (lastIndex === -1) return false;
  return request.messages.slice(lastIndex + 1).some((message) => message.role === "tool");
}

/** Индекс последнего настоящего сообщения пользователя в истории модели. */
function lastAuthoredUserIndex(request: MockModelRequest): number {
  const authored = request.userMessages.at(-1);
  if (authored === undefined) return -1;

  for (let index = request.messages.length - 1; index >= 0; index -= 1) {
    const message = request.messages[index];
    if (message === undefined) continue;
    if (message.role === "user" && message.text === authored) return index;
  }
  return -1;
}

/**
 * Ответ фикстурной модели. Ожидание `/slow` прерывается отменой и поправкой
 * не здесь: eve перестаёт читать поток модели, а таймер дорабатывает впустую.
 */
export async function respondToFixture(request: MockModelRequest): Promise<MockModelResponse> {
  const message = request.lastUserMessage ?? "";
  const command = parseFixtureCommand(message);

  switch (command.kind) {
    case "usage":
      return {
        text: `${FIXTURE_ECHO_PREFIX}${unwrapSubagentMessage(message)}`,
        usage: { inputTokens: command.inputTokens, outputTokens: command.outputTokens },
      };
    case "usage-none":
      return { text: `${FIXTURE_ECHO_PREFIX}/usage none` };
    case "prompt":
      return { text: buildFixturePrompt(request.messages) };
    case "invalid-json":
      return { text: FIXTURE_INVALID_JSON };
    case "tool":
      if (hasToolResultAfterLastUser(request)) {
        return { text: FIXTURE_TOOL_DONE };
      }
      return { toolCalls: [{ name: command.name, input: command.input }] };
    case "slow":
      await sleep(command.seconds * 1000);
      return { text: `${FIXTURE_ECHO_PREFIX}${command.text}` };
    case "echo":
      return { text: `${FIXTURE_ECHO_PREFIX}${command.text}` };
  }
}

type FixtureModel = Extract<ReturnType<typeof mockModel>, { specificationVersion: "v4" }>;
type ProviderUsage = Awaited<ReturnType<FixtureModel["doGenerate"]>>["usage"];

function fixtureMock(respond: typeof respondToFixture): FixtureModel {
  const model = mockModel(respond);
  if (typeof model === "string" || model.specificationVersion !== "v4") {
    throw new Error("Фикстурной модели нужен mockModel с протоколом v4.");
  }
  return model;
}

function fixtureProviderUsage(command: FixtureCommand): ProviderUsage | undefined {
  if (command.kind !== "usage" && command.kind !== "usage-none") return undefined;
  const explicit = command.kind === "usage" ? command : undefined;
  return {
    inputTokens: {
      total: explicit?.inputTokens,
      noCache: explicit === undefined ? undefined : Math.max(0, explicit.inputTokens - explicit.cacheReadTokens),
      cacheRead: explicit?.cacheReadTokens,
      cacheWrite: explicit === undefined ? undefined : 0,
    },
    outputTokens: {
      total: explicit?.outputTokens,
      text: explicit?.outputTokens,
      reasoning: explicit === undefined ? undefined : 0,
    },
  };
}

/**
 * mockModel 0.83 оценивает отсутствующий usage и не принимает кэш.
 * Меняем только usage результата SDK, сохраняя штатные ответы и идентичность
 * mockModel. Отдельный delegate на вызов исключает гонки счётчиков.
 */
export function createFixtureModel(): FixtureModel {
  const model = fixtureMock(respondToFixture);
  function createCall() {
    let usage: ProviderUsage | undefined;
    const delegate = fixtureMock((request) => {
      usage = fixtureProviderUsage(parseFixtureCommand(request.lastUserMessage ?? ""));
      return respondToFixture(request);
    });
    return { delegate, usage: () => usage };
  }

  model.doGenerate = async (options) => {
    const call = createCall();
    const result = await call.delegate.doGenerate(options);
    const usage = call.usage();
    return usage === undefined ? result : { ...result, usage };
  };
  model.doStream = async (options) => {
    const call = createCall();
    const result = await call.delegate.doStream(options);
    const usage = call.usage();
    if (usage === undefined) return result;
    return {
      ...result,
      stream: result.stream.pipeThrough(new TransformStream({
        transform(part, controller) {
          controller.enqueue(part.type === "finish" ? { ...part, usage } : part);
        },
      })),
    };
  };
  return model;
}
