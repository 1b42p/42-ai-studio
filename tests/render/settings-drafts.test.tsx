import { beforeEach, afterEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";

import { SettingsPage } from "@/components/studio/settings/settings-page";
import { useSettings } from "@/components/studio/settings/use-settings";
import { Button } from "@/components/ui/button";
import type { PublicUser } from "@/lib/auth/user";
import { renderOnDesktop, renderOnPhone } from "./support/render";

const user: PublicUser = {
  id: "settings-owner", name: "Пользователь", username: null, photoUrl: null, isOperator: false,
};
beforeEach(() => sessionStorage.clear());
afterEach(() => { sessionStorage.clear(); vi.restoreAllMocks(); });

function settings(owner = user.id, save = vi.fn(async () => ({
  customInstructions: "Новые указания", memoryEnabled: false,
}))) {
  return (
    <SettingsPage
      user={{ ...user, id: owner }} onLogout={vi.fn()}
      settings={{ customInstructions: "Начальные указания", memoryEnabled: false }}
      save={save}
    />
  );
}

function RefreshableSettings() {
  const controller = useSettings({ customInstructions: "Начальные указания", memoryEnabled: false });
  return (
    <>
      <Button onClick={() => void controller.refresh()}>Обновить настройки</Button>
      <p role="status" aria-label="Серверные указания">{controller.settings.customInstructions}</p>
      <SettingsPage user={user} onLogout={vi.fn()} settings={controller.settings} save={controller.save} />
    </>
  );
}

test("server refresh синхронизирует pristine поле с новым baseline", async () => {
  let instructions = "Начальные указания";
  vi.spyOn(window, "fetch").mockImplementation(async () =>
    Response.json({ customInstructions: instructions, memoryEnabled: false }),
  );
  await renderOnDesktop(<RefreshableSettings />);
  await expect.element(page.getByRole("textbox", { name: "Общие указания" })).toHaveValue(instructions);
  instructions = "Свежие серверные указания";
  await page.getByRole("button", { name: "Обновить настройки" }).click();
  await expect.element(page.getByRole("textbox", { name: "Общие указания" })).toHaveValue(instructions);
  await expect.element(page.getByRole("button", { name: "Сохранить", exact: true })).toBeDisabled();
});

test("server refresh не затирает dirty поле, возврат к baseline снова разрешает синхронизацию", async () => {
  let instructions = "Начальные указания";
  vi.spyOn(window, "fetch").mockImplementation(async () =>
    Response.json({ customInstructions: instructions, memoryEnabled: false }),
  );
  await renderOnDesktop(<RefreshableSettings />);
  const field = page.getByRole("textbox", { name: "Общие указания" });
  await field.fill("Мои несохранённые изменения");
  instructions = "Свежие серверные указания";
  await page.getByRole("button", { name: "Обновить настройки" }).click();
  await expect.element(page.getByRole("status", { name: "Серверные указания" })).toHaveTextContent(instructions);
  await expect.element(field).toHaveValue("Мои несохранённые изменения");
  expect(sessionStorage.getItem("studio:draft:v1:settings-owner:instructions")).toBe("Мои несохранённые изменения");
  // Return to the fresh server baseline, not the one from the first render.
  await field.fill(instructions);
  await expect.element(page.getByRole("button", { name: "Сохранить", exact: true })).toBeDisabled();
  instructions = "Следующее обновление сервера";
  await page.getByRole("button", { name: "Обновить настройки" }).click();
  await expect.element(field).toHaveValue(instructions);
});

test("server refresh не затирает восстановленный черновик", async () => {
  sessionStorage.setItem("studio:draft:v1:settings-owner:instructions", "Восстановленный текст");
  vi.spyOn(window, "fetch").mockImplementation(async () =>
    Response.json({ customInstructions: "Новые указания сервера", memoryEnabled: false }),
  );
  await renderOnDesktop(<RefreshableSettings />);
  await expect.element(page.getByRole("status", { name: "Серверные указания" })).toHaveTextContent("Новые указания сервера");
  await expect.element(page.getByRole("textbox", { name: "Общие указания" })).toHaveValue("Восстановленный текст");
});

test("несохранённые указания восстанавливаются в той же вкладке, но не у другого пользователя", async () => {
  let view = await renderOnPhone(settings());
  await page.getByRole("textbox", { name: "Общие указания" }).fill("Мой несохранённый стиль");
  await view.unmount();
  view = await renderOnPhone(settings("other-owner"));
  await expect.element(page.getByRole("textbox", { name: "Общие указания" })).toHaveValue("Начальные указания");
  await view.unmount();
  await renderOnPhone(settings());
  await expect.element(page.getByRole("textbox", { name: "Общие указания" })).toHaveValue("Мой несохранённый стиль");
});

test("ошибка сохранения не удаляет черновик, успешное сохранение удаляет", async () => {
  const save = vi.fn()
    .mockRejectedValueOnce(new TypeError("offline"))
    .mockResolvedValueOnce({ customInstructions: "Новые указания", memoryEnabled: false });
  await renderOnDesktop(settings(user.id, save));
  await page.getByRole("textbox", { name: "Общие указания" }).fill("Новые указания");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect.element(page.getByRole("alert")).toHaveTextContent("Не удалось сохранить. Попробуйте ещё раз.");
  expect(sessionStorage.getItem("studio:draft:v1:settings-owner:instructions")).toBe("Новые указания");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect.element(page.getByText("Сохранено", { exact: true })).toBeVisible();
  expect(sessionStorage.getItem("studio:draft:v1:settings-owner:instructions")).toBeNull();
});

test("навигация по настройкам имеет роль ссылки и не выдаёт type=button", async () => {
  await renderOnDesktop(settings());
  const navigation = page.getByRole("navigation", { name: "Разделы настроек" });
  const links = navigation.getByRole("link").elements();
  expect(links).toHaveLength(5);
  expect(links.every((link) => !link.hasAttribute("type"))).toBe(true);
});
