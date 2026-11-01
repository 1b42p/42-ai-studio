/** Чистые функции выбора модели: без сети и без запущенного приложения. */
import { describe, expect, test } from "vitest";

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
