"use client";

import { Disc3, FileSpreadsheet, FileText, FileType, Link2, MessageSquareText, Music2 } from "lucide-react";

import Bento1, { type Bento1Item } from "@/components/watermelon/bento-01";
import { AspectRatio } from "@/components/ui/aspect-ratio";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import type { ExampleVideo } from "@/lib/examples";

import { landingFeatures } from "./content";

const documentFormats = [
  { label: "PDF", Icon: FileText },
  { label: "PPTX", Icon: FileType },
  { label: "XLSX", Icon: FileSpreadsheet },
];

function Poster({ example }: { example?: ExampleVideo }) {
  if (!example) return null;
  return (
    <AspectRatio ratio={example.width / example.height} className="overflow-hidden rounded-xl bg-muted">
      <img
        src={example.poster}
        alt={example.title}
        width={example.width}
        height={example.height}
        loading="lazy"
        className="absolute inset-0 size-full object-contain"
      />
    </AspectRatio>
  );
}

export function LandingCapabilities({ examples }: { examples: readonly ExampleVideo[] }) {
  const explainer = examples.find(({ id }) => id === "explainer");
  const chart = examples.find(({ id }) => id === "data-chart");
  const visuals: Record<number, Bento1Item["visual"]> = {
    0: <img src="/studio-design/voice-waveform.png" alt="" width={1200} height={240} loading="lazy" className="h-24 w-full object-cover" />,
    1: (
      <p aria-hidden="true" className="font-heading text-3xl leading-tight font-semibold tracking-tight md:text-4xl">
        Направления<br />
        <span className="rounded-lg bg-primary px-2 py-0.5 text-primary-foreground">движутся</span>
      </p>
    ),
    2: (
      <div className="w-full py-4">
        <Poster example={explainer} />
        <div aria-hidden="true" className="mt-4 flex items-center justify-between gap-3">
          <Badge variant="outline" className="rounded-lg">3D</Badge>
          <Badge variant="outline" className="rounded-lg">16:9</Badge>
          <Badge variant="outline" className="rounded-lg">9:16</Badge>
        </div>
      </div>
    ),
    3: <Poster example={chart} />,
    4: (
      <div aria-hidden="true" className="flex w-full flex-col gap-3">
        {documentFormats.map(({ label, Icon }) => (
            <Card key={label} variant="soft" size="sm" className="rounded-xl py-3">
              <CardContent className="flex items-center gap-3">
                <Icon className="size-5 text-foreground" />
                <span className="font-medium">{label}</span>
              </CardContent>
            </Card>
        ))}
      </div>
    ),
    5: (
      <div aria-hidden="true" className="flex w-full items-center justify-center py-5">
        <Card variant="accent" className="rotate-[-8deg] rounded-3xl p-6">
          <CardContent className="p-0"><Link2 className="size-14 stroke-[1.25]" /></CardContent>
        </Card>
      </div>
    ),
    6: (
      <div aria-hidden="true" className="flex w-full items-center gap-8 overflow-hidden">
        <Disc3 className="size-28 shrink-0 stroke-[0.65] text-foreground/80" />
        <Music2 className="size-16 shrink-0 stroke-[0.8] text-foreground/35" />
      </div>
    ),
    7: (
      <Card variant="soft" className="w-full rounded-2xl">
        <CardContent className="flex items-start gap-4">
          <MessageSquareText aria-hidden="true" className="mt-1 size-5 shrink-0" />
          <p className="font-heading max-w-sm text-2xl leading-snug font-medium tracking-tight">
            «Сделай заголовок крупнее»
          </p>
        </CardContent>
      </Card>
    ),
  };
  const layout: Record<number, Bento1Item["layout"]> = {
    0: "small", 1: "small", 2: "hero", 3: "half",
    4: "quarter", 5: "quarter", 6: "small", 7: "wide",
  };
  const items = [2, 0, 1, 3, 4, 5, 6, 7].map((index): Bento1Item => ({
    ...landingFeatures[index],
    visual: visuals[index],
    layout: layout[index],
    tone: index === 0 ? "brand" : index === 1 || index === 6 ? "soft" : "default",
  }));

  return <Bento1 items={items} />;
}
