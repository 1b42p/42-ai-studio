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
    <Empty className="mx-auto max-w-2xl">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle>
          <h1>{title}</h1>
        </EmptyTitle>
        <EmptyDescription>
          {description}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent className="flex-row flex-wrap justify-center">
        {children}
      </EmptyContent>
    </Empty>
  );
}
