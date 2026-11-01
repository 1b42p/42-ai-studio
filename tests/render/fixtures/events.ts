/**
 * Конструктор событий для ручных фикстур. События, которые фикстурная модель
 * не создаёт (размышление, ошибки, отмена, открытый запрос ввода, завершённая
 * сессия), собираются по схеме из `eve/docs/concepts/sessions-runs-and-streaming.md`
 * («The event envelope») и `guides/client/streaming.mdx`.
 */
import type { MessageStreamEvent } from "eve/client";

let counter = 0;

/** Уникальный `meta.id` в порядке создания. */
export function nextEventId(): string {
  counter += 1;
  return `evt_fixture_${String(counter).padStart(4, "0")}`;
}

export function event(
  type: MessageStreamEvent["type"],
  data: Record<string, unknown>,
  id: string = nextEventId(),
): MessageStreamEvent {
  return {
    type,
    data,
    meta: { id, at: "2026-11-01T12:00:00.000Z" },
  } as unknown as MessageStreamEvent;
}
