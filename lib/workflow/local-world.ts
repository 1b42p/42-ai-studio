import { randomBytes, timingSafeEqual } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { reenqueueActiveRuns } from "@workflow/world";
import { createWorld, type LocalWorld } from "@workflow/world-local";

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
    await assertRunScopedStorage(dataDir);
    await start?.();
    await reenqueueActiveRuns(world.runs, async (name, message, options) => {
      if (typeof message === "object" && message !== null && "runId" in message &&
        typeof message.runId === "string") {
        try {
          await world.releaseOrphanedSteps(message.runId);
        } catch {
          console.warn("[workflow] orphaned step release failed:", message.runId);
        }
      }
      return world.queue(name, message, options);
    }, "studio-workflow", undefined, { queueLost: true });
  };
  return world;
}

export default function createWorldForEve(): LocalWorld {
  return createStudioLocalWorld();
}
