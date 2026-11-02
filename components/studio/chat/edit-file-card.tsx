"use client";

import {
  ChevronDownIcon,
  ChevronUpIcon,
  FilePlus2Icon,
  FilePenLineIcon,
  FileWarningIcon,
} from "lucide-react";
import { useState } from "react";

import type { ToolCardProps } from "@/components/studio/chat/tool-card";
import { Button } from "@/components/ui/button";
import {
  CodeBlock,
  CodeBlockContent,
  CodeBlockLine,
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
import {
  buildDiffRows,
  DIFF_PREVIEW_LINES,
  isDiffTooLarge,
  type DiffRow,
} from "@/lib/edit-file/diff-view";

interface EditFileOutput {
  readonly path?: string;
  readonly created?: boolean;
  readonly oldContent?: string | null;
  readonly newContent?: string;
  readonly linesAdded?: number;
  readonly linesRemoved?: number;
}

function inputPath(input: unknown): string {
  if (typeof input === "object" && input !== null && "filePath" in input) {
    const value = input.filePath;
    if (typeof value === "string") return value;
  }
  return "";
}

function asOutput(value: unknown): EditFileOutput | null {
  return typeof value === "object" && value !== null ? (value as EditFileOutput) : null;
}

function fileTitle(path: string): { directory: string; name: string } {
  if (path.length === 0) return { directory: "", name: "файл" };
  const normalized = path.replaceAll("\\", "/");
  const slash = normalized.lastIndexOf("/");
  if (slash === -1) return { directory: "", name: normalized };
  const name = normalized.slice(slash + 1) || normalized;
  const directory = normalized.slice(0, slash);
  return {
    directory: directory === "" || directory === "/" ? "" : directory,
    name,
  };
}

function formatSkip(skipped: number): string {
  return `⋯ ${skipped} строк без изменений`;
}

function DiffBody({ rows, expanded }: { rows: DiffRow[]; expanded: boolean }) {
  const visible = expanded ? rows : rows.slice(0, DIFF_PREVIEW_LINES);
  return (
    <CodeBlock size="sm">
      <CodeBlockContent className="max-h-96">
        {visible.map((row, index) => {
          if (row.kind === "skip") {
            return (
              <CodeBlockLine key={`skip-${index}`}>
                {formatSkip(row.skipped)}
              </CodeBlockLine>
            );
          }
          const oldNum = row.oldLine === null ? " " : String(row.oldLine);
          const newNum = row.newLine === null ? " " : String(row.newLine);
          const text = row.text.endsWith("\n") ? row.text.slice(0, -1) : row.text;
          return (
            <CodeBlockLine
              key={`${row.kind}-${index}`}
              variant={row.kind === "context" ? "default" : row.kind}
            >
              <span className="inline-block w-8 select-none text-end text-muted-foreground tabular-nums">
                {oldNum}
              </span>
              <span className="inline-block w-8 select-none text-end text-muted-foreground tabular-nums">
                {newNum}
              </span>
              <span className="ms-3 whitespace-pre">{text.length === 0 ? "\n" : text}</span>
            </CodeBlockLine>
          );
        })}
      </CodeBlockContent>
    </CodeBlock>
  );
}

type HeaderKind = "running" | "error" | "created" | "changed";

function HeaderLine({
  path,
  kind,
  description,
}: {
  path: string;
  kind: HeaderKind;
  description: string;
}) {
  const { directory, name } = fileTitle(path);
  const Icon =
    kind === "error"
      ? FileWarningIcon
      : kind === "created"
        ? FilePlus2Icon
        : FilePenLineIcon;
  const badge =
    kind === "error"
      ? "Ошибка"
      : kind === "running"
        ? "Правка…"
        : kind === "created"
          ? "Создан"
          : "Изменён";
  const status = kind === "error" ? "error" : kind === "running" ? "running" : undefined;
  return (
    <TraceLine status={status} className="flex-wrap">
      <TraceIcon><Icon /></TraceIcon>
      <TraceTitle className="flex min-w-0 flex-1 basis-24 items-baseline gap-1.5">
        {directory.length > 0 ? (
          <span className="truncate text-muted-foreground/70">{directory}/</span>
        ) : null}
        <span className="truncate font-medium text-foreground">{name}</span>
      </TraceTitle>
      <TraceDescription>{badge}</TraceDescription>
      {description.length > 0 ? <TraceDescription>{description}</TraceDescription> : null}
    </TraceLine>
  );
}

export function EditFileCard({ part }: ToolCardProps) {
  const path = inputPath(part.input) || (part.state === "output-available"
    ? asOutput(part.output)?.path ?? ""
    : "");
  const [expanded, setExpanded] = useState(false);

  if (part.state === "output-error") {
    const error = part.errorText ?? "Ошибка правки";
    return (
      <TraceCollapsible defaultOpen>
        <TraceCollapsibleTrigger>
          <HeaderLine path={path} kind="error" description="" />
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          <CodeBlock size="sm" variant="destructive">
            <CodeBlockContent wrap className="max-h-64">{error}</CodeBlockContent>
          </CodeBlock>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    );
  }

  if (part.state !== "output-available") {
    return <HeaderLine path={path} kind="running" description="" />;
  }

  const output = asOutput(part.output);
  const resolvedPath = output?.path ?? path;
  const created = output?.created === true;
  const newContent = typeof output?.newContent === "string" ? output.newContent : "";
  const priorContent =
    output?.oldContent === null || output?.oldContent === undefined
      ? ""
      : typeof output.oldContent === "string"
        ? output.oldContent
        : "";
  const linesAdded = typeof output?.linesAdded === "number" ? output.linesAdded : 0;
  const linesRemoved = typeof output?.linesRemoved === "number" ? output.linesRemoved : 0;
  const stats = `+${linesAdded} −${linesRemoved}`;
  const tooLarge = isDiffTooLarge(priorContent, newContent);

  const line = (
    <HeaderLine
      path={resolvedPath}
      kind={created ? "created" : "changed"}
      description={stats}
    />
  );

  if (tooLarge) {
    return (
      <TraceCollapsible defaultOpen>
        <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          <TraceDescription className="text-sm">Изменение слишком большое для показа</TraceDescription>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    );
  }

  const rows = buildDiffRows(priorContent, newContent);
  const needsToggle = rows.length > DIFF_PREVIEW_LINES;

  return (
    <TraceCollapsible defaultOpen>
      <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
      <TraceCollapsibleContent className="flex flex-col gap-2">
        <DiffBody rows={rows} expanded={expanded || !needsToggle} />
        {needsToggle ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="self-start"
            aria-label={expanded ? "Свернуть" : `Показать все ${rows.length} строк`}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? <ChevronUpIcon /> : <ChevronDownIcon />}
            {expanded ? "Свернуть" : `Показать все ${rows.length} строк`}
          </Button>
        ) : null}
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}
