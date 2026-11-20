import type { MessageStreamEvent } from "eve/client";
import type { ServerSession } from "eve/server";

const readTimeoutMs = 5_000;

export async function* readSessionEventPrefix(
  stream: ServerSession["stream"],
  startIndex: number,
  targets: ReadonlySet<string>,
): AsyncIterable<MessageStreamEvent> {
  const remaining = new Set(targets);
  if (remaining.size === 0) return;

  const signal = AbortSignal.timeout(readTimeoutMs);
  for await (const event of stream({ startIndex, follow: true, signal })) {
    yield event;
    const id = event.meta?.id;
    if (id !== undefined) remaining.delete(id);
    if (remaining.size === 0) return;
  }
}
