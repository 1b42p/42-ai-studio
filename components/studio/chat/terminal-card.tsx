"use client";

import { TerminalIcon } from "lucide-react";
import stripAnsi from "strip-ansi";

import type { ToolCardProps } from "@/components/studio/chat/tool-card";
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockHeader,
  CodeBlockTitle,
} from "@/components/ui/code-block";
import {
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@/components/ui/trace";

function outputText(value: unknown): string {
  return typeof value === "string" ? stripAnsi(value) : "";
}

function lineCount(text: string): number {
  return text.length === 0 ? 0 : text.replace(/\r?\n$/, "").split(/\r?\n/).length;
}

function TerminalOutput({
  title,
  text,
  destructive = false,
}: {
  title: string;
  text: string;
  destructive?: boolean;
}) {
  return (
    <CodeBlock size="sm" variant={destructive ? "destructive" : "default"}>
      <CodeBlockHeader>
        <CodeBlockTitle>{title}</CodeBlockTitle>
        <CodeBlockActions>
          <CodeBlockCopyButton value={text} />
        </CodeBlockActions>
      </CodeBlockHeader>
      <CodeBlockContent wrap className="max-h-64">{text}</CodeBlockContent>
    </CodeBlock>
  );
}

export function TerminalCard({ part }: ToolCardProps) {
  const input = part.input;
  const command =
    typeof input === "object" && input !== null && "command" in input && typeof input.command === "string"
      ? input.command
      : "";

  const output = part.state === "output-available" && typeof part.output === "object" && part.output !== null
    ? part.output
    : null;
  const stdout = outputText(output && "stdout" in output ? output.stdout : undefined);
  const stderr = outputText(output && "stderr" in output ? output.stderr : undefined);
  const error = part.state === "output-error" ? outputText(part.errorText) : "";
  const truncated = output !== null && "truncated" in output && output.truncated === true;
  const completed = output !== null && "status" in output && output.status === "completed";
  const background = output !== null && "status" in output && output.status === "running";
  const exitCode = output !== null && "exitCode" in output && typeof output.exitCode === "number"
    ? output.exitCode
    : undefined;
  const failed = part.state === "output-error" || (completed && exitCode !== undefined && exitCode !== 0);
  const description = part.state === "output-error"
    ? "Ошибка выполнения"
    : completed
      ? `Код ${exitCode}`
      : background
        ? "Выполняется в фоне"
        : "Выполняется…";

  const line = (
    <TraceLine status={failed ? "error" : completed ? undefined : "running"} className="flex-wrap">
      <TraceIcon><TerminalIcon /></TraceIcon>
      <TraceTitle className="flex-1 basis-24">{`$ ${command}`}</TraceTitle>
      <TraceDescription>{description}</TraceDescription>
      {truncated ? <TraceDescription>Вывод обрезан</TraceDescription> : null}
    </TraceLine>
  );

  if (stdout.length === 0 && stderr.length === 0 && error.length === 0) return line;

  return (
    <TraceCollapsible defaultOpen={lineCount(stdout) + lineCount(stderr) + lineCount(error) <= 12}>
      <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
      <TraceCollapsibleContent className="flex flex-col gap-2">
        {stdout.length > 0 ? <TerminalOutput title="Вывод" text={stdout} /> : null}
        {stderr.length > 0 ? (
          <TerminalOutput title={failed ? "Ошибки" : "Сообщения"} text={stderr} destructive={failed} />
        ) : null}
        {error.length > 0 ? <TerminalOutput title="Ошибка" text={error} destructive /> : null}
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}
