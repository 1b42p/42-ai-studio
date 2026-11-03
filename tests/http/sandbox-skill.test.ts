/** Загрузка навыка sandbox-environment фикстурной моделью (#14). */
import type { MessageStreamEvent } from "eve/client";
import { beforeEach, expect, test } from "vitest";

import { createSessionAs, sendAndWait } from "./support/chat";
import { createDaytonaKey, createUser, resetDatabase } from "./support/db";
import { fakeSandbox } from "./support/fake-sandbox";

beforeEach(async () => {
  await resetDatabase();
  await fakeSandbox.reset();
  await createDaytonaKey();
});

function skillResult(events: readonly MessageStreamEvent[]) {
  const results = events.filter((event) => event.type === "action.result");
  const event = results.find(
    (item) => item.data.result.kind === "load-skill-result" && item.data.result.name === "sandbox-environment",
  );
  expect(event, "нет результата eve__skill").toBeDefined();
  return event!.data;
}

test("сообщение /tool eve__skill возвращает текст навыка sandbox-environment", async () => {
  const user = await createUser();
  const { id } = await createSessionAs(user);
  const events = await sendAndWait(user, id, '/tool eve__skill {"name":"sandbox-environment"}');
  const result = skillResult(events);
  expect(result.status).toBe("completed");
  expect(JSON.stringify(result)).toContain("sandbox-vcpu");
});
