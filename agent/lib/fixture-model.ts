/**
 * Детерминированная модель для HTTP- и тестов отрисовки (`APP_TEST_MODE=1`).
 *
 * Ответ зависит только от последнего сообщения пользователя:
 *
 * - `/tool <имя> <JSON>` — вызвать инструмент с этим входом (JSON необязателен);
 *   после результата инструмента модель отвечает «готово»;
 * - `/slow <секунды> <текст>` — ответ `Эхо: <текст>` через указанное время
 *   (от 1 до 120 секунд);
 * - иначе — `Эхо: <текст>`.
 *
 * Логика вынесена в чистую функцию, чтобы проверять её без eve и сети.
 */
import type { MockModelMessage, MockModelRequest, MockModelResponse } from "eve/evals";

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

/** Разбирает последнее сообщение пользователя в команду фикстуры. */
export function parseFixtureCommand(message: string): FixtureCommand {
  if (startsWithCommand(message, "/tool")) return parseToolCommand(message);
  if (startsWithCommand(message, "/slow")) return parseSlowCommand(message);
  return { kind: "echo", text: message };
}

/**
 * Есть ли в запросе результат инструмента позже последнего сообщения
 * пользователя. Поле `toolResults` для этого не годится: оно содержит всю
 * историю, и второй `/tool` в той же сессии ответил бы «готово» без вызова.
 */
export function hasToolResultAfterLastUser(messages: readonly MockModelMessage[]): boolean {
  let lastUserIndex = -1;
  for (let index = 0; index < messages.length; index += 1) {
    if (messages[index]?.role === "user") lastUserIndex = index;
  }
  return messages.slice(lastUserIndex + 1).some((message) => message.role === "tool");
}

/**
 * Ответ фикстурной модели. Ожидание `/slow` прерывается отменой и поправкой
 * не здесь: eve перестаёт читать поток модели, а таймер дорабатывает впустую.
 */
export async function respondToFixture(request: MockModelRequest): Promise<MockModelResponse> {
  const message = request.lastUserMessage ?? "";
  const command = parseFixtureCommand(message);

  switch (command.kind) {
    case "invalid-json":
      return { text: FIXTURE_INVALID_JSON };
    case "tool":
      if (hasToolResultAfterLastUser(request.messages)) {
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
