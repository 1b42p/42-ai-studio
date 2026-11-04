/** Протокол фикстурной модели: без eve и сети. */
import { afterEach, describe, expect, test, vi } from "vitest";
import type { MockModelMessage, MockModelRequest } from "eve/evals";

import {
  FIXTURE_ECHO_PREFIX,
  FIXTURE_INVALID_JSON,
  FIXTURE_TOOL_DONE,
  hasToolResultAfterLastUser,
  parseFixtureCommand,
  respondToFixture,
} from "../../agent/lib/fixture-model";

function request(
  message: string,
  messages: readonly MockModelMessage[] = [{ role: "user", text: message }],
): MockModelRequest {
  return {
    messages,
    userMessages: messages.filter((item) => item.role === "user").map((item) => item.text),
    lastUserMessage: message,
    userMessageCount: messages.filter((item) => item.role === "user").length,
    tools: [],
    toolResults: [],
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("respondToFixture", () => {
  test("обычное сообщение получает эхо", async () => {
    await expect(respondToFixture(request("привет"))).resolves.toEqual({
      text: `${FIXTURE_ECHO_PREFIX}привет`,
    });
  });

  test("/tool без JSON вызывает инструмент с пустым входом", async () => {
    await expect(respondToFixture(request("/tool get_weather"))).resolves.toEqual({
      toolCalls: [{ name: "get_weather", input: {} }],
    });
  });

  test("/tool с JSON передаёт вход инструменту", async () => {
    await expect(
      respondToFixture(request('/tool get_weather {"city":"Москва","days":3}')),
    ).resolves.toEqual({
      toolCalls: [{ name: "get_weather", input: { city: "Москва", days: 3 } }],
    });
  });

  test("/tool с неверным JSON отвечает ошибкой фикстуры", async () => {
    await expect(respondToFixture(request('/tool get_weather {"city":'))).resolves.toEqual({
      text: FIXTURE_INVALID_JSON,
    });
  });

  test("после результата инструмента модель отвечает «готово»", async () => {
    const messages: MockModelMessage[] = [
      { role: "user", text: "/tool get_weather" },
      { role: "assistant", text: "" },
      { role: "tool", text: "солнечно" },
    ];

    await expect(respondToFixture(request("/tool get_weather", messages))).resolves.toEqual({
      text: FIXTURE_TOOL_DONE,
    });
  });

  test("результат инструмента до последнего сообщения пользователя не считается", async () => {
    const messages: MockModelMessage[] = [
      { role: "user", text: "/tool get_weather" },
      { role: "tool", text: "солнечно" },
      { role: "user", text: "/tool get_weather" },
    ];

    await expect(respondToFixture(request("/tool get_weather", messages))).resolves.toEqual({
      toolCalls: [{ name: "get_weather", input: {} }],
    });
  });

  test("/slow отвечает эхом через указанное время", async () => {
    vi.useFakeTimers();
    const pending = respondToFixture(request("/slow 5 долгий ответ"));

    await vi.advanceTimersByTimeAsync(4999);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({ text: `${FIXTURE_ECHO_PREFIX}долгий ответ` });
  });

  test("/slow с секундами вне 1–120 — обычное сообщение", async () => {
    await expect(respondToFixture(request("/slow 0 привет"))).resolves.toEqual({
      text: `${FIXTURE_ECHO_PREFIX}/slow 0 привет`,
    });
    await expect(respondToFixture(request("/slow 121 привет"))).resolves.toEqual({
      text: `${FIXTURE_ECHO_PREFIX}/slow 121 привет`,
    });
  });
});

describe("parseFixtureCommand", () => {
  test("похожее на команду слово без пробела — не команда", () => {
    expect(parseFixtureCommand("/toolbox")).toEqual({ kind: "echo", text: "/toolbox" });
    expect(parseFixtureCommand("/slowdown")).toEqual({ kind: "echo", text: "/slowdown" });
  });

  test("/tool без имени — обычное сообщение", () => {
    expect(parseFixtureCommand("/tool")).toEqual({ kind: "echo", text: "/tool" });
  });
});

describe("hasToolResultAfterLastUser", () => {
  function history(messages: readonly MockModelMessage[], authored: string): MockModelRequest {
    // `userMessages` содержат только настоящие сообщения: служебные eve
    // дописывает от имени пользователя и в это поле не включает.
    return { ...request(authored, messages), userMessages: [authored] };
  }

  test("ищет результат после последнего сообщения пользователя", () => {
    expect(hasToolResultAfterLastUser(history([{ role: "user", text: "раз" }], "раз"))).toBe(false);
    expect(
      hasToolResultAfterLastUser(
        history(
          [
            { role: "user", text: "раз" },
            { role: "assistant", text: "" },
            { role: "tool", text: "результат" },
          ],
          "раз",
        ),
      ),
    ).toBe(true);
  });

  test("служебный результат задачи от имени пользователя не сбивает поиск", () => {
    const messages: MockModelMessage[] = [
      { role: "user", text: "/tool agent" },
      { role: "assistant", text: "" },
      { role: "tool", text: "задача запущена" },
      { role: "user", text: '<task_result id="t1" status="completed">готово</task_result>' },
      { role: "user", text: "[Tasks]\n<tasks />" },
    ];

    expect(hasToolResultAfterLastUser(history(messages, "/tool agent"))).toBe(true);
  });
});
