import { afterEach, expect, test, vi } from "vitest";
import { cdp, page, userEvent } from "vitest/browser";

import { ChatView } from "@/components/studio/chat/chat-view";

import { downloadConversation, type DownloadScenario } from "./fixtures/download-video";
import { expectNoHorizontalScroll, renderOnDesktop, renderOnPhone } from "./support/render";

let restoreNetwork: (() => Promise<void>) | undefined;

afterEach(async () => {
  await restoreNetwork?.();
  restoreNetwork = undefined;
});

async function serveFrames() {
  const session = cdp();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="100%" height="100%" fill="#335544"/></svg>`;
  const onRequest = async ({ requestId }: { requestId: string }) => {
    await session.send("Fetch.fulfillRequest", {
      requestId,
      responseCode: 200,
      responseHeaders: [
        { name: "Content-Type", value: "image/svg+xml" },
        { name: "Cache-Control", value: "no-store" },
      ],
      body: btoa(svg),
    });
  };
  session.on("Fetch.requestPaused", onRequest);
  await session.send("Fetch.enable", {
    patterns: [{ urlPattern: "*/api/media/*", resourceType: "Image", requestStage: "Request" }],
  });
  restoreNetwork = async () => {
    await session.send("Fetch.disable");
    session.off("Fetch.requestPaused", onRequest);
  };
}

function view(name: DownloadScenario["name"]) {
  return (
    <div className="h-dvh">
      <ChatView
        agent={downloadConversation({ name })}
        onCancel={vi.fn()}
        onRespond={vi.fn()}
        onSend={vi.fn()}
      />
    </div>
  );
}

function assertPlainText() {
  expectNoHorizontalScroll();
  const text = document.body.innerText;
  expect(text).not.toContain("download_video");
  expect(text).not.toContain("{");
}

test("телефон показывает фазы, кадры, пропуски, ошибку и не растягивает страницу", async () => {
  await serveFrames();
  await renderOnPhone(view("running"));
  await expect.element(page.getByText("Скачиваю")).toBeVisible();
  assertPlainText();

  await renderOnPhone(view("ready"));
  await expect.element(page.getByText("А".repeat(20), { exact: false })).toBeVisible();
  await expect.element(page.getByText("0:11")).toBeVisible();
  const source = [...document.querySelectorAll("a")].find((anchor) => anchor.textContent === "Источник");
  expect(source?.getAttribute("rel")).toContain("noopener");
  expect(source?.getAttribute("rel")).toContain("noreferrer");
  expect(source?.getAttribute("target")).toBe("_blank");
  assertPlainText();

  const open = page.getByRole("button", { name: "Открыть кадр 0:00" });
  await open.click();
  await expect.element(page.getByRole("dialog")).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Закрыть" }));
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();

  await renderOnPhone(view("skipped"));
  await expect.element(page.getByText("Нет кадров для моментов: 1:39")).toBeVisible();
  await renderOnPhone(view("error"));
  await expect.element(page.getByText("Видео недоступно", { exact: false })).toBeVisible();
  await renderOnPhone(view("unavailable"));
  await expect.element(page.getByText("Кадр недоступен")).toBeVisible();
  assertPlainText();
});

test("компьютер открывает тот же кадр крупно", async () => {
  await serveFrames();
  await renderOnDesktop(view("ready"));
  await expect.element(page.getByText("0:00")).toBeVisible();
  await page.getByRole("button", { name: "Открыть кадр 0:05" }).click();
  await expect.element(page.getByRole("dialog")).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Закрыть" }));
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  expectNoHorizontalScroll();
});
