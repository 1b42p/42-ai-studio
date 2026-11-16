"use client";

import { useId, useRef, useState } from "react";
import { Captions, Check, Clock3, Film, Mic, Smartphone, Waypoints, ChartNoAxesCombined } from "lucide-react";

import { AspectRatio } from "@/components/ui/aspect-ratio";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Carousel, CarouselContent, CarouselItem, CarouselNext, CarouselPrevious } from "@/components/ui/carousel";
import type { ExampleVideo } from "@/lib/examples";
import { cn } from "@/lib/utils";

function FeatureBadge({ label }: { label: string }) {
  const Icon = label === "Озвучка" ? Mic
    : label === "Субтитры" ? Captions
    : label === "Схемы" ? Waypoints
    : label === "Графики" ? ChartNoAxesCombined
    : label === "Вертикальный формат" ? Smartphone : Check;
  return <Badge variant="secondary"><Icon data-icon="inline-start" aria-hidden="true" />{label}</Badge>;
}

export function ExampleCard({
  example,
  onPlay,
}: {
  example: ExampleVideo;
  onPlay?: (video: HTMLVideoElement) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const requestId = useId();
  const vertical = example.format === "9:16";
  const seconds = Math.round(example.durationSec);

  return (
    <Card className="h-full min-w-0 gap-5 pt-0">
      <CardContent className="p-0">
        <div
          className="mx-auto w-full overflow-hidden rounded-t-xl bg-muted"
          style={vertical ? { maxWidth: `calc(70svh * ${example.width} / ${example.height})` } : undefined}
        >
          <AspectRatio ratio={example.width / example.height}>
            <video
              src={example.video}
              poster={example.poster}
              width={example.width}
              height={example.height}
              controls
              preload="none"
              playsInline
              aria-label={example.title}
              className="absolute inset-0 size-full max-h-[70svh] object-contain"
              onPlay={(event) => onPlay?.(event.currentTarget)}
            >
              <img src={example.poster} alt={example.title} width={example.width} height={example.height} />
            </video>
          </AspectRatio>
        </div>
      </CardContent>
      <CardHeader className="gap-3">
        <CardTitle><h3>{example.title}</h3></CardTitle>
        <div className="flex flex-wrap gap-1.5">
          {example.features.map((label) => <FeatureBadge key={label} label={label} />)}
        </div>
      </CardHeader>
      <CardContent className="flex flex-col items-start gap-1">
        <CardDescription id={requestId} className={cn("leading-relaxed break-words", !expanded && "line-clamp-3 md:line-clamp-none")}>
          Запрос: «{example.request}»
        </CardDescription>
        <Button
          variant="link"
          size="sm"
          className="h-auto px-0 py-2 md:hidden"
          aria-expanded={expanded}
          aria-controls={requestId}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Свернуть" : "Показать полностью"}
        </Button>
      </CardContent>
      <CardFooter className="mt-auto flex-wrap gap-4">
        <span className="text-muted-foreground inline-flex items-center gap-1.5 text-xs"><Film className="size-3.5" aria-hidden="true" />{example.format}</span>
        <span className="text-muted-foreground inline-flex items-center gap-1.5 text-xs tabular-nums"><Clock3 className="size-3.5" aria-hidden="true" />{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}</span>
      </CardFooter>
    </Card>
  );
}

export function ExamplesSection({ examples }: { examples: readonly ExampleVideo[] }) {
  const root = useRef<HTMLElement>(null);
  if (examples.length === 0) return null;

  const play = (current: HTMLVideoElement) => {
    root.current?.querySelectorAll("video").forEach((video) => {
      if (video !== current) video.pause();
    });
  };

  return (
    <section ref={root} id="examples" aria-labelledby="examples-title" className="mx-auto flex w-full max-w-7xl scroll-mt-14 flex-col gap-8 px-4 py-16 md:px-8 md:py-20">
      <div className="flex flex-col gap-3">
        <h2 id="examples-title" className="font-heading text-3xl font-semibold tracking-tight md:text-4xl">Примеры готовых роликов</h2>
        <p className="text-muted-foreground">Все ролики сделал агент по одной просьбе в чате</p>
      </div>
      <Carousel aria-label="Примеры готовых роликов" deferUntilVisible opts={{ align: "start", loop: false }}>
        <CarouselContent className="items-stretch">
          {examples.map((example, index) => (
            <CarouselItem key={example.id} className="basis-[90%] pb-1 md:basis-1/3" aria-label={`${index + 1} из ${examples.length}`}>
              <ExampleCard example={example} onPlay={play} />
            </CarouselItem>
          ))}
        </CarouselContent>
        {examples.length > 3 && (
          <div className="mt-6 hidden justify-end gap-2 md:flex">
            <CarouselPrevious className="static translate-none" />
            <CarouselNext className="static translate-none" />
          </div>
        )}
      </Carousel>
    </section>
  );
}
