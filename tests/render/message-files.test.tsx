/**
 * Отрисовка файлов из ответа агента (#8): видео, аудио, изображение, карточка
 * скачивания, скелет и заглушки; телефон и компьютер.
 */
import type { MessageStreamEvent } from "eve/client";
import { conversationReducer, type ConversationState } from "eve/react";
import { afterEach, beforeEach, describe, expect, test, vi, type MockInstance } from "vitest";
import { commands, page } from "vitest/browser";

import { ChatView } from "@/components/studio/chat/chat-view";
import type { MessageFilesState } from "@/components/studio/chat/message-files";
import { resolveSandboxPath } from "@/lib/media/sandbox-path";
import type { MessageFileView } from "@/lib/media/types";

import { fileConversation } from "./fixtures/conversations";
import { expectNoHorizontalScroll, renderOnDesktop, renderOnPhone } from "./support/render";

const MEDIA_ID = "0b9b4b0a-1a1a-4a4a-8a8a-123456789abc";

function stateOf(events: readonly MessageStreamEvent[]): ConversationState {
  return events.reduce<ConversationState>(
    (state, event) => conversationReducer.reduce(state, event),
    conversationReducer.initial(),
  );
}

function entry(path: string, overrides: Partial<MessageFileView> = {}): MessageFileView {
  return {
    messageId: "turn_0:0",
    path,
    state: "ready",
    reason: null,
    mediaId: MEDIA_ID,
    contentType: "application/octet-stream",
    name: path.split("/").at(-1) ?? "file",
    sizeBytes: 2048,
    ...overrides,
  };
}

function view(text: string, messageFiles?: MessageFilesState) {
  const events = fileConversation(text);
  return (
    <div className="h-dvh">
      <ChatView
        agent={{ data: stateOf(events), events, status: "ready" }}
        messageFiles={messageFiles}
        onCancel={vi.fn()}
        onRespond={vi.fn()}
        onSend={vi.fn()}
      />
    </div>
  );
}

let errors: MockInstance<typeof console.error>;

beforeEach(() => {
  errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  const nesting = errors.mock.calls.filter((args) =>
    args.some((value) => String(value).includes("validateDOMNesting")),
  );
  errors.mockRestore();
  expect(nesting).toEqual([]);
});

describe("файлы в ответе", () => {
  test("в браузере разбор даёт тот же результат, что на сервере", () => {
    expect(resolveSandboxPath("out/final.mp4")).toEqual({
      kind: "file",
      path: "/workspace/out/final.mp4",
    });
    expect(resolveSandboxPath("%2e%2e/x")).toEqual({
      kind: "rejected",
      path: "/x",
      reason: "outside_workspace",
    });
    expect(resolveSandboxPath("https://example.com/a.mp4")).toEqual({ kind: "external" });
  });

  test("видео играется плеером, подпись и скачивание на месте", async () => {
    const phone = await renderOnPhone(
      view("Вот [ролик](out/final.mp4)", {
        entries: [
          entry("/workspace/out/final.mp4", {
            contentType: "video/mp4",
            name: "final.mp4",
          }),
        ],
      }),
    );

    await expect.element(page.getByText("ролик")).toBeVisible();
    const video = document.querySelector("video");
    expect(video).not.toBeNull();
    expect(video?.getAttribute("src")).toContain(`/api/media/${MEDIA_ID}`);
    expect(video?.getAttribute("controls")).not.toBeNull();
    expect(document.body.textContent).not.toContain("[blocked]");
    expectNoHorizontalScroll();
    await phone.unmount();

    await renderOnDesktop(
      view("Вот [ролик](out/final.mp4)", {
        entries: [entry("/workspace/out/final.mp4", { contentType: "video/mp4" })],
      }),
    );
    expect(document.querySelector("video")).not.toBeNull();
    expectNoHorizontalScroll();
  });

  test("относительный, точечный и абсолютный пути дают один и тот же файл", async () => {
    await renderOnDesktop(
      view(
        "Вот [a](out/final.mp4), [b](./out/final.mp4) и [c](/workspace/out/final.mp4)",
        {
          entries: [
            entry("/workspace/out/final.mp4", {
              contentType: "video/mp4",
              name: "final.mp4",
            }),
          ],
        },
      ),
    );

    const videos = document.querySelectorAll("video");
    expect(videos).toHaveLength(3);
    for (const video of videos) {
      expect(video.getAttribute("src")).toContain(`/api/media/${MEDIA_ID}`);
    }
    expect(document.body.textContent).not.toContain("[blocked]");
  });

  test("ссылка-определение тоже доходит до файла", async () => {
    await renderOnDesktop(
      view("Вот [ролик][ref]\n\n[ref]: out/final.mp4", {
        entries: [entry("/workspace/out/final.mp4", { contentType: "video/mp4" })],
      }),
    );

    const video = document.querySelector("video");
    expect(video).not.toBeNull();
    expect(video?.getAttribute("src")).toContain(`/api/media/${MEDIA_ID}`);
  });

  test("аудио показывает русские подписи плеера", async () => {
    const audio = () =>
      view("![озвучка](out/voice.mp3)", {
        entries: [
          entry("/workspace/out/voice.mp3", {
            contentType: "audio/mpeg",
            name: "voice.mp3",
          }),
        ],
      });

    const phone = await renderOnPhone(audio());
    await expect.element(page.getByRole("button", { name: "Воспроизвести" })).toBeVisible();
    await expect.element(page.getByRole("slider", { name: "Перемотка" })).toBeVisible();
    expectNoHorizontalScroll();
    await phone.unmount();

    await renderOnDesktop(audio());
    await expect.element(page.getByRole("button", { name: /Скорость 1×/ })).toBeVisible();
  });

  test("изображение видно с alt и кнопкой скачивания", async () => {
    const phone = await renderOnPhone(
      view("![кадр](out/frame.png)", {
        entries: [
          entry("/workspace/out/frame.png", {
            contentType: "image/png",
            name: "frame.png",
          }),
        ],
      }),
    );

    const image = document.querySelector("img");
    expect(image).not.toBeNull();
    expect(image?.getAttribute("alt")).toBe("кадр");
    expect(image?.getAttribute("src")).toContain(`/api/media/${MEDIA_ID}`);
    const download = page.getByText("Скачать").element().closest("a");
    expect(download?.getAttribute("href")).toBe(`/api/media/${MEDIA_ID}?download=1`);
    expectNoHorizontalScroll();
    await phone.unmount();
  });

  test("прочий файл — карточка с именем, размером и скачиванием", async () => {
    await renderOnDesktop(
      view("[документ](out/report.pdf)", {
        entries: [
          entry("/workspace/out/report.pdf", {
            contentType: "application/pdf",
            name: "report.pdf",
            sizeBytes: 2048,
          }),
        ],
      }),
    );

    await expect.element(page.getByText("report.pdf")).toBeVisible();
    await expect.element(page.getByText("2 КБ")).toBeVisible();
    const download = page.getByRole("button", { name: "Скачать" }).element();
    const href =
      download.getAttribute("href") ?? download.closest("a")?.getAttribute("href");
    expect(href).toBe(`/api/media/${MEDIA_ID}?download=1`);
  });

  test("скелет «Файл готовится…» при copying и при отсутствии строки в идущем ходе", async () => {
    const first = await renderOnDesktop(
      view("![кадр](out/frame.png)", {
        entries: [entry("/workspace/out/frame.png", { state: "copying", mediaId: null })],
      }),
    );
    await expect.element(page.getByText("Файл готовится…")).toBeVisible();
    await first.unmount();

    await renderOnDesktop(
      view("![кадр](out/frame.png)", {
        entries: [],
        pendingMessageIds: ["turn_0:0"],
      }),
    );
    await expect.element(page.getByText("Файл готовится…")).toBeVisible();
  });

  test("все три заглушки и старое сообщение без строки", async () => {
    const notFound = await renderOnDesktop(
      view("![кадр](out/frame.png)", {
        entries: [entry("/workspace/out/frame.png", { state: "missing", reason: "not_found" })],
      }),
    );
    await expect.element(page.getByText("Файл не найден")).toBeVisible();
    await notFound.unmount();

    const outside = await renderOnDesktop(
      view("![кадр](../frame.png)", { entries: [] }),
    );
    await expect.element(page.getByText("Файл не найден")).toBeVisible();
    await outside.unmount();

    const tooLarge = await renderOnDesktop(
      view("![кадр](out/frame.png)", {
        entries: [entry("/workspace/out/frame.png", { state: "missing", reason: "too_large" })],
      }),
    );
    await expect
      .element(page.getByText("Файл слишком большой и не сохранён"))
      .toBeVisible();
    await tooLarge.unmount();

    const failed = await renderOnDesktop(
      view("![кадр](out/frame.png)", {
        entries: [entry("/workspace/out/frame.png", { state: "missing", reason: "copy_failed" })],
      }),
    );
    await expect.element(page.getByText("Не удалось сохранить файл")).toBeVisible();
    await failed.unmount();

    const tooMany = await renderOnDesktop(
      view("![кадр](out/frame.png)", {
        entries: [entry("/workspace/out/frame.png", { state: "missing", reason: "too_many" })],
      }),
    );
    await expect.element(page.getByText("Не удалось сохранить файл")).toBeVisible();
    await tooMany.unmount();

    // Завершённое старое сообщение: строки нет и ход не идёт.
    await renderOnDesktop(view("![кадр](out/frame.png)", { entries: [] }));
    await expect.element(page.getByText("Файл не найден")).toBeVisible();
  });

  test("все формы отвергнутых путей дают «Файл не найден»", async () => {
    await renderOnDesktop(
      view(
        "![a](../x) ![b](%2e%2e/x) ![c](/etc/passwd) ![d](/workspace/../etc/passwd) ![e](/workspace)",
        { entries: [] },
      ),
    );

    await expect.element(page.getByText("Файл не найден").first()).toBeVisible();
    expect(page.getByText("Файл не найден").elements()).toHaveLength(5);
  });

  test("режим без файлов выводит путь текстом", async () => {
    await renderOnDesktop(
      view("Вот [ролик](out/final.mp4), ![кадр](out/frame.png) и [плохая](../x)", {
        entries: [],
        enabled: false,
      }),
    );

    await expect.element(page.getByText("/workspace/out/final.mp4")).toBeVisible();
    await expect.element(page.getByText("/workspace/out/frame.png")).toBeVisible();
    await expect.element(page.getByText("/x")).toBeVisible();
    expect(document.querySelector("video")).toBeNull();
    expect(document.querySelector("img")).toBeNull();
  });

  test("удалённые изображения блокируются, внешняя ссылка остаётся ссылкой", async () => {
    await renderOnDesktop(
      view("![чужое](https://example.com/x.png) и [внешняя](https://example.com/page)", {
        entries: [],
      }),
    );

    await expect.element(page.getByText("[Image blocked: чужое]")).toBeVisible();
    await expect.element(page.getByText("внешняя")).toBeVisible();
    expect(document.querySelector("img")).toBeNull();
  });

  test("ошибка видео один раз перезапрашивает ссылку с ?retry=1", async () => {
    await commands.retryMedia("**/api/media/**");
    await renderOnDesktop(
      view("![кадр](out/final.mp4)", {
        entries: [
          entry("/workspace/out/final.mp4", {
            contentType: "video/mp4",
            name: "final.mp4",
          }),
        ],
      }),
    );

    await vi.waitFor(() => {
      const video = document.querySelector("video");
      expect(video?.getAttribute("src")).toContain("retry=1");
    });
    await vi.waitFor(() => {
      expect(document.querySelector("video")).not.toBeNull();
    });
  });

  test("повторная ошибка показывает карточку скачивания", async () => {
    await commands.failMedia("**/api/media/**");
    await renderOnDesktop(
      view("![кадр](out/final.mp4)", {
        entries: [
          entry("/workspace/out/final.mp4", {
            contentType: "video/mp4",
            name: "final.mp4",
          }),
        ],
      }),
    );

    // Первая ошибка оставила бы видео с адресом `?retry=1`; карточка
    // появляется только после второй.
    await vi.waitFor(() => {
      expect(document.querySelector("video")).toBeNull();
    });
    await expect.element(page.getByRole("button", { name: "Скачать" })).toBeVisible();
  });
});
