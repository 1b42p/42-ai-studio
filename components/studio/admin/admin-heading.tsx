"use client";

import type { ReactNode } from "react";
import { CardAction, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/** Общая иерархия рабочих разделов без привязки к запросам и маршрутизатору. */
export function AdminHeading({ title, description, actions }: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <CardHeader className="gap-3 rounded-none px-0 has-data-[slot=card-action]:grid-cols-1 sm:has-data-[slot=card-action]:grid-cols-[1fr_auto]">
      <CardTitle
        role="heading"
        aria-level={2}
        className="text-2xl font-semibold tracking-tight md:text-3xl"
      >
        {title}
      </CardTitle>
      {description ? (
        <CardDescription className="max-w-3xl text-pretty">
          {description}
        </CardDescription>
      ) : null}
      {actions ? (
        <CardAction className="col-start-1 row-span-1 row-start-3 flex flex-wrap gap-2 justify-self-start sm:col-start-2 sm:row-span-2 sm:row-start-1 sm:justify-self-end">
          {actions}
        </CardAction>
      ) : null}
    </CardHeader>
  );
}
