/** Чистые функции выбора модели: без сети и без запущенного приложения. */
import { describe, expect, test, vi } from "vitest";
import { jsonSchema, streamText, tool } from "ai";

import {
  AgentModelConfigError,
  FIXTURE_CONTEXT_TOKENS,
  OPENAI_COMPATIBLE_PROVIDER,
  selectAgentModel,
  type AgentModelConfig,
} from "../../agent/lib/agent-model";

function config(overrides: Partial<AgentModelConfig> = {}): AgentModelConfig {
  return {
    appTestMode: false,
    agentModel: "openai/gpt-6-luna-fast",
    agentModelBaseUrl: undefined,
    agentModelApiKey: undefined,
    agentModelContextTokens: undefined,
    agentModelStreaming: true,
    agentModelApi: "openai",
    agentReasoning: "high",
    ...overrides,
  };
}

describe("selectAgentModel", () => {
  test("в тестовом режиме даёт фикстурную модель с окном контекста", () => {
    const selection = selectAgentModel(config({ appTestMode: true }));

    expect(selection.modelContextWindowTokens).toBe(FIXTURE_CONTEXT_TOKENS);
    expect(selection.reasoning).toBeUndefined();
    expect(selection.model).toMatchObject({ provider: "eve-mock" });
  });

  test("с AGENT_MODEL_BASE_URL даёт модель OpenAI-совместимого провайдера", () => {
    const selection = selectAgentModel(
      config({
        agentModel: "своя-модель",
        agentModelBaseUrl: "https://api.example.com/v1",
        agentModelApiKey: "ключ",
        agentModelContextTokens: 128000,
        agentReasoning: "medium",
      }),
    );

    const model = selection.model as { provider: string; modelId: string };
    expect(model.provider).toContain(OPENAI_COMPATIBLE_PROVIDER);
    expect(model.provider).not.toBe("openai");
    expect(model.modelId).toBe("своя-модель");
    expect(selection.reasoning).toBe("medium");
    expect(selection.modelContextWindowTokens).toBe(128000);
  });

  test("без AGENT_MODEL_BASE_URL возвращает строку для AI Gateway", () => {
    const selection = selectAgentModel(config({ agentReasoning: "low" }));

    expect(selection).toEqual({
      model: "openai/gpt-6-luna-fast",
      reasoning: "low",
    });
  });

  test("обычный ответ провайдера сохраняет аргументы инструментов в потоке eve", async () => {
    const requests: Record<string, unknown>[] = [];
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      requests.push(request);
      const call = { id: "call-command", type: "function", function: { name: "bash", arguments: '{"command":"printf ok"}' } };
      if (request.stream) {
        const chunk = { id: "chat-test", object: "chat.completion.chunk", created: 1, model: "test-model",
          choices: [{ index: 0, delta: { tool_calls: [{ ...call, index: 0, function: { ...call.function, arguments: "" } }] }, finish_reason: "tool_calls" }] };
        return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
      }
      return Response.json({ id: "chat-test", object: "chat.completion", created: 1, model: "test-model",
        choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [call] }, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } });
    });
    try {
      const { model } = selectAgentModel(config({ agentModelBaseUrl: "https://api.example.com/v1", agentModelApiKey: "test-key",
        agentModelContextTokens: 128000, agentModelStreaming: false }));
      const result = streamText({ model, prompt: "Вызови bash", maxRetries: 0,
        tools: { bash: tool({ inputSchema: jsonSchema<{ command: string }>({ type: "object",
          properties: { command: { type: "string" } }, required: ["command"], additionalProperties: false }) }) } });
      expect(await result.toolCalls).toMatchObject([{ toolName: "bash", input: { command: "printf ok" } }]);
      expect(requests).toHaveLength(1);
      expect(requests[0].stream).not.toBe(true);
      expect((await result.usage).outputTokens).toBe(4);
    } finally { fetch.mockRestore(); }
  });

  test("AGENT_MODEL_API=anthropic выбирает Messages API того же адреса", () => {
    const selection = selectAgentModel(
      config({
        agentModel: "claude-haiku-5-5",
        agentModelBaseUrl: "https://api.example.com/v1",
        agentModelApiKey: "ключ",
        agentModelContextTokens: 200000,
        agentModelApi: "anthropic",
      }),
    );
    const model = selection.model as { provider: string; modelId: string };
    expect(model.provider).toContain("anthropic");
    expect(model.provider).not.toBe("openai");
    expect(model.modelId).toBe("claude-haiku-5-5");
  });

  test("anthropic без базового адреса называет AGENT_MODEL_BASE_URL", () => {
    expect(() =>
      selectAgentModel(config({ agentModelApi: "anthropic", agentModel: "claude-haiku-5-5" })),
    ).toThrow(/AGENT_MODEL_BASE_URL/);
  });

  test("без AGENT_MODEL ошибка на русском называет переменную", () => {
    expect(() => selectAgentModel(config({ agentModel: undefined }))).toThrow(
      AgentModelConfigError,
    );
    expect(() => selectAgentModel(config({ agentModel: undefined }))).toThrow(/AGENT_MODEL/);
  });

  test("без ключа и окна контекста ошибки называют свои переменные", () => {
    expect(() =>
      selectAgentModel(
        config({ agentModelBaseUrl: "https://api.example.com/v1", agentModelContextTokens: 128000 }),
      ),
    ).toThrow(/AGENT_MODEL_API_KEY/);

    expect(() =>
      selectAgentModel(
        config({ agentModelBaseUrl: "https://api.example.com/v1", agentModelApiKey: "ключ" }),
      ),
    ).toThrow(/AGENT_MODEL_CONTEXT_TOKENS/);
  });
});
