import { defineEval } from "eve/evals";
import { documentSession } from "./fixtures";

const path = "/workspace/.eve/attachments/ab12/deck.pptx";

export default Array.from({ length: 3 }, () => defineEval({
  description: "Агент читает приложенную PPTX штатным скриптом до вопросов о ролике.",
  tags: ["documents", "loads-skill", "pptx"],
  async test(t) {
    const session = await documentSession(t, path);
    await session.send(`Сделай ролик по презентации. К сообщению приложен файл ${path}.`);
    t.succeeded();
    t.noFailedActions();
    t.loadedSkill("reading-documents");
    t.calledTool("bash", { input: { command: (value: unknown) =>
      typeof value === "string" && value.includes("inspect_document.py") && value.includes(path) } });
  },
}));
