import { defineEvalConfig } from "eve/evals";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { Experimental_DecisionLanguageModel } from "@ai-sdk/provider-utils/experimental-decision";

import { loadEvalJudgeConfig, readEvalCheckpointDirectory } from "../lib/config";
import { CheckpointStore } from "./support/checkpoint-store.mjs";
import { createCheckpointReporter } from "./support/checkpoint-reporter";

const { model: judgeModel, baseUrl: baseURL, apiKey } = loadEvalJudgeConfig();
const checkpoints = new CheckpointStore(readEvalCheckpointDirectory() ??
  resolve(".eve/evals/checkpoints", randomUUID()));

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
  setup: () => ({ checkpoints }),
  reporters: [createCheckpointReporter(checkpoints, createHash("sha256")
    .update(JSON.stringify({ model: judgeModel ?? "typesafe-ai/jev", baseURL })).digest("hex"))],
  maxConcurrency: 1,
  timeoutMs: 180_000,
  ...(judge ? { judge } : {}),
});
