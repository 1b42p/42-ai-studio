import { decodeJwt } from "jose";
import { expect, test, vi } from "vitest";

import { signInternalToken } from "@/lib/auth/internal-tokens";

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
