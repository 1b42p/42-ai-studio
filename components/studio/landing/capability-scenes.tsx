"use client";

import { useEffect, useId, useRef, useState } from "react";
import * as motion from "motion/react-m";
import { ArrowDown, ArrowRight, ArrowUpRight, FileText, Maximize2, Pause, Play, RotateCcw, Scissors } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useBentoActivity } from "@/components/watermelon/bento-02";
import { WaveformScrub } from "@/components/watermelon/waveform-scrub";
import { cn } from "@/lib/utils";
import voice from "@/lib/landing/voice-sample-v1.json";

function useSceneSteps(count: number, milliseconds: number) {
  const { active, visible, reduced } = useBentoActivity();
  const [playing, setPlaying] = useState<boolean | null>(null);
  const [step, setStep] = useState(0);
  const running = visible && !reduced && (playing ?? active);
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setStep((value) => (value + 1) % count), milliseconds);
    return () => window.clearInterval(timer);
  }, [running, count, milliseconds]);
  return { step, setStep, running, reduced, toggle: () => reduced ? setStep((value) => (value + 1) % count) : setPlaying(!running) };
}

export function KineticScene() {
  const { step, toggle, running, reduced } = useSceneSteps(3, 1600);
  return (
    <div className="relative isolate flex h-[310px] flex-col justify-between overflow-hidden px-6 md:h-[350px] lg:px-7" style={{ containerType: "inline-size" }}>
      <div className="relative z-10 flex items-center justify-between">
        <Badge variant="outline">Форма следует за идеей</Badge>
        <Button size="icon-sm" variant="ghost" onClick={toggle} aria-pressed={running} aria-label={running ? "Остановить титровую сцену" : "Сменить титровую сцену"}>
          {running ? <Pause /> : <Play />}
        </Button>
      </div>
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
        <motion.div
          className="absolute -right-8 top-12 size-52 rounded-full border-[34px] border-primary lg:right-5 lg:size-64 lg:border-[44px]"
          animate={{ x: step === 1 ? -65 : 0, y: step === 2 ? 50 : 0, scale: step === 1 ? 0.8 : 1 }}
          transition={{ duration: reduced ? 0 : 0.8, type: "spring", bounce: 0.15 }}
        />
        <motion.div
          className="absolute right-[25%] top-14 h-36 w-10 bg-foreground"
          animate={{ rotate: step === 2 ? 90 : -28, x: step === 1 ? 45 : 0 }}
          transition={{ duration: reduced ? 0 : 0.65 }}
        />
        <div className="absolute bottom-9 right-4 h-px w-1/3 bg-border" />
        <div className="absolute bottom-5 right-8 size-16 rounded-full border border-foreground/25" />
        <div className="absolute bottom-14 right-0 h-px w-24 -rotate-45 bg-foreground/25" />
      </div>
      <div className="relative z-10 pb-3">
        <motion.p
          className="font-heading leading-[0.86] font-semibold tracking-[-0.065em]"
          style={{ fontSize: "clamp(3rem, 12.5cqw, 7rem)" }}
          animate={{ x: step === 1 ? 12 : 0 }}
          transition={{ duration: reduced ? 0 : 0.65 }}
        >
          ИДЕЯ<span className="text-primary">.</span><br />
          <motion.span
            className="inline-block"
            animate={{ x: step === 2 ? 16 : 0 }}
            transition={{ duration: reduced ? 0 : 0.65, delay: reduced ? 0 : 0.08 }}
          >
            В ДВИЖЕНИИ
          </motion.span>
        </motion.p>
        <div className="mt-5 flex items-center gap-3">
          <span className="font-mono text-[10px] tracking-[0.18em] text-muted-foreground">ТИПОГРАФИКА / ГЕОМЕТРИЯ / РИТМ</span>
          <ArrowUpRight className="size-4 text-primary" />
        </div>
      </div>
    </div>
  );
}

export function CaptionScene() {
  const words = ["У", "каждого", "слова", "свой", "момент."];
  const { step, setStep, toggle, running, reduced } = useSceneSteps(words.length, 650);
  return (
    <div className="flex h-[250px] flex-col justify-between md:h-full md:min-h-[250px]">
      <div className="flex flex-wrap content-center gap-x-2 gap-y-3 py-7 font-heading text-[clamp(1.8rem,3vw,2.7rem)] leading-tight font-medium tracking-tight">
        {words.map((word, index) => (
          <motion.span
            key={word}
            className={cn("relative isolate inline-block px-1", index === step && "text-primary-foreground")}
            animate={{ y: index === step && !reduced ? -3 : 0 }}
            transition={{ duration: reduced ? 0 : 0.18 }}
          >
            {index === step && <motion.span layoutId="caption-highlight" className="absolute inset-0 -z-10 rounded-lg bg-primary" transition={{ duration: reduced ? 0 : 0.18 }} />}
            {word}{index < words.length - 1 ? " " : null}
          </motion.span>
        ))}
      </div>
      <div className="flex items-center gap-3">
        <Button size="icon" variant="outline" onClick={toggle} aria-label="Показать выделение слов">
          {running ? <Pause /> : <Play />}
        </Button>
        <div aria-hidden="true" className="flex flex-1 items-end gap-1">
          {words.map((word, index) => (
            <div key={word} className={cn("h-7 flex-1 rounded-sm border-b-2", index === step ? "border-primary bg-primary/20" : "border-border bg-foreground/5")} />
          ))}
        </div>
        <Button size="icon-sm" variant="ghost" onClick={() => setStep(0)} aria-label="Вернуться к первому слову"><RotateCcw /></Button>
      </div>
    </div>
  );
}

export function VoiceScene() {
  return (
    <div className="flex min-h-[225px] flex-col justify-center gap-4 py-2">
      <div aria-hidden="true" className="flex items-end gap-2 font-heading">
        <span className="border-b-2 border-primary text-6xl leading-none font-medium tracking-tighter text-foreground">Аа</span>
        <span className="mb-1 text-lg text-muted-foreground">Живой голос.<br />Ваши слова.</span>
      </div>
      <WaveformScrub src="/studio-design/voice-sample-v1.mp3" duration={voice.duration} waveformHeights={voice.peaks} fileName="Фрагмент озвучки" />
    </div>
  );
}

const sampleData = [
  { label: "А", value: 24 },
  { label: "Б", value: 48 },
  { label: "В", value: 36 },
  { label: "Г", value: 72 },
];

export function DataScene() {
  const [chart, setChart] = useState(true);
  const { reduced, visible } = useBentoActivity();
  return (
    <div className="flex min-h-[255px] flex-col gap-5">
      <div className="flex items-center justify-between gap-2">
        <Badge variant="outline">Пример данных</Badge>
        <Button size="sm" variant="ghost" onClick={() => setChart((value) => !value)} aria-label={chart ? "Показать исходную таблицу" : "Превратить таблицу в диаграмму"}>
          {chart ? "К таблице" : "В диаграмму"}<ArrowRight data-icon="inline-end" />
        </Button>
      </div>
      <div className="grid flex-1 grid-cols-[76px_1fr] gap-5 sm:grid-cols-[110px_1fr]">
        <div className="flex flex-col justify-end gap-2 pb-6 font-mono text-xs text-muted-foreground">
          <span className="mb-2 text-foreground">данные.csv</span>
          {sampleData.map(({ label, value }, index) => (
            <div key={label} className={cn("flex justify-between border-b border-border pb-1", chart && index === 3 && "border-primary font-medium text-foreground")}>
              <span>{label}</span><span>{value}</span>
            </div>
          ))}
        </div>
        <div className="relative h-44 border-b border-border pb-6">
          <div aria-hidden="true" className="absolute inset-0 flex flex-col justify-between pb-6">
            {[0, 1, 2, 3].map((line) => <div key={line} className="w-full border-t border-dashed border-border/70" />)}
          </div>
          {sampleData.map(({ label, value }, index) => (
            <motion.div
              key={label}
              initial={false}
              animate={{
                height: chart ? value / 80 * 144 : 28,
                width: chart ? "calc(25% - 10px)" : "100%",
                left: chart ? `${index * 25}%` : "0%",
                bottom: chart ? 24 : (3 - index) * 36 + 8,
                borderRadius: chart ? "8px 8px 0 0" : "6px",
              }}
              transition={{ duration: reduced || !visible ? 0 : 0.65, delay: reduced || !visible ? 0 : index * 0.06 }}
              className={cn("absolute flex items-start justify-center", index === 3 ? "bg-primary text-primary-foreground" : "bg-foreground/15 text-foreground")}
            >
              {!chart && <span className="absolute left-3 top-2 font-mono text-[10px]">{label}</span>}
              <span className="pt-2 font-mono text-[10px]">{value}</span>
              {chart && <span className="absolute -bottom-5 inset-x-0 text-center font-mono text-xs text-muted-foreground">{label}</span>}
            </motion.div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function DocumentScene() {
  const { active, reduced, visible } = useBentoActivity();
  return (
    <div className="relative isolate h-[230px]">
      <motion.div
        className="absolute left-1 top-5 w-[64%]"
        animate={{ rotate: active ? -15 : -9, x: active ? -8 : 0 }}
        transition={{ duration: reduced || !visible ? 0 : 0.4 }}
      >
        <Card variant="default" className="h-44 rounded-xl">
          <CardContent className="flex flex-col gap-3">
            <Badge variant="outline" className="w-fit">PDF</Badge>
            <span className="font-heading text-lg leading-tight font-medium">От большой<br />истории</span>
            <div className="flex flex-col gap-1.5" aria-hidden="true">
              {[100, 80, 90, 65].map((width, index) => <div key={index} className="h-1 rounded-full bg-foreground/10" style={{ width: `${width}%` }} />)}
            </div>
          </CardContent>
        </Card>
      </motion.div>
      <motion.div
        className="absolute left-[22%] top-1 w-[66%]"
        animate={{ rotate: active ? 10 : 6, x: active ? 9 : 0 }}
        transition={{ duration: reduced || !visible ? 0 : 0.4 }}
      >
        <Card variant="default" className="h-44 rounded-xl">
          <CardContent>
            <Badge variant="outline">PPTX</Badge>
            <div aria-hidden="true" className="relative mt-5 h-16 overflow-hidden rounded-lg bg-muted">
              <div className="absolute bottom-0 left-5 size-14 rounded-full bg-primary/80" />
              <div className="absolute right-4 top-2 size-11 rotate-12 border-[7px] border-foreground/30" />
            </div>
          </CardContent>
        </Card>
      </motion.div>
      <motion.div className="absolute bottom-0 right-0 w-[69%]" animate={{ y: active ? -8 : 0 }} transition={{ duration: reduced || !visible ? 0 : 0.4 }}>
        <Card variant="default" size="sm" className="rounded-xl shadow-lg">
          <CardContent className="flex items-center gap-3">
            <FileText aria-hidden="true" className="size-7 shrink-0 text-primary" />
            <span className="font-heading text-lg leading-tight font-medium">к главному<br />за минуту</span>
            <ArrowDown aria-hidden="true" className="ml-auto size-5 text-muted-foreground" />
          </CardContent>
        </Card>
      </motion.div>
    </div>
  );
}

function FilmFrame({ variant }: { variant: number }) {
  return (
    <img src={`/studio-design/film-frame-v1-${variant + 1}.webp`} alt="" width={320} height={180} loading="lazy" className="size-full object-cover" />
  );
}

export function FilmScene() {
  const { visible, reduced } = useBentoActivity();
  const [selected, setSelected] = useState(1);
  const [source, setSource] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [showVideo, setShowVideo] = useState(false);
  const [error, setError] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const playback = useRef({ start: 1.5, end: 3 });
  const pending = useRef(false);
  const id = useId();
  const intervals = ["0–1,5 с", "1,5–3 с", "3–4,5 с"];

  useEffect(() => {
    if (!visible) {
      pending.current = false;
      video.current?.pause();
    }
  }, [visible]);

  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const advance = () => {
      const element = video.current;
      if (!element || element.paused) return;
      if (element.currentTime >= playback.current.end) {
        pending.current = false;
        element.pause();
        element.currentTime = playback.current.end - 1 / 24;
        return;
      }
      frame = requestAnimationFrame(advance);
    };
    frame = requestAnimationFrame(advance);
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  // A changed preference stops existing motion, but never prevents explicit playback.
  useEffect(() => {
    if (reduced) {
      pending.current = false;
      video.current?.pause();
    }
  }, [reduced]);

  useEffect(() => {
    const element = video.current;
    const pause = () => {
      if (document.hidden) {
        pending.current = false;
        element?.pause();
      }
    };
    document.addEventListener("visibilitychange", pause);
    return () => {
      pending.current = false;
      element?.pause();
      document.removeEventListener("visibilitychange", pause);
    };
  }, []);

  function selectFragment(index: number) {
    pending.current = false;
    video.current?.pause();
    setSelected(index);
    setSource(false);
    setShowVideo(false);
    setError(false);
    playback.current = { start: index * 1.5, end: (index + 1) * 1.5 };
  }

  function play(useSource: boolean) {
    const element = video.current;
    if (!element) return;
    if (!element.paused && source === useSource) {
      pending.current = false;
      element.pause();
      return;
    }
    element.pause();
    setSource(useSource);
    setError(false);
    setShowVideo(false);
    playback.current = useSource
      ? { start: 0, end: 4.5 }
      : { start: selected * 1.5, end: (selected + 1) * 1.5 };
    pending.current = true;
    // No src at all before a play gesture: preload="none" alone is only a hint.
    if (!element.getAttribute("src") || element.error) {
      element.src = "/studio-design/film-source-v1.mp4";
      element.load();
    } else {
      beginPlayback();
    }
  }

  function beginPlayback() {
    const element = video.current;
    if (!element || !pending.current || document.hidden) return;
    element.currentTime = playback.current.start;
    void element.play().catch((failure: unknown) => {
      if (failure instanceof DOMException && failure.name === "AbortError") return;
      pending.current = false;
      setError(true);
      setShowVideo(false);
    });
  }

  return (
    <div className="@container/film flex min-h-[230px] flex-col gap-3 px-6 lg:px-7">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button size="xs" variant="ghost" onClick={() => play(true)} aria-controls={id} aria-label={playing && source ? "Остановить исходный клип" : "Посмотреть исходный клип целиком"}>
          {playing && source ? <Pause data-icon="inline-start" /> : <Play data-icon="inline-start" />}
          Исходник · 4,5 с
        </Button>
        <span className="text-[10px] text-muted-foreground">Съёмка с МКС</span>
      </div>
      <ToggleGroup
        value={[String(selected)]}
        onValueChange={(value) => { if (value.length) selectFragment(Number(value[0])); }}
        aria-label="Выберите интервал исходного видео"
        className="grid w-full grid-cols-3 gap-2"
      >
        {intervals.map((label, index) => (
          <ToggleGroupItem
            key={label}
            value={String(index)}
            aria-label={`Выбрать фрагмент ${index + 1}: ${label}`}
            aria-controls={id}
            className="h-auto min-w-0 flex-col gap-1.5 overflow-hidden rounded-md p-1 data-pressed:ring-2 data-pressed:ring-primary"
          >
            <span className="aspect-video w-full overflow-hidden rounded-sm"><FilmFrame variant={index} /></span>
            <span className="font-mono text-[10px]">{label}</span>
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
        <Scissors aria-hidden="true" className="size-3 text-primary" />
        <span>Один фрагмент</span><ArrowDown aria-hidden="true" className="ml-auto size-3" /><span>В композицию</span>
      </div>
      <Card id={id} size="sm" className="gap-0 py-0">
        <CardContent className="relative flex h-40 flex-col overflow-hidden p-0 @min-[280px]/film:h-32 @min-[280px]/film:flex-row">
          {!source && (
            <div className="order-2 flex shrink-0 items-center justify-between gap-2 p-2 @min-[280px]/film:order-none @min-[280px]/film:w-2/5 @min-[280px]/film:flex-col @min-[280px]/film:items-start @min-[280px]/film:gap-3 @min-[280px]/film:p-3">
              <span className="hidden font-mono text-[9px] text-muted-foreground @min-[280px]/film:inline">СЦЕНА 01</span>
              <span className="font-heading text-xs leading-[0.95] font-semibold tracking-tight @min-[280px]/film:text-lg">НАША{" "}<br className="hidden @min-[280px]/film:block" />ПЛАНЕТА<span className="text-primary">.</span></span>
              <span className="hidden text-[9px] text-muted-foreground @min-[280px]/film:inline">Взгляд с орбиты</span>
            </div>
          )}
          <div className="relative order-1 min-h-0 min-w-0 flex-1 overflow-hidden @min-[280px]/film:order-none">
            <div className="absolute inset-0"><FilmFrame variant={source ? 0 : selected} /></div>
            <video
              ref={video}
              preload="none"
              playsInline
              muted
              aria-label={source ? "Исходный клип: Земля с МКС" : `Фрагмент ${selected + 1} в композиции`}
              className={cn("absolute inset-0 size-full object-cover", !showVideo && "invisible")}
              onLoadedMetadata={beginPlayback}
              onPlaying={() => {
                if (!pending.current || document.hidden) {
                  video.current?.pause();
                  return;
                }
                setPlaying(true);
                setShowVideo(true);
              }}
              onPause={() => setPlaying(false)}
              onEnded={() => { pending.current = false; setPlaying(false); }}
              onTimeUpdate={() => {
                const element = video.current;
                if (element && !element.paused && element.currentTime >= playback.current.end) {
                  pending.current = false;
                  element.pause();
                  element.currentTime = Math.max(playback.current.start, playback.current.end - 1 / 24);
                }
              }}
              onError={() => {
                pending.current = false;
                setPlaying(false);
                setShowVideo(false);
                setError(true);
              }}
            />
          </div>
        </CardContent>
      </Card>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button size="xs" variant="outline" onClick={() => play(false)} aria-controls={id} aria-label={playing && !source ? "Остановить выбранный фрагмент" : `Посмотреть фрагмент ${selected + 1} в композиции`}>
          {playing && !source ? <Pause data-icon="inline-start" /> : <Play data-icon="inline-start" />}
          Фрагмент 0{selected + 1} · 1,5 с
        </Button>
        <span className="text-[9px] text-muted-foreground">Видео: NASA Johnson</span>
      </div>
      <span role="status" className={error ? "text-xs text-destructive" : "sr-only"}>
        {error ? "Не удалось загрузить видео. Нажмите ещё раз." : `В композиции выбран фрагмент ${selected + 1}: ${intervals[selected]}.`}
      </span>
    </div>
  );
}

const score = [
  { x: 0, y: 2, length: 2 }, { x: 2, y: 1, length: 1 }, { x: 3, y: 3, length: 2 },
  { x: 5, y: 2, length: 1 }, { x: 6, y: 0, length: 2 }, { x: 8, y: 1, length: 2 },
  { x: 10, y: 3, length: 1 }, { x: 11, y: 2, length: 2 }, { x: 13, y: 1, length: 3 },
];

export function MusicScene() {
  const { step, toggle, running, reduced } = useSceneSteps(16, 240);
  return (
    <div className="flex h-[230px] flex-col justify-between gap-4">
      <div className="flex items-center gap-2">
        <span className="font-heading text-4xl leading-none tracking-tight">ля<span className="text-primary">—</span></span>
        <span className="ml-auto font-mono text-[10px] text-muted-foreground">МЕЛОДИЯ / БАС / РИТМ</span>
      </div>
      <div aria-hidden="true" className="relative h-32 overflow-hidden border-y border-border">
        <div className="absolute inset-0 grid grid-cols-16">{Array.from({ length: 16 }, (_, index) => <div key={index} className="border-r border-border/50" />)}</div>
        <div className="absolute inset-0 grid grid-rows-6">{Array.from({ length: 6 }, (_, index) => <div key={index} className="border-b border-border/50" />)}</div>
        {score.map((note, index) => (
          <div key={index} className="absolute h-3 rounded-sm bg-primary" style={{ left: `${note.x / 16 * 100}%`, top: `${note.y * 16 + 7}%`, width: `calc(${note.length / 16 * 100}% - 3px)` }} />
        ))}
        {[0, 4, 8, 12].map((beat) => <div key={beat} className="absolute bottom-2 h-3 rounded-sm bg-foreground/35" style={{ left: `${beat / 16 * 100}%`, width: "22%" }} />)}
        <motion.div className="absolute inset-y-0 w-px bg-foreground" animate={{ left: `${step / 16 * 100}%` }} transition={{ duration: reduced ? 0 : 0.18 }} />
      </div>
      <div className="flex items-center justify-between gap-2">
        <Button size="sm" variant="outline" onClick={toggle}>{running ? <Pause data-icon="inline-start" /> : <Play data-icon="inline-start" />}{running ? "Остановить ритм" : "Показать ритм"}</Button>
        <span className="text-xs text-muted-foreground">Партитура ролика</span>
      </div>
    </div>
  );
}

export function EditScene() {
  const [large, setLarge] = useState(false);
  const { reduced, visible } = useBentoActivity();
  const id = useId();
  return (
    <div className="grid items-center gap-6 md:grid-cols-[0.85fr_1.15fr] lg:gap-14">
      <div className="flex flex-col items-start gap-4 py-2">
        <Badge variant="outline">Попробуйте прямо здесь</Badge>
        <p className="font-heading max-w-xs text-2xl leading-snug font-medium tracking-tight lg:text-3xl">Хорошая идея.<br /><span className="text-muted-foreground">Ещё один штрих.</span></p>
        <Button variant={large ? "secondary" : "default"} size="lg" onClick={() => setLarge((value) => !value)} aria-controls={id} aria-pressed={large}>
          {large ? <RotateCcw data-icon="inline-start" /> : <Maximize2 data-icon="inline-start" />}
          {large ? "Вернуть как было" : "Сделай заголовок крупнее"}
        </Button>
      </div>
      <Card id={id} variant="default" className="relative isolate h-[230px] overflow-hidden rounded-2xl sm:h-[260px]" style={{ containerType: "inline-size" }}>
        <CardContent className="relative flex h-full flex-col justify-between">
          <div aria-hidden="true" className="pointer-events-none absolute -right-8 -top-14 size-60 rounded-full border-[38px] border-primary/20" />
          <div className="relative flex items-center justify-between">
            <span className="font-mono text-[10px] tracking-widest text-muted-foreground">ВСТРЕЧАЕМ НОВЫЙ ДЕНЬ</span>
            <Badge variant="secondary">{large ? "02" : "01"}</Badge>
          </div>
          <motion.p
            initial={false}
            animate={{ fontSize: large ? "clamp(1.8rem, 9.2cqw, 3.8rem)" : "clamp(1.4rem, 5cqw, 2.5rem)" }}
            transition={{ duration: reduced || !visible ? 0 : 0.5 }}
            className="font-heading relative leading-[0.92] font-semibold tracking-[-0.06em]"
          >
            БОЛЬШЕ<br />ВОЗМОЖНОСТЕЙ<span className="text-primary">.</span>
          </motion.p>
          <div className="relative flex items-center justify-between">
            <span className="text-xs text-muted-foreground">Начните с вашей идеи</span>
            <ArrowUpRight aria-hidden="true" className="size-5 text-primary" />
          </div>
        </CardContent>
      </Card>
      <span role="status" className="sr-only">{large ? "Заголовок в композиции увеличен." : "Исходный размер заголовка."}</span>
    </div>
  );
}
