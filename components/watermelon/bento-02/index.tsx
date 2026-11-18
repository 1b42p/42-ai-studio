"use client";

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { MotionConfig, useInView } from "motion/react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { useReducedMotionPreference } from "@/hooks/use-reduced-motion";
import { MotionSurface } from "@/components/studio/motion-surface";

const Activity = createContext({ active: false, visible: false, reduced: true });
const PageVisibility = createContext(true);
const MotionPreference = createContext(true);

export function useBentoActivity() {
  return useContext(Activity);
}

/**
 * Adapted from Watermelon's Bento 02: asymmetric, content-led cells and
 * interaction-driven motion. Each cell owns its scene rather than flattening
 * very different demonstrations into a title/icon array.
 */
export default function Bento2({ children, className }: { children?: ReactNode; className?: string }) {
  const [pageVisible, setPageVisible] = useState(true);
  const reduced = useReducedMotionPreference();

  useEffect(() => {
    const update = () => setPageVisible(!document.hidden);
    update();
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  return (
    <MotionSurface>
    <MotionConfig reducedMotion="never">
      <MotionPreference.Provider value={reduced}>
        <PageVisibility.Provider value={pageVisible}>
          <div data-slot="studio-bento" className={cn("grid min-w-0 grid-cols-1 gap-4 md:grid-cols-12 lg:gap-5", className)}>
            {children}
          </div>
        </PageVisibility.Provider>
      </MotionPreference.Provider>
    </MotionConfig>
    </MotionSurface>
  );
}

export function Bento2Card({
  title,
  description,
  children,
  className,
  reverse = false,
}: {
  title: string;
  description: string;
  children: ReactNode;
  className?: string;
  reverse?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { amount: 0.15 });
  const reduced = useContext(MotionPreference);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const pageVisible = useContext(PageVisibility);

  const visible = inView && pageVisible;
  return (
    <Activity.Provider value={{ active: visible && (hovered || focused) && !reduced, visible, reduced: !!reduced }}>
      <Card
        ref={ref}
        data-capability={title}
        className={cn("relative min-w-0", className)}
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
        onFocusCapture={() => setFocused(true)}
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
        }}
      >
        <CardContent className={cn("relative min-w-0 flex-1", reverse && "order-2")}>
          {children}
        </CardContent>
        <CardHeader className={cn("relative", reverse && "order-1")}>
          <CardTitle><h3>{title}</h3></CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
      </Card>
    </Activity.Provider>
  );
}
