import type { CDPSession } from "playwright";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cdp, commands, page, userEvent } from "vitest/browser";
import { renderToString } from "react-dom/server";

import { LandingPage } from "@/components/studio/landing/landing-page";
import type { ExampleVideo } from "@/lib/examples";

import { fourLandingExamples, landingExamples, landingFeatures, landingSteps } from "./fixtures/landing";
import { expectNoHorizontalScroll, renderOnDesktop, renderOnPhone } from "./support/render";

const hero = "Опишите ролик словами — получите готовое видео";
const loginHref = "/api/auth/telegram/login?next=%2Fs";
const protocol = () => cdp() as Pick<CDPSession, "send">;
const diagnostics: string[] = [];

function recordDiagnostic(...args: unknown[]) {
  const message = args.map(String).join(" ");
  // next-themes вставляет script при клиентском монтировании без серверного HTML.
  if (!message.includes("Encountered a script tag while rendering React component")) {
    diagnostics.push(message);
  }
}

function recordWarning(...args: unknown[]) {
  // Motion в dev сообщает об эмулированной системной настройке. Это не ошибка
  // отрисовки: https://motion.dev/troubleshooting/reduced-motion-disabled.
  if (args.map(String).join(" ").startsWith("You have Reduced Motion enabled on your device.")) return;
  recordDiagnostic(...args);
}

function landing(examples: readonly ExampleVideo[] = landingExamples) {
  return <LandingPage examples={examples} />;
}

function loginLinks() {
  return page.getByRole("link", { name: "Войти через Telegram", exact: true });
}

function studioLinks() {
  return page.getByRole("link", { name: "Открыть студию", exact: true });
}

function videos() {
  return [...document.querySelectorAll<HTMLVideoElement>("#examples video")];
}

function section(id: string) {
  const node = document.getElementById(id);
  expect(node, `секция #${id}`).not.toBeNull();
  return node!;
}

async function nextFrame() {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

/** Видимость текста вместе с предками: ловит скрытые GSAP-обёртки. */
function expectReadable(element: HTMLElement) {
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    expect(Number(style.opacity)).toBeGreaterThan(0);
    expect(style.visibility).not.toBe("hidden");
    expect(style.display).not.toBe("none");
    expect(style.filter).not.toMatch(/blur\([1-9]/);
  }
  expect(element.getBoundingClientRect().width).toBeGreaterThan(0);
}

beforeEach(async () => {
  diagnostics.length = 0;
  localStorage.clear();
  document.documentElement.classList.remove("light", "dark");
  performance.clearResourceTimings();
  window.scrollTo(0, 0);
  await commands.emulateColorScheme("light");
  vi.spyOn(console, "error").mockImplementation(recordDiagnostic);
  vi.spyOn(console, "warn").mockImplementation(recordWarning);
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 401 }));
});

afterEach(async () => {
  await protocol().send("Emulation.setEmulatedMedia", { features: [] });
  await protocol().send("Emulation.setCPUThrottlingRate", { rate: 1 });
  vi.restoreAllMocks();
  localStorage.clear();
  expect(diagnostics).toEqual([]);
});

for (const [viewport, renderLanding] of [
  ["телефон", renderOnPhone],
  ["компьютер", renderOnDesktop],
] as const) {
  for (const theme of ["light", "dark"] as const) {
    test(`${viewport}/${theme}: весь контент, три ссылки входа, якоря и раскладка`, async () => {
      localStorage.setItem("theme", theme);
      await renderLanding(landing());
      await expect.poll(() => document.documentElement.classList.contains(theme)).toBe(true);
      await expect.element(page.getByRole("heading", { level: 1, name: hero })).toBeVisible();
      expect(document.querySelectorAll("h1")).toHaveLength(1);
      expect(document.querySelector("h1 p")).toBeNull();
      await expect.element(page.getByText("Видео из одной просьбы", { exact: true })).toBeVisible();
      await expect.element(page.getByText("Агент-видеограф сам напишет анимацию, озвучит текст, добавит субтитры, проверит кадры и пришлёт файл прямо в чат.", { exact: true })).toBeVisible();
      await expect.element(page.getByText("Отдельный аккаунт не нужен: вход через Telegram", { exact: true })).toBeVisible();

      for (const name of ["Примеры готовых роликов", "Как это работает", "Возможности", "Попробуйте на своей задаче"]) {
        await expect.element(page.getByRole("heading", { name, exact: true })).toBeVisible();
      }
      await expect.element(page.getByText("Все ролики сделал агент по одной просьбе в чате", { exact: true })).toBeVisible();
      await expect.element(page.getByText("Опишите ролик одним сообщением — первый результат уже в чате.", { exact: true })).toBeVisible();
      await expect.element(page.getByText("© 42 AI Studio", { exact: true })).toBeVisible();
      for (const [title, description] of landingSteps) {
        await expect.element(page.elementLocator(section("how")).getByText(title, { exact: true })).toBeVisible();
        await expect.element(page.getByText(description, { exact: true })).toBeVisible();
      }
      for (const [title, description] of landingFeatures) {
        await expect.element(page.elementLocator(section("features")).getByText(title, { exact: true })).toBeVisible();
        await expect.element(page.getByText(description, { exact: true })).toBeVisible();
      }
      expect(section("how").querySelectorAll("h3")).toHaveLength(4);
      expect(section("features").querySelectorAll("h3")).toHaveLength(8);
      const heading = document.querySelector("h1")!;
      expect(heading.scrollWidth).toBeLessThanOrEqual(heading.clientWidth + 1);

      expect(loginLinks().elements()).toHaveLength(3);
      for (const link of loginLinks().elements()) {
        expect(link.tagName).toBe("A");
        expect(link.getAttribute("href")).toBe(loginHref);
        expect(link.querySelector("svg")).not.toBeNull();
      }
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      expect(vi.mocked(globalThis.fetch).mock.calls[0]![0]).toBe("/api/auth/me");
      await expect.element(page.getByRole("link", { name: "Смотреть примеры" })).toHaveAttribute("href", "#examples");

      for (const [name, href] of [["Примеры", "#examples"], ["Как это работает", "#how"], ["Возможности", "#features"]] as const) {
        const link = page.getByRole("banner").getByRole("link", { name, exact: true, includeHidden: true });
        if (viewport === "компьютер") {
          await expect.element(link).toBeVisible();
          await expect.element(link).toHaveAttribute("href", href);
        } else {
          await expect.element(link).not.toBeVisible();
        }
        const headerHeight = page.getByRole("banner").element().getBoundingClientRect().height;
        expect(parseFloat(getComputedStyle(section(href.slice(1))).scrollMarginTop)).toBeGreaterThanOrEqual(headerHeight);
      }
      expectNoHorizontalScroll();
    });

    for (const result of [200, 401, 403, "network"] as const) {
      test(`${viewport}/${theme}: один отложенный запрос входа, результат ${result}`, async () => {
        localStorage.setItem("theme", theme);
        const pending = Promise.withResolvers<Response>();
        vi.mocked(globalThis.fetch).mockImplementation(() => pending.promise);
        await renderLanding(landing());
        await expect.element(page.getByRole("heading", { level: 1, name: hero })).toBeVisible();
        const buttons = loginLinks().elements();
        expect(buttons).toHaveLength(3);
        const before = buttons.map((button) => button.getBoundingClientRect().width);
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
        await nextFrame();
        expect(loginLinks().elements().map((button) => button.getBoundingClientRect().width)).toEqual(before);

        if (result === "network") pending.reject(new TypeError("network unavailable"));
        else pending.resolve(result === 200
          ? Response.json({ id: "00000000-0000-4000-8000-000000000033", name: "Посетитель", username: null, photoUrl: null, isOperator: false })
          : new Response(null, { status: result }));

        if (result === 200) {
          await expect.poll(() => studioLinks().elements().length).toBe(3);
          expect(loginLinks().elements()).toHaveLength(0);
          for (const link of studioLinks().elements()) expect(link.getAttribute("href")).toBe("/s");
          expect(studioLinks().elements().map((button) => button.getBoundingClientRect().width)).toEqual(before);
        } else {
          await nextFrame();
          await nextFrame();
          expect(loginLinks().elements()).toHaveLength(3);
          for (const link of loginLinks().elements()) expect(link.getAttribute("href")).toBe(loginHref);
          expect(studioLinks().elements()).toHaveLength(0);
          await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
          expect(document.body.textContent).not.toContain("network unavailable");
        }
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
        expectNoHorizontalScroll();
      });
    }

    test(`${viewport}/${theme}: плееры резервируют место и не запрашивают MP4 до воспроизведения`, async () => {
      localStorage.setItem("theme", theme);
      await renderLanding(landing());
      await expect.poll(() => videos().length).toBe(3);
      const before = videos().map((video) => video.getBoundingClientRect().height);
      for (const [index, video] of videos().entries()) {
        const example = landingExamples[index]!;
        expect(video.preload).toBe("none");
        expect(video.controls).toBe(true);
        expect(video.autoplay).toBe(false);
        expect(video.playsInline).toBe(true);
        expect(video.getAttribute("aria-label")).toBe(example.title);
        expect(video.src).toBe(example.video);
        expect(video.poster).toBe(example.poster);
        expect(video.width).toBe(example.width);
        expect(video.height).toBe(example.height);
        expect(video.querySelector("img")?.alt).toBe(example.title);
        expect(video.querySelector("track")).toBeNull();
        expect(video.getBoundingClientRect().height).toBeGreaterThan(0);
        expect(video.networkState).toBe(HTMLMediaElement.NETWORK_IDLE);
      }
      const portrait = videos()[1]!;
      expect(portrait.getBoundingClientRect().height).toBeLessThanOrEqual(window.innerHeight * 0.7);
      // Повторное использование уже загруженной картинки не обязано добавлять
      // новую ResourceTiming-запись; проверяем настоящий декодированный постер.
      await expect.poll(() => videos()[0]!.querySelector("img")!.naturalWidth).toBe(160);
      await nextFrame();
      expect(videos().map((video) => video.getBoundingClientRect().height)).toEqual(before);
      expect(performance.getEntriesByType("resource").filter((entry) => /\.mp4(?:[?#]|$)/.test(entry.name))).toEqual([]);
      for (const example of landingExamples) {
        await expect.element(page.getByText(example.title, { exact: true })).toBeVisible();
      }
      await expect.element(page.getByText("0:30", { exact: true }).first()).toBeVisible();
      await expect.element(page.getByText("0:20", { exact: true })).toBeVisible();
      expectNoHorizontalScroll();
    });

    test(`${viewport}/${theme}: запуск другого настоящего видео ставит первое на паузу`, async () => {
      localStorage.setItem("theme", theme);
      await renderLanding(landing());
      const [first, second] = videos();
      first!.muted = true;
      second!.muted = true;
      try {
        await first!.play();
        await expect.poll(() => first!.paused).toBe(false);
        await expect.poll(() => first!.currentTime).toBeGreaterThan(0);
        await second!.play();
        await expect.poll(() => second!.paused).toBe(false);
        await expect.poll(() => first!.paused).toBe(true);
        await expect.poll(() => second!.currentTime).toBeGreaterThan(0);
      } finally {
        for (const video of videos()) video.pause();
      }
    });

    test(`${viewport}/${theme}: reduced motion сразу показывает заголовок, шаги и возможности`, async () => {
      localStorage.setItem("theme", theme);
      await protocol().send("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-reduced-motion", value: "reduce" }],
      });
      expect(matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(true);
      await renderLanding(landing());
      const heading = page.getByRole("heading", { level: 1, name: hero }).element() as HTMLElement;
      expect(heading.textContent).toBe(hero);
      expectReadable(heading);
      for (const [title] of landingSteps) {
        expectReadable(page.elementLocator(section("how")).getByText(title, { exact: true }).element() as HTMLElement);
      }
      for (const [, description] of landingFeatures) {
        expectReadable(page.getByText(description, { exact: true }).element() as HTMLElement);
      }
      if (viewport === "компьютер") {
        await expect.poll(() => document.querySelector("canvas")).not.toBeNull();
      }
      const canvas = document.querySelector("canvas");
      const frame = canvas?.toDataURL();
      await nextFrame();
      await nextFrame();
      if (canvas) expect(canvas.toDataURL()).toBe(frame);
      expect(document.getAnimations().filter((animation) => animation.playState === "running")).toEqual([]);
      expectNoHorizontalScroll();
    });

    test(`${viewport}/${theme}: отсутствие canvas-контекста не ломает страницу`, async () => {
      localStorage.setItem("theme", theme);
      const context = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
      await renderLanding(landing());
      await expect.element(page.getByRole("heading", { level: 1, name: hero })).toBeVisible();
      for (const [, description] of landingFeatures) await expect.element(page.getByText(description, { exact: true })).toBeVisible();
      expect(loginLinks().elements()).toHaveLength(3);
      if (viewport === "компьютер") {
        await expect.poll(() => context.mock.calls.some(([kind]) => kind === "webgl2")).toBe(true);
      }
      await nextFrame();
      expectNoHorizontalScroll();
    });

    test(`${viewport}/${theme}: тема выбирается кнопкой и с клавиатуры`, async () => {
      localStorage.setItem("theme", theme);
      await renderLanding(landing());
      const light = page.getByRole("button", { name: "Светлая", exact: true });
      (light.element() as HTMLElement).focus();
      await userEvent.keyboard("{Enter}");
      await expect.poll(() => document.documentElement.classList.contains("light")).toBe(true);
      await userEvent.keyboard("{ArrowRight}");
      const dark = page.getByRole("button", { name: "Тёмная", exact: true });
      await expect.element(dark).toHaveFocus();
      await userEvent.keyboard(" ");
      await expect.poll(() => document.documentElement.classList.contains("dark")).toBe(true);
      await page.getByRole("button", { name: "Системная", exact: true }).click();
      expect(localStorage.getItem("theme")).toBe("system");
      expectNoHorizontalScroll();
    });
  }
}

test("серверная разметка содержит восемь возможностей и один корректный h1 до JavaScript", () => {
  const document = new DOMParser().parseFromString(renderToString(landing()), "text/html");
  expect(document.querySelectorAll("h1")).toHaveLength(1);
  expect(document.querySelector("h1 p")).toBeNull();
  for (const [title, description] of landingFeatures) {
    expect(document.body.textContent).toContain(title);
    expect(document.body.textContent).toContain(description);
  }
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

test("изменение reduced motion останавливает и возобновляет фон без перезагрузки", async () => {
  const drawing = vi.spyOn(WebGL2RenderingContext.prototype, "drawArrays");
  await protocol().send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  await renderOnDesktop(landing());
  await expect.poll(() => drawing.mock.calls.length).toBeGreaterThan(0);
  for (let frame = 0; frame < 4; frame++) await nextFrame();
  const stopped = drawing.mock.calls.length;
  await nextFrame();
  await nextFrame();
  expect(drawing.mock.calls.length).toBe(stopped);

  await protocol().send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "no-preference" }],
  });
  await expect.poll(() => drawing.mock.calls.length).toBeGreaterThan(stopped + 2);
  await protocol().send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  for (let frame = 0; frame < 4; frame++) await nextFrame();
  const pausedAgain = drawing.mock.calls.length;
  await nextFrame();
  await nextFrame();
  expect(drawing.mock.calls.length).toBe(pausedAgain);
});

test("пустой манифест не показывает примеры, пустую карусель и ссылки на отсутствующий якорь", async () => {
  await renderOnDesktop(landing([]));
  expect(document.getElementById("examples")).toBeNull();
  expect(document.querySelectorAll('a[href="#examples"]')).toHaveLength(0);
  expect(videos()).toHaveLength(0);
  await expect.element(page.getByRole("heading", { level: 1, name: hero })).toBeVisible();
  expectNoHorizontalScroll();
});

test.each(["light", "dark"] as const)("компьютер/%s: якоря шапки прокручивают секции ниже липкой шапки, просьбы видны целиком", async (theme) => {
  localStorage.setItem("theme", theme);
  await renderOnDesktop(landing());
  const originalUrl = location.href;
  try {
    for (const [name, id] of [["Примеры", "examples"], ["Как это работает", "how"], ["Возможности", "features"]] as const) {
      await page.getByRole("banner").getByRole("link", { name, exact: true }).click();
      await expect.poll(() => location.hash).toBe(`#${id}`);
      await expect.poll(() => section(id).getBoundingClientRect().top).toBeGreaterThanOrEqual(
        page.getByRole("banner").element().getBoundingClientRect().bottom - 1,
      );
    }
    for (const example of landingExamples) {
      const request = page.getByText(`Запрос: «${example.request}»`, { exact: true }).element() as HTMLElement;
      expect(request.scrollHeight).toBeLessThanOrEqual(request.clientHeight + 1);
    }
    await expect.element(page.getByRole("button", { name: "Показать полностью", exact: true }).first()).not.toBeInTheDocument();
    expectNoHorizontalScroll();
  } finally {
    history.replaceState(null, "", originalUrl);
  }
});

test.each(["light", "dark"] as const)("компьютер/%s: три карточки в ряд без стрелок, четвёртая доступна кнопками Вперёд и Назад", async (theme) => {
  localStorage.setItem("theme", theme);
  const screen = await renderOnDesktop(landing());
  await expect.element(page.getByRole("button", { name: "Вперёд", exact: true })).not.toBeInTheDocument();
  await expect.element(page.getByRole("button", { name: "Назад", exact: true })).not.toBeInTheDocument();
  const rects = videos().map((video) => video.closest('[data-slot="carousel-item"]')!.getBoundingClientRect());
  expect(new Set(rects.map((rect) => rect.top)).size).toBe(1);
  expect(rects[2]!.right).toBeLessThanOrEqual(window.innerWidth);
  await screen.unmount();
  await renderOnDesktop(landing(fourLandingExamples));
  const next = page.getByRole("button", { name: "Вперёд", exact: true });
  const previous = page.getByRole("button", { name: "Назад", exact: true });
  section("examples").scrollIntoView({ block: "start" });
  await expect.element(next).toBeEnabled();
  await expect.element(previous).toBeDisabled();
  const last = page.getByText("Четвёртый пример", { exact: true });
  const viewport = section("examples").querySelector<HTMLElement>('[data-slot="carousel-content"]')!;
  expect(last.element().getBoundingClientRect().left).toBeGreaterThanOrEqual(viewport.getBoundingClientRect().right);
  await next.click();
  await expect.poll(() => last.element().getBoundingClientRect().right).toBeLessThanOrEqual(viewport.getBoundingClientRect().right + 1);
  await expect.element(previous).toBeEnabled();
  await previous.click();
  await expect.element(previous).toBeDisabled();
  expectNoHorizontalScroll();
});

test.each(["light", "dark"] as const)("телефон/%s: просьба ограничена тремя строками и раскрывается целиком", async (theme) => {
  localStorage.setItem("theme", theme);
  await renderOnPhone(landing());
  const request = page.getByText(/Запрос:.*Сделай объясняющий ролик/).element() as HTMLElement;
  const collapsedHeight = request.getBoundingClientRect().height;
  expect(collapsedHeight).toBeLessThanOrEqual(parseFloat(getComputedStyle(request).lineHeight) * 3 + 1);
  expect(request.scrollHeight).toBeGreaterThan(request.clientHeight);
  await page.getByRole("button", { name: "Показать полностью", exact: true }).first().click();
  expect(request.textContent).toContain(landingExamples[0]!.request);
  expect(request.getBoundingClientRect().height).toBeGreaterThan(collapsedHeight);
  expect(request.scrollHeight).toBeLessThanOrEqual(request.clientHeight + 1);
  expectNoHorizontalScroll();
});

test.each(["light", "dark"] as const)("телефон/%s: свайп по карусели показывает следующую карточку", async (theme) => {
  localStorage.setItem("theme", theme);
  await protocol().send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  let target: HTMLElement | null = null;
  let started = false;
  const events: { type: string; trusted: boolean }[] = [];
  const record = (event: Event) => events.push({ type: event.type, trusted: event.isTrusted });
  try {
    await renderOnPhone(landing());
    target = section("examples").querySelector<HTMLElement>('[data-slot="carousel-content"]')!;
    expect(target).not.toBeNull();
    const title = page.getByRole("heading", { name: "Как устроен светофор", exact: true }).element();
    title.scrollIntoView({ block: "center" });
    await nextFrame();
    const before = videos()[1]!.getBoundingClientRect().left;
    const rect = target.getBoundingClientRect();
    const titleRect = title.getBoundingClientRect();
    // CDP принимает координаты верхнего окна, а Vitest рисует страницу в iframe,
    // который может быть смещён или масштабирован интерфейсом самого раннера.
    const frame = window.frameElement?.getBoundingClientRect();
    const scaleX = frame ? frame.width / window.innerWidth : 1;
    const scaleY = frame ? frame.height / window.innerHeight : 1;
    const startX = Math.min(rect.right, window.innerWidth) - 40;
    const y = titleRect.top + titleRect.height / 2;
    const point = (x: number) => ({
      x: (frame?.left ?? 0) + x * scaleX,
      y: (frame?.top ?? 0) + y * scaleY,
      id: 33,
    });
    for (const type of ["touchstart", "touchmove", "touchend", "touchcancel"]) target.addEventListener(type, record);
    await protocol().send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point(startX)] });
    started = true;
    expect(events[0]).toEqual({ type: "touchstart", trusted: true });
    for (let step = 1; step <= 8; step++) {
      await protocol().send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [point(startX - step * 35)],
      });
      await nextFrame();
    }
    await protocol().send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    started = false;
    expect(events.some((event) => event.type === "touchcancel")).toBe(false);
    await expect.poll(() => videos()[1]!.getBoundingClientRect().left).toBeLessThan(before - 100);
    await expect.poll(() => videos()[1]!.getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth);
    expectNoHorizontalScroll();
  } finally {
    if (started) await protocol().send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
    for (const type of ["touchstart", "touchmove", "touchend", "touchcancel"]) target?.removeEventListener(type, record);
    await protocol().send("Emulation.setTouchEmulationEnabled", { enabled: false });
  }
});

test("телефон: взаимодействия после отрисовки при CPU ×4 не создают задач дольше 200 мс", async () => {
  await renderOnPhone(landing());
  await document.fonts.ready;
  await nextFrame();
  await nextFrame();
  const longTasks: PerformanceEntry[] = [];
  const observer = new PerformanceObserver((list) => {
    longTasks.push(...list.getEntries());
  });
  expect(PerformanceObserver.supportedEntryTypes).toContain("longtask");
  await protocol().send("Emulation.setCPUThrottlingRate", { rate: 4 });
  observer.observe({ type: "longtask" });
  try {
    await expect.element(page.getByRole("heading", { level: 1, name: hero })).toBeVisible();
    await page.getByRole("button", { name: "Показать полностью", exact: true }).first().click();
    await nextFrame();
    await nextFrame();
    longTasks.push(...observer.takeRecords());
    expect(longTasks.filter((entry) => entry.duration > 200).map((entry) => entry.toJSON())).toEqual([]);
    expectNoHorizontalScroll();
  } finally {
    observer.disconnect();
    await protocol().send("Emulation.setCPUThrottlingRate", { rate: 1 });
  }
});
