/**
 * Админка: ключи Daytona в окнах 390×844 и 1280×800.
 * Даты заданы литералами, время показывается после монтирования.
 */
import { expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import { AdminKeysPanel } from "@/components/studio/admin/keys/admin-keys-panel";
import { AdminShell } from "@/components/studio/admin/admin-shell";
import { adminSections } from "@/components/studio/admin/sections";
import type { AdminKeyView, AdminKeysPage } from "@/lib/admin/key-view";
import { USAGE_ERROR_TEXT } from "@/lib/admin/key-view";

import { expectNoHorizontalScroll, renderOnDesktop, renderOnPhone } from "./support/render";

const NOW = new Date("2026-11-01T12:00:00Z");
const ZONE = "Europe/Moscow";
const LONG = "Я".repeat(200);

function key(overrides: Partial<AdminKeyView> = {}): AdminKeyView {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    label: "Основной",
    enabled: true,
    deletedAt: null,
    createdAt: "2026-10-01T08:00:00.000Z",
    order: 1,
    usage: {
      source: "daytona",
      fetchedAt: "2026-11-01T11:58:00.000Z",
      organizationId: "org-1",
      region: "eu",
      cpu: { used: 4, quota: 10 },
      memoryGb: { used: 8, quota: 10 },
      diskGb: { used: 27, quota: 30 },
      maxPerSandbox: { cpu: 4, memoryGb: 8, diskGb: 10 },
      error: null,
    },
    usageCheckedAt: "2026-11-01T11:59:30.000Z",
    exhaustedUntil: null,
    remainingSandboxes: null,
    fits: 2,
    sandboxes: { running: 1, stopped: 2, archived: 0 },
    warning: null,
    ...overrides,
  };
}

function view(items: readonly AdminKeyView[]): AdminKeysPage {
  return { items, defaults: { cpu: 2, memoryGb: 4, diskGb: 8 } };
}

function panel(items: readonly AdminKeyView[], props: Partial<Parameters<typeof AdminKeysPanel>[0]> = {}) {
  return (
    <AdminShell pathname="/admin/keys" sections={adminSections}>
      <AdminKeysPanel
        key={items.map((item) => `${item.id}:${item.label}`).join("|")}
        createRequest={async () => key()}
        deleteRequest={async () => ({ remainingSandboxes: 0 })}
        initialPage={view(items)}
        listRequest={async () => view([])}
        now={NOW}
        patchRequest={async () => key()}
        refreshRequest={async () => key()}
        timeZone={ZONE}
        {...props}
      />
    </AdminShell>
  );
}

async function expectBars(root: HTMLElement) {
  await expect.element(page.getByText("vCPU: 4 из 10")).toBeVisible();
  await expect.element(page.getByText("Память: 8 из 10 ГиБ")).toBeVisible();
  await expect.element(page.getByText("Диск: 27 из 30 ГиБ")).toBeVisible();
  const cpu = root.querySelector("[aria-label='vCPU: 4 из 10']");
  const memory = root.querySelector("[aria-label='Память: 8 из 10 ГиБ']");
  const disk = root.querySelector("[aria-label='Диск: 27 из 30 ГиБ']");
  expect(cpu?.getAttribute("aria-valuenow")).toBe("4");
  expect(memory?.getAttribute("aria-valuenow")).toBe("8");
  expect(disk?.getAttribute("aria-valuenow")).toBe("27");
  expect(cpu?.getAttribute("data-level")).toBe("ok");
  expect(memory?.getAttribute("data-level")).toBe("warning");
  expect(disk?.getAttribute("data-level")).toBe("destructive");
  expect(cpu?.querySelector("[data-slot='badge']")).toBeNull();
  await expect.element(page.elementLocator(memory!).getByText("Квота заканчивается", { exact: true })).toBeVisible();
  await expect.element(page.elementLocator(disk!).getByText("Квота почти исчерпана", { exact: true })).toBeVisible();
  for (const [bar, max] of [[cpu, 10], [memory, 10], [disk, 30]] as const) {
    expect(bar).toHaveAttribute("role", "progressbar");
    expect(bar).toHaveAttribute("aria-valuemax", String(max));
    await expect.element(bar!.querySelector<HTMLElement>("[data-slot='progress-indicator']")!).toBeVisible();
  }
}

for (const [viewport, render] of [["телефон", renderOnPhone], ["компьютер", renderOnDesktop]] as const) {
  for (const [used, level, warning] of [
    [69, "ok", null],
    [70, "warning", "Квота заканчивается"],
    [89, "warning", "Квота заканчивается"],
    [90, "destructive", "Квота почти исчерпана"],
  ] as const) {
    test(`${viewport}: предупреждение квоты на границе ${used}%`, async () => {
      const usage = key().usage!;
      const screen = await render(panel([key({ usage: { ...usage, memoryGb: { used, quota: 100 } } })]));
      const bar = page.getByRole("progressbar", { name: `Память: ${used} из 100 ГиБ`, exact: true });
      await expect.element(bar).toBeVisible();
      await expect.element(bar).toHaveAttribute("aria-valuenow", String(used));
      await expect.element(bar).toHaveAttribute("aria-valuemax", "100");
      await expect.element(bar).toHaveAttribute("data-level", level);
      if (warning === null) {
        expect(bar.element().querySelector("[data-slot='badge']")).toBeNull();
      } else {
        await expect.element(bar.getByText(warning, { exact: true })).toBeVisible();
      }
      expectNoHorizontalScroll();
      await screen.unmount();
    });
  }
}

test("компьютер: карточка, пороги и подтверждения", async () => {
  const patchRequest = vi.fn(async () => key({ enabled: false }));
  const deleteRequest = vi.fn(async () => ({ remainingSandboxes: 0 }));
  const screen = await renderOnDesktop(panel([key()], { patchRequest, deleteRequest }));

  await expect.element(page.getByRole("heading", { name: "Ключи Daytona" })).toBeVisible();
  await expect.element(page.getByText("Включён")).toBeVisible();
  await expect.element(page.getByText("№ 1")).toBeVisible();
  await expect.element(page.getByText("Ещё поместится: 2 песочницы (2 vCPU / 4 ГиБ / 8 ГиБ)")).toBeVisible();
  await expect.element(page.getByText("Песочницы на ключе: запущено 1, остановлено 2, в архиве 0")).toBeVisible();
  await expectBars(screen.container);
  expectNoHorizontalScroll();

  await page.getByRole("button", { name: "Отключить Основной" }).click();
  await page.getByRole("button", { name: "Отмена" }).click();
  expect(patchRequest).not.toHaveBeenCalled();

  await page.getByRole("button", { name: "Отключить Основной" }).click();
  await page.getByRole("button", { name: "Отключить", exact: true }).click();
  await expect.poll(() => patchRequest.mock.calls.length).toBe(1);

  await page.getByRole("button", { name: "Удалить Основной" }).click();
  await expect.element(page.getByText(/будут удалены вместе с файлами/)).toBeVisible();
  await page.getByRole("button", { name: "Удалить", exact: true }).click();
  await expect.poll(() => deleteRequest.mock.calls.length).toBe(1);
  await screen.unmount();
});

test("телефон: одна колонка, длинное название усечено, диалог добавления", async () => {
  const createRequest = vi.fn(async () => key({ id: "00000000-0000-4000-8000-000000000009", label: "Новый" }));
  const screen = await renderOnPhone(panel([key({ label: LONG, enabled: false, exhaustedUntil: "2026-11-01T12:20:00.000Z" })], {
    createRequest,
  }));

  const title = page.getByText(LONG).element();
  expect(title.textContent).toBe(LONG);
  expect(getComputedStyle(title!).textOverflow).toBe("ellipsis");
  await expect.element(page.getByText("Отключён")).toBeVisible();
  await expect.element(page.getByText("Квота исчерпана до 15:20")).toBeVisible();
  expectNoHorizontalScroll();

  await page.getByRole("button", { name: "Добавить ключ" }).first().click();
  const submit = page.getByRole("button", { name: "Добавить", exact: true });
  await expect.element(submit).toBeDisabled();
  const secret = page.getByLabelText("API-ключ Daytona");
  expect(secret.element().getAttribute("type")).toBe("password");
  await userEvent.fill(page.getByLabelText("Название"), "Запасной");
  await userEvent.fill(secret, "dtn_render_secret");
  await expect.element(submit).toBeEnabled();

  createRequest.mockRejectedValueOnce(new Error("Daytona не приняла ключ. Проверьте, что ключ скопирован целиком."));
  await submit.click();
  await expect.element(page.getByText("Daytona не приняла ключ. Проверьте, что ключ скопирован целиком.")).toBeVisible();
  expect((secret.element() as HTMLInputElement).value).toBe("dtn_render_secret");

  await submit.click();
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  expect((document.getElementById("daytona-api-key") as HTMLInputElement | null)?.value ?? "").toBe("");
  expectNoHorizontalScroll();
  await screen.unmount();
});

test("состояния чтения, пустой список, нехватка и удалённые", async () => {
  const errors = (["unauthorized", "forbidden", "unavailable", "unexpected"] as const).map((error, index) =>
    key({
      id: `00000000-0000-4000-8000-00000000000${index + 1}`,
      label: error,
      usage: {
        source: "error",
        fetchedAt: "2026-11-01T11:59:30.000Z",
        organizationId: null,
        region: null,
        cpu: { used: 4, quota: 10 },
        memoryGb: { used: 1, quota: 10 },
        diskGb: { used: 1, quota: 30 },
        maxPerSandbox: null,
        error,
      },
    }),
  );
  const errorsScreen = await renderOnDesktop(panel(errors));
  for (const error of ["unauthorized", "forbidden", "unavailable", "unexpected"] as const) {
    await expect.element(page.getByText(USAGE_ERROR_TEXT[error], { exact: false })).toBeVisible();
  }
  await expect.element(page.getByText("vCPU: 4 из 10").first()).toBeVisible();
  await errorsScreen.unmount();

  const emptyUsage = await renderOnPhone(panel([
    key({
      id: "00000000-0000-4000-8000-000000000021",
      usage: null,
      fits: null,
    }),
  ], {
    refreshRequest: () => new Promise(() => {}),
    initialPage: view([key({
      id: "00000000-0000-4000-8000-000000000021",
      label: "Пустой",
      usage: null,
      fits: null,
      usageCheckedAt: "2026-10-01T00:00:00.000Z",
    })]),
  }));
  await expect.element(page.getByText("Использование ещё не читалось")).toBeVisible();
  expect(document.querySelector("[data-slot='skeleton']")).not.toBeNull();
  await emptyUsage.unmount();

  const emptyList = await renderOnDesktop(panel([], {
    initialError: false,
    listRequest: async (deleted) => deleted
      ? view([key({ label: "Старый", deletedAt: "2026-10-20T10:00:00.000Z", enabled: false, order: null })])
      : view([]),
  }));
  await expect.element(page.getByText("Ключей Daytona нет. Без ключа песочницы не создаются.")).toBeVisible();
  await page.getByRole("button", { name: /Удалённые ключи/ }).click();
  await expect.element(page.getByText("Старый", { exact: false })).toBeVisible();
  await emptyList.unmount();

  const failed = await renderOnPhone(panel([], { initialError: true }));
  await expect.element(page.getByText("Не удалось загрузить ключи")).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Повторить" })).toBeVisible();
  await failed.unmount();

  const disabled = await renderOnDesktop(panel([
    key({ enabled: false, fits: 0, id: "00000000-0000-4000-8000-000000000031" }),
  ]));
  await expect.element(page.getByText("Нет включённых ключей: новые сессии не смогут запустить песочницу.")).toBeVisible();
  await disabled.unmount();

  const waiting = await renderOnPhone(panel([
    key({ fits: 0, id: "00000000-0000-4000-8000-000000000032", remainingSandboxes: 2 }),
  ]));
  await expect.element(page.getByText("Свободной квоты нет ни на одном ключе: новые сессии будут ждать в очереди.")).toBeVisible();
  await expect.element(page.getByText(/2 песочницы не удалось удалить в Daytona/)).toBeVisible();
  const money = document.body.textContent ?? "";
  expect(money).not.toContain("баланс");
  expect(money).not.toContain("стоимость");
  expect(money).not.toMatch(/[$€₽]/);
  expectNoHorizontalScroll();
  await waiting.unmount();
});
