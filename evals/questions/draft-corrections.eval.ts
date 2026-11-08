import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";
import { isDraft, isFinal, questionSession, renderCommands, REQUEST, TIMEOUT } from "./fixtures";

export default Array.from({ length: 3 }, () => defineEval({
  timeoutMs: TIMEOUT, tags: ["questions"], description: "Правка заголовка вызывает новый черновик и новый вопрос.",
  async test(t) {
    const session = await questionSession(t);
    const first = await session.send(REQUEST(120));
    first.parked();
    t.check(renderCommands(first).some(isDraft), equals(true));
    const initialRenders = new Set(renderCommands(first));
    const initialEdits = new Set(first.toolCalls.filter((call) => call.name === "edit_file").map((call) => JSON.stringify(call.input)));
    const request = session.requireInputRequest({ toolName: "ask_question", prompt: /Рендерить финал/ });
    const corrected = await session.respond([{ requestId: request.requestId, text: "Поправь заголовок на «Утро начинается с кофе»" }]);
    corrected.parked();
    // A response includes calls completed in that stream slice and spanning
    // workflow calls, so compare captured inputs rather than cumulative counts.
    t.check(corrected.toolCalls.some((call) => call.name === "edit_file" && !initialEdits.has(JSON.stringify(call.input))), equals(true));
    t.check(renderCommands(corrected).some((command) => isDraft(command) && !initialRenders.has(command)) &&
      !renderCommands(corrected).some(isFinal), equals(true));
    t.check(renderCommands(corrected).some((command) => isDraft(command) && command.includes("props-v2.json")), equals(true));
    const next = session.requireInputRequest({ toolName: "ask_question", prompt: /Рендерить финал/ });
    t.check(next.requestId !== request.requestId, equals(true));
    t.parked();
  },
}));
