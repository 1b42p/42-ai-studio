import { defineDynamic, defineInstructions } from "eve/instructions";

import { getSettings } from "@/lib/settings/service";

import { resolveUserGuidelines } from "../lib/user-guidelines";

export default defineDynamic({
  events: {
    "turn.started": async (_event, ctx) => {
      const content = await resolveUserGuidelines(ctx.session.auth, getSettings);
      return content === null ? null : defineInstructions({ content, role: "system" });
    },
  },
});
