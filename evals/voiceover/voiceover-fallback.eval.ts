import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";
import { videoLinks } from "../video/observations";
import { assertVoiceoverAssembly } from "./assertions";
import { piperScenes } from "./observations";
import {
  VOICEOVER_CATALOG_FAILURE_REQUEST,
  VOICEOVER_TIMEOUT_MS,
  voiceoverSession,
} from "./fixtures";

export default Array.from({ length: 3 }, () =>
  defineEval({
    description:
      "При отказе каталога агент пробует стандартный speak, а при отказе синтеза озвучивает все сцены через Piper.",
    tags: ["voiceover", "voiceover-fallback"],
    timeoutMs: VOICEOVER_TIMEOUT_MS,
    async test(t) {
      const session = await voiceoverSession(t, true);
      const turn = await session.send(VOICEOVER_CATALOG_FAILURE_REQUEST);
      t.succeeded();
      t.loadedSkill("voiceover");
      turn.calledTool("list_voices", { status: "failed", count: 1 });
      const catalogFailedAt = turn.events.findIndex(event => event.type === "action.result" &&
        event.data.status === "failed" && event.data.result.kind === "tool-result" &&
        event.data.result.toolName === "list_voices");
      const defaultSpeechAt = turn.events.findIndex(event => event.type === "actions.requested" &&
        event.data.actions.some(action => action.kind === "tool-call" && action.toolName === "speak" &&
          action.input.voice === undefined && [undefined, "ru", "ru-RU"].includes(action.input.language as string | undefined)));
      t.check(catalogFailedAt >= 0 && defaultSpeechAt > catalogFailedAt,
        satisfies(Boolean, "стандартный русский speak вызван после отказа каталога"));
      // Ожидаемый throw — часть сценария, поэтому noFailedActions здесь неприменим.
      t.calledTool("speak", {
        status: "failed",
        count: (count) => count >= 1 && count <= 3,
      });
      t.calledTool("bash", {
        status: "completed",
        input: {
          command:
            /^(?=[\s\S]*piper_speak\.py)(?=[\s\S]*--text-file)(?=[\s\S]*--out)(?=[\s\S]*--voice)/u,
        },
      });
      t.check(
        piperScenes(turn.toolCalls),
        satisfies(
          (scenes: number[]) => scenes.join() === "1,2,3",
          "Piper вызван для каждой из трёх сцен, отдельно или пакетной командой",
        ),
      );
      assertVoiceoverAssembly(t, turn);
      // Без MP4 случай уже не проходит; отдельный запрос судье здесь не нужен.
      await t.require(
        videoLinks(turn.message),
        satisfies(
          (links: string[]) => links.length > 0,
          "итоговая ссылка на MP4 в песочнице",
        ),
      );
      t.judge(
        "Итоговый ответ сообщает пользователю, что озвучка выполнена запасным способом " +
           "из-за недоступности основного сервиса и называет фактически использованный голос. " +
          "Недостаточно обещания попробовать запасной способ, предложения пользователю сделать это самому " +
          "или сообщения, что озвучки нет. Техническое название Piper необязательно.",
        { on: turn.message ?? "" },
      ).gate(0.8);
    },
  }),
);
