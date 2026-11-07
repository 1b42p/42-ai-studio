import { JustBashSandbox } from "eve/sandbox/just-bash";

import { voiceoverFrames } from "../../evals/voiceover/media-fixture";

export const stubEvalEnvironment = JustBashSandbox.environment({
  autoInstall: false,
  async filesystem({ defaultFilesystem }) {
    await defaultFilesystem.mkdir("/workspace/.eval/voiceover", { recursive: true });
    for (const frame of voiceoverFrames) {
      if (!await defaultFilesystem.exists(frame.path)) {
        await defaultFilesystem.writeFile(frame.path, Buffer.from(frame.base64, "base64"));
      }
    }
    return defaultFilesystem;
  },
});
