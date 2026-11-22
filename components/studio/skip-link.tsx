import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function SkipLink() {
  return (
    <a
      href="#studio-content"
      className={cn(
        buttonVariants({ variant: "default", size: "lg" }),
        "sr-only fixed top-3 left-3 z-50 focus:not-sr-only focus:absolute focus:px-4",
      )}
    >
      Перейти к содержимому
    </a>
  );
}
