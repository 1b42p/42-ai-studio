import { decodeJwt } from "jose";
import { expect, test, vi } from "vitest";

import { signInternalToken } from "@/lib/auth/internal-tokens";
import * as service from "@/lib/mcp/service";
import userMcp from "@/agent/connections/user-mcp";

test("служебный токен подключения получает новое время при повторном выпуске", async () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const first = await signInternalToken("mcp_proxy", { uid: "user", srv: "server" });
    vi.advanceTimersByTime(2_000);
    const second = await signInternalToken("mcp_proxy", { uid: "user", srv: "server" });
    expect(decodeJwt(second).iat! - decodeJwt(first).iat!).toBe(2);
    expect(second).not.toBe(first);
  } finally { vi.useRealTimers(); }
});

test("одно подключение выпускает новый токен для каждого запроса", async () => {
  vi.useFakeTimers();
  const userId = "00000000-0000-4000-8000-000000000001";
  const serverId = "00000000-0000-4000-8000-000000000002";
  const list = vi.spyOn(service, "listEnabledMcpServers").mockResolvedValue([{
    id: serverId, name: "Тест", slug: "mcp-test", url: "https://example.com/mcp", authKind: "bearer",
  }]);
  try {
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const resolve = userMcp.events["turn.started"] as unknown as (
      event: object, context: object,
    ) => Promise<Record<string, { headers: () => Promise<Record<string, string>> }>>;
    const connections = await resolve({}, { session: { auth: { current: {
      principalType: "user", authenticator: "studio", principalId: userId,
    } } } });
    const first = (await connections["mcp-test"].headers())["x-studio-mcp-token"];
    vi.advanceTimersByTime(2000);
    const second = (await connections["mcp-test"].headers())["x-studio-mcp-token"];
    expect(decodeJwt(second).iat! - decodeJwt(first).iat!).toBe(2);
    expect(second).not.toBe(first);
  } finally {
    list.mockRestore();
    vi.useRealTimers();
  }
});
