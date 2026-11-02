/**
 * Ссылки на файлы песочницы в ответе агента (#8).
 *
 * Одна чистая функция используется и сервером (копирование файла в S3), и
 * браузером (отрисовка), поэтому проверки не расходятся. Вход — сырой `url`
 * узла Markdown (mdast), а не `href` после `remark-rehype`: нормализация URI и
 * `rehype-harden` меняют адреса.
 *
 * Файлом песочницы считается только то, что после нормализации лежит строго
 * внутри `/workspace/`. Относительные пути считаются от `/workspace`.
 */
import type { Root } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

/** Причина отказа: путь не является файлом внутри рабочей области. */
export type SandboxPathReason = "outside_workspace";

/** Результат разбора одного адреса. */
export type SandboxPathResult =
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "rejected"; readonly path: string; readonly reason: SandboxPathReason }
  | { readonly kind: "external" };

/** Ссылка на файл песочницы, найденная в Markdown. */
export type SandboxLink = Exclude<SandboxPathResult, { readonly kind: "external" }>;

/** Префикс адреса, которым remark-плагин помечает файл песочницы. */
export const SANDBOX_FILE_PREFIX = "/__sandbox-file/";

/** Адрес отвергнутой ссылки: компонент показывает «Файл не найден». */
export const SANDBOX_FILE_REJECTED_URL = "/__sandbox-file-rejected";

/** Адрес файла для `components` Streamdown: путь кодируется целиком. */
export function sandboxFileUrl(path: string): string {
  return `${SANDBOX_FILE_PREFIX}${encodeURIComponent(path)}`;
}

/** Путь из адреса компонента или `null`, если это не файл песочницы. */
export function sandboxFilePath(url: string | undefined): string | null {
  if (url === undefined || !url.startsWith(SANDBOX_FILE_PREFIX)) return null;
  try {
    return decodeURIComponent(url.slice(SANDBOX_FILE_PREFIX.length));
  } catch {
    return null;
  }
}

/** Управляющие символы, которые недопустимы в пути. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/** Процентная кодировка с ошибкой: одиночный `%` или неполная пара. */
const BROKEN_PERCENT = /%(?![0-9a-fA-F]{2})/;

/** Схема адреса (`https:`, `mailto:`, `data:`, `file:`). */
const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

function hasUnsafeCharacters(value: string): boolean {
  return (
    value.includes("\0") ||
    value.includes("\\") ||
    CONTROL_CHARACTERS.test(value)
  );
}

/** Нормализация POSIX-пути без `node:path`: модуль работает и в браузере. */
function normalizePosix(input: string): string {
  const segments: string[] = [];
  for (const segment of input.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return `/${segments.join("/")}`;
}

function rejected(path: string): SandboxPathResult {
  return { kind: "rejected", path, reason: "outside_workspace" };
}

/**
 * Разбирает один адрес: файл песочницы, отвергнутый путь или обычная ссылка.
 * Запрос и фрагмент отбрасываются, процентное кодирование раскрывается один раз.
 */
export function resolveSandboxPath(rawUrl: string): SandboxPathResult {
  if (typeof rawUrl !== "string" || rawUrl.length === 0) return { kind: "external" };

  let value = rawUrl;
  const hash = value.indexOf("#");
  if (hash !== -1) value = value.slice(0, hash);
  const query = value.indexOf("?");
  if (query !== -1) value = value.slice(0, query);
  if (value.length === 0) return { kind: "external" };

  // Схема и адрес от чужого хоста — обычные ссылки, их не трогаем.
  if (SCHEME.test(value) || value.startsWith("//")) return { kind: "external" };

  if (hasUnsafeCharacters(value) || BROKEN_PERCENT.test(value)) return rejected(value);

  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return rejected(value);
  }
  // Раскрытие один раз: `%25` даёт настоящий `%`, и это уже не ошибка.
  if (hasUnsafeCharacters(decoded)) return rejected(value);

  const absolute = decoded.startsWith("/") ? decoded : `/workspace/${decoded}`;
  const normalized = normalizePosix(absolute);
  if (normalized === "/workspace" || !normalized.startsWith("/workspace/")) {
    return rejected(normalized);
  }
  return { kind: "file", path: normalized };
}

interface MarkdownNode {
  readonly type: string;
  readonly url?: string;
  readonly identifier?: string;
  readonly children?: readonly MarkdownNode[];
}

function walk(node: MarkdownNode, visit: (node: MarkdownNode) => void): void {
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

/**
 * Адреса файлов песочницы из Markdown: ссылки, картинки, определения и
 * ссылки-определения. Уникальные пути в порядке появления; обычные ссылки
 * (со схемой или от чужого хоста) пропускаются.
 */
export function parseSandboxLinks(markdown: string): SandboxLink[] {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown) as Root;

  const definitions = new Map<string, string>();
  walk(tree as unknown as MarkdownNode, (node) => {
    if (node.type === "definition" && typeof node.url === "string") {
      definitions.set(node.identifier ?? "", node.url);
    }
  });

  const links: SandboxLink[] = [];
  const seen = new Set<string>();
  const collect = (url: string | undefined) => {
    if (url === undefined) return;
    const result = resolveSandboxPath(url);
    if (result.kind === "external" || seen.has(result.path)) return;
    seen.add(result.path);
    links.push(result);
  };

  walk(tree as unknown as MarkdownNode, (node) => {
    switch (node.type) {
      case "link":
      case "image":
      case "definition":
        collect(node.url);
        break;
      case "linkReference":
      case "imageReference":
        collect(definitions.get(node.identifier ?? ""));
        break;
      default:
        break;
    }
  });

  return links;
}
