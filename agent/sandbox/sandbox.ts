import { defineSandbox } from "eve/sandbox";
import { DockerSandbox } from "eve/sandbox/docker";
import { readVideoEvalSandbox } from "@/lib/config";
import { DaytonaSandbox } from "../lib/daytona-provider";
import { isEvalPrincipal } from "../lib/eval-auth";
import { prepareNativeVideoEval, initializeNativeVideoEval, NATIVE_VIDEO_EVAL_REVISION } from "../lib/video-eval-native";

const videoEval = readVideoEvalSandbox();
export const environment = videoEval
  ? DockerSandbox.dockerfile({
    env: { STUDIO_VIDEO_EVAL_REVISION: NATIVE_VIDEO_EVAL_REVISION },
    prepare: prepareNativeVideoEval,
  })
  : DaytonaSandbox.environment();

export default defineSandbox(async ({ session }) => {
  if (videoEval && (!isEvalPrincipal(session.auth.initiator) || session.auth.initiator?.attributes.videoEval !== "1")) {
    throw new Error("Среда оценок видео доступна только проверенному eval-принципалу.");
  }
  const renderFails = session.auth.initiator?.attributes.videoEvalRenderFails === "1";
  const sandbox = await environment.open(videoEval ? { networkPolicy: renderFails ? "deny-all" : "allow-all" } : undefined);
  if (videoEval) {
    await initializeNativeVideoEval(sandbox, renderFails);
  }
  return sandbox;
});
