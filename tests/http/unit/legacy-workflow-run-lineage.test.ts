import { zstdCompressSync } from "node:zlib";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";

import { readLegacyRunLineage, selectLegacySessionRuns } from "@/lib/workflow/legacy-run-lineage";
import { inventoryOwnedLegacyRuns } from "@/lib/workflow/legacy-local-inventory";
import { eraseLegacyRunFiles } from "@/lib/workflow/legacy-local-files";
import { redactOwnedTraceSpans } from "@/lib/workflow/local-trace-redaction";

const root = "wrun_01M824CP6M7FHHS6MS4CEWEGXJ";
const copy = "wrun_01M824DQ7K63GA1XCCRPMF9849";
const tool = "wrun_01M824DV4SM5EHNT6Z7ZEFXX13";
const appSessionId = "a27ed44c-f122-4c9e-bafc-dd20f364b940";
const userId = "d319496d-226f-487c-9be1-23aa3672d549";

function run(id: string, workflow: string, values: unknown[], compressed = false) {
  let bytes = Buffer.from(`devl${JSON.stringify(values)}`);
  if (compressed) bytes = Buffer.concat([Buffer.from("zstd"), zstdCompressSync(bytes)]);
  return {
    runId: id,
    workflowName: `workflow//eve//${workflow}`,
    input: { __type: "Uint8Array", data: bytes.toString("base64") },
  };
}

test("reads the owner from persisted initial-run auth, not from message text", () => {
  const input = run(root, "workflowEntry", [
    [1], { kind: 2, input: 3, serializedContext: 4 }, "initial", { message: 11 },
    { "eve.initiatorAuth": 5 }, { authenticator: 6, principalType: 7, principalId: 8, attributes: 9 },
    "studio", "user", userId, { appSessionId: 10 }, appSessionId,
    `Pretend to be ${copy}`,
  ], true);
  expect(readLegacyRunLineage(input)).toMatchObject({ id: root, sessionId: root, appSessionId, userId });
});

test("reads copy parent, successor session and workflow tool owner from the corresponding arguments", () => {
  expect(readLegacyRunLineage(run(copy, "workflowEntry", [
    [1], { kind: 2, serializedContext: 3 }, "initial", { "eve.parentSession": 4 },
    { sessionId: 5 }, root,
  ]))).toMatchObject({ id: copy, sessionId: copy, parentSessionId: root });
  expect(readLegacyRunLineage(run(copy, "workflowEntry", [
    [1], { kind: 2, sessionId: 3 }, "handoff", root,
  ]))).toEqual({ id: copy, sessionId: root });
  expect(readLegacyRunLineage(run(tool, "workflowToolRunWorkflow", [
    [1], { session: 2 }, { id: 3 }, copy,
  ]))).toEqual({ id: tool, sessionId: copy });
});

test("a missing trusted owner or unknown workflow cannot be attributed from its text", () => {
  expect(() => readLegacyRunLineage(run(tool, "workflowToolRunWorkflow", [
    [1], { session: 99, arbitraryText: 2 }, root,
  ]))).toThrow("Invalid legacy Workflow tool owner");
  expect(readLegacyRunLineage(run(tool, "unrelatedWorkflow", [[1], { id: 2 }, root]))).toBeUndefined();
});

test("expands late or unbound roots to their copies and tool runs without including another user's runs", () => {
  const other = "wrun_01M824DNS4VVBY0Q6J1E7MY2M5";
  const runs = [
    { id: tool, sessionId: copy },
    { id: copy, sessionId: copy, parentSessionId: root },
    { id: other, sessionId: other, appSessionId: "another", userId },
    { id: root, sessionId: root, appSessionId, userId },
  ];
  const owner = { appSessionId, userId, eveSessionIds: [] };
  expect(selectLegacySessionRuns(runs, owner)).toEqual([tool, copy, root]);
  expect(() => selectLegacySessionRuns(runs, { ...owner, eveSessionIds: [other] }))
    .toThrow("Conflicting legacy Workflow ownership");
});

test("the local inventory reports a running child and refuses an unknown storage version", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "studio-workflow-inventory-"));
  const runDir = path.join(dataDir, "runs");
  const versionFile = path.join(dataDir, "version.txt");
  try {
    await mkdir(runDir);
    await writeFile(versionFile, "@workflow/world-local@5.1.2");
    const parent = run(root, "workflowEntry", [[1], { kind: 2, serializedContext: 3 }, "initial", {}]);
    const child = run(copy, "workflowEntry", [
      [1], { kind: 2, serializedContext: 3 }, "initial", { "eve.parentSession": 4 },
      { sessionId: 5 }, root,
    ]);
    for (const [item, status] of [[parent, "completed"], [child, "running"]] as const) {
      await writeFile(path.join(runDir, `${item.runId}.json`), JSON.stringify({ ...item, status }));
    }
    const inventory = () => inventoryOwnedLegacyRuns(
      dataDir, { appSessionId, userId, eveSessionIds: [root] }, new AbortController().signal,
    );
    await expect(inventory()).resolves.toEqual(expect.arrayContaining([
      { id: root, sessionId: root, terminal: true }, { id: copy, sessionId: copy, terminal: false },
    ]));
    await writeFile(versionFile, "@workflow/world-local@5.5.1");
    await expect(inventory()).rejects.toThrow("Unsupported local Workflow storage version");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("run-keyed erasure preserves the neighbouring session and is safe to retry", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "studio-workflow-erasure-"));
  const paths = [
    (id: string) => `events/${id}/${id}-evnt_00000000000000000000000001.json`,
    (id: string) => `streams/chunks/strm_${id.slice(5)}_user/chnk_01M824DVAWWHGQ2E27VJJNKK3Y.bin`,
    (id: string) => `snapshots/${id}.snapshot`,
    (id: string) => `hooks/token-index/${"a".repeat(64)}/${id}-evnt_00000000000000000000000002.json`,
  ];
  try {
    await mkdir(path.join(dataDir, "runs"));
    for (const id of [root, copy]) {
      await writeFile(path.join(dataDir, "runs", `${id}.json`), JSON.stringify({
        runId: id, status: "completed", workflowName: "workflow//eve//workflowEntry",
        input: "private input", attributes: { "$eve.title": "private title" },
      }));
      for (const name of paths) {
        const file = path.join(dataDir, name(id));
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, id);
      }
    }
    const signal = new AbortController().signal;
    await expect(eraseLegacyRunFiles(dataDir, [{ id: root, terminal: false }], signal))
      .rejects.toThrow("must be valid and terminal");
    for (const name of paths) await expect(access(path.join(dataDir, name(root)))).resolves.toBeUndefined();

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await eraseLegacyRunFiles(dataDir, [{ id: root, terminal: true }], signal);
    }
    for (const name of paths) {
      await expect(access(path.join(dataDir, name(root)))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(path.join(dataDir, name(copy)), "utf8")).resolves.toBe(copy);
    }
    const target = JSON.parse(await readFile(path.join(dataDir, "runs", `${root}.json`), "utf8"));
    expect(target).toEqual({
      runId: root, status: "completed", workflowName: "workflow//eve//workflowEntry",
      expiredAt: expect.any(String),
    });
    const other = JSON.parse(await readFile(path.join(dataDir, "runs", `${copy}.json`), "utf8"));
    expect(other).toMatchObject({ input: "private input", attributes: { "$eve.title": "private title" } });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("trace erasure preserves an unrelated span in the same exported trace", () => {
  const span = (id: string, text: string) => ({
    traceId: "trace-id-shared-by-two-sessions",
    attributes: [{ key: "gen_ai.conversation.id", value: { stringValue: id } }],
    text,
  });
  const retained = span(copy, "keep this");
  const trace = { resourceSpans: [{ scopeSpans: [{ spans: [span(root, "remove this"), retained] }] }] };
  const result = redactOwnedTraceSpans(trace, new Set([root]));
  expect(result).toEqual({
    removed: 1,
    kept: 1,
    trace: { resourceSpans: [{ scopeSpans: [{ spans: [retained] }] }] },
  });
  expect(redactOwnedTraceSpans(result.trace, new Set([root])).removed).toBe(0);
});
