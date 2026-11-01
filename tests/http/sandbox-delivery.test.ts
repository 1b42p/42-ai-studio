import { randomUUID } from "node:crypto";
import path from "node:path";
import { eq } from "drizzle-orm";
import type { SandboxSessionContext } from "eve/sandbox/provider";
import { expect, test } from "vitest";

import { createDaytonaLifecycle } from "../../agent/lib/daytona-provider";
import { loadConfig } from "../../lib/config";
import { appSessions } from "../../lib/db/schema";
import { createDaytonaKey, createUser, db } from "./support/db";
import { fakeSandbox } from "./support/fake-sandbox";
import { buildSandboxDeliveryArtifact } from "./support/sandbox-build";
import { createSessionAs, sendAndWait } from "./support/chat";

test("eve build без .env и секретов доставляет workspace и skill с вложенными references в новую песочницу", async () => {
  const workspace = Uint8Array.of(0, 1, 127, 128, 254, 255, 10);
  const skill = "---\ndescription: Test workspace delivery.\n---\n\nЧитайте references/nested.md.\n";
  const reference = "# Вложенный справочник\n\nРусский текст и точные байты: ✓\n";
  const artifact = await buildSandboxDeliveryArtifact({
    "agent/sandbox/workspace/delivery/seed.bin": workspace,
    "agent/skills/test-skill/SKILL.md": skill,
    "agent/skills/test-skill/references/nested.md": reference,
  });
  // Копия исходников уже удалена. start получает именно артефакт eve build,
  // не вызов prepare с придуманным populate и не fakeSandbox.seed.
  expect(artifact.files.length).toBeGreaterThanOrEqual(3);
  expect(artifact.dockerfile).toContain("FROM ");

  await createDaytonaKey();
  const user = await createUser();
  const { id } = await createSessionAs(user);
  await sendAndWait(user, id, "Подготовка проверки доставки файлов");
  const [session] = await db().select().from(appSessions).where(eq(appSessions.id, id));
  const eveSessionId = session.eveSessionId!;
  const ctx = {
    kind: "session",
    session: { id: eveSessionId, auth: { current: null, initiator: null }, turn: { id: randomUUID(), sequence: 0 } },
    storagePath: loadConfig().fakeSandboxDir!,
    resolveProjectPath: (filename: string) => path.resolve(filename),
  } satisfies SandboxSessionContext;
  const lifecycle = createDaytonaLifecycle();
  const opened = await lifecycle.start(ctx, undefined, artifact);
  try {
    const expected = [
      ["/workspace/delivery/seed.bin", workspace],
      ["/root/.agents/skills/test-skill/SKILL.md", Buffer.from(skill)],
      ["/root/.agents/skills/test-skill/references/nested.md", Buffer.from(reference)],
    ] as const;
    for (const [filename, bytes] of expected) {
      const delivered = await fakeSandbox.files.read(session.id, filename);
      expect(delivered, filename).not.toBeNull();
      expect(new Uint8Array(delivered!), filename).toEqual(new Uint8Array(bytes));
    }
    expect((await fakeSandbox.counters()).created).toBe(1);
    expect(await fakeSandbox.files.list(session.id, "/workspace/skills")).toEqual([]);
    const events = await sendAndWait(user, id, '/tool read_file {"filePath":"/root/.agents/skills/test-skill/references/nested.md"}');
    const result = events.find((event) => event.type === "action.result");
    expect(result?.data.status).toBe("completed");
    expect(JSON.stringify(result)).toContain("Русский текст и точные байты: ✓");
    expect((await fakeSandbox.counters()).created).toBe(1);
  } finally {
    try { await opened.connection.close?.(); }
    finally { await lifecycle.onSessionEnd(ctx, opened.state, { reason: "deleted" }); }
  }
}, 240_000);
