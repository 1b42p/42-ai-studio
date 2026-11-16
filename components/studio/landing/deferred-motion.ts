"use client";

import { startTransition, useEffect, useState } from "react";

/** Optional decoration starts after page load and never competes with hydration. */
export function useDeferredMotion<T>(
  load: () => Promise<{ default: T }>,
  enabled: boolean,
): T | null {
  const [component, setComponent] = useState<T | null>(null);

  useEffect(() => {
    if (!enabled || component) return;
    let disposed = false;
    let idle: number | undefined;
    let timer: number | undefined;

    const begin = () => {
      if (disposed || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      void load().then(
        (module) => {
          if (disposed) return;
          startTransition(() => setComponent(() => module.default));
        },
        () => {
          // The static content is the complete UI; failed decoration stays static.
        },
      );
    };
    const schedule = () => {
      if (typeof window.requestIdleCallback === "function") {
        idle = window.requestIdleCallback(begin);
      } else {
        timer = window.setTimeout(begin, 0);
      }
    };

    if (document.readyState === "complete") schedule();
    else window.addEventListener("load", schedule, { once: true });

    return () => {
      disposed = true;
      window.removeEventListener("load", schedule);
      if (idle !== undefined) window.cancelIdleCallback(idle);
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [enabled, component, load]);

  return enabled ? component : null;
}
