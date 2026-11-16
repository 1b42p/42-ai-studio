import { expect, test } from "vitest";

import { mcpPolicy, validateMcpAddress } from "@/lib/mcp/policy";
import { checkOutboundAddress, parseOutboundUrl, safeFetch } from "@/lib/web/safe-fetch";

test("политика MCP разрешает публичные нестандартные порты и блокирует внутренние адреса", () => {
  const policy = mcpPolicy();
  for (const address of [
    "https://2130706433/", "https://0x7f.1/", "https://[::ffff:7f00:1]/", "https://[::1]/",
    "https://0.0.0.1/", "https://169.254.169.254/", "https://10.0.0.5/", "https://100.64.0.1/",
    "https://172.16.0.1/", "https://192.0.0.1/", "https://192.0.2.1/", "https://192.88.99.1/",
    "https://192.168.0.1/", "https://198.18.0.1/", "https://198.51.100.1/", "https://203.0.113.1/",
    "https://224.0.0.1/", "https://240.0.0.1/", "https://[2001:db8::1]/", "https://[2002::1]/",
    "https://[3fff::1]/", "https://[fc00::1]/", "https://[fe80::1]/", "https://[ff00::1]/",
  ]) {
    expect(parseOutboundUrl(address, policy)).toEqual({ ok: false, reason: "blocked_address" });
  }
  for (const address of ["https://8.8.8.8:8443/", "https://1.1.1.1/", "https://[2606:4700:4700::1111]/"]) {
    expect(parseOutboundUrl(address, policy).ok).toBe(true);
  }
  for (const address of ["ftp://example.com/", "file:///etc/passwd", "https://user:pw@example.com/"]) {
    expect(parseOutboundUrl(address, policy)).toEqual({ ok: false, reason: "bad_url" });
  }
});

test("токен через HTTP запрещён без DNS-запроса", async () => {
  await expect(validateMcpAddress("http://nonexistent.invalid/mcp", "bearer"))
    .rejects.toThrow("Токен и заголовки передаются только по https.");
});

test("смешанный ответ DNS целиком блокируется политикой MCP", async () => {
  await expect(checkOutboundAddress("https://mixed.example/mcp", {
    ...mcpPolicy(), resolveDns: async () => ["8.8.8.8", "127.0.0.1"],
  })).rejects.toMatchObject({ reason: "blocked_address" });
});

test("повторное разрешение имени при соединении блокирует DNS rebinding", async () => {
  let calls = 0;
  const policy = {
    ...mcpPolicy(3_000),
    resolveDns: async () => (++calls === 1 ? ["8.8.8.8"] : ["127.0.0.1"]),
  };
  await expect(safeFetch("http://rebind.example/mcp", {}, policy)).rejects.toMatchObject({ reason: "blocked_address" });
  expect(calls).toBeGreaterThanOrEqual(2);
});
