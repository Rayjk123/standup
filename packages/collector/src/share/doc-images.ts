/**
 * The image sources a markdown doc's body writes, as a renderer reads them:
 * inline images (`![alt](src "title")`, `![alt](<src with spaces>)`) and
 * reference images (`![alt][label]`, `![label][]`, `![label]`) through their
 * `[label]: src` definitions. Fenced code blocks and inline code spans are
 * left out, as they render as text, and so is raw HTML (`<img src>`), which
 * the doc renderers don't render. A definition only a link uses is not an
 * image source.
 *
 * Every step is a single pass over the body, with bounded lookahead: a
 * bracket closes within its paragraph and LABEL_MAX characters, a
 * destination ends within DESTINATION_MAX characters on its line, and at
 * most IMAGE_REFS_MAX image references are looked at. A hostile body costs
 * time linear in its length.
 */

/** The longest label (alt text or reference) looked at, as markdown caps a link label. */
const LABEL_MAX = 999;
/** The longest destination looked at. */
const DESTINATION_MAX = 2048;
/** How many image references (`![…]` with a closing bracket) one body is read for. */
export const IMAGE_REFS_MAX = 1000;

/** Backslash escapes of ASCII punctuation, which markdown drops from a URL. */
function unescapeMarkdown(text: string): string {
  return text.replace(/\\([!-/:-@[-`{-~])/g, "$1");
}

/** A reference label as markdown matches it: case-folded, inner whitespace collapsed. */
function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, " ").toLowerCase();
}

/** `body` with fenced code blocks blanked out (line count kept). */
function withoutFences(body: string): string {
  const lines = body.split("\n");
  let fence: { char: string; length: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (close && close[1]![0] === fence.char && close[1]!.length >= fence.length) fence = null;
      lines[i] = "";
    } else if (open && !(open[1]![0] === "`" && line.slice(open.index + open[0].length).includes("`"))) {
      fence = { char: open[1]![0]!, length: open[1]!.length };
      lines[i] = "";
    }
  }
  return lines.join("\n");
}

/** The first index in the ascending `list` greater than `after`, or -1. */
function firstAfter(list: readonly number[], after: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid]! > after) hi = mid;
    else lo = mid + 1;
  }
  return lo < list.length ? list[lo]! : -1;
}

/**
 * `text` with inline code spans (a backtick run up to the next run of exactly
 * the same length) blanked out. The backtick runs are found in one pass and
 * indexed by length, so each opener finds its closer by a binary search.
 */
function withoutCodeSpans(text: string): string {
  // Every maximal run of backticks: where it starts and how long it is.
  const runStart: number[] = [];
  const runLength: number[] = [];
  for (let i = 0; i < text.length; ) {
    if (text[i] !== "`") {
      i++;
      continue;
    }
    let j = i;
    while (text[j] === "`") j++;
    runStart.push(i);
    runLength.push(j - i);
    i = j;
  }
  if (runStart.length === 0) return text;
  // The start of every maximal run, by its length.
  const byLength = new Map<number, number[]>();
  for (let r = 0; r < runStart.length; r++) {
    const list = byLength.get(runLength[r]!);
    if (list) list.push(runStart[r]!);
    else byLength.set(runLength[r]!, [runStart[r]!]);
  }

  const out: string[] = [];
  let copied = 0;
  let run = 0;
  for (let i = 0; i < text.length; ) {
    if (text[i] === "\\") {
      i += 2;
      continue;
    }
    if (text[i] !== "`") {
      i++;
      continue;
    }
    // The run holding i (it may start mid-run, after an escaped backtick).
    while (runStart[run]! + runLength[run]! <= i) run++;
    const end = runStart[run]! + runLength[run]!;
    const length = end - i;
    const close = firstAfter(byLength.get(length) ?? [], i);
    if (close === -1) {
      i = end;
      continue;
    }
    out.push(text.slice(copied, i), text.slice(i, close + length).replace(/[^\n]/g, " "));
    copied = close + length;
    i = copied;
  }
  out.push(text.slice(copied));
  return out.join("");
}

/**
 * For each `[`, the index just past the `]` closing it (nested brackets
 * balanced, backslash escapes honored, never across a blank line), or -1;
 * found for every bracket in one pass with a stack.
 */
function closingBrackets(text: string): Int32Array {
  const close = new Int32Array(text.length).fill(-1);
  const open: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") i++;
    else if (ch === "[") open.push(i);
    else if (ch === "]") {
      const at = open.pop();
      if (at !== undefined && i - at <= LABEL_MAX + 1) close[at] = i + 1;
    } else if (ch === "\n" && text[i + 1] === "\n") open.length = 0;
  }
  return close;
}

/** The destination of an inline link starting just after its `(`, or null when it isn't one. */
function inlineDestination(text: string, start: number): string | null {
  let i = start;
  while (i < text.length && i - start < DESTINATION_MAX && (text[i] === " " || text[i] === "\t" || text[i] === "\n")) i++;
  const limit = Math.min(text.length, i + DESTINATION_MAX);
  if (text[i] === "<") {
    for (let j = i + 1; j < limit; j++) {
      if (text[j] === "\n" || text[j] === "<") return null;
      if (text[j] === "\\") {
        j++;
        continue;
      }
      if (text[j] === ">") return unescapeMarkdown(text.slice(i + 1, j));
    }
    return null;
  }
  let depth = 0;
  let j = i;
  for (; j < limit; j++) {
    const ch = text[j]!;
    if (ch === "\\") {
      j++;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") break;
    if (ch === "(") depth++;
    else if (ch === ")") {
      if (depth === 0) break;
      depth--;
    }
  }
  // A destination that runs past the cap is not one this reader resolves.
  if (j >= limit && limit < text.length) return null;
  return j > i ? unescapeMarkdown(text.slice(i, Math.min(j, text.length))) : null;
}

/** `[label]: destination` definitions, by normalized label (the first of each wins, as markdown has it). */
function referenceDefinitions(text: string): Map<string, string> {
  const defs = new Map<string, string>();
  const lines = text.split("\n");
  const head = /^ {0,3}\[((?:[^\]\\\n]|\\.){1,999})\]:[ \t]*(.*)$/;
  for (let i = 0; i < lines.length; i++) {
    const m = head.exec(lines[i]!);
    if (!m) continue;
    // The destination may be on the next line.
    let rest = m[2]!.trim();
    if (rest === "" && i + 1 < lines.length) rest = lines[i + 1]!.trim();
    const dest = /^(<[^>]*>|\S+)/.exec(rest)?.[1];
    const label = normalizeLabel(m[1]!);
    if (!dest || !label || defs.has(label)) continue;
    const angled = dest.length >= 2 && dest.startsWith("<") && dest.endsWith(">");
    defs.set(label, unescapeMarkdown(angled ? dest.slice(1, -1) : dest));
  }
  return defs;
}

/** Every distinct image source the body writes, in order of first appearance. */
export function docImageSources(body: string): string[] {
  const text = withoutCodeSpans(withoutFences(body));
  const close = closingBrackets(text);
  const defs = referenceDefinitions(text);
  const found = new Set<string>();

  let refs = 0;
  for (let i = text.indexOf("!["); i !== -1 && refs < IMAGE_REFS_MAX; i = text.indexOf("![", i + 1)) {
    if (i > 0 && text[i - 1] === "\\") continue;
    const end = close[i + 1]!;
    if (end === -1) continue;
    refs++;
    if (text[end] === "(") {
      const dest = inlineDestination(text, end + 1);
      if (dest) found.add(dest);
      continue;
    }
    let label = text.slice(i + 2, end - 1);
    if (text[end] === "[") {
      const refEnd = close[end]!;
      if (refEnd !== -1) {
        const explicit = text.slice(end + 1, refEnd - 1);
        if (explicit.trim()) label = explicit;
      }
    }
    const dest = defs.get(normalizeLabel(label));
    if (dest) found.add(dest);
  }
  return [...found];
}
