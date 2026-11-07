import { JustBashSandbox } from "eve/sandbox/just-bash";
import { dirname } from "node:path";

import { voiceoverFrames } from "../../evals/voiceover/media-fixture";

export const stubEvalEnvironment = JustBashSandbox.environment({
  autoInstall: false,
  async filesystem({ defaultFilesystem }) {
    for (const frame of voiceoverFrames) {
      await defaultFilesystem.mkdir(dirname(frame.path), { recursive: true });
      if (!(await defaultFilesystem.exists(frame.path))) {
        await defaultFilesystem.writeFile(
          frame.path,
          Buffer.from(frame.base64, "base64"),
        );
      }
    }
    return defaultFilesystem;
  },
});
