"use client";

import { AudioLinesIcon } from "lucide-react";
import { useState } from "react";

import type { ToolCardProps } from "@/components/studio/chat/tool-card";
import { StudioAudioPlayer } from "@/components/studio/media/studio-audio-player";
import { useMediaRetry } from "@/components/studio/use-media-retry";
import { Button } from "@/components/ui/button";
import { CodeBlock, CodeBlockContent } from "@/components/ui/code-block";
import {
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@/components/ui/trace";
import { formatClock, languageLabel, voiceDisplayName } from "@/lib/speech/format";

const COLLAPSE_AT = 240;

interface SpeakView {
  text: string;
  voice: string;
  language: string;
  durationMs: number;
  audioId: string | null;
}

function speakView(value: unknown): SpeakView | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.text !== "string" || typeof record.voice !== "string") return null;
  const media = record.media;
  const audioId =
    typeof media === "object" &&
    media !== null &&
    "audioId" in media &&
    typeof media.audioId === "string"
      ? media.audioId
      : null;
  return {
    text: record.text,
    voice: record.voice,
    language: typeof record.language === "string" ? record.language : "",
    durationMs: typeof record.durationMs === "number" ? record.durationMs : 0,
    audioId,
  };
}

function SpokenText({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const collapsible = text.length > COLLAPSE_AT || text.split("\n").length > 5;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <p
        className={expanded || !collapsible ? "break-words" : "line-clamp-5 break-words"}
        data-clamped={expanded || !collapsible ? "false" : "true"}
      >
        {text}
      </p>
      {collapsible && !expanded ? (
        <Button onClick={() => setExpanded(true)} size="sm" type="button" variant="ghost">
          Показать полностью
        </Button>
      ) : null}
    </div>
  );
}

function ReadyCard({ view }: { view: SpeakView }) {
  const retry = useMediaRetry(view.audioId);
  const missing = view.audioId === null || retry.failed;
  const language = view.language.length > 0 ? languageLabel(view.language) : "";
  const description = [voiceDisplayName(view.voice), language, formatClock(view.durationMs)]
    .filter((part) => part.length > 0)
    .join(" · ");
  return (
    <TraceCollapsible defaultOpen>
      <TraceCollapsibleTrigger className="w-full">
        <TraceLine className="w-full">
          <TraceIcon>
            <AudioLinesIcon />
          </TraceIcon>
          <TraceTitle className="shrink-0">Озвучка готова</TraceTitle>
          <TraceDescription className="min-w-0 shrink truncate">{description}</TraceDescription>
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent className="flex min-w-0 flex-col gap-2">
        <SpokenText text={view.text} />
        {missing ? (
          <p>Файл озвучки не найден</p>
        ) : (
          <StudioAudioPlayer onError={retry.onError} src={retry.src} />
        )}
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}

/** Карточка `speak`: подпись, текст и плеер. Имя инструмента и вход не показываются. */
export function SpeakCard({ part }: ToolCardProps) {
  if (part.state === "output-error") {
    return (
      <TraceCollapsible defaultOpen>
        <TraceCollapsibleTrigger className="w-full">
          <TraceLine className="w-full" status="error">
            <TraceIcon>
              <AudioLinesIcon />
            </TraceIcon>
            <TraceTitle>Озвучка</TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          <CodeBlock size="sm" variant="destructive">
            <CodeBlockContent className="max-h-64" wrap>
              {part.errorText ?? ""}
            </CodeBlockContent>
          </CodeBlock>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    );
  }

  if (part.state === "output-available") {
    const view = speakView(part.output);
    if (view === null) {
      return (
        <TraceLine>
          <TraceIcon>
            <AudioLinesIcon />
          </TraceIcon>
          <TraceTitle>Файл озвучки не найден</TraceTitle>
        </TraceLine>
      );
    }
    return <ReadyCard view={view} />;
  }

  return (
    <TraceLine status="running">
      <TraceIcon>
        <AudioLinesIcon />
      </TraceIcon>
      <TraceTitle>Озвучка текста</TraceTitle>
    </TraceLine>
  );
}
