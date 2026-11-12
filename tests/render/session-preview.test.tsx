import { afterEach, beforeEach, expect, test } from "vitest";
import { commands, page } from "vitest/browser";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";

import { SessionList } from "@/components/studio/sessions/session-list";
import { SessionPreview } from "@/components/studio/sessions/session-preview";
import { ThemeProvider } from "@/components/studio/theme-provider";
import { Item, ItemGroup } from "@/components/ui/item";

import { previewMedia, previewSessions } from "./fixtures/session-previews";
import { expectNoHorizontalScroll, renderOnDesktop, renderOnPhone } from "./support/render";

const NOW = new Date("2026-11-01T12:00:00Z");

function list() {
  return (
    <SessionList
      initialPage={{ items: previewSessions, nextCursor: null }}
      initialQuery=""
      now={NOW}
      request={async () => ({ items: previewSessions, nextCursor: null })}
      timeZone="Europe/Moscow"
    />
  );
}

beforeEach(async () => {
  localStorage.clear();
  document.documentElement.classList.remove("light", "dark");
  await commands.emulateColorScheme("light");
  await commands.sessionPreviewMedia("setup", { pending: true });
});

afterEach(async () => {
  await commands.sessionPreviewMedia("reset");
  await commands.emulateColorScheme("light");
  localStorage.clear();
});

for (const [viewport, renderList, width, height] of [
  ["phone", renderOnPhone, 96, 54],
  ["desktop", renderOnDesktop, 160, 90],
] as const) {
  test.each(["light", "dark"] as const)(`${viewport}/%s: кадры вписаны целиком, место зарезервировано, длинное название не расширяет список`, async (theme) => {
    await commands.emulateColorScheme(theme);
    await renderList(list());
    await expect.poll(() => document.documentElement.classList.contains("dark")).toBe(theme === "dark");
    const group = page.getByRole("list");
    await expect.element(group).toBeVisible();
    const listNode = group.element();
    const before = listNode.getBoundingClientRect().height;
    const tiles = [...listNode.querySelectorAll<HTMLElement>("[data-slot=item-media]")];
    expect(tiles).toHaveLength(5);
    for (const tile of tiles) {
      expect(tile.getBoundingClientRect().width).toBe(width);
      expect(tile.getBoundingClientRect().height).toBe(height);
    }

    const images = [...listNode.querySelectorAll<HTMLImageElement>("img")];
    expect(images).toHaveLength(3);
    expect(images.every((image) => image.naturalWidth === 0)).toBe(true);
    await commands.sessionPreviewMedia("release");
    await expect.poll(() => listNode.querySelectorAll("img").length).toBe(2);
    await expect.poll(() => images[0]!.naturalWidth).toBe(320);
    await expect.poll(() => images[1]!.naturalHeight).toBe(320);
    for (const image of images.slice(0, 2)) {
      expect(getComputedStyle(image).objectFit).toBe("contain");
      expect(image.getBoundingClientRect().width).toBe(width);
      expect(image.getBoundingClientRect().height).toBe(height);
    }
    expect(listNode.getBoundingClientRect().height).toBe(before);
    expect(tiles[2]!.querySelector("svg")).not.toBeNull();
    expect(tiles[3]!.querySelector("svg")?.outerHTML).toBe(tiles[2]!.querySelector("svg")?.outerHTML);
    expect(tiles[3]!.className).toBe(tiles[2]!.className);
    const longTitle = listNode.querySelectorAll<HTMLElement>("[data-slot=item-title]")[4]!;
    expect(longTitle.textContent).toHaveLength(200);
    expect(longTitle.scrollWidth).toBeGreaterThan(longTitle.clientWidth);
    expect(longTitle.getClientRects()).toHaveLength(1);
    expectNoHorizontalScroll();
    const requests = await commands.sessionPreviewMedia("requests");
    expect(requests.filter((url) => url.includes(previewMedia.missing))).toEqual([
      `/api/media/${previewMedia.missing}`,
      `/api/media/${previewMedia.missing}?retry=1`,
    ]);
    await page.screenshot({ path: `../../.vitest/attachments/issue18-${viewport}-${theme}.png` });
  });
}

function preview(mediaId: string | null) {
  return (
    <ItemGroup>
      <Item>
        <SessionPreview preview={mediaId === null ? null : { mediaId }} />
      </Item>
    </ItemGroup>
  );
}

test("гидратация показывает SSR-картинку, чей настоящий load завершился до подключения React", async () => {
  await page.viewport(390, 844);
  const container = document.createElement("div");
  container.innerHTML = renderToString(preview(previewMedia.landscape));
  document.body.append(container);
  let root: Root | undefined;
  const errors: unknown[] = [];

  try {
    const image = container.querySelector("img")!;
    const loadedBeforeHydration = new Promise<void>((resolve) => {
      image.addEventListener("load", () => resolve(), { once: true });
    });
    await commands.sessionPreviewMedia("release");
    await loadedBeforeHydration;
    expect(image.complete).toBe(true);
    expect(image.naturalWidth).toBe(320);
    expect(getComputedStyle(image).visibility).toBe("hidden");

    root = hydrateRoot(container, preview(previewMedia.landscape), {
      onRecoverableError: (error) => errors.push(error),
    });
    await expect.poll(() => getComputedStyle(image).visibility).toBe("visible");
    expect(container.querySelector("img")).toBe(image);
    expect(container.querySelector("[data-slot=skeleton]")).toBeNull();
    expect(errors).toEqual([]);
    expect(await commands.sessionPreviewMedia("requests")).toEqual([
      `/api/media/${previewMedia.landscape}`,
    ]);
  } finally {
    root?.unmount();
    container.remove();
  }
});

test.each([
  [previewMedia.retry, true],
  [previewMedia.missing, false],
] as const)("гидратация после раннего error у %s повторяет запрос ровно один раз", async (mediaId, succeeds) => {
  await page.viewport(390, 844);
  const container = document.createElement("div");
  container.innerHTML = renderToString(preview(mediaId));
  document.body.append(container);
  let root: Root | undefined;
  const errors: unknown[] = [];

  try {
    const image = container.querySelector("img")!;
    const failedBeforeHydration = new Promise<void>((resolve) => {
      image.addEventListener("error", () => resolve(), { once: true });
    });
    await commands.sessionPreviewMedia("release");
    await failedBeforeHydration;
    expect(image.complete).toBe(true);
    expect(image.naturalWidth).toBe(0);
    const before = container.getBoundingClientRect().height;

    root = hydrateRoot(container, preview(mediaId), {
      onRecoverableError: (error) => errors.push(error),
    });
    if (succeeds) {
      await expect.poll(() => image.naturalWidth).toBe(320);
      await expect.poll(() => getComputedStyle(image).visibility).toBe("visible");
      expect(container.querySelector("img")).toBe(image);
    } else {
      await expect.poll(() => container.querySelector("img")).toBeNull();
      expect(container.querySelector("svg")).not.toBeNull();
    }
    expect(container.querySelector("[data-slot=skeleton]")).toBeNull();
    expect(container.getBoundingClientRect().height).toBe(before);
    expect(errors).toEqual([]);
    expect(await commands.sessionPreviewMedia("requests")).toEqual([
      `/api/media/${mediaId}`,
      `/api/media/${mediaId}?retry=1`,
    ]);
  } finally {
    root?.unmount();
    container.remove();
  }
});

test("после истёкшей ссылки картинка загружается повторно и показывается без изменения размера", async () => {
  await renderOnPhone(preview(previewMedia.retry));
  const tile = document.querySelector<HTMLElement>("[data-slot=item-media]")!;
  const before = tile.getBoundingClientRect().height;
  await commands.sessionPreviewMedia("release");
  await expect.poll(() => tile.querySelector<HTMLImageElement>("img")?.naturalWidth).toBe(320);
  await expect.element(page.getByRole("list")).toBeVisible();
  expect(getComputedStyle(tile.querySelector("img")!).visibility).toBe("visible");
  expect(tile.querySelector("[data-slot=skeleton]")).toBeNull();
  expect(tile.getBoundingClientRect().height).toBe(before);
  expect(await commands.sessionPreviewMedia("requests")).toEqual([
    `/api/media/${previewMedia.retry}`,
    `/api/media/${previewMedia.retry}?retry=1`,
  ]);
});

test("смена mediaId после окончательной ошибки начинает загрузку заново, удаление превью оставляет плитку", async () => {
  const screen = await renderOnDesktop(preview(previewMedia.missing));
  await commands.sessionPreviewMedia("release");
  const tile = document.querySelector<HTMLElement>("[data-slot=item-media]")!;
  await expect.poll(() => tile.querySelector("img")).toBeNull();
  expect(tile.querySelector("svg")).not.toBeNull();

  await commands.sessionPreviewMedia("setup", { pending: true });
  await screen.rerender(<ThemeProvider>{preview(previewMedia.retry)}</ThemeProvider>);
  await expect.poll(async () => commands.sessionPreviewMedia("requests")).toEqual([
    `/api/media/${previewMedia.retry}`,
  ]);
  expect(tile.querySelector("[data-slot=skeleton]")).not.toBeNull();
  await commands.sessionPreviewMedia("release");
  await expect.poll(() => tile.querySelector<HTMLImageElement>("img")?.naturalWidth).toBe(320);
  expect(await commands.sessionPreviewMedia("requests")).toEqual([
    `/api/media/${previewMedia.retry}`,
    `/api/media/${previewMedia.retry}?retry=1`,
  ]);

  await screen.rerender(<ThemeProvider>{preview(null)}</ThemeProvider>);
  expect(tile.querySelector("img")).toBeNull();
  expect(tile.querySelector("svg")).not.toBeNull();
  expect(tile.getBoundingClientRect().width).toBe(160);
  expect(tile.getBoundingClientRect().height).toBe(90);
});
