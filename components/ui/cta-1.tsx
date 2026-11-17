import type { ReactNode } from "react";

export interface CTAProps {
  title: string;
  description: string;
  action: ReactNode;
}

/** Watermelon cta-1 with a split film-gate illustration and shared auth action. */
export function Cta1({ title, description, action }: CTAProps) {
  return (
    <section
      aria-labelledby="try-title"
      className="relative isolate w-full overflow-hidden bg-primary text-primary-foreground"
    >
      <div className="relative mx-auto grid max-w-7xl gap-10 px-5 pt-14 pb-0 md:px-8 md:pt-20 lg:grid-cols-[1.65fr_1fr] lg:items-center lg:gap-4 lg:py-24">
        <div className="relative z-10 flex flex-col items-start gap-8 pb-0 lg:pb-2">
          <h2
            id="try-title"
            className="max-w-3xl font-heading text-[clamp(2.75rem,6.8vw,6rem)] leading-[0.98] font-semibold tracking-[-0.065em] text-balance"
          >
            {title}
          </h2>
          <p className="max-w-sm text-base leading-relaxed md:max-w-md md:text-lg">
            {description}
          </p>
          <div className="mt-1 flex max-w-full items-center">{action}</div>
        </div>
        <svg
          aria-hidden="true"
          focusable="false"
          viewBox="0 0 520 440"
          fill="none"
          className="pointer-events-none -mt-5 -mr-14 h-auto w-[min(100%,22rem)] justify-self-end text-background md:-mr-16 md:w-96 lg:-my-10 lg:-mr-20 lg:w-[calc(100%+5rem)]"
        >
          {/* One widescreen gate, separated along a diagonal editing splice. */}
          <path
            d="M60 66H466V151L408 203V124H118V294L60 346Z"
            fill="currentColor"
          />
          <path
            d="M54 382V339L112 287V324H402V157L460 105V382Z"
            fill="currentColor"
          />
          <g className="text-primary-foreground" stroke="currentColor">
            <path d="M36 42H490V154M490 244V406H36V384" strokeOpacity=".35" />
            <path d="M138 145H380V221M380 269V303H138V260" strokeOpacity=".5" />
            <path d="M10 408L510 20" strokeOpacity=".75" />
            <path d="M10 421L510 33" strokeOpacity=".3" />
          </g>
        </svg>
      </div>
    </section>
  );
}
