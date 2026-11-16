"use client";

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export interface MagicBentoItem {
  id?: string | number;
  title: string;
  description: string;
  icon?: ReactNode;
}

export interface MagicBentoProps {
  items: readonly MagicBentoItem[];
  columns?: number;
  gap?: number;
  theme?: "dark" | "light";
  textAutoHide?: boolean;
  disableAnimations?: boolean;
  className?: string;
}

/**
 * React Bits MagicBento, adapted to the studio's Card primitives and tokens.
 * Keep its container-based layout and pointer spotlight; omit demo artwork,
 * fixed palettes, stars, tilt and click waves on non-interactive feature cards.
 */
export default function MagicBento({
  items,
  columns = 4,
  gap = 16,
  theme = "light",
  textAutoHide = false,
  disableAnimations = false,
  className,
}: MagicBentoProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [cols, setCols] = useState<number | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const observer = new ResizeObserver(() => {
      const cell = (count: number) => (root.clientWidth - gap * (count - 1)) / count;
      setCols(cell(columns) >= 220 ? columns : cell(2) >= 220 ? 2 : 1);
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, [columns, gap]);

  return (
    <div
      ref={rootRef}
      data-theme={theme}
      className={cn("magic-bento grid min-w-0 w-full grid-cols-1 md:grid-cols-2 xl:grid-cols-4", className)}
      style={{
        gridTemplateColumns: cols === null ? undefined : `repeat(${cols}, minmax(0, 1fr))`,
        gap,
      }}
    >
      {items.map((item, index) => (
        <Card
          key={item.id ?? item.title}
          className={cn(
            "group/bento relative min-w-0 overflow-hidden",
            index % 3 === 0 && "bg-muted/40",
          )}
          onPointerMove={(event) => {
            if (disableAnimations || event.pointerType !== "mouse") return;
            const rect = event.currentTarget.getBoundingClientRect();
            event.currentTarget.style.setProperty("--mb-x", `${event.clientX - rect.left}px`);
            event.currentTarget.style.setProperty("--mb-y", `${event.clientY - rect.top}px`);
          }}
        >
          {!disableAnimations && (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 opacity-0 transition-opacity group-hover/bento:opacity-100 motion-reduce:hidden"
              style={{
                background:
                  "radial-gradient(240px circle at var(--mb-x, 50%) var(--mb-y, 50%), color-mix(in oklab, var(--primary) 7%, transparent), transparent 75%)",
              } as CSSProperties}
            />
          )}
          <CardHeader className="relative gap-5">
            {item.icon && <span aria-hidden="true" className="text-primary [&>svg]:size-6">{item.icon}</span>}
            <CardTitle>
              <h3 className={cn(textAutoHide && "line-clamp-1")}>{item.title}</h3>
            </CardTitle>
          </CardHeader>
          <CardContent className="relative">
            <CardDescription className={cn("leading-relaxed", textAutoHide && "line-clamp-2")}>
              {item.description}
            </CardDescription>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
