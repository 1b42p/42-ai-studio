import type { CDPSession } from "playwright";
import { act } from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cdp, page, userEvent } from "vitest/browser";
import { cleanup } from "vitest-browser-react";

import { CreationArtwork, CreationFrame } from "@/components/studio/landing/creation-artwork";
import { CreationStory } from "@/components/studio/landing/creation-story";

import { landingSteps } from "./fixtures/landing";
import { expectNoHorizontalScroll, renderOnDesktop, renderOnPhone } from "./support/render";

const protocol = () => cdp() as Pick<CDPSession, "send">;
const storySteps = landingSteps.map(([title, description]) => ({ title, description }));

/** Measure actual theme colors, including alpha, rather than former CSS classes. */
function contrastOnCard(element: Element) {
  const card = element.closest('[data-slot="card"]')!;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d")!;
  context.fillStyle = getComputedStyle(card).backgroundColor;
  context.fillRect(0, 0, 1, 1);
  const background = context.getImageData(0, 0, 1, 1).data;
  expect(background[3]).toBe(255);
  context.fillStyle = getComputedStyle(element).color;
  context.fillRect(0, 0, 1, 1);
  const foreground = context.getImageData(0, 0, 1, 1).data;
  const luminance = (pixels: Uint8ClampedArray) => {
    const [red, green, blue] = [...pixels].slice(0, 3).map((channel) => {
      const value = channel / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return red * 0.2126 + green * 0.7152 + blue * 0.0722;
  };
  const back = luminance(background);
  const front = luminance(foreground);
  return (Math.max(back, front) + 0.05) / (Math.min(back, front) + 0.05);
}

test("акцент финального кадра не перекрывает заголовок", async () => {
  await renderOnDesktop(<CreationFrame scene={2} />);
  const frame = document.querySelector("svg")!;
  const accent = frame.querySelector("circle")!.getBBox();
  const titles = [...frame.querySelectorAll("text")].slice(0, 2);
  expect(titles).toHaveLength(2);
  for (const title of titles) {
    const bounds = title.getBBox();
    expect(bounds.y + bounds.height).toBeLessThan(accent.y);
  }
});

beforeEach(async () => {
  await protocol().send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "no-preference" }],
  });
});

afterEach(async () => {
  await cleanup();
  await protocol().send("Emulation.setEmulatedMedia", { features: [] });
  vi.restoreAllMocks();
  localStorage.clear();
});

for (const [viewport, renderStory] of [
  ["телефон", renderOnPhone],
  ["компьютер", renderOnDesktop],
] as const) {
  for (const theme of ["light", "dark"] as const) {
    test(`${viewport}/${theme}: подписи процесса контрастны, этапы и кадры доступны с клавиатуры`, async () => {
      localStorage.setItem("theme", theme);
      await renderStory(<CreationStory steps={storySteps} />);
      await expect.poll(() => document.documentElement.classList.contains(theme)).toBe(true);
      const steps = page.getByRole("tablist", { name: "Этапы создания видео" }).getByRole("tab");
      const active = steps.nth(0).element();
      const panel = page.getByRole("tabpanel", { name: storySteps[0].title, exact: true });
      for (const slot of ["card-title", "card-description", "badge"]) {
        const label = panel.element().querySelector(`[data-slot="${slot}"]`)!;
        expect(label, slot).not.toBeNull();
        await expect.element(page.elementLocator(label)).toBeVisible();
        expect(contrastOnCard(label), `${slot}: контраст обычного текста`).toBeGreaterThanOrEqual(4.5);
      }
      await expect.element(steps.nth(0)).toHaveAttribute("aria-selected", "true");
      (active as HTMLElement).focus();
      await userEvent.keyboard("{ArrowRight}");
      await expect.element(steps.nth(1)).toHaveFocus();
      await expect.element(steps.nth(1)).toHaveAttribute("aria-selected", "true");
      await page.getByRole("button", { name: "Дальше", exact: true }).click();
      await expect.element(steps.nth(2)).toHaveAttribute("aria-selected", "true");
      await expect.element(page.getByRole("img", { name: viewport === "телефон" ? "Графика со звуком и субтитрами" : "Графика, звуковая дорожка и субтитры", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Дальше", exact: true }).click();
      const third = page.getByRole("button", { name: "Кадр 3", exact: true });
      await third.click();
      await expect.element(third).toHaveAttribute("aria-pressed", "true");
      await page.getByRole("button", { name: "Смотреть монтаж", exact: true }).click();
      await expect.element(page.getByRole("button", { name: "Кадр 1", exact: true })).toHaveAttribute("aria-pressed", "true");
      await expect.element(page.getByRole("button", { name: "Идёт монтаж", exact: true })).toBeDisabled();
      await third.click();
      await expect.element(page.getByRole("button", { name: "Смотреть монтаж", exact: true })).toBeEnabled();
      expectNoHorizontalScroll();
    });
  }
}

test.each(["reduce", "no-preference"])("готовый кадр виден в SSR и гидратируется без расхождений при %s", async (preference) => {
  await protocol().send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: preference }],
  });
  await page.viewport(1280, 800);
  const container = document.createElement("div");
  container.innerHTML = renderToString(<CreationArtwork stage={3} scene={2} />);
  document.body.append(container);
  const frames = [...container.querySelectorAll('svg[width="600"] > g')];
  expect(frames).toHaveLength(3);
  for (const frame of frames) expect(frame.getAttribute("opacity")).toBe("1");
  const errors: unknown[] = [];
  const consoleErrors: unknown[][] = [];
  vi.spyOn(console, "error").mockImplementation((...args) => consoleErrors.push(args));
  // hydrateRoot is mounted directly, outside vitest-browser-react's act wrapper.
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let root: Root | undefined;
  try {
    await act(async () => {
      root = hydrateRoot(container, <CreationArtwork stage={3} scene={2} />, {
        onRecoverableError: (error) => errors.push(error),
      });
    });
    expect(errors).toEqual([]);
    expect(consoleErrors).toEqual([]);
    for (const frame of frames) {
      expect(frame.isConnected).toBe(true);
      expect(getComputedStyle(frame).opacity).toBe("1");
    }
  } finally {
    await act(async () => root?.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

test("включение reduced motion отменяет монтаж, ручной выбор кадра остаётся доступен", async () => {
  await renderOnDesktop(<CreationStory steps={storySteps} />);
  await page.getByRole("tab").nth(3).click();
  await page.getByRole("button", { name: "Смотреть монтаж", exact: true }).click();
  await expect.element(page.getByRole("button", { name: "Идёт монтаж", exact: true })).toBeDisabled();
  const second = page.getByRole("button", { name: "Кадр 2", exact: true });
  await expect.poll(() => second.element().getAttribute("aria-pressed"), { timeout: 3500 }).toBe("true");
  await protocol().send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  await expect.element(page.getByRole("button", { name: "Смотреть монтаж", exact: true })).toBeDisabled();
  // Ожидание превышает 1800 мс: отменённый таймер не должен выбрать третий кадр.
  await new Promise<void>((resolve) => window.setTimeout(resolve, 2000));
  await expect.element(second).toHaveAttribute("aria-pressed", "true");
  const third = page.getByRole("button", { name: "Кадр 3", exact: true });
  await third.click();
  await expect.element(third).toHaveAttribute("aria-pressed", "true");
  await protocol().send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "no-preference" }],
  });
  await expect.element(page.getByRole("button", { name: "Смотреть монтаж", exact: true })).toBeEnabled();
  await expect.element(third).toHaveAttribute("aria-pressed", "true");
}, 12000);

test.each([0, 1, 2, 3])("SVG этапа %s одинаков при погрешности тригонометрии разных движков", (stage) => {
  const markup = renderToString(<CreationArtwork stage={stage} scene={2} />);
  const sin = Math.sin;
  const cos = Math.cos;
  vi.spyOn(Math, "sin").mockImplementation((value) => sin(value) * (1 + 1e-14));
  vi.spyOn(Math, "cos").mockImplementation((value) => cos(value) * (1 - 1e-14));
  expect(renderToString(<CreationArtwork stage={stage} scene={2} />)).toBe(markup);

  const document = new DOMParser().parseFromString(markup, "text/html");
  for (const rect of document.querySelectorAll("rect")) {
    for (const attribute of ["x", "y", "width", "height"]) {
      const value = rect.getAttribute(attribute);
      if (value !== null) expect(value).toMatch(/^-?\d+(?:\.\d{1,3})?$/);
    }
  }
});
