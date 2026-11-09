import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { blockedRead, emptySearch, webSession } from "../web/fixtures";

const ZOO = "https://www.youtube.com/watch?v=jNQXAC9IVRw";

const downloaded = {
  videoPath: "/workspace/downloads/zoo/video.mp4",
  title: "Me at the zoo",
  uploader: "jawed",
  site: "Youtube",
  sourceUrl: ZOO,
  durationSec: 19,
  width: 320,
  height: 240,
  videoCodec: "h264",
  sizeBytes: 200_000,
  frames: [
    { path: "/workspace/downloads/zoo/frames/frame-0005.00.jpg", momentSec: 5, mediaId: null },
    { path: "/workspace/downloads/zoo/frames/frame-0020.00.jpg", momentSec: 20, mediaId: null },
  ],
  skippedMoments: [],
};

export default Array.from({ length: 3 }, () => defineEval({
  description: "Кадры из чужого ролика запрашиваются у download_video, а не у оболочки песочницы.",
  tags: ["download"],
  timeoutMs: 180_000,
  async test(t) {
    const session = await webSession(t, [
      blockedRead,
      emptySearch,
      {
        id: "download-ok",
        tool: "download_video",
        outcome: { response: downloaded },
      },
    ]);
    const turn = await session.send(`Возьми кадры на 5 и 20 секунде из ${ZOO}`);
    t.succeeded();
    t.calledTool("download_video", {
      input: {
        url: ZOO,
        moments: (value: unknown) => Array.isArray(value) && value.length === 2 && value[0] === 5 && value[1] === 20,
      },
    });
    const shell = turn.toolCalls.filter((call) => call.name === "bash");
    t.check(
      shell.every((call) => !/\byt-dlp\b|\bcurl\b|\bwget\b/.test(JSON.stringify(call.input))),
      satisfies((ok: boolean) => ok, "bash не запускает yt-dlp, curl и wget"),
    );
  },
}));
