import { eq } from "drizzle-orm";
import { Client, type MessageStreamEvent } from "eve/client";
import { readFileSync } from "node:fs";
import { expect, inject, test } from "vitest";

import { appSessions, media } from "../../lib/db/schema";
import { fetchApp } from "./support/app";
import { loginAs } from "./support/auth";
import { createSessionAs, sendAndWait } from "./support/chat";
import { createDaytonaKey, createUser, db } from "./support/db";
import { fakeSandbox } from "./support/fake-sandbox";
import { s3 } from "./support/s3";
import { setSessionPreview } from "../../lib/session-preview/service";
import { fakeMachineFor, sandboxSessionFrom } from "./support/sandbox-session";
import { loadConfig } from "../../lib/config";
import { Storage } from "../../lib/s3";
import { publishToolMedia } from "../../lib/media/publish-tool-media";

const jpeg = new Uint8Array(readFileSync(new URL("../fixtures/frame.jpeg", import.meta.url)));

function previewResult(events: readonly MessageStreamEvent[]) {
  const result = events.find((event) => event.type === "action.result" &&
    event.data.result.kind === "tool-result" && event.data.result.toolName === "set_session_preview");
  if (result?.type !== "action.result") throw new Error("Нет результата превью");
  return result.data;
}

test("JPEG становится превью сессии, список и S3 отдают точные байты только владельцу", async () => {
  await createDaytonaKey();
  const user = await createUser();
  const { id } = await createSessionAs(user);
  await fakeSandbox.seed(id, { "out/p.jpg": jpeg });
  const result = previewResult(await sendAndWait(user, id, '/tool set_session_preview {"path":"out/p.jpg"}'));
  expect(result).toMatchObject({ status: "completed", result: { output: {
    path: "out/p.jpg", size: jpeg.length, contentType: "image/jpeg",
  } } });
  const [session] = await db().select().from(appSessions).where(eq(appSessions.id, id));
  const [stored] = await db().select().from(media).where(eq(media.appSessionId, id));
  expect(stored).toMatchObject({ kind: "preview", userId: user.id, contentType: "image/jpeg" });
  expect(session).toHaveProperty("previewMediaId", stored!.id);
  const keys = await s3().listKeys(`u/${user.id}/s/${id}/preview/`);
  expect(keys).toEqual([stored!.objectKey]);
  expect(await s3().getBytes(keys[0]!)).toEqual(jpeg);
  const headers = { cookie: await loginAs(user) };
  const list = await (await fetchApp("/api/sessions", { headers })).json();
  expect(list.items).toContainEqual(expect.objectContaining({ id, preview: { mediaId: stored!.id } }));
  const response = await fetchApp(`/api/media/${stored!.id}`, { headers });
  expect(response.status).toBe(302);
  expect(new Uint8Array(await (await fetch(response.headers.get("location")!)).arrayBuffer())).toEqual(jpeg);
  const stranger = await createUser();
  const strangerHeaders = { cookie: await loginAs(stranger) };
  expect((await fetchApp(`/api/media/${stored!.id}`, { headers: strangerHeaders })).status).toBe(404);
  expect((await (await fetchApp("/api/sessions", { headers: strangerHeaders })).json()).items).toEqual([]);
  const replacement = new Uint8Array([...jpeg, 42]);
  await fakeSandbox.files.write(id, "out/new.jpg", replacement);
  expect(previewResult(await sendAndWait(user, id, '/tool set_session_preview {"path":"out/new.jpg"}')).status).toBe("completed");
  expect(await db().select().from(media).where(eq(media.id, stored!.id))).toEqual([]);
  const [newMedia] = await db().select().from(media).where(eq(media.appSessionId, id));
  expect(await s3().listKeys(`u/${user.id}/s/${id}/preview/`)).toEqual([newMedia!.objectKey]);
  expect(await s3().getBytes(newMedia!.objectKey)).toEqual(replacement);
  await db().delete(media).where(eq(media.id, newMedia!.id));
  expect((await db().select().from(appSessions).where(eq(appSessions.id, id)))[0]?.previewMediaId).toBeNull();
  expect((await (await fetchApp("/api/sessions", { headers })).json()).items).toContainEqual(expect.objectContaining({ id, preview: null }));
});

test("ошибочные файлы и пути оставляют прежнее превью без изменений", async () => {
  await createDaytonaKey();
  const user = await createUser();
  const { id } = await createSessionAs(user);
  await fakeSandbox.seed(id, {
    "out/p.jpg": jpeg,
    "out/text.jpg": "не картинка",
    "out/empty.jpg": new Uint8Array(),
    "out/large.jpg": new Uint8Array(1_048_577),
  });
  expect(previewResult(await sendAndWait(user, id, '/tool set_session_preview {"path":"out/p.jpg"}')).status).toBe("completed");
  const [before] = await db().select().from(appSessions).where(eq(appSessions.id, id));
  const rows = await db().select().from(media).where(eq(media.appSessionId, id));
  const keys = await s3().listKeys(`u/${user.id}/s/${id}/preview/`);
  for (const [path, code] of [
    ["out/text.jpg", "preview_not_image"], ["out/empty.jpg", "preview_not_image"],
    ["out/large.jpg", "preview_too_large"], ["out/missing.jpg", "preview_not_found"],
    ["out", "preview_not_found"], ["../../etc/passwd", "preview_bad_path"],
    ["/etc/passwd", "preview_bad_path"], ["out/../p.jpg", "preview_bad_path"],
  ]) {
    const result = previewResult(await sendAndWait(user, id, `/tool set_session_preview ${JSON.stringify({ path })}`));
    expect(result.status, path).toBe("failed");
    expect(JSON.stringify(result), path).toContain(code);
    expect((await db().select().from(appSessions).where(eq(appSessions.id, id)))[0]?.previewMediaId).toBe(before!.previewMediaId);
    expect(await db().select().from(media).where(eq(media.appSessionId, id))).toEqual(rows);
    expect(await s3().listKeys(`u/${user.id}/s/${id}/preview/`)).toEqual(keys);
  }
  const calls = await fakeSandbox.calls(id);
  expect(JSON.stringify(calls.filter((call) => call.op === "readFile"))).not.toContain("large.jpg");
  await fakeSandbox.rules.set([{ match: /^realpath -e -- '\/workspace\/out\/link.jpg'$/, stdout: "/etc/passwd\n", exitCode: 0 }]);
  try {
    const result = previewResult(await sendAndWait(user, id, '/tool set_session_preview {"path":"out/link.jpg"}'));
    expect(result.status).toBe("failed");
    expect(JSON.stringify(result)).toContain("preview_bad_path");
    expect((await db().select().from(appSessions).where(eq(appSessions.id, id)))[0]?.previewMediaId).toBe(before!.previewMediaId);
    expect(await s3().listKeys(`u/${user.id}/s/${id}/preview/`)).toEqual(keys);
  } finally {
    await fakeSandbox.rules.clear();
  }
  // Размер мог измениться между stat и чтением: повторная граница — по байтам.
  await fakeSandbox.rules.set([{ match: /^LC_ALL=C stat -c %s -- '\/workspace\/out\/large.jpg'$/, stdout: "1\n", exitCode: 0 }]);
  try {
    const result = previewResult(await sendAndWait(user, id, '/tool set_session_preview {"path":"out/large.jpg"}'));
    expect(result.status).toBe("failed");
    expect(JSON.stringify(result)).toContain("preview_too_large");
    expect((await db().select().from(appSessions).where(eq(appSessions.id, id)))[0]?.previewMediaId).toBe(before!.previewMediaId);
    expect(await s3().listKeys(`u/${user.id}/s/${id}/preview/`)).toEqual(keys);
  } finally {
    await fakeSandbox.rules.clear();
  }
}, 60_000);

test("штатная подмена инструмента доставляет результат без публикации превью", async () => {
  const client = new Client({
    host: inject("appUrl"), auth: { bearer: loadConfig().eveEvalAuthToken! }, redirect: "manual",
  });
  const before = await db().select().from(media);
  const keys = await s3().listKeys("");
  const output = { path: "out/stub.jpg", size: 27, contentType: "image/jpeg" };
  const { response } = await client.sessions.create({
    message: '/tool set_session_preview {"path":"out/stub.jpg"}',
    stubs: [{ id: "preview", tool: "set_session_preview", outcome: { response: output } }],
  });
  const turn = await response.result();
  expect(previewResult(turn.events)).toMatchObject({ status: "completed", result: { output } });
  expect(await db().select().from(media)).toEqual(before);
  expect(await s3().listKeys("")).toEqual(keys);
});

test("замена удаляет прежнее превью; поздний повтор того же callId не возвращает старое", async () => {
  const user = await createUser();
  const [session] = await db().insert(appSessions).values({ userId: user.id, eveSessionId: "preview-retry" }).returning();
  const id = session!.id;
  await fakeSandbox.seed(id, { "out/a.jpg": jpeg, "out/b.png": Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]) });
  const sandbox = sandboxSessionFrom(await fakeMachineFor(id));
  const ctx = { session: { id: "preview-retry" }, callId: "preview-first", getSandbox: async () => sandbox };
  const first = await setSessionPreview(ctx, { path: "out/a.jpg" });
  expect(await setSessionPreview(ctx, { path: "out/a.jpg" })).toEqual(first);
  expect(await db().select().from(media).where(eq(media.appSessionId, id))).toHaveLength(1);
  await setSessionPreview({
    ...ctx, callId: "preview-second",
    session: { id: "preview-copy", parent: { rootSessionId: "preview-retry" } },
  }, { path: "out/b.png" });
  await fakeSandbox.files.write(id, "out/a.jpg", "первоначального изображения больше нет");
  expect(await setSessionPreview(ctx, { path: "out/a.jpg" })).toEqual(first);
  const rows = await db().select().from(media).where(eq(media.appSessionId, id));
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ originalName: "b.png", contentType: "image/png" });
  expect(await s3().listKeys(`u/${user.id}/s/${id}/preview/`)).toEqual([rows[0]!.objectKey]);
  expect((await db().select().from(appSessions).where(eq(appSessions.id, id)))[0]?.previewMediaId).toBe(rows[0]!.id);
});

test("неизвестная сессия отказывает до доступа к песочнице", async () => {
  await expect(setSessionPreview({
    session: { id: "preview-unknown" }, callId: "unknown",
    getSandbox: async () => { throw new Error("Песочница не должна открываться"); },
  }, { path: "out/p.jpg" })).rejects.toThrow("preview_no_session: Не удалось определить сессию для превью.");
});

test("параллельные замены и повтор шага оставляют только текущее превью", async () => {
  const user = await createUser();
  const [session] = await db().insert(appSessions).values({ userId: user.id, eveSessionId: "preview-parallel" }).returning();
  const id = session!.id;
  await fakeSandbox.seed(id, { "out/a.jpg": jpeg, "out/b.jpg": jpeg });
  const sandbox = sandboxSessionFrom(await fakeMachineFor(id));
  const ctx = { session: { id: "preview-parallel" }, callId: "parallel-a", getSandbox: async () => sandbox };
  let release!: () => void;
  let entered!: () => void;
  const uploading = new Promise<void>((resolve) => { entered = resolve; });
  const continueUpload = new Promise<void>((resolve) => { release = resolve; });
  class SlowStorage extends Storage {
    override async putObject(key: string, body: Uint8Array | string, contentType?: string) {
      entered();
      await continueUpload;
      await super.putObject(key, body, contentType);
    }
  }
  const late = setSessionPreview(ctx, { path: "out/a.jpg" }, { storage: new SlowStorage(loadConfig()) });
  await uploading;
  try {
    await setSessionPreview(ctx, { path: "out/a.jpg" });
    await setSessionPreview({ ...ctx, callId: "parallel-b" }, { path: "out/b.jpg" });
  } finally {
    release();
  }
  await late;
  const rows = await db().select().from(media).where(eq(media.appSessionId, id));
  expect(rows).toHaveLength(1);
  expect(rows[0]?.originalName).toBe("b.jpg");
  expect((await db().select().from(appSessions).where(eq(appSessions.id, id)))[0]?.previewMediaId).toBe(rows[0]!.id);
  expect(await s3().listKeys(`u/${user.id}/s/${id}/preview/`)).toEqual([rows[0]!.objectKey]);
});

test("повтор после перезапуска удаляет позднюю публикацию завершённого вызова, не текущее превью", async () => {
  const user = await createUser();
  const [session] = await db().insert(appSessions).values({
    userId: user.id, eveSessionId: "preview-restart",
  }).returning();
  const id = session!.id;
  await fakeSandbox.seed(id, { "out/a.jpg": jpeg, "out/b.jpg": jpeg });
  const sandbox = sandboxSessionFrom(await fakeMachineFor(id));
  const ctx = {
    session: { id: "preview-restart" },
    callId: "restart-a",
    getSandbox: async () => sandbox,
  };
  const first = await setSessionPreview(ctx, { path: "out/a.jpg" });
  await setSessionPreview({ ...ctx, callId: "restart-b" }, { path: "out/b.jpg" });
  const [current] = await db().select().from(media).where(eq(media.appSessionId, id));

  // A успел прочитать файл до появления квитанции, но опубликовал M2 уже
  // после удаления M1 вызовом B. Процесс оборвался до очистки M2 сервисом.
  const late = await publishToolMedia(ctx, {
    path: "out/a.jpg", kind: "preview", contentType: "image/jpeg", validatedBytes: jpeg,
  });
  expect(late.mediaId).not.toBe(current!.id);
  expect(await s3().listKeys(`u/${user.id}/s/${id}/preview/`)).toHaveLength(2);

  // Новый исполнитель видит только durable-состояние; песочница недоступна.
  const resumed = {
    ...ctx,
    getSandbox: async () => { throw new Error("Повтор не должен читать песочницу"); },
  };
  expect(await setSessionPreview(resumed, { path: "out/a.jpg" })).toEqual(first);
  expect(await db().select().from(media).where(eq(media.appSessionId, id))).toEqual([current]);
  expect(await s3().listKeys(`u/${user.id}/s/${id}/preview/`)).toEqual([current!.objectKey]);
  expect((await db().select().from(appSessions).where(eq(appSessions.id, id)))[0]?.previewMediaId).toBe(current!.id);
  expect(await setSessionPreview(resumed, { path: "out/a.jpg" })).toEqual(first);
  expect(await s3().getBytes(current!.objectKey)).toEqual(jpeg);
});

test("публикуются проверенные байты; отказ удалить S3 не мешает замене и удалению строки", async () => {
  const user = await createUser();
  const [session] = await db().insert(appSessions).values({ userId: user.id, eveSessionId: "preview-snapshot" }).returning();
  const id = session!.id;
  await fakeSandbox.seed(id, { "out/a.jpg": jpeg });
  const sandbox = sandboxSessionFrom(await fakeMachineFor(id));
  const ctx = { session: { id: "preview-snapshot" }, callId: "snapshot-a", getSandbox: async () => sandbox };
  class MutatingStorage extends Storage {
    override async putObject(key: string, body: Uint8Array | string, contentType?: string) {
      await fakeSandbox.files.write(id, "out/a.jpg", "изменённый не-графический файл");
      await super.putObject(key, body, contentType);
    }
  }
  await setSessionPreview(ctx, { path: "out/a.jpg" }, { storage: new MutatingStorage(loadConfig()) });
  const [old] = await db().select().from(media).where(eq(media.appSessionId, id));
  expect(await s3().getBytes(old!.objectKey)).toEqual(jpeg);
  await fakeSandbox.files.write(id, "out/a.jpg", jpeg);
  const unavailable = new Storage({ ...loadConfig(), s3AccessKeyId: "invalid", s3SecretAccessKey: "invalid" });
  await expect(setSessionPreview({ ...ctx, callId: "snapshot-failure" }, { path: "out/a.jpg" }, {
    storage: unavailable,
  })).rejects.toThrow();
  expect((await db().select().from(appSessions).where(eq(appSessions.id, id)))[0]?.previewMediaId).toBe(old!.id);
  expect(await db().select().from(media).where(eq(media.appSessionId, id))).toHaveLength(1);
  class DeleteUnavailableStorage extends Storage {
    override async deleteObject(): Promise<void> { throw new Error("S3 недоступен при удалении"); }
  }
  await expect(setSessionPreview({ ...ctx, callId: "snapshot-b" }, { path: "out/a.jpg" }, {
    storage: new DeleteUnavailableStorage(loadConfig()),
  })).resolves.toMatchObject({ contentType: "image/jpeg" });
  expect(await db().select().from(media).where(eq(media.id, old!.id))).toEqual([]);
  const rows = await db().select().from(media).where(eq(media.appSessionId, id));
  expect(rows).toHaveLength(1);
  expect((await db().select().from(appSessions).where(eq(appSessions.id, id)))[0]?.previewMediaId).toBe(rows[0]!.id);
});
