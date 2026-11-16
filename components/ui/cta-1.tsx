import type { ReactNode } from "react";

export interface CTAProps {
  title: string;
  description: string;
  action: ReactNode;
}

/** Watermelon cta-1 with the shared auth action and semantic theme tokens. */
export function Cta1({ title, description, action }: CTAProps) {
  return (
    <section aria-labelledby="try-title" className="w-full py-16 md:py-24">
      <div className="mx-auto flex max-w-7xl flex-col items-start justify-between gap-8 px-4 md:flex-row md:items-center md:gap-12 md:px-8">
        <div className="flex max-w-2xl flex-col gap-4">
          <h2 id="try-title" className="font-heading text-3xl font-semibold tracking-tight md:text-4xl">{title}</h2>
          <p className="text-muted-foreground text-base leading-relaxed">{description}</p>
        </div>
        {action}
      </div>
    </section>
  );
}
