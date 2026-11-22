import { defineSchedule } from "eve/schedules";

import { loadConfig } from "@/lib/config";
import { reconcileMessageFiles } from "@/lib/media/message-files";

export default defineSchedule({
  cron: "* * * * *",
  async run() {
    const config = loadConfig();
    if (config.appStubEvalSandbox || config.appVideoEvalSandbox) return;
    await reconcileMessageFiles();
  },
});
