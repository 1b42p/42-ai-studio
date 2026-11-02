"use client";

import {
  AlertCircleIcon,
  DownloadIcon,
  FileAudioIcon,
  FileIcon,
  FileImageIcon,
  FileTextIcon,
  FileVideoIcon,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";

import { StudioAudioPlayer } from "@/components/studio/media/studio-audio-player";
import { useMediaRetry } from "@/components/studio/use-media-retry";
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
} from "@/components/ui/attachment";
import { Button } from "@/components/ui/button";
import { Card, CardFooter } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { MessageFileView } from "@/lib/media/types";

/** Что известно о файле по паре «сообщение, путь». */
export type SandboxFileStatus =
  | { readonly kind: "entry"; readonly entry: MessageFileView }
  | { readonly kind: "pending" }
  | { readonly kind: "unknown" };

/**
 * Как разрешать файлы: обычная беседа, копия агента (#12) или часть без
 * координат сообщения.
 */
export type SandboxFileResolver =
  | { readonly kind: "disabled" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "lookup"; readonly status: (path: string) => SandboxFileStatus };

export interface SandboxFileProps {
  readonly path: string | null;
  readonly label?: string;
  /** Исходный путь отвергнутой ссылки: нужен режиму «без файлов». */
  readonly originalPath?: string;
  readonly resolver: SandboxFileResolver;
  /** Адрес отвергнутой ссылки: файл заведомо не найден. */
  readonly rejected?: boolean;
}

function downloadUrl(mediaId: string): string {
  return `/api/media/${mediaId}?download=1`;
}

function formatSize(bytes: number | null): string {
  if (bytes === null) return "";
  const units = ["Б", "КБ", "МБ", "ГБ"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const formatted = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 }).format(value);
  return `${formatted} ${units[unit]}`;
}

function iconFor(contentType: string | null): LucideIcon {
  if (contentType === null) return FileIcon;
  if (contentType.startsWith("video/")) return FileVideoIcon;
  if (contentType.startsWith("audio/")) return FileAudioIcon;
  if (contentType.startsWith("image/")) return FileImageIcon;
  if (contentType.startsWith("text/")) return FileTextIcon;
  return FileIcon;
}

function missingTitle(reason: MessageFileView["reason"]): string {
  switch (reason) {
    case "too_large":
      return "Файл слишком большой и не сохранён";
    case "too_many":
    case "copy_failed":
      return "Не удалось сохранить файл";
    case "not_found":
    case "outside_workspace":
    case null:
      return "Файл не найден";
  }
}

function DownloadButton({ mediaId }: { mediaId: string }) {
  return (
    <Button
      nativeButton={false}
      render={<a href={downloadUrl(mediaId)} />}
      size="sm"
      variant="outline"
    >
      <DownloadIcon data-icon="inline-start" />
      Скачать
    </Button>
  );
}

function Caption({ text, name }: { text: string | undefined; name: string }) {
  if (text === undefined || text.trim().length === 0 || text.trim() === name) return null;
  return <span className="block truncate text-xs text-muted-foreground">{text.trim()}</span>;
}

function PendingFile() {
  return (
    <Attachment className="w-full max-w-md" state="processing">
      <AttachmentMedia variant="icon">
        <Skeleton className="size-full" />
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>Файл готовится…</AttachmentTitle>
      </AttachmentContent>
    </Attachment>
  );
}

function MissingFile({ title, name }: { title: string; name?: string }) {
  return (
    <Attachment className="w-full max-w-md" state="error">
      <AttachmentMedia variant="icon">
        <AlertCircleIcon />
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>{title}</AttachmentTitle>
        {name === undefined ? null : (
          <AttachmentDescription className="truncate">{name}</AttachmentDescription>
        )}
      </AttachmentContent>
    </Attachment>
  );
}

function FileCard({ entry }: { entry: MessageFileView }) {
  const Icon = iconFor(entry.contentType);
  const size = formatSize(entry.sizeBytes);
  return (
    <Attachment className="w-full max-w-md">
      <AttachmentMedia variant="icon">
        <Icon />
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>{entry.name}</AttachmentTitle>
        <AttachmentDescription>{size.length > 0 ? size : "Файл"}</AttachmentDescription>
      </AttachmentContent>
      {entry.mediaId === null ? null : (
        <AttachmentActions>
          <AttachmentAction
            aria-label="Скачать"
            nativeButton={false}
            render={<a href={downloadUrl(entry.mediaId)} />}
          >
            <DownloadIcon />
          </AttachmentAction>
        </AttachmentActions>
      )}
    </Attachment>
  );
}

function MediaCard({
  entry,
  label,
  children,
}: {
  entry: MessageFileView;
  label?: string;
  children: ReactNode;
}) {
  return (
    <Card className="w-full max-w-xl gap-0 py-0">
      {children}
      <CardFooter className="justify-between gap-3 py-3">
        <div className="min-w-0">
          <span className="block truncate text-sm font-medium">{entry.name}</span>
          <Caption name={entry.name} text={label} />
        </div>
        {entry.mediaId === null ? null : <DownloadButton mediaId={entry.mediaId} />}
      </CardFooter>
    </Card>
  );
}

function VideoFile({ entry, label }: { entry: MessageFileView; label?: string }) {
  const { src, failed, onError } = useMediaRetry(entry.mediaId);
  const video = useRef<HTMLVideoElement>(null);
  const previousSrc = useRef(src);

  useEffect(() => {
    // После смены src на `?retry=1` элемент нужно перезапустить.
    if (previousSrc.current === src) return;
    previousSrc.current = src;
    video.current?.load();
  }, [src]);

  if (failed || src === undefined) return <FileCard entry={entry} />;

  return (
    <MediaCard entry={entry} label={label}>
      <video
        className="max-h-[70vh] w-full bg-muted object-contain"
        controls
        onError={onError}
        preload="metadata"
        ref={video}
        src={src}
      />
    </MediaCard>
  );
}

function ImageFile({ entry, label }: { entry: MessageFileView; label?: string }) {
  const { src, failed, onError } = useMediaRetry(entry.mediaId);
  if (failed || src === undefined) return <FileCard entry={entry} />;

  return (
    <MediaCard entry={entry}>
      <img
        alt={label === undefined || label.trim().length === 0 ? entry.name : label}
        className="max-h-[70vh] w-full bg-muted object-contain"
        onError={onError}
        src={src}
      />
    </MediaCard>
  );
}

function AudioFile({ entry, label }: { entry: MessageFileView; label?: string }) {
  const { src, failed, onError } = useMediaRetry(entry.mediaId);
  if (failed || src === undefined) return <FileCard entry={entry} />;

  return (
    <Attachment className="w-full max-w-md">
      <AttachmentContent className="flex flex-col gap-1">
        <Caption name={entry.name} text={label} />
        <StudioAudioPlayer onError={onError} src={src} />
      </AttachmentContent>
      {entry.mediaId === null ? null : (
        <AttachmentActions>
          <AttachmentAction
            aria-label="Скачать"
            nativeButton={false}
            render={<a href={downloadUrl(entry.mediaId)} />}
          >
            <DownloadIcon />
          </AttachmentAction>
        </AttachmentActions>
      )}
    </Attachment>
  );
}

function ReadyFile({ entry, label }: { entry: MessageFileView; label?: string }) {
  if (entry.contentType?.startsWith("video/")) return <VideoFile entry={entry} label={label} />;
  if (entry.contentType?.startsWith("audio/")) return <AudioFile entry={entry} label={label} />;
  if (entry.contentType?.startsWith("image/")) return <ImageFile entry={entry} label={label} />;
  return <FileCard entry={entry} />;
}

/**
 * Ссылка или картинка Markdown, которая указывает на файл песочницы: скелет,
 * плеер, изображение или карточка скачивания. В режиме копии агента файлы не
 * разрешаются — выводится путь текстом.
 */
export function SandboxFile({
  path,
  label,
  originalPath,
  resolver,
  rejected = false,
}: SandboxFileProps) {
  if (resolver.kind === "disabled") {
    const text =
      path ??
      originalPath ??
      (label === undefined || label.trim().length === 0 ? "Файл" : label);
    return (
      <span className="font-mono text-xs break-all text-muted-foreground">{text}</span>
    );
  }
  if (resolver.kind === "unavailable") {
    return <MissingFile title="Файл недоступен" name={path ?? undefined} />;
  }
  if (rejected) return <MissingFile title="Файл не найден" name={path ?? undefined} />;
  if (path === null) return <MissingFile title="Файл недоступен" />;

  const status = resolver.status(path);
  if (status.kind === "pending") return <PendingFile />;
  if (status.kind === "unknown") return <MissingFile title="Файл не найден" name={path} />;

  const entry = status.entry;
  if (entry.state === "copying") return <PendingFile />;
  if (entry.state === "missing") {
    return <MissingFile title={missingTitle(entry.reason)} name={entry.name} />;
  }
  return <ReadyFile entry={entry} label={label} />;
}
