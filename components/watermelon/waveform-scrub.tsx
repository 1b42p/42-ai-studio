"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Pause, Play, RotateCcw } from "lucide-react";
import { useInView } from "motion/react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";

interface WaveformScrubProps {
  src: string;
  duration: number;
  fileName?: string;
  /** Normalized RMS peaks of this specific audio file, not animated random bars. */
  waveformHeights: readonly number[];
}

function clock(seconds: number) {
  return `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60).toString().padStart(2, "0")}`;
}

export function WaveformScrub({
  src,
  duration,
  fileName = "Послушайте голос",
  waveformHeights,
}: WaveformScrubProps) {
  const root = useRef<HTMLDivElement>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const pendingSeek = useRef<number | null>(null);
  const visible = useInView(root, { amount: 0.2 });
  const label = useId();
  const [currentTime, setCurrentTime] = useState(0);
  const [length, setLength] = useState(duration);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState(false);
  const finished = currentTime >= length;

  useEffect(() => {
    if (!visible) audio.current?.pause();
  }, [visible]);

  useEffect(() => {
    const pauseWhenHidden = () => {
      if (document.hidden) audio.current?.pause();
    };
    document.addEventListener("visibilitychange", pauseWhenHidden);
    return () => document.removeEventListener("visibilitychange", pauseWhenHidden);
  }, []);

  async function toggle() {
    const element = audio.current;
    if (!element) return;
    if (!element.paused) {
      element.pause();
      return;
    }
    setError(false);
    // No src is assigned until an explicit Play gesture, not even for seeking.
    if (!element.getAttribute("src")) element.src = src;
    if (finished) {
      pendingSeek.current = 0;
      element.currentTime = 0;
      setCurrentTime(0);
    }
    try {
      await element.play();
    } catch {
      setError(true);
      setPlaying(false);
    }
  }

  function seek(value: number | readonly number[]) {
    const time = Math.max(0, Math.min(length, typeof value === "number" ? value : value[0]));
    setCurrentTime(time);
    pendingSeek.current = time;
    if (audio.current && audio.current.readyState > 0) {
      audio.current.currentTime = time;
      pendingSeek.current = null;
    }
  }

  return (
    <Card ref={root} variant="default" className="w-full rounded-2xl">
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <Button
            size="icon-lg"
            variant="default"
            className="rounded-full"
            onClick={toggle}
            aria-label={playing ? "Приостановить озвучку" : finished ? "Послушать ещё раз" : "Послушать озвучку"}
          >
            {playing ? <Pause /> : finished ? <RotateCcw /> : <Play />}
          </Button>
          <span className="min-w-0 flex-1 truncate font-medium">{fileName}</span>
          <span className="font-mono text-xs text-muted-foreground tabular-nums">
            {clock(currentTime)} / {clock(length)}
          </span>
        </div>
        <div aria-hidden="true" className="relative flex h-24 items-center gap-[2px] overflow-hidden">
          {waveformHeights.map((peak, index) => (
            <div
              key={index}
              className={cn("min-w-0 flex-1 rounded-full", index / waveformHeights.length < currentTime / length ? "bg-primary" : "bg-foreground/20")}
              style={{ height: `${Math.max(3, Math.min(1, peak) * 88)}%` }}
            />
          ))}
          <div className="absolute inset-y-0 w-px bg-primary" style={{ left: `${Math.min(99.8, currentTime / length * 100)}%` }} />
        </div>
        <span id={label} className="sr-only">Позиция воспроизведения озвучки</span>
        <Slider
          value={[currentTime]}
          min={0}
          max={length}
          step={0.1}
          onValueChange={seek}
          aria-labelledby={label}
          className="py-2"
        />
        {error && <p role="alert" className="text-sm text-destructive">Не удалось включить звук. Нажмите, чтобы повторить.</p>}
        <audio
          ref={audio}
          preload="none"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => { setPlaying(false); setCurrentTime(length); }}
          onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
          onLoadedMetadata={(event) => {
            const element = event.currentTarget;
            if (Number.isFinite(element.duration)) setLength(element.duration);
            if (pendingSeek.current !== null) {
              element.currentTime = pendingSeek.current;
              pendingSeek.current = null;
            }
          }}
          onError={() => { setError(true); setPlaying(false); }}
        />
      </CardContent>
    </Card>
  );
}
