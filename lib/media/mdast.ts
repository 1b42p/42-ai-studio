/** Обход дерева Markdown (mdast) без внешних зависимостей. */
export interface MarkdownNode {
  readonly type: string;
  url?: string;
  readonly identifier?: string;
  readonly children?: readonly MarkdownNode[];
}

export function walkMarkdown(
  node: MarkdownNode,
  visit: (node: MarkdownNode) => void,
): void {
  visit(node);
  for (const child of node.children ?? []) walkMarkdown(child, visit);
}
