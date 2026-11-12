import { JustBashSandbox } from "eve/sandbox/just-bash";
import { dirname } from "node:path";

import { voiceoverFrames } from "../../evals/voiceover/media-fixture";
import { questionFrames } from "../../evals/questions/media-fixture";
import { seedMusicFrames } from "../../evals/music/media-fixture";
import { seedPreviewFrames } from "../../evals/preview/media-fixture";

export const stubEvalEnvironment = JustBashSandbox.environment({
  autoInstall: false,
  async filesystem({ defaultFilesystem }) {
    for (const frame of [...voiceoverFrames, ...questionFrames]) {
      await defaultFilesystem.mkdir(dirname(frame.path), { recursive: true });
      if (!(await defaultFilesystem.exists(frame.path))) {
        await defaultFilesystem.writeFile(
          frame.path,
          Buffer.from(frame.base64, "base64"),
        );
      }
    }
    await seedMusicFrames(defaultFilesystem);
    await seedPreviewFrames(defaultFilesystem);
    return defaultFilesystem;
  },
});
