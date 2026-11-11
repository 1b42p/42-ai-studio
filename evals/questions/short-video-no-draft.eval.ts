import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";
import { isDraft, isFinal, questionSession, renderCommands, REQUEST, TIMEOUT } from "./fixtures";

export default Array.from({ length: 3 }, () => defineEval({
  timeoutMs: TIMEOUT, tags: ["questions"], description: "30 секунд: финал без черновика и вопроса о рендере.",
  async test(t) {
    const session = await questionSession(t, 30);
    const turn = await session.send(REQUEST(30));
    turn.succeeded();
    turn.notCalledTool("ask_question");
    t.check(!renderCommands(turn).some(isDraft) && renderCommands(turn).some(isFinal), equals(true));
    t.succeeded();
  },
}));
