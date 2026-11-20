import { beforeEach, expect, test, vi } from "vitest";

import type { User } from "../../../lib/db/schema";
import { assertEveSessionAccess } from "../../../lib/sessions/access";

const { findRoot, findStarting } = vi.hoisted(() => ({
  findRoot: vi.fn(),
  findStarting: vi.fn(),
}));

vi.mock("../../../lib/sessions/service", () => ({
  findAppSessionByEveId: findRoot,
  findStartingAppSession: findStarting,
}));

vi.mock("../../../lib/sessions/agent-sessions", () => ({
  findAgentSessionByEveId: async () => null,
  hasRecentSessionActivity: async () => false,
}));

const user = { id: "user" } as User;
const eveSessionId = "wrun_stream_start";

beforeEach(() => {
  findRoot.mockReset();
  findStarting.mockReset();
});

test.each([
  { title: "свою", ownerId: user.id, allowed: true },
  { title: "чужую", ownerId: "stranger", allowed: false },
])("поток проверяет $title привязку, завершившуюся между запросами", async ({ ownerId, allowed }) => {
  let bound = false;
  findRoot.mockImplementation(async () => bound ? { userId: ownerId } : null);
  findStarting.mockImplementation(async () => {
    bound = true;
    return null;
  });

  const access = assertEveSessionAccess(user, eveSessionId, "stream");
  if (allowed) await expect(access).resolves.toBeUndefined();
  else await expect(access).rejects.toMatchObject({ code: "session_forbidden" });
  expect(findStarting).toHaveBeenCalledOnce();
});
