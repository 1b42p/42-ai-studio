/**
 * Тесты отрисовки: настоящий Chromium, компоненты React и те же глобальные
 * стили, что у приложения. Запуск — `npm run test:render`.
 * Браузер ставится командой `npx playwright install chromium` (см. README).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";
import type { BrowserCommand } from "vitest/node";

/** Эмуляция системной цветовой схемы через настройки страницы Playwright. */
const emulateColorScheme: BrowserCommand<["light" | "dark"]> = async (
  context,
  colorScheme,
) => {
  if (context.provider.name !== "playwright") {
    throw new Error("Эмуляция цветовой схемы доступна только с провайдером Playwright");
  }

  await context.page.emulateMedia({ colorScheme });
};

/**
 * Ответ на медиа: первый запрос — 404, повторные — настоящий tiny.mp4.
 * Так проверяется одна повторная загрузка после ошибки (#8).
 */
const retryMedia: BrowserCommand<[string]> = async (context, pattern) => {
  if (context.provider.name !== "playwright") {
    throw new Error("Подмена медиа доступна только с провайдером Playwright");
  }
  const body = readFileSync(
    fileURLToPath(new URL("tests/render/fixtures/tiny.mp4", import.meta.url)),
  );
  let requests = 0;
  await context.page.unroute(pattern);
  await context.page.route(pattern, async (route) => {
    requests += 1;
    await route.fulfill(
      requests === 1
        ? { status: 404, contentType: "text/plain", body: "not found" }
        : { status: 200, contentType: "video/mp4", body },
    );
  });
};

/** Все запросы медиа — 404: вторая ошибка показывает карточку скачивания. */
const failMedia: BrowserCommand<[string]> = async (context, pattern) => {
  if (context.provider.name !== "playwright") {
    throw new Error("Подмена медиа доступна только с провайдером Playwright");
  }
  await context.page.unroute(pattern);
  await context.page.route(pattern, async (route) => {
    await route.fulfill({ status: 404, contentType: "text/plain", body: "not found" });
  });
};

declare module "vitest/browser" {
  interface BrowserCommands {
    emulateColorScheme: (colorScheme: "light" | "dark") => Promise<void>;
    failMedia: (pattern: string) => Promise<void>;
    retryMedia: (pattern: string) => Promise<void>;
  }
}

export default defineConfig({
  plugins: [tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  test: {
    include: ["tests/render/**/*.test.tsx"],
    setupFiles: ["tests/render/setup.ts"],
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      instances: [{ browser: "chromium" }],
      commands: { emulateColorScheme, failMedia, retryMedia },
    },
  },
});
