import { ArrowLeftIcon } from "lucide-react";
import { PageState } from "@/components/studio/page-state";
import { ButtonLink } from "@/components/studio/button-link";

/** 404 беседы: сессии нет или она чужая. */
export default function SessionNotFound() {
  return (
    <PageState
      kind="session"
      title="Сессия не найдена"
      description="Возможно, ссылка устарела или сессия недоступна. Откройте медиатеку, чтобы продолжить работу."
    >
      <ButtonLink size="lg" href="/s">
        <ArrowLeftIcon data-icon="inline-start" />
        К сессиям
      </ButtonLink>
    </PageState>
  );
}
