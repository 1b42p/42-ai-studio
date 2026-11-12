import type { EveEvalContext, EveEvalTaskResult, EveEvalTurn, ToolStub } from "eve/evals";
import type { ClientSession } from "eve/client";
import { expect, test, vi } from "vitest";
import { AssertionCollector } from "../../../node_modules/eve/dist/src/evals/assertions/collector.js";
import { EvalSessionDriver } from "../../../node_modules/eve/dist/src/evals/session.js";
import { createEvalContext } from "../../../node_modules/eve/dist/src/evals/context.js";
import { webSession, blockedRead, emptySearch } from "../../../evals/web/fixtures";
import { previewSession } from "../../../evals/preview/fixtures";
import draftCases from "../../../evals/preview/preview-draft.eval";
import { event, previewHistory } from "./preview-eval-support";

const names = ["bash", "read_file", "edit_file", "agent", "ask_question", "speak", "list_voices", "download_video", "read_page", "web_search", "set_session_preview"];
function isolatedContext(extra: string[] = [], dynamic: unknown[] = []) {
  const session = vi.fn(async (_options: { stubs: readonly ToolStub[] }) => ({}));
  const context = { target: { fetch: async (path: string) => path === "/api/health"
    ? new Response(null, { headers: { "x-studio-eval-runtime": "stub" } })
    : Response.json({ tools: { static: [...names, ...extra].map(name => ({ name })), dynamic } }) }, session } as unknown as EveEvalContext;
  return { context, session };
}

test.each([undefined, false, true])("webSession allowNativeQuestion=%s: default сохраняет unavailable, opt-in удаляет все правила вопроса", async allowed => {
  const { context, session } = isolatedContext();
  const questions: ToolStub[] = [
    { id: "specific-question", tool: "ask_question", match: { question: { const: "Q" } }, outcome: { response: {} } },
    { id: "other-question", tool: "ask_question", outcome: { response: { status: "unavailable" } } },
  ];
  await webSession(context, [blockedRead, emptySearch, ...questions], allowed === undefined ? undefined : { allowNativeQuestion: allowed });
  const stubs = session.mock.calls[0][0].stubs;
  expect(stubs.filter(stub => stub.tool === "ask_question")).toEqual(allowed ? [] : questions);
  expect(stubs.length).toBeLessThanOrEqual(100);
  for (const name of names.filter(name => name !== "ask_question")) {
    expect(stubs.some(stub => stub.tool === name && stub.match === undefined), name).toBe(true);
  }
});

test.each([30, 120])("исключение native question включено только для preview %s", async seconds => {
  const { context, session } = isolatedContext();
  await previewSession(context, seconds);
  const questions = session.mock.calls[0][0].stubs.filter(stub => stub.tool === "ask_question");
  expect(questions).toEqual(seconds === 120 ? [] : [expect.objectContaining({
    id: "isolate-question", outcome: { response: { status: "unavailable" } },
  })]);
});

test.each([false, true])("allowNativeQuestion=%s не допускает неизвестные, dynamic или только условно подменённые инструменты", async allowed => {
  for (const [extra, dynamic, stubs] of [
    [["new_effect"], [], []],
    [[], [{ name: "ask_question" }], []],
    [["new_effect"], [], [{ id: "conditional", tool: "new_effect", match: { x: { const: 1 } }, outcome: { response: {} } }]],
  ] as [string[], unknown[], ToolStub[]][]) {
    const { context, session } = isolatedContext(extra, dynamic);
    await expect(webSession(context, [blockedRead, emptySearch, ...stubs], { allowNativeQuestion: allowed })).rejects.toThrow("изолированы");
    expect(session).not.toHaveBeenCalled();
  }
});

test("native question не снимает предел 100 правил", async () => {
  const { context, session } = isolatedContext();
  const stubs: ToolStub[] = Array.from({ length: 101 }, (_, i) => ({
    id: `extra-${i}`, tool: "read_page", match: { url: { const: String(i) } }, outcome: { response: {} },
  }));
  await expect(webSession(context, [blockedRead, emptySearch, ...stubs], { allowNativeQuestion: true })).rejects.toThrow("100");
  expect(session).not.toHaveBeenCalled();
});

async function draftHarness(mode = "parked", cleanupError = false) {
  const h = await previewHistory(120);
  h.events.push(event("actions.requested", { turnId: "turn_0", stepIndex: 0, actions: [{ kind: "load-skill", callId: "load-review", name: "frame-review" }] }));
  h.events.push(event("action.result", { status: "completed", result: { kind: "load-skill-result", callId: "load-review", name: "frame-review", output: {} } }));
  h.review(); h.render(); h.inspect();
  h.message("[Черновик](preview-coffee-120/out/draft.mp4)");
  const input = { question: "Рендерить финал?" };
  const action = { kind: "tool-call", toolName: "ask_question", callId: "native-question", input };
  const request = { requestId: "req_question", kind: "question", prompt: input.question, allowFreeform: true, action };
  h.events.push(event("actions.requested", { turnId: "turn_0", stepIndex: 10, actions: [action] }));
  if (mode === "unavailable") h.events.push(event("action.result", {
    status: "completed", result: { kind: "tool-result", callId: action.callId, toolName: action.toolName, output: { status: "unavailable" } },
  }));
  if (mode === "text-only") h.events.pop();
  if (mode === "unauthorised-final") { h.render(false); h.inspect(false); h.still(); h.publish(); }
  // A question-only last step has an empty final text block, as in the native suite.
  h.events.push(event("message.completed", { turnId: "turn_0", stepIndex: 10, sequence: 10, message: "" }));
  if (mode !== "text-only" && mode !== "unavailable") {
    h.events.push(event("input.requested", { turnId: "turn_0", stepIndex: 10, requests: mode === "duplicate-input" ? [request, { ...request, requestId: "req_second" }] : [request] }));
    h.events.push(event("turn.waiting", { turnId: "turn_0", on: "input" }));
  } else {
    h.events.push(event("turn.completed", { turnId: "turn_0" }));
    h.events.push(event("session.waiting", {}));
  }
  const collector = new AssertionCollector();
  const cancel = vi.fn(async () => {
    if (cleanupError) throw new Error("cancel failed");
    // Cleanup advances the live session, not the immutable evaluated turn.
    await driver.consume((async function* () {
      yield { ...event("turn.cancelled", { turnId: "turn_0" }), meta: { at: "2026-11-12T00:01:00.000Z", id: "cancelled" } };
      yield { ...event("session.waiting", {}), meta: { at: "2026-11-12T00:01:00.000Z", id: "after-cancel" } };
    })()).result();
    return { status: "accepted" };
  });
  const client = { state: { sessionId: "unit-preview" }, cancel } as unknown as ClientSession;
  const driver = new EvalSessionDriver({ collector, primary: true, session: client, onTurn() {} });
  let parkedTurn: EveEvalTurn;
  vi.spyOn(driver, "send").mockImplementation(async () => {
    parkedTurn = await driver.consume((async function* () {
      for (const [index, row] of h.events.entries()) yield {
        ...row, meta: { at: "2026-11-12T00:00:00.000Z", id: `evt-${index}` },
      };
    })()).result();
    return parkedTurn;
  });
  const requireInput = vi.spyOn(driver, "requireInputRequest");
  const respond = vi.spyOn(driver, "respond");
  const isolated = isolatedContext();
  const context = createEvalContext({ collector, target: isolated.context.target,
    manager: { session: async () => driver } as unknown as Parameters<typeof createEvalContext>[0]["manager"],
    signal: new AbortController().signal, judge: undefined, log() {},
  }).context;
  const check = vi.spyOn(context, "check");
  const run = () => draftCases[0].test(context);
  return { run, driver, collector, cancel, requireInput, respond, check, get parkedTurn() { return parkedTurn; } };
}

test("настоящий Eve EvalSessionDriver проверяет parked/pending/open input и сохраняет снимок после cleanup", async () => {
  const h = await draftHarness();
  await h.run();
  expect(h.cancel).toHaveBeenCalledTimes(1);
  expect(h.respond).not.toHaveBeenCalled();
  expect(h.requireInput).toHaveBeenCalledWith({ toolName: "ask_question" });
  expect(h.parkedTurn.message).toBe("");
  expect(h.parkedTurn.toolCalls.find(call => call.name === "ask_question")?.status).toBe("pending");
  expect(h.parkedTurn.events.some(row => row.type === "turn.cancelled")).toBe(false);
  expect(h.driver.events.some(row => row.type === "turn.cancelled")).toBe(true);
  expect(h.check).toHaveBeenCalledTimes(5);
  expect(h.cancel.mock.invocationCallOrder[0]).toBeGreaterThan(h.check.mock.invocationCallOrder.at(-1)!);
  const results = await h.collector.finalize({} as EveEvalTaskResult);
  expect(results.length).toBeGreaterThanOrEqual(9);
  expect(results.every(result => result.passed), JSON.stringify(results)).toBe(true);
});

test.each(["text-only", "unavailable", "unauthorised-final", "duplicate-input"])("native draft отклоняет %s и всё равно отменяет сессию", async mode => {
  const h = await draftHarness(mode);
  try { await h.run(); } catch { /* requireInputRequest throws after recording its failed gate. */ }
  expect(h.cancel).toHaveBeenCalledTimes(1);
  expect(h.respond).not.toHaveBeenCalled();
  const results = await h.collector.finalize({} as EveEvalTaskResult);
  expect(results.some(result => result.passed === false), JSON.stringify(results)).toBe(true);
});

test("ошибка session.cancel не скрывается", async () => {
  const h = await draftHarness("parked", true);
  await expect(h.run()).rejects.toThrow("cancel failed");
});
