"use client";

import { useEffect, useState } from "react";
import { ArrowUpRight, RotateCcw } from "lucide-react";
import * as motion from "motion/react-m";
import { MotionSurface } from "@/components/studio/motion-surface";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useReducedMotionPreference } from "@/hooks/use-reduced-motion";
import { cn } from "@/lib/utils";

import { CreationArtwork } from "./creation-artwork";

interface CreationStep {
  title: string;
  description: string;
}

const captions = [
  ["Сначала — ваша мысль.", "Достаточно нескольких слов. Остальное сложится в историю."],
  ["У истории появляется форма.", "Вместо одинаковых слайдов — свой характер у каждого кадра."],
  ["Теперь она звучит.", "Графика, голос и слова встречаются в одном ритме."],
  ["Идея становится видео.", "Три сцены. Один визуальный язык. Посмотрите, как они соединяются."],
];

export function CreationStory({ steps }: { steps: readonly CreationStep[] }) {
  const [stage, setStage] = useState(0);
  const [scene, setScene] = useState(0);
  const [playing, setPlaying] = useState(false);
  const reduced = useReducedMotionPreference();

  useEffect(() => {
    if (!playing || stage !== 3) return;
    if (reduced) {
      setPlaying(false);
      return;
    }
    const timer = window.setTimeout(() => {
      if (scene >= 2) setPlaying(false);
      else setScene(scene + 1);
    }, 1800);
    return () => window.clearTimeout(timer);
  }, [playing, stage, scene, reduced]);

  function selectStage(value: unknown) {
    const next = Number(value);
    if (!Number.isInteger(next) || next < 0 || next > 3) return;
    setStage(next);
    setScene(0);
    setPlaying(false);
  }

  return (
    <MotionSurface>
    <Tabs value={stage} onValueChange={selectStage} className="gap-0">
      <Card variant="soft" className="gap-0 rounded-2xl py-0">
        <CardHeader className="flex flex-row items-start justify-between gap-4 px-5 pt-6 md:px-9 md:pt-8">
          <div className="flex flex-col gap-2">
            <CardTitle className="text-xl tracking-tight md:text-2xl">{captions[stage][0]}</CardTitle>
            <CardDescription className="max-w-lg text-sm leading-relaxed text-foreground/75">{captions[stage][1]}</CardDescription>
          </div>
          <Badge variant="outline" className="shrink-0 gap-2 border-primary/25 py-1.5 text-foreground">
            <span className="hidden sm:inline">Из идеи в кадр</span>
            {String(stage + 1).padStart(2, "0")} / 04
          </Badge>
        </CardHeader>
        <CardContent className="relative overflow-hidden px-0">
          <div className="h-[390px] md:h-auto md:aspect-[1200/590]">
            <CreationArtwork stage={stage} scene={scene} />
          </div>
          <div className="flex min-h-16 items-center justify-between gap-3 border-t border-border/70 px-5 py-3 md:px-9">
            {stage === 3 ? (
              <>
                <div className="flex gap-2" aria-label="Кадры готовой композиции">
                  {[0, 1, 2].map((index) => (
                    <Button key={index} variant={scene === index ? "default" : "ghost"} size="sm" aria-label={`Кадр ${index + 1}`} aria-pressed={scene === index} onClick={() => { setScene(index); setPlaying(false); }}>
                      0{index + 1}
                    </Button>
                  ))}
                </div>
                <Button variant="ghost" size="sm" onClick={() => { setScene(0); setPlaying(true); }} disabled={playing || reduced}>
                  <RotateCcw data-icon="inline-start" aria-hidden="true" />
                  {playing ? "Идёт монтаж" : "Смотреть монтаж"}
                </Button>
              </>
            ) : (
              <>
                <span className="text-xs text-foreground/75 md:text-sm">Небольшая история о большой идее</span>
                <Button variant="ghost" size="sm" onClick={() => selectStage(stage + 1)}>
                  Дальше
                  <ArrowUpRight data-icon="inline-end" aria-hidden="true" />
                </Button>
              </>
            )}
          </div>
        </CardContent>
      </Card>
      <TabsList variant="line" activateOnFocus aria-label="Этапы создания видео" className="mt-7 grid h-auto! w-full grid-cols-2 items-start gap-x-5 gap-y-6 rounded-none p-0 md:mt-9 md:grid-cols-4 md:gap-7">
        {steps.map((step, index) => (
          <TabsTrigger key={step.title} value={index} className={cn("relative h-full items-start justify-start rounded-none border-0 border-t-2 border-border px-0 pt-5 pb-0 text-left whitespace-normal after:hidden data-active:bg-transparent data-active:shadow-none", stage === index && "border-primary")}>
            <span className="flex flex-col gap-3">
              <span className="flex items-center gap-3">
                <span className={cn("text-xs tabular-nums", stage === index ? "text-foreground" : "text-muted-foreground")}>0{index + 1}</span>
                <span className="text-base font-semibold text-foreground">{step.title}</span>
              </span>
              <span className="text-sm leading-relaxed font-normal text-muted-foreground">{step.description}</span>
            </span>
            {stage === index && <motion.span layoutId="creation-active-step" transition={{ duration: reduced ? 0 : 0.35 }} className="absolute -top-0.5 left-0 h-0.5 w-12 bg-primary" />}
          </TabsTrigger>
        ))}
      </TabsList>
      {steps.map((step, index) => (
        <TabsContent key={step.title} value={index} className="sr-only">
          {step.title}. {captions[index]?.[0]}
        </TabsContent>
      ))}
    </Tabs>
    </MotionSurface>
  );
}
