import { ConnectionAuthorizationFailedError } from "eve/connections";

const messages = {
  wrong_user: "Вход возможен только владельцу сервера",
  discovery_failed: "Не удалось получить настройки входа сервера",
  resource_mismatch: "Сервер описал себя иначе, чем указан адрес",
  pkce_unsupported: "Сервер авторизации не поддерживает безопасный вход (PKCE)",
  registration_unsupported: "Сервер не поддерживает автоматическую регистрацию клиента",
  access_denied: "Доступ не разрешён",
  provider_error: "Сервер авторизации отклонил вход",
  invalid_state: "Вход устарел, начните заново",
  issuer_mismatch: "Ответ пришёл не от сервера авторизации",
  token_exchange_failed: "Сервер не выдал токен",
} as const;

export type OAuthFailureReason = keyof typeof messages;

export class OAuthProtocolError extends Error {
  constructor(readonly reason: OAuthFailureReason) {
    super(`${reason}: ${messages[reason]}`);
  }
}

export function authorizationFailure(connection: string, reason: OAuthFailureReason, retryable = false) {
  return new ConnectionAuthorizationFailedError(connection, {
    reason, retryable, message: `${reason}: ${messages[reason]}`,
  });
}
