import type { MockModelMessage, MockModelRequest } from "eve/evals";
import { describe, expect, test } from "vitest";

import {
  buildFixturePrompt,
  parseFixtureCommand,
  respondToFixture,
  unwrapSubagentMessage,
} from "@/agent/lib/fixture-model";

function request(messages: readonly MockModelMessage[]): MockModelRequest {
  const userMessages = messages.filter((message) => message.role === "user").map((message) => message.text);
  return {
    messages,
    userMessages,
    lastUserMessage: userMessages.at(-1) ?? null,
    userMessageCount: userMessages.length,
    tools: [],
    toolResults: [],
  };
}

describe("/prompt", () => {
  test("выводит system и user по порядку без assistant и tool", async () => {
    await expect(respondToFixture(request([
      { role: "system", text: "Правила" },
      { role: "user", text: "Привет" },
      { role: "assistant", text: "Старый вывод /prompt" },
      { role: "tool", text: "Секрет инструмента" },
      { role: "system", text: "Дополнительные правила" },
      { role: "user", text: "/prompt" },
    ]))).resolves.toEqual({
      text: "[system]\nПравила\n---\n[user]\nПривет\n---\n[system]\nДополнительные правила\n---\n[user]\n/prompt",
    });
  });

  test("не усекает system, включая динамические указания в середине", () => {
    const system = `${"а".repeat(9000)}\nОбщие указания пользователя\n${"б".repeat(9000)}`;
    expect(buildFixturePrompt([{ role: "system", text: system }])).toBe(`[system]\n${system}`);
  });

  test.each([0, 7999, 8000, 8001, 12000])("ограничивает user, длина %i", (length) => {
    const text = "я".repeat(length);
    expect(buildFixturePrompt([{ role: "user", text }])).toBe(
      `[user]\n${text.slice(0, 8000)}${length > 8000 ? `…[усечено ${length - 8000} знаков]` : ""}`,
    );
  });

  test("повтор /prompt не включает предыдущий ответ", async () => {
    const messages: MockModelMessage[] = [
      { role: "system", text: "Правила" },
      { role: "user", text: "/prompt" },
    ];
    const first = await respondToFixture(request(messages));
    const second = await respondToFixture(request([
      ...messages,
      { role: "assistant", text: first.text! },
      { role: "user", text: "/prompt" },
    ]));
    expect(second.text).toBe("[system]\nПравила\n---\n[user]\n/prompt\n---\n[user]\n/prompt");
  });

  test("команда в обёртке копии читает реальные messages", async () => {
    const wrapper = 'You are the subagent "agent".\nCaller message:\n/prompt';
    await expect(respondToFixture(request([
      { role: "system", text: "Указания для копии" },
      { role: "user", text: wrapper },
    ]))).resolves.toEqual({
      text: `[system]\nУказания для копии\n---\n[user]\n${wrapper}`,
    });
  });

  test("распознаёт границы команды", () => {
    expect(parseFixtureCommand("/prompt")).toEqual({ kind: "prompt" });
    expect(parseFixtureCommand("/prompt\n")).toEqual({ kind: "prompt" });
    expect(parseFixtureCommand("/promptly")).toEqual({ kind: "echo", text: "/promptly" });
  });
});

describe("unwrapSubagentMessage", () => {
  test.each([
    ["Caller message:\n/prompt", "/prompt"],
    ["Caller message:\nCaller message:\n/prompt", "/prompt"],
    ["Обёртка\nCaller message:\nСтарая задача\nCaller message:\n/prompt", "/prompt"],
    ["Обёртка\r\nCaller message:\r\n/tool bash {}", "/tool bash {}"],
    ["Текст с Caller message: внутри строки", "Текст с Caller message: внутри строки"],
  ])("снимает только последнюю строку-маркер: %s", (message, expected) => {
    expect(unwrapSubagentMessage(message)).toBe(expected);
  });

  test("разбор /tool и /slow сохраняется после последнего маркера", () => {
    expect(parseFixtureCommand("Копия\nCaller message:\n/tool bash {}")).toEqual({
      kind: "tool", name: "bash", input: {},
    });
    expect(parseFixtureCommand("Копия\nCaller message:\n/slow 2 текст")).toEqual({
      kind: "slow", seconds: 2, text: "текст",
    });
  });
});
