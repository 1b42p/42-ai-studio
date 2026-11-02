/**
 * Файлы в ответе агента (#8): распознавание ссылок, копирование в S3,
 * маршруты медиа и списка файлов на фиктивной песочнице.
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";

import type { MessageStreamEvent } from "eve/client";

import { media } from "../../lib/db/schema";
import { fetchApp } from "./support/app";
import { loginAs } from "./support/auth";
import { createSessionAs, sendAndWait } from "./support/chat";
import { createDaytonaKey, createUser, db, resetDatabase } from "./support/db";
import { fakeSandbox } from "./support/fake-sandbox";
import {
  mediaRedirect,
  readSigned,
  sessionFiles,
  waitForSessionFiles,
} from "./support/media";
import { s3 } from "./support/s3";
import { telegramStub } from "./support/telegram";

beforeEach(async () => {
  await telegramStub.reset();
  await resetDatabase();
  await fakeSandbox.reset();
  await s3().deletePrefix("");
  await createDaytonaKey();
});

function completed(events: readonly MessageStreamEvent[]): {
  messageId: string;
} {
  const event = events.find((item) => item.type === "message.completed");
  if (event === undefined) throw new Error("в потоке нет message.completed");
  const data = event.data as { stepIndex: number; turnId: string };
  return { messageId: `${data.turnId}:${data.stepIndex}` };
}

describe("копирование файла из ответа", () => {
  test("готовый файл лежит в S3, отдаётся по ссылке и не меняется при перезаписи в песочнице", async () => {
    const user = await createUser();
    const { id } = await createSessionAs(user);
    const original = new TextEncoder().encode("первые байты ролика");
    await fakeSandbox.seed(id, { "out/final.mp4": original });

    const events = await sendAndWait(user, id, "Вот ![кадр](out/final.mp4)");
    const { messageId } = completed(events);

    const files = await waitForSessionFiles(
      user,
      id,
      (items) => items.length === 1 && items[0]?.state === "ready",
    );
    const file = files[0]!;
    expect(file.messageId).toBe(messageId);
    expect(file.path).toBe("/workspace/out/final.mp4");
    expect(file.contentType).toBe("video/mp4");
    expect(file.name).toBe("final.mp4");
    expect(file.reason).toBeNull();
    expect(file.mediaId).not.toBeNull();

    const prefix = `u/${user.id}/s/${id}/message-files/`;
    const keys = await s3().listKeys(prefix);
    expect(keys).toHaveLength(1);
    expect(await s3().getBytes(keys[0]!)).toEqual(original);

    const redirect = await mediaRedirect(user, file.mediaId!);
    expect(redirect.status).toBe(302);
    expect(redirect.location).not.toBeNull();
    expect(await readSigned(redirect.location!)).toEqual(original);

    // Перезапись в песочнице не меняет старую копию, новое сообщение — новый объект.
    const changed = new TextEncoder().encode("вторые байты ролика");
    await fakeSandbox.files.write(id, "out/final.mp4", changed);
    await sendAndWait(user, id, "Ещё раз [ролик](out/final.mp4)");

    const filesAfter = await waitForSessionFiles(
      user,
      id,
      (items) => items.length === 2 && items.every((item) => item.state === "ready"),
    );
    expect(filesAfter[0]?.mediaId).not.toBe(filesAfter[1]?.mediaId);
    expect(filesAfter[0]?.messageId).not.toBe(filesAfter[1]?.messageId);

    const keysAfter = await s3().listKeys(prefix);
    expect(keysAfter).toHaveLength(2);
    const [oldMedia] = await db().select().from(media).where(eq(media.id, filesAfter[0]!.mediaId!));
    const [newMedia] = await db().select().from(media).where(eq(media.id, filesAfter[1]!.mediaId!));
    expect(oldMedia!.objectKey).not.toBe(newMedia!.objectKey);
    expect(await s3().getBytes(oldMedia!.objectKey)).toEqual(original);
    expect(await s3().getBytes(newMedia!.objectKey)).toEqual(changed);
  }, 30_000);

  test("несуществующий файл остаётся missing/not_found без объекта в S3", async () => {
    const user = await createUser();
    const { id } = await createSessionAs(user);

    await sendAndWait(user, id, "Вот ![нет](out/missing.mp4)");
    const files = await waitForSessionFiles(
      user,
      id,
      (items) => items.length === 1 && items[0]?.state === "missing",
    );

    expect(files[0]).toMatchObject({
      path: "/workspace/out/missing.mp4",
      state: "missing",
      reason: "not_found",
      mediaId: null,
    });
    expect(await s3().listKeys("")).toEqual([]);
  }, 30_000);

  test("пути вне рабочей области отвергаются без чтения в песочнице", async () => {
    const user = await createUser();
    const { id } = await createSessionAs(user);

    await sendAndWait(
      user,
      id,
      "Вот [a](/etc/passwd) [b](/workspace/../x) [c](%2e%2e/x) [d](out/missing.mp4)",
    );
    const files = await waitForSessionFiles(
      user,
      id,
      (items) => items.length === 3 && items.every((item) => item.state === "missing"),
    );

    expect(
      files.filter((file) => file.reason === "outside_workspace").map((file) => file.path).sort(),
    ).toEqual(["/etc/passwd", "/x"].sort());
    expect(files.find((file) => file.path === "/workspace/out/missing.mp4")?.reason).toBe(
      "not_found",
    );
    expect(await s3().listKeys("")).toEqual([]);

    const calls = await fakeSandbox.calls(id);
    expect(
      calls.filter(
        (call) =>
          call.command?.includes("/etc/passwd") === true ||
          call.command?.includes(" -- '/x'") === true ||
          (call.op === "readFile" && (call.path === "/etc/passwd" || call.path === "/x")),
      ),
    ).toEqual([]);
  }, 30_000);

  test("realpath за пределы рабочей области отвергается", async () => {
    const user = await createUser();
    const { id } = await createSessionAs(user);
    await fakeSandbox.seed(id, { "out/final.mp4": "кадры" });
    await fakeSandbox.rules.set([
      { match: "^realpath -- ", stdout: "/etc/passwd\n", exitCode: 0 },
    ]);

    await sendAndWait(user, id, "Вот ![кадр](out/final.mp4)");
    const files = await waitForSessionFiles(
      user,
      id,
      (items) => items.length === 1 && items[0]?.state === "missing",
    );

    expect(files[0]).toMatchObject({
      path: "/workspace/out/final.mp4",
      reason: "outside_workspace",
      mediaId: null,
    });
    expect(await s3().listKeys("")).toEqual([]);
  }, 30_000);

  test("ссылка со схемой не создаёт строк", async () => {
    const user = await createUser();
    const { id } = await createSessionAs(user);

    await sendAndWait(user, id, "Вот [ролик](https://example.com/a.mp4)");
    expect(await sessionFiles(user, id)).toEqual([]);
  }, 30_000);

  test("из 21 ссылки обрабатываются первые 20, последняя — too_many", async () => {
    const user = await createUser();
    const { id } = await createSessionAs(user);
    const links = Array.from({ length: 21 }, (_, index) => `[${index}](out/f${index}.mp4)`).join(" ");

    await sendAndWait(user, id, `Вот ${links}`);
    const files = await waitForSessionFiles(
      user,
      id,
      (items) => items.length === 21 && items.every((item) => item.state !== "copying"),
    );

    expect(files).toHaveLength(21);
    expect(files.find((file) => file.path === "/workspace/out/f20.mp4")).toMatchObject({
      reason: "too_many",
      state: "missing",
    });
    expect(
      files
        .filter((file) => file.path !== "/workspace/out/f20.mp4")
        .every((file) => file.reason === "not_found"),
    ).toBe(true);
  }, 30_000);
});

describe("маршруты медиа", () => {
  test("чужой пользователь получает 404, без входа — 401", async () => {
    const owner = await createUser();
    const { id } = await createSessionAs(owner);
    await fakeSandbox.seed(id, { "out/final.mp4": "байты" });
    await sendAndWait(owner, id, "Вот ![кадр](out/final.mp4)");
    const [file] = await waitForSessionFiles(
      owner,
      id,
      (items) => items.length === 1 && items[0]?.state === "ready",
    );

    const stranger = await createUser();
    const strangerCookie = await loginAs(stranger);
    const filesResponse = await fetchApp(`/api/sessions/${id}/files`, {
      headers: { cookie: strangerCookie },
    });
    expect(filesResponse.status).toBe(404);
    const mediaResponse = await fetchApp(`/api/media/${file!.mediaId}`, {
      headers: { cookie: strangerCookie },
    });
    expect(mediaResponse.status).toBe(404);

    expect((await fetchApp(`/api/sessions/${id}/files`)).status).toBe(401);
    expect((await fetchApp(`/api/media/${file!.mediaId}`)).status).toBe(401);
  }, 30_000);

  test("?download=1 подписывает вложение, html и pdf всегда скачиваются", async () => {
    const user = await createUser();
    const { id } = await createSessionAs(user);
    await fakeSandbox.seed(id, { "out/final.mp4": "кадры" });
    await sendAndWait(user, id, "Вот ![кадр](out/final.mp4)");
    const [file] = await waitForSessionFiles(
      user,
      id,
      (items) => items.length === 1 && items[0]?.state === "ready",
    );

    const download = await mediaRedirect(user, file!.mediaId!, "?download=1");
    expect(download.status).toBe(302);
    const downloadUrl = new URL(download.location!);
    expect(downloadUrl.searchParams.get("response-content-disposition")).toContain("attachment");
    expect(downloadUrl.searchParams.get("response-content-disposition")).toContain("final.mp4");

    const rows = [
      { contentType: "text/html", name: "page.html" },
      { contentType: "application/pdf", name: "документ.pdf" },
      { contentType: "image/png", name: "кадр.png" },
    ];
    for (const [index, row] of rows.entries()) {
      const key = `u/${user.id}/s/${id}/uploads/${index}/${row.name}`;
      await s3().put(key, new Uint8Array([index]), row.contentType);
      const [inserted] = await db()
        .insert(media)
        .values({
          userId: user.id,
          appSessionId: id,
          kind: "upload",
          objectKey: key,
          contentType: row.contentType,
          sizeBytes: 1,
          originalName: row.name,
        })
        .returning();
      const redirect = await mediaRedirect(user, inserted!.id);
      const disposition = new URL(redirect.location!).searchParams.get(
        "response-content-disposition",
      );
      if (row.contentType.startsWith("image/")) {
        expect(disposition).toBeNull();
      } else {
        expect(disposition).toContain("attachment");
      }
      if (row.contentType === "application/pdf") {
        // Имя с кириллицей: ASCII-запасное и точное в filename*.
        expect(disposition).toContain('filename="');
        expect(disposition).toContain(
          "filename*=UTF-8''%D0%B4%D0%BE%D0%BA%D1%83%D0%BC%D0%B5%D0%BD%D1%82.pdf",
        );
      }
    }
  }, 30_000);

  test("остановленная песочница не нужна для выдачи файла", async () => {
    const user = await createUser();
    const { id } = await createSessionAs(user);
    await fakeSandbox.seed(id, { "out/final.mp4": "кадры после остановки" });
    await sendAndWait(user, id, "Вот ![кадр](out/final.mp4)");
    const [file] = await waitForSessionFiles(
      user,
      id,
      (items) => items.length === 1 && items[0]?.state === "ready",
    );

    await fakeSandbox.stop(id);
    const before = await fakeSandbox.counters();

    const redirect = await mediaRedirect(user, file!.mediaId!);
    expect(redirect.status).toBe(302);
    expect(new TextDecoder().decode(await readSigned(redirect.location!))).toBe(
      "кадры после остановки",
    );
    const files = await sessionFiles(user, id);
    expect(files[0]?.state).toBe("ready");

    expect(await fakeSandbox.counters()).toEqual(before);
  }, 30_000);
});
