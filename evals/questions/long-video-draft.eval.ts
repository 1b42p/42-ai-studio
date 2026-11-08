import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";
import { isDraft, isFinal, questionSession, renderCommands, REQUEST, TIMEOUT } from "./fixtures";

export default Array.from({ length: 3 }, () => defineEval({
  timeoutMs: TIMEOUT, tags: ["questions"], description: "Двухминутный ролик ждёт ответа после черновика.",
  async test(t) {
    const session = await questionSession(t);
    const draft = await session.send(REQUEST(120));
    draft.parked();
    const commands = renderCommands(draft);
    t.check(commands.some(isDraft) && !commands.some(isFinal), equals(true));
    const request = session.requireInputRequest({ toolName: "ask_question", prompt: /Рендерить финал/ });
    t.check(request.options?.map((option) => option.label), equals(["Рендерить финал", "Хочу поправить"]));
    t.check(/\.mp4/.test(draft.message ?? ""), equals(true));
    const final = await session.respond([{ requestId: request.requestId, text: "Рендерить финал" }]);
    final.succeeded();
    t.check(renderCommands(final).some(isFinal), equals(true));
    t.check(/\]\([^)]*\.mp4\)/.test(final.message ?? ""), equals(true));
    t.succeeded();
  },
}));
