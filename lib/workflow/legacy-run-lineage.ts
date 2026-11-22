import { zstdDecompressSync } from "node:zlib";

const MAX_INPUT_BYTES = 32 * 1024 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });
const RUN_ID = /^wrun_[0-9A-HJKMNP-TV-Z]{26}$/;

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as RecordValue
    : undefined;
}

function runId(value: unknown): string | undefined {
  return typeof value === "string" && RUN_ID.test(value) ? value : undefined;
}

/** Reads only named fields from the flattened Workflow input; never revives objects or searches payload text. */
function inputReader(input: unknown) {
  const encoded = record(input);
  if (encoded?.__type !== "Uint8Array" || typeof encoded.data !== "string" ||
      encoded.data.length > Math.ceil(MAX_INPUT_BYTES / 3) * 4) {
    throw new Error("Unsupported legacy Workflow input");
  }

  let bytes: Uint8Array = Buffer.from(encoded.data, "base64");
  if (Buffer.from(bytes).toString("base64") !== encoded.data) {
    throw new Error("Invalid legacy Workflow input encoding");
  }
  if (decoder.decode(bytes.subarray(0, 4)) === "zstd") {
    bytes = zstdDecompressSync(bytes.subarray(4), { maxOutputLength: MAX_INPUT_BYTES });
  }
  if (decoder.decode(bytes.subarray(0, 4)) !== "devl") {
    throw new Error("Unsupported legacy Workflow serialization");
  }

  const table: unknown = JSON.parse(decoder.decode(bytes.subarray(4)));
  if (!Array.isArray(table) || !Array.isArray(table[0]) || table[0].length !== 1) {
    throw new Error("Invalid legacy Workflow arguments");
  }
  const get = (index: unknown): unknown =>
    typeof index === "number" && Number.isSafeInteger(index) && index >= 0 && index < table.length
      ? table[index]
      : undefined;
  const field = (value: unknown, key: string): unknown => {
    const object = record(value);
    return object && Object.hasOwn(object, key) ? get(object[key]) : undefined;
  };
  const argument = record(get(table[0][0]));
  if (!argument) throw new Error("Invalid legacy Workflow argument");
  return { argument, field };
}

export interface LegacyRunLineage {
  readonly id: string;
  readonly sessionId?: string;
  readonly parentSessionId?: string;
  readonly appSessionId?: string;
  readonly userId?: string;
}

type SessionOwner = {
  readonly appSessionId: string;
  readonly userId: string;
  readonly eveSessionIds: readonly string[];
};

/** Expands only trusted application bindings and the storage's explicit parent/owner relationships. */
export function selectLegacySessionRuns(
  runs: readonly LegacyRunLineage[],
  owner: SessionOwner,
): string[] {
  const sessions = new Set(owner.eveSessionIds);
  if ([...sessions].some((id) => !runId(id))) throw new Error("Invalid bound Eve session");

  const copiesByParent = new Map<string, string[]>();
  for (const run of runs) {
    if (run.id !== run.sessionId) continue;
    if (run.appSessionId === owner.appSessionId && run.userId === owner.userId) sessions.add(run.id);
    if (run.parentSessionId) {
      const copies = copiesByParent.get(run.parentSessionId) ?? [];
      copies.push(run.id);
      copiesByParent.set(run.parentSessionId, copies);
    }
  }
  // A Set iterator includes additions. Cycles and already-known copies are visited once.
  for (const parent of sessions) {
    for (const id of copiesByParent.get(parent) ?? []) sessions.add(id);
  }

  const selected: string[] = [];
  for (const run of runs) {
    if (!run.sessionId || !sessions.has(run.sessionId)) continue;
    if ((run.appSessionId && run.appSessionId !== owner.appSessionId) ||
        (run.userId && run.userId !== owner.userId)) {
      throw new Error("Conflicting legacy Workflow ownership");
    }
    selected.push(run.id);
  }
  return selected;
}

/** Recognizes the exact run argument layouts written by Eve 0.83.0's local World. */
export function readLegacyRunLineage(value: unknown): LegacyRunLineage | undefined {
  const run = record(value);
  const id = runId(run?.runId);
  if (!run || !id) throw new Error("Invalid legacy Workflow run");

  switch (run.workflowName) {
    case "workflow//eve//workflowEntry": {
      if (run.input === undefined && typeof run.expiredAt === "string") {
        // Native retention has already stripped inputs, but not Eve's title
        // or parent attributes. A known anchor or explicit parent still binds them.
        const attributes = record(run.attributes);
        return {
          id, sessionId: id,
          parentSessionId: runId(attributes?.["$eve.parent"]) ?? runId(attributes?.["$eve.root"]),
        };
      }
      const { argument, field } = inputReader(run.input);
      const kind = field(argument, "kind");
      if (kind === "handoff") {
        const sessionId = runId(field(argument, "sessionId"));
        if (!sessionId) throw new Error("Invalid legacy Workflow handoff");
        return { id, sessionId };
      }
      if (kind !== "initial") throw new Error("Unsupported legacy Workflow start");

      const context = field(argument, "serializedContext");
      const parent = field(context, "eve.parentSession");
      const parentSessionId = runId(field(parent, "sessionId"));
      if (parent !== undefined && !parentSessionId) throw new Error("Invalid legacy Workflow parent");

      const auth = field(context, "eve.initiatorAuth");
      const principalId = field(auth, "principalId");
      const appSessionId = field(field(auth, "attributes"), "appSessionId");
      if (field(auth, "authenticator") === "studio" && field(auth, "principalType") === "user" &&
          typeof principalId === "string" && typeof appSessionId === "string") {
        return { id, sessionId: id, parentSessionId, appSessionId, userId: principalId };
      }
      return { id, sessionId: id, parentSessionId };
    }
    case "workflow//eve//workflowToolRunWorkflow": {
      const { argument, field } = inputReader(run.input);
      const sessionId = runId(field(field(argument, "session"), "id"));
      if (!sessionId) throw new Error("Invalid legacy Workflow tool owner");
      return { id, sessionId };
    }
    default:
      return undefined;
  }
}
