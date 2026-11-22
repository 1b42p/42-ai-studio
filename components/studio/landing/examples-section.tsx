"use client";

import { useId, useMemo, useRef, useState } from "react";
import AutoHeight from "embla-carousel-auto-height";
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
    <Card className="min-w-0">
      <CardContent>
        <div
          className="mx-auto w-full overflow-hidden rounded-2xl bg-muted ring-1 ring-border/70"
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
      <CardHeader>
        <CardTitle><h3>{example.title}</h3></CardTitle>
        <div className="flex flex-wrap gap-1.5">
          {example.features.map((label) => <FeatureBadge key={label} label={label} />)}
        </div>
      </CardHeader>
      <CardContent className="flex flex-col items-start gap-1">
        <CardDescription id={requestId} className={cn("break-words", !expanded && "line-clamp-3 md:line-clamp-none")}>
          Запрос: «{example.request}»
        </CardDescription>
        <Button
          variant="link"
          size="sm"
          className="md:hidden"
          aria-expanded={expanded}
          aria-controls={requestId}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Свернуть" : "Показать полностью"}
        </Button>
      </CardContent>
      <CardFooter className="flex-wrap gap-4">
        <span className="text-muted-foreground inline-flex items-center gap-1.5 text-xs"><Film className="size-3.5" aria-hidden="true" />{example.format}</span>
        <span className="text-muted-foreground inline-flex items-center gap-1.5 text-xs tabular-nums"><Clock3 className="size-3.5" aria-hidden="true" />{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}</span>
      </CardFooter>
    </Card>
  );
}

export function ExamplesSection({ examples }: { examples: readonly ExampleVideo[] }) {
  const root = useRef<HTMLElement>(null);
  const plugins = useMemo(() => [
    AutoHeight({ breakpoints: { "(min-width: 768px)": { active: false } } }),
  ], []);
  const editorial = examples.length === 3 && examples.some(({ format }) => format === "9:16");
  if (examples.length === 0) return null;

  const play = (current: HTMLVideoElement) => {
    root.current?.querySelectorAll("video").forEach((video) => {
      if (video !== current) video.pause();
    });
  };

  return (
    <section ref={root} id="examples" aria-labelledby="examples-title" className="mx-auto flex w-full max-w-7xl scroll-mt-20 flex-col gap-10 px-5 py-16 md:gap-12 md:px-8 md:py-24">
      <div className="flex max-w-3xl flex-col gap-4">
        <h2 id="examples-title" className="font-heading text-4xl font-semibold tracking-tighter md:text-5xl">Примеры готовых роликов</h2>
        <p className="text-muted-foreground">Все ролики сделал агент по одной просьбе в чате</p>
      </div>
      <Carousel
        aria-label="Примеры готовых роликов"
        deferUntilVisible
        plugins={plugins}
        opts={{
          align: "start",
          loop: false,
          breakpoints: { "(min-width: 768px)": { active: examples.length > 3 } },
        }}
      >
        <CarouselContent className={cn(
          "items-start",
          editorial && "md:ml-0 md:grid md:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)] md:gap-x-10 md:gap-y-12",
        )}>
          {examples.map((example, index) => (
            <CarouselItem
              key={example.id}
              className={cn(
                "basis-[90%] pb-1 md:basis-1/3",
                editorial && "md:pl-0",
                editorial && example.format === "9:16" && "md:col-start-2 md:row-span-2 md:row-start-1 md:pt-16",
              )}
              aria-label={`${index + 1} из ${examples.length}`}
            >
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
