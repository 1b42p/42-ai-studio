import { defineEval } from "eve/evals";
import {
  MUSIC_REQUEST,
  MUSIC_TIMEOUT_MS,
  musicFinalLink,
  musicSession,
  musicWorkflowGates,
} from "./fixtures";

export default Array.from({ length: 3 }, () =>
  defineEval({
    description: "Ролик с озвучкой и спокойной фоновой музыкой, которая приглушается во время речи.",
    tags: ["music", "music-bed"],
    timeoutMs: MUSIC_TIMEOUT_MS,
    async test(t) {
      const session = await musicSession(t);
      const turn = await session.send(MUSIC_REQUEST);
      t.succeeded();
      t.loadedSkill("music-synthesis");
      t.loadedSkill("voiceover");
      t.loadedSkill("frame-review");
      const gates = musicWorkflowGates(turn.events);
      for (const [stage, passed] of Object.entries(gates)) {
        t.score(passed ? 1 : 0).label(`workflow-${stage}`).gate();
      }
      t.score(musicFinalLink(turn.message) ? 1 : 0).label("final-video-link").gate();
      t.judge(
        "Да — только если итоговое сообщение прямо сообщает оба факта: музыка спокойная и во время речи она звучит тише. Сообщение только про спокойную музыку, без фразы про тише во время речи, — нет. Точное число децибел не обязательно.",
        { on: turn.message ?? "" },
      ).gate(0.8);
    },
  }),
);
