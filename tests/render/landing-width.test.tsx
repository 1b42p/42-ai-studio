import { afterEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";

import { LandingPage } from "@/components/studio/landing/landing-page";

import { landingExamples } from "./fixtures/landing";
import { expectNoHorizontalScroll, renderAtSize } from "./support/render";

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

for (const theme of ["light", "dark"] as const) {
  test(`главная/${theme}: все элементы шапки помещаются при 768 px до и после входа`, async () => {
    localStorage.setItem("theme", theme);
    const pending = Promise.withResolvers<Response>();
    const fetch = globalThis.fetch.bind(globalThis);
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) =>
      input === "/api/auth/me" ? pending.promise : fetch(input, init),
    );
    await renderAtSize(<LandingPage examples={landingExamples} />, { width: 768, height: 800 });
    await document.fonts.ready;

    function expectHeaderFits() {
      const header = page.getByRole("banner").element();
      const inner = header.firstElementChild as HTMLElement;
      const [brand, navigation, actions] = [...inner.children];
      const bounds = [brand!, navigation!, actions!].map((node) => node.getBoundingClientRect());
      const diagnostic = JSON.stringify(bounds.map(({ left, right, width }) => ({ left, right, width })));
      expect(bounds[0]!.left, diagnostic).toBeGreaterThanOrEqual(0);
      expect(bounds[0]!.right, diagnostic).toBeLessThanOrEqual(bounds[1]!.left);
      expect(bounds[1]!.right, diagnostic).toBeLessThanOrEqual(bounds[2]!.left);
      expect(bounds[2]!.right, diagnostic).toBeLessThanOrEqual(window.innerWidth);

      for (const link of navigation!.querySelectorAll("a")) {
        const rect = link.getBoundingClientRect();
        expect(rect.left, diagnostic).toBeGreaterThanOrEqual(bounds[1]!.left);
        expect(rect.right, diagnostic).toBeLessThanOrEqual(bounds[1]!.right);
        expect(rect.top, diagnostic).toBeGreaterThanOrEqual(header.getBoundingClientRect().top);
        expect(rect.bottom, diagnostic).toBeLessThanOrEqual(header.getBoundingClientRect().bottom);
        expect(link.scrollWidth, diagnostic).toBeLessThanOrEqual(link.clientWidth + 1);
      }
      expectNoHorizontalScroll();
    }

    for (const name of ["Примеры", "Как это работает", "Возможности"]) {
      await expect.element(page.getByRole("banner").getByRole("link", { name, exact: true })).toBeVisible();
    }
    expectHeaderFits();
    pending.resolve(Response.json({ id: "visitor" }));
    await expect.element(page.getByRole("banner").getByRole("link", { name: "Открыть студию" })).toBeVisible();
    expectHeaderFits();
  });
}
