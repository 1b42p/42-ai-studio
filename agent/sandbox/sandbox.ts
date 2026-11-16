import { defineSandbox } from "eve/sandbox";
import { DockerSandbox } from "eve/sandbox/docker";
import { readStubEvalSandbox, readVideoEvalSandbox } from "@/lib/config";
import { DaytonaSandbox } from "../lib/daytona-provider";
import { isEvalPrincipal } from "../lib/eval-auth";
import { stubEvalEnvironment } from "../lib/stub-eval-media";
import { prepareNativeVideoEval, initializeNativeVideoEval, NATIVE_VIDEO_EVAL_REVISION } from "../lib/video-eval-native";
import { BROKEN_LAYOUT_ENTRY, BROKEN_LAYOUT_NOTES, BROKEN_LAYOUT_ROOT } from "./eval-projects";

const videoEval = readVideoEvalSandbox();
const stubEval = readStubEvalSandbox();
export const environment = stubEval ? stubEvalEnvironment : videoEval
  ? DockerSandbox.dockerfile({
    env: { STUDIO_VIDEO_EVAL_REVISION: NATIVE_VIDEO_EVAL_REVISION },
    prepare: prepareNativeVideoEval,
  })
  : DaytonaSandbox.environment();

export default defineSandbox(async ({ session }) => {
  if (stubEval && !isEvalPrincipal(session.auth.initiator)) {
    throw new Error("Хранилище фикстур доступно только проверенному eval-принципалу.");
  }
  if (videoEval && (!isEvalPrincipal(session.auth.initiator) || session.auth.initiator?.attributes.videoEval !== "1")) {
    throw new Error("Среда оценок видео доступна только проверенному eval-принципалу.");
  }
  const renderFails = session.auth.initiator?.attributes.videoEvalRenderFails === "1";
  const sandbox = await environment.open(videoEval ? { networkPolicy: renderFails ? "deny-all" : "allow-all" } : undefined);
  if (videoEval) {
    await initializeNativeVideoEval(sandbox, renderFails);
    if (session.auth.initiator?.attributes.videoEvalMissingEntrypoint === "1") {
      // Seed once per disposable eval sandbox, never repair it on subsequent opens.
      const seeded = await sandbox.run({ command: `
if ! test -e /workspace/.eve/missing-entrypoint-seeded; then
  mkdir -p /workspace/unfinished /workspace/.eve &&
  cp /opt/remotion/package.json /opt/remotion/tsconfig.json /opt/remotion/remotion.config.ts /workspace/unfinished/ &&
  cp -r /opt/remotion/src /workspace/unfinished/src &&
  ln -s /opt/remotion/node_modules /workspace/unfinished/node_modules &&
  rm /workspace/unfinished/src/index.ts &&
  touch /workspace/.eve/missing-entrypoint-seeded
fi` });
      if (seeded.exitCode !== 0) throw new Error(`Cannot seed missing entrypoint eval project: ${seeded.stderr}`);
    }
    if (session.auth.initiator?.attributes.videoEvalBrokenLayout === "1") {
      // The project is prepared once; later opens must not undo the agent's fixes.
      const marker = await sandbox.run({ command: "test -e /workspace/.eve/broken-layout-seeded" });
      if (marker.exitCode !== 0) {
        const prepared = await sandbox.run({ command: `
mkdir -p /workspace/broken/src /workspace/.eve &&
cp /opt/remotion/package.json /opt/remotion/tsconfig.json /opt/remotion/remotion.config.ts /workspace/broken/ &&
ln -sfn /opt/remotion/node_modules /workspace/broken/node_modules` });
        if (prepared.exitCode !== 0) throw new Error(`Cannot prepare broken layout eval project: ${prepared.stderr}`);
        await sandbox.writeTextFile({ path: "/workspace/broken/src/index.ts", content: BROKEN_LAYOUT_ENTRY });
        await sandbox.writeTextFile({ path: "/workspace/broken/src/Root.tsx", content: BROKEN_LAYOUT_ROOT });
        await sandbox.writeTextFile({ path: "/workspace/broken/NOTES.md", content: BROKEN_LAYOUT_NOTES });
        const seeded = await sandbox.run({ command: "touch /workspace/.eve/broken-layout-seeded" });
        if (seeded.exitCode !== 0) throw new Error(`Cannot finish broken layout eval seed: ${seeded.stderr}`);
      }
    }
  }
  return sandbox;
});
