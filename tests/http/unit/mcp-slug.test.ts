import { describe, expect, it } from "vitest";

import { mcpSlug } from "@/lib/mcp/slug";

describe("имя подключения MCP", () => {
  it("транслитерирует русское название", () => {
    expect(mcpSlug("Мой сервер")).toBe("mcp-moy-server");
    expect(mcpSlug("Щука и ёж")).toBe("mcp-shchuka-i-ezh");
  });

  it("сжимает разделители и использует запасное имя", () => {
    expect(mcpSlug("  A / B  ")).toBe("mcp-a-b");
    expect(mcpSlug("ъь!!!")).toBe("mcp-server");
  });

  it("ограничивает длину и не оставляет дефис на конце", () => {
    expect(mcpSlug(`${"a".repeat(39)}-b`)).toBe(`mcp-${"a".repeat(39)}`);
  });
});
