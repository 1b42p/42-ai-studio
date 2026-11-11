// Persist only tool inputs, action ordering and reviewed native rule IDs.
// Provider requests, judges, trace contexts and headers are never copied.
import { readFileSync, writeFileSync } from "node:fs";
import { StubPlayback } from "../../../node_modules/eve/dist/src/tool-stubs/playback.js";
import { allMusicStubs } from "../../../tests/http/unit/music-eval-support";

async function main() {
const report = JSON.parse(readFileSync(process.argv[2], "utf8"));
const rules = await allMusicStubs();
const cases = report.results.map((item: { result: { events: { type: string; data: any }[] } }, index: number) => {
  const playback = new StubPlayback(rules);
  const calls: unknown[] = [];
  const events: unknown[] = [];
  const toolNames = new Map<string, string>();
  item.result.events.forEach((event, at) => {
    if (event.type === "actions.requested") {
      const actions = event.data.actions.map((action: any) => {
        if (action.kind !== "tool-call") return { kind: action.kind, callId: action.callId, name: action.name };
        toolNames.set(action.callId, action.toolName);
        const answer = playback.call({ callId: action.callId, tool: action.toolName, input: action.input });
        if (answer.kind !== "stub") throw new Error("Real tool execution is not allowed");
        calls.push({ callId: action.callId, tool: action.toolName, input: action.input, rule: answer.ruleId,
          error: "throw" in answer.outcome, exitCode: "response" in answer.outcome ? (answer.outcome.response as { exitCode?: number }).exitCode : undefined });
        return { kind: action.kind, callId: action.callId, toolName: action.toolName, input: action.input };
      });
      events.push({ at, type: event.type, data: { actions } });
    }
    if (event.type === "action.result") {
      const result = event.data.result;
      if (result.kind === "tool-result" && toolNames.has(result.callId)) events.push({ at, type: event.type, data: {
        status: event.data.status, result: { kind: result.kind, callId: result.callId, toolName: toolNames.get(result.callId) },
      } });
      if (result.kind === "load-skill-result") events.push({ at, type: event.type, data: {
        status: event.data.status, result: { kind: result.kind, callId: result.callId, name: result.name },
      } });
    }
  });
  return { index, calls, events };
});
writeFileSync(process.argv[3] ?? "evals/fixtures/music/history-v2.json", JSON.stringify({ cases }, null, 2) + "\n");
console.log(cases.map((scenario: { calls: unknown[] }) => scenario.calls.length));
}
void main();
