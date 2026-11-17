import { AudioLinesIcon, ClapperboardIcon, FilmIcon, WandSparklesIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";

/** Приглашение к работе, общее для новой сессии и пустой истории. */
export function StudioWelcome({
  title = "Ваш следующий ролик начинается здесь",
  description = "Расскажите идею. Агент соберёт сцены, добавит голос и подготовит видео — а вы сможете направлять работу по ходу.",
  compact = false,
}: {
  title?: string;
  description?: string;
  compact?: boolean;
}) {
  return (
    <Empty className={compact ? "items-start gap-4 border-0 p-0 text-left" : "gap-6 border-0 px-0 py-10 md:py-16"}>
      <EmptyHeader className={compact ? "max-w-xl items-start gap-3" : "max-w-xl gap-4"}>
        <EmptyMedia variant="icon" className="size-12 rounded-2xl bg-primary/10 text-foreground ring-1 ring-primary/15">
          <ClapperboardIcon />
        </EmptyMedia>
        <EmptyTitle className={compact ? "text-2xl leading-tight font-semibold tracking-tight md:text-3xl" : "text-3xl leading-tight font-semibold tracking-tight md:text-4xl"}>
          {title}
        </EmptyTitle>
        <EmptyDescription className="max-w-lg text-sm leading-7">
          {description}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent className={compact ? "max-w-none flex-row flex-wrap justify-start gap-2" : "max-w-none flex-row flex-wrap justify-center gap-2"}>
        <Badge variant="outline" className="gap-2 rounded-full bg-card px-3 py-1.5">
          <WandSparklesIcon data-icon="inline-start" />
          Идея и сценарий
        </Badge>
        <Badge variant="outline" className="gap-2 rounded-full bg-card px-3 py-1.5">
          <FilmIcon data-icon="inline-start" />
          Сцены и монтаж
        </Badge>
        <Badge variant="outline" className="gap-2 rounded-full bg-card px-3 py-1.5">
          <AudioLinesIcon data-icon="inline-start" />
          Голос и музыка
        </Badge>
      </EmptyContent>
    </Empty>
  );
}
