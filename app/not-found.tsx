import { ArrowLeftIcon } from "lucide-react";

import { PageState } from "@/components/studio/page-state";
import { PublicShell } from "@/components/studio/public-shell";
import { ButtonLink } from "@/components/studio/button-link";

export default function NotFound() {
  return (
    <PublicShell>
      <PageState
        kind="missing"
        title="Страница не найдена"
        description="Возможно, адрес изменился или в ссылке есть опечатка. Вернитесь на главную или продолжите работу в студии."
      >
        <ButtonLink size="lg" href="/">
          <ArrowLeftIcon data-icon="inline-start" />
          На главную
        </ButtonLink>
        <ButtonLink size="lg" variant="outline" href="/s">
          Открыть студию
        </ButtonLink>
      </PageState>
    </PublicShell>
  );
}
