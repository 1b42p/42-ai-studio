import { cn } from "@/lib/utils";

export function Brand({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex min-w-0 items-baseline gap-1.5 whitespace-nowrap font-heading text-base font-semibold tracking-tight", className)}>
      <span className="text-foreground">42</span> AI Studio
    </span>
  );
}
