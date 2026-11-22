"use client";

import { ArrowLeftIcon, RefreshCwIcon } from "lucide-react";
import { useTransition } from "react";

import { PageState } from "@/components/studio/page-state";
import { ButtonLink } from "@/components/studio/button-link";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

export function PageError({ retry, inApp = false }: { retry: () => void; inApp?: boolean }) {
  const [pending, startTransition] = useTransition();

  return (
    <PageState
      kind="error"
      title="Не удалось открыть страницу"
      description={inApp
        ? "Попробуйте ещё раз. Если ошибка повторится, вернитесь к сессиям или откройте страницу позже."
        : "Попробуйте ещё раз. Если ошибка повторится, вернитесь на главную или откройте страницу позже."}
    >
      <Button
        size="lg"
        disabled={pending}
        aria-busy={pending}
        onClick={() => startTransition(retry)}
      >
        {pending ? <Spinner data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />}
        Попробовать ещё раз
      </Button>
      <ButtonLink
        size="lg"
        variant="outline"
        href={inApp ? "/s" : "/"}
      >
        <ArrowLeftIcon data-icon="inline-start" />
        {inApp ? "К сессиям" : "На главную"}
      </ButtonLink>
    </PageState>
  );
}
