import type { EveEvalContext, EveEvalTurn } from "eve/evals";
import { satisfies } from "eve/evals/expect";
import { framesBeforeFullRender, videoLinks } from "../video/observations";
import { SCENES } from "./fixtures";

export function assertVoiceoverAssembly(t: EveEvalContext, turn: EveEvalTurn) {
  t.loadedSkill("frame-review");
  t.check(framesBeforeFullRender(turn.events), satisfies((value: boolean) => value,
    "не меньше четырёх разных кадров просмотрены после правок и до полного рендера"));
  for (const [index] of SCENES.entries()) {
    const path = new RegExp(`scene-0?${index + 1}(?:-piper)?\\.words\\.json`, "u");
    const read = turn.toolCalls.some((call) => call.status === "completed" &&
      (call.name === "read_file" && typeof call.input.filePath === "string" && path.test(call.input.filePath) ||
       call.name === "bash" && typeof call.input.command === "string" &&
       /\b(?:cat|readFile(?:Sync)?|open)\b/u.test(call.input.command) && path.test(call.input.command)));
    t.check(read, satisfies((value: boolean) => value, `прочитаны тайминги сцены ${index + 1}`));
  }
  t.check(videoLinks(turn.message), satisfies((links: string[]) => links.length > 0, "итоговая ссылка на MP4 в песочнице"));
}
