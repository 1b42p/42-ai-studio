import { EveAgentStore, conversationReducer, type MessageStreamEvent } from "eve/client";
import { afterEach, beforeEach, expect, onTestFinished, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { useState } from "react";
import type { UserContent } from "ai";

import { ChatComposer } from "@/components/studio/chat/chat-composer";
import { ChatDraftIdentityContext } from "@/components/studio/chat/draft-identity";
import type { AttachmentsController, PendingAttachment } from "@/components/studio/chat/attachments";
import { sendAcknowledged } from "@/components/studio/chat/send-acknowledged";
import { useStudioAgent } from "@/components/studio/chat/use-studio-agent";
import { ThemeProvider } from "@/components/studio/theme-provider";
import { renderOnDesktop } from "./support/render";
import { event } from "./fixtures/events";

const sessionId = "wrun_delivery_contract";

/** Native Client + EveAgentStore, with only HTTP and the NDJSON server controlled. */
function transport() {
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const posts: Array<{ message?: string | UserContent; turnPolicy?: string; inputResponses?: unknown }> = [];
  const cancels: unknown[] = [];
  let failPost = false;
  let nextPost: Promise<Response> | undefined;
  const request = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input), window.location.origin);
    if (url.pathname === `/eve/v1/session/${sessionId}/cancel`) {
      cancels.push(JSON.parse(String(init?.body ?? "{}")));
      return Response.json({ status: "accepted", sessionId });
    }
    if (url.pathname !== "/eve/v1/session" && url.pathname !== `/eve/v1/session/${sessionId}` &&
        url.pathname !== `/eve/v1/session/${sessionId}/stream`) {
      throw new Error(`Unexpected native SDK request: ${url.pathname}`);
    }
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      posts.push(body);
      if (nextPost) {
        const pending = nextPost;
        nextPost = undefined;
        return pending;
      }
      if (failPost) throw new TypeError("controlled connection failure");
      return Response.json({ sessionId, deliveryId: `delivery-${posts.length}` });
    }
    let controller: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(value) { controller = value; streams.add(value); },
      cancel() { streams.delete(controller); },
    });
    init?.signal?.addEventListener("abort", () => {
      if (streams.delete(controller)) controller.error(new DOMException("Aborted", "AbortError"));
    }, { once: true });
    return new Response(stream, { headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "x-eve-stream-format": "ndjson",
      "x-eve-stream-version": "26",
      "x-eve-stream-tail-index": "-1",
    } });
  });
  return {
    request, posts, streams, cancels,
    holdNextPost() {
      const pending = Promise.withResolvers<Response>();
      nextPost = pending.promise;
      return pending;
    },
    fail(value: boolean) { failPost = value; },
    emit(value: MessageStreamEvent, deliveryIds: string[]) {
      const bytes = new TextEncoder().encode(`${JSON.stringify({
        ...value, meta: { ...value.meta, deliveryIds },
      })}\n`);
      for (const controller of streams) controller.enqueue(bytes);
    },
    received(message: string, delivery: string | string[]) {
      this.emit(event("message.received", {
        message, parts: [{ type: "text", text: message }], sequence: 0, turnId: "turn_0",
      }), typeof delivery === "string" ? [delivery] : delivery);
    },
  };
}

function nativeStore() {
  const store = new EveAgentStore({
    reducer: conversationReducer, initialSession: { sessionId, streamIndex: 0 }, followIdle: false,
  });
  onTestFinished(() => store.reset());
  return store;
}

beforeEach(() => sessionStorage.clear());
afterEach(() => vi.restoreAllMocks());

test("настоящий store.send завершается без reject при сетевой ошибке, но ACK-команда отвергается", async () => {
  const wire = transport();
  wire.fail(true);
  const store = nativeStore();
  await expect(store.send({ message: "Первый текст" })).resolves.toBeUndefined();
  expect(store.snapshot.error).toBeDefined();
  expect(store.snapshot.conversation.messages.some((message) => message.metadata?.status === "failed")).toBe(true);
  await expect(sendAcknowledged(store, { message: "Повтор" })).rejects.toBeInstanceOf(Error);
});

test("ACK освобождает отправку до конца native send; одинаковое чужое сообщение не подтверждает steer", async () => {
  const wire = transport();
  const store = nativeStore();
  const send = vi.spyOn(store, "send");
  const accepted = sendAcknowledged(store, { message: "Начальный текст" });
  await expect.poll(() => wire.posts.length).toBe(1);
  await expect.poll(() => wire.streams.size).toBe(1);
  let turnFinished = false;
  void send.mock.results[0].value.then(() => { turnFinished = true; });
  wire.emit(event("turn.started", { sequence: 0, turnId: "turn_0" }), ["delivery-1"]);
  wire.received("Начальный текст", "delivery-1");
  await accepted;
  expect(turnFinished).toBe(false);
  expect(store.snapshot.status).toBe("streaming");

  let steerAccepted = false;
  const steered = sendAcknowledged(store, { message: "Поправка", turnPolicy: "steer" });
  void steered.then(() => { steerAccepted = true; });
  await expect.poll(() => wire.posts.length).toBe(2);
  expect(wire.posts[1].turnPolicy).toBe("steer");
  wire.received("Поправка", "unrelated-delivery");
  await expect.poll(() => store.snapshot.events.filter((item) => item.type === "message.received").length).toBe(2);
  expect(steerAccepted).toBe(false);
  wire.received("Поправка", "delivery-2");
  await steered;
  expect(turnFinished).toBe(false);
});

function Composer({ attachments, newSession = false, appSessionId = "existing-chat" }: {
  attachments: AttachmentsController; newSession?: boolean; appSessionId?: string | null;
}) {
  const agent = useStudioAgent(newSession ? {} : { initialSession: { sessionId, streamIndex: 0 } });
  return (
    <ChatDraftIdentityContext.Provider value="native-owner">
      <p role="status" aria-label="Статус native store">{agent.status}</p>
      <ChatComposer
        appSessionId={appSessionId} attachments={attachments} status={agent.status}
        onCancel={async () => { await agent.cancel(); }}
        onSend={(message) => agent.send(message, { turnPolicy: "steer" })}
      />
    </ChatDraftIdentityContext.Provider>
  );
}

test("ошибка старого root observer не отклоняет held steer, принятый позже с собственным delivery", async () => {
  const wire = transport();
  const store = nativeStore();
  const nativeSend = vi.spyOn(store, "send");
  const rootObserver = new AbortController();
  const root = sendAcknowledged(store, { message: "Корень", signal: rootObserver.signal });
  await expect.poll(() => wire.posts.length).toBe(1);
  await expect.poll(() => wire.streams.size).toBe(1);
  wire.emit(event("turn.started", { sequence: 0, turnId: "turn_0" }), ["delivery-1"]);
  wire.received("Корень", "delivery-1");
  await root;
  const post = wire.holdNextPost();
  const steer = sendAcknowledged(store, { message: "Ещё летящий steer", turnPolicy: "steer" });
  let outcome = "pending";
  void steer.then(() => { outcome = "accepted"; }, () => { outcome = "rejected"; });
  await expect.poll(() => wire.posts.length).toBe(2);
  // Public caller AbortSignal with an Error reason fails only the older reader.
  // The native shared session stream and independent steer request remain alive.
  rootObserver.abort(new Error("old root reader failed"));
  await expect.poll(() => store.snapshot.error?.message).toBe("old root reader failed");
  expect(outcome).toBe("pending");
  post.resolve(Response.json({ sessionId, deliveryId: "delivery-2" }));
  let nativeSteerFinished = false;
  void nativeSend.mock.results[1].value.then(() => { nativeSteerFinished = true; });
  await expect.poll(() => nativeSteerFinished).toBe(true);
  expect(outcome).toBe("pending");
  wire.received("Ещё летящий steer", "delivery-2");
  await steer;
  expect(outcome).toBe("accepted");
  expect(wire.posts).toHaveLength(2);
});

test("при смене appSessionId отказ старого native send не предлагает его текст/файлы в новой беседе", async () => {
  const wire = transport();
  const post = wire.holdNextPost();
  const original: AttachmentsController = {
    ...emptyAttachments(),
    items: [{ id: "old", name: "old.txt", contentType: "text/plain", sizeBytes: 1,
      progress: 100, state: "done", fileUrl: "/api/media/old" }],
  };
  const view = await renderOnDesktop(<Composer attachments={original} />);
  const field = page.getByRole("textbox", { name: "Сообщение агенту" });
  await field.fill("Исходный текст старой беседы");
  await page.getByRole("button", { name: "Отправить", exact: true }).click();
  await expect.poll(() => wire.posts.length).toBe(1);
  await field.fill("Следующий черновик старой беседы");
  await view.rerender(<ThemeProvider><Composer attachments={emptyAttachments()} appSessionId="other-chat" /></ThemeProvider>);
  post.reject(new TypeError("old session offline"));
  await expect.element(field).toHaveValue("");
  await field.fill("Черновик новой беседы");
  await expect.element(page.getByRole("button", { name: "Отправить", exact: true })).toBeEnabled();
  expect(document.body.textContent).not.toContain("Исходный текст старой беседы");
  expect(document.body.textContent).not.toContain("old.txt");
  expect(vi.mocked(original.clear)).not.toHaveBeenCalled();
  expect(sessionStorage.getItem("studio:draft:v1:native-owner:chat:existing-chat:pending")).toBe("Исходный текст старой беседы");
  expect(sessionStorage.getItem("studio:draft:v1:native-owner:chat:existing-chat")).toBe("Следующий черновик старой беседы");
});

test("new → created мигрирует ровно свою отправку и не привязывает её к следующему new", async () => {
  const wire = transport();
  const post = wire.holdNextPost();
  const attachments = emptyAttachments();
  const view = await renderOnDesktop(<Composer attachments={attachments} appSessionId={null} />);
  const field = page.getByRole("textbox", { name: "Сообщение агенту" });
  await field.fill("Исходная новая беседа");
  await page.getByRole("button", { name: "Отправить", exact: true }).click();
  await expect.poll(() => wire.posts.length).toBe(1);
  await field.fill("Следующий текст исходной беседы");
  await view.rerender(<ThemeProvider><Composer attachments={attachments} appSessionId="created-chat" /></ThemeProvider>);
  post.reject(new TypeError("creation delivery failed"));
  await expect.element(page.getByRole("button", { name: "Повторить отправку", exact: true })).toBeVisible();
  expect(sessionStorage.getItem("studio:draft:v1:native-owner:chat:created-chat:pending")).toBe("Исходная новая беседа");
  await view.rerender(<ThemeProvider><Composer attachments={emptyAttachments()} appSessionId={null} /></ThemeProvider>);
  await expect.element(field).toHaveValue("");
  await expect.element(page.getByRole("button", { name: "Повторить отправку", exact: true })).not.toBeInTheDocument();
  expect(document.body.textContent).not.toContain("Исходная новая беседа");
  expect(sessionStorage.getItem("studio:draft:v1:native-owner:chat:created-chat")).toBe("Следующий текст исходной беседы");
});

function RestoredComposer() {
  const [items, setItems] = useState<PendingAttachment[]>([{
    id: "next-draft-file", name: "next-draft.txt", contentType: "text/plain",
    sizeBytes: 4, progress: 100, state: "done", fileUrl: "/api/media/next-draft",
  }]);
  const attachments: AttachmentsController = {
    items, blocking: false,
    // A completed upload fixture; the message still traverses the real SDK.
    addFiles(files) {
      setItems((previous) => [...previous, ...files.map((file, index): PendingAttachment => ({
        id: `reattached-${index}`, name: file.name, contentType: file.type,
        sizeBytes: file.size, state: "done", progress: 100,
        fileUrl: `/api/media/reattached-${index}`,
      }))]);
    },
    remove(id) { setItems((previous) => previous.filter((item) => item.id !== id)); },
    retry() {},
    clear() { setItems([]); },
  };
  return <Composer attachments={attachments} />;
}

test("restored pending: явное повторное прикрепление входит в native POST исходного, следующий draft не теряется", async () => {
  const wire = transport();
  sessionStorage.setItem("studio:draft:v1:native-owner:chat:existing-chat:pending", "Текст с неподтверждённой доставкой");
  sessionStorage.setItem("studio:draft:v1:native-owner:chat:existing-chat", "Отдельный следующий черновик");
  await renderOnDesktop(<RestoredComposer />);
  const field = page.getByRole("textbox", { name: "Сообщение агенту" });
  await expect.element(field).toHaveValue("Отдельный следующий черновик");
  await expect.element(page.getByText("next-draft.txt", { exact: true })).toBeVisible();
  await expect.poll(() => page.getByRole("alert").element().textContent?.replace(/\s+/g, " ").trim())
    .toContain("Проверьте историю беседы перед повтором");
  await page.getByRole("button", { name: "Прикрепить файлы к повтору", exact: true }).click();
  const input = document.querySelector<HTMLInputElement>('input[data-testid="attachment-file-input"]');
  expect(input).not.toBeNull();
  await userEvent.upload(input!, [new File(["new"], "replacement.txt", { type: "text/plain" })]);
  await page.getByRole("button", { name: "Повторить с файлами", exact: true }).click();
  await expect.poll(() => wire.posts.length).toBe(1);
  expect(wire.posts[0].message).toEqual([
    { type: "text", text: "Текст с неподтверждённой доставкой" },
    { type: "file", filename: "replacement.txt", mediaType: "text/plain", data: "/api/media/reattached-0" },
  ]);
  wire.emit(event("turn.started", { sequence: 0, turnId: "turn_0" }), ["delivery-1"]);
  wire.received("Текст с неподтверждённой доставкой", "delivery-1");
  await expect.element(page.getByRole("button", { name: "Повторить с файлами", exact: true })).not.toBeInTheDocument();
  await expect.element(field).toHaveValue("Отдельный следующий черновик");
  await expect.element(page.getByText("next-draft.txt", { exact: true })).toBeVisible();
  expect(sessionStorage.getItem("studio:draft:v1:native-owner:chat:existing-chat:pending")).toBeNull();
  expect(sessionStorage.getItem("studio:draft:v1:native-owner:chat:existing-chat")).toBe("Отдельный следующий черновик");
  expect(JSON.stringify(sessionStorage)).not.toContain("replacement.txt");
});

test("restored pending: файловый следующий draft не смешивается с отказавшим и затем принятым повтором", async () => {
  const wire = transport();
  wire.fail(true);
  sessionStorage.setItem("studio:draft:v1:native-owner:chat:existing-chat:pending", "Исходный текст для повтора");
  await renderOnDesktop(<RestoredComposer />);
  const field = page.getByRole("textbox", { name: "Сообщение агенту" });
  await expect.element(field).toHaveValue("");
  await expect.element(page.getByText("next-draft.txt", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Прикрепить файлы к повтору", exact: true }).click();
  const input = document.querySelector<HTMLInputElement>('input[data-testid="attachment-file-input"]');
  expect(input).not.toBeNull();
  await userEvent.upload(input!, [new File(["new"], "replacement.txt", { type: "text/plain" })]);
  await page.getByRole("button", { name: "Повторить с файлами", exact: true }).click();
  await expect.element(page.getByRole("button", { name: "Повторить отправку", exact: true })).toBeVisible();
  await expect.element(field).toHaveValue("");
  await expect.element(page.getByText("next-draft.txt", { exact: true })).toBeVisible();
  expect(sessionStorage.getItem("studio:draft:v1:native-owner:chat:existing-chat:pending")).toBe("Исходный текст для повтора");
  const expected = [
    { type: "text", text: "Исходный текст для повтора" },
    { type: "file", filename: "replacement.txt", mediaType: "text/plain", data: "/api/media/reattached-0" },
  ];
  expect(wire.posts[0].message).toEqual(expected);

  wire.fail(false);
  await page.getByRole("button", { name: "Повторить отправку", exact: true }).click();
  await expect.poll(() => wire.posts.length).toBe(2);
  expect(wire.posts[1].message).toEqual(expected);
  expect(JSON.stringify(wire.posts)).not.toContain("/api/media/next-draft");
  wire.emit(event("turn.started", { sequence: 0, turnId: "turn_0" }), ["delivery-2"]);
  wire.received("Исходный текст для повтора", "delivery-2");
  await expect.element(page.getByRole("button", { name: "Повторить отправку", exact: true })).not.toBeInTheDocument();
  await expect.element(field).toHaveValue("");
  await expect.element(page.getByText("next-draft.txt", { exact: true })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Отправить", exact: true })).toBeEnabled();
  expect(sessionStorage.getItem("studio:draft:v1:native-owner:chat:existing-chat:pending")).toBeNull();
});

test("реальный store: failed snapshot сохраняет текст/файлы, message.received очищает и сразу разрешает steer", async () => {
  const wire = transport();
  wire.fail(true);
  const attachments: AttachmentsController = {
    items: [{ id: "file", name: "script.txt", contentType: "text/plain", sizeBytes: 3,
      state: "done", progress: 100, fileUrl: "/api/media/file" }],
    blocking: false, addFiles: vi.fn(), remove: vi.fn(), retry: vi.fn(), clear: vi.fn(),
  };
  const view = await renderOnDesktop(<Composer attachments={attachments} />);
  const field = page.getByRole("textbox", { name: "Сообщение агенту" });
  const send = page.getByRole("button", { name: "Отправить", exact: true });
  await field.fill("  Сохранить исходный текст  ");
  await send.click();
  await expect.poll(() => page.getByRole("alert").element().textContent?.replace(/\s+/g, " ").trim()).toContain("Попробуйте ещё раз");
  await expect.element(field).toHaveValue("  Сохранить исходный текст  ");
  await expect.element(field).toBeEnabled();
  expect(attachments.clear).not.toHaveBeenCalled();

  wire.fail(false);
  await send.click();
  await expect.poll(() => wire.posts.length).toBe(2);
  wire.emit(event("turn.started", { sequence: 0, turnId: "turn_0" }), ["delivery-2"]);
  wire.received("Сохранить исходный текст", "delivery-2");
  await expect.element(field).toHaveValue("");
  await expect.element(field).toBeEnabled();
  expect(attachments.clear).toHaveBeenCalledTimes(1);
  await field.fill("Поправка во время рендера");
  await send.click();
  await expect.poll(() => wire.posts.length).toBe(3);
  expect(wire.posts[2].turnPolicy).toBe("steer");
  // A steered message joins the same turn: its durable envelope retains the
  // root delivery too. Otherwise the root response reader filters it out and
  // followSteeredTurns correctly waits for a follow-up it has not consumed.
  wire.received("Поправка во время рендера", ["delivery-2", "delivery-3"]);
  await expect.element(field).toHaveValue("");
  await field.fill("Следующий черновик");
  wire.emit(event("turn.completed", { sequence: 0, turnId: "turn_0" }), ["delivery-2", "delivery-3"]);
  wire.emit(event("session.waiting", {
    wait: "next-user-message", continuationToken: "wrun_fixture",
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
  }), ["delivery-2", "delivery-3"]);
  await expect.element(page.getByRole("status", { name: "Статус native store" })).toHaveTextContent("ready");
  await expect.element(field).toHaveValue("Следующий черновик");
  await view.unmount();
  expect(sessionStorage.getItem("studio:draft:v1:native-owner:chat:existing-chat")).toBe("Следующий черновик");
});

function emptyAttachments(): AttachmentsController {
  return { items: [], blocking: false, addFiles: vi.fn(), remove: vi.fn(), retry: vi.fn(), clear: vi.fn() };
}

test("долгий pre-ACK не блокирует следующий текст, отказ сохраняет два буфера, повтор отправляет исходный", async () => {
  const wire = transport();
  const delayed = wire.holdNextPost();
  await renderOnDesktop(<Composer attachments={emptyAttachments()} />);
  const field = page.getByRole("textbox", { name: "Сообщение агенту" });
  await field.fill("Исходное сообщение");
  await page.getByRole("button", { name: "Отправить", exact: true }).click();
  await expect.poll(() => wire.posts.length).toBe(1);
  await expect.element(field).toBeEnabled();
  await expect.element(field).toHaveValue("");
  await field.fill("Следующее сообщение");
  expect(sessionStorage.getItem("studio:draft:v1:native-owner:chat:existing-chat:pending")).toBe("Исходное сообщение");
  delayed.reject(new TypeError("controlled offline"));
  await expect.element(page.getByRole("button", { name: "Повторить отправку", exact: true })).toBeVisible();
  await expect.element(field).toHaveValue("Следующее сообщение");
  await page.getByRole("button", { name: "Повторить отправку", exact: true }).click();
  await expect.poll(() => wire.posts.length).toBe(2);
  expect(wire.posts[1].message).toBe("Исходное сообщение");
  wire.emit(event("turn.started", { sequence: 0, turnId: "turn_0" }), ["delivery-2"]);
  wire.received("Исходное сообщение", "delivery-2");
  await expect.element(page.getByRole("button", { name: "Повторить отправку", exact: true })).not.toBeInTheDocument();
  await expect.element(field).toHaveValue("Следующее сообщение");
  await expect.element(page.getByRole("button", { name: "Отправить", exact: true })).toBeEnabled();
  expect(sessionStorage.getItem("studio:draft:v1:native-owner:chat:existing-chat:pending")).toBeNull();
});

test("первое сообщение с файлами: до message.received редактор активен, ACK не стирает следующий текст", async () => {
  const wire = transport();
  const attachments: AttachmentsController = {
    ...emptyAttachments(),
    items: [{ id: "uploaded", name: "first.txt", contentType: "text/plain",
      sizeBytes: 4, progress: 100, state: "done", fileUrl: "/api/media/uploaded" }],
  };
  await renderOnDesktop(<Composer attachments={attachments} newSession />);
  const field = page.getByRole("textbox", { name: "Сообщение агенту" });
  await field.fill("Первое задание с файлом");
  await page.getByRole("button", { name: "Отправить", exact: true }).click();
  await expect.poll(() => wire.posts.length).toBe(1);
  await expect.poll(() => wire.streams.size).toBe(1);
  await expect.element(field).toBeEnabled();
  await field.fill("Следующее задание, пока доставляются файлы");
  expect(attachments.clear).not.toHaveBeenCalled();
  expect(sessionStorage.getItem("studio:draft:v1:native-owner:chat:existing-chat:pending")).toBe("Первое задание с файлом");
  wire.emit(event("turn.started", { sequence: 0, turnId: "turn_0" }), ["delivery-1"]);
  wire.received("Первое задание с файлом", "delivery-1");
  await expect.poll(() => vi.mocked(attachments.clear).mock.calls.length).toBe(1);
  await expect.element(field).toHaveValue("Следующее задание, пока доставляются файлы");
  expect(sessionStorage.getItem("studio:draft:v1:native-owner:chat:existing-chat:pending")).toBeNull();
});

test("cancel до message.received не теряет исходный буфер и набранное следующее сообщение", async () => {
  const wire = transport();
  await renderOnDesktop(<Composer attachments={emptyAttachments()} />);
  const field = page.getByRole("textbox", { name: "Сообщение агенту" });
  await field.fill("Сообщение в очереди");
  await page.getByRole("button", { name: "Отправить", exact: true }).click();
  await expect.poll(() => wire.posts.length).toBe(1);
  wire.emit(event("turn.started", { sequence: 0, turnId: "turn_0" }), ["delivery-1"]);
  await field.fill("Новый черновик");
  await page.getByRole("button", { name: "Стоп", exact: true }).click();
  await expect.poll(() => wire.cancels.length).toBe(1);
  wire.emit(event("turn.cancelled", { sequence: 0, turnId: "turn_0" }), ["delivery-1"]);
  wire.emit(event("session.waiting", {
    wait: "next-user-message", continuationToken: "wrun_fixture",
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  }), ["delivery-1"]);
  await expect.element(page.getByRole("button", { name: "Повторить отправку", exact: true })).toBeVisible();
  await expect.element(field).toHaveValue("Новый черновик");
  expect(sessionStorage.getItem("studio:draft:v1:native-owner:chat:existing-chat:pending")).toBe("Сообщение в очереди");
});
