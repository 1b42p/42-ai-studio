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
    const request = session.requireInputRequest({ toolName: "ask_question", prompt: /Рендерить финал/ });
    const corrected = await session.respond([{ requestId: request.requestId, text: "Поправь заголовок на «Утро начинается с кофе»" }]);
    corrected.parked();
    // Responses continue the same turn, so counts include the original draft.
    t.check(corrected.toolCalls.filter((call) => call.name === "edit_file").length >
      first.toolCalls.filter((call) => call.name === "edit_file").length, equals(true));
    t.check(renderCommands(corrected).filter(isDraft).length > renderCommands(first).filter(isDraft).length &&
      !renderCommands(corrected).some(isFinal), equals(true));
    const next = session.requireInputRequest({ toolName: "ask_question", prompt: /Рендерить финал/ });
    t.check(next.requestId !== request.requestId, equals(true));
    t.parked();
  },
}));
