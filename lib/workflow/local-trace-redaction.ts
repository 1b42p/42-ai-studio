type Entry = Record<string, unknown>;

function object(value: unknown): Entry {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid local trace record");
  return value as Entry;
}

function collection(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error("Invalid local trace collection");
  return value;
}

function spanOwners(span: Entry): string[] {
  return (span.attributes === undefined ? [] : collection(span.attributes))
    .map(object)
    .filter(({ key }) => key === "agent.run.id" || key === "gen_ai.conversation.id")
    .flatMap(({ value }) => {
      const id = object(value).stringValue;
      return typeof id === "string" ? [id] : [];
    });
}

/** Preserves spans from another conversation even when they share a trace ID. */
export function redactOwnedTraceSpans(input: unknown, ownedIds: ReadonlySet<string>) {
  let removed = 0;
  let kept = 0;
  const trace = object(input);
  const resourceSpans = collection(trace.resourceSpans).map((resourceValue) => {
    const resource = object(resourceValue);
    const scopeSpans = collection(resource.scopeSpans).map((scopeValue) => {
      const scope = object(scopeValue);
      const spans = collection(scope.spans).filter((value) => {
        const owners = spanOwners(object(value));
        const belongs = owners.some((id) => ownedIds.has(id));
        if (belongs && !owners.every((id) => ownedIds.has(id))) {
          throw new Error("Conflicting local trace ownership");
        }
        if (belongs) removed += 1;
        else kept += 1;
        return !belongs;
      });
      return { ...scope, spans };
    }).filter((scope) => scope.spans.length !== 0);
    return { ...resource, scopeSpans };
  }).filter((resource) => resource.scopeSpans.length !== 0);
  return { removed, kept, trace: { ...trace, resourceSpans } };
}

const TRACE_ID = /^[0-9a-f]{32}$/;
const SEGMENT_FILE = /^[0-9a-f]{16}\.otlp\.json$/;

async function isTraceDirectory(directory: string) {
  const stat = await lstat(directory).catch((error: unknown) => {
    if (isMissingFile(error)) return null;
    throw error;
  });
  if (stat !== null && !stat.isDirectory()) throw new Error("Invalid local trace directory");
  return stat !== null;
}

/** The local exporter must have drained before the caller enters this write phase. */
export async function eraseLocalTraceData(
  tracesDir: string,
  ownedIds: ReadonlySet<string>,
  signal: AbortSignal,
): Promise<void> {
  if (ownedIds.size === 0) return;
  const conversationKeys = [...ownedIds].map((id) => createHash("sha256").update(id).digest("hex"));
  if (!await isTraceDirectory(tracesDir)) return;
  for (const entry of await readdir(tracesDir, { withFileTypes: true })) {
    signal.throwIfAborted();
    if (!TRACE_ID.test(entry.name)) continue;
    if (!entry.isDirectory()) throw new Error("Invalid local trace identity");
    const tracePath = path.join(tracesDir, entry.name);
    const segments = path.join(tracePath, "segments");
    if (await isTraceDirectory(segments)) {
      for (const segment of await readdir(segments, { withFileTypes: true })) {
        signal.throwIfAborted();
        if (!SEGMENT_FILE.test(segment.name)) continue;
        if (!segment.isFile()) throw new Error("Invalid local trace segment");
        const file = path.join(segments, segment.name);
        const result = redactOwnedTraceSpans(JSON.parse(await readFile(file, { encoding: "utf8", signal })), ownedIds);
        if (!result.removed) continue;
        if (result.kept === 0) await unlinkIfPresent(file);
        else await replaceLocalJson(file, JSON.stringify(result.trace), signal);
      }
      await syncDirectory(segments);
    }
    const conversations = path.join(tracePath, "index", "v1", "conversations");
    if (await isTraceDirectory(conversations)) {
      for (const key of conversationKeys) {
        signal.throwIfAborted();
        await unlinkIfPresent(path.join(conversations, key));
      }
      await syncDirectory(conversations);
    }
  }
}
import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { isMissingFile, replaceLocalJson, syncDirectory, unlinkIfPresent } from "./durable-redaction";
