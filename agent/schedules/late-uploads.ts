import { defineSchedule } from "eve/schedules";

import { sweepLateUploads } from "@/lib/sessions/late-upload-cleanup";

export default defineSchedule({
  cron: "*/5 * * * *",
  run: sweepLateUploads,
});
