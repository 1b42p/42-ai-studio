import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";
import { parseSandboxLinks } from "../../lib/media/sandbox-path";
import { isDraft, isFinal, questionSession, questionVideoContracts, renderCommands, REQUEST, TIMEOUT } from "./fixtures";
import { verifiedFinalPreview, verifiedVideoLinkBeforeQuestion } from "./observations";

export default Array.from({ length: 3 }, () => defineEval({
  timeoutMs: TIMEOUT, tags: ["questions"], description: "Двухминутный ролик ждёт ответа после черновика.",
  async test(t) {
    const session = await questionSession(t);
    const videos = questionVideoContracts(120);
    const draftVideo = videos.find(video => video.version === 1 && video.draft)!;
    const finalVideo = videos.find(video => video.version === 1 && !video.draft)!;
    const draft = await session.send(REQUEST(120));
    draft.parked();
    draft.notCalledTool("set_session_preview");
    const commands = renderCommands(draft);
    t.check(commands.some(isDraft) && !commands.some(isFinal), equals(true));
    const request = session.requireInputRequest({ toolName: "ask_question", prompt: /Рендерить финал/ });
    t.check(request.options?.map((option) => option.label), equals(["Рендерить финал", "Хочу поправить"]));
    t.check(verifiedVideoLinkBeforeQuestion(draft.events, draftVideo, request.requestId), equals(true));
    const final = await session.respond([{ requestId: request.requestId, text: "Рендерить финал" }]);
    final.succeeded();
    t.check(renderCommands(final).some(isFinal), equals(true));
    t.check(final.toolCalls.some(call => call.name === "bash" && call.status === "completed" &&
      typeof call.input.command === "string" && finalVideo.render.test(call.input.command)), equals(true));
    t.check(parseSandboxLinks(final.message ?? "", { includeUnusedDefinitions: false }).some(link =>
      link.kind === "file" && link.path === finalVideo.path), equals(true));
    t.check(verifiedFinalPreview(final.events, finalVideo), equals(true));
    t.succeeded();
  },
}));
