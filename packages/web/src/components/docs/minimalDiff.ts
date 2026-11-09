import type { Root } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { joinFrontmatter, splitFrontmatter } from "@standup/shared";

/*
 * A save writes back only the blocks an edit changed. The editor serializes
 * the whole document in its own style (tables re-padded, `_` escaped, a
 * blank line before every list), so saving its output as it stands would
 * rewrite every block of a hand- or agent-written file on the first edit.
 * Instead the stored markdown and the editor's serialization are both split
 * into top-level blocks, the two block sequences are aligned (blocks compared
 * by their syntax trees, positions left out), and the saved text is the
 * stored source of every block that is unchanged (with the stored whitespace
 * between them) and the editor's text of every block that changed or is new.
 * The result must parse to the same blocks as the editor's serialization, or
 * the serialization is saved as it stands.
 *
 * Parsing is the cost (a large doc takes a large fraction of a second per
 * pass), so parsed blocks are cached by text, and when the caller passes the
 * editor's serialization of the stored text (`previous`) the new
 * serialization is parsed only where it differs from that one; the result is
 * then checked around each changed block rather than parsed whole. A body
 * whose top-level block starts are reparsed alone parses as it does in place
 * (markdown's block structure doesn't look back past a block start), and each
 * check takes in the unchanged block on either side of a change, which is
 * where a change could reach.
 */

const parser = unified().use(remarkParse).use(remarkGfm);

/** Bodies longer than this many characters (stored or serialized) are saved as the editor wrote them, without a block alignment. */
export const MINIMAL_DIFF_MAX_CHARS = 512 * 1024;
/** The largest alignment table built; a bigger changed middle is written as the editor wrote it. */
export const MINIMAL_DIFF_MAX_CELLS = 4_000_000;
/** Results up to this long are checked by parsing them whole; longer ones around each change. */
const WHOLE_CHECK_MAX_CHARS = 64 * 1024;
const CACHE_ENTRIES = 6;

/** A node with its positions left out and its keys in a fixed order, as text: two blocks mean the same when these match. */
function shape(node: unknown): string {
  const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(strip);
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value).sort()) {
        if (key === "position") continue;
        const v = (value as Record<string, unknown>)[key];
        if (v !== undefined) out[key] = strip(v);
      }
      return out;
    }
    return value;
  };
  return JSON.stringify(strip(node));
}

/** A text's top-level blocks: where each starts and ends, and what it means. */
interface Blocks {
  source: string;
  starts: number[];
  ends: number[];
  shapes: string[];
}

const cache = new Map<string, Blocks>();

function remember(blocks: Blocks): void {
  cache.delete(blocks.source);
  cache.set(blocks.source, blocks);
  while (cache.size > CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
}

/** Parses `text` on its own; offsets are moved on by `offset` (where `text` sits in a larger source). */
function parseBlocks(text: string, offset: number, source: string): Blocks | null {
  const root = parser.parse(text) as Root;
  const starts: number[] = [];
  const ends: number[] = [];
  const shapes: string[] = [];
  for (const node of root.children) {
    const from = node.position?.start.offset;
    const to = node.position?.end.offset;
    if (typeof from !== "number" || typeof to !== "number") return null;
    starts.push(from + offset);
    ends.push(to + offset);
    shapes.push(shape(node));
  }
  return { source, starts, ends, shapes };
}

function blocksOf(source: string): Blocks | null {
  const known = cache.get(source);
  if (known) return known;
  const parsed = parseBlocks(source, 0, source);
  if (parsed) remember(parsed);
  return parsed;
}

const sameShapes = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((s, i) => s === b[i]);

/**
 * `next`'s blocks, parsed only where it differs from `previous` (whose blocks
 * are known): the blocks wholly inside the text the two share at the start
 * and the end are `previous`'s, less one on each side so the block meeting a
 * change is always reparsed.
 */
function blocksAgainst(previous: Blocks, next: string): Blocks | null {
  const prev = previous.source;
  const count = previous.shapes.length;
  if (count === 0) return null;
  const max = Math.min(prev.length, next.length);
  let prefix = 0;
  while (prefix < max && prev.charCodeAt(prefix) === next.charCodeAt(prefix)) prefix++;
  let suffix = 0;
  while (suffix < max - prefix && prev.charCodeAt(prev.length - 1 - suffix) === next.charCodeAt(next.length - 1 - suffix)) suffix++;
  let head = 0;
  while (head < count && previous.ends[head]! <= prefix) head++;
  head = Math.max(0, head - 1);
  let tail = 0;
  while (tail < count - head && previous.starts[count - 1 - tail]! >= prev.length - suffix) tail++;
  tail = Math.max(0, tail - 1);
  const delta = next.length - prev.length;
  const from = head === 0 ? 0 : previous.starts[head]!;
  const to = tail === 0 ? next.length : previous.starts[count - tail]! + delta;
  if (to < from) return null;
  const middle = parseBlocks(next.slice(from, to), from, next);
  if (!middle) return null;
  return {
    source: next,
    starts: [...previous.starts.slice(0, head), ...middle.starts, ...previous.starts.slice(count - tail).map((x) => x + delta)],
    ends: [...previous.ends.slice(0, head), ...middle.ends, ...previous.ends.slice(count - tail).map((x) => x + delta)],
    shapes: [...previous.shapes.slice(0, head), ...middle.shapes, ...previous.shapes.slice(count - tail)],
  };
}

/** The text between block `i` and the next one. */
const gapAfter = (b: Blocks, i: number) => b.source.slice(b.ends[i], b.starts[i + 1]);
const blockText = (b: Blocks, i: number) => b.source.slice(b.starts[i], b.ends[i]);

/** One block of the result: the stored block `a` (unchanged) or the serialization's block `b`; `b` is always its place in the serialization. */
type Piece = { a: number | null; b: number };

/**
 * The serialization's blocks in order, each matched to an unchanged stored
 * block where the alignment finds one. Blocks the two share at the start and
 * the end are matched directly; only the middle between them is aligned (a
 * longest common subsequence), and a middle too large to align is taken as
 * changed throughout.
 */
function align(stored: Blocks, next: Blocks): Piece[] {
  const n = stored.shapes.length;
  const m = next.shapes.length;
  let head = 0;
  while (head < n && head < m && stored.shapes[head] === next.shapes[head]) head++;
  let tail = 0;
  while (tail < n - head && tail < m - head && stored.shapes[n - 1 - tail] === next.shapes[m - 1 - tail]) tail++;

  const pieces: Piece[] = [];
  for (let k = 0; k < head; k++) pieces.push({ a: k, b: k });
  const rows = n - head - tail;
  const cols = m - head - tail;
  if ((rows + 1) * (cols + 1) > MINIMAL_DIFF_MAX_CELLS) {
    for (let j = head; j < m - tail; j++) pieces.push({ a: null, b: j });
  } else {
    const lcs: Uint32Array[] = Array.from({ length: rows + 1 }, () => new Uint32Array(cols + 1));
    for (let i = rows - 1; i >= 0; i--) {
      for (let j = cols - 1; j >= 0; j--) {
        lcs[i]![j] = stored.shapes[head + i] === next.shapes[head + j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (j < cols) {
      if (i < rows && stored.shapes[head + i] === next.shapes[head + j]) {
        pieces.push({ a: head + i, b: head + j });
        i++;
        j++;
      } else if (i < rows && lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
        i++;
      } else {
        pieces.push({ a: null, b: head + j });
        j++;
      }
    }
  }
  for (let k = tail; k > 0; k--) pieces.push({ a: n - k, b: m - k });
  return pieces;
}

/** An assembled result: its text, where each piece landed in it, and which pieces sit at a change. */
interface Assembled {
  blocks: Blocks;
  /** Per piece: whether it, or the seam before or after it, differs from the stored text. */
  changed: boolean[];
}

/**
 * The text of the aligned pieces. Between two stored blocks that were
 * neighbours, and between two serialized blocks, the whitespace is their own;
 * where a stored block meets an edited one it is the stored whitespace on
 * that side when `preferStored`, else the serialization's.
 */
function assemble(stored: Blocks, next: Blocks, pieces: Piece[], preferStored: boolean): Assembled {
  const lastStored = stored.shapes.length - 1;
  const first = pieces[0]!;
  const last = pieces[pieces.length - 1]!;
  const changed = pieces.map((p) => p.a === null);
  const starts: number[] = [];
  const ends: number[] = [];
  let out = first.a === 0 ? stored.source.slice(0, stored.starts[0]) : next.source.slice(0, next.starts[first.b]);
  if (first.a !== 0) changed[0] = true;
  for (let k = 0; k < pieces.length; k++) {
    const piece = pieces[k]!;
    starts.push(out.length);
    out += piece.a !== null ? blockText(stored, piece.a) : blockText(next, piece.b);
    ends.push(out.length);
    const following = pieces[k + 1];
    if (!following) break;
    if (piece.a !== null && following.a === piece.a + 1) {
      out += gapAfter(stored, piece.a);
      continue;
    }
    changed[k] = true;
    changed[k + 1] = true;
    if (piece.a === null && following.a === null) out += gapAfter(next, piece.b);
    else if (preferStored && piece.a !== null && piece.a < lastStored) out += gapAfter(stored, piece.a);
    else if (preferStored && following.a !== null && following.a > 0) out += gapAfter(stored, following.a - 1);
    else out += gapAfter(next, piece.b);
  }
  if (last.a === lastStored) out += stored.source.slice(stored.ends[lastStored]);
  else {
    out += next.source.slice(next.ends[last.b]);
    changed[pieces.length - 1] = true;
  }
  return { blocks: { source: out, starts, ends, shapes: pieces.map((p) => next.shapes[p.b]!) }, changed };
}

/**
 * Whether the assembled text parses to the blocks it was assembled from:
 * whole when it is small, else around each changed run of pieces, taking in
 * the unchanged piece on either side.
 */
function holds({ blocks, changed }: Assembled): boolean {
  const { source, starts, ends, shapes } = blocks;
  if (source.length <= WHOLE_CHECK_MAX_CHARS) {
    const whole = parseBlocks(source, 0, source);
    return whole !== null && sameShapes(whole.shapes, shapes);
  }
  const count = shapes.length;
  for (let k = 0; k < count; k++) {
    if (!changed[k]) continue;
    let end = k;
    while (end + 1 < count && changed[end + 1]) end++;
    const lo = Math.max(0, k - 1);
    const hi = Math.min(count - 1, end + 1);
    const from = lo === 0 ? 0 : starts[lo]!;
    const to = hi === count - 1 ? source.length : ends[hi]!;
    const part = parseBlocks(source.slice(from, to), from, source);
    if (!part || !sameShapes(part.shapes, shapes.slice(lo, hi + 1))) return false;
    k = end;
  }
  return true;
}

/**
 * Parses the stored text and the editor's serialization of it ahead of the
 * first save (the doc pane does this once a doc loads), so that save only
 * parses what it changed.
 */
export function prepareMinimalDiff(stored: string, previous: string): void {
  if (stored.length > MINIMAL_DIFF_MAX_CHARS || previous.length > MINIMAL_DIFF_MAX_CHARS) return;
  try {
    blocksOf(stored);
    blocksOf(previous);
  } catch {
    // A text the parser can't take is diffed (or not) at save time.
  }
}

/**
 * The markdown to store for an edit: `next` (the editor's serialization)
 * with every block it shares with `stored` (the markdown as stored, without
 * frontmatter) written as it was stored. `previous`, when given, is the
 * editor's serialization of `stored`, which lets `next` be parsed only where
 * it changed. Always means what `next` means; falls back to `next` itself
 * when no such text can be made, and never throws.
 */
export function minimalMarkdown(stored: string, next: string, previous?: string): string {
  if (stored === next || stored.length > MINIMAL_DIFF_MAX_CHARS || next.length > MINIMAL_DIFF_MAX_CHARS) return next;
  try {
    const before = blocksOf(stored);
    if (!before || before.shapes.length === 0) return next;
    let after = cache.get(next) ?? null;
    if (!after && previous !== undefined && previous.length <= MINIMAL_DIFF_MAX_CHARS) {
      const prior = blocksOf(previous);
      // `previous` stands in for the stored text only where it means the same, block for block.
      if (prior && sameShapes(prior.shapes, before.shapes)) after = blocksAgainst(prior, next);
    }
    after ??= blocksOf(next);
    if (!after || after.shapes.length === 0) return next;
    const pieces = align(before, after);
    for (const preferStored of [true, false]) {
      const candidate = assemble(before, after, pieces, preferStored);
      if (holds(candidate)) {
        // Kept only once they have held: the serialization is the next save's
        // `previous`, and the saved text its stored text.
        remember(after);
        remember(candidate.blocks);
        return candidate.blocks.source;
      }
    }
  } catch {
    // Anything the parser can't take is saved as the editor wrote it.
  }
  return next;
}

/** The body to store when the editor's content becomes `next`: the stored body's frontmatter, then minimalMarkdown against its content. */
export function minimalBody(storedBody: string, frontmatter: string, next: string, previous?: string): string {
  return joinFrontmatter(frontmatter, minimalMarkdown(splitFrontmatter(storedBody).content, next, previous));
}
