import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import path from "node:path";

export function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

export async function unlinkIfPresent(file: string): Promise<void> {
  await unlink(file).catch((error: unknown) => { if (!isMissingFile(error)) throw error; });
}

export async function syncDirectory(dir: string, noFollow = true): Promise<void> {
  const handle = await open(dir, constants.O_RDONLY | constants.O_DIRECTORY |
    (noFollow ? constants.O_NOFOLLOW : 0));
  try { await handle.sync(); }
  finally { await handle.close(); }
}

export async function replaceLocalJson(file: string, json: string, signal: AbortSignal): Promise<void> {
  const dir = path.dirname(file);
  const staging = path.join(dir, `.${randomUUID()}.redaction`);
  signal.throwIfAborted();
  const handle = await open(staging, "wx", 0o600);
  try {
    try {
      await handle.writeFile(json, { signal });
      await handle.sync();
    } finally {
      await handle.close();
    }
    signal.throwIfAborted();
    await rename(staging, file);
    await syncDirectory(dir);
  } finally {
    await unlinkIfPresent(staging);
  }
}
