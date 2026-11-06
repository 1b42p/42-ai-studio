import type { EveEvalContext, EveEvalSession, EveEvalTurn } from "eve/evals";
import type { CheckpointStore } from "./checkpoint-store.mjs";

type SessionOptions = Parameters<EveEvalContext["session"]>[0];
type TurnOptions = Parameters<EveEvalSession["send"]>[1];

async function observeDelivery<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    throw new Error(`Checkpoint pending: Не удалось подтвердить доставку или дочитать ход: ${
      error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

/** Повторное чтение принятого хода не отправляет его модели ещё раз. */
export async function resumableSession(t: EveEvalContext, caseId: string, options?: SessionOptions) {
  const store = (t.context as { checkpoints?: CheckpointStore } | undefined)?.checkpoints;
  let progress = await store?.readProgress(caseId);
  let session: EveEvalSession | undefined;
  let turnIndex = 0;
  if (!progress) {
    session = await t.session(options);
    progress = { sessionId: session.sessionId, turns: [] };
    await store?.writeProgress(caseId, progress);
  }
  const saved = progress;
  async function verifyStubs() {
    if (!options?.stubs) return;
    const response = await t.target.fetch(`/eve/v1/session/${encodeURIComponent(saved.sessionId)}/stubs`, {
      headers: options.headers, signal: t.signal,
    });
    if (!response.ok) throw new Error(`Не удалось проверить подмены сессии: HTTP ${response.status}.`);
    const status = await response.json() as { error?: unknown; matchedRuleIds?: unknown };
    if (status.error !== null || !Array.isArray(status.matchedRuleIds) ||
      !status.matchedRuleIds.every((id) => typeof id === "string")) {
      throw new Error(`Проверка подмен сессии не пройдена: ${String(status.error ?? "некорректный ответ")}.`);
    }
  }
  return {
    async send(message: string, turnOptions?: TurnOptions): Promise<EveEvalTurn> {
      const recorded = saved.turns[turnIndex];
      if (recorded) {
        if (recorded.message !== message) {
          throw new Error(`Просьба хода ${turnIndex + 1} изменилась; checkpoint ${caseId} не переиспользуется.`);
        }
        if (recorded.phase === "sending") {
          throw new Error(`Checkpoint pending: Не подтверждена доставка хода ${turnIndex + 1} сессии ${saved.sessionId}. ` +
            "Проверьте её сохранённый поток; повторная отправка автоматически запрещена.");
        }
        const turn = await observeDelivery(() => t.target.watchTurn(saved.sessionId, { startIndex: recorded.startIndex }).result());
        const received = turn.events.find((event) => event.type === "message.received");
        if (received?.type !== "message.received" || received.data.message !== message ||
          received.meta.id !== recorded.receivedEventId) {
          throw new Error(`Checkpoint pending: Поток сессии ${saved.sessionId} не соответствует сохранённому ходу.`);
        }
        session = turn.session;
        await verifyStubs();
        recorded.phase = "settled";
        await store?.writeProgress(caseId, saved);
        turnIndex++;
        return turn;
      }
      if (!session) {
        throw new Error(`Checkpoint pending: Сессия ${saved.sessionId} сохранена до первого хода. ` +
          "Нужно восстановить её состояние, а не создавать новую сессию.");
      }
      const entry = { message, startIndex: session.state.streamIndex, phase: "sending" as const };
      saved.turns.push(entry);
      await store?.writeProgress(caseId, saved);
      const live = await observeDelivery(() => session!.start(message, turnOptions));
      const received = await observeDelivery(() => live.waitForEvent("message.received"));
      if (received.data.message !== message) throw new Error("Checkpoint pending: Получен другой запрос вместо отправленного хода.");
      const accepted = { ...entry, phase: "accepted" as const, receivedEventId: received.meta.id };
      saved.turns[turnIndex] = accepted;
      await observeDelivery(async () => { await store?.writeProgress(caseId, saved); });
      const turn = await observeDelivery(() => live.result());
      session = turn.session;
      saved.turns[turnIndex] = { ...accepted, phase: "settled" };
      await store?.writeProgress(caseId, saved);
      turnIndex++;
      return turn;
    },
  };
}
