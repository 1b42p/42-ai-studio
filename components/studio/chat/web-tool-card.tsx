"use client";

import { ArrowUpRightIcon, GlobeIcon, type LucideIcon } from "lucide-react";

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

/** Веб-карточки не превращают произвольные схемы из результата в ссылки. */
export function webToolUrl(value: unknown): URL | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

export function webToolOutput(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}

export function WebToolError({
  title,
  error,
  icon: Icon,
}: {
  title: string;
  error: string;
  icon: LucideIcon;
}) {
  const message = error
    .replace(/^(?:Error:\s*)?(?:web_search|read_page)_[a-z_]+:\s*/, "")
    .replace(/\bweb_search\b/g, "поиск в интернете")
    .replace(/\bread_page\b/g, "чтение страницы")
    .replace(/\bdownload_video\b/g, "скачивание видео");

  return (
    <TraceCollapsible defaultOpen>
      <TraceCollapsibleTrigger>
        <TraceLine status="error">
          <TraceIcon><Icon /></TraceIcon>
          <TraceTitle>{title}</TraceTitle>
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent>
        <CodeBlock size="sm" variant="destructive">
          <CodeBlockContent className="max-h-64" wrap>{message}</CodeBlockContent>
        </CodeBlock>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}

/** Источник — ссылка вокруг строки; небезопасный адрес оставляет обычную строку. */
export function WebToolSource({
  url,
  title,
  description,
}: {
  url: URL | null;
  title: string;
  description: string;
}) {
  const line = (
    <TraceLine>
      <TraceIcon><GlobeIcon /></TraceIcon>
      <TraceTitle>
        {title}
        {url === null ? null : <span className="sr-only"> (откроется в новой вкладке)</span>}
      </TraceTitle>
      <TraceDescription className="min-w-0 max-w-1/2 shrink truncate">{description}</TraceDescription>
      {url === null ? null : <TraceIcon><ArrowUpRightIcon /></TraceIcon>}
    </TraceLine>
  );

  return url === null ? line : (
    <a href={url.href} rel="noopener noreferrer" target="_blank">{line}</a>
  );
}
