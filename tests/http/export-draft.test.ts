import { expect, test } from "vitest";

import { createSessionAs, eveClientAs, readStreamUntil } from "./support/chat";
import { fetchApp } from "./support/app";
import { loginAs } from "./support/auth";
import { createDaytonaKey, createUser } from "./support/db";
import { fakeSandbox } from "./support/fake-sandbox";

test.each([
  { option: "Хочу поправить", renders: 0, status: "revision" },
  { option: "Рендерить финал", renders: 1, status: "rendered" },
])("экспорт версии v2: $option", async ({ option, renders, status }) => {
  await fakeSandbox.reset();
  await createDaytonaKey();
  await fakeSandbox.rules.set([
    { match: "remotion render src/index.ts Main", exitCode: 0 },
    { match: "out/coffee-draft-v2\\.mp4 \\|\\| exit 21", exitCode: 22 },
  ]);
  const user = await createUser();
  const { id } = await createSessionAs(user);
  const cookie = await loginAs(user);
  await fakeSandbox.seed(id, {
    "/workspace/coffee/out/coffee-draft-v2.mp4": "draft bytes",
    "/workspace/coffee/out/coffee-v2.mp4": "final bytes",
  });
  const files = async () => {
    const response = await fetchApp(`/api/sessions/${id}/files`, { headers: { cookie } });
    expect(response.ok).toBe(true);
    return (await response.json()).files;
  };
  const client = await eveClientAs(user, id);
  const input = {
    project: "coffee", draft: "out/coffee-draft-v2.mp4", entry: "src/index.ts", composition: "Main",
    props: "props-v2.json", durationSeconds: 120, width: 1920, height: 1080,
  };
  const { session, response } = await client.sessions.create({ message: `/tool export_draft ${JSON.stringify(input)}` });
  const paused = await readStreamUntil(response, "input.requested");
  const pending = paused.find(event => event.type === "input.requested")?.data.requests[0];
  expect(pending?.options?.map(item => item.label)).toEqual(["Рендерить финал", "Хочу поправить"]);
  expect(await files()).toEqual([expect.objectContaining({
    path: "/workspace/coffee/out/coffee-draft-v2.mp4", state: "ready", mediaId: expect.any(String),
  })]);
  const renderCalls = async () => (await fakeSandbox.calls(id)).filter(call => call.command?.includes("remotion render "));
  expect(await renderCalls()).toHaveLength(0);

  const selected = pending!.options!.find(item => item.label === option)!;
  const resumed = await session.respond([{ requestId: pending!.requestId, optionId: selected.id }]);
  const draining = resumed.result().catch(() => null);
  const events = await readStreamUntil(session.stream({ startIndex: 0 }), "session.waiting");
  await draining;
  expect(events.filter(event => event.type === "input.requested")).toHaveLength(1);
  expect(events.find(event => event.type === "action.result")?.data).toMatchObject({ result: { output: { status } } });
  const calls = await renderCalls();
  expect(calls).toHaveLength(renders);
  if (renders) {
    expect(calls[0].command).toContain("--props=props-v2.json");
    expect(calls[0].command).toContain("mv -f -- \"$temp\" out/coffee-v2.mp4");
    expect(await files()).toEqual(expect.arrayContaining([expect.objectContaining({
      path: "/workspace/coffee/out/coffee-v2.mp4", state: "ready", mediaId: expect.any(String),
    })]));
  } else {
    expect(await files()).toHaveLength(1);
  }
});
