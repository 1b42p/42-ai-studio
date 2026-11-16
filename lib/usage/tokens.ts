/** Usage провайдера; отсутствующий счётчик не равен сообщённому нулю. */
export interface ModelTokenUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly inputTokenDetails?: {
    readonly cacheReadTokens?: number;
    readonly cacheWriteTokens?: number;
  };
}

export interface ModelTokenAmount {
  readonly kind: "model_input_tokens" | "model_output_tokens";
  readonly amount: number;
}

function isTokenCount(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0;
}

/** Только новые входные токены; запись кэша уже включена в общий вход. */
export function modelTokenAmounts(usage: ModelTokenUsage | undefined): ModelTokenAmount[] {
  if (usage === undefined) return [];
  const amounts: ModelTokenAmount[] = [];
  const cacheReadTokens = usage.inputTokenDetails?.cacheReadTokens ?? 0;
  if (isTokenCount(usage.inputTokens) && isTokenCount(cacheReadTokens)) {
    const amount = Math.max(0, usage.inputTokens - cacheReadTokens);
    if (amount > 0) amounts.push({ kind: "model_input_tokens", amount });
  }
  if (isTokenCount(usage.outputTokens) && usage.outputTokens > 0) {
    amounts.push({ kind: "model_output_tokens", amount: usage.outputTokens });
  }
  return amounts;
}
