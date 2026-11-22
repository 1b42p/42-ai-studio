/** Клиент S3: круговой прогон объекта и подписанной ссылки. */
import { describe, expect, test } from "vitest";

import { getStorage, StorageObjectSizeMismatch } from "../../lib/s3";
import { s3 } from "./support/s3";

const KEY = "u/test-user/s/test-session/uploads/0af1c2d3/sample.bin";
const PREFIX = "u/test-user/";

describe("клиент S3", () => {
  test("кладёт объект, читает его обратно и удаляет по префиксу", async () => {
    const storage = getStorage();
    const helper = s3();
    const bytes = new Uint8Array([0, 1, 2, 3, 250, 251, 252, 253, 254, 255]);

    await storage.putObject(KEY, bytes, "application/octet-stream");

    expect(await helper.exists(KEY)).toBe(true);
    expect(await helper.getBytes(KEY)).toEqual(bytes);
    expect(await helper.listKeys(PREFIX)).toContain(KEY);

    const removed = await storage.deletePrefix(PREFIX);

    expect(removed).toBeGreaterThan(0);
    expect(await helper.listKeys(PREFIX)).toEqual([]);
    expect(await storage.objectExists(KEY)).toBe(false);
  });

  test("подписанная ссылка на чтение отдаёт те же байты", async () => {
    const storage = getStorage();
    const bytes = new Uint8Array([7, 7, 7, 9]);

    await storage.putObject(KEY, bytes, "application/octet-stream");
    const url = await storage.presignRead(KEY, {
      expiresIn: 300,
      downloadName: "sample.bin",
    });

    const response = await fetch(url, { redirect: "manual" });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain("sample.bin");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);

    await storage.deletePrefix(PREFIX);
  });

  test("подписанная ссылка на загрузку принимает объект с указанным типом", async () => {
    const storage = getStorage();
    const bytes = new Uint8Array([4, 3, 2, 1]);

    const url = await storage.presignUpload(KEY, "application/octet-stream", bytes.length, { expiresIn: 300 });
    const upload = await fetch(url, {
      method: "PUT",
      body: bytes,
      headers: { "content-type": "application/octet-stream" },
      redirect: "manual",
    });

    expect(upload.status).toBe(200);
    expect(await storage.getObject(KEY, bytes.length)).toEqual(bytes);
    await expect(storage.getObject(KEY, bytes.length - 1)).rejects.toBeInstanceOf(StorageObjectSizeMismatch);

    await storage.deletePrefix(PREFIX);
  });
});

describe("совместимость со строгими провайдерами", () => {
  test("ссылка на загрузку подписывает размер и тип без контрольной суммы", async () => {
    const url = await getStorage().presignUpload(KEY, "image/png", 1, { expiresIn: 300 });

    expect(url).not.toMatch(/checksum/i);
    expect(new URL(url).searchParams.get("X-Amz-SignedHeaders")).toBe("content-length;content-type;host");
  });

  test("PUT с другим Content-Type отвергается", async () => {
    const url = await getStorage().presignUpload(KEY, "image/png", 1, { expiresIn: 300 });
    const upload = await fetch(url, {
      method: "PUT",
      body: new Uint8Array([1]),
      headers: { "content-type": "text/plain" },
      redirect: "manual",
    });

    expect(upload.status).toBe(403);
    expect(await getStorage().objectExists(KEY)).toBe(false);
  });

  test("имя для скачивания передаётся по RFC 6266", async () => {
    const storage = getStorage();
    const name = 'Отчёт "итог".pdf';
    await storage.putObject(KEY, new Uint8Array([1, 2]), "application/pdf");

    const response = await fetch(await storage.presignRead(KEY, { downloadName: name }), {
      redirect: "manual",
    });
    const header = response.headers.get("content-disposition") ?? "";
    const fallback = /filename="([^"]*)"/.exec(header)?.[1];

    expect(response.status).toBe(200);
    expect(header).toContain(`filename*=UTF-8''${encodeURIComponent(name)}`);
    expect(fallback).toBeDefined();
    expect(fallback).not.toMatch(/[^\x20-\x7e]/);
    expect(fallback).not.toContain('"');

    await storage.deletePrefix(PREFIX);
  });
});
