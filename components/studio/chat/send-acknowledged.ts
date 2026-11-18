import type { EveAgentStore, ConversationState } from "eve/client";

type Turn = Parameters<EveAgentStore<ConversationState>["send"]>[0];

/**
 * Store.send consumes the entire turn and reports first-turn failures in its
 * snapshot, not its returned promise. Only the SDK's own delivery correlation
 * may acknowledge a message; text equality and optimistic projection are not ACKs.
 */
export function sendAcknowledged(store: EveAgentStore<ConversationState>, turn: Turn): Promise<void> {
  const before = store.snapshot;
  const existingIds = new Set(before.conversation.messages.map((message) => message.id));
  let submissionId: string | undefined;
  let settled = false;
  const acknowledged = Promise.withResolvers<void>();
  let unsubscribe = () => {};
  const finish = (error?: Error) => {
    if (settled) return;
    settled = true;
    unsubscribe();
    if (error) acknowledged.reject(error);
    else acknowledged.resolve();
  };
  const inspect = () => {
    if (settled) return;
    const snapshot = store.snapshot;
    const messages = snapshot.conversation.messages;
    if (turn.message !== undefined) {
      submissionId ??= messages.find((message) =>
        message.role === "user" && message.metadata?.optimistic && !existingIds.has(message.id),
      )?.id;
      const submitted = messages.find((message) => message.id === submissionId);
      if (submitted?.metadata?.status === "failed") {
        finish(snapshot.error ?? new Error("Сообщение не было принято. Попробуйте ещё раз."));
        return;
      }
      // The SDK removes exactly this optimistic ID after correlating the POST
      // delivery with authoritative message.received, even if the event arrived
      // before the POST response. An unrelated identical message cannot do this.
      if (submissionId && !submitted &&
          snapshot.events.slice(before.events.length).some((event) => event.type === "message.received")) {
        finish();
        return;
      }
    } else {
      const resolved = new Set(snapshot.events.slice(before.events.length).flatMap((event) =>
        event.type === "input.resolved"
          ? event.data.resolutions.filter((resolution) => resolution.outcome === "answered").map((resolution) => resolution.requestId)
          : [],
      ));
      const responses = turn.inputResponses;
      if (responses && responses.length > 0 && responses.every((response) => resolved.has(response.requestId))) {
        finish();
        return;
      }
    }
    // snapshot.error belongs to the root operation, not necessarily this send.
    // A held steer POST can still succeed after the older root reports an error.
  };
  unsubscribe = store.subscribe(inspect);
  // Do not await the turn here. Continue consuming it in the native store.
  void store.send(turn).then(() => {
    inspect();
    const snapshot = store.snapshot;
    // A steer can finish awaiting the older operation's completion while its
    // own delivery is still pending. The shared root error is not its refusal.
    const ownMessage = snapshot.conversation.messages.find((message) => message.id === submissionId);
    if (!settled && snapshot.error && ownMessage?.metadata?.optimistic &&
        ownMessage.metadata.status !== "failed") return;
    if (!settled) finish(store.snapshot.error ?? new Error("Отправка не подтверждена. Попробуйте ещё раз."));
  }, (cause: unknown) => finish(cause instanceof Error ? cause : new Error("Не удалось отправить сообщение.")));
  inspect();
  return acknowledged.promise;
}
