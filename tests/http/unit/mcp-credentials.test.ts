import { describe, expect, it } from "vitest";

import { parseMcpCredentials } from "@/lib/mcp/credentials";

describe("учётные данные MCP", () => {
  it("принимает токен и собственный заголовок", () => {
    expect(parseMcpCredentials({ authKind: "bearer", token: "secret-token" })).toEqual({
      authKind: "bearer",
      credentials: { token: "secret-token" },
    });
    expect(parseMcpCredentials({ authKind: "headers", headers: [{ name: "X-Api-Key", value: "k1" }] })).toEqual({
      authKind: "headers",
      credentials: { headers: { "x-api-key": "k1" } },
    });
  });

  it("отвергает небезопасные и повторяющиеся заголовки", () => {
    for (const name of ["Host", "x-studio-mcp-token", "Sec-Fetch-Site", "Cookie", "bad name"]) {
      expect(() => parseMcpCredentials({ authKind: "headers", headers: [{ name, value: "x" }] })).toThrow();
    }
    expect(() => parseMcpCredentials({
      authKind: "headers",
      headers: [{ name: "X-Key", value: "a" }, { name: "x-key", value: "b" }],
    })).toThrow();
  });

  it("принимает OAuth без статических учётных данных", () => {
    expect(parseMcpCredentials({ authKind: "oauth" })).toEqual({
      authKind: "oauth",
      credentials: null,
    });
    expect(() => parseMcpCredentials({ authKind: "oauth", token: "secret" })).toThrow();
    expect(() => parseMcpCredentials({ authKind: "oauth", headers: [] })).toThrow();
  });

  it("отвергает управляющие символы и неподдерживаемые способы входа", () => {
    expect(() => parseMcpCredentials({ authKind: "bearer", token: "a b" })).toThrow();
    expect(() => parseMcpCredentials({ authKind: "headers", headers: [{ name: "X-Key", value: "a\r\nb" }] })).toThrow();
    expect(() => parseMcpCredentials({ authKind: "password" })).toThrow();
  });
});
