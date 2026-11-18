import type { ReactNode } from "react";

export interface CTAProps {
  title: string;
  description: string;
  action: ReactNode;
  visual: ReactNode;
}

export function Cta1({ title, description, action, visual }: CTAProps) {
  return (
    <section
      aria-labelledby="try-title"
      className="relative isolate w-full overflow-hidden bg-primary text-primary-foreground"
    >
      <div className="relative mx-auto grid max-w-7xl gap-2 px-5 pt-14 pb-4 md:px-8 md:pt-20 md:pb-10 lg:grid-cols-[1.05fr_1fr] lg:items-center lg:gap-0 lg:py-16">
        <div className="relative z-10 flex flex-col items-start gap-8 lg:py-6">
          <h2
            id="try-title"
            className="max-w-3xl font-heading text-[clamp(2.75rem,5.5vw,5.5rem)] leading-[0.98] font-semibold tracking-[-0.065em] text-balance"
          >
            {title}
          </h2>
          <p className="max-w-sm text-base leading-relaxed md:max-w-md md:text-lg">
            {description}
          </p>
          <div className="mt-1 flex max-w-full items-center">{action}</div>
        </div>
        <div className="pointer-events-none relative mx-auto w-full max-w-xl lg:-my-12 lg:-mr-8 lg:max-w-none lg:w-[calc(100%+3rem)]">
          {visual}
        </div>
      </div>
    </section>
  );
}
