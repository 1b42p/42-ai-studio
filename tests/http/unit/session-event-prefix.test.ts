import type { MessageStreamEvent } from "eve/client";
import { describe, expect, it, vi } from "vitest";

import { readSessionEventPrefix } from "@/lib/sessions/event-prefix";

const received = (id: string): MessageStreamEvent =>
  ({ type: "message.appended", meta: { id } }) as MessageStreamEvent;

describe("readSessionEventPrefix", () => {
  it("uses the supplied cursor and stops at the last requested event in stream order", async () => {
    const closed = vi.fn();
    const stream = vi.fn(async function* () {
      try {
        yield received("before");
        yield received("later-hook");
        yield received("earlier-hook");
        throw new Error("must not read beyond the requested prefix");
      } finally {
        closed();
      }
    });

    const events = await Array.fromAsync(
      readSessionEventPrefix(stream, 6596, new Set(["earlier-hook", "later-hook"])),
    );

    expect(stream).toHaveBeenCalledOnce();
    expect(stream).toHaveBeenCalledWith({
      startIndex: 6596,
      follow: true,
      signal: expect.any(AbortSignal),
    });
    expect(events.map((event) => event.meta?.id)).toEqual(["before", "later-hook", "earlier-hook"]);
    expect(closed).toHaveBeenCalledOnce();
  });
});
