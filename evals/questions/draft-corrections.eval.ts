import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";
import { isDraft, isFinal, questionFrameContracts, questionSession, questionVideoContracts, renderCommands, REQUEST, TIMEOUT } from "./fixtures";
import { reviewedRevisionBeforeVideo } from "./frame-observations";
import { questionProjectPath, questionProps } from "./media-fixture";
import { verifiedVideoLinkBeforeQuestion } from "./observations";

export default Array.from({ length: 3 }, () => defineEval({
  timeoutMs: TIMEOUT, tags: ["questions"], description: "Правка заголовка вызывает новый черновик и новый вопрос.",
  async test(t) {
    const session = await questionSession(t);
    const videos = questionVideoContracts(120);
    const originalVideo = videos.find(video => video.version === 1 && video.draft)!;
    const revisedVideo = { ...videos.find(video => video.version === 2 && video.draft)!,
      requiredEdit: { path: `${questionProjectPath(120)}/props-v2.json`, content: questionProps(2) } };
    const revisedFrames = questionFrameContracts(120).find(frames => frames.version === 2)!;
    const first = await session.send(REQUEST(120));
    first.parked();
    first.notCalledTool("set_session_preview");
    t.check(renderCommands(first).some(isDraft) && !renderCommands(first).some(isFinal), equals(true));
    const initialRenders = new Set(renderCommands(first));
    const initialEdits = new Set(first.toolCalls.filter((call) => call.name === "edit_file").map((call) => JSON.stringify(call.input)));
    const request = session.requireInputRequest();
    first.calledTool("ask_question", { status: "pending", count: 1 });
    t.check(request.action?.kind === "tool-call" && request.action.toolName === "ask_question" && /Рендерить финал/.test(request.prompt), equals(true));
    t.check(request.options?.map(option => option.label), equals(["Рендерить финал", "Хочу поправить"]));
    t.check(verifiedVideoLinkBeforeQuestion(first.events, originalVideo, request.requestId), equals(true));
    const corrected = await session.respond([{ requestId: request.requestId, text: "Поправь заголовок на «Утро начинается с кофе»" }]);
    corrected.parked();
    corrected.notCalledTool("set_session_preview");
    // A response includes calls completed in that stream slice and spanning
    // workflow calls, so compare captured inputs rather than cumulative counts.
    t.check(corrected.toolCalls.some((call) => call.name === "edit_file" && !initialEdits.has(JSON.stringify(call.input))), equals(true));
    t.check(renderCommands(corrected).some((command) => isDraft(command) && !initialRenders.has(command)) &&
      !renderCommands(corrected).some(isFinal), equals(true));
    t.check(renderCommands(corrected).some((command) => isDraft(command) && command.includes("props-v2.json")), equals(true));
    const next = session.requireInputRequest();
    corrected.calledTool("ask_question", { status: "pending", count: 1 });
    t.check(next.action?.kind === "tool-call" && next.action.toolName === "ask_question" && /Рендерить финал/.test(next.prompt), equals(true));
    t.check(next.options?.map(option => option.label), equals(["Рендерить финал", "Хочу поправить"]));
    t.check(next.requestId !== request.requestId, equals(true));
    t.check(verifiedVideoLinkBeforeQuestion(corrected.events, revisedVideo, next.requestId), equals(true));
    t.check(reviewedRevisionBeforeVideo(corrected.events, revisedVideo, revisedFrames), equals(true));
    t.parked();
  },
}));
