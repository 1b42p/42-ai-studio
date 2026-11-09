import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { blockedRead, emptySearch, webSession } from "../web/fixtures";

const ZOO = "https://www.youtube.com/watch?v=jNQXAC9IVRw";

export default Array.from({ length: 3 }, () => defineEval({
  description: "Ошибка входа объясняется пользователю, тот же вызов не повторяется больше двух раз.",
  tags: ["download"],
  timeoutMs: 180_000,
  async test(t) {
    const session = await webSession(t, [
      blockedRead,
      emptySearch,
      {
        id: "download-login",
        tool: "download_video",
        outcome: {
          throw: {
            message: "download_login_required: Видео требует входа в аккаунт. У сервиса нет данных входа, сообщите оператору.",
          },
        },
      },
    ]);
    const turn = await session.send(`Скачай ${ZOO} и возьми кадр на 5 секунде.`);
    const calls = turn.toolCalls.filter((call) => call.name === "download_video");
    t.check(calls.length, satisfies((count: number) => count >= 1 && count <= 2, "один или два вызова"));
    t.judge("Ответ объясняет, что видео требует входа в аккаунт и поэтому не скачано. Ассистент не утверждает, что ролик получен.", {
      on: { reply: turn.message ?? "" },
    }).label("explains-login").gate(0.8);
  },
}));
