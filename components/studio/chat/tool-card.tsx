"use client";

import type { EveDynamicToolPart } from "eve/react";
import { WrenchIcon } from "lucide-react";
import type { ComponentType } from "react";

import { TerminalCard } from "@/components/studio/chat/terminal-card";
import { TraceIcon, TraceLine, TraceTitle } from "@/components/ui/trace";

export interface ToolCardProps {
  part: EveDynamicToolPart;
}

const toolCards: ReadonlyMap<string, ComponentType<ToolCardProps>> = new Map([
  ["bash", TerminalCard],
]);

function FallbackToolCard({ part }: ToolCardProps) {
  const status = part.state === "output-error"
    ? "error"
    : part.state === "output-available" || part.state === "output-denied"
      ? undefined
      : "running";

  return (
    <TraceLine status={status}>
      <TraceIcon><WrenchIcon /></TraceIcon>
      <TraceTitle>{part.toolMetadata?.eve?.label ?? "Инструмент"}</TraceTitle>
    </TraceLine>
  );
}

/** Новые карточки добавляются в сопоставление, неизвестные инструменты сохраняют подпись eve. */
export function ToolCard({ part }: ToolCardProps) {
  const Card = toolCards.get(part.toolName) ?? FallbackToolCard;
  return <Card part={part} />;
}
