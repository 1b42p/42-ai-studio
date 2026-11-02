/** Карточка фоновой команды: опрос задания, вывод, ошибки и остановка (#11). */
import { conversationReducer, type EveDynamicToolPart } from "eve/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";

import { ChatView } from "@/components/studio/chat/chat-view";
import type { BashJobResponse } from "@/lib/sandbox/job-types";

import { cancelledConversation } from "./fixtures/conversations";
import { expectNoHorizontalScroll, renderOnDesktop, renderOnPhone } from "./support/render";

let sequence = 0;
let fetchMock: ReturnType<typeof vi.fn>;
let visibility: DocumentVisibilityState = "visible";

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  // Браузерный прогон не всегда считает страницу видимой, а опрос начинается
  // только на видимой вкладке.
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
});

afterEach(() => {
  visibility = "visible";
  delete (document as { visibilityState?: DocumentVisibilityState }).visibilityState;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function uniqueJobId(): string {
  sequence += 1;
  return sequence.toString(16).padStart(8, "0");
}

function bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

function bashPart(jobId: string, callId = `terminal-${jobId}`): EveDynamicToolPart {
  return {
    type: "dynamic-tool",
    toolName: "bash",
    toolCallId: callId,
    state: "output-available",
    input: { command: "npx remotion render" },
    output: {
      status: "running",
      pid: 4312,
      outputDirectory: `/tmp/.eve/jobs/${jobId}`,
      stdout: "старт\n",
      stderr: "",
      truncated: false,
      message: "Command is running",
    },
  } as unknown as EveDynamicToolPart;
}

function jobBody(jobId: string, overrides: Partial<BashJobResponse> = {}): BashJobResponse {
  return {
    jobId,
    status: "running",
    exitCode: null,
    stdout: "кадр 1\n",
    stderr: "",
    stdoutBytes: bytes("кадр 1\n"),
    stderrBytes: 0,
    truncated: false,
    source: "sandbox",
    updatedAt: "2026-10-24T12:00:00.000Z",
    ...overrides,
  };
}

function respond(body: BashJobResponse | Error | number) {
  if (body instanceof Error) fetchMock.mockRejectedValueOnce(body);
  else if (typeof body === "number") {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: {} }), { status: body }));
  } else {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }
}

function view(
  parts: EveDynamicToolPart[],
  options: { events?: Parameters<typeof ChatView>[0]["agent"]["events"]; appSessionId?: string | null } = {},
) {
  return (
    <div className="h-dvh">
      <ChatView
        agent={{
          data: {
            ...conversationReducer.initial(),
            messages: [{ id: "assistant-1", role: "assistant", parts }],
          },
          events: options.events ?? [],
          status: "ready",
        }}
        appSessionId={options.appSessionId ?? "session-id"}
        onCancel={vi.fn()}
        onRespond={vi.fn()}
        onSend={vi.fn()}
      />
    </div>
  );
}

async function settle(ms = 0) {
  await vi.advanceTimersByTimeAsync(ms);
}

for (const [viewport, render] of [["телефон", renderOnPhone], ["компьютер", renderOnDesktop]] as const) {
  test(`фоновая карточка сразу опрашивает задание и показывает вывод — ${viewport}`, async () => {
    const jobId = uniqueJobId();
    respond(jobBody(jobId));
    await render(view([bashPart(jobId)]));
    await settle();

    await expect.element(page.getByText("кадр 1", { exact: true })).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toBe(`/api/sessions/session-id/jobs/${jobId}`);
    expectNoHorizontalScroll();
  });
}

test("интервал 2 секунды, через минуту — 5, через десять минут — 10", async () => {
  const jobId = uniqueJobId();
  fetchMock.mockImplementation(async () => new Response(JSON.stringify(jobBody(jobId)), { status: 200 }));
  await renderOnDesktop(view([bashPart(jobId)]));
  await settle();
  expect(fetchMock).toHaveBeenCalledTimes(1);

  await settle(2_000);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  await settle(2_000);
  expect(fetchMock).toHaveBeenCalledTimes(3);

  vi.setSystemTime(Date.now() + 60_000);
  await settle(2_000);
  expect(fetchMock).toHaveBeenCalledTimes(4);
  await settle(4_999);
  expect(fetchMock).toHaveBeenCalledTimes(4);
  await settle(1);
  expect(fetchMock).toHaveBeenCalledTimes(5);

  vi.setSystemTime(Date.now() + 10 * 60_000);
  await settle(5_000);
  expect(fetchMock).toHaveBeenCalledTimes(6);
  await settle(9_999);
  expect(fetchMock).toHaveBeenCalledTimes(6);
  await settle(1);
  expect(fetchMock).toHaveBeenCalledTimes(7);
});

test("скрытая вкладка приостанавливает опрос и возобновляет при возвращении", async () => {
  const jobId = uniqueJobId();
  fetchMock.mockImplementation(async () => new Response(JSON.stringify(jobBody(jobId)), { status: 200 }));
  await renderOnDesktop(view([bashPart(jobId)]));
  await settle();
  expect(fetchMock).toHaveBeenCalledTimes(1);

  visibility = "hidden";
  document.dispatchEvent(new Event("visibilitychange"));
  await settle(15_000);
  expect(fetchMock).toHaveBeenCalledTimes(1);

  visibility = "visible";
  document.dispatchEvent(new Event("visibilitychange"));
  await settle();
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test("completed показывает код выхода и прекращает опрос", async () => {
  const jobId = uniqueJobId();
  respond(jobBody(jobId));
  respond(jobBody(jobId, { status: "completed", exitCode: 2, stderr: "не удалось", stderrBytes: 12 }));
  await renderOnDesktop(view([bashPart(jobId)]));
  await settle(2_000);

  await expect.element(page.getByText("Код 2", { exact: true })).toBeVisible();
  await expect.element(page.getByText("Ошибки", { exact: true })).toBeVisible();
  expect(document.querySelector('[data-variant="destructive"]')).not.toBeNull();
  await settle(60_000);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test("completed с кодом 0 показывает нейтральную метку", async () => {
  const jobId = uniqueJobId();
  respond(jobBody(jobId, { status: "completed", exitCode: 0, stdout: "готово\n", stderr: "" }));
  await renderOnDesktop(view([bashPart(jobId)]));
  await settle();

  await expect.element(page.getByText("Код 0", { exact: true })).toBeVisible();
  await expect.element(page.getByText("готово", { exact: true })).toBeVisible();
  expect(document.querySelector('[data-variant="destructive"]')).toBeNull();
});

test("interrupted показывает сообщение и последний вывод", async () => {
  const jobId = uniqueJobId();
  respond(jobBody(jobId, { status: "interrupted", stdout: "последний кадр\n" }));
  await renderOnDesktop(view([bashPart(jobId)]));
  await settle();

  await expect.element(page.getByText("Выполнение прервано: песочница была остановлена", { exact: true })).toBeVisible();
  await expect.element(page.getByText("последний кадр", { exact: true })).toBeVisible();
  await settle(30_000);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("пустой ответ оставляет вывод из результата bash", async () => {
  const jobId = uniqueJobId();
  respond(jobBody(jobId, { stdout: "", stderr: "" }));
  await renderOnDesktop(view([bashPart(jobId)]));
  await settle();

  await expect.element(page.getByText("старт", { exact: true })).toBeVisible();
});

test("длинный вывод идущего задания прокручивается вниз, пока читатель не ушёл наверх", async () => {
  const jobId = uniqueJobId();
  const lines = Array.from({ length: 80 }, (_, index) => `кадр ${index + 1}`).join("\n");
  const more = `${lines}\nкадр 81\n`;
  respond(jobBody(jobId, { stdout: lines, stdoutBytes: bytes(lines) }));
  respond(jobBody(jobId, { stdout: more, stdoutBytes: bytes(more) }));
  await renderOnDesktop(view([bashPart(jobId)]));
  await settle();
  await expect.element(page.getByText(lines, { exact: true })).toBeVisible();
  await settle();

  const scroller = page.getByText(lines, { exact: true }).element().parentElement!;
  expect(scroller.scrollTop + scroller.clientHeight).toBeGreaterThanOrEqual(scroller.scrollHeight - 8);

  scroller.scrollTop = 0;
  scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
  await settle(2_000);
  expect(scroller.scrollTop).toBe(0);
});

test("пять ошибок подряд показывают «Нет связи, повторяем…»", async () => {
  const jobId = uniqueJobId();
  fetchMock.mockRejectedValue(new Error("сеть"));
  await renderOnDesktop(view([bashPart(jobId)]));
  await settle();
  expect(fetchMock).toHaveBeenCalledTimes(1);

  await settle(2_000); // 2
  await settle(4_000); // 3
  await settle(8_000); // 4
  await settle(16_000); // 5
  expect(fetchMock).toHaveBeenCalledTimes(5);
  await expect.element(page.getByText("Нет связи, повторяем…", { exact: true })).toBeVisible();

  await settle(30_000);
  expect(fetchMock).toHaveBeenCalledTimes(6);
  await expect.element(page.getByText("Нет связи, повторяем…", { exact: true })).toBeVisible();
});

test("401 и 404 останавливают опрос и объясняют причину", async () => {
  const unauthorized = uniqueJobId();
  respond(401);
  await renderOnDesktop(view([bashPart(unauthorized)]));
  await settle();
  await expect.element(page.getByText("Войдите снова", { exact: true })).toBeVisible();
  await settle(60_000);
  expect(fetchMock).toHaveBeenCalledTimes(1);

  const missing = uniqueJobId();
  respond(404);
  await renderOnDesktop(view([bashPart(missing)]));
  await settle();
  await expect.element(page.getByText("Задание недоступно", { exact: true })).toBeVisible();
  await settle(60_000);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test("опрос идёт после «Стоп», когда ход уже ожидает", async () => {
  const jobId = uniqueJobId();
  respond(jobBody(jobId));
  await renderOnDesktop(view([bashPart(jobId)], { events: cancelledConversation() }));
  await settle();

  await expect.element(page.getByText("кадр 1", { exact: true })).toBeVisible();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("два экземпляра одного задания делают один запрос", async () => {
  const jobId = uniqueJobId();
  fetchMock.mockImplementation(async () => new Response(JSON.stringify(jobBody(jobId)), { status: 200 }));
  await renderOnDesktop(view([bashPart(jobId, "terminal-a"), bashPart(jobId, "terminal-b")]));
  await settle();

  expect(fetchMock).toHaveBeenCalledTimes(1);
  await expect.element(page.getByText("кадр 1", { exact: true }).first()).toBeVisible();
});
