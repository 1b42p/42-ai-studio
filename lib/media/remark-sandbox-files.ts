/** Адреса файлов песочницы в Markdown → адреса компонентов Streamdown (#8). */
import type { Root } from "mdast";

import {
  resolveSandboxPath,
  SANDBOX_FILE_REJECTED_URL,
  sandboxFileUrl,
} from "./sandbox-path";

interface MarkdownNode {
  type: string;
  url?: string;
  children?: readonly MarkdownNode[];
}

function walk(node: MarkdownNode, visit: (node: MarkdownNode) => void): void {
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

/**
 * Remark-плагин до `remark-rehype`: файл песочницы получает адрес
 * `/__sandbox-file/<путь>`, отвергнутый — `/__sandbox-file-rejected`.
 * Остальные адреса не трогаются.
 */
export function remarkSandboxFiles() {
  return (tree: Root) => {
    walk(tree as unknown as MarkdownNode, (node) => {
      if (
        (node.type === "link" || node.type === "image" || node.type === "definition") &&
        typeof node.url === "string"
      ) {
        const result = resolveSandboxPath(node.url);
        if (result.kind === "file") {
          node.url = sandboxFileUrl(result.path);
        } else if (result.kind === "rejected") {
          node.url = SANDBOX_FILE_REJECTED_URL;
        }
      }
    });
  };
}
