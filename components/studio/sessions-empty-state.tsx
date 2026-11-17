import { ClapperboardIcon } from "lucide-react";

import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";

/** Пустой список на странице нового чата. */
export function SessionsEmptyState() {
  return (
    <Empty className="min-h-64 flex-1 rounded-2xl border border-dashed border-primary/25 bg-primary/4 md:min-h-72">
      <EmptyHeader>
        <EmptyMedia variant="icon" className="mb-3 size-14 rounded-2xl bg-primary/10 text-foreground [&_svg]:size-6">
          <ClapperboardIcon />
        </EmptyMedia>
        <EmptyTitle>Сессий пока нет</EmptyTitle>
        <EmptyDescription>
          Опишите ролик в поле выше, и сессия появится здесь
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
