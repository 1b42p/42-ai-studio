/** Инструменты read_page и web_search доступны фикстурной модели. */
import type { MessageStreamEvent } from "eve/client";
import { beforeEach, expect, test } from "vitest";

import { createSessionAs, sendAndWait } from "./support/chat";
import { createDaytonaKey, createUser, resetDatabase } from "./support/db";
import { fakeSandbox } from "./support/fake-sandbox";
import { tavilyStub } from "./support/tavily";

beforeEach(async () => {
  await resetDatabase();
  await fakeSandbox.reset();
  await createDaytonaKey();
  await tavilyStub.reset();
});

function toolResult(events: readonly MessageStreamEvent[], name: string) {
  const results = events.filter((event) => event.type === "action.result");
  const event = results.find(
    (item) => item.data.result.kind === "tool-result" && item.data.result.toolName === name,
  );
  expect(event, `нет результата ${name}`).toBeDefined();
  return event!.data;
}

test("read_page отказывается читать внутренний адрес, web_search получает источники с сервера", async () => {
  const user = await createUser();
  const { id } = await createSessionAs(user);

  const read = toolResult(
    await sendAndWait(user, id, '/tool read_page {"url":"http://127.0.0.1/"}'),
    "read_page",
  );
  expect(read.status).toBe("failed");
  expect(read.error?.message ?? JSON.stringify(read)).toContain("внутренней сети");

  const search = toolResult(
    await sendAndWait(user, id, '/tool web_search {"query":"remotion captions"}'),
    "web_search",
  );
  expect(search.status).toBe("completed");
  expect(search.result.kind === "tool-result" && search.result.output).toMatchObject({
    results: expect.arrayContaining([expect.objectContaining({ title: "Captions", host: "www.remotion.dev" })]),
  });
});
