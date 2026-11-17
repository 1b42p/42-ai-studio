import type { CDPSession } from "playwright";
import { act } from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cdp, page } from "vitest/browser";

import { SculptureScene } from "@/components/studio/landing/sculpture-scene";
import { sculptureCompositions } from "@/components/studio/landing/sculpture-config";

// renderToString inside Chromium otherwise sees next-themes' client state.
// Keep the actual scene, CSS, IntersectionObserver and image loading untouched.
const themeState = vi.hoisted(() => ({
  resolvedTheme: undefined as "light" | "dark" | undefined,
}));

vi.mock("next-themes", async (importOriginal) => {
  const original = await importOriginal<typeof import("next-themes")>();
  return {
    ...original,
    useTheme: () => ({
      ...original.useTheme(),
      resolvedTheme: themeState.resolvedTheme,
    }),
  };
});

const protocol = () => cdp() as Pick<CDPSession, "send">;
const diagnostics: unknown[][] = [];

async function frames(count = 12) {
  for (let frame = 0; frame < count; frame++) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
}

function attributes(element: Element) {
  return [...element.attributes].map(({ name, value }) => [name, value]);
}

beforeEach(async () => {
  diagnostics.length = 0;
  themeState.resolvedTheme = undefined;
  localStorage.clear();
  document.documentElement.classList.remove("light", "dark");
  await page.viewport(390, 844);
  window.scrollTo({ top: 0, behavior: "instant" });
  await protocol().send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  // Every case must observe a real visible-poster request, not inherit an image
  // cache hit from a previous theme. Do not intercept or fake the image response.
  await protocol().send("Network.enable");
  await protocol().send("Network.setCacheDisabled", { cacheDisabled: true });
  await protocol().send("Network.clearBrowserCache");
  performance.clearResourceTimings();
  vi.spyOn(console, "error").mockImplementation((...args) => diagnostics.push(args));
  vi.spyOn(console, "warn").mockImplementation((...args) => diagnostics.push(args));
  vi.spyOn(globalThis, "fetch");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(async () => {
  await protocol().send("Network.setCacheDisabled", { cacheDisabled: false });
  await protocol().send("Network.disable");
  await protocol().send("Emulation.setEmulatedMedia", { features: [] });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  document.documentElement.classList.remove("light", "dark");
  expect(diagnostics).toEqual([]);
});

for (const composition of ["hero", "finale"] as const) {
  for (const theme of ["light", "dark"] as const) {
    test(`${composition}/${theme}: SSR без темы гидратируется без замены DOM и загружает только видимый постер на телефоне`, async () => {
      const definition = sculptureCompositions[composition];
      const ui = <SculptureScene composition={composition} />;
      expect(themeState.resolvedTheme).toBeUndefined();
      const serverMarkup = renderToString(ui);
      const container = document.createElement("div");
      container.innerHTML = serverMarkup;
      const parsedMarkup = container.innerHTML;

      const originalNodes = [...container.querySelectorAll("*")];
      const originalAttributes = originalNodes.map(attributes);
      const images = [...container.querySelectorAll<HTMLImageElement>("img")];
      expect(images).toHaveLength(2);
      for (const imageTheme of ["light", "dark"] as const) {
        const image = images.find((candidate) => candidate.dataset.sculptureTheme === imageTheme);
        expect(image).toBeDefined();
        expect(image!.getAttribute("src")).toBe(`/landing/${definition.asset}-${imageTheme}.webp`);
        expect(image!.getAttribute("loading")).toBe("lazy");
        expect(image!.getAttribute("width")).toBe(String(definition.width));
        expect(image!.getAttribute("height")).toBe(String(definition.height));
      }
      expect(container.querySelector("canvas")).toBeNull();
      expect(container.querySelector("[suppresshydrationwarning]")).toBeNull();

      // next-themes' inline bootstrap sets this class before hydration.
      // The server still knew neither resolvedTheme nor the user's preference.
      document.documentElement.classList.add(theme);
      themeState.resolvedTheme = theme;
      expect(renderToString(ui)).toBe(serverMarkup);

      const visible = images.find((image) => image.dataset.sculptureTheme === theme)!;
      const hidden = images.find((image) => image !== visible)!;
      const visibleUrl = new URL(visible.getAttribute("src")!, location.href).href;
      const hiddenUrl = new URL(hidden.getAttribute("src")!, location.href).href;
      const errors: unknown[] = [];
      let root: Root | undefined;
      document.body.append(container);
      try {
        // Correct CSS poster is selected even before React hydrates.
        expect(getComputedStyle(visible).display).not.toBe("none");
        expect(getComputedStyle(hidden).display).toBe("none");
        expect(getComputedStyle(visible).opacity).toBe("1");
        expect(visible.getBoundingClientRect().width).toBeGreaterThan(0);
        expect(visible.getBoundingClientRect().height).toBeGreaterThan(0);

        await act(async () => {
          root = hydrateRoot(container, ui, {
            onRecoverableError: (error) => errors.push(error),
            onCaughtError: (error) => errors.push(error),
            onUncaughtError: (error) => errors.push(error),
          });
        });
        // Each act flushes state queued by RAF and IntersectionObserver; finale's
        // first intersection also schedules a second eligibility effect.
        await act(async () => frames());
        await act(async () => frames());
        await act(async () => {
          await expect.poll(() => visible.complete && visible.naturalWidth > 0).toBe(true);
          await expect.poll(() => performance.getEntriesByName(visibleUrl, "resource").length).toBeGreaterThan(0);
          await frames();
        });

        expect(errors).toEqual([]);
        expect(diagnostics).toEqual([]);
        expect([...container.querySelectorAll("*")]).toHaveLength(originalNodes.length);
        for (const [index, node] of originalNodes.entries()) {
          expect(node.isConnected).toBe(true);
          expect(container.querySelectorAll("*")[index]).toBe(node);
          // React can leave mismatched attributes unpatched. Check every one,
          // in addition to both error channels and exact pre-hydration markup.
          expect(attributes(node)).toEqual(originalAttributes[index]);
        }
        expect(container.innerHTML).toBe(parsedMarkup);
        expect(getComputedStyle(visible).display).not.toBe("none");
        expect(getComputedStyle(visible).opacity).toBe("1");
        expect(getComputedStyle(hidden).display).toBe("none");
        expect(performance.getEntriesByName(hiddenUrl, "resource")).toEqual([]);
        expect(container.querySelector("canvas")).toBeNull();
        expect(vi.mocked(globalThis.fetch).mock.calls.filter(([input]) => /\.glb(?:[?#]|$)/.test(String(input)))).toEqual([]);
        expect(performance.getEntriesByType("resource").filter(({ name }) => /\.glb(?:[?#]|$)/.test(name))).toEqual([]);
        expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
      } finally {
        await act(async () => root?.unmount());
        container.remove();
      }
      expect(errors).toEqual([]);
      expect(diagnostics).toEqual([]);
    });
  }
}
