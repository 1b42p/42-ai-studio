import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { inventoryOwnedLegacyRuns, type LocalWorkflowOwner } from "./legacy-local-inventory";
import { eraseLegacyRunFiles } from "./legacy-local-files";
import { eraseLocalTraceData } from "./local-trace-redaction";
import { localErasureJournal } from "./local-erasure-journal";

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
  const journal = localErasureJournal(dataDir, owner);
  const captured = await journal.read(signal);
  const inventory = () => inventoryOwnedLegacyRuns(dataDir, owner, signal, { captured });
  let runs = await inventory();
  if (!runs.length) {
    // The caller skips truly never-started sessions. An expired start claim
    // without a run cannot distinguish a failed start from a missing volume or
    // a start request that has not reached Workflow yet.
    throw new Error("Missing owned Eve root for a previously requested start");
  }
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

  // Capture all verified IDs before the first scrub. Retrying on a different
  // World cannot use this journal to bypass the on-disk root and run checks.
  const sessionIds = runs.filter(({ id, sessionId }) => id === sessionId).map(({ id }) => id);
  if (!sessionIds.length) throw new Error("Missing owned Eve root after reset");
  await journal.write({ runIds: runs.map(({ id }) => id), sessionIds }, signal);

  await eraseLocalTraceData(
    path.join(stateDir, "traces", "v1"),
    new Set(runs.flatMap((run) => run.sessionId ? [run.id, run.sessionId] : [run.id])),
    signal,
  );
  await eraseLegacyRunFiles(dataDir, runs, signal);
}

/** Call only after the database has durably removed the application session. */
export async function forgetStudioWorkflowErasure(
  stateDir: string,
  owner: Pick<LocalWorkflowOwner, "appSessionId" | "userId">,
): Promise<void> {
  await localErasureJournal(path.join(stateDir, ".workflow-data"), owner).forget();
}
