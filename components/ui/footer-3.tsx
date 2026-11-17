import type { ReactNode } from "react";

import { Separator } from "@/components/ui/separator";

export interface Footer3Props {
  logo?: ReactNode;
  brandName?: string;
  copyright?: string;
}

/** Watermelon footer-3 reduced to the studio's brand and copyright. */
export function Footer3({ logo, brandName, copyright }: Footer3Props) {
  return (
    <footer className="w-full">
      <Separator />
      <div className="mx-auto flex max-w-7xl flex-col gap-6 px-5 py-10 md:flex-row md:items-end md:justify-between md:px-8 md:py-12">
        <span className="font-heading text-3xl font-semibold tracking-tighter md:text-5xl">{logo ?? brandName}</span>
        {copyright && <p className="text-muted-foreground text-xs md:pb-1">{copyright}</p>}
      </div>
    </footer>
  );
}
