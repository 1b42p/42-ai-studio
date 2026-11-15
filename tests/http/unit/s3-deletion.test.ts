import { DeleteObjectsCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AppConfig } from "../../../lib/config";
import { Storage, StorageDeletionError } from "../../../lib/s3";

const config = {
  s3Bucket: "deletion-test", s3Endpoint: "http://127.0.0.1:1", s3Region: "us-east-1",
  s3ForcePathStyle: true, s3AccessKeyId: "test", s3SecretAccessKey: "test",
} as AppConfig;

afterEach(() => vi.restoreAllMocks());

describe("S3 deletePrefix", () => {
  test("пустой префикс не отправляет DeleteObjects", async () => {
    const send = vi.spyOn(S3Client.prototype, "send").mockResolvedValueOnce({ Contents: [] } as never);
    expect(await new Storage(config).deletePrefix("u/user/s/session/")).toBe(0);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toBeInstanceOf(ListObjectsV2Command);
  });

  test("обходит ContinuationToken, удаляет страницу до чтения следующей", async () => {
    const send = vi.spyOn(S3Client.prototype, "send")
      .mockResolvedValueOnce({ Contents: [{ Key: "prefix/a" }, {}], IsTruncated: true, NextContinuationToken: "next" } as never)
      .mockResolvedValueOnce({} as never)
      .mockResolvedValueOnce({ Contents: [{ Key: "prefix/b" }], IsTruncated: false } as never)
      .mockResolvedValueOnce({} as never);
    expect(await new Storage(config).deletePrefix("prefix/")).toBe(2);
    expect(send.mock.calls.map(([command]) => command.constructor.name)).toEqual([
      "ListObjectsV2Command", "DeleteObjectsCommand", "ListObjectsV2Command", "DeleteObjectsCommand",
    ]);
    expect(send.mock.calls[2][0].input).toMatchObject({ Prefix: "prefix/", ContinuationToken: "next" });
    expect(send.mock.calls[1][0].input).toMatchObject({ Delete: { Objects: [{ Key: "prefix/a" }] } });
  });

  test("в DeleteObjects не бывает больше 1000 ключей", async () => {
    const send = vi.spyOn(S3Client.prototype, "send")
      .mockResolvedValueOnce({ Contents: Array.from({ length: 2001 }, (_, i) => ({ Key: `key-${i}` })) } as never)
      .mockResolvedValue({} as never);
    expect(await new Storage(config).deletePrefix("key-")).toBe(2001);
    const commands = send.mock.calls.map(([command]) => command).filter((command) => command instanceof DeleteObjectsCommand);
    expect(commands.map((command) => command.input.Delete?.Objects?.length)).toEqual([1000, 1000, 1]);
  });

  test("Errors при HTTP 200 — исключение с ключами, продолжения нет", async () => {
    const send = vi.spyOn(S3Client.prototype, "send")
      .mockResolvedValueOnce({ Contents: [{ Key: "private/a" }], IsTruncated: true, NextContinuationToken: "next" } as never)
      .mockResolvedValueOnce({ Errors: [{ Key: "private/a", Code: "AccessDenied" }] } as never);
    const failure = await new Storage(config).deletePrefix("private/").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(StorageDeletionError);
    expect((failure as StorageDeletionError).failures).toEqual([{ key: "private/a", code: "AccessDenied" }]);
    expect(send).toHaveBeenCalledTimes(2);
  });

  test("AbortSignal передаётся каждой отправке, отмена останавливает обход", async () => {
    const controller = new AbortController();
    const send = vi.spyOn(S3Client.prototype, "send")
      .mockResolvedValueOnce({ Contents: [{ Key: "a" }], IsTruncated: true, NextContinuationToken: "next" } as never)
      .mockImplementationOnce(async () => { controller.abort(); return {} as never; });
    await expect(new Storage(config).deletePrefix("", { signal: controller.signal })).rejects.toThrow();
    expect(send).toHaveBeenCalledTimes(2);
    for (const call of send.mock.calls) {
      const options = call[1] as { abortSignal: AbortSignal };
      expect(options.abortSignal).toBeInstanceOf(AbortSignal);
      expect(options.abortSignal.aborted).toBe(true);
    }
  });

  test("заранее отменённая операция не делает запросов", async () => {
    const send = vi.spyOn(S3Client.prototype, "send");
    await expect(new Storage(config).deletePrefix("", { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });

  test("усечённая страница без continuation token не считается полной", async () => {
    vi.spyOn(S3Client.prototype, "send").mockResolvedValueOnce({ IsTruncated: true } as never);
    await expect(new Storage(config).deletePrefix("")).rejects.toThrow("continuation token");
  });
});
