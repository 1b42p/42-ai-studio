/** Публичное состояние песочницы сессии, общее для сервера и браузера. */
export interface SandboxStatus {
  state: "none" | "starting" | "started" | "stopped" | "archived" | "queued";
  queue: {
    position: number;
    total: number;
    reason: "capacity" | "own_session_busy";
  } | null;
}
