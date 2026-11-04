import { eq } from "drizzle-orm";
import type { MessageStreamEvent } from "eve/client";
import { readFileSync } from "node:fs";
import { expect, test, vi } from "vitest";

import { publishReadFileImage } from "../../agent/lib/read-file-media";
import { loadConfig } from "../../lib/config";
import { appSessions, media, toolCallMedia } from "../../lib/db/schema";
import { Storage } from "../../lib/s3";
import { fetchApp } from "./support/app";
import { loginAs } from "./support/auth";
import { createSessionAs, sendAndWait } from "./support/chat";
import { createDaytonaKey, createUser, db } from "./support/db";
import { fakeSandbox } from "./support/fake-sandbox";
import { fakeMachineFor, sandboxSessionFrom } from "./support/sandbox-session";
import { s3 } from "./support/s3";

const jpeg = new Uint8Array(readFileSync(new URL("../fixtures/frame.jpeg", import.meta.url)));

function readResult(events: readonly MessageStreamEvent[]) {
  const result = events.find((event) => event.type === "action.result" &&
    event.data.result.kind === "tool-result" && event.data.result.toolName === "read_file");
  if (result?.type !== "action.result") throw new Error("Нет результата чтения");
  return result.data;
}

test("просмотренный JPEG сохраняется для владельца и доступен без песочницы", async () => {
  await createDaytonaKey();
  const user = await createUser();
  const { id } = await createSessionAs(user);
  await fakeSandbox.seed(id, { "frames/a.jpeg": jpeg });

  const result = readResult(await sendAndWait(user, id, '/tool read_file {"filePath":"frames/a.jpeg"}'));
  expect(result).toMatchObject({ status: "completed", result: { output: {
    path: "/workspace/frames/a.jpeg", file: { mediaType: "image/jpeg", width: 320, height: 180 },
    media: { imageId: expect.any(String) },
  } } });
  const output = result.result.kind === "tool-result" ? result.result.output as { media: { imageId: string } } : null;
  const imageId = output!.media.imageId;
  const [stored] = await db().select().from(media).where(eq(media.id, imageId));
  expect(stored).toMatchObject({ userId: user.id, appSessionId: id, kind: "tool_media", contentType: "image/jpeg" });
  expect(stored!.objectKey).toContain(`u/${user.id}/s/${id}/tool-media/`);
  expect(await s3().getBytes(stored!.objectKey)).toEqual(jpeg);
  expect(await db().select().from(toolCallMedia).where(eq(toolCallMedia.mediaId, imageId))).toMatchObject([
    { appSessionId: id, callId: result.result.callId, sandboxPath: "/workspace/frames/a.jpeg" },
  ]);

  await fakeSandbox.stop(id);
  const counters = await fakeSandbox.counters();
  const response = await fetchApp(`/api/media/${imageId}`, { headers: { cookie: await loginAs(user) } });
  expect(response.status).toBe(302);
  expect(new Uint8Array(await (await fetch(response.headers.get("location")!)).arrayBuffer())).toEqual(jpeg);
  const stranger = await createUser();
  expect((await fetchApp(`/api/media/${imageId}`, { headers: { cookie: await loginAs(stranger) } })).status).toBe(404);
  expect(await fakeSandbox.counters()).toEqual(counters);
});

test("текст, PDF и слишком большое изображение не публикуются", async () => {
  await createDaytonaKey();
  const user = await createUser();
  const { id } = await createSessionAs(user);
  const big = new Uint8Array(3 * 1024 * 1024 + 1);
  big.set(jpeg);
  await fakeSandbox.seed(id, {
    "notes.txt": "Текст без картинки\n",
    "document.pdf": "%PDF-1.4\n1 0 obj<</Type /Catalog>>endobj\n%%EOF",
    "frames/big.jpeg": big,
  });
  for (const filePath of ["notes.txt", "document.pdf"]) {
    const result = readResult(await sendAndWait(user, id, `/tool read_file ${JSON.stringify({ filePath })}`));
    expect(result.status).toBe("completed");
    expect(result.result.kind).toBe("tool-result");
    if (result.result.kind !== "tool-result") throw new Error("Нет результата");
    expect(result.result.output).not.toHaveProperty("media");
    if (filePath.endsWith(".pdf")) expect(result.result.output).toHaveProperty("file.mediaType", "application/pdf");
    else expect(result.result.output).toHaveProperty("content", "1: Текст без картинки");
  }
  const tooLarge = readResult(await sendAndWait(user, id, '/tool read_file {"filePath":"frames/big.jpeg"}'));
  expect(tooLarge.status).toBe("failed");
  expect(JSON.stringify(tooLarge)).toContain("3 MiB");
  expect(await db().select().from(media).where(eq(media.appSessionId, id))).toEqual([]);
  expect(await db().select().from(toolCallMedia).where(eq(toolCallMedia.appSessionId, id))).toEqual([]);
  expect(await s3().listKeys(`u/${user.id}/`)).toEqual([]);
});

test("сбой S3 и отсутствие сессии сохраняют исходный результат просмотра", async () => {
  await createDaytonaKey();
  const user = await createUser();
  const { id } = await createSessionAs(user);
  // Привязывает настоящую сессию приложения, не публикуя файлов.
  await sendAndWait(user, id, "Начало беседы");
  const [session] = await db().select().from(appSessions).where(eq(appSessions.id, id));
  await fakeSandbox.seed(id, { "frames/a.jpeg": jpeg });
  const sandbox = sandboxSessionFrom(await fakeMachineFor(id));
  const output = {
    path: "/workspace/frames/a.jpeg", content: "Просмотренный кадр", totalLines: 0, truncated: false,
    file: { mediaType: "image/jpeg", width: 320, height: 180, size: jpeg.length },
  };
  const ctx = { session: { id: session!.eveSessionId! }, callId: "read_s3_failure", getSandbox: async () => sandbox };
  const brokenStorage = new Storage({ ...loadConfig(), s3AccessKeyId: "invalid-key", s3SecretAccessKey: "invalid-secret" });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect(await publishReadFileImage(output, ctx, { storage: brokenStorage })).toEqual(output);
    expect(await publishReadFileImage(output, { ...ctx, session: { id: "no_such_session" } })).toEqual(output);
    expect(warn.mock.calls).toEqual([
      ["[read_file:media] Кадр не сохранён:", "copy_failed"],
      ["[read_file:media] Кадр не сохранён:", "no_session"],
    ]);
  } finally {
    warn.mockRestore();
  }
  expect(await db().select().from(media).where(eq(media.appSessionId, id))).toEqual([]);
  expect(await db().select().from(toolCallMedia).where(eq(toolCallMedia.appSessionId, id))).toEqual([]);
  expect(await s3().listKeys(`u/${user.id}/`)).toEqual([]);
});
