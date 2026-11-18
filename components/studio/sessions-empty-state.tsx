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
    <Empty className="min-h-64 md:min-h-72">
      <EmptyHeader>
        <EmptyMedia variant="icon">
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
