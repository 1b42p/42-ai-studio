import type { ComponentType } from "react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export interface Feature4Item {
  title: string;
  description: string;
  icon: ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" | "false" }>;
}

/** Watermelon feature-4's token-based card grid, also the server fallback. */
export default function Features4({ items }: { items: readonly Feature4Item[] }) {
  return (
    <div className="grid min-w-0 w-full grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
      {items.map(({ title, description, icon: Icon }) => (
        <Card key={title} className="min-w-0">
          <CardHeader>
            <Icon aria-hidden="true" />
            <CardTitle><h3>{title}</h3></CardTitle>
          </CardHeader>
          <CardContent>
            <CardDescription>{description}</CardDescription>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
