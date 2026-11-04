import { afterEach, expect, test, vi } from "vitest";
import { cdp, page, userEvent } from "vitest/browser";

import { ChatView } from "@/components/studio/chat/chat-view";

import { frameName, frameOutput, readFileConversation, type ReadFileScenario } from "./fixtures/read-file";
import { expectNoHorizontalScroll, renderOnDesktop, renderOnPhone } from "./support/render";

let restoreNetwork: (() => Promise<void>) | undefined;

afterEach(async () => {
  await restoreNetwork?.();
  restoreNetwork = undefined;
});

/** Подмена только HTTP-границы изображения, без подмены карточки или хука. */
async function imageNetwork({ width = 1920, height = 1080, failFirst = false, failAlways = false, hold = false } = {}) {
  const session = cdp();
  // Отдельная строка media на сценарий: Chromium держит декодированные картинки
  // по URL внутри документа даже между размонтированиями React.
  const imageId = crypto.randomUUID();
  const requests: string[] = [];
  const paused = new Set<string>();
  let holding = hold;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#d8b58c"/><rect x="40" y="40" width="${width - 80}" height="${height - 80}" fill="#483322"/><text x="50%" y="50%" text-anchor="middle" fill="white" font-size="80">COFFEE</text></svg>`;
  const respond = (requestId: string, failed = false) => session.send("Fetch.fulfillRequest", {
    requestId,
    responseCode: failed ? 404 : 200,
    responseHeaders: [{ name: "Content-Type", value: failed ? "text/plain" : "image/svg+xml" }, { name: "Cache-Control", value: "no-store" }],
    body: btoa(failed ? "not found" : svg),
  });
  const onRequest = async ({ requestId, request }: { requestId: string; request: { url: string } }) => {
    requests.push(request.url);
    if (failAlways || (failFirst && requests.length === 1)) {
      await respond(requestId, true);
    } else if (holding) {
      paused.add(requestId);
    } else {
      await respond(requestId);
    }
  };
  session.on("Fetch.requestPaused", onRequest);
  await session.send("Fetch.enable", { patterns: [{ urlPattern: `*/api/media/${imageId}*`, resourceType: "Image", requestStage: "Request" }] });
  restoreNetwork = async () => {
    await session.send("Fetch.disable");
    session.off("Fetch.requestPaused", onRequest);
  };
  return {
    imageId,
    output: { ...frameOutput, file: { ...frameOutput.file, width, height }, media: { imageId } },
    requests,
    release: async () => {
      holding = false;
      await Promise.all([...paused].map((requestId) => respond(requestId)));
      paused.clear();
    },
  };
}

function view(scenario: ReadFileScenario) {
  return (
    <div className="h-dvh">
      <ChatView
        agent={readFileConversation(scenario)}
        onCancel={vi.fn()}
        onRespond={vi.fn()}
        onSend={vi.fn()}
      />
    </div>
  );
}

function assertNoRawTool() {
  expectNoHorizontalScroll();
  const viewport = document.querySelector('[data-slot="message-scroller-viewport"]');
  expect(viewport).not.toBeNull();
  expect(viewport!.scrollWidth).toBeLessThanOrEqual(viewport!.clientWidth);
  expect(document.body.innerText).not.toMatch(/read_file|ВходнойПуть|Скрытое содержимое|Внутренний отказ|Сырые данные|\{/);
}

for (const [viewport, render] of [["телефон", renderOnPhone], ["компьютер", renderOnDesktop]] as const) {
  test(`чтение кадра: выполнение показывает подпись и значок изображения — ${viewport}`, async () => {
    const label = `Смотрит кадр: ${"ОченьДлиннаяПодпись".repeat(24)}`;
    await render(view({ label }));
    await expect.element(page.getByText(label, { exact: true })).toBeVisible();
    expect(document.querySelector('[data-status="running"] .lucide-image')).not.toBeNull();
    expect(document.querySelector('[data-slot="attachment"]')).toBeNull();
    assertNoRawTool();
  });

  test(`чтение кадра: публикация недоступна — ${viewport}`, async () => {
    await render(view({ output: { ...frameOutput, media: undefined } }));
    await expect.element(page.getByText("Кадр недоступен", { exact: true })).toBeVisible();
    expect(document.querySelector('[data-slot="attachment"][data-state="error"][data-orientation="vertical"]')).not.toBeNull();
    expect(document.querySelector('[data-status="running"]')).toBeNull();
    await expect.element(page.getByRole("button", { name: /Открыть кадр/ })).not.toBeInTheDocument();
    assertNoRawTool();
  });

  for (const [orientation, width, height] of [["горизонтальный", 1920, 1080], ["вертикальный", 1080, 1920]] as const) {
    test(`чтение кадра: ${orientation}, загрузка и крупный просмотр — ${viewport}`, async () => {
      const network = await imageNetwork({ width, height, hold: true });
      await render(view({ output: network.output }));
      const row = page.getByRole("button", { name: new RegExp(`^Кадр.*${width}×${height}`) });
      await expect.element(row).toHaveAttribute("aria-expanded", "true");
      await expect.element(page.getByLabelText("Загрузка кадра")).toBeVisible();
      expect(document.querySelector('[data-slot="attachment"] [data-slot="attachment-media"]')).toHaveAttribute("aria-busy", "true");
      await expect.poll(() => network.requests.length).toBe(1);
      expect(new URL(network.requests[0]).pathname).toBe(`/api/media/${network.imageId}`);
      await network.release();
      const thumbnail = page.getByRole("img", { name: frameName });
      await expect.element(thumbnail).toBeVisible();
      await expect.element(page.getByLabelText("Загрузка кадра")).not.toBeInTheDocument();
      expect(document.querySelector('[data-slot="attachment"] [data-slot="attachment-media"]')).toHaveAttribute("aria-busy", "false");
      const image = thumbnail.element() as HTMLImageElement;
      await expect.poll(() => image.naturalWidth).toBe(width);
      const bounds = image.getBoundingClientRect();
      expect(image).not.toHaveAttribute("style");
      expect(image.parentElement).not.toHaveAttribute("style");
      expect(getComputedStyle(image).position).toBe("static");
      expect(bounds.height).toBeLessThanOrEqual(180);
      expect(bounds.width / bounds.height).toBeCloseTo(width / height, 2);
      expect(getComputedStyle(image).objectFit).toBe("contain");
      expect(document.querySelector('[data-slot="attachment"][data-orientation="vertical"]')).not.toBeNull();
      expect(document.querySelector('[data-slot="attachment-description"]')?.textContent).toBe(`${width}×${height} · 96 КиБ`);

      // Строка только сворачивает карточку, но не открывает Dialog.
      await row.click();
      await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
      await expect.element(row).toHaveAttribute("aria-expanded", "false");
      await row.click();
      await expect.element(row).toHaveAttribute("aria-expanded", "true");
      const trigger = page.getByRole("button", { name: `Открыть кадр: ${frameName}`, exact: true });
      await trigger.click();
      const dialog = page.getByRole("dialog", { name: "Кадр", exact: true });
      await expect.element(dialog).toBeVisible();
      await expect.element(dialog.getByRole("heading", { name: "Кадр", exact: true })).toBeVisible();
      const full = dialog.getByRole("img", { name: frameName });
      await expect.element(full).toBeVisible();
      const fullImage = full.element() as HTMLImageElement;
      await expect.poll(() => fullImage.naturalWidth).toBe(width);
      const largeBounds = fullImage.getBoundingClientRect();
      expect(fullImage).not.toHaveAttribute("style");
      expect(fullImage.parentElement).not.toHaveAttribute("style");
      expect(getComputedStyle(fullImage).position).toBe("static");
      expect(getComputedStyle(fullImage.parentElement!).opacity).toBe("1");
      expect(largeBounds.width / largeBounds.height).toBeCloseTo(width / height, 2);
      expect(largeBounds.height).toBeGreaterThan(bounds.height);
      expect(largeBounds.left).toBeGreaterThanOrEqual(0);
      expect(largeBounds.right).toBeLessThanOrEqual(window.innerWidth);
      expect(largeBounds.top).toBeGreaterThanOrEqual(0);
      expect(largeBounds.bottom).toBeLessThanOrEqual(window.innerHeight);
      expectNoHorizontalScroll();
      await dialog.getByRole("button", { name: "Закрыть", exact: true }).click();
      await expect.element(dialog).not.toBeInTheDocument();
      await expect.element(trigger).toHaveFocus();
      await userEvent.keyboard("{Enter}");
      await expect.element(dialog).toBeVisible();
      await userEvent.keyboard("{Escape}");
      await expect.element(dialog).not.toBeInTheDocument();
      await expect.element(trigger).toHaveFocus();
      assertNoRawTool();
    });
  }

  test(`чтение кадра: первая ошибка обновляет ссылку один раз — ${viewport}`, async () => {
    const network = await imageNetwork({ failFirst: true });
    await render(view({ output: network.output }));
    const image = page.getByRole("img", { name: frameName });
    await expect.element(image).toBeVisible();
    await expect.element(image).toHaveAttribute("src", `/api/media/${network.imageId}?retry=1`);
    await expect.poll(() => (image.element() as HTMLImageElement).naturalWidth).toBe(1920);
    expect(network.requests.map((url) => new URL(url).search)).toEqual(["", "?retry=1"]);
    await expect.element(page.getByText("Кадр недоступен", { exact: true })).not.toBeInTheDocument();
    assertNoRawTool();
  });

  test(`чтение кадра: две сетевые ошибки делают кадр недоступным — ${viewport}`, async () => {
    const network = await imageNetwork({ failAlways: true });
    await render(view({ output: network.output }));
    await expect.element(page.getByText("Кадр недоступен", { exact: true })).toBeVisible();
    expect(document.querySelector('[data-slot="attachment"][data-state="error"]')).not.toBeNull();
    expect(document.querySelector('img[src*="/api/media/"]')).toBeNull();
    expect(network.requests.map((url) => new URL(url).search)).toEqual(["", "?retry=1"]);
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    assertNoRawTool();
  });

  for (const [kind, output] of [
    ["текст", { path: "/workspace/NOTES.md", content: "Скрытое содержимое файла", totalLines: 12, truncated: false }],
    ["PDF", { path: "/workspace/source.pdf", file: { mediaType: "application/pdf", size: 98304 } }],
    ["большая картинка", { path: frameOutput.path, content: "Скрытое содержимое файла" }],
    ["повреждённый результат", { file: { mediaType: "image/jpeg", width: "1920", height: null }, internal: "Сырые данные" }],
  ] as const) {
    test(`чтение файла: ${kind} остаётся строкой с подписью — ${viewport}`, async () => {
      const label = `Читает файл: ${"ОченьДлинныйПуть".repeat(30)}`;
      await render(view({ output, label }));
      await expect.element(page.getByText(label, { exact: true })).toBeVisible();
      expect(document.querySelector('[data-status="running"]')).toBeNull();
      expect(document.querySelector('[data-slot="attachment"]')).toBeNull();
      expect(document.querySelector('[data-slot="trace-collapsible"]')).toBeNull();
      assertNoRawTool();
    });
  }

  for (const [kind, scenario] of [
    ["ошибка", { error: 'read_file_failed: {"secret":"Сырые данные"}' }],
    ["отказ", { denied: true }],
  ] as const) {
    test(`чтение файла: ${kind} не показывает ожидание или технические подробности — ${viewport}`, async () => {
      await render(view({ ...scenario, label: "Чтение опорного кадра" }));
      await expect.element(page.getByText("Чтение опорного кадра", { exact: true })).toBeVisible();
      expect(document.querySelector('[data-status="running"]')).toBeNull();
      expect(document.querySelector('[data-status="error"]') !== null).toBe(kind === "ошибка");
      assertNoRawTool();
    });
  }
}
