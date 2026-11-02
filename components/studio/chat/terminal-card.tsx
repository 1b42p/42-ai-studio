"use client";

import { TerminalIcon } from "lucide-react";
import stripAnsi from "strip-ansi";
import { useEffect, useRef } from "react";

import type { ToolCardProps } from "@/components/studio/chat/tool-card";
import { useBashJob, type BashJobPoll } from "@/components/studio/chat/use-bash-job";
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
import { jobIdFromDirectory } from "@/lib/sandbox/job-types";

function outputText(value: unknown): string {
  return typeof value === "string" ? stripAnsi(value) : "";
}

function lineCount(text: string): number {
  return text.length === 0 ? 0 : text.replace(/\r?\n$/, "").split(/\r?\n/).length;
}

function describeJob(options: {
  outputError: boolean;
  completed: boolean;
  exitCode: number | undefined;
  interrupted: boolean;
  pollKind: BashJobPoll["kind"];
  background: boolean;
}): string {
  if (options.outputError) return "Ошибка выполнения";
  if (options.completed) {
    return options.exitCode === undefined || options.exitCode === null
      ? "Завершено"
      : `Код ${options.exitCode}`;
  }
  if (options.interrupted) return "Выполнение прервано: песочница была остановлена";
  if (options.pollKind === "unauthorized") return "Войдите снова";
  if (options.pollKind === "not_found") return "Задание недоступно";
  return options.background ? "Выполняется в фоне" : "Выполняется…";
}

function TerminalOutput({
  title,
  text,
  destructive = false,
  follow = false,
}: {
  title: string;
  text: string;
  destructive?: boolean;
  follow?: boolean;
}) {
  const scroller = useRef<HTMLPreElement>(null);
  const pinned = useRef(true);

  useEffect(() => {
    const node = scroller.current;
    if (node === null || !follow || !pinned.current) return;
    node.scrollTop = node.scrollHeight;
  }, [text, follow]);

  return (
    <CodeBlock size="sm" variant={destructive ? "destructive" : "default"}>
      <CodeBlockHeader>
        <CodeBlockTitle>{title}</CodeBlockTitle>
        <CodeBlockActions>
          <CodeBlockCopyButton value={text} />
        </CodeBlockActions>
      </CodeBlockHeader>
      <CodeBlockContent
        onScroll={(event) => {
          const node = event.currentTarget;
          pinned.current =
            node.scrollHeight - node.scrollTop - node.clientHeight < 8;
        }}
        ref={scroller}
        wrap
        className="max-h-64"
      >
        {text}
      </CodeBlockContent>
    </CodeBlock>
  );
}

export function TerminalCard({ part, appSessionId }: ToolCardProps) {
  const input = part.input;
  const command =
    typeof input === "object" && input !== null && "command" in input && typeof input.command === "string"
      ? input.command
      : "";

  const output = part.state === "output-available" && typeof part.output === "object" && part.output !== null
    ? part.output
    : null;
  const baseStdout = outputText(output && "stdout" in output ? output.stdout : undefined);
  const baseStderr = outputText(output && "stderr" in output ? output.stderr : undefined);
  const error = part.state === "output-error" ? outputText(part.errorText) : "";
  const baseTruncated = output !== null && "truncated" in output && output.truncated === true;
  const baseStatus = output !== null && "status" in output ? output.status : undefined;
  const baseExitCode = output !== null && "exitCode" in output && typeof output.exitCode === "number"
    ? output.exitCode
    : undefined;

  const jobId = jobIdFromDirectory(
    output !== null && "outputDirectory" in output ? output.outputDirectory : undefined,
  );
  const poll = useBashJob(appSessionId, jobId);
  const job = poll.job;

  const status = job?.status ?? (baseStatus === "running" ? "running" : baseStatus === "completed" ? "completed" : undefined);
  const stdout = job !== null && job.stdout.length > 0 ? outputText(job.stdout) : baseStdout;
  const stderr = job !== null && job.stderr.length > 0 ? outputText(job.stderr) : baseStderr;
  const truncated = job !== null ? job.truncated : baseTruncated;
  const exitCode = job?.exitCode ?? baseExitCode;
  const completed = status === "completed";
  const background = status === "running";
  const interrupted = status === "interrupted";
  const retrying =
    poll.failures >= 5 && (poll.kind === "pending" || poll.kind === "data");
  const failed = part.state === "output-error" || (completed && exitCode !== undefined && exitCode !== 0);
  const finished =
    completed ||
    interrupted ||
    poll.kind === "unauthorized" ||
    poll.kind === "not_found";

  const description = describeJob({
    outputError: part.state === "output-error",
    completed,
    exitCode,
    interrupted,
    pollKind: poll.kind,
    background,
  });

  const truncatedLabel = job !== null ? "Показан конец вывода, последние 64 КиБ" : "Вывод обрезан";

  const line = (
    <TraceLine status={failed ? "error" : finished ? undefined : "running"} className="flex-wrap">
      <TraceIcon><TerminalIcon /></TraceIcon>
      <TraceTitle className="flex-1 basis-24">{`$ ${command}`}</TraceTitle>
      <TraceDescription>{description}</TraceDescription>
      {truncated ? <TraceDescription>{truncatedLabel}</TraceDescription> : null}
    </TraceLine>
  );

  if (stdout.length === 0 && stderr.length === 0 && error.length === 0 && !retrying) return line;

  return (
    <TraceCollapsible defaultOpen={background || lineCount(stdout) + lineCount(stderr) + lineCount(error) <= 12}>
      <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
      <TraceCollapsibleContent className="flex flex-col gap-2">
        {stdout.length > 0 ? (
          <TerminalOutput follow={background} title="Вывод" text={stdout} />
        ) : null}
        {stderr.length > 0 ? (
          <TerminalOutput
            destructive={failed}
            follow={background}
            title={failed ? "Ошибки" : "Сообщения"}
            text={stderr}
          />
        ) : null}
        {error.length > 0 ? <TerminalOutput title="Ошибка" text={error} destructive /> : null}
        {retrying ? <TraceDescription>Нет связи, повторяем…</TraceDescription> : null}
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}
