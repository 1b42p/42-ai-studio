import { FileQuestionIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";

/** 404 беседы: сессии нет или она чужая. */
export default function SessionNotFound() {
  return (
    <Empty className="flex-1 border border-dashed">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <FileQuestionIcon />
        </EmptyMedia>
        <EmptyTitle>Сессия не найдена</EmptyTitle>
        <EmptyDescription>Возможно, ссылка устарела или сессия вам не принадлежит.</EmptyDescription>
      </EmptyHeader>
      <Button nativeButton={false} variant="outline" render={<a href="/s" />}>
        Новая сессия
      </Button>
    </Empty>
  );
}
