"use client";

import { FileTextIcon } from "lucide-react";

import type { ToolCardProps } from "@/components/studio/chat/tool-card";
import { WebToolError, WebToolSource, webToolOutput, webToolUrl } from "@/components/studio/chat/web-tool-card";
import { TraceIcon, TraceLine, TraceTitle } from "@/components/ui/trace";

const characterCount = new Intl.NumberFormat("ru-RU");

export function ReadPageCard({ part }: ToolCardProps) {
  if (part.state === "output-error" || part.state === "output-denied") {
    return (
      <WebToolError
        title="Не удалось прочитать страницу"
        icon={FileTextIcon}
        error={part.state === "output-error" ? part.errorText || "Страница сейчас недоступна." : "Чтение страницы отклонено."}
      />
    );
  }

  const output = part.state === "output-available" ? webToolOutput(part.output) : null;
  if (output !== null && typeof output.content === "string") {
    // Конечный адрес важнее исходного; небезопасный конечный адрес не заменяем исходным.
    const url = webToolUrl(output.finalUrl ?? output.url);
    const host = url?.hostname ?? (typeof output.host === "string" ? output.host : "Страница");
    const title = typeof output.title === "string" && output.title.trim().length > 0 ? output.title : host;
    const partial = typeof output.nextOffset === "number";
    const description = `${characterCount.format(output.content.length)} знаков${partial ? ", прочитана часть страницы" : ""}`;

    return <WebToolSource url={url} title={title} description={description} />;
  }

  if (part.state === "output-available") {
    return <WebToolError title="Не удалось прочитать страницу" icon={FileTextIcon} error="Результат чтения недоступен." />;
  }

  return (
    <TraceLine status="running">
      <TraceIcon><FileTextIcon /></TraceIcon>
      <TraceTitle>{part.toolMetadata?.eve?.label ?? "Чтение страницы"}</TraceTitle>
    </TraceLine>
  );
}
