/**
 * Повтор шагов публикации: `copying` — незавершённая работа, а не таймер.
 */
import type { HookContext } from "eve/hooks";
import { beforeEach, describe, expect, test } from "vitest";

import messageFilesHook from "../../agent/hooks/message-files";
import { media, messageFiles } from "../../lib/db/schema";
import { mediaObjectKey } from "../../lib/media/keys";
import { captureMessageFiles } from "../../lib/media/message-files";
import { parseSandboxLinks } from "../../lib/media/sandbox-path";
import type { Storage } from "../../lib/s3";
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
  test("сессия-копия агента пропускается до обращения к базе", async () => {
    const handler = messageFilesHook.events?.["message.completed"];
    expect(handler).toBeTypeOf("function");

    const ctx = {
      session: { id: "evt-child", parent: { rootSessionId: "evt-root" } },
      getSandbox: async () => {
        throw new Error("песочница не должна открываться");
      },
    } as unknown as HookContext;
    await handler!(
      {
        type: "message.completed",
        data: { message: "[файл](out/final.mp4)", stepIndex: 0, turnId: "turn_0" },
      } as never,
      ctx,
    );

    expect(await db().select().from(messageFiles)).toEqual([]);
  });
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

    await Promise.all([captureMessageFiles(options), captureMessageFiles(options)]);
    await captureMessageFiles({
      ...options,
      getSandbox: async () => { throw new Error("готовая копия не открывает песочницу"); },
    });

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

  test("повтор шага сразу подбирает незавершённую запись даже без повторной ссылки", async () => {
    const user = await createUser();
    const { id } = await createSessionAs(user);
    await fakeSandbox.seed(id, { "out/final.mp4": "кадры" });
    const sandbox = sandboxSessionFrom(await fakeMachineFor(id));
    await db().insert(messageFiles).values({
      appSessionId: id,
      messageId: "turn_0:0",
      sandboxPath: "/workspace/out/final.mp4",
      state: "copying",
    });

    await captureMessageFiles({
      appSessionId: id,
      messageId: "turn_0:0",
      links: [],
      maxBytes: 1024 * 1024,
      userId: user.id,
      getSandbox: async () => sandbox,
    });

    const rows = await db().select().from(messageFiles);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe("ready");
    expect(await db().select().from(media)).toHaveLength(1);
  }, 30_000);

  test("отказ S3 переводит строку в missing/copy_failed", async () => {
    const user = await createUser();
    const { id } = await createSessionAs(user);
    await fakeSandbox.seed(id, { "out/final.mp4": new TextEncoder().encode("кадры") });
    const sandbox = sandboxSessionFrom(await fakeMachineFor(id));
    const failing = {
      objectInfo: async () => null,
      putStream: async () => {
        throw new Error("S3 недоступен");
      },
      deleteObject: async () => undefined,
    } as unknown as Storage;

    await captureMessageFiles({
      appSessionId: id,
      messageId: "turn_0:0",
      links: [{ kind: "file", path: "/workspace/out/final.mp4" }],
      maxBytes: 1024 * 1024,
      userId: user.id,
      storage: failing,
      getSandbox: async () => sandbox,
    });

    const [row] = await db().select().from(messageFiles);
    expect(row).toMatchObject({ state: "missing", reason: "copy_failed", mediaId: null });
    expect(await db().select().from(media)).toEqual([]);
    expect(await s3().listKeys(`u/${user.id}/`)).toEqual([]);
  }, 30_000);

  test("несколько блоков одного шага делят предел в 20 ссылок", async () => {
    const user = await createUser();
    const { id } = await createSessionAs(user);
    const first = Array.from({ length: 15 }, (_, index) => ({
      kind: "rejected" as const,
      path: `/etc/p${index}`,
      reason: "outside_workspace" as const,
    }));
    const second = Array.from({ length: 15 }, (_, index) => ({
      kind: "rejected" as const,
      path: `/etc/q${index}`,
      reason: "outside_workspace" as const,
    }));

    for (const links of [first, second]) {
      await captureMessageFiles({
        appSessionId: id,
        messageId: "turn_0:0",
        links,
        maxBytes: 1024 * 1024,
        userId: user.id,
        getSandbox: async () => {
          throw new Error("для отвергнутых ссылок песочница не нужна");
        },
      });
    }

    const rows = await db().select().from(messageFiles);
    expect(rows).toHaveLength(30);
    expect(rows.filter((row) => row.reason === "too_many")).toHaveLength(10);
    expect(rows.filter((row) => row.reason === "outside_workspace")).toHaveLength(20);
  }, 30_000);

  test("повтор принимает завершённый объект S3 после сбоя перед записью media", async () => {
    const user = await createUser();
    const { id } = await createSessionAs(user);
    const [pending] = await db().insert(messageFiles).values({
      appSessionId: id,
      messageId: "turn_0:0",
      sandboxPath: "/workspace/out/final.mp4",
      state: "copying",
    }).returning();
    const key = mediaObjectKey({
      userId: user.id, appSessionId: id, kind: "message_file", name: "final.mp4", objectId: pending!.id,
    });
    const bytes = new TextEncoder().encode("сохранённый ролик");
    await s3().put(key, bytes, "video/mp4");

    await captureMessageFiles({
      appSessionId: id,
      messageId: "turn_0:0",
      links: [{ kind: "file", path: "/workspace/out/final.mp4" }],
      maxBytes: 1024 * 1024,
      userId: user.id,
      getSandbox: async () => {
        throw new Error("объект уже загружен, песочница не нужна");
      },
    });

    const [row] = await db().select().from(messageFiles);
    expect(row?.state).toBe("ready");
    expect(row?.mediaId).not.toBeNull();
    expect(await db().select().from(media)).toHaveLength(1);
    expect(await s3().getBytes(key)).toEqual(bytes);
  }, 30_000);

  test("даже старая copying остаётся copying; чтение не открывает песочницу", async () => {
    const user = await createUser();
    const { id } = await createSessionAs(user);
    const stale = new Date(Date.now() - 24 * 60 * 60 * 1000);
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
      expect.objectContaining({ state: "copying", reason: null }),
    ]);
    expect(await fakeSandbox.calls(id)).toEqual([]);
  });
});
