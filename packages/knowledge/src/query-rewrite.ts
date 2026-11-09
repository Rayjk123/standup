import type { SearchResult } from "./search.js";
import { layerOf, type SourceKind } from "./types.js";

/**
 * Task-aware launch injection, the pure half: what a launch brief is searched
 * for, how the per-query results fuse, and which fused candidates the task
 * itself rules out. The collector's launcher wraps it with the searches, the
 * optional model rewrite and the telemetry; the retrieval eval drives the same
 * functions, so the queries it measures are the queries that ship.
 *
 *  - planInjection: the brief cleaned of Standup's appended blocks
 *    (cleanBrief), then up to MAX_INJECTION_QUERIES queries — the cleaned brief,
 *    its title sentence, the code paths and identifiers it names, and its noun
 *    phrases — plus a task type and the actions the brief forbids.
 *  - fuseRankedLists: RRF over the per-query lists, one entry per doc.
 *  - injectionPlanGate: drops a runbook about an action the brief forbids, and
 *    admits an activity note only when it is relevant and recent.
 */

export type InjectionTaskType = "research" | "implement" | "fix" | "deploy" | "review";

export const INJECTION_TASK_TYPES: readonly InjectionTaskType[] = ["research", "implement", "fix", "deploy", "review"];

/** The most queries one launch's injection searches. */
export const MAX_INJECTION_QUERIES = 4;

/** The longest one injection query runs; a longer brief is cut at a word boundary. */
export const MAX_INJECTION_QUERY_CHARS = 1500;

/** The most code paths and identifiers the identifier query carries. */
export const MAX_IDENTIFIER_TERMS = 8;

/** The most words the noun-phrase query carries. */
export const MAX_PHRASE_QUERY_WORDS = 12;

/** The RRF constant: a doc at rank r of one list scores 1/(k + r). */
export const INJECTION_RRF_K = 60;

/** The relevance an activity note needs to be injected. */
export const ACTIVITY_INJECT_MIN_RELEVANCE = 0.5;

/** The age, in days, past which an activity note is never injected. */
export const ACTIVITY_INJECT_MAX_AGE_DAYS = 30;

/**
 * The relevance a product/spec doc homed outside the launching project (a
 * related project's, or the global corpus's) needs to be injected. Above the
 * plain inject floor: such a doc describes some other product unless the brief
 * is plainly about it, and a match on a few generic words is not that.
 */
export const FOREIGN_INTENT_INJECT_MIN_RELEVANCE = 0.35;

/**
 * An action a brief can forbid; runbooks about it are then left out of the
 * injection. `code_review` is opening or revising a code review (a pull
 * request, merge request, or whatever the org calls one).
 */
export type ForbiddenAction = "code_review" | "deploy" | "push" | "commit";

/** How a brief mentions an action, and how a runbook's title, slug or tags say it is about it. */
export interface ForbiddenActionRule {
  action: ForbiddenAction;
  /** A mention of the action in the brief. */
  mention: RegExp;
  /** A runbook about the action, over its title, slug words and tags. */
  doc: RegExp;
}

/** The code-review nouns every install recognizes, as regex alternatives. */
const BUILTIN_REVIEW_NOUNS: readonly string[] = [
  String.raw`code[\s-]reviews?`,
  String.raw`pull[\s-]requests?`,
  String.raw`prs?`,
  String.raw`merge[\s-]requests?`,
];

/** A literal term as a whole-word regex alternative: escaped, spaces or hyphens interchangeable, optional plural `s`. */
function termAlternative(term: string): string {
  const escaped = term
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/[\s-]+/g, String.raw`[\s-]`);
  return `${escaped}s?`;
}

/** The `\b(?:…)\b` regex over the built-in review nouns and `extra` terms, case-insensitive. */
function reviewNounRegex(extra: readonly string[]): RegExp {
  return new RegExp(String.raw`\b(?:${[...BUILTIN_REVIEW_NOUNS, ...extra].join("|")})\b`, "i");
}

const STATIC_FORBIDDEN_ACTION_RULES: readonly ForbiddenActionRule[] = [
  {
    action: "deploy",
    mention: /\b(?:(?:hand-)?deploy\w*|roll\s*outs?)\b/i,
    doc: /\b(?:deploy\w*|rollouts?|pipelines?)\b/i,
  },
  {
    action: "push",
    mention: /\b(?:git\s+)?push(?:es|ed|ing)?\b/i,
    doc: /\b(?:git[\s-])?push\w*\b/i,
  },
  {
    action: "commit",
    mention: /\bcommit(?:s|ted|ting)?\b/i,
    doc: /\bcommit\w*\b/i,
  },
];

function buildForbiddenActionRules(extraReviewTerms: readonly string[]): readonly ForbiddenActionRule[] {
  const review = reviewNounRegex(extraReviewTerms);
  return [{ action: "code_review", mention: review, doc: review }, ...STATIC_FORBIDDEN_ACTION_RULES];
}

let extraCodeReviewTerms: readonly string[] = [];
let forbiddenActionRuleTable: readonly ForbiddenActionRule[] = buildForbiddenActionRules([]);
let reviewTaskPattern: RegExp = buildReviewTaskPattern([]);

/**
 * Sets the org's own words for one code review (`changeset`, `CL`, …), on top
 * of the built-in "code review", "pull request", "PR" and "merge request".
 * Each term is matched as a whole word, case-insensitively, with an optional
 * plural `s`: a brief that forbids it forbids the `code_review` action, a
 * runbook titled with it is about that action, and "review the <term>" reads
 * as a review task. Replaces the terms set before; `[]` restores the
 * built-ins alone. The collector sets these from the active org profile.
 */
export function setCodeReviewTerms(terms: readonly string[]): void {
  extraCodeReviewTerms = Object.freeze([...terms]);
  const alternatives = terms.filter((t) => t.trim() !== "").map(termAlternative);
  forbiddenActionRuleTable = buildForbiddenActionRules(alternatives);
  reviewTaskPattern = buildReviewTaskPattern(alternatives);
}

/** The org's code-review terms in force, as last passed to setCodeReviewTerms (`[]` for the built-ins alone). */
export function codeReviewTerms(): readonly string[] {
  return extraCodeReviewTerms;
}

/** The forbidden-action rules in force: the code-review rule (with the org's terms) first. */
export function forbiddenActionRules(): readonly ForbiddenActionRule[] {
  return forbiddenActionRuleTable;
}

/** A word or phrase that turns what follows it in the same clause into a prohibition. */
const NEGATION = /\b(?:don['’]?t|do\s+not|never|must\s+not|mustn['’]t|should\s+not|shouldn['’]t|no\s+need\s+to|without|avoid|not\s+to|no)\b/gi;

/** How far past a negation, in characters, its clause can name the forbidden action. */
const NEGATION_REACH = 60;

/** The clauses of a brief: a prohibition reaches only to the end of its own. */
const CLAUSE_BREAK = /[.;!?\n]+/;

/** Whether `clause` forbids the action `mention` names: a negation followed, within reach, by the mention. */
function clauseForbids(clause: string, mention: RegExp): boolean {
  for (const m of clause.matchAll(NEGATION)) {
    const after = clause.slice(m.index! + m[0].length, m.index! + m[0].length + NEGATION_REACH);
    if (mention.test(after)) return true;
  }
  return false;
}

/** Whether `clause` is a prohibition of any table action (and so says nothing about the topic). */
function isProhibitionClause(clause: string): boolean {
  return forbiddenActionRuleTable.some((rule) => clauseForbids(clause, rule.mention));
}

/**
 * The actions `brief` forbids ("don't open PRs", "do not deploy", "no push",
 * "never commit"). A research task also forbids every table action it never
 * mentions outside a prohibition: research opens no pull request and ships nothing, so a
 * runbook about doing so is noise for it.
 */
export function forbiddenActions(brief: string, taskType?: InjectionTaskType): ForbiddenAction[] {
  const clauses = brief.split(CLAUSE_BREAK);
  const out: ForbiddenAction[] = [];
  for (const rule of forbiddenActionRuleTable) {
    const forbidden = clauses.some((c) => clauseForbids(c, rule.mention));
    const mentioned = clauses.some((c) => !clauseForbids(c, rule.mention) && rule.mention.test(c));
    if (forbidden || (taskType === "research" && !mentioned)) out.push(rule.action);
  }
  return out;
}

/** The fields of a doc the forbidden-runbook check reads. */
export interface RunbookFields {
  sourceKind: SourceKind;
  title: string;
  slug: string;
  tags?: readonly string[];
}

/** The forbidden action a runbook is about, or null when it is not a runbook or is about none of them. */
export function forbiddenRunbookAction(doc: RunbookFields, forbidden: readonly ForbiddenAction[]): ForbiddenAction | null {
  if (doc.sourceKind !== "runbook" || forbidden.length === 0) return null;
  const text = `${doc.title} ${doc.slug.replace(/[-_]+/g, " ")} ${(doc.tags ?? []).join(" ")}`;
  for (const rule of forbiddenActionRuleTable) {
    if (forbidden.includes(rule.action) && rule.doc.test(text)) return rule.action;
  }
  return null;
}

/**
 * A Standup-fenced block (`<!-- standup:<name> … -->` … `<!-- /standup:<name> … -->`,
 * the owner-preferences and playbook blocks), and an opening marker whose block
 * is cut off, which runs to the end of the text.
 */
const FENCED_BLOCK = /<!--\s*standup:([a-z-]+)\b[^>]*-->[\s\S]*?(?:<!--\s*\/standup:\1\b[^>]*-->|$)/g;

/** A line that is only a horizontal rule: Standup separates every block it appends to a brief with one. */
const APPENDED_SEPARATOR = /^\s*-{3,}\s*$/m;

/**
 * Lines that are dispatch or steering boilerplate, not the task: the ticket
 * dispatch's "Implement this fix.", the delivery-pipeline and knowledge-first
 * instructions, which name Standup's own tools.
 */
const BOILERPLATE_LINES: readonly RegExp[] = [
  /^\s*(?:implement|fix|do|complete|handle)\s+(?:this|the)\s+(?:fix|task|ticket|issue|change)\.?\s*$/i,
  /\bdelivery[\s-]pipeline\b/i,
  /\b(?:pipeline_advance|pipeline_status|pipeline_park|mark_ready_for_review|submit_review_packet|submit_plan|report_task)\b/,
  /\b(?:search_knowledge|get_knowledge_doc|graph_neighbors|propose_knowledge)\b/,
];

/**
 * The task text of a brief: Standup's fenced blocks removed, everything after
 * the first appended `---` separator dropped (when the text before it holds
 * the task), boilerplate lines and prohibition clauses dropped, whitespace
 * collapsed. Falls back to the whitespace-collapsed brief when nothing is left.
 */
export function cleanBrief(brief: string): string {
  let text = brief.replace(FENCED_BLOCK, "\n");
  const sep = APPENDED_SEPARATOR.exec(text);
  if (sep && text.slice(0, sep.index).trim()) text = text.slice(0, sep.index);
  const lines = text
    .split("\n")
    .filter((line) => !BOILERPLATE_LINES.some((re) => re.test(line)))
    .map((line) =>
      line
        .split(/(?<=[.;!?])\s+/)
        .filter((clause) => !isProhibitionClause(clause))
        .join(" ")
    );
  const cleaned = lines.join("\n").replace(/\s+/g, " ").trim();
  return cleaned || brief.replace(/\s+/g, " ").trim();
}

/** `text` cut to `max` characters at a word boundary. */
function capChars(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return (space > max / 2 ? cut.slice(0, space) : cut).trim();
}

/** The brief's title: its markdown heading or short first line, else its first sentence. */
export function briefTitle(cleaned: string, raw: string = cleaned): string {
  const firstLine = raw.replace(FENCED_BLOCK, "\n").split("\n").find((l) => l.trim())?.trim() ?? "";
  const heading = /^#{1,6}\s+(.+)$/.exec(firstLine);
  if (heading) return heading[1]!.trim();
  const sentence = cleaned.split(/(?<=[.!?])\s+/)[0] ?? cleaned;
  return sentence.replace(/[.!?]+$/, "").trim();
}

/** Spans a brief names code with: backticks, paths, file names and non-prose identifiers. */
const IDENTIFIER_PATTERNS: readonly RegExp[] = [
  /`([^`\n]{2,80})`/g,
  /(?:^|[\s(])((?:[\w.-]+\/)+[\w.-]+)/g,
  /\b([\w-]+\.(?:ts|tsx|js|jsx|mjs|py|java|kt|go|rs|rb|md|json|ya?ml|toml|sql|sh))\b/g,
  /(?:^|[^\w#/])([a-z][a-z0-9]*[A-Z][A-Za-z0-9]*)\b/g,
  /\b([A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*)\b/g,
  /\b([a-z][a-z0-9]*_[a-z0-9_]+)\b/g,
  /\b([A-Z][A-Z0-9]*_[A-Z0-9_]+)\b/g,
];

/** The code paths and identifiers `text` names, in order of first appearance, deduplicated. */
export function namedIdentifiers(text: string): string[] {
  const found: { term: string; at: number }[] = [];
  for (const re of IDENTIFIER_PATTERNS) {
    for (const m of text.matchAll(re)) {
      const term = m[1]!.trim().replace(/[.,:;]+$/, "");
      if (term.length >= 3) found.push({ term, at: m.index! });
    }
  }
  found.sort((a, b) => a.at - b.at);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const { term } of found) {
    const key = term.toLowerCase();
    if (seen.has(key) || [...seen].some((s) => s.includes(key))) continue;
    seen.add(key);
    out.push(term);
    if (out.length >= MAX_IDENTIFIER_TERMS) break;
  }
  return out;
}

/** Function words and task verbs, which separate noun phrases. */
const PHRASE_STOPWORDS = new Set(
  (
    "a an the and or but nor so of to in on at by for from with without into onto over under about as is are was " +
    "were be been being it its this that these those there here then than when where which who whom whose what how " +
    "why while each every any all some no not only also just very more most less least such same other own new one " +
    "two first last before after above below between through during so if else must should would could can may might " +
    "will shall do does did done doing have has had having i we you they he she them us our your their my me " +
    "add adds added adding make makes made making fix fixes fixed fixing change changes changed changing update " +
    "updates updated updating remove removes removed removing keep keeps kept confirm confirms ensure ensures turn " +
    "turns use uses used using follow following run runs running cover covers get gets set sets let lets put " +
    "need needs want wants try tries start starts stay stays send sending sent instead way ways right existing " +
    "implement implements implemented implementing create creates created creating support supports"
  ).split(" ")
);

/** The noun phrases of `text`: runs of content words between stopwords and punctuation, longest first in order. */
export function nounPhrases(text: string): string[] {
  const phrases: string[] = [];
  for (const segment of text.split(/[.,;:!?()[\]{}"“”'`]+|\s[-–—]\s/)) {
    let run: string[] = [];
    const flush = () => {
      const keep = run.length >= 2 || (run.length === 1 && /[A-Z]/.test(run[0]!.slice(1)));
      if (keep) phrases.push(run.join(" "));
      run = [];
    };
    for (const raw of segment.split(/\s+/)) {
      const word = raw.replace(/^[^\w#]+|[^\w]+$/g, "");
      if (!word || PHRASE_STOPWORDS.has(word.toLowerCase()) || /^\d+$/.test(word)) flush();
      else run.push(word);
    }
    flush();
  }
  return phrases;
}

/** The noun-phrase query: phrases in order until MAX_PHRASE_QUERY_WORDS words, deduplicated by word. */
function phraseQuery(text: string): string {
  const words: string[] = [];
  const seen = new Set<string>();
  for (const phrase of nounPhrases(text)) {
    const fresh = phrase.split(" ").filter((w) => !seen.has(w.toLowerCase()));
    if (fresh.length === 0) continue;
    if (words.length + fresh.length > MAX_PHRASE_QUERY_WORDS) break;
    for (const w of fresh) seen.add(w.toLowerCase());
    words.push(...fresh);
  }
  return words.join(" ");
}

/** The leading verb of a task title, mapped to its task type. */
const LEAD_VERB_TYPES: Readonly<Record<string, InjectionTaskType>> = {
  research: "research",
  investigate: "research",
  compare: "research",
  evaluate: "research",
  study: "research",
  survey: "research",
  explore: "research",
  analyze: "research",
  analyse: "research",
  diagnose: "research",
  explain: "research",
  find: "research",
  measure: "research",
  fix: "fix",
  debug: "fix",
  repair: "fix",
  resolve: "fix",
  deploy: "deploy",
  release: "deploy",
  ship: "deploy",
  rollout: "deploy",
  roll: "deploy",
  review: "review",
  audit: "review",
  critique: "review",
};

/** "Review the <thing>": the built-in review objects plus the org's own code-review terms. */
function buildReviewTaskPattern(extraReviewTerms: readonly string[]): RegExp {
  const objects = [
    String.raw`prs?`,
    String.raw`pull\s+requests?`,
    String.raw`merge\s+requests?`,
    String.raw`diffs?`,
    String.raw`changes?`,
    String.raw`patch\w*`,
    "code",
    ...extraReviewTerms,
  ];
  return new RegExp(String.raw`\b(?:review|audit)\s+(?:the\s+|this\s+|a\s+)?(?:${objects.join("|")})\b`, "i");
}

/** Task types by what a brief says anywhere, in priority order; a brief matching none is `implement`. */
function taskTypePatterns(): readonly { type: InjectionTaskType; pattern: RegExp }[] {
  return [
    { type: "fix", pattern: /\b(?:fix\w*|bugs?|broken|regressions?|crash\w*|fails?|failing|failures?|dropped|wrong)\b/i },
    { type: "research", pattern: /\b(?:research|investigat\w+|compar\w+|analy[sz]\w+|study|survey|why\s+(?:does|do|is|did))\b/i },
    { type: "review", pattern: reviewTaskPattern },
    { type: "deploy", pattern: /^\s*(?:deploy|release|roll\s*out)\b/i },
  ];
}

/** The task type of a brief: its title's leading verb, else the first taskTypePatterns() match, else `implement`. */
export function classifyTaskType(cleaned: string, title: string = briefTitle(cleaned)): InjectionTaskType {
  const lead = /^[^A-Za-z]*([A-Za-z]+)/.exec(title)?.[1]?.toLowerCase();
  if (lead && LEAD_VERB_TYPES[lead]) return LEAD_VERB_TYPES[lead]!;
  const patterns = taskTypePatterns();
  for (const { type, pattern } of patterns) if (pattern.test(title)) return type;
  for (const { type, pattern } of patterns) if (pattern.test(cleaned)) return type;
  return "implement";
}

/** A launch's injection plan: what it searches, what kind of task it is and what the task forbids. */
export interface InjectionPlan {
  /** 1 to MAX_INJECTION_QUERIES distinct queries, the cleaned brief first. */
  queries: string[];
  taskType: InjectionTaskType;
  forbidden: ForbiddenAction[];
  /** Whether the focused queries and task type came from the model step or the heuristic. */
  source: "heuristic" | "model";
}

/** The focused queries and task type a model rewrite returned (parseModelRewrite). */
export interface ModelRewrite {
  taskType: InjectionTaskType;
  queries: string[];
}

/** `queries` trimmed, blanks and case-insensitive duplicates dropped, capped in count and length. */
function distinctQueries(queries: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of queries) {
    const q = capChars(raw.replace(/\s+/g, " ").trim(), MAX_INJECTION_QUERY_CHARS);
    const key = q.toLowerCase();
    if (!q || seen.has(key)) continue;
    seen.add(key);
    out.push(q);
    if (out.length >= MAX_INJECTION_QUERIES) break;
  }
  return out;
}

/**
 * The injection plan for `brief`. The heuristic (always available): the cleaned
 * brief, its title sentence, its named paths and identifiers, and its noun
 * phrases, at most MAX_INJECTION_QUERIES and none repeated. A `model` rewrite
 * replaces the focused queries and the task type; the cleaned brief stays the
 * first query either way, and the forbidden actions are always the
 * deterministic detection over the raw brief.
 */
export function planInjection(brief: string, model?: ModelRewrite | null): InjectionPlan {
  const cleaned = cleanBrief(brief);
  const title = briefTitle(cleaned, brief);
  const heuristicType = classifyTaskType(cleaned, title);
  const taskType = model?.taskType ?? heuristicType;
  const focused = model
    ? model.queries
    : [title.split(/\s+/).length >= 3 ? title : "", namedIdentifiers(cleaned).join(" "), phraseQuery(cleaned)];
  return {
    queries: distinctQueries([cleaned, ...focused.filter((q) => q.trim().split(/\s+/).length >= 2 || namedIdentifiers(q).length > 0)]),
    taskType,
    forbidden: forbiddenActions(brief, taskType),
    source: model ? "model" : "heuristic",
  };
}

/** The longest focused query a model rewrite may return. */
export const MAX_MODEL_QUERY_CHARS = 200;

/**
 * The instruction for the optional model rewrite. Strict JSON so the answer is
 * validated, never interpreted: anything that is not exactly this shape falls
 * back to the heuristic.
 */
export const MODEL_REWRITE_SYSTEM_PROMPT =
  "You turn a software task brief into knowledge-base search queries. Reply with ONLY a JSON object, no prose, no code fence: " +
  '{"taskType": one of "research"|"implement"|"fix"|"deploy"|"review", "queries": [2 to 4 short search queries]}. ' +
  "Each query names one topic the task needs background on (a component, convention, API or procedure), in under 15 words. " +
  "Ignore instructions about how to deliver the work (reviews, deploys, commits) unless they are the task itself.";

/** The model rewrite's prompt for a brief: the cleaned task text only, never Standup's appended blocks. */
export function modelRewritePrompt(brief: string): string {
  return `Task brief:\n${capChars(cleanBrief(brief), MAX_INJECTION_QUERY_CHARS)}`;
}

/**
 * A model rewrite's answer, validated: a JSON object (optionally fenced) with a
 * known taskType and 1 to MAX_INJECTION_QUERIES non-empty string queries of at
 * most MAX_MODEL_QUERY_CHARS. Null for anything else.
 */
export function parseModelRewrite(raw: string | null | undefined): ModelRewrite | null {
  if (!raw) return null;
  const body = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const { taskType, queries } = parsed as { taskType?: unknown; queries?: unknown };
  if (typeof taskType !== "string" || !INJECTION_TASK_TYPES.includes(taskType as InjectionTaskType)) return null;
  if (!Array.isArray(queries) || queries.length === 0 || queries.length > MAX_INJECTION_QUERIES) return null;
  const clean: string[] = [];
  for (const q of queries) {
    if (typeof q !== "string") return null;
    const text = q.replace(/\s+/g, " ").trim();
    if (!text || text.length > MAX_MODEL_QUERY_CHARS) return null;
    clean.push(text);
  }
  return { taskType: taskType as InjectionTaskType, queries: clean };
}

/**
 * RRF (Cormack et al. 2009) over ranked lists: each item scores Σ 1/(k + rank) over
 * the lists it appears in (rank from 1), one entry per `keyOf`, highest first;
 * ties keep the order of first appearance. The entry kept for a key is the one
 * `prefer` ranks higher (default: the first seen).
 */
export function fuseRankedLists<T>(
  lists: readonly (readonly T[])[],
  keyOf: (item: T) => string,
  prefer: (a: T, b: T) => boolean = () => false,
  k: number = INJECTION_RRF_K
): T[] {
  const fused = new Map<string, { item: T; score: number; order: number }>();
  let order = 0;
  for (const list of lists) {
    list.forEach((item, i) => {
      const key = keyOf(item);
      const entry = fused.get(key);
      const add = 1 / (k + i + 1);
      if (!entry) fused.set(key, { item, score: add, order: order++ });
      else {
        entry.score += add;
        if (prefer(item, entry.item)) entry.item = item;
      }
    });
  }
  return [...fused.values()].sort((a, b) => b.score - a.score || a.order - b.order).map((e) => e.item);
}

/**
 * Fuses per-query search results for injection: RRF by doc id, keeping each
 * doc's most relevant instance, so a doc's gates read the relevance of the
 * query it answers best.
 */
export function fuseInjectionResults(lists: readonly (readonly SearchResult[])[]): SearchResult[] {
  return fuseRankedLists(
    lists,
    (r) => r.id,
    (a, b) => (a.relevance ?? 0) > (b.relevance ?? 0)
  );
}

/**
 * One query's injection candidates: the family's hits with the activity notes
 * the same query found merged in by score, keeping only notes in the activity
 * layer (a native-memory CLAUDE.md mirror is loaded natively, never injected).
 */
export function mergeActivityHits(hits: readonly SearchResult[], activity: readonly SearchResult[]): SearchResult[] {
  const notes = activity.filter((r) => layerOf(r) === "activity");
  if (notes.length === 0) return [...hits];
  return [...hits, ...notes].sort((a, b) => b.score - a.score);
}

/** The fields of a fused candidate the activity gate reads. */
export type ActivityGateHit = Pick<SearchResult, "relevance" | "writtenAt"> & Parameters<typeof layerOf>[0];

/**
 * Whether a doc may be injected into a launch for `projectId` by where it is
 * homed: a product/spec doc homed in another project or the global corpus
 * needs relevance at least FOREIGN_INTENT_INJECT_MIN_RELEVANCE. True for the
 * project's own docs and any doc outside the intent layer.
 */
export function foreignIntentAdmissible(
  r: Pick<SearchResult, "relevance" | "projectId"> & Parameters<typeof layerOf>[0],
  projectId: string
): boolean {
  if (layerOf(r) !== "intent" || r.projectId === projectId) return true;
  return (r.relevance ?? 0) >= FOREIGN_INTENT_INJECT_MIN_RELEVANCE;
}

/**
 * Whether an activity note may be injected: relevance at least
 * ACTIVITY_INJECT_MIN_RELEVANCE and written less than ACTIVITY_INJECT_MAX_AGE_DAYS
 * before `now`. A note with no write date is never admitted. True for any doc
 * outside the activity layer.
 */
export function activityAdmissible(r: ActivityGateHit, now: Date): boolean {
  if (layerOf(r) !== "activity") return true;
  if ((r.relevance ?? 0) < ACTIVITY_INJECT_MIN_RELEVANCE || !r.writtenAt) return false;
  const written = Date.parse(r.writtenAt);
  if (!Number.isFinite(written)) return false;
  return now.getTime() - written < ACTIVITY_INJECT_MAX_AGE_DAYS * 86_400_000;
}

/** Why the injection plan holds a fused candidate back. */
export type InjectionPlanDropReason = "forbidden" | "activity";

/**
 * The plan gate over one fused candidate: `forbidden` for a runbook about an
 * action the brief forbids, `activity` for an activity note that is not
 * relevant or recent enough, null when it passes. `tagsOf` reads a doc's
 * stored tags; omitted, only the title and slug are matched.
 */
export function injectionPlanGate(
  r: SearchResult,
  plan: Pick<InjectionPlan, "forbidden">,
  now: Date,
  tagsOf?: (r: SearchResult) => readonly string[] | undefined
): InjectionPlanDropReason | null {
  if (forbiddenRunbookAction({ ...r, tags: plan.forbidden.length > 0 ? tagsOf?.(r) : undefined }, plan.forbidden)) {
    return "forbidden";
  }
  if (!activityAdmissible(r, now)) return "activity";
  return null;
}

/** One line naming a plan's task type, source and queries, for the launch log. */
export function describeInjectionPlan(plan: InjectionPlan): string {
  const forbidden = plan.forbidden.length > 0 ? `; forbids ${plan.forbidden.join(", ")}` : "";
  return `${plan.taskType} task (${plan.source} rewrite${forbidden}): ${plan.queries.map((q) => JSON.stringify(capChars(q, 120))).join(" | ")}`;
}
