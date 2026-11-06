"use client";

import type { ConversationState, EveDynamicToolPart } from "eve/react";
import { WrenchIcon } from "lucide-react";
import type { ComponentType } from "react";

import { AgentCopyCard } from "@/components/studio/chat/agent-copy-card";
import { EditFileCard } from "@/components/studio/chat/edit-file-card";
import { ReadFileCard } from "@/components/studio/chat/read-file-card";
import { ReadPageCard } from "@/components/studio/chat/read-page-card";
import { SpeakCard } from "@/components/studio/chat/speak-card";
import { TerminalCard } from "@/components/studio/chat/terminal-card";
import { WebSearchCard } from "@/components/studio/chat/web-search-card";
import { TraceIcon, TraceLine, TraceTitle } from "@/components/ui/trace";

export interface ToolCardProps {
  part: EveDynamicToolPart;
  /** Беседа: карточка копии читает задачи и сессии копий из неё. */
  data: ConversationState;
  /** Сессия приложения: карточка фоновой команды опрашивает её задание. */
  appSessionId?: string | null;
  /** Панель копии открыта/закрыта: по этому чат освобождает место справа. */
  onCopyPanelChange?: (callId: string, open: boolean) => void;
}

const toolCards: ReadonlyMap<string, ComponentType<ToolCardProps>> = new Map([
  ["bash", TerminalCard],
  ["edit_file", EditFileCard],
  ["read_file", ReadFileCard],
  ["speak", SpeakCard],
  ["web_search", WebSearchCard],
  ["read_page", ReadPageCard],
  // Встроенная копия корня приходит с `toolName: "eve:subagent:agent"`,
  // поэтому выбор карточки идёт по `toolMetadata.eve.name`.
  ["agent", AgentCopyCard],
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

/** Карточка вызова: имя инструмента берётся из метаданных eve, затем из части. */
export function ToolCard({ part, data, appSessionId, onCopyPanelChange }: ToolCardProps) {
  // У загрузки навыка `name` — имя навыка, а не инструмент: карточку не ищем.
  const name =
    part.toolMetadata?.eve?.kind === "load-skill"
      ? part.toolName
      : (part.toolMetadata?.eve?.name ?? part.toolName);
  const Card = toolCards.get(name) ?? FallbackToolCard;
  return (
    <Card
      appSessionId={appSessionId}
      data={data}
      onCopyPanelChange={onCopyPanelChange}
      part={part}
    />
  );
}
