/**
 * Доставка загруженного файла агенту (#9): канал eve забирает байты из S3 по
 * `fileUrl`, кладёт их в песочницу и отказывает чужим и битым файлам.
 */
import { createHash, randomUUID } from "node:crypto";
import { beforeEach, describe, expect, test } from "vitest";

import type { MessageStreamEvent } from "eve/client";

import { media } from "../../lib/db/schema";
import { uploadObjectKey } from "../../lib/uploads/keys";
import { startApp } from "./support/app";
import { createSessionAs, sendContentAndWait, sendWithFiles } from "./support/chat";
import { createDaytonaKey, createUser, db, resetDatabase } from "./support/db";
import { startEveDev } from "./support/eve-dev";
import { fakeSandbox } from "./support/fake-sandbox";
import { s3 } from "./support/s3";
import { telegramStub } from "./support/telegram";
import { uploadBytes } from "./support/uploads";

beforeEach(async () => {
  await telegramStub.reset();
  await resetDatabase();
  await fakeSandbox.reset();
  await s3().deletePrefix("");
  await createDaytonaKey();
});

/** Каталог, в который eve складывает входящие вложения. */
const ATTACHMENTS = "/workspace/.eve/attachments";

function hashPrefix(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}

async function sandboxAttachments(appSessionId: string): Promise<string[]> {
  return fakeSandbox.files.list(appSessionId, ATTACHMENTS);
}

function filePart(events: readonly MessageStreamEvent[]): Record<string, unknown> {
  const received = events.find((event) => event.type === "message.received");
  if (received === undefined) throw new Error("в потоке нет message.received");
  const parts = (received.data as { parts?: Array<Record<string, unknown>> }).parts ?? [];
  const part = parts.find((item) => item.type === "file");
  if (part === undefined) throw new Error("в message.received нет файловой части");
  return part;
}

async function directUpload(input: {
  userId: string;
  appSessionId: string;
  name: string;
  contentType: string;
  sizeBytes: number;
  bytes?: Uint8Array;
}): Promise<string> {
  const id = randomUUID();
  const objectKey = uploadObjectKey({
    userId: input.userId,
    appSessionId: input.appSessionId,
    uploadId: id,
    name: input.name,
  });
  if (input.bytes !== undefined) await s3().put(objectKey, input.bytes, input.contentType);
  await db().insert(media).values({
    id,
    userId: input.userId,
    appSessionId: input.appSessionId,
    kind: "upload",
    objectKey,
    contentType: input.contentType,
    sizeBytes: input.sizeBytes,
    originalName: input.name,
  });
  return id;
}

describe("доставка файла агенту", () => {
  test("файл из загрузки доходит до песочницы, поток называет имя и тип", async () => {
    const user = await createUser();
    const { id } = await createSessionAs(user);
    const bytes = new TextEncoder().encode("id,name\n1,Отчёт\n");

    const ticket = await uploadBytes(
      user,
      { appSessionId: id, name: "report.csv", contentType: "text/csv", sizeBytes: bytes.length },
      bytes,
    );
    const events = await sendWithFiles(user, id, "Посмотри отчёт", [ticket.id]);

    expect(filePart(events)).toMatchObject({
      filename: "report.csv",
      mediaType: "text/csv",
      url: `http://localhost:3100/api/media/${ticket.id}`,
    });
    expect(filePart(events)).not.toHaveProperty("size");

    const path = `${ATTACHMENTS}/${hashPrefix(bytes)}/report.csv`;
    expect(await sandboxAttachments(id)).toContain(path);
    expect(new Uint8Array((await fakeSandbox.files.read(id, path))!)).toEqual(bytes);
  }, 30_000);

  test("русское имя с пробелом ложится как имя eve: только буквы, цифры, точка и дефис", async () => {
    const user = await createUser();
    const { id } = await createSessionAs(user);
    const bytes = new TextEncoder().encode("a;b\n");

    const ticket = await uploadBytes(
      user,
      {
        appSessionId: id,
        name: "Отчёт 2026.csv",
        contentType: "text/csv",
        sizeBytes: bytes.length,
      },
      bytes,
    );
    await sendWithFiles(user, id, "", [ticket.id]);

    const path = `${ATTACHMENTS}/${hashPrefix(bytes)}/_2026.csv`;
    expect(await sandboxAttachments(id)).toContain(path);
    expect(new Uint8Array((await fakeSandbox.files.read(id, path))!)).toEqual(bytes);
  }, 30_000);

  test("файл 30 МиБ доходит, когда предел канала поднят", async () => {
    const size = 30 * 1024 * 1024;
    const eve = await startEveDev({
      UPLOAD_MAX_BYTES: "33554432",
      EVE_DEV_STATE_DIR: `.tmp/eve-upload-large-${process.pid}`,
    });
    const app = await startApp({
      env: { EVE_BASE_URL: eve.url, UPLOAD_MAX_BYTES: "33554432" },
    });

    try {
      const user = await createUser();
      const { id } = await createSessionAs(user, { baseUrl: app.url });
      const bytes = new Uint8Array(size);
      bytes.fill(7);
      const mediaId = await directUpload({
        userId: user.id,
        appSessionId: id,
        name: "big.bin",
        contentType: "application/octet-stream",
        sizeBytes: size,
        bytes,
      });

      await sendWithFiles(user, id, "Вот файл", [mediaId], { baseUrl: app.url });

      const path = `${ATTACHMENTS}/${hashPrefix(bytes)}/big.bin`;
      expect(await sandboxAttachments(id)).toContain(path);
      const stored = await fakeSandbox.files.read(id, path);
      expect(stored?.byteLength).toBe(size);
    } finally {
      await app.stop();
      await eve.stop();
    }
  }, 300_000);
});

describe("отказы при доставке", () => {
  test("чужой файл, файл без объекта, несовпадение размера и произвольный адрес не попадают в песочницу", async () => {
    const owner = await createUser();
    const ownerSession = await createSessionAs(owner);
    const ownerBytes = new TextEncoder().encode("чужое");
    const foreignId = await uploadBytes(
      owner,
      {
        appSessionId: ownerSession.id,
        name: "foreign.txt",
        contentType: "text/plain",
        sizeBytes: ownerBytes.length,
      },
      ownerBytes,
    );

    const user = await createUser();
    const { id } = await createSessionAs(user);

    const withoutObject = await directUpload({
      userId: user.id,
      appSessionId: id,
      name: "missing.bin",
      contentType: "application/octet-stream",
      sizeBytes: 10,
    });
    const mismatched = await directUpload({
      userId: user.id,
      appSessionId: id,
      name: "mismatch.bin",
      contentType: "application/octet-stream",
      sizeBytes: 10,
      bytes: new Uint8Array(20),
    });
    const aboveLimit = await directUpload({
      userId: user.id,
      appSessionId: id,
      name: "limit.bin",
      contentType: "application/octet-stream",
      sizeBytes: 2_000_000,
      bytes: new Uint8Array(2_000_000),
    });

    await sendWithFiles(user, id, "Чужой файл", [foreignId.id]);
    await sendWithFiles(user, id, "Без объекта", [withoutObject]);
    await sendWithFiles(user, id, "Не тот размер", [mismatched]);
    await sendWithFiles(user, id, "Больше предела", [aboveLimit]);
    await sendContentAndWait(user, id, [
      { type: "text", text: "Произвольный адрес" },
      {
        type: "file",
        data: "https://example.com/x.png",
        mediaType: "image/png",
        filename: "x.png",
      },
    ]);

    expect(await sandboxAttachments(id)).toEqual([]);
  }, 60_000);
});
