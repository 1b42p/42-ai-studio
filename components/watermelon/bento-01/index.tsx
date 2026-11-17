"use client";

import type { ComponentType, ReactNode } from "react";

import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export interface Bento1Item {
  title: string;
  description: string;
  icon: ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" | "false" }>;
  visual?: ReactNode;
  layout?: "hero" | "half" | "quarter" | "small" | "wide";
  tone?: "default" | "soft" | "brand";
}

export default function Bento1({
  items,
  className,
}: {
  items: readonly Bento1Item[];
  className?: string;
}) {
  return (
    <div data-slot="studio-bento" className={cn("grid min-w-0 w-full grid-cols-1 gap-5 md:grid-cols-12", className)}>
      {items.map(({ title, description, icon: Icon, visual, layout = "small", tone = "default" }) => (
        <Card
          key={title}
          variant={tone}
          className={cn(
            "group/bento relative min-w-0 gap-6 rounded-2xl [--card-spacing:--spacing(6)] motion-safe:transition-[transform,box-shadow] motion-safe:duration-300 motion-safe:hover:-translate-y-1",
            layout === "hero" && "md:col-span-7 md:row-span-2",
            layout === "half" && "md:col-span-6",
            layout === "quarter" && "md:col-span-3",
            layout === "small" && "md:col-span-5",
            layout === "wide" && "md:col-span-7",
          )}
        >
          <CardHeader className="gap-4">
            <Icon aria-hidden="true" className={cn("size-6", tone === "brand" ? "text-primary-foreground" : "text-foreground")} />
            <CardTitle className="text-xl leading-tight font-semibold tracking-tight md:text-2xl">
              <h3>{title}</h3>
            </CardTitle>
          </CardHeader>
          {visual && <CardContent className="flex min-h-24 flex-1 items-center overflow-hidden">{visual}</CardContent>}
          <CardFooter className="border-0 bg-transparent pt-0">
            <CardDescription className="max-w-xl text-sm leading-relaxed">
              {description}
            </CardDescription>
          </CardFooter>
        </Card>
      ))}
    </div>
  );
}
