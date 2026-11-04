import { defineEvalConfig } from "eve/evals";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { Experimental_DecisionLanguageModel } from "@ai-sdk/provider-utils/experimental-decision";

import { loadEvalJudgeConfig } from "../lib/config";

const { model: judgeModel, baseUrl: baseURL, apiKey } = loadEvalJudgeConfig();

// Совместимый сервер поддерживает Chat Completions, а не нативный
// OpenAI /decisions. Это тот же публичный адаптер структурированного
// ответа, который AI SDK использует для language-model судей.
const judge = judgeModel && baseURL
  ? { model: new Experimental_DecisionLanguageModel({
      model: createOpenAICompatible({ name: "studio-eval-judge", baseURL, apiKey,
        supportsStructuredOutputs: true }).chatModel(judgeModel),
    }) }
  : judgeModel ? { model: judgeModel } : undefined;

export default defineEvalConfig({
  maxConcurrency: 1,
  timeoutMs: 180_000,
  ...(judge ? { judge } : {}),
});
