import type { SandboxState } from "@/lib/db/schema";
import { StudioSandboxError } from "./errors";

/** Единое отображение состояний Daytona для провайдера и сверки очереди. */
export function sandboxState(state: string | undefined): SandboxState {
  switch (state) {
    case "started": return "started";
    case "stopped": case "stopping": return "stopped";
    case "archived": case "archiving": return "archived";
    case "destroyed": return "gone";
    case "creating": case "starting": case "restoring": case "pending_build":
    case "building_snapshot": case "pulling_snapshot": case "resizing":
    case "snapshotting": case "forking": case "resuming": case "destroying": return "starting";
    case "error": case "build_failed": throw new StudioSandboxError("sandbox_start_failed");
    default:
      console.warn("[sandbox] unexpected_state");
      return "starting";
  }
}
