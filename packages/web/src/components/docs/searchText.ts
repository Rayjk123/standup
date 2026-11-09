/*
 * The Docs tab's search: the shortcut that opens it and the highlighting of
 * what matched. Matching itself is the collector's (GET /api/docs/search).
 */

/** The words of a query, lowercased: each one is highlighted wherever it appears. */
export function searchTerms(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))];
}

export interface TextPart {
  text: string;
  hit: boolean;
}

/** `text` cut into runs that match one of `terms` (case-insensitive) and runs that don't. */
export function highlightParts(text: string, terms: readonly string[]): TextPart[] {
  const lower = text.toLowerCase();
  const marked = new Array<boolean>(text.length).fill(false);
  for (const term of terms) {
    for (let at = lower.indexOf(term); at !== -1; at = lower.indexOf(term, at + term.length)) marked.fill(true, at, at + term.length);
  }
  const parts: TextPart[] = [];
  for (let i = 0; i < text.length; i++) {
    const last = parts[parts.length - 1];
    if (last && last.hit === marked[i]) last.text += text[i];
    else parts.push({ text: text[i]!, hit: marked[i]! });
  }
  return parts;
}

/** Whether a keydown is the search shortcut: Cmd+K on a Mac, Ctrl+K elsewhere (either is taken on both). */
export function isSearchShortcut(e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">): boolean {
  return (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k";
}

/** The shortcut as this platform writes it, for the search button's tooltip. */
export function searchShortcutLabel(platform = typeof navigator !== "undefined" ? navigator.platform || navigator.userAgent : ""): string {
  return /mac|iphone|ipad/i.test(platform) ? "⌘K" : "Ctrl+K";
}
