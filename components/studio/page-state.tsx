import type { ReactNode } from "react";
import { ClapperboardIcon, FilmIcon, UnplugIcon } from "lucide-react";

import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";

const stateIcons = {
  missing: FilmIcon,
  session: ClapperboardIcon,
  error: UnplugIcon,
};

export function PageState({
  kind,
  title,
  description,
  children,
}: {
  kind: keyof typeof stateIcons;
  title: string;
  description: string;
  children: ReactNode;
}) {
  const Icon = stateIcons[kind];

  return (
    <Empty className="mx-auto w-full max-w-2xl flex-1 justify-center gap-8 border-0 px-4 py-16 md:py-24">
      <EmptyHeader className="max-w-lg gap-5">
        <EmptyMedia
          variant="default"
          className="size-20 rounded-3xl bg-primary/10 text-primary ring-1 ring-primary/15 [&_svg]:size-9"
        >
          <Icon aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle>
          <h1 className="text-3xl leading-tight font-semibold tracking-tight text-balance md:text-4xl">
            {title}
          </h1>
        </EmptyTitle>
        <EmptyDescription className="text-base leading-relaxed text-pretty">
          {description}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent className="w-full flex-row flex-wrap justify-center gap-3">
        {children}
      </EmptyContent>
    </Empty>
  );
}
