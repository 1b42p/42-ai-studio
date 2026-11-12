import type { BrowserCommand } from "vitest/node";

import { previewMedia } from "./session-previews";

type Action = "setup" | "release" | "requests" | "reset";

interface PreviewRequests {
  readonly requests: string[];
  readonly ready: Promise<void>;
  readonly release: () => void;
}

const states = new WeakMap<object, PreviewRequests>();
const pattern = "**/api/media/00000018-**";

// Контрастные границы на всех четырёх краях позволяют заметить обрезку кадра.
function image(width: number, height: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <rect width="${width}" height="${height}" fill="#172b4d"/>
    <rect x="4" y="4" width="${width - 8}" height="${height - 8}" fill="none" stroke="#f5c542" stroke-width="8"/>
    <circle cx="${width / 2}" cy="${height / 2}" r="${Math.min(width, height) / 4}" fill="#69d3b2"/>
  </svg>`;
}

/** Реальные запросы img, управляемые на сетевой границе Playwright. */
export const sessionPreviewMedia: BrowserCommand<[Action, { pending?: boolean }?]> = async (
  context,
  action,
  options,
) => {
  if (context.provider.name !== "playwright") {
    throw new Error("Превью проверяются в настоящем Chromium через Playwright");
  }

  const previous = states.get(context.page);
  if (action === "requests") return previous?.requests ?? [];
  if (action === "release") {
    previous?.release();
    return previous?.requests ?? [];
  }

  previous?.release();
  await context.page.unroute(pattern);
  states.delete(context.page);
  if (action === "reset") return [];

  let release = () => {};
  const ready = new Promise<void>((resolve) => { release = resolve; });
  const state: PreviewRequests = { requests: [], ready, release };
  states.set(context.page, state);
  if (!options?.pending) release();

  await context.page.route(pattern, async (route) => {
    const url = new URL(route.request().url());
    state.requests.push(`${url.pathname}${url.search}`);
    await state.ready;
    const mediaId = url.pathname.split("/").at(-1);
    const unavailable = mediaId === previewMedia.missing ||
      (mediaId === previewMedia.retry && !url.searchParams.has("retry"));
    await route.fulfill(unavailable
      ? { status: 404, contentType: "text/plain", body: "not found" }
      : {
          status: 200,
          contentType: "image/svg+xml",
          body: mediaId === previewMedia.portrait ? image(180, 320) : image(320, 180),
        });
  });
  return [];
};

declare module "vitest/browser" {
  interface BrowserCommands {
    sessionPreviewMedia: (action: Action, options?: { pending?: boolean }) => Promise<string[]>;
  }
}
