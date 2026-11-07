import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";
import { videoLinks } from "../video/observations";
import { assertVoiceoverAssembly } from "./assertions";
import { piperScenes } from "./observations";
import { VOICEOVER_REQUEST, VOICEOVER_TIMEOUT_MS, voiceoverSession } from "./fixtures";

export default Array.from({ length: 3 }, () => defineEval({
  description: "При speak_unavailable агент использует Piper и сообщает о другом запасном голосе.",
  tags: ["voiceover", "voiceover-fallback"],
  timeoutMs: VOICEOVER_TIMEOUT_MS,
  async test(t) {
    const session = await voiceoverSession(t, true);
    const turn = await session.send(VOICEOVER_REQUEST);
    t.succeeded();
    t.loadedSkill("voiceover");
    // Ожидаемый throw — часть сценария, поэтому noFailedActions здесь неприменим.
    t.calledTool("speak", { status: "failed", count: (count) => count >= 1 && count <= 3 });
    t.calledTool("bash", { status: "completed", input: {
      command: /^(?=[\s\S]*piper_speak\.py)(?=[\s\S]*--text-file)(?=[\s\S]*--out)(?=[\s\S]*--voice)/u,
    } });
    t.check(piperScenes(turn.toolCalls), satisfies((scenes: number[]) => scenes.join() === "1,2,3",
      "Piper вызван для каждой из трёх сцен, отдельно или пакетной командой"));
    assertVoiceoverAssembly(t, turn);
    // Без MP4 случай уже не проходит; отдельный запрос судье здесь не нужен.
    await t.require(videoLinks(turn.message), satisfies((links: string[]) => links.length > 0, "итоговая ссылка на MP4 в песочнице"));
    t.judge("Итоговый ответ сообщает пользователю, что озвучка выполнена запасным способом " +
      "из-за недоступности основного сервиса и голос отличается от выбранной Светланы. " +
      "Недостаточно обещания попробовать запасной способ, предложения пользователю сделать это самому " +
      "или сообщения, что озвучки нет. Техническое название Piper необязательно.",
    { on: turn.message ?? "" }).gate(0.8);
  },
}));
