import { conversationReducer } from "eve/react";
import { afterEach, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import { ChatView } from "@/components/studio/chat/chat-view";
import { DeleteSessionDialog } from "@/components/studio/sessions/delete-session-dialog";
import { SessionList } from "@/components/studio/sessions/session-list";
import { useSessionDeletion } from "@/components/studio/sessions/use-session-deletion";

import { expectNoHorizontalScroll, renderOnDesktop, renderOnPhone } from "./support/render";

const SESSION = {
  id: "00000000-0000-4000-8000-000000000025",
  title: "Ролик для кофейни",
  createdAt: "2026-11-01T12:00:00.000Z",
  updatedAt: "2026-11-01T12:00:00.000Z",
};
const DESCRIPTION = "Будут удалены переписка, загруженные файлы, ролики и песочница. Это действие нельзя отменить.";
const FAILURE = "Не удалось полностью удалить сессию. Повторите.";
const trigger = () => page.getByRole("button", { name: `Удалить сессию «${SESSION.title}»` });
const dialog = () => page.getByRole("alertdialog", { name: "Удалить сессию?" });

function list(title = SESSION.title, deleteRequest?: (id: string) => Promise<void>) {
  return (
    <SessionList
      deleteRequest={deleteRequest}
      initialPage={{ items: [{ ...SESSION, title }], nextCursor: null }}
      initialQuery=""
      request={async () => ({ items: [], nextCursor: null })}
    />
  );
}

afterEach(() => vi.restoreAllMocks());

for (const [name, render] of [["телефон", renderOnPhone], ["компьютер", renderOnDesktop]] as const) {
  test(`${name}: видимая кнопка вне ссылки, длинное название и диалог без прокрутки`, async () => {
    const title = "Очень длинное название ролика ".repeat(30);
    await render(list(title));
    const button = page.getByRole("button", { name: `Удалить сессию «${title}»` });
    await expect.element(button).toBeVisible();
    expect(button.element().closest("a")).toBeNull();
    const titleNode = document.querySelector("[data-slot=item-title]") as HTMLElement;
    expect(titleNode.scrollWidth).toBeGreaterThan(titleNode.clientWidth);
    expectNoHorizontalScroll();
    await button.click();
    await expect.element(dialog()).toBeVisible();
    await expect.element(page.getByText(DESCRIPTION)).toBeVisible();
    expectNoHorizontalScroll();
    await page.getByRole("button", { name: "Отмена", exact: true }).click();
    await expect.element(dialog()).not.toBeInTheDocument();
    await expect.element(button).toHaveFocus();
  });
}

test("«Отмена» закрывает диалог, не вызывает удаление и сохраняет строку", async () => {
  const request = vi.fn(async () => undefined);
  await renderOnDesktop(list(SESSION.title, request));
  await trigger().click();
  await page.getByRole("button", { name: "Отмена" }).click();
  await expect.element(dialog()).not.toBeInTheDocument();
  expect(request).not.toHaveBeenCalled();
  await expect.element(page.getByRole("link", { name: /Ролик для кофейни/ })).toBeVisible();
});

test("один запрос, блокировка кнопок, Esc и внешнего клика; успех убирает строку", async () => {
  let finish!: () => void;
  const request = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
  await renderOnPhone(list(SESSION.title, request));
  await trigger().click();
  await page.getByRole("button", { name: "Удалить", exact: true }).click();
  expect(request).toHaveBeenCalledExactlyOnceWith(SESSION.id);
  await expect.element(page.getByRole("button", { name: "Удалить", exact: true })).toBeDisabled();
  await expect.element(page.getByRole("button", { name: "Отмена" })).toBeDisabled();
  await expect.element(page.getByRole("status", { name: "Удаление" })).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(dialog()).toBeVisible();
  await userEvent.click(document.querySelector("[data-slot=alert-dialog-overlay]")!, {
    position: { x: 5, y: 5 },
  });
  await expect.element(dialog()).toBeVisible();
  expect(request).toHaveBeenCalledTimes(1);
  finish();
  await expect.element(dialog()).not.toBeInTheDocument();
  await expect.element(page.getByRole("link", { name: /Ролик для кофейни/ })).not.toBeInTheDocument();
  await expect.element(page.getByText("Сессий пока нет")).toBeVisible();
});

test("502 оставляет предупреждение и «Повторить», 404 при повторе завершает удаление", async () => {
  const request = vi.spyOn(window, "fetch")
    .mockResolvedValueOnce(new Response(null, { status: 502 }))
    .mockResolvedValueOnce(new Response(null, { status: 404 }));
  await renderOnDesktop(list());
  await trigger().click();
  await page.getByRole("button", { name: "Удалить", exact: true }).click();
  await expect.element(dialog()).toBeVisible();
  await expect.element(page.getByRole("alert")).toHaveTextContent(FAILURE);
  await page.getByRole("button", { name: "Повторить", exact: true }).click();
  await expect.element(dialog()).not.toBeInTheDocument();
  await expect.element(page.getByText("Сессий пока нет")).toBeVisible();
  expect(request).toHaveBeenCalledTimes(2);
  expect(request).toHaveBeenNthCalledWith(1, `/api/sessions/${SESSION.id}`, { method: "DELETE" });
});

test("сетевая ошибка остаётся в диалоге и допускает повтор", async () => {
  vi.spyOn(window, "fetch").mockRejectedValue(new TypeError("offline"));
  await renderOnDesktop(list());
  await trigger().click();
  await page.getByRole("button", { name: "Удалить", exact: true }).click();
  await expect.element(page.getByRole("alert")).toHaveTextContent(FAILURE);
  await expect.element(page.getByRole("button", { name: "Повторить" })).toBeEnabled();
});

for (const text of [
  "Удаление этой сессии уже выполняется.",
  "Сессия ещё создаётся, повторите через несколько секунд.",
]) {
  test(`409: ${text}`, async () => {
    vi.spyOn(window, "fetch").mockResolvedValue(Response.json({
      error: { code: "conflict", message: text },
    }, { status: 409 }));
    await renderOnDesktop(list());
    await trigger().click();
    await page.getByRole("button", { name: "Удалить", exact: true }).click();
    await expect.element(page.getByRole("alert")).toHaveTextContent(text);
    await expect.element(page.getByRole("button", { name: "Повторить" })).toBeEnabled();
  });
}

for (const status of [401, 403]) {
  test(`${status}: ссылка «Войдите снова» ведёт на /login`, async () => {
    vi.spyOn(window, "fetch").mockResolvedValue(new Response(null, { status }));
    await renderOnPhone(list());
    await trigger().click();
    await page.getByRole("button", { name: "Удалить", exact: true }).click();
    await expect.element(page.getByRole("link", { name: "Войдите снова" })).toHaveAttribute("href", "/login");
    await expect.element(dialog()).toBeVisible();
  });
}

test("управляемый диалог получает состояние и обработчик без сети", async () => {
  const fetchSpy = vi.spyOn(window, "fetch");
  const onConfirm = vi.fn();
  await renderOnDesktop(
    <DeleteSessionDialog
      onClose={() => undefined}
      onConfirm={onConfirm}
      open
      state={{ status: "error", message: FAILURE, login: false }}
      title={SESSION.title}
    />,
  );
  await page.getByRole("button", { name: "Повторить" }).click();
  expect(onConfirm).toHaveBeenCalledTimes(1);
  expect(fetchSpy).not.toHaveBeenCalled();
});

function ChatHarness({ onDeleted }: { onDeleted: (id: string) => void }) {
  const deletion = useSessionDeletion({ onDeleted });
  return (
    <div className="h-dvh">
      <ChatView
        agent={{ data: conversationReducer.initial(), events: [], status: "ready" }}
        appSessionId={SESSION.id}
        onCancel={() => undefined}
        onRespond={() => undefined}
        onSend={() => undefined}
        sessionDeletion={deletion}
        title={SESSION.title}
      />
    </div>
  );
}

test("шапка удаляет открытую сессию и передаёт её id обработчику перехода", async () => {
  const onDeleted = vi.fn();
  vi.spyOn(window, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
  await renderOnPhone(<ChatHarness onDeleted={onDeleted} />);
  await expect.element(trigger()).toBeVisible();
  expectNoHorizontalScroll();
  await trigger().click();
  await page.getByRole("button", { name: "Удалить", exact: true }).click();
  await expect.element(dialog()).not.toBeInTheDocument();
  expect(onDeleted).toHaveBeenCalledExactlyOnceWith(SESSION.id);
});
