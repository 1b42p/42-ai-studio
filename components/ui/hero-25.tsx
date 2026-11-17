"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface Hero25Props {
  badge: ReactNode;
  title: ReactNode;
  description: string;
  actions: ReactNode;
  note: string;
  visual: ReactNode;
  className?: string;
}

export default function Hero25({
  badge,
  title,
  description,
  actions,
  note,
  visual,
  className,
}: Hero25Props) {
  return (
    <section className={cn("relative isolate w-full overflow-hidden bg-background", className)}>
      <div className="mx-auto grid w-full max-w-7xl items-center gap-2 px-5 pt-8 pb-12 md:grid-cols-[1.1fr_1fr] md:gap-0 md:px-8 md:pt-12 md:pb-16 xl:min-h-[660px]">
        <div className="relative z-10 flex min-w-0 flex-col items-start gap-6 md:gap-7">
          {badge}
          <h1 className="font-heading max-w-3xl text-[clamp(2.5rem,4vw,4rem)] leading-[1.05] font-semibold tracking-tighter text-balance">
            {title}
          </h1>
          <p className="text-muted-foreground max-w-lg text-base leading-relaxed text-pretty md:text-lg">
            {description}
          </p>
          <div className="flex flex-wrap items-center gap-3">{actions}</div>
          <p className="text-muted-foreground text-xs leading-relaxed">{note}</p>
        </div>
        <div className="relative -mx-5 -mt-3 min-w-0 rounded-full bg-radial from-primary/10 via-primary/3 to-transparent md:-mr-12 md:-ml-8 md:mt-0 xl:-mr-20">
          {visual}
        </div>
      </div>
    </section>
  );
}
