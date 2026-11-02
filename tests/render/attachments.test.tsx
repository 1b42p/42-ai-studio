/**
 * Вложения сообщения (#9): скрепка, перетаскивание, вставка, прогресс, ошибки,
 * лента пользовательского сообщения и раскладки.
 */
import type { UserContent } from "ai";
import type { MessageStreamEvent } from "eve/client";
import { conversationReducer, type ConversationState } from "eve/react";
import { afterEach, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import { ChatView } from "@/components/studio/chat/chat-view";
import { selectAttachableFiles } from "@/components/studio/chat/attachments";
import { useAttachments } from "@/components/studio/chat/use-attachments";

import { simpleConversation, userFilesConversation } from "./fixtures/conversations";
import { expectNoHorizontalScroll, renderOnDesktop, renderOnPhone } from "./support/render";
import { fakeXhr, type FakeXhrController } from "./support/xhr";

const SESSION_ID = "0b9b4b0a-1a1a-4a4a-8a8a-123456789abc";
const IMAGE_ID = "1b9b4b0a-1a1a-4a4a-8a8a-123456789abc";
const FILE_ID = "2b9b4b0a-1a1a-4a4a-8a8a-123456789abc";

function stateOf(events: readonly MessageStreamEvent[]): ConversationState {
  return events.reduce<ConversationState>(
    (state, event) => conversationReducer.reduce(state, event),
    conversationReducer.initial(),
  );
}

function file(name: string, size = 8, type = "text/plain"): File {
  return new File([new Uint8Array(size)], name, { type });
}

interface UploadStub {
  /** Возвращать ошибку сервера на каждый `POST /api/uploads`. */
  failure?: { status: number; message: string };
  calls: () => number;
  bodies: () => Array<Record<string, unknown>>;
}

/** Подменяет `fetch` только для `POST /api/uploads`. */
function stubUploads(): UploadStub {
  const original = window.fetch.bind(window);
  let calls = 0;
  let failure: UploadStub["failure"];
  const bodies: Array<Record<string, unknown>> = [];

  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.endsWith("/api/uploads")) {
      return original(input as RequestInfo, init);
    }
    calls += 1;
    if (typeof init?.body === "string") bodies.push(JSON.parse(init.body) as Record<string, unknown>);
    if (failure !== undefined) {
      return new Response(
        JSON.stringify({ error: { code: "x", message: failure.message } }),
        { status: failure.status, headers: { "content-type": "application/json" } },
      );
    }
    const id = crypto.randomUUID();
    return new Response(
      JSON.stringify({
        id,
        uploadUrl: `https://storage.test/upload/${id}`,
        method: "PUT",
        headers: { "Content-Type": "text/plain" },
        expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        fileUrl: new URL(`/api/media/${id}`, window.location.origin).href,
      }),
      { status: 201, headers: { "content-type": "application/json" } },
    );
  });

  vi.stubGlobal("fetch", mock);

  return {
    get failure() {
      return failure;
    },
    set failure(value) {
      failure = value;
    },
    calls: () => calls,
    bodies: () => bodies,
  };
}

function ChatHarness({
  onSend,
  events = simpleConversation,
}: {
  onSend: (content: string | UserContent) => void | Promise<void>;
  events?: MessageStreamEvent[];
}) {
  const attachments = useAttachments({
    appSessionId: SESSION_ID,
    ensureSession: async () => SESSION_ID,
  });

  return (
    <div className="h-dvh">
      <ChatView
        agent={{ data: stateOf(events), events, status: "ready" }}
        attachments={attachments}
        onCancel={vi.fn()}
        onRespond={vi.fn()}
        onSend={onSend}
      />
    </div>
  );
}

async function chooseFiles(files: File[]): Promise<void> {
  const input = document.querySelector<HTMLInputElement>(
    'input[data-testid="attachment-file-input"]',
  );
  expect(input).not.toBeNull();
  await userEvent.upload(input!, files);
}

async function waitForRequests(xhr: FakeXhrController, count: number): Promise<void> {
  await vi.waitFor(() => {
    expect(xhr.instances.length).toBe(count);
  });
}

function sendButton(): HTMLButtonElement {
  return page.getByRole("button", { name: "Отправить" }).element() as HTMLButtonElement;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("скрепка прикладывает файлы, показывает миниатюру, прогресс и отправляет части", async () => {
  const xhr = fakeXhr();
  stubUploads();
  const onSend = vi.fn();

  await renderOnDesktop(<ChatHarness onSend={onSend} />);
  expect(document.querySelector('[data-slot="attachment"]')).toBeNull();

  // Скрепка открывает выбор файлов.
  const input = document.querySelector<HTMLInputElement>(
    'input[data-testid="attachment-file-input"]',
  )!;
  const open = vi.spyOn(input, "click").mockImplementation(() => {});
  await page.getByRole("button", { name: "Прикрепить файлы" }).click();
  expect(open).toHaveBeenCalledTimes(1);
  open.mockRestore();

  await chooseFiles([file("photo.png", 10, "image/png"), file("doc.txt", 20)]);

  await expect.element(page.getByText("photo.png")).toBeVisible();
  await expect.element(page.getByText("doc.txt")).toBeVisible();
  // Изображение — миниатюрой, остальное — значком.
  const media = document.querySelectorAll('[data-slot="attachment-media"]');
  expect(media[0]?.querySelector("img")).not.toBeNull();
  expect(media[1]?.querySelector("svg")).not.toBeNull();
  expect(sendButton().disabled).toBe(true);

  await waitForRequests(xhr, 2);
  xhr.instances[0]!.progress(0, 100);
  await expect.element(page.getByText(/· 0%/).first()).toBeVisible();
  xhr.instances[0]!.progress(50, 100);
  await expect.element(page.getByText(/· 50%/).first()).toBeVisible();
  xhr.instances[0]!.progress(100, 100);
  await expect.element(page.getByText(/· 100%/).first()).toBeVisible();

  xhr.instances[0]!.succeed();
  await vi.waitFor(() => {
    expect(sendButton().disabled).toBe(true);
  });
  xhr.instances[1]!.succeed();
  await vi.waitFor(() => {
    expect(sendButton().disabled).toBe(false);
  });

  await page.getByRole("textbox", { name: "Сообщение агенту" }).fill("Посмотри");
  await page.getByRole("button", { name: "Отправить" }).click();

  expect(onSend).toHaveBeenCalledTimes(1);
  const content = onSend.mock.calls[0]![0] as UserContent;
  expect(Array.isArray(content)).toBe(true);
  const parts = content as unknown as Array<Record<string, unknown>>;
  expect(parts[0]).toMatchObject({ type: "text", text: "Посмотри" });
  expect(parts.slice(1)).toHaveLength(2);
  for (const part of parts.slice(1)) {
    expect(part.type).toBe("file");
    expect(String(part.data)).toContain("/api/media/");
  }
  await expect.element(page.getByText("photo.png")).not.toBeInTheDocument();
});

test("сессия приложения создаётся перед первой загрузкой", async () => {
  const xhr = fakeXhr();
  const uploads = stubUploads();
  const ensure = vi.fn(async () => SESSION_ID);

  function Harness() {
    const attachments = useAttachments({ appSessionId: null, ensureSession: ensure });
    return (
      <div className="h-dvh">
        <ChatView
          agent={{ data: stateOf(simpleConversation), events: simpleConversation, status: "ready" }}
          attachments={attachments}
          onCancel={vi.fn()}
          onRespond={vi.fn()}
          onSend={vi.fn()}
        />
      </div>
    );
  }

  await renderOnDesktop(<Harness />);
  await chooseFiles([file("first.txt")]);
  await waitForRequests(xhr, 1);

  expect(ensure).toHaveBeenCalledTimes(1);
  expect(uploads.bodies()[0]).toMatchObject({
    appSessionId: SESSION_ID,
    name: "first.txt",
    sizeBytes: 8,
  });
});

test("ошибка сервера показывает текст, «Повторить» повторяет загрузку", async () => {
  const xhr = fakeXhr();
  const uploads = stubUploads();
  uploads.failure = { status: 413, message: "Файл «big.bin» больше допустимых 1 МиБ." };
  const onSend = vi.fn();

  await renderOnDesktop(<ChatHarness onSend={onSend} />);
  await chooseFiles([file("big.bin", 10, "application/octet-stream")]);

  await expect
    .element(page.getByText("Файл «big.bin» больше допустимых 1 МиБ."))
    .toBeVisible();
  await expect.element(page.getByRole("button", { name: "Повторить" })).toBeVisible();
  expect(sendButton().disabled).toBe(true);
  expect(xhr.instances).toHaveLength(0);

  uploads.failure = undefined;
  await page.getByRole("button", { name: "Повторить" }).click();

  await waitForRequests(xhr, 1);
  xhr.last().succeed();
  await vi.waitFor(() => {
    expect(sendButton().disabled).toBe(false);
  });
  await expect
    .element(page.getByText("Файл «big.bin» больше допустимых 1 МиБ."))
    .not.toBeInTheDocument();
});

test("«Убрать файл» прерывает загрузку и убирает карточку", async () => {
  const xhr = fakeXhr();
  stubUploads();

  await renderOnDesktop(<ChatHarness onSend={vi.fn()} />);
  await chooseFiles([file("stop.txt")]);
  await expect.element(page.getByText("stop.txt")).toBeVisible();
  await waitForRequests(xhr, 1);

  await page.getByRole("button", { name: "Убрать файл" }).click();

  expect(xhr.last().aborted).toBe(true);
  await expect.element(page.getByText("stop.txt")).not.toBeInTheDocument();
  expect(sendButton().disabled).toBe(true);
});

test("перетаскивание показывает подсказку и прикладывает файл, вставка называет снимок", async () => {
  fakeXhr();
  stubUploads();

  await renderOnDesktop(<ChatHarness onSend={vi.fn()} />);
  const textarea = page.getByRole("textbox", { name: "Сообщение агенту" }).element();

  const dropped = new DataTransfer();
  dropped.items.add(file("drop.txt"));
  textarea.dispatchEvent(
    new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: dropped }),
  );
  await expect.element(page.getByText("Отпустите файлы, чтобы прикрепить")).toBeVisible();

  textarea.dispatchEvent(
    new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dropped }),
  );
  await expect.element(page.getByText("drop.txt")).toBeVisible();
  await expect
    .element(page.getByText("Отпустите файлы, чтобы прикрепить"))
    .not.toBeInTheDocument();

  const pasted = new DataTransfer();
  pasted.items.add(file("", 12, "image/png"));
  textarea.dispatchEvent(
    new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: pasted }),
  );

  await vi.waitFor(() => {
    expect(document.body.textContent).toMatch(/Снимок экрана \d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}\.png/);
  });
});

test("одиннадцатый файл не добавляется, сообщение объясняет предел", async () => {
  const xhr = fakeXhr();
  stubUploads();

  await renderOnDesktop(<ChatHarness onSend={vi.fn()} />);
  const ten = Array.from({ length: 10 }, (_, index) => file(`file-${index}.txt`));
  await chooseFiles(ten);
  await vi.waitFor(() => {
    expect(document.querySelectorAll('[data-slot="attachment"]')).toHaveLength(10);
  });

  await chooseFiles([file("file-10.txt")]);
  await expect
    .element(page.getByText("Можно прикрепить не больше 10 файлов к одному сообщению."))
    .toBeVisible();
  expect(document.querySelectorAll('[data-slot="attachment"]')).toHaveLength(10);
  await expect.element(page.getByText("file-10.txt")).not.toBeInTheDocument();
  // Одновременно идут только три загрузки, остальные ждут очереди.
  await waitForRequests(xhr, 3);
  expect(xhr.instances).toHaveLength(3);
});

test("суммарный предел 4 ГиБ объясняется", () => {
  const huge = { size: 5 * 1024 ** 3 } as File;
  const selection = selectAttachableFiles([], [huge]);
  expect(selection.accepted).toEqual([]);
  expect(selection.notice).toBe("Суммарный размер вложений не больше 4 ГиБ.");
});

test("вложения сообщения в ленте: имя, миниатюра и скачивание", async () => {
  const events = userFilesConversation([
    { filename: "кадр.png", mediaType: "image/png", url: `http://localhost:3000/api/media/${IMAGE_ID}` },
    { filename: "report.csv", mediaType: "text/csv", url: `http://localhost:3000/api/media/${FILE_ID}` },
  ]);

  const phone = await renderOnPhone(
    <div className="h-dvh">
      <ChatView
        agent={{ data: stateOf(events), events, status: "ready" }}
        onCancel={vi.fn()}
        onRespond={vi.fn()}
        onSend={vi.fn()}
      />
    </div>,
  );

  await expect.element(page.getByText("кадр.png")).toBeVisible();
  await expect.element(page.getByText("report.csv")).toBeVisible();
  const image = document.querySelector("img");
  expect(image?.getAttribute("src")).toBe(`/api/media/${IMAGE_ID}`);
  expect(document.querySelectorAll("img")).toHaveLength(1);
  const download = page.getByRole("link", { name: "Скачать кадр.png" }).element();
  expect(download.getAttribute("href")).toBe(`/api/media/${IMAGE_ID}?download=1`);
  expectNoHorizontalScroll();

  await phone.unmount();

  await renderOnDesktop(
    <div className="h-dvh">
      <ChatView
        agent={{ data: stateOf(events), events, status: "ready" }}
        onCancel={vi.fn()}
        onRespond={vi.fn()}
        onSend={vi.fn()}
      />
    </div>,
  );
  await expect.element(page.getByText("кадр.png")).toBeVisible();
  expectNoHorizontalScroll();
});

test("десять длинных имён не дают горизонтальной прокрутки на телефоне", async () => {
  fakeXhr();
  stubUploads();

  const phone = await renderOnPhone(<ChatHarness onSend={vi.fn()} />);
  const long = Array.from({ length: 10 }, (_, index) =>
    file(`${"очень-длинное-имя-".repeat(5)}${index}.pdf`, 10, "application/pdf"),
  );
  await chooseFiles(long);
  await vi.waitFor(() => {
    expect(document.querySelectorAll('[data-slot="attachment"]')).toHaveLength(10);
  });
  expectNoHorizontalScroll();
  await phone.unmount();

  await renderOnDesktop(<ChatHarness onSend={vi.fn()} />);
  await chooseFiles(long);
  await vi.waitFor(() => {
    expect(document.querySelectorAll('[data-slot="attachment"]')).toHaveLength(10);
  });
  expectNoHorizontalScroll();
});
