"use client";

/**
 * Вложения в сообщении пользователя (#9): имя и значок из файловых частей
 * `message.received`; у изображения — миниатюра по адресу `/api/media/<uuid>`,
 * нажатие скачивает файл.
 */
import type { EveMessagePart } from "eve/react";

import { attachmentIcon, isImageType } from "@/components/studio/chat/attachment-kind";
import {
  Attachment,
  AttachmentContent,
  AttachmentMedia,
  AttachmentTitle,
  AttachmentTrigger,
} from "@/components/ui/attachment";
import { mediaIdFromUrl } from "@/lib/media/media-url";

type FilePart = Extract<EveMessagePart, { type: "file" }>;

function MessageAttachment({ part }: { part: FilePart }) {
  const name = part.filename?.trim() ?? "";
  const title = name.length === 0 ? "Файл" : name;
  const mediaId = part.url === undefined ? null : mediaIdFromUrl(part.url);
  const image = isImageType(part.mediaType) && mediaId !== null;
  const Icon = attachmentIcon(part.mediaType);

  return (
    <Attachment size="sm">
      <AttachmentMedia variant={image ? "image" : "icon"}>
        {image ? <img alt={title} src={`/api/media/${mediaId}`} /> : <Icon />}
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>{title}</AttachmentTitle>
      </AttachmentContent>
      {mediaId === null ? null : (
        <AttachmentTrigger
          aria-label={`Скачать ${title}`}
          render={<a href={`/api/media/${mediaId}?download=1`} />}
        />
      )}
    </Attachment>
  );
}

/** Вложения одного сообщения; без файловых частей ничего не рисуется. */
export function MessageAttachments({ parts }: { parts: readonly EveMessagePart[] }) {
  const files = parts.filter((part): part is FilePart => part.type === "file");
  if (files.length === 0) return null;

  return (
    <div className="flex flex-wrap justify-end gap-2">
      {files.map((part, index) => (
        <MessageAttachment key={`${part.filename ?? "file"}-${index}`} part={part} />
      ))}
    </div>
  );
}
