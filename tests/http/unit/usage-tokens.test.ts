import { describe, expect, test } from "vitest";

import { createFixtureModel, parseFixtureCommand } from "../../../agent/lib/fixture-model";
import { modelTokenAmounts } from "../../../lib/usage/tokens";

describe("новые токены модели", () => {
  test("из 1000 входных токенов исключает 400 прочитанных из кэша", () => {
    expect(modelTokenAmounts({
      inputTokens: 1000,
      inputTokenDetails: { cacheReadTokens: 400, cacheWriteTokens: 200 },
      outputTokens: 80,
    })).toEqual([
      { kind: "model_input_tokens", amount: 600 },
      { kind: "model_output_tokens", amount: 80 },
    ]);
  });

  test("чтение кэша больше входа не создаёт отрицательный расход", () => {
    expect(modelTokenAmounts({
      inputTokens: 100,
      inputTokenDetails: { cacheReadTokens: 400 },
      outputTokens: 20,
    })).toEqual([{ kind: "model_output_tokens", amount: 20 }]);
  });

  test("отсутствующее поле и нулевой вывод не создают записи", () => {
    expect(modelTokenAmounts({ outputTokens: 0 })).toEqual([]);
    expect(modelTokenAmounts({ inputTokenDetails: { cacheReadTokens: 400 } })).toEqual([]);
    expect(modelTokenAmounts({})).toEqual([]);
    expect(modelTokenAmounts(undefined)).toEqual([]);
  });

  test("без данных о кэше учитывает весь вход, без данных о выводе — только вход", () => {
    expect(modelTokenAmounts({ inputTokens: 123 })).toEqual([
      { kind: "model_input_tokens", amount: 123 },
    ]);
  });

  test("не записывает недопустимые счётчики провайдера", () => {
    for (const inputTokens of [-1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(modelTokenAmounts({ inputTokens, outputTokens: 0 })).toEqual([]);
    }
  });
});

describe("usage фикстурной модели", () => {
  test("распознаёт команду и внутри обёртки копии", () => {
    expect(parseFixtureCommand("Caller message:\n/usage 1000 400 80")).toEqual({
      kind: "usage", inputTokens: 1000, cacheReadTokens: 400, outputTokens: 80,
    });
    expect(parseFixtureCommand("/usage none")).toEqual({ kind: "usage-none" });
    expect(parseFixtureCommand("/usage -1 0 0").kind).toBe("echo");
  });

  test("настоящий поток SDK передаёт явно заданный кэш", async () => {
    const result = await createFixtureModel().doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "/usage 1000 400 80" }] }],
    });
    const reader = result.stream.getReader();
    let usage;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      if (next.value.type === "finish") usage = next.value.usage;
    }
    expect(usage).toMatchObject({
      inputTokens: { total: 1000, cacheRead: 400 },
      outputTokens: { total: 80 },
    });
  });

  test("none не подставляет оценённые mockModel счётчики", async () => {
    const result = await createFixtureModel().doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "/usage none" }] }],
    });
    expect(result.usage.inputTokens.total).toBeUndefined();
    expect(result.usage.outputTokens.total).toBeUndefined();
    expect(result.content).toContainEqual({ type: "text", text: "Эхо: /usage none" });
  });
});
