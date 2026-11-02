"use client";

/** Карточка загрузки в предпросмотре под полем ввода (#9). */
import { RefreshCwIcon, XIcon } from "lucide-react";

import { attachmentIcon, isImageType } from "@/components/studio/chat/attachment-kind";
import type { PendingAttachment } from "@/components/studio/chat/attachments";
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
} from "@/components/ui/attachment";
import { Progress } from "@/components/ui/progress";
import { formatFileSize } from "@/lib/format-size";

export interface AttachmentCardProps {
  item: PendingAttachment;
  onRemove: (id: string) => void;
  onRetry: (id: string) => void;
}

/**
 * Одна загрузка: имя, размер и процент с полосой, пока идёт загрузка; текст
 * ошибки и «Повторить» после отказа. Крестик прерывает загрузку.
 */
export function AttachmentCard({ item, onRemove, onRetry }: AttachmentCardProps) {
  const Icon = attachmentIcon(item.contentType);
  const size = formatFileSize(item.sizeBytes);
  const uploading = item.state === "uploading";
  const description =
    item.state === "error"
      ? (item.error ?? "Не удалось загрузить файл")
      : uploading
        ? `${size} · ${item.progress}%`
        : size;

  return (
    <Attachment size="sm" state={item.state}>
      <AttachmentMedia variant={isImageType(item.contentType) ? "image" : "icon"}>
        {item.previewUrl === undefined ? (
          <Icon />
        ) : (
          <img alt="" src={item.previewUrl} />
        )}
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>{item.name}</AttachmentTitle>
        <AttachmentDescription>{description}</AttachmentDescription>
        {uploading ? (
          <Progress
            aria-label="Загрузка файла"
            className="mt-1.5"
            value={item.progress}
          />
        ) : null}
      </AttachmentContent>
      <AttachmentActions>
        {item.state === "error" ? (
          <AttachmentAction aria-label="Повторить" onClick={() => onRetry(item.id)}>
            <RefreshCwIcon />
          </AttachmentAction>
        ) : null}
        <AttachmentAction aria-label="Убрать файл" onClick={() => onRemove(item.id)}>
          <XIcon />
        </AttachmentAction>
      </AttachmentActions>
    </Attachment>
  );
}
