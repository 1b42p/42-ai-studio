import type { ComponentType } from "react";
import { ArrowDownRight, ArrowRight, MessageSquareText, SlidersHorizontal, Clapperboard, FileVideo } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Item, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item";
import type { ExampleVideo } from "@/lib/examples";
import { cn } from "@/lib/utils";

interface WorkflowStep {
  title: string;
  description: string;
}

const icons: ComponentType<{ className?: string; "aria-hidden"?: boolean }>[] = [
  MessageSquareText, SlidersHorizontal, Clapperboard, FileVideo,
];

export default function Features3({
  steps,
  preview,
}: {
  steps: readonly WorkflowStep[];
  preview?: ExampleVideo;
}) {
  return (
    <section id="how" aria-labelledby="how-title" className="w-full scroll-mt-24 bg-muted/35">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-10 px-5 py-16 md:gap-14 md:px-8 md:py-24">
        <h2 id="how-title" className="font-heading max-w-3xl text-4xl font-semibold tracking-tighter md:text-5xl">
          Как это работает
        </h2>
        <div className={cn("grid gap-10 md:items-center md:gap-16", preview && "md:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]")}>
          {preview && <Card variant="media" className="relative overflow-visible rounded-3xl p-0">
            <CardContent className="relative overflow-hidden rounded-3xl p-0">
              <img
                src={preview.poster}
                alt={preview.title}
                width={preview.width}
                height={preview.height}
                loading="lazy"
                className="aspect-video w-full object-contain"
              />
            </CardContent>
            <Badge className="absolute -top-4 -left-2 gap-2 rounded-xl px-4 py-2 shadow-lg">
              <MessageSquareText data-icon="inline-start" aria-hidden="true" />
              Опишите задачу
            </Badge>
            <Badge variant="secondary" className="absolute -right-2 -bottom-4 gap-2 rounded-xl border border-border px-4 py-2 shadow-lg">
              <FileVideo data-icon="inline-start" aria-hidden="true" />
              Получите результат
            </Badge>
          </Card>}
          <div className="flex flex-col gap-2">
            {steps.map((step, index) => {
              const Icon = icons[index] ?? Clapperboard;
              return (
                <Item key={step.title} className="items-start gap-5 rounded-none px-0 py-5">
                  <Badge variant="outline" className="size-11 shrink-0 justify-center rounded-xl border-primary/20 bg-primary/5 text-base font-medium tabular-nums">
                    {index + 1}
                  </Badge>
                  <ItemContent className="gap-2">
                    <ItemTitle className="text-lg font-semibold">
                      <h3>{step.title}</h3>
                      <Icon aria-hidden={true} className="size-4 text-muted-foreground" />
                    </ItemTitle>
                    <ItemDescription className="line-clamp-none text-sm leading-relaxed">
                      {step.description}
                    </ItemDescription>
                  </ItemContent>
                  {index < steps.length - 1 && <ArrowDownRight aria-hidden="true" className="mt-3 size-4 shrink-0 text-muted-foreground md:hidden" />}
                  {index === steps.length - 1 && <ArrowRight aria-hidden="true" className="mt-3 hidden size-4 shrink-0 text-muted-foreground md:block" />}
                </Item>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
