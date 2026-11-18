import { expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import { ButtonLink } from "@/components/studio/button-link";
import { renderOnDesktop, renderOnPhone } from "./support/render";

for (const [name, render] of [["телефон", renderOnPhone], ["компьютер", renderOnDesktop]] as const) {
  test(`${name}: переход выглядит как кнопка, но сохраняет клавиатурное поведение ссылки`, async () => {
    const activate = vi.fn();
    await render(
      <ButtonLink href="/settings" size="lg" onClick={(event) => {
        event.preventDefault();
        activate();
      }}>
        Настройки студии
      </ButtonLink>,
    );
    const link = page.getByRole("link", { name: "Настройки студии" });
    expect(link.element().getAttribute("type")).toBeNull();
    expect(link.element().getAttribute("role")).toBeNull();
    expect(link.element().getAttribute("href")).toBe("/settings");
    (link.element() as HTMLElement).focus();
    await userEvent.keyboard(" ");
    expect(activate).not.toHaveBeenCalled();
    await userEvent.keyboard("{Enter}");
    expect(activate).toHaveBeenCalledTimes(1);
  });
}
