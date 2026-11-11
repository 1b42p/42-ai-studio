/**
 * Выбор модели агента по окружению. Живой объект модели допустим только
 * в обработчике `step.started`: на `session.started` и `turn.started` eve
 * принимает лишь строку, а обычная строка с `process.env` запеклась бы при
 * сборке. Поэтому выбор — чистая функция: её проверяет тест без сети.
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { simulateStreamingMiddleware, wrapLanguageModel, type LanguageModel } from "ai";
import { mockModel } from "eve/evals";

import type { AgentReasoning } from "@/lib/config";
import { respondToFixture } from "./fixture-model";

/** Имя провайдера для OpenAI-совместимого API: не `openai`, иначе eve включит нативные инструменты OpenAI. */
export const OPENAI_COMPATIBLE_PROVIDER = "studio";

/** Окно контекста фикстурной модели: без него eve ищет `eve-mock/model` в каталоге AI Gateway. */
export const FIXTURE_CONTEXT_TOKENS = 1_000_000;

/** Поля конфигурации, от которых зависит выбор модели. */
export interface AgentModelConfig {
  readonly appTestMode: boolean;
  readonly agentModel: string | undefined;
  readonly agentModelBaseUrl: string | undefined;
  readonly agentModelApiKey: string | undefined;
  readonly agentModelContextTokens: number | undefined;
  readonly agentModelStreaming: boolean;
  /** `openai` — Chat Completions; `anthropic` — Messages API того же базового URL. */
  readonly agentModelApi: "openai" | "anthropic";
  readonly agentReasoning: AgentReasoning;
}

/** Выбор модели для обработчика `step.started`. */
export interface AgentModelSelection {
  readonly model: LanguageModel;
  readonly reasoning?: AgentReasoning;
  readonly modelContextWindowTokens?: number;
}

/** Понятная ошибка вместо невнятного отказа модели. */
export class AgentModelConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentModelConfigError";
  }
}

const MISSING_MODEL_MESSAGE =
  "Не задана переменная окружения AGENT_MODEL: без неё агент не может выбрать модель. " +
  "Укажите её в .env (или включите APP_TEST_MODE=1 для фикстурной модели).";

/**
 * Выбирает модель по конфигурации:
 *
 * - `APP_TEST_MODE=1` — фикстурная модель с окном контекста;
 * - задан `AGENT_MODEL_BASE_URL` — модель OpenAI-совместимого провайдера;
 * - иначе — строка `AGENT_MODEL` для AI Gateway.
 */
export function selectAgentModel(config: AgentModelConfig): AgentModelSelection {
  if (config.appTestMode) {
    return {
      model: mockModel(respondToFixture),
      modelContextWindowTokens: FIXTURE_CONTEXT_TOKENS,
    };
  }

  if (config.agentModel === undefined) {
    throw new AgentModelConfigError(MISSING_MODEL_MESSAGE);
  }

  if (config.agentModelBaseUrl !== undefined || config.agentModelApi === "anthropic") {
    if (config.agentModelBaseUrl === undefined) {
      throw new AgentModelConfigError(
        "Не задана переменная окружения AGENT_MODEL_BASE_URL: она нужна для AGENT_MODEL_API=anthropic.",
      );
    }
    if (config.agentModelApiKey === undefined) {
      throw new AgentModelConfigError(
        "Не задана переменная окружения AGENT_MODEL_API_KEY: она нужна вместе с AGENT_MODEL_BASE_URL.",
      );
    }
    if (config.agentModelContextTokens === undefined) {
      throw new AgentModelConfigError(
        "Не задана переменная окружения AGENT_MODEL_CONTEXT_TOKENS: без размера окна контекста " +
          "eve не сможет сжимать историю модели по AGENT_MODEL_BASE_URL.",
      );
    }

    const model = config.agentModelApi === "anthropic"
      ? createAnthropic({
        baseURL: config.agentModelBaseUrl,
        apiKey: config.agentModelApiKey,
      })(config.agentModel)
      : createOpenAICompatible({
        name: OPENAI_COMPATIBLE_PROVIDER,
        baseURL: config.agentModelBaseUrl,
        apiKey: config.agentModelApiKey,
        includeUsage: true,
      })(config.agentModel);

    return {
      model: config.agentModelStreaming ? model : wrapLanguageModel({
        model, middleware: simulateStreamingMiddleware(),
      }),
      reasoning: config.agentReasoning,
      modelContextWindowTokens: config.agentModelContextTokens,
    };
  }

  if (!config.agentModelStreaming) {
    throw new AgentModelConfigError("AGENT_MODEL_STREAMING=false поддерживается только с AGENT_MODEL_BASE_URL.");
  }

  return {
    model: config.agentModel,
    reasoning: config.agentReasoning,
  };
}
