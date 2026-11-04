import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";
import { VIDEO_REQUEST, videoSession } from "./fixtures";

export default Array.from({ length: 3 }, () => defineEval({
  description: "Недосказанная просьба вызывает вопросы; полная — работу без повторных вопросов.",
  tags: ["video", "clarify"],
  async test(t) {
    const session = await videoSession(t);
    const clarification = await session.send("Сделай ролик");
    clarification.succeeded();
    clarification.notCalledTool("bash");
    clarification.notCalledTool("edit_file");
    clarification.notCalledTool("agent");
    t.check(clarification.message, includes("?"));
    t.judge("На просьбу «Сделай ролик» агент задаёт вопросы о теме, длительности или формате, " +
      "не больше трёх вопросов одним сообщением, предлагает варианты и ждёт ответа. " +
      "Не начинает производство ролика и не выдаёт его за готовый.",
    { on: clarification.message ?? "" }).gate(0.8);

    const production = await clarification.session.send(VIDEO_REQUEST);
    production.succeeded();
    production.calledTool("bash");
    t.judge("Пользователь дал полную просьбу о 30-секундном вертикальном ролике 9:16 " +
      "об утренней зарядке, без озвучки, три сцены. Агент не задаёт новых уточняющих вопросов " +
      "и не ждёт согласования, а приступает к выполнению. Предложение внести правки после " +
      "готового результата не является уточнением до начала работы.",
    { on: { response: production.message ?? "", bashCalls: production.toolCalls.filter((call) => call.name === "bash").length } }).gate(0.8);
    t.succeeded();
  },
}));
