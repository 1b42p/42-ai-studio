import { expect, test } from "vitest";

import { rewriteEndpointEvent } from "@/lib/mcp/legacy-sse";

test("адрес устаревшего SSE остаётся на исходном сервере и проходит через прокси", () => {
  expect(rewriteEndpointEvent("event: endpoint\ndata: /messages?sessionId=123", new URL("https://example.com/sse"), "id"))
    .toBe("event: endpoint\ndata: /api/mcp-proxy/id/o/messages?sessionId=123");
  expect(() => rewriteEndpointEvent("event: endpoint\ndata: https://evil.example/messages", new URL("https://example.com/sse"), "id"))
    .toThrow();
  expect(rewriteEndpointEvent("event: message\ndata: hello", new URL("https://example.com/sse"), "id"))
    .toBe("event: message\ndata: hello");
});
