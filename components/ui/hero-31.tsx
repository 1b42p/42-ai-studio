"use client";

import type { ReactNode } from "react";
import * as motion from "motion/react-m";
import { useReducedMotionPreference } from "@/hooks/use-reduced-motion";
import { MotionSurface } from "@/components/studio/motion-surface";

interface Hero31Props {
  badge: ReactNode;
  title: string;
  subtitle: string;
  actions: ReactNode;
  note: string;
  visual: ReactNode;
}

export default function Hero31({
  badge,
  title,
  subtitle,
  actions,
  note,
  visual,
}: Hero31Props) {
  const reduced = useReducedMotionPreference();
  const titleWords = title.split(" ");

  return (
    <MotionSurface>
    <section data-slot="cinema-hero" className="relative isolate w-full overflow-hidden bg-background">
      <div className="absolute inset-0 -z-10">{visual}</div>
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 bg-linear-to-b from-background/95 via-background/95 via-55% to-background/0 md:bg-linear-to-r md:from-background md:via-background/50 md:via-50% md:to-background/0" />
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 -z-10 h-20 bg-linear-to-t from-background to-background/0" />
      <div className="pointer-events-none mx-auto flex min-h-[740px] w-full max-w-7xl flex-col items-start px-5 pt-9 pb-12 md:min-h-[min(850px,calc(100svh-80px))] md:px-8 md:pt-14 md:pb-16 [&>*]:pointer-events-auto">
        {badge}
        <h1 className="mt-7 max-w-6xl font-heading text-[clamp(2.5rem,5.15vw,5.25rem)] leading-[1.03] font-semibold tracking-[-0.055em] text-balance md:mt-9">
          {titleWords.map((word, index) => (
            <span key={`${word}-${index}`}>
              <motion.span
                className="inline-block"
                initial={false}
                animate={reduced ? { y: 0, rotateX: 0 } : { y: [18, 0], rotateX: [8, 0] }}
                transition={{ duration: reduced ? 0 : 0.75, delay: reduced ? 0 : index * 0.045, ease: [0.22, 1, 0.36, 1] }}
              >
                {word}
              </motion.span>
              {index < titleWords.length - 1 ? " " : null}
            </span>
          ))}
        </h1>
        <motion.div
          className="mt-7 flex max-w-[29rem] flex-col items-start gap-6 md:mt-9 md:gap-7"
          initial={false}
          animate={reduced ? { y: 0 } : { y: [14, 0] }}
          transition={{ duration: reduced ? 0 : 0.8, delay: reduced ? 0 : 0.2, ease: [0.22, 1, 0.36, 1] }}
        >
          <p className="text-base leading-relaxed text-foreground/80 text-pretty md:text-lg">{subtitle}</p>
          <div className="flex flex-wrap items-center gap-3">{actions}</div>
          <p className="max-w-xs rounded-md bg-background/85 px-2 py-1 text-xs leading-relaxed text-muted-foreground md:bg-transparent md:px-0 md:py-0">{note}</p>
        </motion.div>
      </div>
    </section>
    </MotionSurface>
  );
}
