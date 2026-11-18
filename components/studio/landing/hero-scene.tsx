import { cn } from "@/lib/utils";

import { SculptureScene } from "./sculpture-scene";

export function HeroScene({ className }: { className?: string }) {
  return <SculptureScene composition="hero" className={cn("size-full", className)} />;
}
