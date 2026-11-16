import { FileQuestionIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";

/** 404 раздела приложения: скрытая страница не раскрывает своего существования. */
export default function AppNotFound() {
  return (
    <Empty className="flex-1 border border-dashed">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <FileQuestionIcon />
        </EmptyMedia>
        <EmptyTitle>Страница не найдена</EmptyTitle>
        <EmptyDescription>Возможно, ссылка устарела или страница недоступна.</EmptyDescription>
      </EmptyHeader>
      <Button nativeButton={false} variant="outline" render={<a href="/s" />}>
        К сессиям
      </Button>
    </Empty>
  );
}
