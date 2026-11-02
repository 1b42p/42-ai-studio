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

  /** Чтение объекта целиком. */
  async getObject(key: string): Promise<Uint8Array> {
    const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    const bytes = await response.Body?.transformToByteArray();
    return bytes ?? new Uint8Array();
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
  async deletePrefix(prefix: string): Promise<number> {
    const keys = await this.listKeys(prefix);
    for (let index = 0; index < keys.length; index += 1000) {
      const chunk = keys.slice(index, index + 1000);
      await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: chunk.map((Key) => ({ Key })) },
        }),
      );
    }
    return keys.length;
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

  /**
   * Подписанная ссылка на загрузку. Тип содержимого входит в подпись:
   * `PUT` с другим `Content-Type` получает `403 SignatureDoesNotMatch`.
   */
  async presignUpload(
    key: string,
    contentType: string,
    options: PresignUploadOptions = {},
  ): Promise<string> {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: contentType,
    });
    return getSignedUrl(this.client, command, {
      expiresIn: options.expiresIn ?? 3600,
      signableHeaders: new Set(["content-type"]),
    });
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
