/**
 * Копирование файла из песочницы в S3 потоком, без загрузки в память (#8).
 *
 * Сначала путь проверяется теми же правилами, что и ссылка Markdown, затем
 * `realpath` и `stat` в песочнице: символическая ссылка наружу отвергается,
 * каталог считается отсутствующим файлом, размер сверяется с пределом и
 * повторно — по числу прочитанных байт.
 */
import type { SandboxSession } from "eve/sandbox";

import type { MediaKind } from "@/lib/db/schema";
import { getStorage, type Storage } from "@/lib/s3";

import { contentTypeForPath, fileNameForPath } from "./files";
import { mediaObjectKey } from "./keys";
import { resolveSandboxFilePath } from "./sandbox-path";

export type MediaCopyReason = "not_found" | "outside_workspace" | "too_large" | "copy_failed";

/** Ошибка копирования с причиной для строки `message_files.reason`. */
export class MediaCopyError extends Error {
  readonly reason: MediaCopyReason;

  constructor(reason: MediaCopyReason, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "MediaCopyError";
    this.reason = reason;
  }
}

export interface CopySandboxFileOptions {
  sandbox: SandboxSession;
  /** Абсолютный путь в песочнице. */
  path: string;
  /** Предел размера в байтах. */
  maxBytes: number;
  userId: string;
  appSessionId: string;
  kind?: MediaKind;
  /** Перекрывает тип по расширению (например, для синтезированной озвучки). */
  contentType?: string;
  storage?: Storage;
  abortSignal?: AbortSignal;
  /** Уже проверенный небольшой файл: публикуются именно эти байты, без повторного чтения. */
  validatedBytes?: Uint8Array;
}

export interface CopiedSandboxFile {
  objectKey: string;
  contentType: string;
  sizeBytes: number;
  originalName: string;
}

/** Путь в одинарных кавычках: безопасен и для пробелов, и для `$(…)`. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function insideWorkspace(path: string): string {
  const resolved = resolveSandboxFilePath(path);
  if (resolved.kind !== "file") {
    throw new MediaCopyError("outside_workspace", "Путь вне рабочей области");
  }
  return resolved.path;
}

/** Поток с проверкой предела: превышение обрывает загрузку. */
function limitedStream(
  source: ReadableStream<Uint8Array>,
  maxBytes: number,
): { stream: ReadableStream<Uint8Array>; bytes: () => number } {
  let total = 0;
  const stream = source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.byteLength;
        if (total > maxBytes) {
          controller.error(new MediaCopyError("too_large", "Файл больше предела"));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
  return { stream, bytes: () => total };
}

/**
 * Перекладывает один файл песочницы в S3. Ошибки не глотает: вызывающий сам
 * решает, записать ли причину в базу.
 */
export async function copySandboxFile(
  options: CopySandboxFileOptions,
): Promise<CopiedSandboxFile> {
  const path = insideWorkspace(options.path);
  const sandbox = options.sandbox;
  const signal = options.abortSignal;

  if (options.validatedBytes !== undefined) {
    const bytes = options.validatedBytes;
    if (bytes.byteLength > options.maxBytes) {
      throw new MediaCopyError("too_large", "Файл больше предела");
    }
    const originalName = fileNameForPath(path);
    const contentType = options.contentType ?? contentTypeForPath(originalName);
    const objectKey = mediaObjectKey({
      userId: options.userId,
      appSessionId: options.appSessionId,
      kind: options.kind ?? "message_file",
      name: originalName,
    });
    const storage = options.storage ?? getStorage();
    try {
      await storage.putObject(objectKey, bytes, contentType);
    } catch (error) {
      await storage.deleteObject(objectKey).catch(() => undefined);
      throw new MediaCopyError("copy_failed", "Не удалось сохранить файл", { cause: error });
    }
    return { objectKey, contentType, sizeBytes: bytes.byteLength, originalName };
  }

  const real = await sandbox.run({
    command: `realpath -- ${shellQuote(path)}`,
    abortSignal: signal,
  });
  if (real.exitCode !== 0) throw new MediaCopyError("not_found", "Файл не найден");
  const realPath = real.stdout.split("\n")[0]?.trim() ?? "";
  if (realPath.length === 0) throw new MediaCopyError("not_found", "Файл не найден");
  // Символическая ссылка может вести за пределы рабочей области.
  const inside = insideWorkspace(realPath);

  const stat = await sandbox.run({
    command: `LC_ALL=C stat -c '%F|%s' -- ${shellQuote(inside)}`,
    abortSignal: signal,
  });
  if (stat.exitCode !== 0) throw new MediaCopyError("not_found", "Файл не найден");
  const [kind, rawSize] = stat.stdout.trim().split("|");
  if (kind !== "regular file" && kind !== "regular empty file") {
    throw new MediaCopyError("not_found", "Это не обычный файл");
  }
  const statSize = Number(rawSize);
  if (!Number.isSafeInteger(statSize) || statSize < 0) {
    throw new MediaCopyError("copy_failed", "Не удалось прочитать размер файла");
  }
  if (statSize > options.maxBytes) {
    throw new MediaCopyError("too_large", "Файл больше предела");
  }

  const source = await sandbox.readFile({ path: inside, abortSignal: signal });
  if (source === null) throw new MediaCopyError("not_found", "Файл не найден");

  const originalName = fileNameForPath(path);
  const contentType = options.contentType ?? contentTypeForPath(originalName);
  const objectKey = mediaObjectKey({
    userId: options.userId,
    appSessionId: options.appSessionId,
    kind: options.kind ?? "message_file",
    name: originalName,
  });
  const storage = options.storage ?? getStorage();
  const limited = limitedStream(source, options.maxBytes);

  try {
    await storage.putStream(objectKey, limited.stream, contentType);
  } catch (error) {
    // Не оставляем часть объекта, если поток оборвался или превысил предел.
    await storage.deleteObject(objectKey).catch(() => undefined);
    if (error instanceof MediaCopyError) throw error;
    throw new MediaCopyError("copy_failed", "Не удалось сохранить файл", { cause: error });
  }

  const sizeBytes = limited.bytes();
  if (sizeBytes > options.maxBytes) {
    await storage.deleteObject(objectKey).catch(() => undefined);
    throw new MediaCopyError("too_large", "Файл больше предела");
  }

  return { objectKey, contentType, sizeBytes, originalName };
}
