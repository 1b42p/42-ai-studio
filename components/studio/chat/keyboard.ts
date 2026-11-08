/** Touch keyboards have no reliable Shift+Enter: use the send button. */
export function isTouchInput(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;
}
