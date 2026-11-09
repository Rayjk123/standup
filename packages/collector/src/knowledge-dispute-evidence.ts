import { isAbsolute, relative } from "path";
import { foundAtRef, pathAtRef, readAtRef, type MainlineDeps, type MainlineRef } from "./knowledge-mainline.js";
import type { DraftDispute } from "./draft-verify.js";

/**
 * The mechanical check every model dispute passes before it is recorded. A
 * verifier's finding is only as good as the line it read, and a confident
 * finding about the wrong line (or a name it failed to find) reads exactly
 * like a real one. So each dispute must carry its evidence and the evidence is
 * re-read at the verified commit:
 *
 * - A dispute that something is wrong quotes the line(s) it cites; each quote
 *   must be distinctive (quoteIsDistinctive) and appear in that file at the
 *   commit, at or within QUOTE_SLACK lines of the cited line.
 * - A dispute explicitly of kind `absent` names the symbol and the file(s) it
 *   searched; a search of the whole tree's contents at the commit must not
 *   find it, nor, for a path-like symbol, a listing of its files.
 * - A quoted dispute's evidence must contradict its claim, not merely sit near
 *   it: one whose quoted line holds the very value the claim states is refuted
 *   (see Entailment below).
 *
 * A dispute failing any of these is dropped, and counted with its reason. So is one
 * whose search could not run (git failed or timed out): an absence that
 * cannot be confirmed is not recorded.
 */

/** How far from the cited line a quote may sit. */
export const QUOTE_SLACK = 3;
/** Non-whitespace characters a single-token quote needs. */
export const MIN_QUOTE_CHARS = 12;
/** Whitespace-separated tokens that make a quote distinctive whatever its length. */
export const MIN_QUOTE_TOKENS = 2;

export interface DroppedDisputes {
  count: number;
  reasons: string[];
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** A quoted line with any line-number gutter a file viewer prints removed. */
function stripGutter(line: string): string {
  return line.replace(/^\s*\d+(?:→|\t|:\s)/, "");
}

/** Whether `quote` appears in `text` at, or within QUOTE_SLACK lines of, `line` (1-based). */
export function quoteNearLine(text: string, line: number, quote: string): boolean {
  const quoted = quote.split("\n").map((l) => normalize(stripGutter(l))).filter(Boolean);
  if (quoted.length === 0 || !Number.isInteger(line) || line < 1) return false;
  const lines = text.split("\n");
  const from = Math.max(0, line - 1 - QUOTE_SLACK);
  const to = Math.min(lines.length, line - 1 + QUOTE_SLACK + quoted.length);
  return normalize(lines.slice(from, to).join(" ")).includes(quoted.join(" "));
}

function isWithin(path: string, root: string): boolean {
  const base = root.replace(/\/+$/, "");
  return path === base || path.startsWith(`${base}/`);
}

/** Where a cited file sits: the commit it is read at and its path in that tree. */
function locate(file: string, refs: readonly MainlineRef[]): Array<{ ref: MainlineRef; path: string }> {
  if (isAbsolute(file)) {
    const ref = refs.find((r) => isWithin(file, r.toplevel));
    return ref ? [{ ref, path: relative(ref.toplevel, file) }] : [];
  }
  const rel = file.replace(/^\.\//, "");
  return refs.flatMap((ref) => [{ ref, path: `${ref.prefix}${rel}` }, ...(ref.prefix ? [{ ref, path: rel }] : [])]);
}

/** Whether a dispute claims something is missing rather than wrong: only one
 *  that says so explicitly. Any other dispute must quote its evidence. */
export function isAbsenceDispute(d: DraftDispute): boolean {
  return d.kind === "absent";
}

/** Whether a quote is long enough to pin one place in a file: at least
 *  MIN_QUOTE_CHARS non-whitespace characters, or MIN_QUOTE_TOKENS tokens. A
 *  lone brace or keyword matches near almost any line. */
export function quoteIsDistinctive(quote: string): boolean {
  const text = normalize(
    quote
      .split("\n")
      .map((l) => stripGutter(l))
      .join(" ")
  );
  return text.replace(/\s/g, "").length >= MIN_QUOTE_CHARS || text.split(" ").filter(Boolean).length >= MIN_QUOTE_TOKENS;
}

/** Whether a symbol names a file or directory: it has no whitespace and holds
 *  a `/` or ends in a file extension. */
export function isPathLike(symbol: string): boolean {
  return !/\s/.test(symbol) && (symbol.includes("/") || /\.[A-Za-z0-9]{1,10}$/.test(symbol));
}

/** `symbol` as a path in `ref`'s tree, or null for an absolute path outside it. */
function treePath(symbol: string, ref: MainlineRef): string | null {
  if (!isAbsolute(symbol)) return symbol;
  return isWithin(symbol, ref.toplevel) ? relative(ref.toplevel, symbol) : null;
}

const EVIDENCE_CHECK_FAILED = "evidence check failed";

/** Why `d` fails its evidence check at `refs`, or null when it holds. */
async function evidenceFailure(d: DraftDispute, refs: readonly MainlineRef[], deps: MainlineDeps): Promise<string | null> {
  if (isAbsenceDispute(d)) {
    const symbol = d.symbol?.trim() ?? "";
    if (!symbol || (d.searched?.length ?? 0) === 0) return "an absence claim names no symbol or no file searched";
    const at = (ref: MainlineRef) => `${ref.ref}@${ref.sha.slice(0, 7)}`;
    for (const ref of refs) {
      const content = await foundAtRef(ref, symbol, deps);
      if (content === "present") return `"${symbol}" is present at ${at(ref)}`;
      if (content === "unknown") return `${EVIDENCE_CHECK_FAILED}: could not search ${at(ref)} for "${symbol}"`;
      if (!isPathLike(symbol)) continue;
      const path = treePath(symbol, ref);
      if (path === null) continue;
      const file = await pathAtRef(ref, path, deps);
      if (file === "present") return `the file "${symbol}" exists at ${at(ref)}`;
      if (file === "unknown") return `${EVIDENCE_CHECK_FAILED}: could not list the files of ${at(ref)}`;
    }
    return null;
  }
  const citations = d.citations ?? [];
  if (citations.length === 0) return "cites no quoted line";
  for (const c of citations) {
    if (!quoteIsDistinctive(c.quote)) {
      return `the quote at ${c.file}:${c.line} is too short to locate (under ${MIN_QUOTE_CHARS} characters and ${MIN_QUOTE_TOKENS} tokens)`;
    }
  }
  for (const c of citations) {
    const candidates = locate(c.file, refs);
    if (candidates.length === 0) return `cites ${c.file}, outside the verified repositories`;
    let read = false;
    let matched = false;
    for (const { ref, path } of candidates) {
      const text = await readAtRef(ref, path, deps);
      if (text === null) continue;
      read = true;
      if (quoteNearLine(text, c.line, c.quote)) {
        matched = true;
        break;
      }
    }
    if (!read) return `${c.file} does not exist at the verified commit`;
    if (!matched) return `the quote is not at ${c.file}:${c.line} (±${QUOTE_SLACK} lines)`;
  }
  return null;
}

// ── Entailment ────────────────────────────────────────────────────────────────
//
// A quote that sits at the cited line proves only that the verifier read that
// line, not that the line opposes the claim: a verifier that misreads a match as
// a mismatch quotes a line that AGREES with the draft. So a dispute citing lines
// is kept only when its evidence does not confirm the claim:
//
// - Deterministic first. The claim's code-like bindings (`NAME = 8`,
//   `NAME: "x"`, `` `NAME` is 8 ``) are compared with the bindings in the quoted
//   lines, by the full name as written (`client.timeout` is not
//   `server.timeout`). Any shared name holding a different value → the
//   evidence contradicts, keep. Every claimed name present in the quote with
//   the same value → refuted, drop with a note. The verifier's own
//   `draftValue`/`codeValue` pair counts the same way when its code value
//   appears in the quote.
// - Nothing shared, or a claimed name the quote does not show → undecided.
//   An optional entailment judge decides the rest;
//   without one (the default — it costs a model call) the dispute is kept.
//
// Absence disputes cite no lines and pass through untouched.

export type Entailment = "contradicts" | "refuted" | "undecided";

/** A model step asked whether a dispute's quoted evidence contradicts its claim;
 *  null when it could not answer. Called only for undecided disputes. */
export type EntailmentJudge = (dispute: DraftDispute) => Promise<"contradicts" | "consistent" | null>;

/** A value token: a quoted string, a number (digit separators allowed), or a word. */
const VALUE = String.raw`"[^"\n]*"|'[^'\n]*'|-?\d[\d_]*(?:\.\d+)?|[A-Za-z_$][\w$.-]*`;
/** A literal value only, for prose connectors where a bare word is just English. */
const LITERAL = String.raw`"[^"\n]*"|'[^'\n]*'|-?\d[\d_]*(?:\.\d+)?|true|false|null`;
const NAME = String.raw`[A-Za-z_$][\w$.]*`;
const BINDING_PATTERNS: readonly RegExp[] = [
  // NAME = value, NAME: value, NAME == value (optionally backticked).
  new RegExp(String.raw`\`?(${NAME})\`?\s*(?:===?|:|=)\s*\`?(${VALUE})\`?`, "g"),
  // NAME is / defaults to / set to / equals <literal>.
  new RegExp(String.raw`\`?(${NAME})\`?\s+(?:is|of|equals|defaults to|is set to|set to)\s+\`?(${LITERAL})\`?`, "g"),
  // A typed declaration: NAME: Type = value.
  new RegExp(String.raw`(${NAME})\s*:\s*[\w$<>\[\]|.]+\s*=\s*(${VALUE})`, "g"),
];

/** A `file.ext` name, as in a `path.ts:42` location rather than a binding. */
const FILE_NAME = /\.(?:[cm]?[jt]sx?|py|md|json|go|rs|java|kt|sql|sh|toml|ya?ml|txt|html|css)$/i;

/** Whether `name` reads as a code identifier rather than an English word. */
function isCodeName(name: string): boolean {
  if (FILE_NAME.test(name)) return false;
  return (
    name.includes("_") ||
    name.includes(".") ||
    /[a-z][A-Z]/.test(name) ||
    (/^[A-Z][A-Z0-9]+$/.test(name) && name.length >= 2)
  );
}

/** A value with quotes, digit separators and case normalized away. */
export function normalizeValue(raw: string): string {
  let v = raw.trim().replace(/[;,]+$/, "");
  if (/^(["'`]).*\1$/.test(v)) return v.slice(1, -1).trim().toLowerCase();
  if (/^-?\d[\d_]*(?:\.\d+)?$/.test(v)) {
    v = v.replace(/_/g, "");
    const n = Number(v);
    return Number.isFinite(n) ? String(n) : v;
  }
  return v.toLowerCase();
}

/**
 * The code-like name → value bindings stated in `text`, last statement
 * winning. A name is kept whole and as written (`client.timeout` and
 * `server.timeout` are different bindings, as are `limit` and `LIMIT`); only
 * the value is normalized (normalizeValue).
 */
export function extractBindings(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const pattern of BINDING_PATTERNS) {
    for (const m of text.matchAll(pattern)) {
      const name = m[1]!;
      if (!isCodeName(name)) continue;
      // A bare word after `=` is only a value when it is itself code-like or a
      // keyword literal ("X = Y_LIMIT", "x: true"), not the next English word.
      const raw = m[2]!;
      if (/^[A-Za-z_$]/.test(raw) && !isCodeName(raw) && !/^(true|false|null)$/.test(raw)) continue;
      out.set(name, normalizeValue(raw));
    }
  }
  return out;
}

/** Whether normalized `value` appears in `quotes` as a whole token (so 8 is not found in 128). */
function quoteHoldsValue(quotes: string, value: string): boolean {
  const text = normalize(quotes).toLowerCase().replace(/(\d)_(?=\d)/g, "$1");
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w.])${escaped}($|[^\\w])`).test(text);
}

/**
 * Whether a dispute's quoted evidence contradicts its claim, by the
 * deterministic rule above. Only disputes that cite lines are decided; any
 * other is `undecided`.
 */
export function disputeEntailment(d: DraftDispute): { entailment: Entailment; detail: string } {
  const quotes = (d.citations ?? []).map((c) => c.quote).join("\n");
  if (isAbsenceDispute(d) || !quotes.trim()) return { entailment: "undecided", detail: "" };
  if (d.draftValue !== undefined && d.codeValue !== undefined) {
    const draft = normalizeValue(d.draftValue);
    const code = normalizeValue(d.codeValue);
    if (code && quoteHoldsValue(quotes, code)) {
      return draft === code
        ? { entailment: "refuted", detail: `the draft and the quoted line both hold ${d.codeValue}` }
        : { entailment: "contradicts", detail: `the draft states ${d.draftValue}, the quoted line ${d.codeValue}` };
    }
  }
  // Refuted only when the quote confirms every binding the claim states: a
  // claim naming two values the quote shows one of may be disputing the other.
  const claimed = extractBindings(d.claim);
  const quoted = extractBindings(quotes);
  const same: string[] = [];
  let unconfirmed = false;
  for (const [name, value] of claimed) {
    const actual = quoted.get(name);
    if (actual === undefined) {
      unconfirmed = true;
      continue;
    }
    if (actual !== value) {
      return { entailment: "contradicts", detail: `${name} is ${actual} in the quoted line, ${value} in the claim` };
    }
    same.push(`${name} = ${value}`);
  }
  return same.length > 0 && !unconfirmed
    ? { entailment: "refuted", detail: `the quoted line holds every claimed value (${same.join(", ")})` }
    : { entailment: "undecided", detail: "" };
}

/**
 * Splits disputes by entailment: a refuted one (its evidence confirms the
 * claim) is dropped with its reason; a contradicting one is kept; an undecided
 * one goes to `judge` when given — dropped on "consistent", kept otherwise.
 */
export async function filterEntailedDisputes(
  disputes: readonly DraftDispute[],
  judge?: EntailmentJudge
): Promise<{ kept: DraftDispute[]; refuted: string[] }> {
  const kept: DraftDispute[] = [];
  const refuted: string[] = [];
  for (const d of disputes) {
    const { entailment, detail } = disputeEntailment(d);
    if (entailment === "refuted") {
      refuted.push(`${d.claim.slice(0, 120)}: refuted — ${detail}`);
      continue;
    }
    if (entailment === "undecided" && judge && !isAbsenceDispute(d) && (d.citations?.length ?? 0) > 0) {
      let answer: "contradicts" | "consistent" | null = null;
      try {
        answer = await judge(d);
      } catch (err) {
        console.warn("[dispute-evidence] entailment judge failed:", err);
      }
      if (answer === "consistent") {
        refuted.push(`${d.claim.slice(0, 120)}: refuted — the entailment judge found the quoted line consistent with the claim`);
        continue;
      }
    }
    kept.push(d);
  }
  return { kept, refuted };
}

export interface DisputeCheckOptions {
  /** Decides disputes the deterministic entailment rule leaves undecided. */
  entailmentJudge?: EntailmentJudge;
}

/**
 * The disputes whose evidence holds at `refs` and contradicts the claim it is
 * cited against, and those dropped, with why.
 */
export async function checkDisputeEvidence(
  disputes: readonly DraftDispute[],
  refs: readonly MainlineRef[],
  deps: MainlineDeps = {},
  options: DisputeCheckOptions = {}
): Promise<{ kept: DraftDispute[]; dropped: DroppedDisputes }> {
  const located: DraftDispute[] = [];
  const reasons: string[] = [];
  for (const d of disputes) {
    const failure = await evidenceFailure(d, refs, deps);
    if (failure === null) located.push(d);
    else reasons.push(`${d.claim.slice(0, 120)}: ${failure}`);
  }
  const { kept, refuted } = await filterEntailedDisputes(located, options.entailmentJudge);
  reasons.push(...refuted);
  return { kept, dropped: { count: reasons.length, reasons } };
}
