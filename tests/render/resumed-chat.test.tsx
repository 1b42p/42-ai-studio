import { afterEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";

import { ResumedChat } from "@/components/studio/chat/resumed-chat";
import { fileConversation } from "./fixtures/conversations";
import { renderOnDesktop } from "./support/render";

const STATUS_URL = "/api/sessions/resumed";
const HISTORY_URL = `${STATUS_URL}/events?after=-1&limit=2000`;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function chat(initialEveSessionId: string | null = null) {
  return (
    <div className="h-dvh">
      <ResumedChat appSessionId="resumed" initialEveSessionId={initialEveSessionId}
        initialTitle="Моя беседа" starting={initialEveSessionId === null} />
    </div>
  );
}

test("после перезагрузки ждёт, пока сервер считает первую отправку активной", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  let starting = true;
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ eveSessionId: null, starting })));
  await renderOnDesktop(chat());

  await vi.advanceTimersByTimeAsync(30_000);
  await new Promise((resolve) => requestAnimationFrame(resolve));
  expect(page.getByText("Сообщение отправляется…").query()).not.toBeNull();
  expect(page.getByText("Не удалось открыть беседу").query()).toBeNull();

  starting = false;
  await vi.advanceTimersByTimeAsync(1_000);
  await expect.element(page.getByText("Не удалось открыть беседу")).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Повторить" })).toBeVisible();
});

test("сбой сети при проверке привязки и сбой чтения истории можно повторить без новой сессии", async () => {
  const events = fileConversation("Сохранённый ответ");
  const status = vi.fn()
    .mockRejectedValueOnce(new TypeError("raw network error"))
    .mockImplementation(() => Response.json({ eveSessionId: "eve-resumed", starting: false }));
  const history = vi.fn()
    .mockImplementationOnce(() => new Response(null, { status: 503 }))
    .mockImplementation(() => Response.json({
      events: events.map((payload, seq) => ({ seq, payload })),
      cursor: events.length,
    }));
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input, window.location.origin);
    if (url.pathname === "/eve/v1/session/eve-resumed/stream") {
      calls.push(url.searchParams.get("startIndex") ?? "");
      return new Response("");
    }
    if (url.pathname === STATUS_URL) return status();
    if (`${url.pathname}${url.search}` === HISTORY_URL) return history();
    if (url.pathname === `${STATUS_URL}/files`) return Response.json({ files: [] });
    if (url.pathname === `${STATUS_URL}/sandbox`) return Response.json({ state: "none" });
    throw new Error("Неожиданный запрос");
  }));
  await renderOnDesktop(chat());

  const failure = page.getByText("Не удалось открыть беседу");
  const retry = page.getByRole("button", { name: "Повторить" });
  await expect.element(failure).toBeVisible();
  await expect.element(page.getByText("raw network error")).not.toBeInTheDocument();

  await retry.click();
  await expect.element(failure).toBeVisible();
  expect(history).toHaveBeenCalledTimes(1);

  await retry.click();
  await expect.element(page.getByText("Сохранённый ответ")).toBeVisible();
  await expect.poll(() => calls).toContain(String(events.length));
  expect(status).toHaveBeenCalledTimes(2);
});
