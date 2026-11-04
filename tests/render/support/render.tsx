import type { ReactElement } from "react";
import { expect } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { ThemeProvider } from "@/components/studio/theme-provider";

import { viewports } from "./viewports";

/** Отрисовывает интерфейс в окне заданного размера. */
export async function renderAtSize(
  ui: ReactElement,
  size: { width: number; height: number },
) {
  await page.viewport(size.width, size.height);

  return render(<ThemeProvider>{ui}</ThemeProvider>);
}

async function renderAt(
  viewport: (typeof viewports)[keyof typeof viewports],
  ui: ReactElement,
) {
  return renderAtSize(ui, viewport);
}

/** Отрисовывает интерфейс в окне телефона (390×844). */
export function renderOnPhone(ui: ReactElement) {
  return renderAt(viewports.phone, ui);
}

/** Отрисовывает интерфейс в окне компьютера (1280×800). */
export function renderOnDesktop(ui: ReactElement) {
  return renderAt(viewports.desktop, ui);
}

/** Ширина содержимого страницы не выходит за ширину окна. */
export function expectNoHorizontalScroll() {
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
}
