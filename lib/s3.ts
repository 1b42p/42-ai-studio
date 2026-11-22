/**
 * Серверный модуль-клиент для любого S3-совместимого хранилища.
 * Настраивается переменными `S3_*` через модуль конфигурации; при
 * `S3_FORCE_PATH_STYLE=true` адресация «хост/бакет/ключ» (так требует MinIO).
 *
 * Формат ключей объектов: u/<user_id>/s/<app_session_id>/<вид>/<uuid>/<имя файла>,
 * где вид — uploads, tool-media, message-files, preview. Удаление сессии или
 * пользователя — это удаление по префиксу.
 */
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

import { loadConfig, type AppConfig } from "./config";

/** Параметры подписанной ссылки на чтение. */
export interface PresignReadOptions {
  /** Время жизни ссылки в секундах. */
  expiresIn?: number;
  /** Имя файла для скачивания (Content-Disposition). */
  downloadName?: string;
}

/** Параметры подписанной ссылки на загрузку. */
export interface PresignUploadOptions {
  /** Время жизни ссылки в секундах. */
  expiresIn?: number;
}

/** Клиент хранилища: операции над объектами одного бакета. */
export class Storage {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: AppConfig) {
    this.bucket = config.s3Bucket;
    this.client = new S3Client({
      endpoint: config.s3Endpoint,
      region: config.s3Region,
      forcePathStyle: config.s3ForcePathStyle,
      // С 3.729.0 SDK по умолчанию считает CRC32 и добавляет его параметры
      // в подписанную ссылку на загрузку; строгие провайдеры такую загрузку
      // отвергают (aws/aws-sdk-js-v3#6810).
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
      credentials: {
        accessKeyId: config.s3AccessKeyId,
        secretAccessKey: config.s3SecretAccessKey,
      },
    });
  }

  /** Проверка бакета: бросает, если бакета нет или хранилище недоступно. */
  async headBucket(): Promise<void> {
    await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
  }

  /** Создание бакета, если его ещё нет (нужно тестовой обвязке). */
  async ensureBucket(): Promise<void> {
    const { CreateBucketCommand } = await import("@aws-sdk/client-s3");
    try {
      await this.headBucket();
    } catch (error) {
      // Создаём бакет только если его нет: прочие ошибки не маскируем.
      if (!isNotFound(error)) throw error;
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
    }
  }

  /** Загрузка объекта. */
  async putObject(key: string, body: Uint8Array | string, contentType?: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  /**
   * Загрузка потоком: файл не читается в память целиком. Многочастная
   * загрузка идёт через `@aws-sdk/lib-storage`.
   */
  async putStream(
    key: string,
    body: ReadableStream<Uint8Array>,
    contentType: string,
  ): Promise<void> {
    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.bucket,
        Key: key,
        Body: Readable.fromWeb(body as unknown as NodeReadableStream<Uint8Array>),
        ContentType: contentType,
      },
    });
    await upload.done();
  }

  /** Чтение объекта целиком, с точным пределом, если размер известен. */
  async getObject(key: string, expectedSize?: number): Promise<Uint8Array> {
    const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (expectedSize === undefined) {
      return (await response.Body?.transformToByteArray()) ?? new Uint8Array();
    }
    if (!response.Body) throw new StorageObjectSizeMismatch();

    const reader = response.Body.transformToWebStream().getReader();
    let completed = false;
    try {
      if (response.ContentLength !== undefined && response.ContentLength !== expectedSize) {
        throw new StorageObjectSizeMismatch();
      }
      const bytes = new Uint8Array(expectedSize);
      let offset = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          completed = true;
          break;
        }
        if (value.byteLength > expectedSize - offset) throw new StorageObjectSizeMismatch();
        bytes.set(value, offset);
        offset += value.byteLength;
      }
      if (offset !== expectedSize) throw new StorageObjectSizeMismatch();
      return bytes;
    } finally {
      if (!completed) await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }

  /** Проверка существования объекта. */
  async objectExists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  /** Размер и тип объекта из метаданных; `null` — объекта нет. */
  async objectInfo(
    key: string,
  ): Promise<{ size: number; contentType: string | undefined } | null> {
    try {
      const response = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return { size: response.ContentLength ?? 0, contentType: response.ContentType };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  /** Удаление объекта. */
  async deleteObject(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  /** Ключи объектов под префиксом (с постраничным обходом списка). */
  async listKeys(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let continuationToken: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );
      for (const item of page.Contents ?? []) {
        if (item.Key !== undefined) keys.push(item.Key);
      }
      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuationToken !== undefined);
    return keys;
  }

  /** Удаление всех объектов по префиксу (с постраничным обходом списка). */
  async deletePrefix(prefix: string, options: { signal?: AbortSignal } = {}): Promise<number> {
    let continuationToken: string | undefined;
    let deleted = 0;
    do {
      // Один предел покрывает и чтение страницы, и удаление всех её ключей.
      const timeout = AbortSignal.timeout(60_000);
      const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
      signal.throwIfAborted();
      const page = await this.client.send(new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: prefix,
        MaxKeys: 1000,
        ContinuationToken: continuationToken,
      }), { abortSignal: signal });
      const keys = (page.Contents ?? []).flatMap((item) => item.Key === undefined ? [] : [item.Key]);
      for (let index = 0; index < keys.length; index += 1000) {
        signal.throwIfAborted();
        const chunk = keys.slice(index, index + 1000);
        const result = await this.client.send(new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: chunk.map((Key) => ({ Key })) },
        }), { abortSignal: signal });
        if (result.Errors?.length) {
          throw new StorageDeletionError(result.Errors.map((error) => ({
            key: error.Key ?? "", code: error.Code ?? "Unknown",
          })));
        }
        deleted += chunk.length;
      }
      signal.throwIfAborted();
      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
      if (page.IsTruncated && !continuationToken) throw new Error("S3 returned no continuation token");
    } while (continuationToken !== undefined);
    return deleted;
  }

  /** Подписанная ссылка на чтение (с необязательным именем файла для скачивания). */
  async presignRead(key: string, options: PresignReadOptions = {}): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ResponseContentDisposition: options.downloadName
        ? attachmentDisposition(options.downloadName)
        : undefined,
    });
    return getSignedUrl(this.client, command, { expiresIn: options.expiresIn ?? 3600 });
  }

  /** Подписанная ссылка на загрузку конкретного типа и размера. */
  async presignUpload(
    key: string,
    contentType: string,
    sizeBytes: number,
    options: PresignUploadOptions = {},
  ): Promise<string> {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: contentType,
      ContentLength: sizeBytes,
    });
    return getSignedUrl(this.client, command, {
      expiresIn: options.expiresIn ?? 3600,
      signableHeaders: new Set(["content-type", "content-length"]),
    });
  }
}

/** Частичный отказ DeleteObjects даже при HTTP 200 нельзя считать успехом. */
export class StorageDeletionError extends Error {
  constructor(readonly failures: ReadonlyArray<{ key: string; code: string }>) {
    super(`S3 could not delete objects: ${failures.map(({ key, code }) => `${key} (${code})`).join(", ")}`);
    this.name = "StorageDeletionError";
  }
}

export class StorageObjectSizeMismatch extends Error {
  constructor() {
    super("S3 object size did not match the expected size");
  }
}

/**
 * `Content-Disposition` для скачивания по RFC 6266: запасное имя из печатных
 * ASCII без кавычек и обратной косой черты плюс точное имя в `filename*`.
 */
export function attachmentDisposition(name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { $metadata?: { httpStatusCode?: number }; name?: string };
  return (
    candidate.$metadata?.httpStatusCode === 404 ||
    candidate.name === "NotFound" ||
    candidate.name === "NoSuchBucket"
  );
}

let cachedStorage: Storage | undefined;

/** Клиент хранилища процесса: создаётся лениво из конфигурации. */
export function getStorage(): Storage {
  if (cachedStorage === undefined) {
    cachedStorage = new Storage(loadConfig());
  }
  return cachedStorage;
}
