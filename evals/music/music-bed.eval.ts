import { defineEval } from "eve/evals";
import { MUSIC_TIMEOUT_MS, musicSession } from "./fixtures";

const REQUEST = "ролик на 20 секунд с озвучкой и спокойной фоновой музыкой";

export default Array.from({ length: 3 }, () =>
  defineEval({
    description: "Ролик с озвучкой и спокойной фоновой музыкой, которая приглушается во время речи.",
    tags: ["music", "music-bed"],
    timeoutMs: MUSIC_TIMEOUT_MS,
    async test(t) {
      const session = await musicSession(t);
      const turn = await session.send(REQUEST);
      t.succeeded();
      t.loadedSkill("music-synthesis");
      t.loadedSkill("voiceover");
      t.calledTool("bash", { input: { command: /make_music\.py/ } });
      t.judge(
        "Засчитывай сообщение, в котором ролик готов, названо спокойное настроение музыки и сказано, что во время речи она звучит тише. " +
          "Слово «приглушение» и точное число децибел не обязательны. Сообщение, где ролика нет или музыка не свелась, не засчитывай.",
        { on: turn.message ?? "" },
      ).gate(0.8);
    },
  }),
);
