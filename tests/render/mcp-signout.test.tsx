import { expect, test, vi } from "vitest";
import { page } from "vitest/browser";

import { McpSectionView } from "@/components/studio/settings/mcp-section";
import { useMcp } from "@/components/studio/settings/use-mcp";
import { renderOnPhone } from "./support/render";

function Settings() {
  const state = useMcp([{
    id: "oauth-server", name: "Сервер", url: "https://example.com/mcp",
    authKind: "oauth", connected: true, enabled: true, headerNames: [], createdAt: "",
  }]);
  return <McpSectionView state={state} />;
}

test("выход отправляет POST, обновляет статус и убирает старую проверку", async () => {
  const request = vi.spyOn(window, "fetch").mockImplementation(async (url) =>
    String(url).endsWith("/check")
      ? Response.json({ ok: true, toolCount: 1, tools: ["echo"] })
      : new Response(null, { status: 204 }),
  );
  try {
    await renderOnPhone(<Settings />);
    await page.getByRole("button", { name: "Проверить Сервер", exact: true }).click();
    await expect.element(page.getByText(/Подключение работает/)).toBeVisible();
    await page.getByRole("button", { name: "Сбросить вход: Сервер", exact: true }).click();
    await page.getByRole("button", { name: "Сбросить вход", exact: true }).click();
    await expect.element(page.getByText("Не подключён", { exact: true })).toBeVisible();
    await expect.element(page.getByText(/Подключение работает/)).not.toBeInTheDocument();
    expect(request).toHaveBeenCalledWith("/api/mcp-servers/oauth-server/signout", { method: "POST" });
  } finally {
    request.mockRestore();
  }
});
