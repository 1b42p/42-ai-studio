/** Сессия eve, к которой привязана сессия приложения: у копии агента — корневая. */
export function speechEveSessionId(session: {
  readonly id: string;
  readonly parent?: { readonly rootSessionId: string } | null;
}): string {
  return session.parent?.rootSessionId ?? session.id;
}
