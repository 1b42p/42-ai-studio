import type { ReactNode } from "react";
import { ArrowUpRight } from "lucide-react";

export interface CTAProps {
  title: string;
  description: string;
  action: ReactNode;
}

/** Watermelon cta-1 with the shared auth action and semantic theme tokens. */
export function Cta1({ title, description, action }: CTAProps) {
  return (
    <section aria-labelledby="try-title" className="relative isolate w-full overflow-hidden bg-primary text-primary-foreground">
      <div className="relative mx-auto grid max-w-7xl gap-8 px-5 py-16 md:grid-cols-[1fr_auto] md:items-center md:gap-12 md:px-8 md:py-24">
        <div className="relative z-10 flex max-w-3xl flex-col items-start gap-7">
          <h2 id="try-title" className="font-heading text-4xl leading-[1.02] font-semibold tracking-tighter md:text-6xl">{title}</h2>
          <p className="max-w-lg text-base leading-relaxed text-primary-foreground md:text-lg">{description}</p>
          {action}
        </div>
        <ArrowUpRight aria-hidden="true" className="pointer-events-none absolute -right-12 -bottom-10 size-64 stroke-[0.7] text-primary-foreground/15 md:relative md:right-auto md:bottom-auto md:size-80 md:text-primary-foreground/85" />
      </div>
    </section>
  );
}
