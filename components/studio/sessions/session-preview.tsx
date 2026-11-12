"use client";

import { cn } from "cn";
import { ClapperboardIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useMediaRetry } from "@/components/studio/use-media-retry";
import { ItemMedia } from "@/components/ui/item";
import { Skeleton } from "@/components/ui/skeleton";

function PreviewImage({ mediaId }: { mediaId: string }) {
  const { src, failed, onError } = useMediaRetry(mediaId);
  const [loaded, setLoaded] = useState(false);
  const imageRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    const image = imageRef.current;
    if (!image?.complete) return;

    // SSR-картинка могла завершить загрузку до подключения обработчиков React.
    if (image.naturalWidth > 0) setLoaded(true);
    else onError();
  }, [src, onError]);

  if (failed) return <ClapperboardIcon />;

  return (
    <>
      {!loaded ? <Skeleton className="absolute inset-0 size-full motion-reduce:animate-none" /> : null}
      {/* Нативное изображение внутри ItemMedia использует защищённый маршрут приложения. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        alt=""
        ref={imageRef}
        className={cn("absolute inset-0 size-full object-contain", !loaded && "invisible")}
        onError={() => {
          setLoaded(false);
          onError();
        }}
        onLoad={() => setLoaded(true)}
        src={src}
      />
    </>
  );
}

export function SessionPreview({
  preview,
}: {
  preview: { readonly mediaId: string } | null;
}) {
  return (
    <ItemMedia
      aria-hidden="true"
      className="relative aspect-video w-24 overflow-hidden rounded-md bg-muted text-muted-foreground md:w-40"
      variant="icon"
    >
      {preview === null ? (
        <ClapperboardIcon />
      ) : (
        <PreviewImage key={preview.mediaId} mediaId={preview.mediaId} />
      )}
    </ItemMedia>
  );
}
