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
      <div className="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-8 md:flex-row md:items-center md:justify-between md:px-8">
        <span className="font-heading text-sm font-medium">{logo ?? brandName}</span>
        {copyright && <p className="text-muted-foreground text-sm">{copyright}</p>}
      </div>
    </footer>
  );
}
