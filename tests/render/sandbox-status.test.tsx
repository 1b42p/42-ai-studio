import { conversationReducer } from "eve/react";
import { afterEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";

import { ChatView } from "@/components/studio/chat/chat-view";
import { ChatPanel, type ChatAgent } from "@/components/studio/chat/chat-panel";
import type { ChatStatus } from "@/components/studio/chat/chat-status";
import type { SandboxStatus } from "@/lib/sandbox/status";
import { ThemeProvider } from "@/components/studio/theme-provider";

import { expectNoHorizontalScroll, renderOnDesktop, renderOnPhone } from "./support/render";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

for (const [viewport, render] of [["телефон", renderOnPhone], ["компьютер", renderOnDesktop]] as const) {
  test(`очередь показана над активным полем ввода — ${viewport}`, async () => {
    await render(
      <div className="h-dvh">
        <ChatView
          agent={{ data: conversationReducer.initial(), events: [], status: "streaming" }}
          sandboxStatus={{ state: "queued", queue: { position: 2, total: 4, reason: "capacity" } }}
          onCancel={vi.fn()}
          onRespond={vi.fn()}
          onSend={vi.fn()}
        />
      </div>,
    );

    const banner = page.getByRole("status", { name: "Состояние песочницы" });
    await expect.element(banner).toHaveTextContent(
      "Все песочницы заняты. Ваше место в очереди: 2 из 4. Сессия продолжит работу сама; если ожидание затянется и придёт ошибка, отправьте сообщение ещё раз.",
    );
    const input = page.getByRole("textbox", { name: "Сообщение агенту" });
    await expect.element(input).toBeEnabled();
    expect(banner.element().getBoundingClientRect().bottom).toBeLessThanOrEqual(
      input.element().getBoundingClientRect().top,
    );
    expectNoHorizontalScroll();
  });

  test(`запуск и ожидание своей сессии; остальные состояния без баннера — ${viewport}`, async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const states: SandboxStatus[] = [
      { state: "starting", queue: null },
      { state: "queued", queue: { position: 1, total: 1, reason: "own_session_busy" } },
      { state: "none", queue: null },
      { state: "started", queue: null },
      { state: "stopped", queue: null },
      { state: "archived", queue: null },
    ];
    for (const sandboxStatus of states) {
      const screen = await render(
        <div className="h-dvh">
          <ChatView
            agent={{ data: conversationReducer.initial(), events: [], status: "ready" }}
            sandboxStatus={sandboxStatus}
            onCancel={vi.fn()}
            onRespond={vi.fn()}
            onSend={vi.fn()}
          />
        </div>,
      );
      const banner = page.getByRole("status", { name: "Состояние песочницы" });
      if (sandboxStatus.state === "starting") {
        await expect.element(banner).toHaveTextContent("Запускаем песочницу…");
        expect(banner.element().querySelector('[data-slot="spinner"]')).not.toBeNull();
      } else if (sandboxStatus.state === "queued") {
        await expect.element(banner).toHaveTextContent(
          "Идёт работа в другой вашей сессии. Эта сессия продолжит работу, когда та закончит.",
        );
      } else {
        await expect.element(banner).not.toBeInTheDocument();
      }
      await expect.element(page.getByRole("textbox", { name: "Сообщение агенту" })).toBeEnabled();
      expectNoHorizontalScroll();
      await screen.unmount();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
}

function panel(status: ChatStatus = "streaming", appSessionId: string | null = "session-queue") {
  const agent = {
    data: conversationReducer.initial(),
    events: [],
    status,
    send: vi.fn(),
    cancel: vi.fn(),
    respond: vi.fn(),
  } as unknown as ChatAgent;
  return (
    <div className="h-dvh">
      <ChatPanel agent={agent} appSessionId={appSessionId} initialTitle="Ролик" messageFiles={{ entries: [] }} />
    </div>
  );
}

test("обёртка опрашивает очередь каждые три секунды, не прерывая ход", async () => {
  vi.useFakeTimers();
  let body: SandboxStatus = { state: "queued", queue: { position: 2, total: 4, reason: "capacity" } };
  const fetchMock = vi.fn(async (_url: RequestInfo | URL) => Response.json(body));
  vi.stubGlobal("fetch", fetchMock);
  const screen = await renderOnDesktop(panel());
  await vi.advanceTimersByTimeAsync(0);
  await expect.element(page.getByText(/Ваше место в очереди: 2 из 4/)).toBeVisible();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(String(fetchMock.mock.calls[0]![0])).toBe("/api/sessions/session-queue/sandbox");

  body = { state: "starting", queue: null };
  await vi.advanceTimersByTimeAsync(2_999);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  await expect.element(page.getByText("Запускаем песочницу…")).toBeVisible();
  expect(fetchMock).toHaveBeenCalledTimes(2);

  body = { state: "started", queue: null };
  await vi.advanceTimersByTimeAsync(3_000);
  await expect.element(page.getByRole("status", { name: "Состояние песочницы" })).not.toBeInTheDocument();
  await vi.advanceTimersByTimeAsync(3_000);
  expect(fetchMock).toHaveBeenCalledTimes(4);

  await screen.rerender(<ThemeProvider>{panel("ready")}</ThemeProvider>);
  await vi.advanceTimersByTimeAsync(0);
  const settledCalls = fetchMock.mock.calls.length;
  await vi.advanceTimersByTimeAsync(9_000);
  expect(fetchMock).toHaveBeenCalledTimes(settledCalls);
});

test("видимая очередь продолжает обновляться после конца хода даже при сбое сети", async () => {
  vi.useFakeTimers();
  const queued: SandboxStatus = {
    state: "queued", queue: { position: 1, total: 3, reason: "own_session_busy" },
  };
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(Response.json(queued))
    .mockRejectedValueOnce(new TypeError("Сеть недоступна"))
    .mockResolvedValue(Response.json({ state: "started", queue: null }));
  vi.stubGlobal("fetch", fetchMock);
  const screen = await renderOnDesktop(panel());
  await vi.advanceTimersByTimeAsync(0);
  await expect.element(page.getByText(/Идёт работа в другой вашей сессии/)).toBeVisible();

  await screen.rerender(<ThemeProvider>{panel("ready")}</ThemeProvider>);
  await vi.advanceTimersByTimeAsync(0);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  await expect.element(page.getByText(/Идёт работа в другой вашей сессии/)).toBeVisible();
  await vi.advanceTimersByTimeAsync(3_000);
  expect(fetchMock).toHaveBeenCalledTimes(3);
  await expect.element(page.getByRole("status", { name: "Состояние песочницы" })).not.toBeInTheDocument();
  await vi.advanceTimersByTimeAsync(9_000);
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

test("открытая очередь восстанавливается без активного хода и обновляет место", async () => {
  vi.useFakeTimers();
  let position = 3;
  const fetchMock = vi.fn(async () => Response.json({
    state: "queued", queue: { position, total: 5, reason: "capacity" },
  }));
  vi.stubGlobal("fetch", fetchMock);
  await renderOnPhone(panel("ready"));
  await vi.advanceTimersByTimeAsync(0);
  await expect.element(page.getByText(/Ваше место в очереди: 3 из 5/)).toBeVisible();
  position = 1;
  await vi.advanceTimersByTimeAsync(3_000);
  await expect.element(page.getByText(/Ваше место в очереди: 1 из 5/)).toBeVisible();
  await expect.element(page.getByRole("textbox", { name: "Сообщение агенту" })).toBeEnabled();
});

test("без id нет запросов; новый ход возобновляет остановленный опрос", async () => {
  vi.useFakeTimers();
  const fetchMock = vi.fn(async () => Response.json({ state: "started", queue: null }));
  vi.stubGlobal("fetch", fetchMock);
  const screen = await renderOnDesktop(panel("ready", null));
  await vi.advanceTimersByTimeAsync(9_000);
  expect(fetchMock).not.toHaveBeenCalled();

  await screen.rerender(<ThemeProvider>{panel("ready")}</ThemeProvider>);
  await vi.advanceTimersByTimeAsync(0);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(9_000);
  expect(fetchMock).toHaveBeenCalledTimes(1);

  await screen.rerender(<ThemeProvider>{panel("submitted")}</ThemeProvider>);
  await vi.advanceTimersByTimeAsync(0);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(3_000);
  expect(fetchMock).toHaveBeenCalledTimes(3);

  await screen.unmount();
  await vi.advanceTimersByTimeAsync(9_000);
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

test("поздний ответ предыдущей сессии не показывает чужую очередь", async () => {
  vi.useFakeTimers();
  let resolveOld!: (response: Response) => void;
  const fetchMock = vi.fn()
    .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveOld = resolve; }))
    .mockResolvedValueOnce(Response.json({ state: "started", queue: null }));
  vi.stubGlobal("fetch", fetchMock);
  const screen = await renderOnDesktop(panel());
  await screen.rerender(<ThemeProvider>{panel("ready", "session-other")}</ThemeProvider>);
  await vi.advanceTimersByTimeAsync(0);
  resolveOld(Response.json({ state: "queued", queue: { position: 7, total: 9, reason: "capacity" } }));
  await vi.advanceTimersByTimeAsync(0);
  await expect.element(page.getByRole("status", { name: "Состояние песочницы" })).not.toBeInTheDocument();
  await vi.advanceTimersByTimeAsync(9_000);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
