import type { EveEvalContext } from "eve/evals";
import { describe, expect, test, vi } from "vitest";

import { questionSession } from "../../../evals/questions/fixtures";
import { videoSession } from "../../../evals/video/fixtures";
import { blockedRead, emptySearch, webSession } from "../../../evals/web/fixtures";

// Recorded identity from /eve/v1/info, not a callable provider tool.
const memoryWrapper = {
  logicalPath: "tools/memory.ts",
  owner: { feature: "memory", kind: "framework" },
  sourceId: "eve:memory-wrapper:tools/memory.ts:from:memory.ts",
  sourceKind: "module",
  eventNames: ["turn.started"],
  slug: "memory",
};
const toolNames = [
  "bash", "read_file", "edit_file", "agent", "ask_question", "speak",
  "list_voices", "download_video", "read_page", "web_search", "set_session_preview",
];

function isolated(dynamic: unknown[], extraStatic: string[] = []) {
  const session = vi.fn(async () => ({ sessionId: "unit-eval" }));
  const context = {
    target: {
      fetch: async (path: string) => path === "/api/health"
        ? new Response(null, { headers: { "x-studio-eval-runtime": "stub", "x-studio-video-eval": "1" } })
        : Response.json({
          tools: { static: [...toolNames, ...extraStatic].map(name => ({ name })), dynamic },
        }),
    },
    session,
  } as unknown as EveEvalContext;
  return { context, session };
}

describe.each([
  ["web", (t: EveEvalContext) => webSession(t, [blockedRead, emptySearch])],
  ["video", (t: EveEvalContext) => videoSession(t, { caseId: "memory-isolation" })],
  ["questions", (t: EveEvalContext) => questionSession(t)],
] as const)("%s: dynamic manifest isolation", (_name, create) => {
  test("accepts the exact framework memory slot disabled for eval callers", async () => {
    const h = isolated([memoryWrapper]);
    await create(h.context);
    expect(h.session).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["application wrapper with the same slug", { ...memoryWrapper, owner: { feature: "memory", kind: "application" } }],
    ["unknown framework feature", { ...memoryWrapper, owner: { feature: "unknown", kind: "framework" } }],
    ["another memory slot", { ...memoryWrapper, slug: "profile" }],
    ["another logical path", { ...memoryWrapper, logicalPath: "tools/profile.ts" }],
    ["another source slot", { ...memoryWrapper, sourceId: "eve:memory-wrapper:tools/memory.ts:from:memory/profile.ts" }],
    ["application source", { ...memoryWrapper, sourceId: "app:tools/memory.ts" }],
    ["another source kind", { ...memoryWrapper, sourceKind: "file" }],
    ["additional lifecycle handler", { ...memoryWrapper, eventNames: ["turn.started", "step.started"] }],
    ["unknown dynamic tool", { name: "dynamic_effect" }],
    ["incomplete memory identity", { owner: memoryWrapper.owner, slug: "memory" }],
    ["missing entry", null],
  ])("rejects %s before session creation, even beside the allowed resolver", async (_description, entry) => {
    const h = isolated([memoryWrapper, entry]);
    await expect(create(h.context)).rejects.toThrow(/изолированы|Неподменённые эффекты/);
    expect(h.session).not.toHaveBeenCalled();
  });

  test("the resolver exception does not authorize exposed provider tools", async () => {
    const h = isolated([memoryWrapper], ["memory__save", "memory__remove"]);
    await expect(create(h.context)).rejects.toThrow(/memory__save.*memory__remove/);
    expect(h.session).not.toHaveBeenCalled();
  });
});
