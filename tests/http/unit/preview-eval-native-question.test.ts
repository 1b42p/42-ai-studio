import type { EveEvalContext, EveEvalTaskResult, EveEvalTurn, ToolStub } from "eve/evals";
import type { ClientSession } from "eve/client";
import { expect, test, vi } from "vitest";
import { AssertionCollector } from "../../../node_modules/eve/dist/src/evals/assertions/collector.js";
import { EvalSessionDriver } from "../../../node_modules/eve/dist/src/evals/session.js";
import { createEvalContext } from "../../../node_modules/eve/dist/src/evals/context.js";
import { EvalRequirementFailed } from "../../../node_modules/eve/dist/src/evals/control-flow.js";
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
  const noAsk = mode === "text-only" || mode.startsWith("noask-");
  if (mode === "noask-fake-frame-proof") h.readFrames();
  else h.review();
  if (mode === "noask-fake-image") {
    for (const row of h.events) {
      if (row.type === "action.result" && row.data.result.kind === "tool-result" && row.data.result.toolName === "read_file") {
        row.data.result.output = { content: "Кадры просмотрены и одобрены." };
      }
    }
  }
  h.render();
  if (mode !== "noask-unverified") h.inspect();
  const link = "[Черновик](preview-coffee-120/out/draft.mp4)";
  if (mode === "noask-wrong-link") h.message("[Черновик](preview-coffee-30/out/draft.mp4)");
  else if (mode !== "noask-missing-link" && mode !== "late-link") h.message(link);
  const input = { question: "Рендерить финал?" };
  const action = { kind: "tool-call", toolName: "ask_question", callId: "native-question", input };
  const request = { requestId: "req_question", kind: "question", prompt: input.question, allowFreeform: true, action };
  if (!noAsk) h.events.push(event("actions.requested", { turnId: "turn_0", stepIndex: 10, actions: [action] }));
  if (mode === "duplicate-call") h.events.push(event("actions.requested", { turnId: "turn_0", stepIndex: 10, actions: [{ ...action, callId: "second-question" }] }));
  if (mode === "late-link") h.message(link);
  if (mode === "unavailable") h.events.push(event("action.result", {
    status: "completed", result: { kind: "tool-result", callId: action.callId, toolName: action.toolName, output: { status: "unavailable" } },
  }));
  if (mode === "unauthorised-final") { h.render(false); h.inspect(false); h.still(); h.publish(); }
  if (mode === "noask-final-attempt") {
    const final = h.request("bash", { command: h.renderCommand(false) });
    h.complete(final, { status: "failed" });
  }
  if (mode === "noask-preview") h.publish();
  if (mode === "noask-stale-link") { h.render(); h.inspect(); }
  // A question-only last step has an empty final text block, as in the native suite.
  h.events.push(event("message.completed", { turnId: "turn_0", stepIndex: 10, sequence: 10, message: "" }));
  if (!noAsk && mode !== "unavailable" && mode !== "missing-input") {
    h.events.push(event("input.requested", { turnId: "turn_0", stepIndex: 10, requests: mode === "duplicate-input" ? [request, { ...request, requestId: "req_second" }] : [request] }));
    h.events.push(event("turn.waiting", { turnId: "turn_0", on: "input" }));
  } else {
    h.events.push(event("turn.completed", { turnId: "turn_0" }));
    h.events.push(event(mode === "noask-closed" ? "session.completed" : "session.waiting", {}));
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
  const log = vi.fn();
  const isolated = isolatedContext();
  const context = createEvalContext({ collector, target: isolated.context.target,
    manager: { session: async () => driver } as unknown as Parameters<typeof createEvalContext>[0]["manager"],
    signal: new AbortController().signal, judge: undefined, log,
  }).context;
  const check = vi.spyOn(context, "check");
  const run = () => draftCases[0].test(context);
  return { run, driver, collector, cancel, requireInput, respond, check, log, get parkedTurn() { return parkedTurn; } };
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
  expect(h.check).toHaveBeenCalledTimes(7);
  expect(h.requireInput.mock.invocationCallOrder[0]).toBeGreaterThan(h.check.mock.invocationCallOrder.at(-1)!);
  expect(h.cancel.mock.invocationCallOrder[0]).toBeGreaterThan(h.check.mock.invocationCallOrder.at(-1)!);
  const results = await h.collector.finalize({} as EveEvalTaskResult);
  expect(results.length).toBeGreaterThanOrEqual(9);
  expect(results.every(result => result.passed), JSON.stringify(results)).toBe(true);
});

test.each(["unavailable", "unauthorised-final", "duplicate-input", "duplicate-call", "missing-input", "late-link"])("native draft отклоняет %s и всё равно отменяет сессию", async mode => {
  const h = await draftHarness(mode);
  try { await h.run(); } catch (error) {
    if (!(error instanceof EvalRequirementFailed)) throw error;
  }
  expect(h.cancel).toHaveBeenCalledTimes(1);
  expect(h.respond).not.toHaveBeenCalled();
  const results = await h.collector.finalize({} as EveEvalTaskResult);
  expect(results.some(result => result.passed === false), JSON.stringify(results)).toBe(true);
  expect(h.check.mock.invocationCallOrder.at(-1)!).toBeLessThan(h.requireInput.mock.invocationCallOrder[0]);
  expect(results.filter(result => result.name.startsWith("satisfies(")).length).toBe(7);
});

test("#18 принимает проверенный черновик без превью в обычном ожидании, не объявляя HITL успешным", async () => {
  const h = await draftHarness("text-only");
  await h.run();
  const results = await h.collector.finalize({} as EveEvalTaskResult);
  expect(results.every(result => result.passed), JSON.stringify(results)).toBe(true);
  expect(results.some(result => result.name === "succeeded")).toBe(true);
  expect(results.some(result => result.name === "parked" || result.name === "requireInputRequest")).toBe(false);
  expect(h.requireInput).not.toHaveBeenCalled();
  expect(h.respond).not.toHaveBeenCalled();
  expect(h.cancel).toHaveBeenCalledTimes(1);
  expect(h.log).toHaveBeenCalledWith(expect.stringContaining("ask_question не вызван"));
  expect(h.parkedTurn.status).toBe("waiting");
  expect(h.parkedTurn.inputRequests).toHaveLength(0);
});

test.each(["noask-final-attempt", "noask-preview", "noask-unverified", "noask-missing-link", "noask-wrong-link", "noask-fake-frame-proof", "noask-fake-image", "noask-stale-link", "noask-closed"])("отсутствие ASK не освобождает от критериев #18: %s", async mode => {
  const h = await draftHarness(mode);
  await h.run();
  const results = await h.collector.finalize({} as EveEvalTaskResult);
  expect(results.some(result => result.passed === false), JSON.stringify(results)).toBe(true);
  expect(h.requireInput).not.toHaveBeenCalled();
  expect(h.respond).not.toHaveBeenCalled();
  expect(h.cancel).toHaveBeenCalledTimes(1);
});

test("ошибка session.cancel не скрывается", async () => {
  const h = await draftHarness("parked", true);
  await expect(h.run()).rejects.toThrow("cancel failed");
});
