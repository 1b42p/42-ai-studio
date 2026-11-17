import type { CDPSession } from "playwright";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cdp, commands, page, userEvent } from "vitest/browser";
import { renderToString } from "react-dom/server";

import { LandingPage } from "@/components/studio/landing/landing-page";
import { ExamplesSection } from "@/components/studio/landing/examples-section";
import { disposeKineticModel, loadKineticAssets } from "@/components/studio/landing/kinetic-assets";
import type { ExampleVideo } from "@/lib/examples";

import { fourLandingExamples, landingExamples, landingFeatures, landingSteps } from "./fixtures/landing";
import { expectNoHorizontalScroll, renderOnDesktop, renderOnPhone } from "./support/render";

const hero = "Опишите ролик словами — получите готовое видео";
const loginHref = "/api/auth/telegram/login?next=%2Fs";
const protocol = () => cdp() as Pick<CDPSession, "send">;
const diagnostics: string[] = [];
let authResponse: () => Promise<Response>;

function authCalls() {
  return vi.mocked(globalThis.fetch).mock.calls.filter(([input]) => input === "/api/auth/me");
}

function scene() {
  return page.getByRole("img", { name: "Кинетическая скульптура из оранжевых кинолент", exact: true }).element();
}

function scenePoster() {
  const theme = document.documentElement.classList.contains("dark") ? "dark" : "light";
  return scene().querySelector<HTMLImageElement>(`img[data-sculpture-theme="${theme}"]`)!;
}

function hasPaintedModel(canvas: HTMLCanvasElement) {
  const sample = document.createElement("canvas");
  sample.width = sample.height = 32;
  const context = sample.getContext("2d")!;
  context.drawImage(canvas, 0, 0, 32, 32);
  const pixels = context.getImageData(0, 0, 32, 32).data;
  let orange = 0;
  for (let index = 0; index < pixels.length; index += 4) {
    const [red, green, blue, alpha] = pixels.slice(index, index + 4);
    if (alpha > 128 && red > 90 && red > green * 1.25 && green > blue * 1.1) orange++;
  }
  return orange > 8;
}

async function expectSceneReady() {
  await expect.poll(() => scene().querySelector("canvas"), { timeout: 15000 }).not.toBeNull();
  try {
    await expect.poll(() => getComputedStyle(scenePoster()).opacity, { timeout: 15000 }).toBe("0");
  } catch (cause) {
    const canvas = scene().querySelector("canvas");
    throw new Error(`Сцена не показала первый кадр: ${JSON.stringify({
      hidden: document.hidden,
      bounds: scene().getBoundingClientRect().toJSON(),
      canvas: canvas ? { width: canvas.width, height: canvas.height } : null,
      assets: performance.getEntriesByType("resource")
        .filter(({ name }) => /kinetic-.*\.(?:glb|gz)/.test(name))
        .map((entry) => ({ name: entry.name, duration: entry.duration })),
    })}`, { cause });
  }
  const canvas = scene().querySelector("canvas")!;
  await expect.poll(() => hasPaintedModel(canvas), { timeout: 15000 }).toBe(true);
  return canvas;
}

async function expectStillScene(canvas: HTMLCanvasElement) {
  await expect.poll(async () => {
    const image = canvas.toDataURL();
    for (let frame = 0; frame < 6; frame++) await nextFrame();
    return canvas.toDataURL() === image;
  }).toBe(true);
}

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
  const fetch = globalThis.fetch.bind(globalThis);
  authResponse = async () => new Response(null, { status: 401 });
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) =>
    input === "/api/auth/me" ? authResponse() : fetch(input, init),
  );
});

afterEach(async () => {
  await protocol().send("Emulation.setEmulatedMedia", { features: [] });
  await protocol().send("Emulation.setCPUThrottlingRate", { rate: 1 });
  vi.restoreAllMocks();
  localStorage.clear();
  expect(diagnostics).toEqual([]);
});

test.each([200, 401])("ответ профиля %s дочитывается, общий запрос завершается", async (status) => {
  const response = new Response("{}", { status });
  authResponse = async () => response;
  await renderOnPhone(landing());
  await expect.poll(() => response.bodyUsed).toBe(true);
  const links = status === 200 ? studioLinks() : loginLinks();
  await expect.poll(() => links.elements().length).toBe(3);
  expect(authCalls()).toHaveLength(1);
});

test("ошибка чтения тела профиля сохраняет ссылки входа", async () => {
  const response = new Response(new ReadableStream({
    start(controller) {
      controller.error(new Error("Не удалось прочитать ответ"));
    },
  }), { status: 200 });
  authResponse = async () => response;
  await renderOnPhone(landing());
  await expect.poll(() => response.bodyUsed).toBe(true);
  await expect.poll(() => loginLinks().elements().length).toBe(3);
  expect(authCalls()).toHaveLength(1);
  await nextFrame();
});

for (const [viewport, renderLanding] of [
  ["телефон", renderOnPhone],
  ["компьютер", renderOnDesktop],
] as const) {
  test(`${viewport}: этапы истории доступны с клавиатуры, кадры и повтор монтажа работают`, async () => {
    await protocol().send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
    await renderLanding(landing());
    const steps = page.getByRole("tablist", { name: "Этапы создания видео" }).getByRole("tab");
    await expect.element(steps.nth(0)).toHaveAttribute("aria-selected", "true");
    (steps.nth(0).element() as HTMLElement).focus();
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
    await expect.element(page.getByRole("button", { name: "Кадр 1", exact: true })).toHaveAttribute("aria-pressed", "false");
    await expect.element(page.getByRole("button", { name: "Смотреть монтаж", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Кадр 1", exact: true }).click();
    await expect.element(page.getByRole("button", { name: "Кадр 1", exact: true })).toHaveAttribute("aria-pressed", "true");
    await third.click();
    await expect.element(third).toHaveAttribute("aria-pressed", "true");
    expectNoHorizontalScroll();
  });

  test(`${viewport}: интерактивные демо меняют композицию и работают при reduced motion`, async () => {
    await protocol().send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
    await renderLanding(landing());
    const titleScene = page.getByRole("button", { name: "Сменить титровую сцену", exact: true });
    const kinetic = titleScene.element().closest("[data-capability]")!;
    const originalTitle = kinetic.querySelector("p")!.style.transform;
    await titleScene.click();
    await expect.poll(() => kinetic.querySelector("p")!.style.transform).not.toBe(originalTitle);
    const caption = page.getByRole("button", { name: "Показать выделение слов" });
    const captions = caption.element().closest("[data-capability]")!;
    const highlighted = () => captions.querySelector(".text-primary-foreground")?.textContent?.trim();
    expect(highlighted()).toBe("У");
    await caption.click();
    await expect.poll(highlighted).toBe("каждого");
    await page.getByRole("button", { name: "Вернуться к первому слову" }).click();
    await expect.poll(highlighted).toBe("У");
    const table = page.getByRole("button", { name: "Показать исходную таблицу" });
    const data = table.element().closest("[data-capability]")!;
    const bar = data.querySelector<HTMLElement>(".absolute.flex.items-start")!;
    const height = bar.style.height;
    await table.click();
    await expect.poll(() => bar.style.height).toBe("28px");
    await page.getByRole("button", { name: "Превратить таблицу в диаграмму" }).click();
    await expect.poll(() => bar.style.height).toBe(height);
    const thirdFragment = page.getByRole("button", { name: "Выбрать фрагмент 3: 3–4,5 с", exact: true });
    await thirdFragment.click();
    await expect.element(thirdFragment).toHaveAttribute("aria-pressed", "true");
    await expect.element(page.getByRole("button", { name: "Выбрать фрагмент 1: 0–1,5 с", exact: true })).toHaveAttribute("aria-pressed", "false");
    const rhythm = page.getByRole("button", { name: "Показать ритм", exact: true });
    const music = rhythm.element().closest("[data-capability]")!;
    const cursor = music.querySelector<HTMLElement>(".absolute.inset-y-0.w-px")!;
    const position = cursor.style.left;
    await rhythm.click();
    await expect.poll(() => cursor.style.left).not.toBe(position);
    const enlarge = page.getByRole("button", { name: "Сделай заголовок крупнее", exact: true });
    const editCard = enlarge.element().closest("[data-capability]")!;
    const preview = document.getElementById(enlarge.element().getAttribute("aria-controls")!)!;
    const text = preview.querySelector<HTMLElement>("p")!;
    const size = parseFloat(getComputedStyle(text).fontSize);
    await enlarge.click();
    await expect.poll(() => parseFloat(getComputedStyle(text).fontSize)).toBeGreaterThan(size);
    await expect.element(page.elementLocator(editCard).getByRole("status")).toHaveTextContent("Заголовок в композиции увеличен.");
    await page.getByRole("button", { name: "Вернуть как было", exact: true }).click();
    await expect.poll(() => parseFloat(getComputedStyle(text).fontSize)).toBe(size);
    expectNoHorizontalScroll();
  });

  test(`${viewport}: видеоклип загружается по нажатию, выбранный интервал играет и останавливается вне экрана`, async () => {
    await renderLanding(landing());
    const video = document.querySelector<HTMLVideoElement>("#features video")!;
    expect(video.getAttribute("src")).toBeNull();
    expect(video.preload).toBe("none");
    expect(video.autoplay).toBe(false);
    expect(performance.getEntriesByType("resource").filter(({ name }) => /film-source-v1\.mp4/.test(name))).toEqual([]);

    await page.getByRole("button", { name: "Выбрать фрагмент 3: 3–4,5 с", exact: true }).click();
    expect(video.getAttribute("src")).toBeNull();
    await expect.poll(() => video.getAttribute("aria-label")).toBe("Фрагмент 3 в композиции");
    await page.getByRole("button", { name: "Посмотреть фрагмент 3 в композиции", exact: true }).click();
    await expect.poll(() => video.currentTime).toBeGreaterThanOrEqual(3);
    await expect.poll(() => video.paused).toBe(false);
    await expect.poll(() => video.paused, { timeout: 5000 }).toBe(true);
    expect(video.currentTime).toBeLessThanOrEqual(4.5);
    expect(video.currentTime).toBeGreaterThan(4.3);
    expect(video.error).toBeNull();

    await page.getByRole("button", { name: "Посмотреть исходный клип целиком", exact: true }).click();
    await expect.poll(() => video.paused).toBe(false);
    expect(video.currentTime).toBeLessThan(1.5);
    page.getByRole("heading", { level: 1 }).element().scrollIntoView({ behavior: "instant" });
    await expect.poll(() => video.paused).toBe(true);
    expectNoHorizontalScroll();
  }, 15000);

  test(`${viewport}: настоящая озвучка загружается только по нажатию и ставится на паузу`, async () => {
    await renderLanding(landing());
    const audio = document.querySelector<HTMLAudioElement>("#features audio")!;
    expect(audio.getAttribute("src")).toBeNull();
    expect(performance.getEntriesByType("resource").filter(({ name }) => /voice-sample-v1\.mp3/.test(name))).toEqual([]);
    const play = page.getByRole("button", { name: "Послушать озвучку", exact: true });
    play.element().scrollIntoView({ block: "center" });
    await nextFrame();
    await nextFrame();
    audio.muted = true;
    await play.click();
    await expect.poll(() => audio.paused).toBe(false);
    await expect.poll(() => audio.currentTime).toBeGreaterThan(0);
    await page.getByRole("button", { name: "Приостановить озвучку", exact: true }).click();
    await expect.poll(() => audio.paused).toBe(true);
    const slider = page.getByRole("slider", { name: "Позиция воспроизведения озвучки" });
    (slider.element() as HTMLElement).focus();
    await userEvent.keyboard("{End}");
    await expect.poll(() => audio.currentTime).toBeGreaterThan(audio.duration - 0.1);
    expectNoHorizontalScroll();
  });

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
        await expect.element(page.elementLocator(section("how")).getByRole("tab", { name: new RegExp(title) })).toBeVisible();
        await expect.element(page.getByText(description, { exact: true })).toBeVisible();
      }
      for (const [title, description] of landingFeatures) {
        await expect.element(page.elementLocator(section("features")).getByText(title, { exact: true })).toBeVisible();
        await expect.element(page.getByText(description, { exact: true })).toBeVisible();
      }
      expect(section("how").querySelectorAll('[role="tab"]')).toHaveLength(4);
      expect(section("features").querySelectorAll("h3")).toHaveLength(8);
      expect(section("features").querySelectorAll("[data-capability]")).toHaveLength(8);
      for (const image of document.querySelectorAll<HTMLImageElement>("#how img, #features img[alt]:not([alt=''])")) {
        expect(landingExamples.map(({ poster }) => poster)).toContain(image.src);
      }
      const heading = document.querySelector("h1")!;
      expect(heading.scrollWidth).toBeLessThanOrEqual(heading.clientWidth + 1);

      expect(loginLinks().elements()).toHaveLength(3);
      for (const link of loginLinks().elements()) {
        expect(link.tagName).toBe("A");
        expect(link.getAttribute("href")).toBe(loginHref);
        expect(link.querySelector("svg")).not.toBeNull();
      }
      expect(authCalls()).toHaveLength(1);
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
        authResponse = () => pending.promise;
        await renderLanding(landing());
        await expect.element(page.getByRole("heading", { level: 1, name: hero })).toBeVisible();
        const buttons = loginLinks().elements();
        expect(buttons).toHaveLength(3);
        const before = buttons.map((button) => button.getBoundingClientRect().width);
        expect(authCalls()).toHaveLength(1);
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
        expect(authCalls()).toHaveLength(1);
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
        expectReadable(page.elementLocator(section("how")).getByRole("tab", { name: new RegExp(title) }).element() as HTMLElement);
      }
      for (const [, description] of landingFeatures) {
        expectReadable(page.getByText(description, { exact: true }).element() as HTMLElement);
      }
      if (viewport === "компьютер") {
        await expectStillScene(await expectSceneReady());
      } else {
        expect(scene().querySelector("canvas")).toBeNull();
        expect(vi.mocked(globalThis.fetch).mock.calls.filter(([input]) => /kinetic-(?:light|dark)\.glb/.test(String(input)))).toEqual([]);
        expect(performance.getEntriesByType("resource").filter(({ name }) => /kinetic-canvas|react-three|kinetic-(?:light|dark)\.glb/.test(name))).toEqual([]);
      }
      expect(document.getAnimations().filter((animation) => animation.playState === "running")).toEqual([]);
      expectNoHorizontalScroll();
    }, 20000);

    test(`${viewport}/${theme}: отсутствие canvas-контекста не ломает страницу`, async () => {
      localStorage.setItem("theme", theme);
      const context = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
      await renderLanding(landing());
      await expect.element(page.getByRole("heading", { level: 1, name: hero })).toBeVisible();
      for (const [, description] of landingFeatures) await expect.element(page.getByText(description, { exact: true })).toBeVisible();
      expect(loginLinks().elements()).toHaveLength(3);
      if (viewport === "компьютер") {
        await expect.poll(() => context.mock.calls.some(([kind]) => String(kind) === "webgl2")).toBe(true);
      }
      const poster = scenePoster();
      await expect.poll(() => poster.naturalWidth).toBeGreaterThan(0);
      expect(getComputedStyle(poster).opacity).toBe("1");
      expect(scene().querySelector("canvas")).toBeNull();
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
  expect(document.querySelectorAll("[data-capability]")).toHaveLength(8);
  expect(document.querySelector('img[src="/landing/kinetic-light.webp"]')).not.toBeNull();
  expect(document.querySelector("canvas")).toBeNull();
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

test.each([768, 1024])("узкое окно %s px сохраняет читаемую композицию демонстраций", async (width) => {
  await renderOnDesktop(landing());
  await page.viewport(width, 1000);
  const documents = document.querySelector<HTMLElement>('[data-capability="Презентации и статьи"]')!;
  const film = document.querySelector<HTMLElement>('[data-capability="Видео по ссылкам"]')!;
  const music = document.querySelector<HTMLElement>('[data-capability="Фоновая музыка"]')!;
  expect(documents.getBoundingClientRect().width).toBeGreaterThan(300);
  expect(film.getBoundingClientRect().top).toBeCloseTo(documents.getBoundingClientRect().top, 0);
  expect(music.getBoundingClientRect().top).toBeGreaterThan(film.getBoundingClientRect().bottom);
  const title = page.elementLocator(film).getByText("НАША ПЛАНЕТА.", { exact: true }).element() as HTMLElement;
  expect(title.scrollWidth).toBeLessThanOrEqual(title.clientWidth + 1);
  expectNoHorizontalScroll();
});

test.each(["light", "dark"] as const)("локальные ассеты kinetic/%s содержат скульптуру и совместимое HDR-окружение", async (theme) => {
  const assets = await loadKineticAssets(theme, new AbortController().signal);
  try {
    expect(assets.sculpture.name).toBe("Light-Cut");
    expect(assets.sculpture.children).toHaveLength(4);
    expect(assets.environment.image.width).toBe(768);
    expect(assets.environment.image.height).toBe(1024);
  } finally {
    assets.environment.dispose();
    disposeKineticModel(assets.model);
  }
});

test("изменение reduced motion останавливает и возобновляет настоящую 3D-сцену без перезагрузки", async () => {
  const drawing = vi.spyOn(WebGL2RenderingContext.prototype, "drawElements");
  await protocol().send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  await renderOnDesktop(landing());
  const canvas = await expectSceneReady();
  await expect.poll(() => drawing.mock.calls.length).toBeGreaterThan(0);
  await expectStillScene(canvas);
  const stopped = drawing.mock.calls.length;
  await nextFrame();
  await nextFrame();
  expect(drawing.mock.calls.length).toBe(stopped);

  await protocol().send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "no-preference" }],
  });
  await expect.poll(() => drawing.mock.calls.length).toBeGreaterThan(stopped + 2);
  const moving = canvas.toDataURL();
  await expect.poll(() => canvas.toDataURL()).not.toBe(moving);
  await protocol().send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  await expectStillScene(canvas);
  const pausedAgain = drawing.mock.calls.length;
  await nextFrame();
  await nextFrame();
  expect(drawing.mock.calls.length).toBe(pausedAgain);
}, 20000);

test("3D-сцена не остаётся пустой после перехода компьютер → телефон → планшет", async () => {
  await protocol().send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  await renderOnDesktop(landing());
  const original = await expectSceneReady();
  await page.viewport(390, 844);
  await expect.poll(() => scene().querySelector("canvas")).toBeNull();
  expect(getComputedStyle(scenePoster()).opacity).toBe("1");
  await page.viewport(768, 800);
  const remounted = await expectSceneReady();
  expect(remounted).not.toBe(original);
  expectNoHorizontalScroll();
}, 30000);

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

test.each(["light", "dark"] as const)("компьютер/%s: редакционная сетка 2+1 без стрелок, четвёртая доступна кнопками Вперёд и Назад", async (theme) => {
  localStorage.setItem("theme", theme);
  const screen = await renderOnDesktop(<ExamplesSection examples={landingExamples} />);
  await expect.element(page.getByRole("button", { name: "Вперёд", exact: true })).not.toBeInTheDocument();
  await expect.element(page.getByRole("button", { name: "Назад", exact: true })).not.toBeInTheDocument();
  const rects = videos().map((video) => video.closest('[data-slot="carousel-item"]')!.getBoundingClientRect());
  const [first, portrait, third] = rects;
  expect(third!.left).toBe(first!.left);
  expect(third!.top).toBeGreaterThan(first!.bottom);
  expect(portrait!.left).toBeGreaterThan(first!.right);
  expect(portrait!.top).toBe(first!.top);
  const portraitItem = videos()[1]!.closest<HTMLElement>('[data-slot="carousel-item"]')!;
  expect(getComputedStyle(portraitItem).gridRowStart).toBe("1");
  expect(getComputedStyle(portraitItem).gridRowEnd).toBe("span 2");
  expect(portrait!.right).toBeLessThanOrEqual(window.innerWidth);
  expect(first!.width).toBeGreaterThan(portrait!.width);
  await screen.unmount();
  await renderOnDesktop(<ExamplesSection examples={fourLandingExamples} />);
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

test.each(["light", "dark"] as const)("телефон/%s: клавиатура меняет карточки, высота галереи следует активной карточке без пустого поля", async (theme) => {
  localStorage.setItem("theme", theme);
  await renderOnPhone(landing());
  const viewport = section("examples").querySelector<HTMLElement>('[data-slot="carousel-content"]')!;
  viewport.scrollIntoView({ block: "center" });
  const slides = [...viewport.querySelectorAll<HTMLElement>('[data-slot="carousel-item"]')];
  const track = viewport.firstElementChild as HTMLElement;
  await expect.poll(() => track.style.height).not.toBe("");
  await expect.poll(() => Math.abs(viewport.getBoundingClientRect().height - slides[0]!.getBoundingClientRect().height)).toBeLessThanOrEqual(1);
  const landscapeHeight = viewport.getBoundingClientRect().height;
  expect(slides[1]!.getBoundingClientRect().height).toBeGreaterThan(landscapeHeight);
  (page.getByRole("button", { name: "Показать полностью", exact: true }).first().element() as HTMLElement).focus();
  await userEvent.keyboard("{ArrowRight}");
  await expect.poll(() => Math.abs(viewport.getBoundingClientRect().height - slides[1]!.getBoundingClientRect().height)).toBeLessThanOrEqual(1);
  await expect.poll(() => videos()[1]!.getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth);
  await userEvent.keyboard("{ArrowLeft}");
  await expect.poll(() => viewport.getBoundingClientRect().height).toBe(landscapeHeight);
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
