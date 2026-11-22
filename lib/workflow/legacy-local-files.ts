import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import type { OwnedLocalRun } from "./legacy-local-inventory";

const RUN_ID = /^wrun_[0-9A-HJKMNP-TV-Z]{26}$/;
const STREAM = /^strm_([0-9A-HJKMNP-TV-Z]{26})(?:_[A-Za-z0-9_-]+)?$/;
const OWNED_NAME = /^(wrun_[0-9A-HJKMNP-TV-Z]{26})[-.]/;
const HASH = /^[0-9a-f]{64}$/;
const HOOK = /^hook_[0-9A-HJKMNP-TV-Z]{26}$/;

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

async function directory(parent: string, name: string): Promise<string | null> {
  const candidate = path.join(parent, name);
  const stat = await lstat(candidate).catch((error: unknown) => {
    if (missing(error)) return null;
    throw error;
  });
  if (stat === null) return null;
  if (!stat.isDirectory()) throw new Error("Invalid local Workflow directory");
  return candidate;
}

async function unlinkExisting(file: string) {
  await unlink(file).catch((error: unknown) => { if (!missing(error)) throw error; });
}

async function list(parent: string | null) {
  if (parent === null) return [];
  return readdir(parent, { withFileTypes: true });
}

async function readEntity(file: string, signal: AbortSignal, maxBytes: number): Promise<unknown> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW).catch((error: unknown) => {
    if (missing(error)) return null;
    throw error;
  });
  if (handle === null) return undefined;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new Error("Invalid local Workflow entity file");
    return JSON.parse(await handle.readFile({ encoding: "utf8", signal })) as unknown;
  } finally {
    await handle.close();
  }
}

/**
 * Removes files of selected runs in an untagged Local World. The caller must
 * fence session access and wait for terminal Workflow writers before calling.
 */
export async function eraseLegacyRunFiles(
  dataDir: string,
  runs: readonly OwnedLocalRun[],
  signal: AbortSignal,
): Promise<void> {
  if (runs.some((run) => !RUN_ID.test(run.id) || !run.terminal)) {
    throw new Error("Local Workflow runs must be valid and terminal before erasure");
  }
  if (runs.length === 0) return;
  const ids = new Set(runs.map(({ id }) => id));
  const files = new Set<string>();
  const addRunKeyedFiles = async (parent: string | null) => {
    if (parent === null) return;
    for (const item of await list(parent)) {
      signal.throwIfAborted();
      const owner = OWNED_NAME.exec(item.name)?.[1];
      if (item.isFile() && owner && ids.has(owner)) files.add(path.join(parent, item.name));
    }
  };

  for (const entity of ["events", "steps"] as const) {
    const parent = await directory(dataDir, entity);
    if (parent === null) continue;
    for (const id of ids) {
      const runDir = await directory(parent, id);
      if (runDir !== null) {
        for (const item of await list(runDir)) {
          if (!item.isFile()) throw new Error("Unexpected local Workflow entity");
          files.add(path.join(runDir, item.name));
        }
      }
    }
  }

  const streams = await directory(dataDir, "streams");
  if (streams !== null) {
    const chunks = await directory(streams, "chunks");
    if (chunks !== null) {
      for (const item of await list(chunks)) {
        const owner = STREAM.exec(item.name)?.[1];
        if (!owner || !ids.has(`wrun_${owner}`)) continue;
        if (!item.isDirectory()) throw new Error("Invalid local Workflow stream");
        const streamDir = path.join(chunks, item.name);
        for (const chunk of await list(streamDir)) {
          if (!chunk.isFile()) throw new Error("Unexpected local Workflow stream entry");
          files.add(path.join(streamDir, chunk.name));
        }
      }
    }
    await addRunKeyedFiles(await directory(streams, "runs"));
  }

  const hooks = await directory(dataDir, "hooks");
  if (hooks !== null) {
    await addRunKeyedFiles(await directory(hooks, "by-run"));
    for (const [parent, identity] of [[hooks, HOOK], [await directory(hooks, "tokens"), HASH]] as const) {
      if (parent === null) continue;
      for (const item of await list(parent)) {
        signal.throwIfAborted();
        if (!item.name.endsWith(".json") || !identity.test(item.name.slice(0, -5))) continue;
        if (!item.isFile()) throw new Error("Unexpected local Workflow hook entry");
        const file = path.join(parent, item.name);
        const entity = await readEntity(file, signal, 1024 * 1024) as { runId?: unknown } | undefined;
        const owner = entity?.runId;
        if (typeof owner === "string" && ids.has(owner)) files.add(file);
      }
    }
    for (const [name, key] of [["token-index", HASH], ["id-index", HOOK]] as const) {
      const index = await directory(hooks, name);
      if (index === null) continue;
      for (const item of await list(index)) {
        if (item.isDirectory() && key.test(item.name)) await addRunKeyedFiles(path.join(index, item.name));
      }
    }
  }

  for (const name of ["waits", "snapshots"] as const) await addRunKeyedFiles(await directory(dataDir, name));
  // Native terminal/step fences are not data files; leave them in place.

  for (const file of files) {
    signal.throwIfAborted();
    await unlinkExisting(file);
  }
  const records = await directory(dataDir, "runs");
  if (records !== null) {
    // Leave a minimal terminal record, not its user-bearing attributes or input.
    // A delayed delivery must never be able to recreate an erased run.
    for (const id of ids) {
      signal.throwIfAborted();
      const file = path.join(records, `${id}.json`);
      const row = await readEntity(file, signal, 48 * 1024 * 1024) as Record<string, unknown> | undefined;
      if (!row) continue;
      if (row.runId !== id || !["completed", "failed", "cancelled"].includes(String(row.status))) {
        throw new Error("Local Workflow run changed during erasure");
      }
      const tombstone = {
        runId: id, status: row.status, workflowName: row.workflowName, specVersion: row.specVersion,
        deploymentId: row.deploymentId, createdAt: row.createdAt, updatedAt: row.updatedAt,
        startedAt: row.startedAt, completedAt: row.completedAt,
        expiredAt: typeof row.expiredAt === "string" ? row.expiredAt : new Date().toISOString(),
      };
      const staging = path.join(records, `.${randomUUID()}.redaction`);
      try {
        await writeFile(staging, JSON.stringify(tombstone), { flag: "wx", mode: 0o600, signal });
        await rename(staging, file);
      } finally {
        await unlinkExisting(staging);
      }
    }
  }
}
