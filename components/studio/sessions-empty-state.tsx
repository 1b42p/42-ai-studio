import { MessagesSquareIcon } from "lucide-react";

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
    <Empty className="flex-1 border border-dashed">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <MessagesSquareIcon />
        </EmptyMedia>
        <EmptyTitle>Сессий пока нет</EmptyTitle>
        <EmptyDescription>
          Опишите ролик в поле выше, и сессия появится здесь
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
