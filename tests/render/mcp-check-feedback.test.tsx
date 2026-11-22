import { afterEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";

import { McpSectionView } from "@/components/studio/settings/mcp-section";
import { useMcp } from "@/components/studio/settings/use-mcp";
import { Button } from "@/components/ui/button";
import { renderOnDesktop, renderOnPhone } from "./support/render";

function Settings() {
  const state = useMcp(["one", "two"].map((id) => ({
    id, name: id, url: "https://example.com/mcp", authKind: "none" as const,
    enabled: true, headerNames: [], createdAt: "",
  })));
  return (
    <>
      <Button onClick={() => { void state.check("one"); void state.check("one"); }}>Две проверки</Button>
      <McpSectionView state={state} />
    </>
  );
}

afterEach(() => vi.restoreAllMocks());

for (const [name, render] of [["телефон", renderOnPhone], ["компьютер", renderOnDesktop]] as const) {
  test(`${name}: проверка занята только в своей строке, старый результат скрыт, повтор объединён`, async () => {
    const pending = Promise.withResolvers<Response>();
    const request = vi.spyOn(window, "fetch")
      .mockResolvedValueOnce(Response.json({ ok: true, toolCount: 1, tools: ["first-result"] }))
      .mockImplementationOnce(() => pending.promise);
    await render(<Settings />);
    await page.getByRole("button", { name: "Проверить one", exact: true }).click();
    await expect.element(page.getByText(/first-result/)).toBeVisible();
    await page.getByRole("button", { name: "Две проверки" }).click();
    await expect.element(page.getByText("Проверяем подключение…")).toBeVisible();
    await expect.element(page.getByText(/first-result/)).not.toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Проверить one", exact: true })).toBeDisabled();
    await expect.element(page.getByRole("button", { name: "Проверить two", exact: true })).toBeEnabled();
    await expect.element(page.getByRole("button", { name: "Удалить one", exact: true })).toBeDisabled();
    expect(request).toHaveBeenCalledTimes(2);
    pending.resolve(Response.json({ ok: true, toolCount: 2, tools: ["fresh-result"] }));
    await expect.element(page.getByText(/fresh-result/)).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Проверить one", exact: true })).toBeEnabled();
  });
}

test("сетевой отказ проверки виден и позволяет повторить без старого успеха", async () => {
  vi.spyOn(window, "fetch")
    .mockRejectedValueOnce(new TypeError("private-network-detail"))
    .mockResolvedValueOnce(Response.json({ ok: true, toolCount: 0, tools: [] }));
  await renderOnPhone(<Settings />);
  const check = page.getByRole("button", { name: "Проверить one", exact: true });
  await check.click();
  await expect.element(page.getByText("Не удалось проверить сервер. Проверьте соединение и попробуйте ещё раз.")).toBeVisible();
  expect(document.body.textContent).not.toContain("private-network-detail");
  await expect.element(check).toBeEnabled();
  await check.click();
  await expect.element(page.getByText(/Подключение работает/)).toBeVisible();
  await expect.element(page.getByText(/Не удалось проверить сервер/)).not.toBeInTheDocument();
});
