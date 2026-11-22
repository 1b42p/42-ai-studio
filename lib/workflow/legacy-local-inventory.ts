import { lstat, open, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

import { isMissingFile } from "./durable-redaction";
import {
  LEGACY_EVE_SESSION_WORKFLOW, readLegacyRunLineage, selectLegacySessionRuns,
} from "./legacy-run-lineage";
import type { ErasureRunScope } from "./local-erasure-journal";

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
  /** Only erasure requires a root and may use scope verified before scrubbing. */
  erasure?: { readonly captured: ErasureRunScope | null },
): Promise<OwnedLocalRun[]> {
  const version = await open(path.join(dataDir, "version.txt"), constants.O_RDONLY |
    constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let actualVersion: string;
  try {
    const stat = await version.stat();
    if (!stat.isFile() || stat.size > 128) throw new Error("Invalid local Workflow storage version file");
    actualVersion = await version.readFile({ encoding: "utf8", signal });
  } finally {
    await version.close();
  }
  if (actualVersion.trim() !== WORLD_VERSION) throw new Error("Unsupported local Workflow storage version");

  const runDirectory = path.join(dataDir, "runs");
  if (!(await lstat(runDirectory)).isDirectory()) throw new Error("Invalid local Workflow run directory");
  const names = await readdir(runDirectory, { withFileTypes: true });
  const lineage = [];
  const byId = new Map<string, OwnedLocalRun>();
  const sessionRoots = new Set<string>();
  const tombstones = new Set<string>();
  const capturedRoots = new Set(erasure?.captured?.sessionIds);
  for (const entry of names) {
    signal.throwIfAborted();
    if (!entry.name.endsWith(".json")) continue;
    const id = RUN_FILE.exec(entry.name)?.[1];
    if (!entry.isFile() || !id) throw new Error("Unsupported local Workflow run layout");

    const handle = await open(path.join(runDirectory, entry.name), constants.O_RDONLY |
      constants.O_NOFOLLOW | constants.O_NONBLOCK)
      .catch((error: unknown) => {
        if (isMissingFile(error)) return null;
        throw error;
      });
    if (handle === null) continue;
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_RUN_BYTES) throw new Error("Invalid local Workflow run file");
      const bytes = await handle.readFile({ signal });
      if (bytes.length > MAX_RUN_BYTES) throw new Error("Invalid local Workflow run file");
      const data = JSON.parse(bytes.toString("utf8")) as {
        runId?: unknown; status?: unknown; input?: unknown; expiredAt?: unknown; workflowName?: unknown;
        attributes?: unknown; executionContext?: unknown;
      };
      if (data?.runId !== id || typeof data.status !== "string") throw new Error("Conflicting local Workflow run identity");
      const isScrubbed = data.input === undefined && typeof data.expiredAt === "string" &&
        data.attributes === undefined && data.executionContext === undefined;
      const parsed = isScrubbed ? undefined : readLegacyRunLineage(data);
      if (parsed !== undefined) lineage.push(parsed);
      if (isScrubbed) tombstones.add(id);
      const sessionId = isScrubbed && capturedRoots.has(id) ? id : parsed?.sessionId;
      if (data.workflowName === LEGACY_EVE_SESSION_WORKFLOW && sessionId === id) sessionRoots.add(id);
      byId.set(id, { id, sessionId, terminal: TERMINAL_STATUSES.has(data.status) });
    } finally {
      await handle.close();
    }
  }
  const eveSessionIds = [...owner.eveSessionIds, ...capturedRoots];
  const scope = new Set(selectLegacySessionRuns(lineage, { ...owner, eveSessionIds }));
  if (erasure && eveSessionIds.some((id) => !sessionRoots.has(id))) {
    throw new Error("Missing bound Eve root in local Workflow storage");
  }
  for (const id of erasure?.captured?.runIds ?? []) {
    if (!byId.get(id)?.terminal || (!scope.has(id) && !tombstones.has(id))) {
      throw new Error("Missing or changed captured local Workflow run");
    }
    scope.add(id);
  }
  return [...scope].map((id) => byId.get(id)!);
}
