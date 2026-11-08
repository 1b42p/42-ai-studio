import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";
import { questionSession, REQUEST, TIMEOUT } from "./fixtures";

export default Array.from({ length: 3 }, () => defineEval({
  timeoutMs: TIMEOUT, tags: ["questions"], description: "Вопросы по одному, с вариантами или свободным ответом.",
  async test(t) {
    const session = await questionSession(t, 30);
    let turn = await session.send("Сделай ролик про кофе");
    turn.parked();
    for (let count = 0; count < 3; count++) {
      const request = session.requireInputRequest({ toolName: "ask_question" });
      t.check(!request.options || request.options.length >= 2 && request.options.length <= 3, equals(true));
      turn = await session.respond([{ requestId: request.requestId, text: REQUEST(30) }]);
      if (turn.status !== "waiting" || turn.inputRequests.length === 0) break;
    }
    turn.succeeded();
    turn.calledTool("bash");
    t.succeeded();
  },
}));
