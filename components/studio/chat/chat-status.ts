/** Состояние беседы, которое приходит из `useEveAgent`. */
export type ChatStatus = "error" | "ready" | "resuming" | "streaming" | "submitted";

/** Идёт ли ход: поле ввода шлёт поправку, а «Стоп» доступна. */
export function isBusyStatus(status: ChatStatus): boolean {
  return status === "submitted" || status === "streaming";
}
