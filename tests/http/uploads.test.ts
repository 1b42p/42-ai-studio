/**
 * Загрузка файлов пользователя (#9): маршрут `POST /api/uploads`, подписанная
 * ссылка S3, проверки полей, прав и очистки имени.
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";

import { media } from "../../lib/db/schema";
import { loadConfig } from "../../lib/config";
import { formatUploadLimit } from "../../lib/uploads/limits";
import { uploadKeyName, uploadOriginalName } from "../../lib/uploads/name";
import { fetchApp } from "./support/app";
import { loginAs } from "./support/auth";
import { createSessionAs } from "./support/chat";
import { createUser, db, resetDatabase } from "./support/db";
import { s3 } from "./support/s3";
import { telegramStub } from "./support/telegram";
import { createUpload, putUpload, requestUpload, uploadBytes } from "./support/uploads";

beforeEach(async () => {
  await telegramStub.reset();
  await resetDatabase();
  await s3().deletePrefix("");
});

/** Имя файла из ключа объекта: последний сегмент. */
function keyName(objectKey: string): string {
  return objectKey.split("/").at(-1) ?? "";
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

async function sessionForNewUser(): Promise<{ user: Awaited<ReturnType<typeof createUser>>; id: string }> {
  const user = await createUser();
  const { id } = await createSessionAs(user);
  return { user, id };
}

describe("маршрут загрузки", () => {
  test("выдаёт адрес загрузки, а PUT кладёт объект под ключ сессии", async () => {
    const { user, id } = await sessionForNewUser();
    const bytes = new TextEncoder().encode("a,b\n1,2\n");

    const ticket = await uploadBytes(
      user,
      { appSessionId: id, name: "report.csv", contentType: "text/csv", sizeBytes: bytes.length },
      bytes,
    );

    expect(ticket.method).toBe("PUT");
    expect(ticket.headers["Content-Type"]).toBe("text/csv");
    expect(ticket.fileUrl).toBe(`${loadConfig().appUrl}/api/media/${ticket.id}`);
    const expiresIn = new Date(ticket.expiresAt).getTime() - Date.now();
    expect(expiresIn).toBeGreaterThan(14 * 60 * 1000);
    expect(expiresIn).toBeLessThanOrEqual(15 * 60 * 1000);

    const [row] = await db().select().from(media).where(eq(media.id, ticket.id));
    expect(row).toMatchObject({
      userId: user.id,
      appSessionId: id,
      kind: "upload",
      contentType: "text/csv",
      sizeBytes: bytes.length,
      originalName: "report.csv",
    });
    expect(row!.objectKey).toMatch(
      new RegExp(`^u/${user.id}/s/${id}/uploads/[0-9a-f-]{36}/report\\.csv$`),
    );
    expect(await s3().listKeys(`u/${user.id}/s/${id}/uploads/`)).toEqual([row!.objectKey]);
    expect(await s3().getBytes(row!.objectKey)).toEqual(bytes);
    expect(await s3().info(row!.objectKey)).toEqual({
      size: bytes.length,
      contentType: "text/csv",
    });

    const redirect = await fetchApp(`/api/media/${ticket.id}`, {
      headers: { cookie: await loginAs(user) },
    });
    expect(redirect.status).toBe(302);
  });

  test("тип содержимого нормализуется, пустой становится потоком байтов", async () => {
    const { user, id } = await sessionForNewUser();
    const cases = [
      { name: "up.txt", contentType: "Text/Plain; charset=utf-8", expected: "text/plain" },
      { name: "bin", contentType: "", expected: "application/octet-stream" },
      { name: "Данные.CSV", contentType: "TEXT/CSV", expected: "text/csv" },
    ] as const;

    for (const item of cases) {
      const ticket = await createUpload(user, {
        appSessionId: id,
        name: item.name,
        contentType: item.contentType,
        sizeBytes: 1,
      });
      expect(ticket.headers["Content-Type"]).toBe(item.expected);
      const [row] = await db().select().from(media).where(eq(media.id, ticket.id));
      expect(row!.contentType).toBe(item.expected);
    }
  });

  test("подпись включает Content-Type: другой заголовок при PUT отвергается", async () => {
    const { user, id } = await sessionForNewUser();
    const ticket = await createUpload(user, {
      appSessionId: id,
      name: "sig.txt",
      contentType: "text/plain",
      sizeBytes: 4,
    });

    const response = await putUpload(ticket.uploadUrl, "data", "application/octet-stream");
    expect(response.status).toBe(403);
    expect(await s3().listKeys("")).toEqual([]);
  });
});

describe("проверки полей", () => {
  test("отсутствующее тело и отсутствующие поля дают 400", async () => {
    const { user, id } = await sessionForNewUser();
    const valid = { appSessionId: id, name: "a.txt", contentType: "text/plain", sizeBytes: 1 };

    const withoutBody = await requestUpload(user, undefined);
    expect(withoutBody.status).toBe(400);

    for (const field of ["appSessionId", "name", "contentType", "sizeBytes"] as const) {
      const body: Record<string, unknown> = { ...valid };
      delete body[field];
      const response = await requestUpload(user, body);
      expect(response.status, field).toBe(400);
      expect(response.body).toEqual({
        error: { code: "invalid_request", message: "Укажите имя, тип и размер файла." },
      });
    }
  });

  test("неверные имя, размер и тип отвергаются как 400", async () => {
    const { user, id } = await sessionForNewUser();
    const valid = { appSessionId: id, name: "a.txt", contentType: "text/plain", sizeBytes: 1 };
    const cases: Array<[string, Record<string, unknown>]> = [
      ["пустое имя", { name: "" }],
      ["имя длиннее 255", { name: `${"a".repeat(252)}.txt` }],
      ["имя не строка", { name: 42 }],
      ["нулевой размер", { sizeBytes: 0 }],
      ["дробный размер", { sizeBytes: 1.5 }],
      ["отрицательный размер", { sizeBytes: -1 }],
      ["размер не число", { sizeBytes: "10" }],
      ["тип без косой", { contentType: "abc" }],
      ["тип без подтипа", { contentType: "image/" }],
      ["тип с пробелом", { contentType: "text / plain" }],
      ["тип длиннее 127", { contentType: `text/${"a".repeat(123)}` }],
      ["поле типа не строка", { contentType: 42 }],
    ];

    for (const [label, override] of cases) {
      const response = await requestUpload(user, { ...valid, ...override });
      expect(response.status, label).toBe(400);
      expect(response.body, label).toEqual({
        error: { code: "invalid_request", message: "Укажите имя, тип и размер файла." },
      });
    }

    expect(await db().select().from(media)).toEqual([]);
  });

  test("размер больше предела — 413 с пределом в тексте и без строки media", async () => {
    const { user, id } = await sessionForNewUser();
    const limit = loadConfig().uploadMaxBytes;

    const response = await requestUpload(user, {
      appSessionId: id,
      name: "big.bin",
      contentType: "application/octet-stream",
      sizeBytes: limit + 1,
    });

    expect(response.status).toBe(413);
    expect(response.body).toEqual({
      error: {
        code: "too_large",
        message: `Файл «big.bin» больше допустимых ${formatUploadLimit(limit)}.`,
      },
    });
    expect(await db().select().from(media)).toEqual([]);
  });

  test("предел в тексте: единица, округление и запятая", () => {
    expect(formatUploadLimit(2_147_483_648)).toBe("2 ГиБ");
    expect(formatUploadLimit(1_572_864)).toBe("1,5 МиБ");
    expect(formatUploadLimit(1_048_576)).toBe("1 МиБ");
    expect(formatUploadLimit(1000)).toBe("1000 Б");
    expect(formatUploadLimit(1_048_577)).toBe("1 МиБ");
  });
});

describe("права доступа", () => {
  test("без входа — 401, заблокированный — 403, чужая сессия — 404", async () => {
    const owner = await createUser();
    const { id } = await createSessionAs(owner);
    const body = { appSessionId: id, name: "a.txt", contentType: "text/plain", sizeBytes: 1 };

    const anonymous = await fetchApp("/api/uploads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(anonymous.status).toBe(401);

    const blocked = await createUser({ isBlocked: true });
    expect((await requestUpload(blocked, body)).status).toBe(403);

    const stranger = await createUser();
    const foreign = await requestUpload(stranger, body);
    expect(foreign.status).toBe(404);
    expect(foreign.body).toEqual({
      error: { code: "not_found", message: "Сессия не найдена." },
    });

    const cookie = await loginAs(stranger);
    const missing = await fetchApp("/api/uploads", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        ...body,
        appSessionId: "00000000-0000-4000-8000-000000000000",
      }),
    });
    expect(missing.status).toBe(404);
    expect(await requestUpload(stranger, { ...body, appSessionId: "не uuid" })).toMatchObject({
      status: 404,
    });
  });

  test("чужой Origin отвергается, свой пропускается", async () => {
    const { user, id } = await sessionForNewUser();
    const cookie = await loginAs(user);
    const body = JSON.stringify({
      appSessionId: id,
      name: "a.txt",
      contentType: "text/plain",
      sizeBytes: 1,
    });

    const foreign = await fetchApp("/api/uploads", {
      method: "POST",
      headers: { cookie, "content-type": "application/json", origin: "https://evil.example" },
      body,
    });
    expect(foreign.status).toBe(403);

    const own = await fetchApp("/api/uploads", {
      method: "POST",
      headers: { cookie, "content-type": "application/json", origin: loadConfig().appUrl },
      body,
    });
    expect(own.status).toBe(201);
  });
});

describe("очистка имени", () => {
  test("косые, обратные косые, управляющие символы и .. заменяются на _", async () => {
    const { user, id } = await sessionForNewUser();
    const cases: Array<{ name: string; expected: string }> = [
      { name: "../../x", expected: "____x" },
      { name: "a/b\\c", expected: "a_b_c" },
      { name: "a\u0000b\u001fc\u007fd", expected: "a_b_c_d" },
      { name: "..", expected: "_" },
      { name: "   ", expected: "file" },
    ];

    for (const item of cases) {
      const ticket = await createUpload(user, {
        appSessionId: id,
        name: item.name,
        contentType: "text/plain",
        sizeBytes: 1,
      });
      const [row] = await db().select().from(media).where(eq(media.id, ticket.id));
      expect(keyName(row!.objectKey), item.name).toBe(item.expected);
      expect(keyName(row!.objectKey)).not.toContain("..");
      expect(keyName(row!.objectKey)).not.toContain("/");
    }
  });

  test("русское имя сохраняется, длинное имя усекается до 180 байт с расширением", async () => {
    const { user, id } = await sessionForNewUser();
    const cases = [
      { name: "Отчёт 2026.csv", expected: "Отчёт 2026.csv" },
      { name: "a".repeat(251) + ".png", expectedBytes: 180, extension: ".png" },
      { name: "я".repeat(251) + ".csv", expectedBytes: 180, extension: ".csv" },
    ];

    for (const item of cases) {
      const ticket = await createUpload(user, {
        appSessionId: id,
        name: item.name,
        contentType: "text/plain",
        sizeBytes: 1,
      });
      const [row] = await db().select().from(media).where(eq(media.id, ticket.id));
      const name = keyName(row!.objectKey);

      expect(byteLength(name)).toBeLessThanOrEqual(180);
      expect(name).not.toContain("\uFFFD");
      if ("expected" in item) {
        expect(name).toBe(item.expected);
        expect(row!.originalName).toBe(item.expected);
      } else {
        expect(byteLength(name)).toBe(item.expectedBytes);
        expect(name.endsWith(item.extension)).toBe(true);
      }
      expect(row!.originalName.length).toBeLessThanOrEqual(255);
    }
  });

  test("очистка 300-символьного имени укладывается в 180 байт и хранит расширение", () => {
    for (const name of ["и".repeat(300) + ".csv", "a".repeat(300) + ".png"]) {
      const keyName = uploadKeyName(name);
      expect(byteLength(keyName)).toBeLessThanOrEqual(180);
      expect(keyName.endsWith(name.slice(-4))).toBe(true);
      expect(byteLength(uploadOriginalName(name))).toBeLessThanOrEqual(510);
      expect([...uploadOriginalName(name)]).toHaveLength(255);
    }
  });

  test("оригинальное имя обрезается до 255 символов без косых", async () => {
    const { user, id } = await sessionForNewUser();
    const ticket = await createUpload(user, {
      appSessionId: id,
      name: `${"ж".repeat(251)}.txt`,
      contentType: "text/plain",
      sizeBytes: 1,
    });

    const [row] = await db().select().from(media).where(eq(media.id, ticket.id));
    expect(row!.originalName).toBe(`${"ж".repeat(251)}.txt`);
    expect([...row!.originalName].length).toBe(255);
    expect(row!.originalName).not.toContain("/");
  });
});
