import { zstdCompressSync } from "node:zlib";
import { access, cp, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";

import { readLegacyRunLineage, selectLegacySessionRuns } from "@/lib/workflow/legacy-run-lineage";
import { inventoryOwnedLegacyRuns } from "@/lib/workflow/legacy-local-inventory";
import { eraseLegacyRunFiles } from "@/lib/workflow/legacy-local-files";
import { redactOwnedTraceSpans } from "@/lib/workflow/local-trace-redaction";
import { eraseStudioWorkflowData } from "@/lib/workflow/erase-session-data";

const root = "wrun_01M824CP6M7FHHS6MS4CEWEGXJ";
const copy = "wrun_01M824DQ7K63GA1XCCRPMF9849";
const tool = "wrun_01M824DV4SM5EHNT6Z7ZEFXX13";
const appSessionId = "a27ed44c-f122-4c9e-bafc-dd20f364b940";
const userId = "d319496d-226f-487c-9be1-23aa3672d549";

vi.mock(import("node:fs/promises"), async (importOriginal) => {
  const fs = await importOriginal();
  return { ...fs, rename: vi.fn(fs.rename) };
});

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

test("a same-version World containing a successor but no bound root cannot confirm erasure", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "studio-workflow-wrong-store-"));
  try {
    const dataDir = path.join(stateDir, ".workflow-data");
    const runDir = path.join(dataDir, "runs");
    await mkdir(runDir, { recursive: true });
    await writeFile(path.join(dataDir, "version.txt"), "@workflow/world-local@5.1.2");
    const successor = run(copy, "workflowEntry", [[1], { kind: 2, sessionId: 3 }, "handoff", root]);
    const file = path.join(runDir, `${copy}.json`);
    const original = JSON.stringify({ ...successor, status: "completed" });
    await writeFile(file, original);

    await expect(eraseStudioWorkflowData({
      stateDir, owner: { appSessionId, userId, eveSessionIds: [root] },
      signal: new AbortController().signal,
      resetSession: async () => { throw new Error("Unexpected reset"); },
    })).rejects.toThrow("Missing bound Eve root");
    await expect(readFile(file, "utf8")).resolves.toBe(original);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("retry retains the full erasure scope after a partial terminal rewrite", async () => {
  const { rename } = await import("node:fs/promises");
  const realFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const stateDir = await mkdtemp(path.join(tmpdir(), "studio-workflow-retry-"));
  try {
    const dataDir = path.join(stateDir, ".workflow-data");
    const runDir = path.join(dataDir, "runs");
    await mkdir(runDir, { recursive: true });
    await writeFile(path.join(dataDir, "version.txt"), "@workflow/world-local@5.1.2");
    const records = [
      run(root, "workflowEntry", [[1], { kind: 2, serializedContext: 3 }, "initial", {}]),
      run(copy, "workflowEntry", [
        [1], { kind: 2, serializedContext: 3 }, "initial", { "eve.parentSession": 4 },
        { sessionId: 5 }, root,
      ]),
      run(tool, "workflowToolRunWorkflow", [[1], { session: 2 }, { id: 3 }, copy]),
    ];
    const runFile = (id: string) => path.join(runDir, `${id}.json`);
    const readRun = async (id: string) => JSON.parse(await readFile(runFile(id), "utf8"));
    for (const record of records) {
      await writeFile(runFile(record.runId), JSON.stringify({ ...record, status: "completed" }));
    }
    let rewrites = 0;
    let pendingId: string | undefined;
    vi.mocked(rename).mockImplementation(async (from, to) => {
      if (path.dirname(String(to)) === runDir && ++rewrites === 3) {
        pendingId = path.basename(String(to), ".json");
        throw new Error("Interrupted terminal rewrite");
      }
      await realFs.rename(from, to);
    });
    const erase = (dir: string) => eraseStudioWorkflowData({
      stateDir: dir, owner: { appSessionId, userId, eveSessionIds: [root] },
      signal: new AbortController().signal,
      resetSession: async () => { throw new Error("Unexpected reset"); },
    });

    await expect(erase(stateDir)).rejects.toThrow("Interrupted terminal rewrite");
    expect(pendingId).toBeDefined();
    expect(await readRun(pendingId!)).toHaveProperty("input");
    // Exercise a retry of cleanup for a child whose record no longer has lineage.
    const scrubbedChild = pendingId === copy ? tool : copy;
    const residual = path.join(dataDir, "events", scrubbedChild, `${scrubbedChild}-residual.json`);
    await mkdir(path.dirname(residual), { recursive: true });
    await writeFile(residual, "private data");
    const fence = path.join(dataDir, ".locks", "runs", `${scrubbedChild}.terminal`);
    await mkdir(path.dirname(fence), { recursive: true });
    await writeFile(fence, "terminal fence");
    const wrongDir = path.join(stateDir, "other-world");
    await mkdir(path.join(wrongDir, ".workflow-data", "runs"), { recursive: true });
    await writeFile(path.join(wrongDir, ".workflow-data", "version.txt"), "@workflow/world-local@5.1.2");
    await expect(erase(wrongDir)).rejects.toThrow("Missing bound Eve root");

    const incompleteDir = path.join(stateDir, "incomplete-world");
    const incompleteDataDir = path.join(incompleteDir, ".workflow-data");
    await cp(dataDir, incompleteDataDir, { recursive: true });
    await unlink(path.join(incompleteDataDir, "runs", `${tool}.json`));
    await expect(erase(incompleteDir)).rejects.toThrow("Missing or changed captured local Workflow run");

    await erase(stateDir);
    await expect(access(residual)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(fence, "utf8")).resolves.toBe("terminal fence");
    for (const record of records) {
      const terminal = await readRun(record.runId);
      expect(terminal).not.toHaveProperty("input");
      expect(terminal).toMatchObject({ runId: record.runId, status: "completed" });
    }
    await expect(erase(stateDir)).resolves.toBeUndefined();
  } finally {
    vi.mocked(rename).mockReset();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("an unbound start remains pending without its owned root and is erasable when the root appears", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "studio-workflow-unbound-"));
  try {
    const dataDir = path.join(stateDir, ".workflow-data");
    const runDir = path.join(dataDir, "runs");
    await mkdir(runDir, { recursive: true });
    await writeFile(path.join(dataDir, "version.txt"), "@workflow/world-local@5.1.2");
    const erase = () => eraseStudioWorkflowData({
      stateDir, owner: { appSessionId, userId, eveSessionIds: [] },
      signal: new AbortController().signal,
      resetSession: async () => { throw new Error("Unexpected reset"); },
    });
    await expect(erase()).rejects.toThrow("Missing owned Eve root");

    const initial = run(root, "workflowEntry", [
      [1], { kind: 2, serializedContext: 3 }, "initial", { "eve.initiatorAuth": 4 },
      { authenticator: 5, principalType: 6, principalId: 7, attributes: 8 },
      "studio", "user", userId, { appSessionId: 9 }, appSessionId,
    ]);
    const file = path.join(runDir, `${root}.json`);
    await writeFile(file, JSON.stringify({ ...initial, status: "completed" }));
    await erase();
    expect(JSON.parse(await readFile(file, "utf8"))).not.toHaveProperty("input");
    await expect(erase()).resolves.toBeUndefined();
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
