/**
 * Comments on a doc's passages: what a signed-in reader of a shareable doc,
 * or the doc's owner, leaves on it, the doc agent's and the owner's replies, and how a comment
 * finds its passage again after the doc is edited.
 *
 * A comment is anchored by the passage's text, not by a position: the quote
 * itself plus a little of the text on each side. Both views (the owner's
 * editor and a reader's rendered markdown) match it against the doc's
 * rendered text with every whitespace character dropped, since the two
 * renderers put different whitespace (or none) between blocks. A comment
 * whose quote is no longer in the doc is an orphan: it is still listed, under
 * "passage removed", but highlights nothing.
 */

/** The passage a comment is on: the selected text and up to DOC_COMMENT_CONTEXT characters on each side. */
export interface DocCommentAnchor {
  quote: string;
  prefix: string;
  suffix: string;
}

/**
 * Where a comment stands:
 *  - `pending`: the doc agent is still working on a reply;
 *  - `answered`: the agent answered from the doc, the owner replied, or the owner left it;
 *  - `waiting`: the doc doesn't answer it (or no agent reply could be made), so it waits for the owner.
 */
export type DocCommentState = "pending" | "answered" | "waiting";

/** A reply on a comment: the doc agent's, or the doc owner's (`author` is the owner's alias). */
export interface DocCommentReply {
  id: string;
  authorKind: "agent" | "owner";
  author?: string;
  /** On the doc agent's reply: present (true) when it answered from the doc, absent when the doc didn't say. */
  fromDoc?: true;
  body: string;
  createdAt: string;
}

/** A comment as the doc's owner and its readers see it; `author` is the signed-in alias that left it. */
export interface DocComment {
  id: string;
  anchor: DocCommentAnchor;
  author: string;
  /** Present (true) when the doc's owner left it: it gets no agent reply and waits on no one. */
  byOwner?: true;
  body: string;
  state: DocCommentState;
  resolved: boolean;
  createdAt: string;
  replies: DocCommentReply[];
}

/** The longest comment or reply body, in characters. */
export const DOC_COMMENT_BODY_MAX = 2000;
/** The longest quoted passage, in characters. */
export const DOC_COMMENT_QUOTE_MAX = 500;
/** How much text on each side of the quote an anchor keeps. */
export const DOC_COMMENT_CONTEXT = 32;
/**
 * How many comments are taken, and how many doc-agent replies are made. A
 * comment past a user's or a doc's limit is refused with a 429. A comment
 * past an agent-reply cap is still stored, but gets no agent reply and waits
 * for the owner, so a burst of comments never starts more model calls than
 * these allow.
 */
export const DOC_COMMENT_LIMITS = {
  /** Comments one user leaves in a minute, and in an hour, across all docs. */
  perUserPerMinute: 5,
  perUserPerHour: 30,
  /** Comments one doc takes in an hour, from everyone. */
  perDocPerHour: 60,
  /** Unresolved comments one doc holds at once. */
  openPerDoc: 200,
  /** Agent replies made for one doc in an hour. */
  agentPerDocPerHour: 20,
  /** Agent replies made for one owner's docs in a day. */
  agentPerOwnerPerDay: 200,
  /** Agent replies being written at once, across the collector. */
  agentConcurrent: 2,
} as const;

/** `text` with every whitespace character dropped, and each kept character's index in `text`. */
function squeezed(text: string): { text: string; at: number[] } {
  let out = "";
  const at: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (/\s/.test(text[i]!)) continue;
    out += text[i];
    at.push(i);
  }
  return { text: out, at };
}

/** The anchor for `text.slice(start, end)`, with its quote and context trimmed to their caps. */
export function anchorAt(text: string, start: number, end: number): DocCommentAnchor {
  const raw = text.slice(start, end);
  const quote = raw.trim().slice(0, DOC_COMMENT_QUOTE_MAX);
  const from = start + raw.length - raw.trimStart().length;
  const to = from + quote.length;
  return {
    quote,
    prefix: text.slice(Math.max(0, from - DOC_COMMENT_CONTEXT), from),
    suffix: text.slice(to, to + DOC_COMMENT_CONTEXT),
  };
}

/** How many characters `a` and `b` share at their ends (`fromEnd`) or starts. */
function shared(a: string, b: string, fromEnd: boolean): number {
  let n = 0;
  while (n < a.length && n < b.length) {
    const x = fromEnd ? a[a.length - 1 - n] : a[n];
    const y = fromEnd ? b[b.length - 1 - n] : b[n];
    if (x !== y) break;
    n++;
  }
  return n;
}

/**
 * Where `anchor`'s passage is in `text` now, as `[start, end)` offsets into
 * `text`, or null when the quote is gone (an orphan). Whitespace is ignored
 * when matching. When the quote appears more than once, the occurrence whose
 * surrounding text best matches the anchor's prefix and suffix wins, the
 * first on a tie.
 */
export function locateAnchor(text: string, anchor: DocCommentAnchor): { start: number; end: number } | null {
  const hay = squeezed(text);
  const quote = squeezed(anchor.quote).text;
  if (!quote) return null;
  const prefix = squeezed(anchor.prefix).text;
  const suffix = squeezed(anchor.suffix).text;
  let best: { at: number; score: number } | null = null;
  for (let at = hay.text.indexOf(quote); at !== -1; at = hay.text.indexOf(quote, at + 1)) {
    const before = hay.text.slice(Math.max(0, at - prefix.length), at);
    const after = hay.text.slice(at + quote.length, at + quote.length + suffix.length);
    const score = shared(before, prefix, true) + shared(after, suffix, false);
    if (!best || score > best.score) best = { at, score };
  }
  if (!best) return null;
  return { start: hay.at[best.at]!, end: hay.at[best.at + quote.length - 1]! + 1 };
}

/** Why a comment can't be taken as sent, or null when it can. */
export function docCommentRefusal(input: { body: unknown; anchor: unknown }): string | null {
  const { body, anchor } = input;
  if (typeof body !== "string" || !body.trim()) return "A comment needs some text";
  if (body.length > DOC_COMMENT_BODY_MAX) return `A comment is at most ${DOC_COMMENT_BODY_MAX} characters`;
  if (!anchor || typeof anchor !== "object") return "A comment is on a passage of the doc";
  const { quote, prefix, suffix } = anchor as Record<string, unknown>;
  if (typeof quote !== "string" || !quote.trim()) return "A comment is on a passage of the doc";
  if (quote.length > DOC_COMMENT_QUOTE_MAX) return `A commented passage is at most ${DOC_COMMENT_QUOTE_MAX} characters`;
  for (const side of [prefix, suffix]) {
    if (typeof side !== "string" || side.length > DOC_COMMENT_CONTEXT * 2) return "A comment's passage context is malformed";
  }
  return null;
}
