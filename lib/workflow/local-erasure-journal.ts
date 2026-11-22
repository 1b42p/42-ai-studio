import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import path from "node:path";

import { isMissingFile, replaceLocalJson, syncDirectory, unlinkIfPresent } from "./durable-redaction";
import { LEGACY_RUN_ID } from "./legacy-run-lineage";

const MAX_BYTES = 4 * 1024 * 1024;

interface ErasureOwner {
  readonly appSessionId: string;
  readonly userId: string;
}

export interface ErasureRunScope {
  readonly runIds: readonly string[];
  readonly sessionIds: readonly string[];
}

function code(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function runIds(value: unknown): value is string[] {
  return Array.isArray(value) &&
    value.every((id) => typeof id === "string" && LEGACY_RUN_ID.test(id)) &&
    new Set(value).size === value.length;
}

/** Operations for one application session are serialized by the caller's DB lock. */
export function localErasureJournal(dataDir: string, owner: ErasureOwner) {
  const scopeKey = createHash("sha256").update(JSON.stringify([owner.appSessionId, owner.userId])).digest("hex");
  const dir = path.join(dataDir, "studio-erasure");
  const file = path.join(dir, `${scopeKey}.json`);

  async function openJournalDirectory() {
    return open(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      .catch((error: unknown) => { if (isMissingFile(error)) return null; throw error; });
  }

  return {
    async read(signal: AbortSignal): Promise<ErasureRunScope | null> {
      signal.throwIfAborted();
      const directory = await openJournalDirectory();
      if (!directory) return null;
      try {
        const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
          .catch((error: unknown) => { if (isMissingFile(error)) return null; throw error; });
        if (!handle) return null;
        try {
          const stat = await handle.stat();
          if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error("Invalid local Workflow erasure journal");
          const bytes = await handle.readFile({ signal });
          if (bytes.length > MAX_BYTES) throw new Error("Invalid local Workflow erasure journal");
          const data = JSON.parse(bytes.toString("utf8")) as {
            version?: unknown; scopeKey?: unknown; runIds?: unknown; sessionIds?: unknown;
          };
          if (data?.version !== 1 || data.scopeKey !== scopeKey || !runIds(data.runIds) ||
              !runIds(data.sessionIds) || Object.keys(data).length !== 4) {
            throw new Error("Invalid local Workflow erasure journal");
          }
          const captured = new Set(data.runIds);
          if (!data.runIds.length || !data.sessionIds.length || !data.sessionIds.every((id) => captured.has(id))) {
            throw new Error("Invalid local Workflow erasure journal scope");
          }
          return { runIds: data.runIds, sessionIds: data.sessionIds };
        } finally {
          await handle.close();
        }
      } finally {
        await directory.close();
      }
    },

    async write(scope: ErasureRunScope, signal: AbortSignal): Promise<void> {
      signal.throwIfAborted();
      const bytes = JSON.stringify({ version: 1, scopeKey, ...scope });
      if (Buffer.byteLength(bytes) > MAX_BYTES) throw new Error("Local Workflow erasure scope is too large");
      await mkdir(dir, { mode: 0o700 }).catch((error: unknown) => {
        if (code(error) !== "EEXIST") throw error;
      });
      // Ensure the directory entry, file contents and final rename survive a crash
      // before any run record can lose its ownership metadata.
      await syncDirectory(dataDir, false);
      await syncDirectory(dir);
      await replaceLocalJson(file, bytes, signal);
    },

    async forget() {
      const directory = await openJournalDirectory();
      if (!directory) return;
      try {
        await unlinkIfPresent(file);
        await directory.sync();
      } finally {
        await directory.close();
      }
    },
  };
}
