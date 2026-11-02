/**
 * Вложения сообщения (#9): модель состояния загрузки для поля ввода и общие
 * правила. Сама загрузка живёт в `use-attachments`, здесь только чистые
 * функции, которые проверяются тестами отрисовки.
 */
import type { UserContent } from "ai";

import {
  MAX_MESSAGE_FILES,
  MAX_MESSAGE_UPLOAD_BYTES,
  MESSAGE_TOO_LARGE_MESSAGE,
  TOO_MANY_FILES_MESSAGE,
} from "@/lib/uploads/limits";

/** Состояние одной загрузки в предпросмотре под полем ввода. */
export type AttachmentUploadState = "uploading" | "done" | "error";

export interface PendingAttachment {
  readonly id: string;
  readonly name: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly state: AttachmentUploadState;
  /** От 0 до 100. */
  readonly progress: number;
  readonly error?: string;
  readonly mediaId?: string;
  readonly fileUrl?: string;
  /** `blob:`-адрес миниатюры изображения; освобождается при удалении. */
  readonly previewUrl?: string;
}

/** Всё, что поле ввода получает от загрузчика вложений. */
export interface AttachmentsController {
  readonly items: readonly PendingAttachment[];
  /** Идёт загрузка или есть ошибка: отправлять сообщение нельзя. */
  readonly blocking: boolean;
  /** Отказ при добавлении: больше десяти файлов или больше 4 ГиБ. */
  readonly notice?: string;
  addFiles(files: readonly File[]): void;
  remove(id: string): void;
  retry(id: string): void;
  clear(): void;
}

export interface AttachSelection {
  readonly accepted: readonly File[];
  readonly notice?: string;
}

/**
 * Какие файлы из выбранных можно приложить. Считаются только ещё не
 * отправленные вложения; отказ по количеству важнее отказа по размеру.
 */
export function selectAttachableFiles(
  existingCount: number,
  existingBytes: number,
  files: readonly File[],
): AttachSelection {
  const accepted: File[] = [];
  let count = existingCount;
  let bytes = existingBytes;
  let tooMany = false;
  let tooLarge = false;

  for (const file of files) {
    if (count >= MAX_MESSAGE_FILES) {
      tooMany = true;
      continue;
    }
    if (bytes + file.size > MAX_MESSAGE_UPLOAD_BYTES) {
      tooLarge = true;
      continue;
    }
    accepted.push(file);
    count += 1;
    bytes += file.size;
  }

  return {
    accepted,
    notice: tooMany ? TOO_MANY_FILES_MESSAGE : tooLarge ? MESSAGE_TOO_LARGE_MESSAGE : undefined,
  };
}

const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
};

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * Имя безымянного изображения из буфера обмена: «Снимок экрана
 * ГГГГ-ММ-ДД ЧЧ-ММ-СС.png» по местному времени.
 */
export function pastedImageName(date: Date, contentType = "image/png"): string {
  const stamp = [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`,
  ].join(" ");
  return `Снимок экрана ${stamp}.${IMAGE_EXTENSIONS[contentType] ?? "png"}`;
}

/** Имя приложенного файла: пустое заменяется именем снимка экрана. */
export function attachmentName(file: File, now: Date = new Date()): string {
  const name = file.name.trim();
  if (name.length > 0) return name;
  return pastedImageName(now, file.type);
}

/** Файловые части сообщения для eve; пустой массив — вложений нет. */
export function attachmentFileParts(
  items: readonly PendingAttachment[],
): Array<{ type: "file"; data: string; mediaType: string; filename: string }> {
  return items.flatMap((item) =>
    item.state === "done" && item.fileUrl !== undefined
      ? [
          {
            type: "file" as const,
            data: item.fileUrl,
            mediaType: item.contentType,
            filename: item.name,
          },
        ]
      : [],
  );
}

/** Содержимое сообщения: строка, если вложений нет, иначе части AI SDK. */
export function messageContent(
  text: string,
  items: readonly PendingAttachment[],
): string | UserContent {
  const parts = attachmentFileParts(items);
  const value = text.trim();
  if (parts.length === 0) return value;
  return [...(value.length === 0 ? [] : [{ type: "text" as const, text: value }]), ...parts];
}
