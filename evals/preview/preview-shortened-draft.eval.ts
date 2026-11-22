import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { previewSession, request, TIMEOUT } from "./fixtures";
import { inspectedVideo, previewEvidence, reviewedBeforeVideo } from "./observations";

const ACTUAL_SECONDS = 30;
const BRIEF = [
  "Задача изначально на 90 секунд, но подготовленная версия фактически длится 30.",
  "Эта короткая версия допустима, графику и параметры менять не надо.",
  request(ACTUAL_SECONDS),
].join("\n");

export default Array.from({ length: 3 }, () => defineEval({
  description: "Ролик из длинного брифа остаётся черновиком, даже если подготовленная версия короче минуты.",
  tags: ["preview", "preview-shortened-draft"],
  timeoutMs: TIMEOUT,
  async test(t) {
    const session = await previewSession(t, ACTUAL_SECONDS, true);
    try {
      const turn = await session.send(BRIEF);
      const evidence = previewEvidence(turn.events, ACTUAL_SECONDS);
      t.check(reviewedBeforeVideo(turn.events, ACTUAL_SECONDS), satisfies(Boolean, "кадры проверены до экспорта"));
      t.check(inspectedVideo(turn.events, ACTUAL_SECONDS, true), satisfies(Boolean, "фактический 30-секундный MP4 проверен и уменьшен"));
      t.check(evidence.draftWithoutPreview, satisfies(Boolean, "финал и превью не созданы без согласия"));
      t.check(evidence.draftLinkBeforeQuestion, satisfies(Boolean, "черновик опубликован до запроса согласования"));
      turn.parked();
      session.requireInputRequest({ toolName: "ask_question" });
    } finally {
      await session.cancel();
    }
  },
}));
