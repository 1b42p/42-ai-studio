"use client";

import { DownloadIcon } from "lucide-react";

import type { ToolCardProps } from "@/components/studio/chat/tool-card";
import { FrameThumbnail } from "@/components/studio/chat/frame-thumbnail";
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
import { formatClock, formatMediaSize, safeHttpUrl } from "@/lib/download/policy";

const PHASES = new Set(["Читаю сведения", "Скачиваю", "Достаю кадры", "Кладу в песочницу"]);

interface DownloadFrameView {
  path: string;
  momentSec: number;
  mediaId: string | null;
}

interface DownloadView {
  title: string;
  sourceUrl: string;
  durationSec: number;
  width: number;
  height: number;
  sizeBytes: number;
  frames: DownloadFrameView[];
  skippedMoments: { momentSec: number }[];
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function downloadView(output: unknown): DownloadView | null {
  const value = record(output);
  if (value === null || typeof value.videoPath !== "string" || typeof value.title !== "string") return null;
  const frames = Array.isArray(value.frames)
    ? value.frames.flatMap((item) => {
      const frame = record(item);
      if (frame === null || typeof frame.path !== "string" || typeof frame.momentSec !== "number") return [];
      return [{
        path: frame.path,
        momentSec: frame.momentSec,
        mediaId: typeof frame.mediaId === "string" ? frame.mediaId : null,
      }];
    })
    : [];
  const skipped = Array.isArray(value.skippedMoments)
    ? value.skippedMoments.flatMap((item) => {
      const moment = record(item);
      if (moment === null || typeof moment.momentSec !== "number") return [];
      return [{ momentSec: moment.momentSec }];
    })
    : [];
  return {
    title: value.title,
    sourceUrl: typeof value.sourceUrl === "string" ? value.sourceUrl : "",
    durationSec: typeof value.durationSec === "number" ? value.durationSec : 0,
    width: typeof value.width === "number" ? value.width : 0,
    height: typeof value.height === "number" ? value.height : 0,
    sizeBytes: typeof value.sizeBytes === "number" ? value.sizeBytes : 0,
    frames,
    skippedMoments: skipped,
  };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "видео";
  }
}

function phaseOf(part: ToolCardProps["part"]): string | null {
  if (part.state === "output-available" && part.partial === true) {
    const output = record(part.output);
    if (output !== null && typeof output.phase === "string" && PHASES.has(output.phase)) return output.phase;
  }
  const label = part.toolMetadata?.eve?.label;
  return label !== undefined && PHASES.has(label) ? label : null;
}

function RunningCard({ part }: { part: ToolCardProps["part"] }) {
  const input = record(part.input);
  const host = typeof input?.url === "string" ? hostOf(input.url) : "видео";
  const phase = phaseOf(part);
  return (
    <TraceLine status="running">
      <TraceIcon>
        <DownloadIcon />
      </TraceIcon>
      <TraceTitle>{`Скачивание видео: ${host}`}</TraceTitle>
      {phase !== null ? <TraceDescription>{phase}</TraceDescription> : null}
    </TraceLine>
  );
}

function ReadyCard({ view }: { view: DownloadView }) {
  const source = safeHttpUrl(view.sourceUrl);
  const host = source === null ? hostOf(view.sourceUrl) : new URL(source).host;
  const meta = [
    host,
    formatClock(view.durationSec),
    `${view.width}×${view.height}`,
    formatMediaSize(view.sizeBytes),
  ].join(" · ");
  const skipped = view.skippedMoments.map((moment) => formatClock(moment.momentSec)).join(", ");
  return (
    <TraceCollapsible defaultOpen>
      <TraceCollapsibleTrigger className="w-full">
        <TraceLine className="w-full">
          <TraceIcon>
            <DownloadIcon />
          </TraceIcon>
          <TraceTitle className="line-clamp-2 whitespace-normal" title={view.title}>
            {view.title}
          </TraceTitle>
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent className="flex min-w-0 max-w-full flex-col gap-2">
        <p className="min-w-0 text-sm text-muted-foreground">{meta}</p>
        {source !== null ? (
          <a className="w-fit text-sm underline" href={source} rel="noopener noreferrer" target="_blank">
            Источник
          </a>
        ) : null}
        <div className="grid min-w-0 max-w-full grid-cols-2 gap-2">
          {view.frames.map((frame) => (
            <FrameThumbnail key={frame.path} label={formatClock(frame.momentSec)} mediaId={frame.mediaId} />
          ))}
        </div>
        {skipped.length > 0 ? <p className="text-sm text-muted-foreground">{`Нет кадров для моментов: ${skipped}`}</p> : null}
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}

/** Карточка `download_video`: фаза, название, кадры. Имя инструмента и JSON не показываются. */
export function DownloadVideoCard({ part }: ToolCardProps) {
  if (part.state === "output-error") {
    return (
      <TraceCollapsible defaultOpen>
        <TraceCollapsibleTrigger className="w-full">
          <TraceLine className="w-full" status="error">
            <TraceIcon>
              <DownloadIcon />
            </TraceIcon>
            <TraceTitle>Скачивание видео</TraceTitle>
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

  if (part.state === "output-available" && part.partial !== true) {
    const view = downloadView(part.output);
    if (view !== null) return <ReadyCard view={view} />;
  }

  return <RunningCard part={part} />;
}
