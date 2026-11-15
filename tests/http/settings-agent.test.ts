import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { MessageStreamEvent } from "eve/client";
import { describe, expect, test } from "vitest";

import type { User } from "../../lib/db/schema";
import { appOutput, fetchApp } from "./support/app";
import { loginAs } from "./support/auth";
import { createSessionAs, eveClientAs, readStreamUntil, sendAndWait } from "./support/chat";
import { createUser } from "./support/db";

const PREFIX = "Общие указания пользователя. Это его пожелания по стилю и привычкам работы:";

async function save(user: User, text: string) {
  const response = await fetchApp("/api/settings", {
    method: "PATCH",
    headers: { cookie: await loginAs(user), "Content-Type": "application/json" },
    body: JSON.stringify({ customInstructions: text }),
  });
  expect(response.status).toBe(200);
}

function reply(events: readonly MessageStreamEvent[]): string {
  const message = events.filter((event) => event.type === "message.completed").at(-1);
  expect(message).toBeDefined();
  return message!.data.message;
}

function systemText(prompt: string): string {
  return prompt.split("\n---\n")
    .filter((block) => block.startsWith("[system]\n"))
    .map((block) => block.slice("[system]\n".length))
    .join("\n");
}

describe("указания на каждом ходу", () => {
  test("сохранение и очистка меняют system того же корня без переноса в историю", async () => {
    const user = await createUser();
    const { id } = await createSessionAs(user);
    const initial = reply(await sendAndWait(user, id, "/prompt"));
    expect(systemText(initial)).not.toContain(PREFIX);

    const guidelines = "Пиши кратко. Личная метка guidelines-private-26.";
    await save(user, guidelines);
    const updated = reply(await sendAndWait(user, id, "/prompt"));
    expect(systemText(updated)).toContain(`${PREFIX}`);
    expect(systemText(updated)).toContain(`\n\n${guidelines}`);

    await save(user, "");
    const cleared = reply(await sendAndWait(user, id, "/prompt"));
    expect(systemText(cleared)).not.toContain(PREFIX);
    expect(cleared).not.toContain(guidelines);
    expect(appOutput()).not.toContain(guidelines);
  }, 90_000);

  test("настройки пользователя не применяются к чужой сессии", async () => {
    const userA = await createUser();
    const userB = await createUser();
    await save(userA, "Уникальная инструкция пользователя Альфа.");
    const sessionA = await createSessionAs(userA);
    const sessionB = await createSessionAs(userB);
    expect(systemText(reply(await sendAndWait(userB, sessionB.id, "/prompt"))))
      .not.toContain("Уникальная инструкция пользователя Альфа.");
    expect(systemText(reply(await sendAndWait(userA, sessionA.id, "/prompt"))))
      .toContain("Уникальная инструкция пользователя Альфа.");
  }, 90_000);

  test("копия агента получает общие указания в system своего запроса", async () => {
    const user = await createUser();
    await save(user, "Пожелания для корня и копии.");
    const { id } = await createSessionAs(user);
    const events = await sendAndWait(user, id, '/tool agent {"message":"/prompt"}');
    const started = events.find((event) => event.type === "agent.started");
    expect(started).toBeDefined();
    const client = await eveClientAs(user, id);
    const child = await readStreamUntil(
      client.sessions.attach(started!.data.sessionId).stream({ follow: false }),
      "session.waiting",
    );
    expect(systemText(reply(child))).toContain("Пожелания для корня и копии.");
  }, 90_000);

  test("информация оператора объявляет определитель turn.started без содержимого", async () => {
    const user = await createUser({ isOperator: true });
    const response = await fetchApp("/eve/v1/info", { headers: { cookie: await loginAs(user) } });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.instructions.dynamic).toEqual(expect.arrayContaining([
      expect.objectContaining({ slug: "user-guidelines", eventNames: ["turn.started"] }),
    ]));
  });

  test("обычный ход не раскрывает указания в событиях, журнале и локальном системном промпте трассы", async () => {
    const user = await createUser();
    const guidelines = "Личные пожелания guidelines-trace-private-26.";
    await save(user, guidelines);
    const { id } = await createSessionAs(user);
    const events = await sendAndWait(user, id, "Обычное сообщение без диагностики");
    expect(reply(events)).toBe("Эхо: Обычное сообщение без диагностики");
    expect(JSON.stringify(events)).not.toContain(guidelines);
    expect(appOutput()).not.toContain(guidelines);

    const started = events.find((event) => event.type === "turn.started");
    const traceId = started?.data.trace?.traceId;
    expect(traceId).toMatch(/^[0-9a-f]{32}$/);
    const directory = join(".eve/traces/v1", traceId!, "segments");
    await expect.poll(async () => {
      const files = await readdir(directory).catch(() => []);
      const reports = await Promise.all(files.filter((name) => name.endsWith(".otlp.json"))
        .map(async (name) => JSON.parse(await readFile(join(directory, name), "utf8")) as {
          resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{
            name: string;
            attributes: Array<{ key: string }>;
          }> }> }>;
        }));
      const spans = reports.flatMap((report) =>
        report.resourceSpans.flatMap((resource) => resource.scopeSpans.flatMap((scope) => scope.spans)),
      );
      const model = spans.find((span) => span.name.startsWith("chat "));
      return {
        hasModel: model !== undefined,
        hasSystemPrompt: model?.attributes.some((attribute) =>
          attribute.key === "gen_ai.system_instructions" || attribute.key === "ai.prompt",
        ) ?? false,
        hasGuidelines: JSON.stringify(reports).includes(guidelines),
      };
    }, { timeout: 10_000 }).toEqual({
      hasModel: true,
      hasSystemPrompt: false,
      hasGuidelines: false,
    });
  }, 30_000);
});
