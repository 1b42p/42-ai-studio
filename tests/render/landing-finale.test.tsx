import type { CDPSession } from "playwright";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cdp, commands, page } from "vitest/browser";
import { cleanup } from "vitest-browser-react";

import { AuthStateProvider, StudioLoginButton } from "@/components/studio/landing/auth-state";
import { FinaleScene } from "@/components/studio/landing/finale-scene";
import { LandingPage } from "@/components/studio/landing/landing-page";
import { ThemeToggle } from "@/components/studio/theme-toggle";
import { Cta1 } from "@/components/ui/cta-1";

import { landingExamples } from "./fixtures/landing";
import { expectNoHorizontalScroll, renderOnDesktop, renderOnPhone } from "./support/render";

const title = "Попробуйте на своей задаче";
const description = "Опишите ролик одним сообщением — первый результат уже в чате.";
const loginHref = "/api/auth/telegram/login?next=%2Fs";
const label = "Объёмная композиция завершённого кинокадра";
const diagnostics: string[] = [];
const protocol = () => cdp() as Pick<CDPSession, "send">;
let realFetch: typeof fetch;

function finale() {
  return page.getByRole("img", { name: label, exact: true }).element();
}

function poster() {
  const theme = document.documentElement.classList.contains("dark") ? "dark" : "light";
  return finale().querySelector<HTMLImageElement>(`img[data-sculpture-theme="${theme}"]`)!;
}

function requests() {
  return vi.mocked(globalThis.fetch).mock.calls
    .filter(([input]) => /\/landing\/finale-(?:light|dark)\.glb/.test(String(input)));
}

function focusedFinale() {
  return (
    <AuthStateProvider>
      <ThemeToggle />
      <Cta1
        title={title}
        description={description}
        action={<StudioLoginButton tone="contrast" />}
        visual={<FinaleScene />}
      />
    </AuthStateProvider>
  );
}

async function frames(count = 6) {
  for (let frame = 0; frame < count; frame++) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
}

/** Read actual rendered RGBA, not the element's presence or its poster. */
function pixels(source: CanvasImageSource) {
  const sample = document.createElement("canvas");
  sample.width = 96;
  sample.height = 80;
  const context = sample.getContext("2d")!;
  context.drawImage(source, 0, 0, sample.width, sample.height);
  const rgba = context.getImageData(0, 0, sample.width, sample.height).data;
  const counts = { orange: 0, light: 0, opaque: 0, transparent: 0 };
  for (let index = 0; index < rgba.length; index += 4) {
    const [red, green, blue, alpha] = rgba.slice(index, index + 4);
    if (alpha < 8) counts.transparent++;
    if (alpha < 240) continue;
    counts.opaque++;
    if (red > 90 && red > green * 1.25 && green > blue * 1.1) counts.orange++;
    if (red > 150 && green > 150 && blue > 150) counts.light++;
  }
  return counts;
}

function expectComposition(source: CanvasImageSource) {
  const counts = pixels(source);
  expect(counts.orange, JSON.stringify(counts)).toBeGreaterThan(15);
  expect(counts.light, JSON.stringify(counts)).toBeGreaterThan(40);
  expect(counts.opaque, JSON.stringify(counts)).toBeGreaterThan(100);
  expect(counts.transparent, JSON.stringify(counts)).toBeGreaterThan(200);
}

async function expectPoster(theme: "light" | "dark") {
  await expect.poll(() => poster().naturalWidth).toBeGreaterThan(0);
  expect(poster().getAttribute("src")).toBe(`/landing/finale-${theme}.webp`);
  expect(getComputedStyle(poster()).opacity).toBe("1");
  expectComposition(poster());
}

async function ready() {
  await expect.poll(() => finale().querySelector("canvas"), { timeout: 20000 }).not.toBeNull();
  const canvas = finale().querySelector("canvas")!;
  await expect.poll(() => getComputedStyle(poster()).opacity, { timeout: 20000 }).toBe("0");
  await expect.poll(() => pixels(canvas).orange, { timeout: 20000 }).toBeGreaterThan(15);
  expectComposition(canvas);
  return canvas;
}

function expectContent() {
  const section = document.getElementById("try-title")!.closest("section")!;
  const scoped = page.elementLocator(section);
  expect(section.textContent).toContain(title);
  expect(section.textContent).toContain(description);
  expect(section.querySelector("p")!.textContent).toBe(description);
  expect(section.querySelectorAll("a")).toHaveLength(1);
  const link = scoped.getByRole("link", { name: "Войти через Telegram", exact: true });
  expect(link.element().getAttribute("href")).toBe(loginHref);
  expect(link.element().tagName).toBe("A");
  expect(link.element().querySelector("svg")).not.toBeNull();
  for (const element of [document.getElementById("try-title")!, link.element()]) {
    expect(element.getBoundingClientRect().width).toBeGreaterThan(0);
    expect(element.scrollWidth).toBeLessThanOrEqual(element.clientWidth + 1);
    for (let node: Element | null = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      expect(Number(style.opacity)).toBeGreaterThan(0);
      expect(style.visibility).not.toBe("hidden");
      expect(style.display).not.toBe("none");
    }
  }
  const bounds = finale().getBoundingClientRect();
  expect(bounds.width / bounds.height).toBeCloseTo(6 / 5, 2);
  expectNoHorizontalScroll();
}

function countDraws() {
  const drawing = vi.spyOn(WebGL2RenderingContext.prototype, "drawElements");
  return (canvas: HTMLCanvasElement) => drawing.mock.contexts
    .filter((context) => (context as WebGL2RenderingContext).canvas === canvas).length;
}

async function expectStopped(canvas: HTMLCanvasElement, draws: ReturnType<typeof countDraws>) {
  // Let a previously scheduled RAF and React's media-query update settle first.
  await frames();
  const count = draws(canvas);
  const image = canvas.toDataURL();
  await frames(12);
  expect(draws(canvas)).toBe(count);
  expect(canvas.toDataURL()).toBe(image);
}

beforeEach(async () => {
  diagnostics.length = 0;
  localStorage.clear();
  document.documentElement.classList.remove("light", "dark");
  window.scrollTo(0, 0);
  performance.clearResourceTimings();
  await commands.emulateColorScheme("light");
  await protocol().send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  realFetch = globalThis.fetch.bind(globalThis);
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) =>
    input === "/api/auth/me" ? Promise.resolve(new Response(null, { status: 401 })) : realFetch(input, init),
  );
  const record = (...args: unknown[]) => {
    const message = args.map(String).join(" ");
    if (message.includes("Encountered a script tag while rendering React component")) return;
    if (message.startsWith("You have Reduced Motion enabled on your device.")) return;
    diagnostics.push(message);
  };
  vi.spyOn(console, "error").mockImplementation(record);
  vi.spyOn(console, "warn").mockImplementation(record);
});

afterEach(async () => {
  // Keep diagnostics installed through renderer disposal, including late aborts.
  await cleanup();
  await frames();
  await protocol().send("Emulation.setEmulatedMedia", { features: [] });
  vi.restoreAllMocks();
  localStorage.clear();
  expect(diagnostics).toEqual([]);
});

for (const theme of ["light", "dark"] as const) {
  for (const [viewport, render] of [["телефон", renderOnPhone], ["компьютер", renderOnDesktop]] as const) {
    test(`${viewport}/${theme}: финал главной сохраняет текст, одну ссылку и откладывает 3D до появления`, async () => {
      localStorage.setItem("theme", theme);
      await render(<LandingPage examples={landingExamples} />);
      await expect.poll(() => document.documentElement.classList.contains(theme)).toBe(true);
      await frames();
      expect(finale().getBoundingClientRect().top).toBeGreaterThan(window.innerHeight);
      expect(finale().querySelector("canvas")).toBeNull();
      expect(requests()).toHaveLength(0);
      expect(performance.getEntriesByType("resource").filter(({ name }) => /finale-.*\.glb/.test(name))).toEqual([]);
      finale().scrollIntoView({ block: "center", behavior: "instant" });
      if (viewport === "телефон") {
        await expectPoster(theme);
        await frames(12);
        expect(finale().querySelector("canvas")).toBeNull();
        expect(requests()).toHaveLength(0);
        expect(performance.getEntriesByType("resource").filter(({ name }) => /finale-.*\.glb/.test(name))).toEqual([]);
      } else {
        await ready();
        expect(requests().some(([input]) => String(input).endsWith(`finale-${theme}.glb`))).toBe(true);
      }
      expectContent();
    }, 30000);
  }

  test(`компьютер/${theme}: постер остаётся до настоящего кадра, reduced motion не рисует дальше, media query возобновляет движение`, async () => {
    localStorage.setItem("theme", theme);
    const draws = countDraws();
    const gate = Promise.withResolvers<void>();
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      if (/\/landing\/finale-.*\.glb/.test(String(input))) await gate.promise;
      return input === "/api/auth/me" ? new Response(null, { status: 401 }) : realFetch(input, init);
    });
    try {
      await renderOnDesktop(focusedFinale());
      await expect.poll(() => requests().length).toBeGreaterThan(0);
      await expectPoster(theme);
      const waiting = finale().querySelector("canvas")!;
      expect(draws(waiting)).toBe(0);
      expect(pixels(waiting).opaque).toBe(0);
    } finally {
      gate.resolve();
    }
    const canvas = await ready();
    expect(draws(canvas)).toBeGreaterThan(0);
    await expectStopped(canvas, draws);
    await protocol().send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "no-preference" }],
    });
    const stopped = draws(canvas);
    const image = canvas.toDataURL();
    await expect.poll(() => draws(canvas)).toBeGreaterThan(stopped + 2);
    await expect.poll(() => canvas.toDataURL()).not.toBe(image);
    await protocol().send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
    await expectStopped(canvas, draws);
    expectContent();
  }, 30000);

  test(`компьютер/${theme}: смена темы и компьютер → телефон → компьютер не оставляют пустой финал`, async () => {
    localStorage.setItem("theme", theme);
    await renderOnDesktop(focusedFinale());
    const original = await ready();
    const other = theme === "light" ? "dark" : "light";
    await page.getByRole("button", { name: "Тема", exact: true }).click();
    await page.getByRole("menuitemradio", { name: other === "light" ? "Светлая" : "Тёмная", exact: true }).click();
    await expect.poll(() => poster().getAttribute("src")).toBe(`/landing/finale-${other}.webp`);
    const themed = await ready();
    expect(themed).not.toBe(original);
    await page.viewport(390, 844);
    await expect.poll(() => finale().querySelector("canvas")).toBeNull();
    await expectPoster(other);
    expectContent();
    await page.viewport(1280, 800);
    finale().scrollIntoView({ block: "center", behavior: "instant" });
    const remounted = await ready();
    expect(remounted).not.toBe(themed);
    expectContent();
  }, 30000);

  test(`компьютер/${theme}: отказ WebGL оставляет содержательный прозрачный постер и CTA`, async () => {
    localStorage.setItem("theme", theme);
    const original = HTMLCanvasElement.prototype.getContext;
    const context = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (
      this: HTMLCanvasElement, kind: string, ...args: unknown[]
    ) {
      if (kind === "webgl2" || kind === "webgl") return null;
      return Reflect.apply(original, this, [kind, ...args]);
    });
    await renderOnDesktop(focusedFinale());
    await expect.poll(() => context.mock.calls.some(([kind]) => String(kind) === "webgl2")).toBe(true);
    await expectPoster(theme);
    expect(finale().querySelector("canvas")).toBeNull();
    expect(requests()).toHaveLength(0);
    expectContent();
  });
}

test("финал останавливает настоящую отрисовку вне экрана и скрытой вкладки и возобновляет её", async () => {
  const draws = countDraws();
  await protocol().send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "no-preference" }],
  });
  await renderOnDesktop(<LandingPage examples={landingExamples} />);
  finale().scrollIntoView({ block: "center", behavior: "instant" });
  const canvas = await ready();
  window.scrollTo({ top: 0, behavior: "instant" });
  await expect.poll(() => finale().getBoundingClientRect().top).toBeGreaterThan(window.innerHeight);
  await expectStopped(canvas, draws);
  finale().scrollIntoView({ block: "center", behavior: "instant" });
  const stopped = draws(canvas);
  await expect.poll(() => draws(canvas)).toBeGreaterThan(stopped + 2);
  // Only visibility is injected; the renderer, RAF and GPU remain real.
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  document.dispatchEvent(new Event("visibilitychange"));
  await expectStopped(canvas, draws);
  const background = draws(canvas);
  hidden.mockRestore();
  document.dispatchEvent(new Event("visibilitychange"));
  await expect.poll(() => draws(canvas)).toBeGreaterThan(background + 2);
  expectComposition(canvas);
}, 30000);

test("настоящая потеря WebGL-контекста возвращает постер, cleanup не выбрасывает ошибок", async () => {
  await renderOnDesktop(focusedFinale());
  const canvas = await ready();
  const context = canvas.getContext("webgl2")!;
  const extension = context.getExtension("WEBGL_lose_context");
  expect(extension).not.toBeNull();
  extension!.loseContext();
  await expect.poll(() => finale().querySelector("canvas")).toBeNull();
  await expectPoster("light");
  expectContent();
  await cleanup();
  await frames(12);
  expect(diagnostics).toEqual([]);
}, 30000);
