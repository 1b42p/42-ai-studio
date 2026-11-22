import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { inventoryOwnedLegacyRuns, type LocalWorkflowOwner } from "./legacy-local-inventory";
import { eraseLegacyRunFiles } from "./legacy-local-files";
import { eraseLocalTraceData } from "./local-trace-redaction";

interface ErasureOptions {
  readonly stateDir: string;
  readonly owner: LocalWorkflowOwner;
  readonly signal: AbortSignal;
  /** Cancels the current turn and resets a logical Eve session by ID. */
  readonly resetSession: (id: string, signal: AbortSignal) => Promise<void>;
}

/**
 * The application must first fence all public access to the session. Reset
 * ends the parent/copy/tool writers; don't erase data just because it replied.
 */
export async function eraseStudioWorkflowData(options: ErasureOptions): Promise<void> {
  const { stateDir, owner, signal, resetSession } = options;
  const dataDir = path.join(stateDir, ".workflow-data");
  const inventory = () => inventoryOwnedLegacyRuns(dataDir, owner, signal);
  let runs = await inventory();
  const reset = new Set<string>();

  while (runs.some((run) => !run.terminal)) {
    for (const run of runs) {
      if (run.terminal || run.sessionId === undefined || reset.has(run.sessionId)) continue;
      // A predecessor or child may finish while another reset is in flight.
      await resetSession(run.sessionId, signal);
      reset.add(run.sessionId);
    }
    await delay(150, undefined, { signal });
    runs = await inventory();
  }

  // Do not scrub identifying run records until the separately persisted traces
  // have been handled. On failure the scope can be recovered on the next try.
  await eraseLocalTraceData(
    path.join(stateDir, "traces", "v1"),
    new Set(runs.flatMap((run) => run.sessionId ? [run.id, run.sessionId] : [run.id])),
    signal,
  );
  await eraseLegacyRunFiles(dataDir, runs, signal);
}
