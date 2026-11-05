import { defineSandbox } from "eve/sandbox";
import { JustBashSandbox } from "eve/sandbox/just-bash";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readVideoEvalSandbox } from "@/lib/config";
import { DaytonaSandbox } from "../lib/daytona-provider";
import { isEvalPrincipal } from "../lib/eval-auth";
import { prepareVideoEvalSandbox, videoEvalCommands, videoEvalConfiguration, VIDEO_EVAL_CONFIG_PATH } from "../lib/video-eval-shell";

const videoEval = readVideoEvalSandbox();
export const environment = videoEval
  ? JustBashSandbox.environment({
    autoInstall: false,
    customCommands: videoEvalCommands,
    prepare: async (sandbox) => prepareVideoEvalSandbox(
      sandbox, await readFile(resolve("agent/sandbox/Dockerfile"), "utf8"),
    ),
  })
  : DaytonaSandbox.environment();

export default defineSandbox(async ({ session }) => {
  if (videoEval && (!isEvalPrincipal(session.auth.initiator) || session.auth.initiator?.attributes.videoEval !== "1")) {
    throw new Error("Виртуальная среда видео доступна только проверенному eval-принципалу.");
  }
  const sandbox = await environment.open();
  if (videoEval) {
    await sandbox.writeTextFile({
      path: VIDEO_EVAL_CONFIG_PATH,
      content: videoEvalConfiguration(session.auth.initiator?.attributes.videoEvalRenderFails === "1"),
    });
  }
  return sandbox;
});
