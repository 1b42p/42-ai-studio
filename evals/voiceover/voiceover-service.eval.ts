import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";
import { videoLinks } from "../video/observations";
import { SCENES, VOICE, VOICEOVER_REQUEST, VOICEOVER_TIMEOUT_MS, voiceoverSession } from "./fixtures";

export default Array.from({ length: 3 }, () => defineEval({
  description: "Три сцены с серверной озвучкой и субтитрами завершаются ссылкой на MP4.",
  tags: ["voiceover", "voiceover-service"],
  timeoutMs: VOICEOVER_TIMEOUT_MS,
  async test(t) {
    const session = await voiceoverSession(t, false);
    const turn = await session.send(VOICEOVER_REQUEST);
    t.succeeded();
    t.loadedSkill("voiceover");
    t.calledTool("speak", { count: (count) => count >= 3 });
    for (const text of SCENES) t.calledTool("speak", { input: { text }, output: { voice: VOICE } });
    t.check(videoLinks(turn.message), satisfies((links: string[]) => links.length > 0, "итоговая ссылка на MP4 в песочнице"));
  },
}));
