import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

import { questionSession, REQUEST, TIMEOUT } from "./fixtures";

export default Array.from({ length: 3 }, () => defineEval({
  timeoutMs: TIMEOUT,
  description: "Недосказанная просьба вызывает вопросы; полная — работу без повторных вопросов.",
  tags: ["video", "clarify"],
  async test(t) {
    const session = await questionSession(t, 30);
    const clarification = await session.send("Сделай ролик");
    clarification.parked();
    session.requireInputRequest({ toolName: "ask_question" });
    clarification.notCalledTool("bash");
    clarification.notCalledTool("edit_file");
    clarification.notCalledTool("agent");

    t.judge("На просьбу «Сделай ролик» агент задаёт вопросы о теме, длительности или формате, " +
      "задаёт один вопрос инструментом и ждёт ответа. " +
      "Не начинает производство ролика и не выдаёт его за готовый.",
    { on: JSON.stringify({ message: clarification.message, requests: clarification.inputRequests }) }).gate(0.8);

    const brief = REQUEST(30);
    const production = await session.respond([{ requestId: session.requireInputRequest({ toolName: "ask_question" }).requestId, text: brief }]);
    production.succeeded();
    production.calledTool("bash");
    // Respond resumes the same turn: its toolCalls include the original question.
    t.check(production.toolCalls.filter((call) => call.name === "ask_question").length,
      equals(clarification.toolCalls.filter((call) => call.name === "ask_question").length));
    // respond() preserves the initial send() prompt in the judge's default
    // state. Supply the actual answered brief so it cannot grade the finished
    // video as an unclarified response to the initial "Сделай ролик".
    t.judge({
      state: { question: clarification.inputRequests, userAnswer: brief,
        response: production.message ?? "", bashCalls: production.toolCalls.filter((call) => call.name === "bash").length },
      questions: { continues: { type: "boolean", instructions:
        "После ответа userAnswer пользователь дал полную просьбу о 30-секундном горизонтальном ролике 16:9 " +
        "о кофе, без озвучки, три сцены. Агент не задаёт новых уточняющих вопросов " +
        "и не ждёт согласования, а приступает к выполнению. Готовый результат с вызовами bash тоже " +
        "подтверждает выполнение. Предложение внести правки после готового результата не является уточнением до начала работы." } },
    }).continues.gate(0.8);
    t.succeeded();
  },
}));
