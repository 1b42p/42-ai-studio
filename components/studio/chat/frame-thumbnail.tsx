"use client";

import { ImageOffIcon } from "lucide-react";

import { useMediaRetry } from "@/components/studio/use-media-retry";
import {
  Attachment,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTrigger,
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

/** Кадр скачанного видео: миниатюра, подпись момента и крупный просмотр. */
export function FrameThumbnail({
  mediaId,
  label,
}: {
  mediaId: string | null;
  label: string;
}) {
  const retry = useMediaRetry(mediaId);
  const missing = mediaId === null || retry.failed || retry.src === undefined;
  if (missing) {
    return (
      <Attachment className="w-full max-w-full has-data-[slot=attachment-content]:w-full" orientation="vertical" state="error">
        <AttachmentMedia className="aspect-auto h-20">
          <ImageOffIcon />
        </AttachmentMedia>
        <AttachmentContent>
          <AttachmentDescription>Кадр недоступен</AttachmentDescription>
        </AttachmentContent>
      </Attachment>
    );
  }

  return (
    <Dialog>
      <Attachment className="w-full max-w-full has-data-[slot=attachment-content]:w-full" orientation="vertical">
        <AttachmentMedia className="aspect-auto min-h-16 w-full" variant="image">
          <img
            alt={label}
            className="block h-auto max-h-[180px] w-auto min-w-0 max-w-full object-contain"
            onError={retry.onError}
            src={retry.src}
          />
          <DialogTrigger
            render={<AttachmentTrigger aria-label={`Открыть кадр ${label}`} />}
          />
        </AttachmentMedia>
        <AttachmentContent>
          <AttachmentDescription>{label}</AttachmentDescription>
        </AttachmentContent>
      </Attachment>
      <DialogContent className="right-0 left-0 mx-auto max-h-[calc(100dvh-2rem)] w-fit max-w-[calc(100vw-2rem)] min-w-0 translate-x-0 overflow-hidden sm:max-w-[calc(100vw-2rem)]">
        <DialogHeader className="min-w-0 pr-8">
          <DialogTitle>Кадр</DialogTitle>
          <DialogDescription>{label}</DialogDescription>
        </DialogHeader>
        <img
          alt={label}
          className="mx-auto block h-auto max-h-[calc(100dvh-9rem)] w-auto min-w-0 max-w-full object-contain"
          onError={retry.onError}
          src={retry.src}
        />
      </DialogContent>
    </Dialog>
  );
}
