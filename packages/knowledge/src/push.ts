import { basename, dirname, extname, isAbsolute, relative, sep } from "path";
import type { ContradictionState, RelevanceSignals } from "./relevance.js";
import type { MirrorProjects } from "./duplicate-hits.js";
import { foreignIntentAdmissible } from "./query-rewrite.js";
import type { SearchOptions } from "./search.js";
import {
  isOriginEligibleForInjection,
  layerOf,
  type DraftVerdict,
  type Layer,
  type OriginClass,
  type Scope,
  type ScopeAudience,
  type SourceKind,
} from "./types.js";

/**
 * Knowledge pushed into an agent's context by a hook, without the agent asking:
 * the pure half — what to search for on each hook, which hits clear the bar, the
 * per-session dedup and the injected text. The collector wraps it with the
 * search call, the latency budget and the telemetry; the retrieval eval drives
 * the same functions, so the bar it reports is the bar that ships.
 *
 *  - `SessionStart`: the launch brief, or the session's project name and title,
 *    up to PUSH_MAX_DOCS.SessionStart docs.
 *  - `UserPromptSubmit`: the prompt, skipped when it is trivial (pushPromptQuery).
 *  - `PreToolUse`: the first edit in a directory (pushEditTarget), searched by
 *    the directory and the file's stem (pushAreaQuery).
 *
 * Only a hit that clears PUSH_RELEVANCE_BAR and is fit to state as fact is
 * pushed (pushGate): an owner/agent doc, not disputed, superseded or on the
 * open/losing side of a contradiction, not stale, and not in the personal or
 * activity layer. A doc the session has already been handed (pushed, injected at
 * launch, or retrieved through search / get_knowledge_doc) is never pushed again.
 */

export type PushEvent = "SessionStart" | "UserPromptSubmit" | "PreToolUse";

export const PUSH_EVENTS: readonly PushEvent[] = ["SessionStart", "UserPromptSubmit", "PreToolUse"];

/**
 * The relevance a hit needs to be pushed. Well above the search floor (0.18):
 * a pushed doc arrives unasked, so a wrong one costs the agent attention it
 * never chose to spend. Calibrated on the retrieval eval's task tier: no
 * unmarked search hit at or above it is unhelpful, and every prompt push it lets
 * through is helpful.
 */
export const PUSH_RELEVANCE_BAR = 0.6;

/**
 * The bar a first-edit push clears. A path query is a bag of path tokens
 * ("src", "launcher", the file stem) with no question in it, so a doc that
 * merely repeats the directory's common words covers it lexically; at
 * PUSH_RELEVANCE_BAR the eval's edit pushes were all unhelpful.
 */
export const PUSH_PATH_RELEVANCE_BAR = 0.7;

/** The bar per hook event. */
export const PUSH_RELEVANCE_BARS: Readonly<Record<PushEvent, number>> = {
  SessionStart: PUSH_RELEVANCE_BAR,
  UserPromptSubmit: PUSH_RELEVANCE_BAR,
  PreToolUse: PUSH_PATH_RELEVANCE_BAR,
};

/** Most docs one hook pushes. */
export const PUSH_MAX_DOCS: Readonly<Record<PushEvent, number>> = {
  SessionStart: 3,
  UserPromptSubmit: 2,
  PreToolUse: 2,
};

/** Most characters of one hook's injected block, header included. */
export const PUSH_MAX_CHARS: Readonly<Record<PushEvent, number>> = {
  SessionStart: 600,
  UserPromptSubmit: 400,
  PreToolUse: 400,
};

/** The layers never pushed: another person's context and dated session notes. */
export const PUSH_EXCLUDED_LAYERS: readonly Layer[] = ["personal", "activity"];

/** Candidates one push search ranks before the gate. */
export const PUSH_SEARCH_LIMIT = 8;

/** A prompt shorter than this many words carries too little to search on. */
export const PUSH_MIN_PROMPT_WORDS = 4;

/** Longest query a push searches with; a pasted log or a launch brief is cut here. */
export const PUSH_MAX_QUERY_CHARS = 1000;

/** The tools whose first call in a directory pushes knowledge about it. */
export const PUSH_EDIT_TOOLS: ReadonlySet<string> = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "apply_patch"]);

/** The one-line header above each hook's docs. */
export const PUSH_HEADERS: Readonly<Record<PushEvent, string>> = {
  SessionStart: "Standup knowledge for this session (open with get_knowledge_doc):",
  UserPromptSubmit: "Standup knowledge for this prompt (open with get_knowledge_doc):",
  PreToolUse: "Standup knowledge about this file area (open with get_knowledge_doc):",
};

/** The fields of a search hit the push gate and formatter read. */
export interface PushCandidate {
  projectId: string;
  slug: string;
  title: string;
  excerpt: string;
  score?: number;
  relevance?: number;
  relevanceSignals?: RelevanceSignals;
  originClass?: OriginClass;
  verdict?: DraftVerdict | string;
  contradiction?: ContradictionState;
  scope?: Scope | string;
  sourceKind?: SourceKind | string;
  layer?: Layer;
}

export interface PushSelectOptions<T extends PushCandidate = PushCandidate> {
  /** The caller's freshness gate: true when the doc is injection-eligible and not stale. */
  fresh?: (hit: T) => boolean;
  /** Refs (`project/slug`) the session already has. */
  seen?: ReadonlySet<string>;
  /** The relevance bar; the event's PUSH_RELEVANCE_BARS entry unless the eval sweeps it. */
  bar?: number;
  /**
   * The project the push is for. When set, a product/spec doc homed elsewhere
   * must clear launch injection's higher foreign-intent bar (foreignIntentAdmissible).
   */
  projectId?: string;
}

/** Why a candidate is not pushed. */
export type PushGateReason = "floor" | "origin" | "verdict" | "personal" | "activity" | "freshness" | "seen";

/** `project/slug`, the key every dedup set holds. */
export function pushRef(doc: { projectId: string; slug: string }): string {
  return `${doc.projectId}/${doc.slug}`;
}

/**
 * Whether a doc's verdict lets it be stated as fact: never disputed or
 * superseded, and a contradicted doc only from the winning side (an undecided
 * pair carries a conflict the one-line push cannot show).
 */
export function isPushVerdictAdmissible(hit: Pick<PushCandidate, "verdict" | "contradiction">): boolean {
  if (hit.verdict === "disputed" || hit.verdict === "superseded") return false;
  if (hit.verdict !== "contradicted") return true;
  return hit.contradiction?.side === "winning";
}

/**
 * Why `hit` is held back, or null when it may be pushed. `fresh` is the
 * caller's freshness gate (eligible and not stale); `seen` holds the refs the
 * session already has.
 */
export function pushGate<T extends PushCandidate>(hit: T, opts: PushSelectOptions<T> = {}): PushGateReason | null {
  const named = hit.relevanceSignals?.named === true;
  const bar = opts.bar ?? PUSH_RELEVANCE_BAR;
  if (!named && !(typeof hit.relevance === "number" && hit.relevance >= bar)) return "floor";
  if (opts.projectId !== undefined && !foreignIntentAdmissible(hit, opts.projectId)) return "floor";
  if (!isOriginEligibleForInjection(hit.originClass as OriginClass | undefined)) return "origin";
  if (!isPushVerdictAdmissible(hit)) return "verdict";
  const layer = hit.layer ?? layerOf({ scope: hit.scope, sourceKind: hit.sourceKind, slug: hit.slug });
  if (layer === "personal") return "personal";
  if (layer === "activity") return "activity";
  if (opts.fresh && !opts.fresh(hit)) return "freshness";
  if (opts.seen?.has(pushRef(hit))) return "seen";
  return null;
}

/** The hits one hook pushes, in rank order: gated, distinct, unseen, capped. */
export function selectPushDocs<T extends PushCandidate>(hits: readonly T[], event: PushEvent, opts: PushSelectOptions<T> = {}): T[] {
  const picked: T[] = [];
  const refs = new Set<string>();
  const gate: PushSelectOptions<T> = { ...opts, bar: opts.bar ?? PUSH_RELEVANCE_BARS[event] };
  for (const hit of hits) {
    if (picked.length >= PUSH_MAX_DOCS[event]) break;
    const ref = pushRef(hit);
    if (refs.has(ref) || pushGate(hit, gate) !== null) continue;
    refs.add(ref);
    picked.push(hit);
  }
  return picked;
}

/**
 * The search options every push runs with, for an audience the caller resolved
 * and the registry's mirror projects (SearchOptions.mirrorProjects). Like launch
 * injection, the audience excludes foreign intent (ScopeAudience.excludeForeignIntent):
 * product/spec docs come from the project, a related project or the global
 * corpus, never an unrelated project's.
 */
export function pushSearchOptions(audience: ScopeAudience, mirrorProjects?: MirrorProjects): SearchOptions {
  return {
    corpus: "all",
    limit: PUSH_SEARCH_LIMIT,
    audience: { ...audience, excludeLayers: PUSH_EXCLUDED_LAYERS, excludeForeignIntent: true },
    confidentFor: "inject",
    ...(mirrorProjects ? { mirrorProjects } : {}),
  };
}

function oneLine(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/[`*_>]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 1) return "";
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

/** Shortest excerpt worth showing; a shorter budget drops the excerpt. */
const MIN_EXCERPT_CHARS = 24;
/** Longest title a line carries. */
const MAX_TITLE_CHARS = 90;

function pushLine(doc: PushCandidate, budget: number): string {
  const ref = ` (get_knowledge_doc slug "${pushRef(doc)}")`;
  const title = clip(oneLine(doc.title) || doc.slug, Math.min(MAX_TITLE_CHARS, Math.max(12, budget - ref.length - 2)));
  const head = `- ${title}`;
  const room = budget - head.length - ref.length - 3;
  const excerpt = oneLine(doc.excerpt);
  return room >= MIN_EXCERPT_CHARS && excerpt ? `${head} — ${clip(excerpt, room)}${ref}` : `${head}${ref}`;
}

/**
 * The block one hook injects: the header, then one line per doc —
 * `- <title> — <one-line excerpt> (get_knowledge_doc slug "<project>/<slug>")`
 * — within PUSH_MAX_CHARS[event]. Excerpts shrink to fit; a doc whose line
 * cannot fit at all is left out, and `included` names what made it. Empty text
 * when no doc fits.
 */
export function formatPushBlock<T extends PushCandidate>(
  event: PushEvent,
  docs: readonly T[],
  maxChars: number = PUSH_MAX_CHARS[event]
): { text: string; included: T[] } {
  const header = PUSH_HEADERS[event];
  for (let n = docs.length; n > 0; n--) {
    const shown = docs.slice(0, n);
    const budget = Math.floor((maxChars - header.length) / n) - 1;
    const lines = shown.map((d) => pushLine(d, budget));
    const text = [header, ...lines].join("\n");
    if (text.length <= maxChars) return { text, included: shown };
  }
  return { text: "", included: [] };
}

const CONTINUE_LIKE =
  /^(?:continue|go on|go ahead|proceed|keep going|carry on|yes|yep|yeah|y|no|n|ok|okay|sure|do it|next|retry|try again|again|thanks|thank you|lgtm|ship it|sounds good|looks good|done)\b[\s.!?,]*(?:please|thanks)?[\s.!?]*$/i;

/**
 * The search query for a submitted prompt, or null when the prompt is not worth
 * a search: a slash command, a "continue"-like reply, or fewer than
 * PUSH_MIN_PROMPT_WORDS words. A long prompt is cut to PUSH_MAX_QUERY_CHARS.
 */
export function pushPromptQuery(prompt: unknown): string | null {
  if (typeof prompt !== "string") return null;
  const text = prompt.trim();
  if (!text || text.startsWith("/")) return null;
  if (CONTINUE_LIKE.test(text)) return null;
  const words = text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
  if (words.length < PUSH_MIN_PROMPT_WORDS) return null;
  return text.slice(0, PUSH_MAX_QUERY_CHARS);
}

/**
 * The SessionStart query: the launch brief when the session is a Standup
 * launch, else the project's name with the session's recent prompt (its
 * title). Null when there is nothing but a scratch or unnamed project.
 */
export function pushSessionStartQuery(input: { brief?: string; projectName?: string; recentPrompt?: string }): string | null {
  const brief = input.brief?.trim();
  if (brief) return brief.slice(0, PUSH_MAX_QUERY_CHARS);
  const parts = [input.projectName?.trim(), input.recentPrompt?.trim()].filter((p): p is string => !!p);
  if (parts.length === 0) return null;
  return parts.join(" ").slice(0, PUSH_MAX_QUERY_CHARS);
}

const APPLY_PATCH_FILE = /^\*\*\* (?:Update|Add) File: (.+)$/m;

/**
 * The file an edit-tool call targets, or null for any other tool. Reads
 * `file_path` (Edit/Write/MultiEdit), `notebook_path` (NotebookEdit), and the
 * first updated or added file of an apply_patch body.
 */
export function pushEditTarget(toolName: unknown, toolInput: unknown): string | null {
  if (typeof toolName !== "string" || !PUSH_EDIT_TOOLS.has(toolName)) return null;
  const input = (toolInput ?? {}) as Record<string, unknown>;
  for (const key of ["file_path", "notebook_path", "path"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  for (const key of ["patch", "input", "command"]) {
    const value = input[key];
    const body = Array.isArray(value) ? value.join("\n") : value;
    if (typeof body === "string") {
      const match = APPLY_PATCH_FILE.exec(body);
      if (match) return match[1].trim();
    }
  }
  return null;
}

/**
 * The file area an edit falls in (its directory, the key the once-per-area
 * dedup holds) and the query searched for it: the directory relative to the
 * session's cwd, the file's own path, and its stem, so a doc naming the file or
 * the directory matches.
 */
export function pushAreaQuery(filePath: string, cwd?: string): { area: string; query: string } {
  const inCwd =
    !!cwd && isAbsolute(filePath) && (filePath === cwd || filePath.startsWith(cwd.endsWith(sep) ? cwd : `${cwd}${sep}`));
  const rel = inCwd ? relative(cwd!, filePath) : filePath.split(sep).filter(Boolean).slice(-4).join("/");
  const area = dirname(filePath);
  const relDir = dirname(rel) === "." ? "" : dirname(rel);
  const stem = basename(filePath, extname(filePath));
  const query = [rel, relDir.split(/[\\/]+/).join(" "), stem].filter(Boolean).join(" ");
  return { area, query };
}
