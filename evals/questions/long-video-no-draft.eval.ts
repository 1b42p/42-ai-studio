import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";
import { parseSandboxLinks } from "../../lib/media/sandbox-path";
import { isDraft, isFinal, questionSession, questionVideoContracts, renderCommands, REQUEST, TIMEOUT } from "./fixtures";
import { verifiedFinalPreview } from "./observations";

export default Array.from({ length: 3 }, () => defineEval({
  timeoutMs: TIMEOUT, tags: ["questions"], description: "120 секунд: явный отказ от черновика даёт проверенный финал и превью без вопроса.",
  async test(t) {
    const session = await questionSession(t);
    const finalVideo = questionVideoContracts(120).find(video => video.version === 1 && !video.draft)!;
    const final = await session.send(`${REQUEST(120)} Без черновика.`);
    final.succeeded();
    final.notCalledTool("ask_question");
    const commands = renderCommands(final);
    t.check(!commands.some(isDraft) && commands.some(isFinal), equals(true));
    final.calledTool("bash", {
      input: { command: finalVideo.render },
      output: { status: "completed", exitCode: 0 },
    });
    t.check(parseSandboxLinks(final.message ?? "", { includeUnusedDefinitions: false }).some(link =>
      link.kind === "file" && link.path === finalVideo.path), equals(true));
    t.check(verifiedFinalPreview(final.events, finalVideo), equals(true));
    t.succeeded();
  },
}));
