/** Удаление сессии закрывает чтение медиа и компенсирует позднюю публикацию. */
import { eq } from "drizzle-orm";
import type { FetchFileContext } from "eve/channels";
import type { SandboxSession } from "eve/sandbox";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { fetchUserAttachment } from "../../agent/lib/attachment-fetch";
import { loadConfig } from "../../lib/config";
import { appSessions, media, messageFiles, toolCallMedia } from "../../lib/db/schema";
import { copySandboxFile } from "../../lib/media/copy";
import * as liveSession from "../../lib/media/live-session";
import { captureMessageFiles } from "../../lib/media/message-files";
import { publishToolMedia } from "../../lib/media/publish-tool-media";
import { findMediaForUser, listSessionFiles } from "../../lib/media/service";
import { Storage } from "../../lib/s3";
import { fetchApp } from "./support/app";
import { loginAs } from "./support/auth";
import { createSessionAs, sendAndWait, waitForStoredEvents } from "./support/chat";
import { createDaytonaKey, createUser, db, resetDatabase } from "./support/db";
import { fakeSandbox } from "./support/fake-sandbox";
import { fakeMachineFor, sandboxSessionFrom } from "./support/sandbox-session";
import { s3 } from "./support/s3";
import { telegramStub } from "./support/telegram";
import { requestUpload } from "./support/uploads";

beforeEach(async () => {
  await telegramStub.reset();
  await resetDatabase();
  await fakeSandbox.reset();
  await s3().deletePrefix("");
});

afterEach(() => vi.restoreAllMocks());

async function fixture() {
  const user = await createUser();
  const [session] = await db().insert(appSessions)
    .values({ userId: user.id, eveSessionId: `eve_${user.id}` }).returning();
  const id = session!.id;
  await fakeSandbox.seed(id, { "out/file.mp4": "video" });
  const sandbox = sandboxSessionFrom(await fakeMachineFor(id));
  return {
    user,
    id,
    prefix: `u/${user.id}/s/${id}/`,
    sandbox,
    ctx: {
      session: { id: session!.eveSessionId! },
      callId: "call_media",
      getSandbox: async () => sandbox,
    },
  };
}

async function softDelete(id: string): Promise<void> {
  await db().update(appSessions).set({ deletedAt: new Date() }).where(eq(appSessions.id, id));
}

/** Настоящий S3 с детерминированным барьером внутри конкретной загрузки. */
class InterleavedStorage extends Storage {
  writes = 0;

  constructor(
    private readonly afterWrite: () => Promise<void>,
    private readonly beforeWrite: () => Promise<void> = async () => {},
  ) {
    super(loadConfig());
  }

  override async putObject(
    key: string,
    body: Uint8Array | string,
    contentType?: string,
  ): Promise<void> {
    this.writes++;
    await this.beforeWrite();
    await super.putObject(key, body, contentType);
    await this.afterWrite();
  }

  override async putStream(
    key: string,
    body: ReadableStream<Uint8Array>,
    contentType: string,
  ): Promise<void> {
    this.writes++;
    await this.beforeWrite();
    await super.putStream(key, body, contentType);
    await this.afterWrite();
  }
}

describe("медиа удалённой сессии", () => {
  test("soft delete закрывает все виды медиа, список файлов, вложения и новые загрузки", async () => {
    const { user, id, prefix } = await fixture();
    const cookie = await loginAs(user);
    const rows = [];
    for (const kind of ["upload", "message_file", "tool_media", "preview"] as const) {
      const objectKey = `${prefix}${kind}/file.mp4`;
      await s3().put(objectKey, "video", "video/mp4");
      const [row] = await db().insert(media).values({
        userId: user.id,
        appSessionId: id,
        kind,
        objectKey,
        contentType: "video/mp4",
        sizeBytes: 5,
        originalName: "file.mp4",
      }).returning();
      rows.push(row!);
    }
    await db().insert(messageFiles).values({
      appSessionId: id,
      messageId: "turn_0:0",
      sandboxPath: "/workspace/out/file.mp4",
      state: "ready",
      mediaId: rows[1]!.id,
    });
    expect((await fetchApp(`/api/media/${rows[0]!.id}`, { headers: { cookie } })).status).toBe(302);

    await softDelete(id);
    for (const row of rows) {
      expect(await findMediaForUser(row.id, user.id)).toBeNull();
      expect((await fetchApp(`/api/media/${row.id}`, { headers: { cookie } })).status).toBe(404);
    }
    expect(await listSessionFiles(id)).toEqual([]);
    expect((await fetchApp(`/api/sessions/${id}/files`, { headers: { cookie } })).status).toBe(404);
    expect((await requestUpload(user, {
      appSessionId: id, name: "new.txt", contentType: "text/plain", sizeBytes: 1,
    })).status).toBe(404);

    const context = {
      session: { auth: { current: { principalId: user.id } } },
    } as unknown as FetchFileContext;
    await expect(fetchUserAttachment(
      `${loadConfig().appUrl}/api/media/${rows[0]!.id}`, context,
    )).rejects.toThrow("Файл недоступен");
    expect(await db().select().from(media)).toHaveLength(4);
    // Запрет чтения не зависит от того, успела ли очистка S3.
    expect(await s3().listKeys(prefix)).toHaveLength(4);
  });

  test("кэш владельца не разрешает хук после soft delete; инструмент не открывает песочницу", async () => {
    const { user, id, prefix, ctx } = await fixture();
    await softDelete(id);
    const getSandbox = vi.fn(async (): Promise<SandboxSession> => {
      throw new Error("Удалённая сессия не должна открывать песочницу");
    });
    await captureMessageFiles({
      appSessionId: id,
      userId: user.id,
      messageId: "turn_0:0",
      links: [{ kind: "file", path: "/workspace/out/file.mp4" }],
      maxBytes: 100,
      getSandbox,
    });
    await expect(publishToolMedia({ ...ctx, getSandbox }, { path: "out/file.mp4" }))
      .rejects.toMatchObject({ reason: "no_session" });
    expect(getSandbox).not.toHaveBeenCalled();
    expect(await db().select().from(messageFiles)).toEqual([]);
    expect(await s3().listKeys(prefix)).toEqual([]);
  });

  test("message.completed начатого по HTTP хода после метки не публикует файл", async () => {
    await createDaytonaKey();
    const user = await createUser();
    const { id } = await createSessionAs(user);
    await fakeSandbox.seed(id, { "out/file.mp4": "video" });
    const finished = sendAndWait(user, id, "/slow 3 [ролик](out/file.mp4)");
    // Подписываем обработчик отказа сразу, даже если ожидание события упадёт.
    void finished.catch(() => undefined);
    await waitForStoredEvents(user, id, (events) =>
      events.some((event) => event.payload.type === "step.started"),
    );
    await softDelete(id);
    const events = await finished;
    expect(events.some((event) => event.type === "message.completed")).toBe(true);
    expect(await db().select().from(messageFiles).where(eq(messageFiles.appSessionId, id))).toEqual([]);
    expect(await s3().listKeys(`u/${user.id}/s/${id}/`)).toEqual([]);
  });

  test("повторная проверка перед put не пишет объект, если удаление случилось при чтении файла", async () => {
    const { user, id, prefix, sandbox } = await fixture();
    const originalRead = sandbox.readFile.bind(sandbox);
    vi.spyOn(sandbox, "readFile").mockImplementation(async (...args) => {
      const result = await originalRead(...args);
      await softDelete(id);
      return result;
    });
    const storage = new InterleavedStorage(async () => {});
    await expect(copySandboxFile({
      sandbox, path: "out/file.mp4", maxBytes: 100,
      userId: user.id, appSessionId: id, storage,
    })).rejects.toMatchObject({ reason: "copy_failed" });
    expect(storage.writes).toBe(0);
    expect(await s3().listKeys(prefix)).toEqual([]);
  });

  for (const duringUpload of [false, true]) {
    test(`проверенный снимок превью: удаление ${duringUpload ? "во время" : "до"} загрузки не оставляет объект`, async () => {
      const { user, id, prefix, sandbox } = await fixture();
      if (!duringUpload) await softDelete(id);
      const storage = new InterleavedStorage(async () => {}, async () => {
        await softDelete(id);
        await s3().deletePrefix(prefix);
      });
      await expect(copySandboxFile({
        sandbox, path: "out/preview.jpg", maxBytes: 100,
        userId: user.id, appSessionId: id, storage,
        kind: "preview", contentType: "image/jpeg",
        validatedBytes: new Uint8Array([255, 216, 255, 217]),
      })).rejects.toMatchObject({ reason: "copy_failed" });
      expect(storage.writes).toBe(duringUpload ? 1 : 0);
      expect(await s3().listKeys(prefix)).toEqual([]);
    });
  }

  for (const deletion of ["soft", "physical"] as const) {
    for (const kind of ["message_file", "tool_media", "preview"] as const) {
      test(`${kind}: ${deletion} delete во время put не оставляет объект после очистки префикса`, async () => {
        const { user, id, prefix, sandbox, ctx } = await fixture();
        const storage = new InterleavedStorage(async () => {}, async () => {
          if (deletion === "soft") await softDelete(id);
          else await db().delete(appSessions).where(eq(appSessions.id, id));
          // Оба прохода очистки успели до поздней загрузки. Её объект обязан
          // убрать сам писатель после завершения put.
          await s3().deletePrefix(prefix);
          await s3().deletePrefix(prefix);
        });
        if (kind === "message_file") {
          await captureMessageFiles({
            appSessionId: id, userId: user.id, messageId: "turn_0:0",
            links: [{ kind: "file", path: "/workspace/out/file.mp4" }],
            maxBytes: 100, getSandbox: async () => sandbox, storage,
          });
        } else {
          await expect(publishToolMedia(ctx, { path: "out/file.mp4", kind }, { storage }))
            .rejects.toMatchObject({ reason: "copy_failed" });
        }
        expect(storage.writes).toBe(1);
        expect(await s3().listKeys(prefix)).toEqual([]);
        expect(await db().select().from(media)).toEqual([]);
        expect(await db().select().from(toolCallMedia)).toEqual([]);
        const files = await db().select().from(messageFiles);
        expect(files.every((file) => file.state !== "ready")).toBe(true);
      });
    }
  }

  test("физическое удаление после post-put check, до публикации строк компенсирует объект", async () => {
    const { id, prefix, ctx } = await fixture();
    const original = liveSession.requireLiveMediaSession;
    let checks = 0;
    vi.spyOn(liveSession, "requireLiveMediaSession").mockImplementation(async (appSessionId) => {
      await original(appSessionId);
      if (++checks === 2) await db().delete(appSessions).where(eq(appSessions.id, id));
    });
    await expect(publishToolMedia(ctx, { path: "out/file.mp4" }))
      .rejects.toMatchObject({ reason: "no_session" });
    expect(checks).toBe(2);
    expect(await s3().listKeys(prefix)).toEqual([]);
    expect(await db().select().from(media)).toEqual([]);
  });

  test("ошибка INSERT связи откатывает media и удаляет уже скопированный объект", async () => {
    const { prefix, ctx } = await fixture();
    // Намеренное нарушение NOT NULL моделирует отказ второй SQL-записи.
    await expect(publishToolMedia(
      { ...ctx, callId: null as unknown as string }, { path: "out/file.mp4" },
    )).rejects.toMatchObject({ reason: "copy_failed" });
    expect(await db().select().from(media)).toEqual([]);
    expect(await db().select().from(toolCallMedia)).toEqual([]);
    expect(await s3().listKeys(prefix)).toEqual([]);
  });

  test("исчезновение message_files откатывает media, не оставляя сироту S3", async () => {
    const { user, id, prefix, sandbox } = await fixture();
    const storage = new InterleavedStorage(async () => {
      await db().delete(messageFiles).where(eq(messageFiles.appSessionId, id));
    });
    await captureMessageFiles({
      appSessionId: id, userId: user.id, messageId: "turn_0:0",
      links: [{ kind: "file", path: "/workspace/out/file.mp4" }],
      maxBytes: 100, getSandbox: async () => sandbox, storage,
    });
    expect(await db().select().from(media)).toEqual([]);
    expect(await s3().listKeys(prefix)).toEqual([]);
  });

  test("параллельная публикация прежнего callId сохраняет одну связь и один объект", async () => {
    const { prefix, ctx } = await fixture();
    const results = await Promise.all([
      publishToolMedia(ctx, { path: "out/file.mp4" }),
      publishToolMedia(ctx, { path: "out/file.mp4" }),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(await db().select().from(media)).toHaveLength(1);
    expect(await db().select().from(toolCallMedia)).toHaveLength(1);
    expect(await s3().listKeys(prefix)).toHaveLength(1);
  });
});
