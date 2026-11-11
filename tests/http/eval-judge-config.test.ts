/** Конфигурация и настоящий адаптер судьи; запросы провайдера перехватываются без сети. */
import { afterEach, describe, expect, test, vi } from "vitest";

import { parseEvalJudgeConfig, type EnvRecord } from "../../lib/config";

const judgeEnvironment = vi.hoisted(() => ({ current: {} as EnvRecord }));

vi.mock("../../lib/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/config")>();
  return {
    ...actual,
    loadEvalJudgeConfig: () => actual.parseEvalJudgeConfig(judgeEnvironment.current),
    readEvalCheckpointDirectory: () => undefined,
  };
});

async function loadJudge(env: EnvRecord) {
  judgeEnvironment.current = env;
  vi.resetModules();
  return (await import("../../evals/evals.config")).default.judge?.model;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("протокол судьи eve eval", () => {
  test("по умолчанию использует openai, пустая настройка равна отсутствующей", () => {
    expect(parseEvalJudgeConfig({}).api).toBe("openai");
    expect(parseEvalJudgeConfig({ AGENT_MODEL_API: "   " }).api).toBe("openai");
  });

  test("читает Anthropic без конфигурации приложения и окна контекста агента", () => {
    expect(parseEvalJudgeConfig({
      EVAL_JUDGE_MODEL: " judge-test ",
      AGENT_MODEL_API: " anthropic ",
      AGENT_MODEL_BASE_URL: " https://api.example.com/v1 ",
      AGENT_MODEL_API_KEY: " judge-test-key ",
      DATABASE_URL: "not-a-url",
      SESSION_SECRET: "short",
      AGENT_MODEL_CONTEXT_TOKENS: "not-a-number",
    })).toEqual({
      model: "judge-test",
      api: "anthropic",
      baseUrl: "https://api.example.com/v1",
      apiKey: "judge-test-key",
    });
  });

  test("отвергает неизвестный протокол, называя переменную", () => {
    expect(() => parseEvalJudgeConfig({ AGENT_MODEL_API: "unknown" }))
      .toThrow("AGENT_MODEL_API");
  });

  test("выбранному Anthropic-судье нужны адрес и ключ", () => {
    expect(() => parseEvalJudgeConfig({
      EVAL_JUDGE_MODEL: "judge-test", AGENT_MODEL_API: "anthropic",
    })).toThrow("AGENT_MODEL_BASE_URL");
    expect(() => parseEvalJudgeConfig({
      EVAL_JUDGE_MODEL: "judge-test",
      AGENT_MODEL_API: "anthropic",
      AGENT_MODEL_BASE_URL: "https://api.example.com/v1",
    })).toThrow("AGENT_MODEL_API_KEY");
  });

  test("без выбранного судьи сохраняет умолчание eve даже при Anthropic", async () => {
    expect(await loadJudge({ AGENT_MODEL_API: "anthropic" })).toBeUndefined();
  });

  test("без пользовательского адреса сохраняет строковую модель Gateway", async () => {
    expect(await loadJudge({ EVAL_JUDGE_MODEL: "typesafe-ai/jev" }))
      .toBe("typesafe-ai/jev");
  });

  test.each([
    { api: undefined, path: "/chat/completions", header: "authorization", credential: "Bearer judge-test-key" },
    { api: "openai", path: "/chat/completions", header: "authorization", credential: "Bearer judge-test-key" },
    { api: "anthropic", path: "/messages", header: "x-api-key", credential: "judge-test-key" },
  ])("протокол $api отправляет решение на $path с заданным ключом", async ({ api, path, header, credential }) => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      expect(request.model).toBe("judge-test");
      if (api === "anthropic") {
        const jsonTool = request.tools?.some((entry: { name: string }) => entry.name === "json");
        return Response.json({
          id: "msg-judge", type: "message", role: "assistant", model: "judge-test",
          content: jsonTool
            ? [{ type: "tool_use", id: "tool-json", name: "json", input: { q0: 0.75 } }]
            : [{ type: "text", text: '{"q0":0.75}' }],
          stop_reason: jsonTool ? "tool_use" : "end_turn", stop_sequence: null,
          usage: { input_tokens: 3, output_tokens: 4 },
        });
      }
      expect(request.response_format.type).toBe("json_schema");
      return Response.json({
        id: "chat-judge", object: "chat.completion", created: 1, model: "judge-test",
        choices: [{ index: 0, message: { role: "assistant", content: '{"q0":0.75}' }, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
      });
    });

    const judge = await loadJudge({
      EVAL_JUDGE_MODEL: "judge-test",
      AGENT_MODEL_API: api,
      AGENT_MODEL_BASE_URL: "https://api.example.com/custom/v1",
      AGENT_MODEL_API_KEY: "judge-test-key",
    });
    if (!judge || typeof judge === "string" || !("doDecide" in judge)) {
      throw new Error("Ожидался адаптер решений судьи");
    }
    const result = await judge.doDecide({
      state: [{ type: "json", value: { response: "Готово" } }],
      questions: { correct: { type: "boolean", instructions: "Ответ корректен?" } },
    });

    expect(result.answers.correct).toEqual({ type: "boolean", probability: 0.75 });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(String(url)).toBe(`https://api.example.com/custom/v1${path}`);
    expect(new Headers(init?.headers).get(header)).toBe(credential);
  });
});
