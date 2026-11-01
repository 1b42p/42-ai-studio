"use client";

import { harden } from "rehype-harden";
import { isValidElement, type ReactNode } from "react";
import { Streamdown, defaultRehypePlugins, type Components } from "streamdown";
import type { PluggableList } from "unified";

import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockHeader,
  CodeBlockTitle,
} from "@/components/ui/code-block";

/**
 * Ограничения Markdown ответа. Удалённые изображения блокируются: картинка
 * из ответа модели может быть каналом утечки. Протоколы ссылок ограничиваются
 * настолько, насколько позволяет `rehype-harden`: его список только дополняет
 * встроенный набор (`https:`, `http:`, `irc:`, `ircs:`, `mailto:`, `xmpp:`,
 * `blob:`), поэтому `tel:` и `ftp:` закрыты, а `http:` и `blob:` — нет.
 */
const rehypePlugins: PluggableList = [
  defaultRehypePlugins.raw as PluggableList[number],
  defaultRehypePlugins.sanitize as PluggableList[number],
  [
    harden,
    {
      allowedLinkPrefixes: ["*"],
      allowedImagePrefixes: [],
      allowDataImages: false,
    },
  ],
];

/** Текст из React-узла: нужен для копирования блока кода. */
function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return "";
}

/** Язык блока кода из класса `language-…` на вложенном `<code>`. */
function languageOf(node: ReactNode): string | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const language = languageOf(child);
      if (language !== undefined) return language;
    }
    return undefined;
  }
  if (!isValidElement<{ children?: ReactNode; className?: string }>(node)) return undefined;

  const match = /language-([\w-]+)/.exec(node.props.className ?? "");
  if (match?.[1] !== undefined) return match[1];
  return languageOf(node.props.children);
}

/**
 * Блоки кода рисует `CodeBlock` с кнопкой копирования, а не голый `<pre>`
 * Streamdown. Инлайновый код остаётся на усмотрение Streamdown.
 */
const components: Components = {
  pre: ({ children }) => {
    const text = textOf(children);
    const language = languageOf(children);

    return (
      <CodeBlock className="my-2">
        <CodeBlockHeader>
          <CodeBlockTitle>{language ?? "Код"}</CodeBlockTitle>
          <CodeBlockActions>
            <CodeBlockCopyButton value={text} />
          </CodeBlockActions>
        </CodeBlockHeader>
        <CodeBlockContent>{text}</CodeBlockContent>
      </CodeBlock>
    );
  },
};

export function ChatMarkdown({
  text,
  streaming = false,
}: {
  text: string;
  streaming?: boolean;
}) {
  return (
    <Streamdown
      className="w-full min-w-0 text-sm leading-relaxed break-words"
      components={components}
      rehypePlugins={rehypePlugins}
      caret={streaming ? "block" : undefined}
      isAnimating={streaming}
    >
      {text}
    </Streamdown>
  );
}
