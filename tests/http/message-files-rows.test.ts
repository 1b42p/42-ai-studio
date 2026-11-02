/**
 * Идемпотентность и зависшие строки `message_files` (#8): повторная доставка
 * хука не дублирует копию, `copying` старше 15 минут перезапускается или
 * показывается как `copy_failed`.
 */
import { beforeEach, describe, expect, test } from "vitest";

import { media, messageFiles } from "../../lib/db/schema";
import { COPYING_STALE_MS } from "../../lib/media/files";
import { captureMessageFiles } from "../../lib/media/message-files";
import { parseSandboxLinks } from "../../lib/media/sandbox-path";
import { fetchApp } from "./support/app";
import { loginAs } from "./support/auth";
import { createSessionAs } from "./support/chat";
import { createUser, db, resetDatabase } from "./support/db";
import { fakeSandbox } from "./support/fake-sandbox";
import { fakeMachineFor, sandboxSessionFrom } from "./support/sandbox-session";
import { s3 } from "./support/s3";
import { telegramStub } from "./support/telegram";

beforeEach(async () => {
  await telegramStub.reset();
  await resetDatabase();
  await fakeSandbox.reset();
  await s3().deletePrefix("");
});

describe("строки файлов сообщения", () => {
  test("повторный вызов не дублирует готовую строку, медиа и объект", async () => {
    const user = await createUser();
    const { id } = await createSessionAs(user);
    const bytes = new TextEncoder().encode("один и тот же файл");
    await fakeSandbox.seed(id, { "out/final.mp4": bytes });
    const sandbox = sandboxSessionFrom(await fakeMachineFor(id));
    const links = parseSandboxLinks("![кадр](out/final.mp4)");
    const options = {
      appSessionId: id,
      messageId: "turn_0:0",
      links,
      maxBytes: 1024 * 1024,
      userId: user.id,
      getSandbox: async () => sandbox,
    };

    await captureMessageFiles(options);
    await captureMessageFiles(options);

    const rows = await db().select().from(messageFiles);
    const mediaRows = await db().select().from(media);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe("ready");
    expect(mediaRows).toHaveLength(1);
    expect(await s3().listKeys(`u/${user.id}/`)).toHaveLength(1);
  }, 30_000);

  test("процент в имени файла раскрывается ровно один раз", async () => {
    const user = await createUser();
    const { id } = await createSessionAs(user);
    const bytes = new TextEncoder().encode("сто процентов");
    await fakeSandbox.seed(id, { "out/100%.txt": bytes });
    const sandbox = sandboxSessionFrom(await fakeMachineFor(id));

    await captureMessageFiles({
      appSessionId: id,
      messageId: "turn_0:0",
      links: parseSandboxLinks("[файл](out/100%25.txt)"),
      maxBytes: 1024 * 1024,
      userId: user.id,
      getSandbox: async () => sandbox,
    });

    const [row] = await db().select().from(messageFiles);
    const [mediaRow] = await db().select().from(media);
    expect(row).toMatchObject({ sandboxPath: "/workspace/out/100%.txt", state: "ready" });
    expect(mediaRow?.originalName).toBe("100%.txt");
    expect(await s3().getBytes(mediaRow!.objectKey)).toEqual(bytes);
  }, 30_000);

  test("зависшая copying старше 15 минут копируется заново", async () => {
    const user = await createUser();
    const { id } = await createSessionAs(user);
    await fakeSandbox.seed(id, { "out/final.mp4": new TextEncoder().encode("кадры") });
    const sandbox = sandboxSessionFrom(await fakeMachineFor(id));
    const stale = new Date(Date.now() - COPYING_STALE_MS - 60_000);

    await db().insert(messageFiles).values({
      appSessionId: id,
      messageId: "turn_0:0",
      sandboxPath: "/workspace/out/final.mp4",
      state: "copying",
      createdAt: stale,
      updatedAt: stale,
    });

    await captureMessageFiles({
      appSessionId: id,
      messageId: "turn_0:0",
      links: [{ kind: "file", path: "/workspace/out/final.mp4" }],
      maxBytes: 1024 * 1024,
      userId: user.id,
      getSandbox: async () => sandbox,
    });

    const [row] = await db().select().from(messageFiles);
    expect(row?.state).toBe("ready");
    expect(row?.mediaId).not.toBeNull();
    expect(await db().select().from(media)).toHaveLength(1);
  }, 30_000);

  test("зависшая copying старше 15 минут отдаётся как missing/copy_failed", async () => {
    const user = await createUser();
    const { id } = await createSessionAs(user);
    const stale = new Date(Date.now() - COPYING_STALE_MS - 60_000);
    await db().insert(messageFiles).values({
      appSessionId: id,
      messageId: "turn_0:0",
      sandboxPath: "/workspace/out/final.mp4",
      state: "copying",
      createdAt: stale,
      updatedAt: stale,
    });

    const cookie = await loginAs(user);
    const response = await fetchApp(`/api/sessions/${id}/files`, { headers: { cookie } });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      files: Array<{ state: string; reason: string | null }>;
    };
    expect(body.files).toEqual([
      expect.objectContaining({ state: "missing", reason: "copy_failed" }),
    ]);
  });
});
