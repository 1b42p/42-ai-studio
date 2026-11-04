"use client";

import { ImageIcon, ImageOffIcon } from "lucide-react";
import { useRef, useState } from "react";

import type { ToolCardProps } from "@/components/studio/chat/tool-card";
import { useMediaRetry } from "@/components/studio/use-media-retry";
import {
  Attachment,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
} from "@/components/ui/attachment";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import {
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@/components/ui/trace";
import { formatUploadLimit } from "@/lib/uploads/limits";
import { cn } from "@/lib/utils";

interface FrameView {
  name: string;
  width: number;
  height: number;
  size: number;
  imageId: string | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

const MEDIA_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Узкая проекция результата: содержимое файла и ошибки не попадают в интерфейс. */
function frameView(output: unknown): FrameView | null {
  const value = record(output);
  const file = record(value?.file);
  if (
    !value || typeof value.path !== "string" ||
    !file || typeof file.mediaType !== "string" || !file.mediaType.startsWith("image/") ||
    !positiveInteger(file.width) || !positiveInteger(file.height) ||
    typeof file.size !== "number" || !Number.isSafeInteger(file.size) || file.size < 0
  ) return null;

  const media = record(value.media);
  return {
    name: value.path.split("/").filter(Boolean).at(-1) || "Кадр",
    width: file.width,
    height: file.height,
    size: file.size,
    imageId: typeof media?.imageId === "string" && MEDIA_ID.test(media.imageId) ? media.imageId : null,
  };
}

function FrameImage({ src, frame, full = false, onError }: {
  src: string;
  frame: FrameView;
  full?: boolean;
  onError: () => void;
}) {
  const [loaded, setLoaded] = useState(false);
  return (
    <AttachmentMedia
      aria-busy={!loaded}
      className={cn(
        "mx-auto aspect-auto w-auto min-w-0 max-w-full opacity-100 *:[img]:aspect-auto *:[img]:w-auto *:[img]:object-contain",
        !loaded && "min-h-24 min-w-24",
      )}
      variant="image"
    >
      <img
        alt={frame.name}
        className={cn(
          "block h-auto w-auto min-w-0 max-w-full object-contain",
          full ? "max-h-[calc(100dvh-9rem)]" : "max-h-[180px]",
          !loaded && "invisible",
        )}
        height={frame.height}
        onError={onError}
        onLoad={() => setLoaded(true)}
        src={src}
        width={frame.width}
      />
      {!loaded ? <Skeleton aria-label="Загрузка кадра" className="absolute inset-0" /> : null}
    </AttachmentMedia>
  );
}

function FrameAttachment({ frame }: { frame: FrameView }) {
  const retry = useMediaRetry(frame.imageId);
  const erroredSrc = useRef<string | undefined>(undefined);
  const missing = retry.failed || retry.src === undefined;
  const metadata = `${frame.width}×${frame.height} · ${formatUploadLimit(frame.size)}`;
  const content = (
    <AttachmentContent>
      <AttachmentTitle title={frame.name}>{frame.name}</AttachmentTitle>
      <AttachmentDescription>{missing ? "Кадр недоступен" : metadata}</AttachmentDescription>
    </AttachmentContent>
  );
  const onError = () => {
    // Миниатюра и открытый кадр могут сообщить об одной ошибке одновременно.
    if (erroredSrc.current === retry.src) return;
    erroredSrc.current = retry.src;
    retry.onError();
  };

  if (missing) {
    return (
      <Attachment className="w-80 has-data-[slot=attachment-content]:w-80" orientation="vertical" state="error">
        <AttachmentMedia className="aspect-auto h-20"><ImageOffIcon /></AttachmentMedia>
        {content}
      </Attachment>
    );
  }

  return (
    <Dialog>
      <Attachment className="w-80 has-data-[slot=attachment-content]:w-80" orientation="vertical">
        <DialogTrigger aria-label={`Открыть кадр: ${frame.name}`} className="w-full min-w-0 cursor-pointer rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
          <FrameImage frame={frame} key={retry.src} onError={onError} src={retry.src!} />
        </DialogTrigger>
        {content}
      </Attachment>
      <DialogContent className="right-0 left-0 mx-auto max-h-[calc(100dvh-2rem)] w-fit max-w-[calc(100vw-2rem)] min-w-0 translate-x-0 overflow-hidden sm:max-w-[calc(100vw-2rem)]">
        <DialogHeader className="min-w-0 pr-8">
          <DialogTitle>Кадр</DialogTitle>
          <DialogDescription className="truncate" title={frame.name}>{frame.name} · {metadata}</DialogDescription>
        </DialogHeader>
        <FrameImage frame={frame} full key={retry.src} onError={onError} src={retry.src!} />
      </DialogContent>
    </Dialog>
  );
}

/** Кадры раскрываются в ленте; прочие файлы остаются строкой с подписью eve. */
export function ReadFileCard({ part }: ToolCardProps) {
  const frame = part.state === "output-available" ? frameView(part.output) : null;
  if (frame) {
    return (
      <TraceCollapsible defaultOpen>
        <TraceCollapsibleTrigger className="w-full">
          <TraceLine className="w-full">
            <TraceIcon><ImageIcon /></TraceIcon>
            <TraceTitle className="shrink-0">Кадр</TraceTitle>
            <TraceDescription className="min-w-0 shrink truncate" title={frame.name}>
              {frame.name}
            </TraceDescription>
            <TraceDescription>{frame.width}×{frame.height}</TraceDescription>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          <FrameAttachment frame={frame} key={frame.imageId ?? frame.name} />
        </TraceCollapsibleContent>
      </TraceCollapsible>
    );
  }

  const denied = part.state === "output-denied" || (part.state === "approval-responded" && !part.approval.approved);
  const status = part.state === "output-error" ? "error" : denied || part.state === "output-available" ? undefined : "running";
  return (
    <TraceLine status={status}>
      <TraceIcon><ImageIcon /></TraceIcon>
      <TraceTitle>{part.toolMetadata?.eve?.label ?? "Чтение файла"}</TraceTitle>
    </TraceLine>
  );
}
