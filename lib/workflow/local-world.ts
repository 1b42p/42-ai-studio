import { randomBytes, timingSafeEqual } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { createWorld, type LocalWorld } from "@workflow/world-local";

import { readWorkflowQueueNamespace } from "../config";

const deliveryHeader = "x-studio-workflow-delivery";

async function assertRunScopedStorage(dataDir: string) {
  for (const directory of ["events", "steps"]) {
    const entries = await readdir(join(dataDir, directory), { withFileTypes: true }).catch(error => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    if (entries.some(entry => !entry.isDirectory() && entry.name.endsWith(".json"))) {
      throw new Error("Legacy flat Workflow storage requires an explicit migration; existing data was not changed");
    }
  }
}

export function createStudioLocalWorld(
  dataDir = join(process.cwd(), ".eve", ".workflow-data"),
): LocalWorld {
  // Recover through our authenticated queue, not the world's unwrapped queue.
  const world = createWorld({ dataDir, recoverActiveRuns: false });
  const secret = randomBytes(32).toString("hex");
  const proof = Buffer.from(secret);
  const queue = world.queue.bind(world);
  const createQueueHandler = world.createQueueHandler.bind(world);
  const start = world.start?.bind(world);

  world.queue = (name, message, options) => queue(name, message, {
    ...options,
    headers: { ...options?.headers, [deliveryHeader]: secret },
  });
  world.createQueueHandler = (prefix, deliver) => {
    const handler = createQueueHandler(prefix, deliver);
    return (request) => {
      const supplied = Buffer.from(request.headers.get(deliveryHeader) ?? "");
      if (supplied.length !== proof.length || !timingSafeEqual(supplied, proof)) {
        return Promise.resolve(Response.json({ error: "Untrusted workflow delivery." }, { status: 401 }));
      }
      return handler(request);
    };
  };
  world.start = async () => {
    const namespace = readWorkflowQueueNamespace();
    if (!namespace) throw new Error("Workflow queue namespace was not initialized by eve");
    await assertRunScopedStorage(dataDir);
    await start?.();
    const prefix = `__${namespace}_wkf_workflow_` as const;
    let cursor: string | undefined;
    do {
      const page = await world.runs.list({
        pagination: { cursor }, resolveData: "none", status: ["pending", "running"],
      });
      for (const run of page.data) {
        try {
          await world.releaseOrphanedSteps(run.runId);
        } catch {
          console.warn("[workflow] orphaned step release failed:", run.runId);
        }
        try {
          await world.queue(`${prefix}${run.workflowName}`, { runId: run.runId });
        } catch {
          console.warn("[workflow] run re-enqueue failed:", run.runId);
        }
      }
      cursor = page.hasMore ? page.cursor ?? undefined : undefined;
    } while (cursor !== undefined);
  };
  return world;
}

export default function createWorldForEve(): LocalWorld {
  return createStudioLocalWorld();
}
