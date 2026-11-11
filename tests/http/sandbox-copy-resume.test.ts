import { eq } from "drizzle-orm";
import { expect, test } from "vitest";

import { appSessions, sandboxes } from "../../lib/db/schema";
import { createSessionAs, eveClientAs, readStreamUntil, sendAndWait } from "./support/chat";
import { createDaytonaKey, createUser, db } from "./support/db";
import { fakeSandbox } from "./support/fake-sandbox";

test("завершённая копия читает ту же песочницу при продолжении в новом ходе корня", async () => {
  await createDaytonaKey();
  const user = await createUser();
  const session = await createSessionAs(user);
  await fakeSandbox.seed(session.id, { "/workspace/notes.txt": "Проект пережил продолжение копии" });
  const message = '/tool read_file {"filePath":"/workspace/notes.txt"}';
  const first = await sendAndWait(user, session.id, `/tool agent ${JSON.stringify({ message })}`);
  const started = first.find((event) => event.type === "agent.started");
  expect(started?.type).toBe("agent.started");
  if (started?.type !== "agent.started") throw new Error("Не открылась сессия копии");
  const taskId = started.data.taskId;
  expect(taskId).toBeTypeOf("string");
  const client = await eveClientAs(user, session.id);
  const child = client.sessions.attach(started.data.sessionId);
  const before = await readStreamUntil(child.stream({ follow: false }), "session.waiting");
  const result = before.find((event) => event.type === "action.result");
  expect(result?.data).toMatchObject({
    status: "completed", result: { output: { content: expect.stringContaining("Проект пережил продолжение") } },
  });
  const [row] = await db().select().from(appSessions).where(eq(appSessions.id, session.id));
  expect(row.sandboxWaitGeneration).toBeGreaterThan(0);

  await sendAndWait(user, session.id, `/tool agent ${JSON.stringify({ message, taskId })}`);
  const after = await readStreamUntil(child.stream({ follow: false, startIndex: before.length }), "session.waiting");
  const results = after.filter((event) => event.type === "action.result");
  expect(results).toHaveLength(1);
  expect(results[0].data).toMatchObject({
    status: "completed", result: { output: { content: expect.stringContaining("Проект пережил продолжение") } },
  });
  expect(after.filter((event) => event.type === "turn.cancelled")).toHaveLength(0);
  expect((await fakeSandbox.counters()).created).toBe(1);
  const [machine] = await db().select().from(sandboxes).where(eq(sandboxes.appSessionId, session.id));
  expect(machine.state).toBe("started");
});
