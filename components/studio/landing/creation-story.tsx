"use client";

import { useEffect, useState } from "react";
import { ArrowUpRight, RotateCcw } from "lucide-react";
import { MotionSurface } from "@/components/studio/motion-surface";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useReducedMotionPreference } from "@/hooks/use-reduced-motion";

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
      <Tabs value={stage} onValueChange={selectStage}>
        <div className="min-w-0 overflow-x-auto">
          <TabsList activateOnFocus aria-label="Этапы создания видео">
            {steps.map((step, index) => (
              <TabsTrigger key={step.title} value={index}>{step.title}</TabsTrigger>
            ))}
          </TabsList>
        </div>
        {steps.map((step, index) => (
          <TabsContent key={step.title} value={index}>
            <div className="flex flex-col gap-4">
              <p className="text-muted-foreground">{step.description}</p>
              <Card>
                <CardHeader>
                  <CardTitle>{captions[index][0]}</CardTitle>
                  <CardDescription>{captions[index][1]}</CardDescription>
                  <CardAction>
                    <Badge variant="outline">
                      <span className="hidden sm:inline">Из идеи в кадр</span>
                      {String(index + 1).padStart(2, "0")} / 04
                    </Badge>
                  </CardAction>
                </CardHeader>
                <CardContent className="relative overflow-hidden">
                  <div className="h-[390px] md:h-auto md:aspect-[1200/590]">
                    <CreationArtwork stage={index} scene={scene} />
                  </div>
                </CardContent>
                <CardFooter className="flex-wrap justify-between gap-3">
                  {index === 3 ? (
                    <>
                      <div className="flex gap-2" aria-label="Кадры готовой композиции">
                        {[0, 1, 2].map((frame) => (
                          <Button key={frame} variant={scene === frame ? "default" : "ghost"} size="sm" aria-label={`Кадр ${frame + 1}`} aria-pressed={scene === frame} onClick={() => { setScene(frame); setPlaying(false); }}>
                            0{frame + 1}
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
                      <Button variant="ghost" size="sm" onClick={() => selectStage(index + 1)}>
                        Дальше
                        <ArrowUpRight data-icon="inline-end" aria-hidden="true" />
                      </Button>
                    </>
                  )}
                </CardFooter>
              </Card>
            </div>
          </TabsContent>
        ))}
      </Tabs>
    </MotionSurface>
  );
}
