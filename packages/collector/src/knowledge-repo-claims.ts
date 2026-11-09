import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  draftFileExists,
  evidenceCap,
  KnowledgeStore,
  layerOf,
  writeDraftFile,
  type KnowledgeDoc,
  type KnowledgeDraftInput,
} from "@standup/knowledge";
import { getProjects } from "@standup/store";
import type { DraftDispute } from "./draft-verify.js";
import { readProjectFreshness, replaceProjectFreshness } from "./knowledge-freshness.js";
import { codeReviewRemote } from "./code-review/adapter.js";
import {
  BRANCH_CODE_PATHSPEC,
  changesPresentIn,
  contentDate,
  deriveNamedPaths,
  deriveNamedSymbols,
  hasProvenance,
  isRepoRoot,
  newMergeCheckCache,
  patchIds,
  primaryRepoPath,
  refPatchIdsSince,
  RepoEvidenceContext,
  squashedInto,
  type GitLineRunner,
  type GitStatusRunner,
  type MergeCheckCache,
} from "./knowledge-staleness.js";

/**
 * Claims a doc makes about the state of its own repository — a commit merged
 * or not, a symbol implemented or not — checked against git as part of the
 * doc's fact-check. A refuted claim is a finding on THAT doc (a dispute tagged
 * `origin: "git"`, with the command that refutes it) for a human to read; it
 * never counts as evidence against the doc anywhere else (see
 * knowledge-publish-verify.ts and the loser rule in knowledge-coherence.ts).
 *
 * Every check errs toward "can't tell":
 * - "merged" / "not merged" is about the repository's DEFAULT branch
 *   (origin/HEAD, else main / master / mainline), never the HEAD of the
 *   checkout the doc was written in, which is often a feature branch. A commit
 *   counts as merged when it is an ancestor of that branch, when an equivalent
 *   patch is (`git cherry`), or when the branch already holds its changes (a
 *   multi-commit squash). A claimed merge is refuted only when the patch is
 *   non-empty, every file it touches still exists on the branch, and the patch
 *   still applies on top of it. A claim that mentions a revert is not checked.
 * - A symbol counts as present only for a match in code — docs, comment lines
 *   and block-comment interiors are ignored — and a claim the sentence places in
 *   another package, repository or directory is not checked at all.
 */

/** A claim about the repository a git command can settle. */
export interface RepoStateClaim {
  /** `merged`: the commit is in HEAD. `unmerged`: it is not. `present` /
   *  `absent`: the symbol exists in the code at HEAD or does not. */
  kind: "merged" | "unmerged" | "present" | "absent";
  /** The commit sha or symbol name. */
  key: string;
  /** The sentence the claim was read from. */
  sentence: string;
}

const SHA = String.raw`\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])([0-9a-f]{7,40})\b`;
const SYMBOL = "`([A-Za-z_][A-Za-z0-9_]{2,})(?:\\(\\))?`";
const CLAIM_PATTERNS: ReadonlyArray<{ kind: RepoStateClaim["kind"]; re: RegExp }> = [
  { kind: "unmerged", re: new RegExp(String.raw`\b(?:not (?:yet )?(?:merged|committed|landed)|unmerged|uncommitted)\b[^.\n]{0,60}?${SHA}`, "gi") },
  { kind: "unmerged", re: new RegExp(String.raw`${SHA}[^.\n]{0,40}?\b(?:not (?:yet )?(?:merged|committed|landed)|unmerged|uncommitted)\b`, "gi") },
  { kind: "absent", re: new RegExp(String.raw`${SYMBOL}[^.\n]{0,40}?\b(?:is not|isn't|was never|has not been|hasn't been|not yet|is not yet)\s+(?:implemented|added|wired|written)\b`, "g") },
  { kind: "absent", re: new RegExp(String.raw`\b(?:not (?:yet )?implemented|unimplemented|does not exist|doesn't exist)\b[^.\n]{0,20}?${SYMBOL}`, "g") },
  { kind: "merged", re: new RegExp(String.raw`\b(?:merged|landed|committed|shipped)\b[^.\n]{0,60}?${SHA}`, "gi") },
  { kind: "merged", re: new RegExp(String.raw`${SHA}[^.\n]{0,40}?\b(?:merged|landed)\b`, "gi") },
  { kind: "present", re: new RegExp(String.raw`${SYMBOL}[^.\n]{0,40}?\b(?:is|was|has been|is now|now)\s+(?:implemented|merged|added|wired|shipped)\b`, "g") },
];

/** A sentence that places its claim in some other package, repo or service. */
const ELSEWHERE = new RegExp(
  [
    String.raw`\b(?:in|into|from|of)\s+(?:the\s+)?[\w./@-]+\s+(?:package|repo|repository|service|module|app|project|crate|library)\b`,
    // "wired in web", "implemented in packages/web": a place named right after the verb.
    String.raw`\b(?:wired|implemented|added|merged|shipped|landed|written)\s+(?:in|into)\s+(?:the\s+)?(?![0-9a-f]{7,40}\b)(?!(?:commit|main|master|mainline|trunk|HEAD|the default branch)\b)[A-Za-z][\w./@-]*`,
  ].join("|"),
  "i"
);

/** A sentence about a revert: whether its commit is "merged" depends on which
 *  side of the revert is meant, so it is not checked. */
const REVERTED = /\brevert|\banymore\b|\bno longer\b/i;

/** The sentence around offset `at`. */
function sentenceAt(body: string, at: number): string {
  const start = Math.max(body.lastIndexOf(".", at), body.lastIndexOf("\n", at)) + 1;
  const ends = [body.indexOf(".", at), body.indexOf("\n", at)].filter((i) => i !== -1);
  const end = ends.length > 0 ? Math.min(...ends) : body.length;
  return body.slice(start, end).trim();
}

/**
 * The repository-state claims a doc body makes, one per commit or symbol. The
 * negated patterns run first, so "abc1234 is not merged yet" is read as
 * `unmerged` and never also as `merged`.
 */
export function extractRepoStateClaims(body: string): RepoStateClaim[] {
  const out: RepoStateClaim[] = [];
  const claimed = new Set<string>();
  for (const { kind, re } of CLAIM_PATTERNS) {
    re.lastIndex = 0;
    for (const m of body.matchAll(re)) {
      const key = m[1]!;
      if (claimed.has(key)) continue;
      claimed.add(key);
      out.push({ kind, key, sentence: sentenceAt(body, m.index ?? 0) });
    }
  }
  return out;
}

/** Answers repository questions at HEAD; null when the question can't be
 *  settled. Injected so the claim logic is testable without git. */
export interface RepoProbe {
  /** True when the default branch holds the commit's changes, false when they
   *  demonstrably do not, null when unknown (no default branch, an unknown
   *  commit, files changed since). */
  commitInDefaultBranch(repo: string, sha: string): Promise<boolean | null>;
  /** Whether the symbol appears in code (not docs, not comments) at HEAD. */
  symbolInCode(repo: string, symbol: string): Promise<boolean | null>;
}

/** Output larger than this (a huge commit's patch) is treated as "can't tell". */
const MAX_GIT_OUTPUT = 2_000_000;

interface GitResult {
  code: number | null;
  stdout: string;
}

async function git(repo: string, args: string[], env?: Record<string, string>, stdin?: string): Promise<GitResult> {
  try {
    const proc = Bun.spawn(["git", "-C", repo, ...args], {
      stdout: "pipe",
      stderr: "ignore",
      stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
      env: env ? { ...process.env, ...env } : undefined,
    });
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (stdout.length > MAX_GIT_OUTPUT) return { code: null, stdout: "" };
    return { code, stdout };
  } catch {
    return { code: null, stdout: "" };
  }
}

/**
 * The repository's default branch ref: origin/HEAD's target, unless the local
 * branch of the same name holds everything it has and more (a host that merges
 * locally and never pushes) — then that local branch, unless origin is on a
 * code-review host, where local commits ahead are still in review (as in newestMainline,
 * knowledge-mainline.ts). Without origin/HEAD, the first of main, master,
 * mainline that exists. Null when there is none.
 */
export async function defaultBranch(repo: string): Promise<string | null> {
  const origin = await git(repo, ["symbolic-ref", "-q", "refs/remotes/origin/HEAD"]);
  const remote = origin.code === 0 ? origin.stdout.trim() : "";
  if (remote) {
    if (codeReviewRemote((await git(repo, ["remote", "get-url", "origin"])).stdout.trim())) return remote;
    const local = `refs/heads/${remote.replace(/^refs\/remotes\/[^/]+\//, "")}`;
    const exists = (await git(repo, ["rev-parse", "-q", "--verify", `${local}^{commit}`])).code === 0;
    if (exists && (await git(repo, ["merge-base", "--is-ancestor", remote, local])).code === 0) return local;
    return remote;
  }
  for (const name of ["main", "master", "mainline"]) {
    if ((await git(repo, ["rev-parse", "-q", "--verify", `refs/heads/${name}`])).code === 0) return `refs/heads/${name}`;
  }
  return null;
}

/** The commit's own patch, text only (no external diff or textconv drivers). */
async function commitPatch(repo: string, sha: string): Promise<string | null> {
  const patch = await git(repo, ["diff", "--no-ext-diff", "--no-textconv", "--binary", `${sha}^`, sha]);
  return patch.code === 0 && patch.stdout.trim() ? patch.stdout : null;
}

/** Whether `patch` applies to `ref`'s tree, forward or reversed — checked
 *  against a scratch index so the working tree and its index are never touched. */
async function patchApplies(repo: string, ref: string, patch: string, reverse: boolean): Promise<boolean | null> {
  const dir = mkdtempSync(join(tmpdir(), "standup-repo-claims-"));
  try {
    const env = { GIT_INDEX_FILE: join(dir, "index") };
    if ((await git(repo, ["read-tree", ref], env)).code !== 0) return null;
    const check = await git(repo, ["apply", "--cached", "--check", ...(reverse ? ["-R"] : [])], env, patch);
    return check.code === null ? null : check.code === 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Whether every file the commit touches still exists on `ref`. */
async function touchedFilesExist(repo: string, ref: string, sha: string): Promise<boolean> {
  const names = await git(repo, ["diff", "--no-ext-diff", "--name-only", `${sha}^`, sha]);
  if (names.code !== 0) return false;
  const files = names.stdout.split("\n").filter(Boolean);
  if (files.length === 0) return false;
  for (const f of files) {
    if ((await git(repo, ["cat-file", "-e", `${ref}:${f}`])).code !== 0) return false;
  }
  return true;
}

/** Lines that are comments in the common languages (and markdown-ish quotes). */
const COMMENT_LINE = /^\s*(?:\/\/|#|\*|\/\*|<!--|--|;|>)/;

/**
 * 1-based line numbers that begin inside a block comment (slash-star or HTML)
 * of `text` — a comment's interior and closing lines. (A line that opens one is
 * a comment line when the opener leads it, which COMMENT_LINE already catches.)
 */
function blockCommentLines(text: string): Set<number> {
  const inside = new Set<number>();
  let close: string | null = null;
  text.split("\n").forEach((line, i) => {
    if (close !== null) inside.add(i + 1);
    let rest = line;
    for (;;) {
      if (close === null) {
        const c = rest.indexOf("/*");
        const h = rest.indexOf("<!--");
        if (c === -1 && h === -1) break;
        const useC = c !== -1 && (h === -1 || c < h);
        close = useC ? "*/" : "-->";
        rest = rest.slice((useC ? c : h) + (useC ? 2 : 4));
      } else {
        const end = rest.indexOf(close);
        if (end === -1) break;
        rest = rest.slice(end + close.length);
        close = null;
      }
    }
  });
  return inside;
}

/** Files read to find block comments per symbol check. */
const MAX_FILES_READ = 20;

/** Paths whose mentions are documentation, not code. */
const NON_CODE_PATHSPECS = [
  ":(exclude)*.md",
  ":(exclude)*.mdx",
  ":(exclude)*.txt",
  ":(exclude)*.rst",
  ":(exclude)docs/**",
  ":(exclude)doc/**",
  ":(exclude)plan/**",
];

/** The production probe over a git checkout. */
export const gitRepoProbe: RepoProbe = {
  async commitInDefaultBranch(repo, sha) {
    if ((await git(repo, ["cat-file", "-e", `${sha}^{commit}`])).code !== 0) return null;
    const ref = await defaultBranch(repo);
    if (!ref) return null;
    if ((await git(repo, ["merge-base", "--is-ancestor", sha, ref])).code === 0) return true;
    // An equivalent patch already on the branch (cherry-pick, one-commit squash).
    const cherry = await git(repo, ["cherry", ref, sha, `${sha}^`]);
    if (cherry.code === 0 && /^-\s/m.test(cherry.stdout)) return true;
    const patch = await commitPatch(repo, sha);
    if (!patch) return null;
    // The branch already holds the changes (a multi-commit squash).
    if ((await patchApplies(repo, ref, patch, true)) === true) return true;
    // Refuted only when the changes demonstrably are not there: every file the
    // commit touches still exists, and its patch still applies on top.
    if (!(await touchedFilesExist(repo, ref, sha))) return null;
    return (await patchApplies(repo, ref, patch, false)) === true ? false : null;
  },
  async symbolInCode(repo, symbol) {
    const res = await git(repo, ["grep", "-n", "-w", "-F", symbol, "HEAD", "--", ".", ...NON_CODE_PATHSPECS]);
    if (res.code === 1) return false;
    if (res.code !== 0) return null;
    // Lines read HEAD:<path>:<line>:<text>.
    const hits = res.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [, path = "", lineNo = "0", ...text] = line.split(":");
        return { path, line: Number(lineNo), text: text.join(":") };
      })
      .filter((h) => !COMMENT_LINE.test(h.text));
    const blocks = new Map<string, Set<number>>();
    for (const hit of hits) {
      if (!blocks.has(hit.path)) {
        if (blocks.size >= MAX_FILES_READ) return null;
        const file = await git(repo, ["show", `HEAD:${hit.path}`]);
        blocks.set(hit.path, file.code === 0 ? blockCommentLines(file.stdout) : new Set());
      }
      if (!blocks.get(hit.path)!.has(hit.line)) return true;
    }
    return false;
  },
};

/**
 * Whether git refutes a claim across `repos` (the doc's checkout first, then
 * the project's other repos): a merge claim against the checkout it was
 * written in; a symbol claim against all of them — present nowhere refutes
 * "implemented", present anywhere refutes "not implemented".
 */
async function refutes(probe: RepoProbe, repos: readonly string[], claim: RepoStateClaim): Promise<boolean> {
  if (ELSEWHERE.test(claim.sentence)) return false;
  switch (claim.kind) {
    case "merged":
    case "unmerged": {
      if (REVERTED.test(claim.sentence)) return false;
      const inHead = await probe.commitInDefaultBranch(repos[0]!, claim.key);
      if (inHead === null) return false;
      return claim.kind === "merged" ? !inHead : inHead;
    }
    case "present":
    case "absent": {
      const answers = await Promise.all(repos.map((r) => probe.symbolInCode(r, claim.key)));
      if (claim.kind === "absent") return answers.some((a) => a === true);
      return answers.length > 0 && answers.every((a) => a === false);
    }
  }
}

function finding(claim: RepoStateClaim): { finding: string; evidence: string } {
  switch (claim.kind) {
    case "merged":
      return {
        finding: `${claim.key} is not on the default branch: its changes still apply on top of it`,
        evidence: `git merge-base --is-ancestor ${claim.key} <default branch>; git diff ${claim.key}^ ${claim.key} | git apply --check`,
      };
    case "unmerged":
      return {
        finding: `the default branch already contains ${claim.key}`,
        evidence: `git merge-base --is-ancestor ${claim.key} <default branch>`,
      };
    case "present":
      return {
        finding: `no code at HEAD names \`${claim.key}\``,
        evidence: `git grep -w ${claim.key} HEAD -- . ':(exclude)*.md'`,
      };
    case "absent":
      return {
        finding: `code at HEAD defines or uses \`${claim.key}\``,
        evidence: `git grep -n -w ${claim.key} HEAD -- . ':(exclude)*.md'`,
      };
  }
}

/** The fact-check disputes for the repository-state claims of `body` that git
 *  refutes. `repos` lists the doc's checkout first. */
export async function repoStateDisputes(
  body: string,
  repos: readonly string[],
  probe: RepoProbe = gitRepoProbe
): Promise<DraftDispute[]> {
  if (repos.length === 0) return [];
  const out: DraftDispute[] = [];
  for (const claim of extractRepoStateClaims(body).slice(0, 8)) {
    if (await refutes(probe, repos, claim)) out.push({ claim: claim.sentence, ...finding(claim), origin: "git" });
  }
  return out;
}

// ── Branch merge-state claims ────────────────────────────────────────────────
//
// "On branch X, not yet merged" goes stale the day X lands, and X usually
// lands as a rebased copy (new shas, same patches) after which X is deleted —
// so an ancestry check never sees it land. The landing check is by content:
//
// 1. X still exists (locally or on a remote): its patches reached a default
//    branch when every commit of X has a patch-identical copy there (`git
//    cherry`, all `-`), when X's combined diff is one commit there (a squash),
//    when every line X adds is there (re-applied, squashed with edits), or
//    when X's tip is reachable from it through a merge. A `-continue-`/
//    `-packet-` or relaunched sibling of X counts the same. Landed only when
//    every path and symbol the doc names is also on that branch now; patches
//    that reached it without them are `dropped` (the design changed after it
//    landed). Commits `git cherry` lists as `+` make it unmerged, unless every
//    name the doc uses is on the default branch now and one of them was added
//    on X since its base — then landed by content (below).
// 2. X is gone, unnamed, or its tip sits on the default branch's own line
//    (nothing committed on it yet): judged from the doc itself.
//    - Its generated_from_sha is off the default branch: landed when every
//      commit from the merge base up to the sha (at most
//      LANDING_MAX_BRANCH_COMMITS) has a patch-identical copy among the
//      MERGE_SEARCH_WINDOW default-branch commits since that base, or the
//      sha's combined diff is one commit there — AND every path and symbol the
//      doc names is on the default branch.
//    - Its sha is on the default branch (the doc was written before the
//      branch's work was committed), or it has none: landed when at least one
//      path or symbol the doc names was absent from the default branch at that
//      commit (else at the doc's date) and every one it names is there now.
//      This inference (via "content") writes the review draft but does not
//      mark the doc as landed (isConfirmedLanding) until the draft is accepted.
// Anything else is "unknown" and changes nothing: a claim is only expired on
// evidence that the work itself is on the default branch.

/** A sentence saying work is not merged yet. */
export interface BranchMergeClaim {
  /** The branch the sentence names, or null when it names none. */
  branch: string | null;
  /** The sentence the claim was read from, as written. */
  sentence: string;
  /** The words that make it a not-merged claim, as written. */
  phrase: string;
}

/** Phrases that say work is still waiting to land. */
const PENDING_MERGE = [
  String.raw`not\s+(?:yet\s+)?(?:merged|landed)\s+yet`,
  String.raw`not\s+yet\s+(?:merged|landed)`,
  String.raw`(?:isn['’]t|aren['’]t)\s+(?:merged|landed)\s+yet`,
  String.raw`(?:hasn['’]t|has\s+not|haven['’]t|have\s+not)\s+(?:yet\s+)?been\s+(?:merged|landed)`,
  String.raw`(?:pending|awaiting)\s+(?:a\s+|the\s+|its\s+)?merge`,
  String.raw`yet\s+to\s+(?:be\s+merged|land)`,
].join("|");
/** Phrases that say work is not merged, without saying it is on its way. */
const NOT_MERGED = String.raw`not\s+merged|(?:isn['’]t|aren['’]t)\s+merged|unmerged`;
const MERGE_STATE_PHRASE = new RegExp(String.raw`\b(?:(${PENDING_MERGE})|${NOT_MERGED})\b`, "gi");

/** A sentence describing what happens in some case, not the state of some work. */
const CONDITIONAL = /\b(?:if|unless|whether|when|whenever)\b/i;

/** "branch <name>" / "branch `name`" and "`name` branch". */
const BRANCH_AFTER = /\bbranch(?:es)?\s+(?:named\s+|called\s+)?(`[^`\n]+`|[A-Za-z0-9][\w./-]*)/gi;
const BRANCH_BEFORE = /`([^`\n]+)`\s+branch\b/gi;
const BACKTICKED_SPAN = /`([^`\n]+)`/g;
/** Words that follow "branch" in prose without being its name. */
const NOT_BRANCH_NAMES = new Set([
  "a", "an", "and", "the", "is", "was", "it", "its", "itself", "that", "which", "has", "had", "of", "or", "for",
  "to", "with", "not", "yet", "name", "names", "tip", "ref", "head", "main", "master", "mainline", "trunk", "develop",
]);

/** `raw` as a branch name, or null when it reads as prose or a file. */
function branchName(raw: string): string | null {
  const quoted = raw.startsWith("`");
  const name = raw.replace(/^`|`$/g, "").replace(/[.,;:)]+$/, "");
  if (!/^[A-Za-z0-9][\w./-]*$/.test(name) || name.length > 200) return null;
  if (NOT_BRANCH_NAMES.has(name.toLowerCase())) return null;
  // A bare word after "branch" is prose ("the branch itself") unless it is shaped like a branch name.
  if (!quoted && !/[/_\d-]/.test(name)) return null;
  if (/\.[A-Za-z]{1,5}$/.test(name)) return null;
  return name;
}

/** The branch `sentence` names, if any. */
function namedBranch(sentence: string): string | null {
  for (const re of [BRANCH_AFTER, BRANCH_BEFORE]) {
    re.lastIndex = 0;
    for (const m of sentence.matchAll(re)) {
      const raw = re === BRANCH_BEFORE ? `\`${m[1]}\`` : m[1]!;
      const name = branchName(raw);
      if (name) return name;
    }
  }
  if (!/\bbranch\b/i.test(sentence)) return null;
  // "branch" said elsewhere in the sentence, the name a backticked ref-shaped span.
  BACKTICKED_SPAN.lastIndex = 0;
  for (const m of sentence.matchAll(BACKTICKED_SPAN)) {
    const name = m[1]!.includes("/") ? branchName(`\`${m[1]}\``) : null;
    if (name) return name;
  }
  return null;
}

/** `body` with fenced code, inline code and double-quoted text blanked out, offsets kept. */
function maskQuoted(body: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, " ");
  return body
    .replace(/```[\s\S]*?(?:```|$)/g, blank)
    .replace(/`[^`\n]*`/g, blank)
    .replace(/"[^"\n]*"|“[^”\n]*”/g, blank);
}

/** The [start, end) of the sentence around offset `at` in `text`: bounded by line breaks and by `.`, `!`, `?` before whitespace. */
function sentenceBounds(text: string, at: number): [number, number] {
  let start = at;
  while (start > 0 && text[start - 1] !== "\n" && !(/[.!?]/.test(text[start - 1]!) && /\s/.test(text[start] ?? " "))) start--;
  let end = at;
  while (end < text.length && text[end] !== "\n" && !(/[.!?]/.test(text[end]!) && /\s/.test(text[end + 1] ?? " "))) end++;
  return [start, end < text.length && text[end] !== "\n" ? end + 1 : end];
}

/**
 * The not-merged claims of `body`, one per sentence: a sentence naming a
 * branch with any not-merged phrase ("on branch X, not merged"), or one saying
 * work is still waiting to land with no branch ("not yet merged", "pending
 * merge"). Quoted and code text, conditionals ("if it is not merged"),
 * reverts, claims placed in another repo, and sentences that name a commit sha
 * instead (extractRepoStateClaims) are not claims.
 */
export function extractBranchMergeClaims(body: string): BranchMergeClaim[] {
  const text = body ?? "";
  const masked = maskQuoted(text);
  const out: BranchMergeClaim[] = [];
  const seen = new Set<number>();
  MERGE_STATE_PHRASE.lastIndex = 0;
  for (const m of masked.matchAll(MERGE_STATE_PHRASE)) {
    const at = m.index ?? 0;
    const [start, end] = sentenceBounds(masked, at);
    if (seen.has(start)) continue;
    const prose = masked.slice(start, end);
    const sentence = text.slice(start, end).trim();
    // "implemented in branch X" places the work on a branch, not in another package.
    const placed = sentence.replace(/\b(?:in|into|on|from)\s+(?:the\s+|its\s+|a\s+)?(?:worktree\s+|feature\s+)?branch\b/gi, " branch");
    if (CONDITIONAL.test(prose) || REVERTED.test(prose) || ELSEWHERE.test(placed)) continue;
    const branch = namedBranch(sentence);
    const pending = m[1] !== undefined;
    if (!branch && !pending) continue;
    if (!branch && new RegExp(SHA).test(sentence)) continue;
    seen.add(start);
    out.push({ branch, sentence, phrase: text.slice(at, at + m[0].length) });
  }
  return out;
}

/** The propose-time warning for a not-merged claim that names no branch. */
export const UNNAMED_UNMERGED_WARNING =
  'Name the branch: write "on branch <name>, not yet merged" so Standup can expire the claim when it lands.';

/** UNNAMED_UNMERGED_WARNING when `body` says work is not yet merged without naming the branch; else null. */
export function unnamedUnmergedWarning(body: string): string | null {
  return extractBranchMergeClaims(body).some((c) => c.branch === null) ? UNNAMED_UNMERGED_WARNING : null;
}

/** Most commits a doc's sha may sit ahead of the default branch for its patches to be matched one by one. */
export const LANDING_MAX_BRANCH_COMMITS = 50;

/** How landed work reached the default branch, which the review draft's wording follows. */
export type LandingVia = "rebased-copy" | "squash" | "reapplied" | "merge" | "content";
const LANDING_VIAS: ReadonlySet<string> = new Set<LandingVia>(["rebased-copy", "squash", "reapplied", "merge", "content"]);

/**
 * `dropped`: the branch's work reached a default branch but names the doc
 * uses are not there now — the design changed after it landed, so the doc
 * needs a human, not a rewrite of its merge status.
 */
export type BranchLanding =
  | { state: "landed"; mainline: string; via: LandingVia; how: string }
  | { state: "unmerged" | "dropped" | "unknown"; how: string };

/** `refs/heads/main` → `main`, `refs/remotes/origin/main` → `main`. */
function branchOfRef(ref: string): string {
  return ref.replace(/^refs\/heads\//, "").replace(/^refs\/remotes\/[^/]+\//, "");
}

/** Per-pass memo of git answers shared by the landing checks of one repo. */
export interface LandingCache {
  merge: MergeCheckCache;
  symbols: Map<string, Promise<Set<string> | null>>;
}

export function newLandingCache(): LandingCache {
  return { merge: newMergeCheckCache(), symbols: new Map() };
}

async function gitOut(ctx: RepoEvidenceContext, args: string[]): Promise<string | null> {
  const r = await ctx.git(ctx.repoPath, args);
  return r && r.code === 0 ? r.stdout.trim() : null;
}

async function isAncestor(ctx: RepoEvidenceContext, a: string, b: string): Promise<boolean> {
  const r = await ctx.git(ctx.repoPath, ["merge-base", "--is-ancestor", a, b]);
  return !!r && r.code === 0;
}

/** Whether `sha` is on `ref`'s first-parent line (committed on it, or fast-forwarded), as opposed to brought in by a merge. */
async function onFirstParentLine(ctx: RepoEvidenceContext, sha: string, ref: string): Promise<boolean> {
  const time = await gitOut(ctx, ["log", "-1", "--format=%ct", sha]);
  if (!time) return true;
  const line = await gitOut(ctx, ["rev-list", "--first-parent", `--since=@${Number(time) - 1}`, ref]);
  return line === null || line.split("\n").includes(sha);
}

/** The ref a branch name resolves to — local first, then any remote — or null. */
async function resolveBranchRef(ctx: RepoEvidenceContext, name: string): Promise<string | null> {
  const refs = await gitOut(ctx, [
    "for-each-ref",
    "--format=%(refname)",
    `refs/heads/${name}`,
    `refs/remotes/${name}`,
    `refs/remotes/*/${name}`,
  ]);
  if (!refs) return null;
  const all = refs.split("\n").filter((r) => r && !r.endsWith("/HEAD"));
  return all.find((r) => r.startsWith("refs/heads/")) ?? all[0] ?? null;
}

/** Every file but markdown, which quotes names from everywhere: where a design that has not been dropped still shows (config keys, JSON schemas included). */
const NON_DOC_PATHSPEC = [".", ":(glob,exclude)**/*.md", ":(glob,exclude)**/*.mdx"];

/** Which of `names` occur as whole words in the code at `commit` (BRANCH_CODE_PATHSPEC; every non-markdown file with `anyFile`), or null when git fails. */
function symbolsAtCommit(
  ctx: RepoEvidenceContext,
  cache: LandingCache,
  commit: string,
  names: readonly string[],
  anyFile = false
): Promise<Set<string> | null> {
  const key = `${commit}\0${anyFile ? "any" : "code"}\0${names.join(",")}`;
  let found = cache.symbols.get(key);
  if (!found) {
    found = (async () => {
      const args = ["grep", "-F", "-w", "-o", "-h", "-I"];
      for (const n of names) args.push("-e", n);
      const r = await ctx.git(ctx.repoPath, [...args, commit, "--", ...(anyFile ? NON_DOC_PATHSPEC : BRANCH_CODE_PATHSPEC)]);
      if (!r || (r.code !== 0 && r.code !== 1)) return null;
      return new Set(r.stdout.split("\n").map((l) => l.trim()).filter(Boolean));
    })();
    cache.symbols.set(key, found);
  }
  return found;
}

/** The paths and symbols `doc` names that are present at `commit`, or null when git fails. */
async function namedPresentAt(
  ctx: RepoEvidenceContext,
  cache: LandingCache,
  commit: string,
  paths: readonly string[],
  symbols: readonly string[],
  anyFile = false
): Promise<Set<string> | null> {
  const tree = paths.length > 0 ? await ctx.treeAt(commit) : new Set<string>();
  const found = symbols.length > 0 ? await symbolsAtCommit(ctx, cache, commit, symbols, anyFile) : new Set<string>();
  if (!tree || !found) return null;
  return new Set([...paths.filter((p) => tree.has(p)), ...symbols.filter((s) => found.has(s))]);
}

/** The paths and symbols a doc names, which its work must have put on the default branch to count as landed. */
interface NamedRefs {
  paths: string[];
  symbols: string[];
}

/**
 * The names `doc` uses for its work, leaving out sentences that contrast it
 * with what the default branch still has (MAINLINE_STILL: "On mainline,
 * `legacyHook` still serves the route.") — a name the work replaced is not
 * one it must have put on the default branch.
 */
function namedRefs(doc: KnowledgeDoc): NamedRefs {
  const body = (doc.body ?? "")
    .split("\n")
    .map((line) =>
      line
        .split(/(?<=[.!?])\s+/)
        .filter((s) => !MAINLINE_STILL.test(s.replace(LINE_PREFIX, "").trim()))
        .join(" ")
    )
    .join("\n");
  return { paths: deriveNamedPaths(body), symbols: deriveNamedSymbols(body) };
}

/**
 * The names of `named` missing at `commit`, or null when git fails. Symbols
 * are looked for in code only (BRANCH_CODE_PATHSPEC), or with `anyFile` in
 * every non-markdown file — enough to tell that a design was not dropped.
 */
async function missingAt(
  ctx: RepoEvidenceContext,
  cache: LandingCache,
  commit: string,
  named: NamedRefs,
  anyFile = false
): Promise<string[] | null> {
  if (named.paths.length + named.symbols.length === 0) return [];
  const present = await namedPresentAt(ctx, cache, commit, named.paths, named.symbols, anyFile);
  return present ? [...named.paths, ...named.symbols].filter((n) => !present.has(n)) : null;
}

/**
 * How `tip` (labelled `label`) reached `mainline` by its patches: merged in, a
 * patch-identical rebased copy, a squash, or every line it adds re-applied
 * there (a squash with edits, a conflict-resolved copy). Unmerged when none
 * holds; null when it cannot decide (the tip is on the default branch's own
 * line, or git failed).
 */
async function patchLanding(
  ctx: RepoEvidenceContext,
  cache: LandingCache,
  label: string,
  tip: string,
  mainline: string
): Promise<BranchLanding | null> {
  const short = branchOfRef(mainline);
  if (await isAncestor(ctx, tip, mainline)) {
    if (await onFirstParentLine(ctx, tip, mainline)) return null;
    return { state: "landed", mainline: short, via: "merge", how: `${label} was merged into ${short}` };
  }
  const cherry = await gitOut(ctx, ["cherry", mainline, tip]);
  const lines = cherry ? cherry.split("\n").filter(Boolean) : [];
  if (lines.length > 0 && lines.every((l) => l.startsWith("-"))) {
    return {
      state: "landed",
      mainline: short,
      via: "rebased-copy",
      how: `every commit of ${label} has a patch-identical copy on ${short} (git cherry ${short} ${label})`,
    };
  }
  if (await squashedInto(ctx.repoPath, tip, mainline, ctx.git, cache.merge)) {
    return { state: "landed", mainline: short, via: "squash", how: `${label} was squash-merged into ${short}` };
  }
  const mergeBase = await gitOut(ctx, ["merge-base", mainline, tip]);
  if (mergeBase && (await changesPresentIn(ctx.repoPath, mergeBase, tip, mainline, ctx.git))) {
    return { state: "landed", mainline: short, via: "reapplied", how: `every line ${label} adds is on ${short}` };
  }
  const ahead = lines.filter((l) => l.startsWith("+")).length;
  return ahead > 0 ? { state: "unmerged", how: `git cherry ${short} ${label} lists ${ahead} commit(s) with no copy on ${short}` } : null;
}

/** Most sibling branches looked at for one claim. */
const MAX_SIBLING_BRANCHES = 10;

/** A launch's follow-up suffix: `-continue-<id>` or `-packet-<id>`. */
const FOLLOW_UP_SUFFIX = /-(?:continue|packet)-[0-9a-f]{6,}$/;

/**
 * The follow-up branches of `name`'s launch — `<slug>-continue-<id>` and
 * `<slug>-packet-<id>`, where `name` is `<slug>-<id>` or one of those
 * follow-ups: `standup/foo-6d117d` and `standup/foo-continue-1a2b3c` share
 * `standup/foo`. Only that exact suffix shape counts: slugs themselves often
 * contain "packet" or "continue" (`review-packet-…`), and a bare relaunch
 * (`<slug>-<other id>`) can be unrelated work that reused the slug.
 */
async function siblingBranches(ctx: RepoEvidenceContext, name: string): Promise<Array<{ name: string; ref: string }>> {
  const stem = FOLLOW_UP_SUFFIX.test(name) ? name.replace(FOLLOW_UP_SUFFIX, "") : name.replace(/-[0-9a-f]{6,}$/, "");
  if (!stem || stem === name || stem.length < 3) return [];
  const refs = await gitOut(ctx, ["for-each-ref", "--format=%(refname)", `refs/heads/${stem}-*`, `refs/remotes/*/${stem}-*`]);
  if (!refs) return [];
  const out: Array<{ name: string; ref: string }> = [];
  const seen = new Set<string>([name]);
  for (const ref of refs.split("\n")) {
    const short = ref.replace(/^refs\/heads\//, "").replace(/^refs\/remotes\/[^/]+\//, "");
    const suffix = short.slice(stem.length);
    if (!short.startsWith(stem) || seen.has(short) || !/^-(?:continue|packet)-[0-9a-f]{6,}$/.test(suffix)) continue;
    seen.add(short);
    out.push({ name: short, ref });
    if (out.length >= MAX_SIBLING_BRANCHES) break;
  }
  return out;
}

/**
 * Rule 1: the branch still exists. Landed when its patches (or a sibling
 * branch's) reached a default branch AND every path and symbol the doc names
 * is there now; work that reached it while the names did not — the design was
 * dropped or reworked after it landed — is `dropped`, not landed. Null when it
 * cannot decide.
 */
async function branchLanding(
  ctx: RepoEvidenceContext,
  cache: LandingCache,
  name: string,
  ref: string,
  named: NamedRefs
): Promise<BranchLanding | null> {
  const tip = await gitOut(ctx, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  if (!tip) return null;
  const landedAs = async (label: string, at: string): Promise<{ landed?: BranchLanding; dropped?: BranchLanding; unmerged?: BranchLanding }> => {
    const out: { landed?: BranchLanding; dropped?: BranchLanding; unmerged?: BranchLanding } = {};
    for (const mainline of ctx.defaultRefs) {
      const landing = await patchLanding(ctx, cache, label, at, mainline);
      if (!landing) continue;
      if (landing.state !== "landed") {
        out.unmerged ??= landing;
        continue;
      }
      const missing = await missingAt(ctx, cache, mainline, named, true);
      if (missing === null) continue;
      if (missing.length === 0) return { landed: landing };
      out.dropped ??= {
        state: "dropped",
        how: `${landing.how}, but ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not on ${landing.mainline}`,
      };
    }
    return out;
  };
  const own = await landedAs(name, tip);
  if (own.landed) return own.landed;
  if (own.dropped) return own.dropped;
  for (const sibling of await siblingBranches(ctx, name)) {
    const sibTip = await gitOut(ctx, ["rev-parse", "--verify", "--quiet", `${sibling.ref}^{commit}`]);
    if (!sibTip) continue;
    const via = await landedAs(sibling.name, sibTip);
    if (via.landed) return { ...via.landed, how: `through sibling branch ${sibling.name}: ${via.landed.how}` };
  }
  if (!own.unmerged) return null;
  return (await introducedLanding(ctx, cache, name, tip, named)) ?? own.unmerged;
}

/** Most of a branch's unlanded commits whose added names are looked up. */
const MAX_INTRODUCING_COMMITS = 20;

/**
 * A branch with commits that have no copy on the default branch, whose work
 * may still have landed in another form (re-written in a follow-up, squashed
 * with other work): landed by content — unconfirmed, so it only writes a
 * review draft — when every name the doc uses is on the default branch now
 * and at least one of them was added by one of the branch's commits that have
 * no copy there (`git cherry` `+`). Names added only by commits that did land
 * (a cherry-picked helper) say nothing about the rest of the branch.
 */
async function introducedLanding(
  ctx: RepoEvidenceContext,
  cache: LandingCache,
  name: string,
  tip: string,
  named: NamedRefs
): Promise<BranchLanding | null> {
  const all = [...named.paths, ...named.symbols];
  if (all.length === 0) return null;
  for (const mainline of ctx.defaultRefs) {
    const missingNow = await missingAt(ctx, cache, mainline, named);
    if (!missingNow || missingNow.length > 0) continue;
    const cherry = await gitOut(ctx, ["cherry", mainline, tip]);
    const unlanded = (cherry ?? "")
      .split("\n")
      .filter((l) => l.startsWith("+ "))
      .map((l) => l.slice(2).trim())
      .slice(0, MAX_INTRODUCING_COMMITS);
    const introduced = new Set<string>();
    for (const commit of unlanded) {
      const before = await missingAt(ctx, cache, `${commit}^`, named);
      const after = await missingAt(ctx, cache, commit, named);
      if (!before || !after) continue;
      for (const n of before) if (!after.includes(n)) introduced.add(n);
    }
    if (introduced.size === 0) continue;
    const short = branchOfRef(mainline);
    return {
      state: "landed",
      mainline: short,
      via: "content",
      how: `${[...introduced].join(", ")} added by ${name}'s unlanded commits and on ${short} now`,
    };
  }
  return null;
}

/** Rule 2: judged from the doc's own sha and the names it uses. */
async function contentLanding(ctx: RepoEvidenceContext, cache: LandingCache, doc: KnowledgeDoc): Promise<BranchLanding> {
  const paths = deriveNamedPaths(doc.body);
  const symbols = deriveNamedSymbols(doc.body);
  const named = [...paths, ...symbols];
  const sha =
    hasProvenance(doc.generatedFromSha) && (await gitOut(ctx, ["rev-parse", "--verify", "--quiet", `${doc.generatedFromSha}^{commit}`]))
      ? doc.generatedFromSha
      : null;
  const docDate = contentDate(doc);
  for (const mainline of ctx.defaultRefs) {
    const short = branchOfRef(mainline);
    const present = named.length > 0 ? await namedPresentAt(ctx, cache, mainline, paths, symbols) : new Set<string>();
    if (!present) continue;
    const allPresent = present.size === named.length;
    if (sha && !(await isAncestor(ctx, sha, mainline))) {
      const mergeBase = await gitOut(ctx, ["merge-base", mainline, sha]);
      if (!mergeBase || !allPresent) continue;
      const count = Number(await gitOut(ctx, ["rev-list", "--count", `${mergeBase}..${sha}`]));
      if (!Number.isFinite(count) || count === 0 || count > LANDING_MAX_BRANCH_COMMITS) continue;
      const log = await ctx.git(ctx.repoPath, ["log", "-p", "--format=commit %H", `${mergeBase}..${sha}`]);
      const mine = log && log.code === 0 ? await patchIds(ctx.repoPath, log.stdout) : new Set<string>();
      const theirs = await refPatchIdsSince(ctx.repoPath, mainline, mergeBase, ctx.git, cache.merge);
      if (mine.size > 0 && [...mine].every((id) => theirs.has(id))) {
        return {
          state: "landed",
          mainline: short,
          via: "rebased-copy",
          how: `the ${count} commit(s) up to ${sha.slice(0, 12)} have patch-identical copies on ${short}`,
        };
      }
      if (await squashedInto(ctx.repoPath, sha, mainline, ctx.git, cache.merge)) {
        return { state: "landed", mainline: short, via: "squash", how: `the work up to ${sha.slice(0, 12)} was squash-merged into ${short}` };
      }
      continue;
    }
    if (named.length === 0 || !allPresent) continue;
    if (sha && !(await onFirstParentLine(ctx, sha, mainline))) {
      return { state: "landed", mainline: short, via: "merge", how: `${sha.slice(0, 12)} was merged into ${short}` };
    }
    const base =
      sha ??
      (Number.isFinite(docDate)
        ? await gitOut(ctx, ["rev-list", "-1", "--first-parent", `--before=@${Math.floor(docDate / 1000)}`, mainline])
        : null);
    if (!base) continue;
    const then = await namedPresentAt(ctx, cache, base, paths, symbols);
    if (!then) continue;
    const introduced = named.filter((n) => !then.has(n));
    if (introduced.length > 0) {
      return {
        state: "landed",
        mainline: short,
        via: "content",
        how: `${introduced.join(", ")} absent from ${short} at ${base.slice(0, 12)} and on ${short} now`,
      };
    }
  }
  return { state: "unknown", how: "no evidence the work is on a default branch" };
}

/**
 * Whether the work behind `doc`'s not-merged claims has landed on a default
 * branch (see the rules above). Landed only when every claim's work has; a
 * claim whose branch still has commits with no copy there makes it unmerged;
 * one whose work landed without the names the doc uses makes it dropped;
 * anything else is unknown.
 */
export async function checkBranchClaimsLanded(
  ctx: RepoEvidenceContext,
  doc: KnowledgeDoc,
  claims: readonly BranchMergeClaim[] = extractBranchMergeClaims(doc.body),
  cache: LandingCache = newLandingCache()
): Promise<BranchLanding> {
  if (claims.length === 0) return { state: "unknown", how: "no not-merged claim" };
  if (ctx.defaultRefs.length === 0) return { state: "unknown", how: "no default branch" };
  const named = namedRefs(doc);
  let fromContent: Promise<BranchLanding> | null = null;
  const landings: BranchLanding[] = [];
  for (const claim of claims) {
    const ref = claim.branch ? await resolveBranchRef(ctx, claim.branch) : null;
    let landing = ref ? await branchLanding(ctx, cache, claim.branch!, ref, named) : null;
    if (!landing) landing = await (fromContent ??= contentLanding(ctx, cache, doc));
    landings.push(landing);
  }
  const unmerged = landings.find((l) => l.state === "unmerged") ?? landings.find((l) => l.state === "dropped");
  if (unmerged) return unmerged;
  if (landings.every((l) => l.state === "landed")) {
    const first = landings[0] as Extract<BranchLanding, { state: "landed" }>;
    // The doc's landing is only as sure as its weakest claim's.
    const weakest =
      landings.find((l) => l.state === "landed" && l.via === "content") ??
      landings.find((l) => l.state === "landed" && l.via === "reapplied");
    return {
      ...first,
      ...(weakest?.state === "landed" ? { via: weakest.via } : {}),
      how: [...new Set(landings.map((l) => l.how))].join("; "),
    };
  }
  return landings.find((l) => l.state === "unknown")!;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const MAINLINE_WORD = String.raw`\`?(?:main|master|mainline|trunk|develop)\`?|the\s+default\s+branch`;

/** The sentence's end: optional closing punctuation, then nothing. */
const AT_END = String.raw`(?=\s*[.!?]?$)`;

/**
 * The ways a not-merged phrase sits in its sentence that can be taken out
 * cleanly: in parentheses; as the sentence's tail after a comma, semicolon or
 * dash (", which is not yet merged."); as a leading label ("Not merged yet:
 * the parser."); as the whole sentence ("Pending merge."); or "unmerged"
 * before "branch". A phrase anywhere else ("X is not yet merged, so …",
 * "… and not yet merged.") is part of the sentence's grammar, and is not.
 */
function caveatPhrase(phrase: string): RegExp[] {
  const core = String.raw`(?:still\s+)?${escapeRe(phrase).replace(/\s+/g, "\\s+")}(?:\s+yet)?(?:\s+(?:in|into|to|on)\s+(?:${MAINLINE_WORD}))?(?:\s+yet)?`;
  const verb = String.raw`(?:(?:which|that|it)\s+(?:is|are|was|has|have)\s+|(?:which|that|it)['’]s\s+|(?:is|are)\s+)?`;
  return [
    new RegExp(String.raw`\s*\(\s*${verb}${core}\s*\)`, "i"),
    new RegExp(String.raw`(?:\s*[,;—–]\s*|\s+-\s+)${verb}${core}${AT_END}`, "i"),
    new RegExp(String.raw`^${core}\s*[:—–]\s*`, "i"),
    new RegExp(String.raw`^${verb}${core}${AT_END}`, "i"),
    ...(/^unmerged$/i.test(phrase) ? [/\bunmerged\s+(?=branch\b)/i] : []),
  ];
}

/** A verb whose place is the branch ("is on branch X", "implemented in branch X"): taking the place out would leave it dangling, so the place becomes the default branch. */
const PLACED_VERB = String.raw`\b(is|are|was|were|lives|live|sits|sit|exists|exist|implemented|added|built|written|wired|done)\s+`;

/**
 * Where a sentence places the work on `branch`, in the two shapes that can be
 * taken out cleanly: a leading "On branch X, …" and a trailing "… on branch
 * X." (or "… in the `X` branch."); `verbed` keeps a dangling verb's place as
 * the default branch ("is on branch X." → "is on `main`.").
 */
function branchPlace(branch: string): { leading: RegExp; trailing: RegExp; verbed: RegExp } {
  const name = String.raw`\`?${escapeRe(branch)}\`?`;
  const on = String.raw`\b(?:on|in|from)\s+(?:the\s+|its\s+|a\s+)?(?:worktree\s+|feature\s+)?`;
  const place = String.raw`${on}(?:branch(?:es)?\s+(?:named\s+|called\s+)?${name}|${name}\s+branch\b)`;
  return {
    leading: new RegExp(String.raw`^${place}\s*[,:]\s*`, "i"),
    trailing: new RegExp(String.raw`\s*${place}${AT_END}`, "i"),
    verbed: new RegExp(String.raw`${PLACED_VERB}${place}${AT_END}`, "i"),
  };
}

/** A sentence left ending on a conjunction or relative ("… is on `main` and."): its caveat was part of its grammar. */
const DANGLING_END = /\b(?:and|but|or|nor|so|yet|while|because|which|that|though|although)\s*[.!?]?$/i;

/** Words that, with the branch and the not-merged phrase taken out, leave a sentence saying nothing else. */
const CAVEAT_FILLER = new Set(
  (
    "this these that it its doc note section page describes documents covers records explains is are was were which the a an " +
    "design work change changes code feature implementation version state on in from and but so still currently for now here " +
    "below above what as of written lives exists only yet branch merged landed status caveat"
  ).split(" ")
);

/** Whether `text` says anything beyond a merge-status caveat: a code span, or a word that is not CAVEAT_FILLER. */
function substantive(text: string): boolean {
  if (/`[^`]+`/.test(text)) return true;
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).some((w) => !CAVEAT_FILLER.has(w));
}

/**
 * A sentence saying the default branch still lacks the work ("On mainline,
 * `/hook` is still unauthenticated.", "Until it lands, main still retries."):
 * true only while the branch was unmerged, so it goes with the caveat. Only
 * "still" marks the contrast — "In main, X runs until…" or "Main does not
 * retry" can be lasting facts about the default branch.
 */
const MAINLINE_STILL = new RegExp(
  String.raw`^(?:(?:on|in)\s+(?:${MAINLINE_WORD})\b[^.!?]*\bstill\b|(?:${MAINLINE_WORD})\s+still\b|until\s+(?:it|this|that|the\s+branch)\s+(?:lands|merges|is\s+merged))`,
  "i"
);

/** A markdown line prefix: indentation, a quote, a bullet or a numbered item. */
const LINE_PREFIX = /^[\s>*+-]*(?:\d+\.\s*)?/;

/**
 * `sentence` with its not-merged caveat taken out: "" when nothing else is
 * left, the rest of the sentence when it says more ("On branch X (not yet
 * merged), `a.ts` `run`." → "`a.ts` `run`."; "The fix is on branch X, not yet
 * merged." → "The fix is on `main`."), or null when the caveat cannot be
 * cleanly separated: the phrase or the branch's place sits anywhere but the
 * shapes caveatPhrase and branchPlace take out, the branch is still named,
 * another not-merged phrase is left, or the sentence ends on a conjunction.
 */
function dropCaveat(sentence: string, claim: BranchMergeClaim, mainline: string): string | null {
  const prefix = LINE_PREFIX.exec(sentence)![0];
  let rest = sentence.slice(prefix.length);
  const phrase = caveatPhrase(claim.phrase).find((re) => re.test(rest));
  if (!phrase) return null;
  rest = rest.replace(phrase, "");
  if (claim.branch) {
    const place = branchPlace(claim.branch);
    if (place.leading.test(rest)) rest = rest.replace(place.leading, "");
    else if (place.verbed.test(rest)) rest = rest.replace(place.verbed, `$1 on \`${mainline}\``);
    else rest = rest.replace(place.trailing, "");
    if (rest.includes(claim.branch)) return null;
  }
  rest = rest
    .replace(/\(\s*\)/g, "")
    .replace(/\s+([,;:.!?])/g, "$1")
    .replace(/([,;:])(?:\s*[,;:])+/g, "$1")
    .replace(/[,;:—–]+\s*([.!?]?)$/, "$1")
    .replace(/^[\s,;:—–.]+/, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!substantive(rest)) return "";
  MERGE_STATE_PHRASE.lastIndex = 0;
  if (MERGE_STATE_PHRASE.test(maskQuoted(rest)) || DANGLING_END.test(rest)) return null;
  // A plain word is capitalized; a path or identifier ("src/a.ts reads…") keeps its case.
  const capital = /^[a-z]+(?:[\s,;:.!?]|$)/.test(rest) ? `${rest[0]!.toUpperCase()}${rest.slice(1)}` : rest;
  return `${prefix}${capital}`;
}

/** Where `sentence` first occurs in `text` outside a fenced code block, or -1. */
function proseIndexOf(text: string, sentence: string): number {
  for (let at = text.indexOf(sentence); at !== -1; at = text.indexOf(sentence, at + 1)) {
    if ((text.slice(0, at).match(/^\s*```/gm) ?? []).length % 2 === 0) return at;
  }
  return -1;
}

/** The [start, end) of the sentence that follows offset `at` on the same line, or on the next line of the same paragraph; null when there is none. */
function nextSentence(text: string, at: number): [number, number] | null {
  let i = at;
  while (i < text.length && (text[i] === " " || text[i] === "\t")) i++;
  if (text[i] === "\n") {
    i++;
    const line = text.slice(i, text.indexOf("\n", i) === -1 ? text.length : text.indexOf("\n", i));
    if (!line.trim() || /^\s*(?:[#>*+-]|\d+\.|```|\|)/.test(line)) return null;
    while (i < text.length && (text[i] === " " || text[i] === "\t")) i++;
  }
  if (i >= text.length || text[i] === "\n") return null;
  const [, end] = sentenceBounds(text, i);
  return [i, end];
}

/** `text` with [start, end) removed, and the whitespace after it (or before it, at a line's end); a line left with only its prefix is removed whole. */
function cutSpan(text: string, start: number, end: number): string {
  let stop = end;
  while (stop < text.length && (text[stop] === " " || text[stop] === "\t")) stop++;
  const lineStart = start === 0 ? 0 : text.lastIndexOf("\n", start - 1) + 1;
  const lineEnd = text.indexOf("\n", stop) === -1 ? text.length : text.indexOf("\n", stop);
  let begin = start;
  if (stop === lineEnd) while (begin > lineStart && (text[begin - 1] === " " || text[begin - 1] === "\t")) begin--;
  const kept = text.slice(lineStart, begin) + text.slice(stop, lineEnd);
  if (!kept.replace(LINE_PREFIX, "").trim()) return text.slice(0, lineStart) + text.slice(lineEnd + (lineEnd < text.length ? 1 : 0));
  return text.slice(0, begin) + text.slice(stop);
}

/**
 * `body` with each landed claim's caveat taken out rather than reworded: a
 * sentence that is only the caveat ("This describes the design on branch X,
 * which is not yet merged.") is dropped, as are the sentences right after it
 * saying the default branch still lacks the work (MAINLINE_STILL); a sentence
 * that says more keeps the rest (dropCaveat). Null when a claim's caveat cannot
 * be cleanly separated from its sentence — then no draft is written, and the
 * doc is left to a human with its LANDED marker. The result describes the
 * code as it is, with no date or merge history.
 */
export function rewriteLandedClaims(body: string, claims: readonly BranchMergeClaim[], mainline: string): string | null {
  let out = body;
  for (const claim of claims) {
    const at = proseIndexOf(out, claim.sentence);
    if (at === -1) continue;
    const rewritten = dropCaveat(claim.sentence, claim, mainline);
    if (rewritten === null) return null;
    out = out.slice(0, at) + rewritten + out.slice(at + claim.sentence.length);
    const after = at + rewritten.length;
    for (let next = nextSentence(out, after); next; next = nextSentence(out, after)) {
      if (!MAINLINE_STILL.test(out.slice(next[0], next[1]).trim())) break;
      out = cutSpan(out, next[0], next[1]);
    }
    if (rewritten === "") out = cutSpan(out, at, at);
  }
  // A dropped opening line leaves the blank line that followed it.
  return /^\s*\n/.test(body) ? out : out.replace(/^\s*\n/, "");
}

/** What is stored for a doc whose not-merged claims were found to have landed. */
export interface LandedClaimRecord {
  slug: string;
  /** The body the check read; a changed body is checked afresh. */
  bodyHash: string;
  /** The first branch the claims name, if any. */
  branch: string | null;
  mainline: string;
  how: string;
  landedAt: string;
  /** Whether a review draft rewriting the claims was written (or one was already pending). */
  draftWritten: boolean;
  /** How the work was found on the mainline; undefined on a record stored before this was kept. */
  via?: LandingVia;
  /** The LANDING_RULES the record was found under; undefined on a record stored before this was kept. */
  rules?: number;
}

/**
 * The version of the landing rules. A record found under older rules is
 * checked again (and forgotten when the work no longer counts as landed): the
 * rules before 2 took ancestry alone as landed, without the doc's names on
 * the default branch.
 */
export const LANDING_RULES = 2;

const LANDED_TABLE_SQL = `CREATE TABLE IF NOT EXISTS knowledge_landed_claims (
  project_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  branch TEXT,
  mainline TEXT NOT NULL,
  how TEXT NOT NULL,
  landed_at TEXT NOT NULL,
  draft_written INTEGER NOT NULL DEFAULT 0,
  via TEXT,
  rules INTEGER,
  PRIMARY KEY (project_id, slug)
)`;

const landedTableReady = new WeakSet<Database>();

/**
 * Landed records live in their own table rather than on the `knowledge` row:
 * that row is rebuilt from the doc file on every sync, and a record keyed by
 * the body it was read from goes quiet by itself once the body changes.
 */
export function ensureLandedClaimsTable(db: Database): void {
  if (landedTableReady.has(db)) return;
  db.run(LANDED_TABLE_SQL);
  const columns = db.query("PRAGMA table_info(knowledge_landed_claims)").all() as Array<{ name: string }>;
  if (!columns.some((c) => c.name === "via")) db.run("ALTER TABLE knowledge_landed_claims ADD COLUMN via TEXT");
  if (!columns.some((c) => c.name === "rules")) db.run("ALTER TABLE knowledge_landed_claims ADD COLUMN rules INTEGER");
  landedTableReady.add(db);
}

/**
 * Whether a landed record is sure enough to show the doc as landed: found by
 * the branch itself (a merge, a patch-identical rebased copy, a squash). A
 * landing inferred from the doc's named paths and symbols appearing on the
 * mainline, or from the branch's added lines each appearing there
 * (`reapplied`, which ignores deletions and order), is not — its review draft
 * is written, but the doc reads as landed only once that draft is accepted. A record that predates `via`, or
 * was found under older LANDING_RULES, is not either; the next check rewrites
 * or forgets it.
 */
export function isConfirmedLanding(rec: Pick<LandedClaimRecord, "via" | "rules">): boolean {
  return rec.via !== undefined && rec.via !== "content" && rec.via !== "reapplied" && rec.rules === LANDING_RULES;
}

export function bodyHash(body: string): string {
  return Bun.hash(body ?? "").toString(16);
}

/** Every landed record of `projectId`, by slug. Empty when the table does not exist yet. */
export function readLandedClaims(db: Database, projectId: string): Map<string, LandedClaimRecord> {
  try {
    ensureLandedClaimsTable(db);
    const rows = db
      .query(
        "SELECT slug, body_hash, branch, mainline, how, landed_at, draft_written, via, rules FROM knowledge_landed_claims WHERE project_id = ?"
      )
      .all(projectId) as Array<{
      slug: string;
      body_hash: string;
      branch: string | null;
      mainline: string;
      how: string;
      landed_at: string;
      draft_written: number;
      via: string | null;
      rules: number | null;
    }>;
    return new Map(
      rows.map((r) => [
        r.slug,
        {
          slug: r.slug,
          bodyHash: r.body_hash,
          branch: r.branch,
          mainline: r.mainline,
          how: r.how,
          landedAt: r.landed_at,
          draftWritten: r.draft_written === 1,
          ...(r.via && LANDING_VIAS.has(r.via) ? { via: r.via as LandingVia } : {}),
          ...(r.rules !== null ? { rules: r.rules } : {}),
        },
      ])
    );
  } catch {
    return new Map();
  }
}

export function recordLandedClaim(db: Database, projectId: string, rec: LandedClaimRecord): void {
  ensureLandedClaimsTable(db);
  db.run(
    `INSERT OR REPLACE INTO knowledge_landed_claims (project_id, slug, body_hash, branch, mainline, how, landed_at, draft_written, via, rules)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      projectId,
      rec.slug,
      rec.bodyHash,
      rec.branch,
      rec.mainline,
      rec.how,
      rec.landedAt,
      rec.draftWritten ? 1 : 0,
      rec.via ?? null,
      rec.rules ?? null,
    ]
  );
}

export function forgetLandedClaim(db: Database, projectId: string, slug: string): void {
  ensureLandedClaimsTable(db);
  db.run("DELETE FROM knowledge_landed_claims WHERE project_id = ? AND slug = ?", [projectId, slug]);
}

/**
 * The confirmed landed record (isConfirmedLanding) for `doc`'s current body,
 * or undefined. Search and injection read this to show a doc's not-merged
 * wording as out of date (landedClaimMarker) instead of as the state of the
 * work.
 */
export function landedClaimFor(db: Database, doc: Pick<KnowledgeDoc, "projectId" | "slug" | "body">): LandedClaimRecord | undefined {
  const rec = readLandedClaims(db, doc.projectId).get(doc.slug);
  return rec && rec.bodyHash === bodyHash(doc.body) && isConfirmedLanding(rec) ? rec : undefined;
}

/** The marker a search hit or injected doc carries when its not-merged claims have landed. */
export function landedClaimMarker(rec: Pick<LandedClaimRecord, "branch" | "mainline">): string {
  const what = rec.branch ? `the work of branch ${rec.branch}` : "the work it describes";
  return `✓ LANDED — ${what} is on ${rec.mainline}; the doc's merge-status wording is out of date`;
}

/** Where landed records are kept and how the review draft is written; injected for tests. */
export interface LandedClaimDeps {
  read: (projectId: string) => Map<string, LandedClaimRecord>;
  record: (projectId: string, rec: LandedClaimRecord) => void;
  /** Drops a record that no longer holds under the current LANDING_RULES. */
  forget?: (projectId: string, slug: string) => void;
  /** Writes the review draft replacing the doc; false when a draft for the slug is already pending (never overwritten). */
  writeDraft?: (projectId: string, draft: KnowledgeDraftInput) => Promise<boolean>;
  now?: () => Date;
}

/** Production deps: records in `db`, drafts under `knowledgeDir`. */
export function landedClaimDeps(db: Database, knowledgeDir: string): LandedClaimDeps {
  return {
    read: (projectId) => readLandedClaims(db, projectId),
    record: (projectId, rec) => recordLandedClaim(db, projectId, rec),
    forget: (projectId, slug) => forgetLandedClaim(db, projectId, slug),
    writeDraft: async (projectId, draft) => {
      if (draftFileExists(knowledgeDir, projectId, draft.slug)) return false;
      await writeDraftFile(knowledgeDir, projectId, draft);
      return true;
    },
  };
}

/** The review draft replacing `doc` with `body`, carrying everything but the text over unchanged. */
function landedDraft(doc: KnowledgeDoc, body: string): KnowledgeDraftInput {
  return {
    slug: doc.slug,
    title: doc.title,
    body,
    tags: doc.tags,
    related: doc.related,
    generatedFromSha: doc.generatedFromSha,
    generatedAt: doc.generatedAt,
    replacesSlug: doc.slug,
    sourceSessionId: doc.sourceSessionId,
    originClass: doc.originClass,
    sourceKind: doc.sourceKind,
    scope: doc.scope,
    ownerUser: doc.ownerUser,
    confidence: doc.confidence,
    lastVerifiedAt: doc.lastVerifiedAt,
    halfLifeDays: doc.halfLifeDays,
  };
}

/** What settling one doc's claims did. */
export interface SettledClaims {
  /** "already" when the doc's current body was found landed before. */
  state: "landed" | "already" | "unmerged" | "dropped" | "unknown" | "none";
  record?: LandedClaimRecord;
  draftWritten: boolean;
  /** For `dropped`: what reached the default branch and which names did not. */
  how?: string;
}

/**
 * Checks `doc`'s not-merged claims (once per body and LANDING_RULES: a body
 * already found landed under the current rules is not checked again) and,
 * when they landed, records it and writes a review draft taking the caveats
 * out (rewriteLandedClaims) — none when they cannot be cleanly taken out. A
 * record from older rules that no longer holds is forgotten. Idempotent: a
 * second call for the same body writes nothing.
 */
export async function settleBranchClaims(
  deps: LandedClaimDeps,
  ctx: RepoEvidenceContext,
  doc: KnowledgeDoc,
  known: ReadonlyMap<string, LandedClaimRecord> = deps.read(doc.projectId),
  cache: LandingCache = newLandingCache()
): Promise<SettledClaims> {
  const hash = bodyHash(doc.body);
  const prior = known.get(doc.slug);
  // A record without `via`, or from older rules, is checked again.
  if (prior && prior.bodyHash === hash && prior.via !== undefined && prior.rules === LANDING_RULES) {
    return { state: "already", record: prior, draftWritten: false };
  }
  const claims = extractBranchMergeClaims(doc.body);
  if (claims.length === 0) return { state: "none", draftWritten: false };
  const landing = await checkBranchClaimsLanded(ctx, doc, claims, cache);
  if (landing.state !== "landed") {
    if (prior) deps.forget?.(doc.projectId, doc.slug);
    return { state: landing.state, draftWritten: false, ...(landing.state === "dropped" ? { how: landing.how } : {}) };
  }
  let draftWritten = false;
  let draftPending = false;
  const rewritten = rewriteLandedClaims(doc.body, claims, landing.mainline);
  if (deps.writeDraft && rewritten !== null && rewritten !== doc.body) {
    draftWritten = await deps.writeDraft(doc.projectId, landedDraft(doc, rewritten));
    // Not written means a draft for the slug was already pending.
    draftPending = true;
  }
  const record: LandedClaimRecord = {
    slug: doc.slug,
    bodyHash: hash,
    branch: claims.find((c) => c.branch)?.branch ?? null,
    mainline: landing.mainline,
    how: landing.how,
    landedAt: (deps.now?.() ?? new Date()).toISOString(),
    draftWritten: draftPending,
    via: landing.via,
    rules: LANDING_RULES,
  };
  deps.record(doc.projectId, record);
  return { state: "landed", record, draftWritten };
}

/** Counts from one expireLandedBranchClaims run. */
export interface ExpireLandedResult {
  /** Docs with a not-merged claim that were looked at. */
  checked: number;
  landed: number;
  alreadyLanded: number;
  unmerged: number;
  /** Docs whose branch reached the default branch without the names they use (left for a human). */
  dropped: number;
  unknown: number;
  drafts: number;
  /** Stored `unmerged` findings dropped from landed docs. */
  findingsCleared: number;
}

export interface ExpireLandedDeps {
  db: Database;
  knowledgeDir: string;
  /** The projects to check, each with its repo and docs; every registered project with a repo by default. */
  projects?: Array<{ projectId: string; repoPath: string; docs: KnowledgeDoc[] }>;
  landed?: LandedClaimDeps;
  /** Re-reads a project's drafts into the index after drafts were written. */
  syncDrafts?: (projectId: string) => Promise<void>;
  git?: GitStatusRunner;
  lines?: GitLineRunner;
  now?: () => Date;
}

/**
 * The stored freshness record of each landed doc in `slugs` without its
 * `unmerged` finding, so its cap lifts now rather than at the next evidence
 * pass. Returns how many findings were dropped.
 */
function clearUnmergedFindings(db: Database, projectId: string, slugs: ReadonlySet<string>, checkedAt: string): number {
  const records = readProjectFreshness(db, projectId);
  let cleared = 0;
  for (const slug of slugs) {
    const r = records.get(slug);
    if (!r) continue;
    const findings = r.findings.filter((f) => f.kind !== "unmerged");
    if (findings.length === r.findings.length) continue;
    cleared += r.findings.length - findings.length;
    records.set(slug, { ...r, findings, cap: evidenceCap(findings) });
  }
  if (cleared > 0) replaceProjectFreshness(db, projectId, [...records.values()], checkedAt);
  return cleared;
}

/**
 * Expires every not-merged claim whose work has landed, across every project
 * (or `deps.projects`): records the landing, writes the review drafts, and
 * drops the landed docs' stored `unmerged` findings. Idempotent — a doc
 * already found landed for its current body is counted, not redone.
 */
export async function expireLandedBranchClaims(deps: ExpireLandedDeps): Promise<ExpireLandedResult> {
  const result: ExpireLandedResult = {
    checked: 0,
    landed: 0,
    alreadyLanded: 0,
    unmerged: 0,
    dropped: 0,
    unknown: 0,
    drafts: 0,
    findingsCleared: 0,
  };
  const landedDeps = deps.landed ?? { ...landedClaimDeps(deps.db, deps.knowledgeDir), now: deps.now };
  const projects =
    deps.projects ??
    getProjects(deps.db).flatMap((p) => {
      const repoPath = primaryRepoPath(p);
      return repoPath ? [{ projectId: p.id, repoPath, docs: new KnowledgeStore(deps.db).getDocsByProject(p.id) }] : [];
    });
  for (const project of projects) {
    const docs = project.docs.filter((d) => {
      const layer = layerOf(d);
      return layer !== "personal" && layer !== "activity" && d.verdict !== "superseded" && extractBranchMergeClaims(d.body).length > 0;
    });
    if (docs.length === 0 || !(await isRepoRoot(project.repoPath, deps.git))) continue;
    const ctx = await RepoEvidenceContext.forDocs(project.repoPath, docs, { git: deps.git, lines: deps.lines });
    const known = landedDeps.read(project.projectId);
    const cache = newLandingCache();
    const landedSlugs = new Set<string>();
    let drafts = 0;
    for (const doc of docs) {
      result.checked++;
      const settled = await settleBranchClaims(landedDeps, ctx, doc, known, cache);
      if (settled.state === "landed") result.landed++;
      else if (settled.state === "already") result.alreadyLanded++;
      else if (settled.state === "unmerged") result.unmerged++;
      else if (settled.state === "dropped") result.dropped++;
      else if (settled.state === "unknown") result.unknown++;
      if (settled.draftWritten) drafts++;
      // An inferred landing keeps its unmerged finding until its draft is accepted.
      if (settled.record && isConfirmedLanding(settled.record)) landedSlugs.add(doc.slug);
    }
    result.drafts += drafts;
    if (drafts > 0) await deps.syncDrafts?.(project.projectId);
    result.findingsCleared += clearUnmergedFindings(
      deps.db,
      project.projectId,
      landedSlugs,
      (deps.now?.() ?? new Date()).toISOString()
    );
  }
  return result;
}
