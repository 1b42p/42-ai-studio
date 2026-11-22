import { ArrowLeftIcon } from "lucide-react";
import { PageState } from "@/components/studio/page-state";
import { ButtonLink } from "@/components/studio/button-link";

/** 404 раздела приложения: скрытая страница не раскрывает своего существования. */
export default function AppNotFound() {
  return (
    <PageState
      kind="missing"
      title="Страница не найдена"
      description="Возможно, ссылка устарела или страница недоступна."
    >
      <ButtonLink size="lg" href="/s">
        <ArrowLeftIcon data-icon="inline-start" />
        К сессиям
      </ButtonLink>
    </PageState>
  );
}
