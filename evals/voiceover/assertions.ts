import type { EveEvalContext, EveEvalTurn } from "eve/evals";
import { satisfies } from "eve/evals/expect";
import fixture from "../fixtures/voiceover/project.json";
import { videoLinks } from "../video/observations";
import { framePaths, PROJECT } from "./fixtures";
import { sceneTimingsAfterSynthesis, voiceoverEvidence } from "./observations";

export function assertVoiceoverAssembly(t: EveEvalContext, turn: EveEvalTurn) {
  t.loadedSkill("frame-review");
  const video = `${PROJECT}/out/calm-morning.mp4`;
  const evidence = voiceoverEvidence(turn.events, {
    frames: framePaths,
    video,
    width: fixture.width,
    height: fixture.height,
    durationMs: fixture.videoDurationMs,
  });
  for (const [key, label] of Object.entries({
    frameRender: "контрольные кадры успешно отрендерены",
    pixels: "пиксели всех восьми кадров проверены после рендера",
    views: "все восемь заданных кадров просмотрены после проверки пикселей",
    fullRender:
      "полный рендер завершён после синтеза, чтения таймингов и просмотра кадров",
    probe:
      "после полного рендера проверены дорожки, размер кадра и длительность того же MP4",
  }) as [keyof typeof evidence, string][]) {
    t.check(
      evidence[key],
      satisfies((value: boolean) => value, label),
    );
  }
  t.check(
    sceneTimingsAfterSynthesis(turn.toolCalls),
    satisfies(
      (scenes: number[]) => scenes.join() === "1,2,3",
      "после синтеза прочитаны тайминги именно созданных файлов всех трёх сцен",
    ),
  );
  t.check(
    videoLinks(turn.message),
    satisfies(
      (links: string[]) => links.includes(video),
      "итоговая ссылка на проверенный MP4",
    ),
  );
}
