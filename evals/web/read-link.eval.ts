import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";
import { ARTICLE_URL, assertWebOnly, blockedRead, emptySearch, readStub, webSession } from "./fixtures";

export default Array.from({ length: 3 }, () => defineEval({
  description: "Ссылка пользователя читается серверным read_page, без команд песочницы.",
  tags: ["web", "read-link"],
  async test(t) {
    const session = await webSession(t, [
      readStub("article", ARTICLE_URL, "Утренняя прогулка", "Утренняя прогулка помогает начать день с умеренной физической нагрузки. Дневной свет поддерживает регулярный режим сна. Начать можно с десятиминутной прогулки и постепенно увеличить время."),
      blockedRead, emptySearch,
    ]);
    const turn = await session.send(`Кратко перескажи статью по-русски: ${ARTICLE_URL}. Видео пока не делай.`);
    assertWebOnly(t);
    t.calledTool("read_page", { input: { url: ARTICLE_URL } });
    t.check(turn.message, includes(/прогул|дневн.*свет/iu));
  },
}));
