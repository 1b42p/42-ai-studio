import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";

import { NewChat } from "@/components/studio/chat/new-chat";
import { ChatDraftIdentityContext } from "@/components/studio/chat/chat-composer";
import { renderOnDesktop } from "./support/render";

const fixture = vi.hoisted(() => ({ send: vi.fn(async () => {}) }));
vi.mock("@/components/studio/chat/use-studio-agent", async () => {
  const original = await import("eve/react");
  const agent = {
    data: original.conversationReducer.initial(),
    events: [], status: "ready", error: undefined,
    send: fixture.send, cancel: vi.fn(), respond: vi.fn(),
  };
  return {
    useStudioAgent: () => agent,
  };
});

beforeEach(() => {
  sessionStorage.clear();
  fixture.send.mockReset();
});
afterEach(() => vi.restoreAllMocks());

test("сбой первого fetch виден, повтор использует один принятый ID даже после ошибки отправки eve", async () => {
  vi.spyOn(History.prototype, "replaceState").mockImplementation(() => {});
  fixture.send.mockRejectedValueOnce(new Error("send failed")).mockResolvedValueOnce(undefined);
  let creates = 0;
  vi.spyOn(window, "fetch").mockImplementation(async (input, init) => {
    if (input === "/api/sessions" && init?.method === "POST") {
      creates += 1;
      if (creates === 1) throw new TypeError("offline");
      return Response.json({ id: "created-session" }, { status: 201 });
    }
    return Response.json({ state: "none", files: [] });
  });
  await renderOnDesktop(
    <ChatDraftIdentityContext.Provider value="owner">
      <NewChat initialPage={{ items: [], nextCursor: null }} initialQuery="" />
    </ChatDraftIdentityContext.Provider>,
  );
  const field = page.getByRole("textbox", { name: "Сообщение агенту" });
  const send = page.getByRole("button", { name: "Отправить", exact: true });
  await field.fill("Мой ролик");
  await send.click();
  await expect.element(page.getByText("Не удалось создать сессию. Попробуйте ещё раз.", { exact: true })).toBeVisible();
  await expect.element(field).toHaveValue("Мой ролик");
  expect(fixture.send).not.toHaveBeenCalled();

  await send.click();
  await expect.poll(() => page.getByRole("alert").element().textContent?.replace(/\s+/g, " ").trim()).toContain("Текст и вложения сохранены");
  await expect.element(field).toHaveValue("Мой ролик");
  expect(creates).toBe(2);
  await send.click();
  await expect.element(field).toHaveValue("");
  expect(creates).toBe(2);
  expect(fixture.send).toHaveBeenCalledTimes(2);
});

test("Стоп во время создания строки сессии предотвращает последующий вызов eve и сохраняет оба текста", async () => {
  vi.spyOn(History.prototype, "replaceState").mockImplementation(() => {});
  const creation = Promise.withResolvers<Response>();
  vi.spyOn(window, "fetch").mockImplementation(async (input, init) => {
    if (input === "/api/sessions" && init?.method === "POST") return creation.promise;
    return Response.json({ state: "none", files: [] });
  });
  await renderOnDesktop(
    <ChatDraftIdentityContext.Provider value="owner">
      <NewChat initialPage={{ items: [], nextCursor: null }} initialQuery="" />
    </ChatDraftIdentityContext.Provider>,
  );
  const field = page.getByRole("textbox", { name: "Сообщение агенту" });
  await field.fill("Первый текст");
  await page.getByRole("button", { name: "Отправить", exact: true }).click();
  await expect.element(field).toBeEnabled();
  await field.fill("Следующий текст");
  await page.getByRole("button", { name: "Стоп", exact: true }).click();
  creation.resolve(Response.json({ id: "created-session" }, { status: 201 }));
  await expect.element(page.getByRole("button", { name: "Повторить отправку", exact: true })).toBeVisible();
  await expect.element(field).toHaveValue("Следующий текст");
  expect(fixture.send).not.toHaveBeenCalled();
  expect(sessionStorage.getItem("studio:draft:v1:owner:chat:created-session:pending")).toBe("Первый текст");
});
