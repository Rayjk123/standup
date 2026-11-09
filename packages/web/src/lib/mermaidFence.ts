/*
 * Telling a ```mermaid fence from any other code block in react-markdown's
 * output. This is all the markdown renderer needs up front; drawing the
 * diagram (lib/mermaid.ts and Mermaid itself) loads only once a doc has one.
 * It imports nothing so that it stays inside the renderer's own chunk, which
 * every page loads at boot; a module shared with lib/mermaid.ts would become
 * a chunk of its own and one more request on every first load.
 */

/** The shape of a hast node as react-markdown hands it to an element renderer. */
export interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: { className?: unknown };
  children?: HastNode[];
}

function textOf(node: HastNode): string {
  return node.type === "text" ? (node.value ?? "") : (node.children ?? []).map(textOf).join("");
}

/**
 * The diagram source of a fenced code block, given its `<pre>`'s hast node,
 * when the fence is ```mermaid (as lib/mermaid.ts's isMermaidLanguage reads
 * a language); undefined for any other block.
 */
export function mermaidFenceSource(pre: HastNode | undefined): string | undefined {
  const code = pre?.children?.find((child) => child.type === "element");
  if (code?.tagName !== "code") return undefined;
  const classes = code.properties?.className;
  const names = Array.isArray(classes) ? classes : typeof classes === "string" ? classes.split(/\s+/) : [];
  const isMermaid = names.some((name) => typeof name === "string" && name.toLowerCase() === "language-mermaid");
  return isMermaid ? textOf(code).replace(/\n$/, "") : undefined;
}
