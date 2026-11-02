/**
 * Идентификатор сообщения в номере файла: `<turnId>:<stepIndex>`.
 * Одна формула для сервера (хук копирования) и браузера (отрисовка): поля
 * берутся из данных события `message.completed` и `part.stepIndex`.
 */
export function messageIdOf(
  turnId: string | undefined,
  stepIndex: number | undefined,
): string | undefined {
  if (turnId === undefined || stepIndex === undefined) return undefined;
  return `${turnId}:${stepIndex}`;
}
