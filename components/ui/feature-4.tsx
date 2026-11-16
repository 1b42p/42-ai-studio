import type { ComponentType } from "react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export interface Feature4Item {
  title: string;
  description: string;
  icon: ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" | "false" }>;
}

/** Watermelon feature-4's token-based card grid, also the server fallback. */
export default function Features4({ items }: { items: readonly Feature4Item[] }) {
  return (
    <div className="grid min-w-0 w-full grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
      {items.map(({ title, description, icon: Icon }, index) => (
        <Card key={title} className={cn("min-w-0", index % 3 === 0 && "bg-muted/40")}>
          <CardHeader className="gap-5">
            <Icon className="size-6 text-primary" aria-hidden="true" />
            <CardTitle><h3>{title}</h3></CardTitle>
          </CardHeader>
          <CardContent>
            <CardDescription className="leading-relaxed">{description}</CardDescription>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
