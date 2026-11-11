import type { InputResponse, MessageStreamEvent } from "eve/client";
import { conversationReducer, openConversationInputs, type ConversationState } from "eve/react";
import { beforeEach, expect, test } from "vitest";

import { fetchApp } from "./support/app";
import { loginAs } from "./support/auth";
import { createSessionAs, eveClientAs, readStreamUntil, waitForStoredEvents } from "./support/chat";
import { createDaytonaKey, createUser, resetDatabase } from "./support/db";
import { fakeSandbox } from "./support/fake-sandbox";
import { telegramStub } from "./support/telegram";
import { readFileSync } from "node:fs";

const question = { question: "Формат кадра?", options: [
  { label: "16:9", description: "Горизонтальный" }, { label: "9:16", description: "Вертикальный" },
] };
const command = (input: object) => `/tool ask_question ${JSON.stringify(input)}`;
const project = (events: readonly MessageStreamEvent[]) => events.reduce<ConversationState>(
  (state, event) => conversationReducer.reduce(state, event), conversationReducer.initial(),
);

beforeEach(async () => {
  await telegramStub.reset();
  await resetDatabase();
  await fakeSandbox.reset();
  await createDaytonaKey();
});

test("каталог публикует ask_question и статические инструкции о длинных роликах", async () => {
  const operator = await createUser({ isOperator: true });
  const response = await fetchApp("/eve/v1/info", { headers: { cookie: await loginAs(operator) } });
  expect(response.status).toBe(200);
  const info = await response.json();
  expect(info.tools.static.some((tool: { name: string }) => tool.name === "ask_question")).toBe(true);
  const text = info.instructions.static.map((entry: { content: string }) => entry.content).join("\n");
  expect(text).toContain("# Длинные ролики");
  expect(text).toContain("- `ask_question` —");
  expect(readFileSync("agent/instructions.md", "utf8").trimEnd().split("\n").length).toBeLessThanOrEqual(200);
});

async function parked(input: { question: string; options?: { label: string; description: string }[] } = question, copy = false) {
  const user = await createUser();
  const { id } = await createSessionAs(user);
  const client = await eveClientAs(user, id);
  const message = copy ? `/tool agent ${JSON.stringify({ message: command(input) })}` : command(input);
  const created = await client.sessions.create({ message });
  await readStreamUntil(created.response, "turn.waiting");
  const stored = await waitForStoredEvents(user, id, (events) =>
    events.some((event) => event.payload.type === "input.requested"));
  const open = openConversationInputs(project(stored.map((event) => event.payload)));
  expect(open).toHaveLength(1);
  return { user, id, session: created.session, input: open[0]!, client };
}

async function postAnswer(p: Awaited<ReturnType<typeof parked>>, response: InputResponse, user = p.user) {
  return fetchApp(`/eve/v1/session/${p.session.state.sessionId}`, {
    method: "POST", headers: { cookie: await loginAs(user), "content-type": "application/json" },
    body: JSON.stringify({ inputResponses: [response] }),
  });
}

test("настоящий ask_question паркует ход, POST отвечает вариантом; журнал восстанавливает вопрос один раз", async () => {
  const p = await parked();
  expect(p.input.request).toMatchObject({ kind: "question", allowFreeform: true });
  expect(p.input.request.options).toHaveLength(2);
  const storedOpen = await waitForStoredEvents(p.user, p.id, (events) =>
    events.some((event) => event.payload.type === "turn.waiting" && event.payload.data.on === "input"));
  const before = project(storedOpen.map((event) => event.payload));
  const request = openConversationInputs(before)[0]!.request;
  const vertical = request.options!.find((option) => option.label === "9:16")!;
  const forbidden = await postAnswer(p, { requestId: request.requestId, optionId: vertical.id }, await createUser());
  expect(forbidden.status).toBe(403);
  expect(await forbidden.json()).toMatchObject({ code: "session_forbidden" });
  const response = await postAnswer(p, { requestId: request.requestId, optionId: vertical.id });
  expect(response.ok).toBe(true);
  const events = await readStreamUntil(p.session.stream({ startIndex: 0 }), "session.waiting");
  expect(events.find((event) => event.type === "action.result")?.data).toMatchObject({
    result: { output: { status: "answered", answer: "9:16" } },
  });
  expect(events.filter((event) => event.type === "message.completed").at(-1)?.data).toMatchObject({ message: "готово" });
  const stored = await waitForStoredEvents(p.user, p.id, (items) => items.some((event) => event.payload.type === "session.waiting"));
  const after = project(stored.map((event) => event.payload));
  expect(openConversationInputs(after)).toHaveLength(0);
  expect(after.inputs[request.requestId]).toMatchObject({ status: "settled", outcome: "answered" });
  expect(stored.filter((event) => event.payload.type === "input.requested")).toHaveLength(1);
  expect(stored.filter((event) => event.payload.type === "input.resolved")).toHaveLength(1);
  const turnIds = events.filter((event) => event.type === "step.started").map((event) => event.data.turnId);
  expect(new Set(turnIds).size).toBe(1);
});

test("вопрос без вариантов принимает структурированный текст", async () => {
  const p = await parked({ question: "О чём ролик?" });
  expect(p.input.request.options ?? []).toHaveLength(0);
  expect((await postAnswer(p, { requestId: p.input.request.requestId, text: "О кофе" })).ok).toBe(true);
  const events = await readStreamUntil(p.session.stream({ startIndex: 0 }), "session.waiting");
  expect(events.find((event) => event.type === "action.result")?.data).toMatchObject({ result: { output: { status: "answered", answer: "О кофе" } } });
});

test("обычное сообщение тоже отвечает на вопрос", async () => {
  const p = await parked();
  const response = await p.session.send("9:16");
  const events = await readStreamUntil(response, "session.waiting");
  const stored = await waitForStoredEvents(p.user, p.id, (items) => items.some((event) => event.payload.type === "input.resolved"));
  expect(project(stored.map((event) => event.payload)).inputs[p.input.request.requestId]).toMatchObject({ status: "settled", outcome: "answered" });
  expect(events.filter((event) => event.type === "message.completed").at(-1)?.data).toMatchObject({ message: "готово" });
});

test("Стоп снимает вопрос", async () => {
  const p = await parked();
  await p.session.cancel();
  await readStreamUntil(p.session.stream({ startIndex: 0 }), "session.waiting");
  const stored = await waitForStoredEvents(p.user, p.id, (items) => items.some((event) => event.payload.type === "input.resolved"));
  expect(project(stored.map((event) => event.payload)).inputs[p.input.request.requestId]).toMatchObject({ status: "settled", outcome: "cancelled" });
});

test("сообщение с файлом снимает корневой вопрос, а вопрос копии остаётся отвечаемым", async () => {
  for (const copy of [false, true]) {
    const p = await parked(question, copy);
    expect(Boolean(p.input.taskId)).toBe(copy);
    const response = await p.session.send([
      { type: "text", text: "Используй этот файл" },
      { type: "file", data: "data:text/plain;base64,0JrQvtGE0LU=", mediaType: "text/plain", filename: "topic.txt" },
    ], { turnPolicy: "steer" });
    if (copy) {
      await readStreamUntil(response, "turn.waiting");
      const stored = await waitForStoredEvents(p.user, p.id, (items) => items.filter((event) => event.payload.type === "message.received").length >= 2);
      expect(openConversationInputs(project(stored.map((event) => event.payload))).map((input) => input.request.requestId)).toContain(p.input.request.requestId);
      expect((await postAnswer(p, { requestId: p.input.request.requestId, text: "Кофе" })).ok).toBe(true);
      await readStreamUntil(p.session.stream({ startIndex: 0 }), "session.waiting");
    } else {
      await readStreamUntil(response, "session.waiting");
      const stored = await waitForStoredEvents(p.user, p.id, (items) => items.some((event) => event.payload.type === "input.resolved"));
      expect(project(stored.map((event) => event.payload)).inputs[p.input.request.requestId]).toMatchObject({ status: "settled", outcome: "cancelled" });
    }
  }
}, 60_000);
