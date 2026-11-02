"use client";

import { harden } from "rehype-harden";
import remarkGfm from "remark-gfm";
import { createContext, isValidElement, useContext, type ReactNode } from "react";
import { Streamdown, defaultComponents, defaultRehypePlugins, type Components } from "streamdown";
import type { PluggableList } from "unified";

import { SandboxFile, type SandboxFileResolver } from "@/components/studio/media/sandbox-file";
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockHeader,
  CodeBlockTitle,
} from "@/components/ui/code-block";
import { remarkSandboxFiles } from "@/lib/media/remark-sandbox-files";
import {
  sandboxFilePath,
  SANDBOX_FILE_PREFIX,
  SANDBOX_FILE_REJECTED_URL,
} from "@/lib/media/sandbox-path";

/**
 * Ограничения Markdown ответа. Удалённые изображения блокируются: картинка
 * из ответа модели может быть каналом утечки. Протоколы ссылок ограничиваются
 * настолько, насколько позволяет `rehype-harden`: его список только дополняет
 * встроенный набор (`https:`, `http:`, `irc:`, `ircs:`, `mailto:`, `xmpp:`,
 * `blob:`), поэтому `tel:` и `ftp:` закрыты, а `http:` и `blob:` — нет.
 * Изображения разрешены только по адресам файлов песочницы; список конкретных
 * префиксов требует `defaultOrigin`, хотя адреса относительные.
 */
const rehypePlugins: PluggableList = [
  defaultRehypePlugins.raw as PluggableList[number],
  defaultRehypePlugins.sanitize as PluggableList[number],
  [
    harden,
    {
      allowedLinkPrefixes: ["*"],
      allowedImagePrefixes: [SANDBOX_FILE_PREFIX, SANDBOX_FILE_REJECTED_URL],
      defaultOrigin: "http://localhost",
      allowDataImages: false,
    },
  ],
];

/**
 * GFM и плагин файлов песочницы. Плагин стоит до `remark-rehype`, поэтому
 * видит тот же сырой `url`, что и сервер.
 */
const remarkPlugins: PluggableList = [
  remarkGfm as PluggableList[number],
  remarkSandboxFiles as PluggableList[number],
];

/** Как разрешать файлы для конкретного текстового блока сообщения. */
const SandboxFileContext = createContext<SandboxFileResolver>({ kind: "unavailable" });

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

const DefaultLink = defaultComponents.a!;
const DefaultImage = defaultComponents.img!;

function isSandboxFileUrl(url: string | undefined): boolean {
  return url === SANDBOX_FILE_REJECTED_URL || sandboxFilePath(url) !== null;
}

/**
 * Компоненты стабильны между рендерами (иначе React пересоздавал бы ссылки
 * и плееры при каждом обновлении потока); разрешение файлов приходит
 * контекстом.
 */
const components: Components = {
  // Блочные карточки внутри `<p>` дали бы ошибку вложенности DOM.
  p: ({ children }) => <div className="my-2 first:mt-0 last:mb-0">{children}</div>,
  a: ({ href, children, title, ...props }) => {
    const resolver = useContext(SandboxFileContext);
    if (isSandboxFileUrl(href)) {
      const rejected = href === SANDBOX_FILE_REJECTED_URL;
      return (
        <SandboxFile
          label={textOf(children)}
          originalPath={rejected ? title : undefined}
          path={sandboxFilePath(href)}
          rejected={rejected}
          resolver={resolver}
        />
      );
    }
    // Обычные и недописанные ссылки потока — штатный обработчик Streamdown
    // с подтверждением перехода.
    return (
      <DefaultLink href={href} title={title} {...props}>
        {children}
      </DefaultLink>
    );
  },
  img: ({ src, alt, title, ...props }) => {
    const resolver = useContext(SandboxFileContext);
    if (typeof src === "string" && isSandboxFileUrl(src)) {
      const rejected = src === SANDBOX_FILE_REJECTED_URL;
      return (
        <SandboxFile
          label={alt}
          originalPath={rejected ? title : undefined}
          path={sandboxFilePath(src)}
          rejected={rejected}
          resolver={resolver}
        />
      );
    }
    return <DefaultImage alt={alt} src={src} title={title} {...props} />;
  },
  // Блоки кода рисует `CodeBlock` с кнопкой копирования, а не голый `<pre>`.
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
  resolver = { kind: "unavailable" },
}: {
  text: string;
  streaming?: boolean;
  resolver?: SandboxFileResolver;
}) {
  return (
    <SandboxFileContext.Provider value={resolver}>
      <Streamdown
        className="w-full min-w-0 text-sm leading-relaxed break-words"
        components={components}
        rehypePlugins={rehypePlugins}
        remarkPlugins={remarkPlugins}
        caret={streaming ? "block" : undefined}
        isAnimating={streaming}
      >
        {text}
      </Streamdown>
    </SandboxFileContext.Provider>
  );
}
