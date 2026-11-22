import { open, readdir, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

import { readLegacyRunLineage, selectLegacySessionRuns } from "./legacy-run-lineage";

const WORLD_VERSION = "@workflow/world-local@5.1.2";
const RUN_FILE = /^(wrun_[0-9A-HJKMNP-TV-Z]{26})\.json$/;
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
const MAX_RUN_BYTES = 48 * 1024 * 1024;

export interface LocalWorkflowOwner {
  readonly appSessionId: string;
  readonly userId: string;
  readonly eveSessionIds: readonly string[];
}

export interface OwnedLocalRun {
  readonly id: string;
  readonly sessionId?: string;
  readonly terminal: boolean;
}

/** The file inventory is only for the app's original, untagged local World. */
export async function inventoryOwnedLegacyRuns(
  dataDir: string,
  owner: LocalWorkflowOwner,
  signal: AbortSignal,
): Promise<OwnedLocalRun[]> {
  const actualVersion = await readFile(path.join(dataDir, "version.txt"), { encoding: "utf8", signal });
  if (actualVersion.trim() !== WORLD_VERSION) throw new Error("Unsupported local Workflow storage version");

  const runDirectory = path.join(dataDir, "runs");
  const names = await readdir(runDirectory, { withFileTypes: true });
  const lineage = [];
  const byId = new Map<string, OwnedLocalRun>();
  for (const entry of names) {
    signal.throwIfAborted();
    if (!entry.name.endsWith(".json")) continue;
    const id = RUN_FILE.exec(entry.name)?.[1];
    if (!entry.isFile() || !id) throw new Error("Unsupported local Workflow run layout");

    const handle = await open(path.join(runDirectory, entry.name), constants.O_RDONLY | constants.O_NOFOLLOW)
      .catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return null;
        throw error;
      });
    if (handle === null) continue;
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_RUN_BYTES) throw new Error("Invalid local Workflow run file");
      const bytes = await handle.readFile({ signal });
      if (bytes.length > MAX_RUN_BYTES) throw new Error("Invalid local Workflow run file");
      const data = JSON.parse(bytes.toString("utf8")) as {
        runId?: unknown; status?: unknown; input?: unknown; expiredAt?: unknown;
        attributes?: unknown; executionContext?: unknown;
      };
      if (data?.runId !== id || typeof data.status !== "string") throw new Error("Conflicting local Workflow run identity");
      const isScrubbed = data.input === undefined && typeof data.expiredAt === "string" &&
        data.attributes === undefined && data.executionContext === undefined;
      const parsed = isScrubbed ? undefined : readLegacyRunLineage(data);
      if (parsed !== undefined) lineage.push(parsed);
      byId.set(id, { id, sessionId: parsed?.sessionId, terminal: TERMINAL_STATUSES.has(data.status) });
    } finally {
      await handle.close();
    }
  }
  return selectLegacySessionRuns(lineage, owner).map((id) => byId.get(id)!);
}
