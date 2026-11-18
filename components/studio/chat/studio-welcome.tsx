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
    <Empty className={compact ? "items-start text-left" : undefined}>
      <EmptyHeader className={compact ? "max-w-xl items-start" : "max-w-xl"}>
        <EmptyMedia variant="icon">
          <ClapperboardIcon />
        </EmptyMedia>
        <EmptyTitle>
          {title}
        </EmptyTitle>
        <EmptyDescription className="max-w-lg">
          {description}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent className={compact ? "max-w-none flex-row flex-wrap justify-start gap-2" : "max-w-none flex-row flex-wrap justify-center gap-2"}>
        <Badge variant="outline">
          <WandSparklesIcon data-icon="inline-start" />
          Идея и сценарий
        </Badge>
        <Badge variant="outline">
          <FilmIcon data-icon="inline-start" />
          Сцены и монтаж
        </Badge>
        <Badge variant="outline">
          <AudioLinesIcon data-icon="inline-start" />
          Голос и музыка
        </Badge>
      </EmptyContent>
    </Empty>
  );
}
