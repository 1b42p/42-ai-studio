import { reconcileSandboxStates } from "@/agent/lib/sandbox-queue";

const INTERVAL_MS = 10_000;
const processState = globalThis as typeof globalThis & {
  __studioAdminReconcile?: { nextAt: number; pending: Promise<void> | null };
};

/** Общая сверка двух отчётов; не запускает диспетчер, toolbox или refreshActivity. */
export function reconcileAdminSandboxes(): Promise<void> {
  const state = processState.__studioAdminReconcile ??= { nextAt: 0, pending: null };
  if (state.pending) return state.pending;
  if (Date.now() < state.nextAt) return Promise.resolve();
  state.nextAt = Date.now() + INTERVAL_MS;
  state.pending = reconcileSandboxStates().then(() => undefined).finally(() => {
    state.pending = null;
  });
  return state.pending;
}
