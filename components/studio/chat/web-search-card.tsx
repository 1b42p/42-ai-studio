"use client";

import { SearchIcon } from "lucide-react";

import type { ToolCardProps } from "@/components/studio/chat/tool-card";
import { WebToolError, WebToolSource, webToolOutput, webToolUrl } from "@/components/studio/chat/web-tool-card";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@/components/ui/trace";

interface SearchResult {
  title: string;
  url: string;
  host: string;
}

function searchResult(value: unknown): value is SearchResult {
  const record = webToolOutput(value);
  return record !== null && typeof record.title === "string" && typeof record.url === "string" && typeof record.host === "string";
}

export function WebSearchCard({ part }: ToolCardProps) {
  if (part.state === "output-error" || part.state === "output-denied") {
    return (
      <WebToolError
        title="Не удалось выполнить поиск"
        icon={SearchIcon}
        error={part.state === "output-error" ? part.errorText || "Поиск сейчас недоступен." : "Выполнение поиска отклонено."}
      />
    );
  }

  const output = part.state === "output-available" ? webToolOutput(part.output) : null;
  if (output !== null && Array.isArray(output.results) && output.results.every(searchResult)) {
    const results = output.results;
    if (results.length === 0) {
      return (
        <TraceLine>
          <TraceIcon><SearchIcon /></TraceIcon>
          <TraceTitle>Ничего не найдено</TraceTitle>
        </TraceLine>
      );
    }

    return (
      <TraceCollapsible>
        <TraceCollapsibleTrigger>
          <TraceLine>
            <TraceIcon><SearchIcon /></TraceIcon>
            <TraceTitle className="shrink-0">Источники: {results.length}</TraceTitle>
            <TraceDescription className="min-w-0 shrink truncate">
              {typeof output.query === "string" ? output.query : ""}
            </TraceDescription>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          <Trace>
            {results.map((result, index) => (
              <WebToolSource
                key={`${result.url}:${index}`}
                url={webToolUrl(result.url)}
                title={result.title || result.host}
                description={result.host}
              />
            ))}
          </Trace>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    );
  }

  if (part.state === "output-available") {
    return <WebToolError title="Не удалось выполнить поиск" icon={SearchIcon} error="Результат поиска недоступен." />;
  }

  return (
    <TraceLine status="running">
      <TraceIcon><SearchIcon /></TraceIcon>
      <TraceTitle>{part.toolMetadata?.eve?.label ?? "Поиск в интернете"}</TraceTitle>
    </TraceLine>
  );
}
