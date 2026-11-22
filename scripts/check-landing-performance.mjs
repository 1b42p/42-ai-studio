import { chromium } from "playwright";

const url = process.argv[2];
if (!url || !/^https?:\/\//.test(url)) {
  throw new Error("Укажите адрес production-сборки: node scripts/check-landing-performance.mjs http://localhost:3000");
}

const browser = await chromium.launch();
const results = [];

async function observeEnhancement(page) {
  await page.evaluate(() => new Promise((resolve) => {
    const afterIdle = () => requestAnimationFrame(() => requestAnimationFrame(resolve));
    if (typeof requestIdleCallback === "function") requestIdleCallback(afterIdle, { timeout: 1000 });
    else setTimeout(afterIdle, 0);
  }));
  await page.waitForLoadState("networkidle");
  // Sample a full second of rendered frames after loading or interaction,
  // including scheduled browser callbacks, not just network requests.
  await page.evaluate(() => new Promise((resolve) => {
    const until = performance.now() + 1000;
    const sample = (now) => now >= until ? resolve() : requestAnimationFrame(sample);
    requestAnimationFrame(sample);
  }));
}

try {
  for (const theme of ["light", "dark"]) {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      colorScheme: theme,
      reducedMotion: "no-preference",
      isMobile: true,
      hasTouch: true,
    });
    await context.addInitScript((theme) => {
      localStorage.setItem("theme", theme);
      window.landingLongTasks = [];
      if (!PerformanceObserver.supportedEntryTypes.includes("longtask")) {
        throw new Error("Браузер не поддерживает измерение Long Task");
      }
      window.landingTaskObserver = new PerformanceObserver((list) => {
        for (const { startTime, duration } of list.getEntries()) {
          window.landingLongTasks.push({ startTime, duration });
        }
      });
      window.landingTaskObserver.observe({ type: "longtask", buffered: true });
    }, theme);
    try {
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const cdp = await context.newCDPSession(page);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
      await cdp.send("Network.enable");
      await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
      const profileResponse = page.waitForResponse((response) =>
        response.url() === new URL("/api/auth/me", url).href,
      );
      const [response, profile] = await Promise.all([
        page.goto(url, { waitUntil: "domcontentloaded" }),
        profileResponse,
      ]);
      if (response?.status() !== 200) throw new Error(`Главная ответила ${response?.status()}`);
      if (profile.status() !== 401) throw new Error(`Профиль гостя ответил ${profile.status()}`);
      const profileError = await profile.finished();
      if (profileError) throw profileError;
      await page.getByRole("heading", { level: 1 }).waitFor();
      await observeEnhancement(page);
      const expand = page.getByRole("button", { name: "Показать полностью", exact: true }).first();
      if (await expand.count()) {
        await expand.click();
        await page.getByRole("button", { name: "Свернуть", exact: true }).first().waitFor();
        await observeEnhancement(page);
      }
      await page.locator("#how").scrollIntoViewIfNeeded();
      await observeEnhancement(page);
      await page.locator("#features").scrollIntoViewIfNeeded();
      await page.locator('#features [data-slot="studio-bento"]').waitFor({ state: "attached" });
      await observeEnhancement(page);
      await page.getByRole("button", { name: theme === "light" ? "Тёмная" : "Светлая", exact: true }).click();
      await observeEnhancement(page);
      const metrics = await page.evaluate(() => {
        for (const { startTime, duration } of window.landingTaskObserver.takeRecords()) {
          window.landingLongTasks.push({ startTime, duration });
        }
        window.landingTaskObserver.disconnect();
        return {
          longTasks: window.landingLongTasks,
          horizontalScroll: document.documentElement.scrollWidth > innerWidth,
          videoRequests: performance.getEntriesByType("resource")
            .filter(({ name }) => /\.mp4(?:[?#]|$)/.test(name))
            .map(({ name }) => name),
        };
      });
      results.push({ theme, errors, ...metrics });
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
}

console.log(JSON.stringify(results, null, 2));
if (results.some(({ errors, longTasks, horizontalScroll, videoRequests }) =>
  errors.length || horizontalScroll || videoRequests.length || longTasks.some(({ duration }) => duration > 200))) {
  process.exitCode = 1;
}
