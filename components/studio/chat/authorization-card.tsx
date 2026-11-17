"use client";

import type { EveMessagePart } from "eve/react";
import { ArrowUpRightIcon, KeyRoundIcon } from "lucide-react";

import { ButtonLink } from "@/components/studio/button-link";
import { Item, ItemActions, ItemContent, ItemDescription, ItemFooter, ItemMedia, ItemTitle } from "@/components/ui/item";
import { TraceIcon, TraceLine, TraceTitle } from "@/components/ui/trace";
import { safeAuthorizationUrl } from "./authorization-url";

export type AuthorizationPart = Extract<EveMessagePart, { type: "authorization" }>;

const reasons: Readonly<Record<string, string>> = {
  access_denied: "Доступ не разрешён",
  invalid_state: "Вход устарел, начните заново",
  issuer_mismatch: "Ответ пришёл не от сервера авторизации",
  pkce_unsupported: "Сервер авторизации не поддерживает безопасный вход (PKCE)",
  registration_unsupported: "Сервер не поддерживает автоматическую регистрацию клиента",
  resource_mismatch: "Сервер описал себя иначе, чем указан адрес",
  discovery_failed: "Не удалось получить настройки входа сервера",
  token_exchange_failed: "Сервер не выдал токен",
  wrong_user: "Вход возможен только владельцу сервера",
};

/** Only recognized codes are projected; never expose raw connection error bodies. */
export function authorizationErrorDescription(error: string): string | null {
  const code = error.split(":", 1)[0]?.trim();
  return code ? reasons[code] ?? null : null;
}

export function AuthorizationCard({ part, allowHosts }: {
  part: AuthorizationPart;
  allowHosts?: readonly string[];
}) {
  if (part.state === "completed") {
    const failed = part.outcome === "failed" || part.outcome === "timed-out";
    const title = part.outcome === "authorized"
      ? `Вход в «${part.displayName}» выполнен`
      : part.outcome === "declined"
        ? `Вход в «${part.displayName}» отменён`
        : part.outcome === "timed-out"
          ? "Время ожидания входа истекло. Попросите агента повторить"
          : `Не удалось войти в «${part.displayName}». ${reasons[part.reason ?? ""] ?? "Попробуйте ещё раз"}`;
    return (
      <TraceLine status={failed ? "error" : undefined}>
        <TraceIcon><KeyRoundIcon /></TraceIcon>
        <TraceTitle title={title}>{title}</TraceTitle>
      </TraceLine>
    );
  }

  const url = safeAuthorizationUrl(part.authorization?.url, allowHosts);
  return (
    <Item variant="outline" className="min-w-0">
      <ItemMedia variant="icon"><KeyRoundIcon /></ItemMedia>
      <ItemContent className="min-w-0 basis-0">
        <ItemTitle className="max-w-full truncate" title={part.displayName}>Нужен вход в «{part.displayName}»</ItemTitle>
        <ItemDescription className="line-clamp-none">
          Откройте ссылку, войдите на сайте сервера и разрешите доступ. Агент продолжит работу сам. Новое сообщение отменит ожидание входа.
        </ItemDescription>
        {url ? (
          <ItemDescription className="truncate" title={url.host}>Откроется {url.host}</ItemDescription>
        ) : <ItemDescription>Ссылка для входа недоступна</ItemDescription>}
      </ItemContent>
      {url ? (
        <ItemActions>
          <ButtonLink href={url.href} target="_blank" rel="noopener noreferrer">
            Войти <ArrowUpRightIcon data-icon="inline-end" />
          </ButtonLink>
        </ItemActions>
      ) : null}
      <ItemFooter>
        <ItemDescription className="line-clamp-none">
          После входа закройте открывшуюся вкладку и вернитесь в чат
        </ItemDescription>
      </ItemFooter>
    </Item>
  );
}
