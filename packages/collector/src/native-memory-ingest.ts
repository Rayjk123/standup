import { readFile, writeFile, readdir, stat, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join, basename, dirname } from "path";
import { homedir } from "os";
import {
  writeKnowledgeFile,
  readKnowledgeFile,
  deleteKnowledgeFile,
  listKnowledgeFiles,
  redactSecrets,
  redactOptionsFor,
  INITIAL_CONFIDENCE,
  NATIVE_MEMORY_HOME_SLUG_PREFIX,
  NATIVE_MEMORY_ACTIVITY_SLUG_PREFIX,
} from "@standup/knowledge";
import type {
  KnowledgeDocFile,
  KnowledgeDocInput,
  OriginClass,
  Scope,
  SourceKind,
} from "@standup/knowledge";
import { upsertManagedBlock, GLOBAL_PROJECT_ID } from "@standup/shared";
import type { IngestableProject } from "./project-docs-ingest.js";
import { hostUserAlias } from "./host-user.js";

export { redactSecrets };

/**
 * Mirrors Claude Code's native-memory surfaces into the knowledge corpus so the
 * context an agent already carries natively — the CLAUDE.md hierarchy and the
 * per-project auto-memory notes — becomes retrievable, instead of living only in
 * the files Claude Code loads at session start. The sibling of project-docs
 * ingest (repo `plan/*.md`); the two share the same idempotent, non-destructive
 * shape but read different sources and stamp a different provenance marker.
 *
 * Each source lands in the knowledge layer (see the knowledge package's Layer)
 * that matches how it goes stale and who may see it:
 *  1. The HOME CLAUDE.md hierarchy — `<base>/.claude/CLAUDE.md` and
 *     `<base>/.claude/rules/*.md`. The host user's personal config: mirrored
 *     `owner`-trust, `scope: user` owned by the host user, homed in the reserved
 *     GLOBAL corpus — the personal layer, which shared retrieval (search
 *     defaults, launch injection) never returns; it reaches its
 *     owner through Persona and through Claude Code's own CLAUDE.md load. An
 *     operator can opt the whole tier out (`includeHomeConfig: false`).
 *  2. Per-project CLAUDE.md + rules — `<repo>/.claude/CLAUDE.md` and
 *     `<repo>/.claude/rules/*.md`. Repo-checked-in steering the team already
 *     shares, mirrored project-scoped under the project's own corpus as
 *     `owner`-trust (the docs layer).
 *  3. Auto-memory — `<base>/.claude/projects/<encoded-repo-path>/memory/*.md`
 *     for every repo of the project, the notes Claude Code writes across a
 *     project's sessions. Claude Code — an agent — authored these, so they are
 *     mirrored `agent`-trust and classified by the note's own front-matter
 *     `type`: `feedback`/`user` notes are about the host user (personal layer,
 *     `scope: user`); `project`/`reference` notes are project facts (docs layer,
 *     `native-mem-note-*`); anything else — session diaries, dated logs, the
 *     MEMORY.md index — is activity (`native-mem-memory-*`) with a short
 *     confidence half-life.
 *
 * Every mirrored body is passed through `redactSecrets` first. Every mirrored
 * doc is stamped `source_kind: native-memory` — the discriminator that keeps
 * auto-mirrored native memory distinguishable from a hand-authored corpus doc
 * even when both resolve to the same trust class. `<base>` is injectable
 * (defaults to the home dir) so a test points the whole ingest at a throwaway
 * dir and never touches the real ~/.claude.
 */

/** Source kind stamped on every doc this ingest writes. */
const NATIVE_MEMORY_SOURCE_KIND: SourceKind = "native-memory";

/**
 * Trust class for mirrored auto-memory. `agent`, because Claude Code — an agent —
 * authored these self-notes across a project's sessions, the same provenance the
 * `agent` origin_class denotes. `source_kind: native-memory` (stamped on every
 * doc this ingest writes) is the orthogonal discriminator that keeps an
 * auto-mirrored note distinguishable from a hand-curated corpus doc even though
 * both are injection-eligible under isOriginEligibleForInjection.
 */
const AUTO_MEMORY_ORIGIN_CLASS: OriginClass = "agent";

/**
 * Confidence half-life of an auto-memory activity note (a session diary, a dated
 * log): its claims describe a moment, so its confidence halves every two weeks
 * from the note's last edit.
 */
export const ACTIVITY_NOTE_HALF_LIFE_DAYS = 14;

/** Reads a boolean opt-in from an env var: `1`/`true`/`yes`/`on` enable it. */
function envFlag(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

/**
 * Slug prefix for every native-memory corpus doc. Namespaces these under a
 * reserved stem so they never collide with a hand-authored or project-docs slug,
 * and makes the whole set greppable in a corpus dir. The per-source stems below
 * keep the tiers apart and carry the layer: `native-mem-home-` (personal),
 * `native-mem-project-` (docs), `native-mem-note-` (docs), `native-mem-memory-`
 * (activity, or personal when scope=user).
 */
const SLUG_PREFIX = "native-mem-";
const HOME_SLUG_PREFIX = NATIVE_MEMORY_HOME_SLUG_PREFIX;
const PROJECT_SLUG_PREFIX = `${SLUG_PREFIX}project-`;
const NOTE_SLUG_PREFIX = `${SLUG_PREFIX}note-`;
const ACTIVITY_SLUG_PREFIX = NATIVE_MEMORY_ACTIVITY_SLUG_PREFIX;

/**
 * Whether a knowledge doc is one of this ingest's mirrors: stamped
 * `source_kind: native-memory`, or carrying the reserved slug stem (a mirror
 * whose stored kind was lost still reads as one). A caller answering people
 * other than the owner filters on this.
 */
export function isNativeMemoryDoc(doc: { slug?: string; sourceKind?: string }): boolean {
  return doc.sourceKind === NATIVE_MEMORY_SOURCE_KIND || (doc.slug ?? "").startsWith(SLUG_PREFIX);
}

/** The corpus the HOME-level native memory (global CLAUDE.md + rules) is
 *  homed in when the caller names none — the reserved GLOBAL_PROJECT_ID corpus,
 *  so the mirrors are not tied to any one project. Their `scope: user` keeps
 *  them out of every shared retrieval window regardless of that home. */
const DEFAULT_GLOBAL_PROJECT_ID = GLOBAL_PROJECT_ID;

/** Managed-block delimiters for the optional write-back. A namespace distinct
 *  from the steering block's, so the two managed regions of a CLAUDE.md never
 *  overwrite each other. */
export const KB_FACTS_BEGIN = "<!-- BEGIN STANDUP KB FACTS -->";
export const KB_FACTS_END = "<!-- END STANDUP KB FACTS -->";

/** A single high-confidence fact the write-back would surface into CLAUDE.md. */
export interface WriteBackFact {
  title: string;
  body: string;
}

/**
 * Optional write-back of high-confidence KB facts into a managed CLAUDE.md
 * block. Off by default and gated exactly like the steering block: nothing is
 * read or written unless `enabled` is set, and even then the file is only
 * touched when `commit` is set. With `enabled` but not `commit` it is a dry run
 * — the block is computed and returned so a caller can preview it, but the live
 * write to CLAUDE.md stays a deliberate human step.
 */
export interface NativeMemoryWriteBackOptions {
  enabled?: boolean;
  commit?: boolean;
  facts?: WriteBackFact[];
}

export interface NativeMemoryWriteBackResult {
  enabled: boolean;
  /** Whether the CLAUDE.md file was actually written (only ever true with `commit`). */
  committed: boolean;
  /** Absolute path of the CLAUDE.md the block targets. */
  targetPath: string;
  /** The managed block that was (or, in a dry run, would be) written. */
  block: string;
  factCount: number;
}

export interface NativeMemoryIngestOptions {
  /** Stands in for HOME; the `.claude` hierarchy derives from this. Defaults to
   *  the home dir. Tests pass a temp dir so the real ~/.claude is never touched. */
  baseDir?: string;
  /** Corpus project id the HOME-level native memory is homed in. Defaults to
   *  STANDUP_NATIVE_MEMORY_PROJECT_ID or the reserved GLOBAL_PROJECT_ID. */
  globalProjectId?: string;
  /** Whether to mirror the HOME config tier (`<base>/.claude/CLAUDE.md` +
   *  `<base>/.claude/rules/*.md`). ON by default. An operator opts the tier out
   *  by passing `false` or setting the STANDUP_NATIVE_MEMORY_EXCLUDE_HOME env
   *  flag; an explicit value here always wins over the env flag. The
   *  per-project CLAUDE.md/rules and auto-memory tiers are unaffected. */
  includeHomeConfig?: boolean;
  /** The user the personal-layer mirrors (home tier, feedback/user auto-memory
   *  notes) are owned by. Defaults to the host user (hostUserAlias). */
  hostUser?: string;
  /** Projects whose per-project CLAUDE.md, `.claude/rules`, and auto-memory are
   *  mirrored under their own corpus id. */
  projects?: readonly IngestableProject[];
  /** Optional, default-OFF write-back (see NativeMemoryWriteBackOptions). */
  writeBack?: NativeMemoryWriteBackOptions;
}

export interface NativeMemoryIngestResult {
  projectId: string;
  /** Slugs written for the first time this pass. */
  ingested: string[];
  /** Slugs whose corpus copy was rewritten because the mirrored doc changed. */
  refreshed: string[];
  /** Slugs whose corpus copy was deleted: source gone, or mirrored elsewhere now. */
  removed: string[];
}

export interface NativeMemoryIngestSummary {
  results: NativeMemoryIngestResult[];
  /** Present only when write-back was enabled. */
  writeBack?: NativeMemoryWriteBackResult;
}

/** A source to mirror, resolved to its corpus destination, trust and audience. */
interface NativeSource {
  corpusProjectId: string;
  slug: string;
  sourceAbsPath: string;
  originClass: OriginClass;
  scope?: Scope;
  ownerUser?: string;
  /** An activity note: stamped with ACTIVITY_NOTE_HALF_LIFE_DAYS from its mtime. */
  activity?: boolean;
}

/** Expands a leading `~` to the home directory; leaves other paths untouched. */
function expandHome(p: string): string {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}

/** True for the "source vanished between scan and read" fs error: a file the
 *  directory scan discovered is gone by the time this pass reads it. Native
 *  memory churns while sessions run, so a mirrored file can be deleted mid-pass;
 *  treating this ENOENT as "skip only this source" keeps one racing file from
 *  aborting the whole boot's ingest. */
function isSourceGoneError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "ENOENT"
  );
}

/**
 * Encodes an absolute project path into the directory name Claude Code uses
 * under `~/.claude/projects` — every non-alphanumeric character becomes a `-`,
 * so `/Volumes/work-disk/standup` becomes `-Volumes-work-disk-standup`.
 */
export function encodeClaudeProjectDir(absPath: string): string {
  return absPath.replace(/[^A-Za-z0-9]/g, "-");
}

/** Absolute paths of the top-level `.md` files in `dir`, or null when the
 *  directory is absent/unreadable. Flat, not recursive: `.claude/rules` and a
 *  project's `memory` dir are flat. */
async function listMarkdownDir(dir: string): Promise<string[] | null> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith(".md"))
      .map((e) => join(dir, e.name))
      .sort();
  } catch {
    return null;
  }
}

/** Folds arbitrary text into the slug body: lowercase, non-alphanumerics to
 *  single hyphens, trimmed. Returns "" when nothing usable survives. */
function slugifyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Caps a slug at the 64-char limit isValidSlug enforces, trimming a trailing
 *  hyphen the cut may have left. */
function cap64(slug: string): string {
  return slug.slice(0, 64).replace(/-+$/g, "");
}

/** Strips a leading `---`-fenced frontmatter block so the mirrored body doesn't
 *  carry a second one under the corpus doc's own frontmatter. */
function stripLeadingFrontmatter(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

/** The doc title: the first Markdown heading, else the fallback. */
function deriveTitle(body: string, fallback: string): string {
  const m = /^#{1,6}[ \t]+(.+?)\s*#*\s*$/m.exec(body);
  return m ? m[1].trim() : fallback;
}

/** The `type:` value of a note's leading front matter, lowercased, or undefined. */
function frontmatterType(content: string): string | undefined {
  const fence = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!fence) return undefined;
  const m = /^type:\s*["']?([A-Za-z-]+)["']?\s*$/m.exec(fence[1]);
  return m ? m[1].toLowerCase() : undefined;
}

const DATE_STAMP = /\b\d{4}-\d{2}-\d{2}\b/;

/** The layer an auto-memory note belongs to (see the module doc). */
export type AutoMemoryClass = "personal" | "docs" | "activity";

/**
 * Classifies an auto-memory note by its own front-matter `type`. A
 * `feedback`/`user` note is about the user (personal); an undated
 * `project`/`reference` note is a project fact (docs); everything else — an
 * untyped note, a session diary, a log whose name or heading carries a date —
 * is activity.
 */
export function classifyAutoMemoryNote(fileName: string, content: string): AutoMemoryClass {
  const type = frontmatterType(content);
  if (type === "feedback" || type === "user") return "personal";
  const heading = deriveTitle(stripLeadingFrontmatter(content), "");
  const dated = DATE_STAMP.test(fileName) || DATE_STAMP.test(heading);
  if ((type === "project" || type === "reference") && !dated) return "docs";
  return "activity";
}

/**
 * The corpus doc a source mirrors to: its redacted body plus the stamps its
 * tier carries. The body is redacted under the options the doc's placement
 * calls for — the scope a curator gave the existing copy, else the tier's —
 * so a personal-layer mirror also loses its account ids.
 */
async function buildMirrorDoc(src: NativeSource, existing: KnowledgeDocFile | null): Promise<KnowledgeDocInput> {
  const raw = await readFile(src.sourceAbsPath, "utf-8");
  const opts = redactOptionsFor({
    projectId: src.corpusProjectId,
    scope: existing?.scope ?? src.scope,
    sourceKind: NATIVE_MEMORY_SOURCE_KIND,
    slug: src.slug,
  });
  // Redact before deriving anything: the title comes off the scrubbed body too,
  // so a secret in a heading never leaks through the doc title.
  const body = redactSecrets(stripLeadingFrontmatter(raw), opts).trim();
  const activityStamp = src.activity
    ? {
        confidence: INITIAL_CONFIDENCE,
        lastVerifiedAt: (await stat(src.sourceAbsPath)).mtime.toISOString(),
        halfLifeDays: ACTIVITY_NOTE_HALF_LIFE_DAYS,
      }
    : {};
  return {
    slug: src.slug,
    title: deriveTitle(body, src.slug),
    body,
    sourceKind: NATIVE_MEMORY_SOURCE_KIND,
    originClass: src.originClass,
    ...(src.scope ? { scope: src.scope } : {}),
    ...(src.ownerUser ? { ownerUser: src.ownerUser } : {}),
    ...activityStamp,
    nativeMemoryFrom: src.sourceAbsPath,
  };
}

/**
 * Whether the corpus copy already mirrors the source: the same redacted body
 * and the same marker. Front matter is not compared — a curator's relabel,
 * re-scope or tags edit on a mirror is theirs to keep — while a copy made
 * before a redaction change differs in body and is rewritten.
 */
function mirrorIsCurrent(existing: KnowledgeDocFile, desired: KnowledgeDocInput): boolean {
  return existing.body === desired.body.trim() && existing.nativeMemoryFrom === desired.nativeMemoryFrom;
}

/**
 * The doc a refresh writes over an existing mirror: the source's new body and
 * marker, with every front-matter key a curator may have set carried over from
 * the copy — scope and owner, kind and trust class, tags and edges, provenance,
 * and a title that no longer matches the body's own heading. An activity
 * note's freshness stamp is re-derived from its source.
 */
function refreshedMirrorDoc(existing: KnowledgeDocFile, desired: KnowledgeDocInput, activity: boolean): KnowledgeDocInput {
  const titleCurated = existing.title !== deriveTitle(existing.body, existing.slug);
  const scoped = existing.scope !== undefined;
  return {
    ...desired,
    title: titleCurated ? existing.title : desired.title,
    tags: existing.tags,
    related: existing.related,
    sourceKind: existing.sourceKind,
    originClass: existing.originClass ?? desired.originClass,
    scope: scoped ? existing.scope : desired.scope,
    ownerUser: scoped ? existing.ownerUser : desired.ownerUser,
    generatedFromSha: existing.generatedFromSha,
    generatedAt: existing.generatedAt,
    sourceSessionId: existing.sourceSessionId,
    ...(activity
      ? {}
      : {
          confidence: existing.confidence,
          lastVerifiedAt: existing.lastVerifiedAt,
          halfLifeDays: existing.halfLifeDays,
        }),
  };
}

/** Project corpus ids present under `knowledgeDir` (its non-dot subdirectories). */
async function corpusProjectIds(knowledgeDir: string): Promise<string[]> {
  try {
    const entries = await readdir(knowledgeDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Reads and mirrors Claude Code's native-memory surfaces into the corpus.
 * Idempotent and non-destructive, mirroring project-docs ingest:
 *  - A brand-new source is written with a `native_memory_from` marker.
 *  - A corpus doc WITHOUT that marker is human-curated and never touched.
 *  - A previously-ingested doc is rewritten when its redacted body or marker
 *    differs from the source's, keeping the front matter a curator set (see
 *    refreshedMirrorDoc), so a redaction change re-applies to every copy.
 *  - A previously-ingested doc is removed when it is a home-tier copy outside
 *    the global home, when its source now mirrors to a different destination,
 *    or when its source file is gone while the source's directory is still
 *    present (an unmounted repo never triggers a removal).
 */
export async function ingestNativeMemory(
  knowledgeDir: string,
  options: NativeMemoryIngestOptions = {}
): Promise<NativeMemoryIngestSummary> {
  const baseDir = options.baseDir ?? homedir();
  const globalProjectId =
    options.globalProjectId ??
    process.env.STANDUP_NATIVE_MEMORY_PROJECT_ID ??
    DEFAULT_GLOBAL_PROJECT_ID;
  const includeHomeConfig =
    options.includeHomeConfig ?? !envFlag(process.env.STANDUP_NATIVE_MEMORY_EXCLUDE_HOME);
  const hostUser = options.hostUser?.trim() || hostUserAlias();
  const projects = options.projects ?? [];

  const claudeDir = join(baseDir, ".claude");

  const sources: NativeSource[] = [];

  // Tier 1: HOME-level CLAUDE.md hierarchy — the host user's personal layer.
  // When the tier is off nothing here is scanned, so a previously-mirrored copy
  // is left in place rather than reclaimed (opting out stops updating, it does
  // not delete).
  if (includeHomeConfig) {
    const personal = { originClass: "owner" as const, scope: "user" as const, ownerUser: hostUser };
    const homeClaude = join(claudeDir, "CLAUDE.md");
    if (existsSync(homeClaude)) {
      sources.push({
        corpusProjectId: globalProjectId,
        slug: `${HOME_SLUG_PREFIX}claude-md`,
        sourceAbsPath: homeClaude,
        ...personal,
      });
    }
    for (const file of (await listMarkdownDir(join(claudeDir, "rules"))) ?? []) {
      const base = slugifyName(basename(file, ".md"));
      if (!base) continue;
      sources.push({
        corpusProjectId: globalProjectId,
        slug: cap64(`${HOME_SLUG_PREFIX}rule-${base}`),
        sourceAbsPath: file,
        ...personal,
      });
    }
  }

  // Tier 2: per-project CLAUDE.md + `.claude/rules` (from the project's first
  // repo, its checked-in home) + auto-memory from every repo of the project.
  for (const project of projects) {
    const repos = (project.repos ?? []).map(expandHome);
    const primary = repos[0];
    if (!primary) continue;
    const projectClaudeDir = join(primary, ".claude");

    const projectClaude = join(projectClaudeDir, "CLAUDE.md");
    if (existsSync(projectClaude)) {
      sources.push({
        corpusProjectId: project.id,
        slug: `${PROJECT_SLUG_PREFIX}claude-md`,
        sourceAbsPath: projectClaude,
        originClass: "owner",
      });
    }
    for (const file of (await listMarkdownDir(join(projectClaudeDir, "rules"))) ?? []) {
      const base = slugifyName(basename(file, ".md"));
      if (!base) continue;
      sources.push({
        corpusProjectId: project.id,
        slug: cap64(`${PROJECT_SLUG_PREFIX}rule-${base}`),
        sourceAbsPath: file,
        originClass: "owner",
      });
    }

    const memoryDirs = [
      ...new Set(repos.map((repo) => join(claudeDir, "projects", encodeClaudeProjectDir(repo), "memory"))),
    ];
    for (const memoryDir of memoryDirs) {
      for (const file of (await listMarkdownDir(memoryDir)) ?? []) {
        const base = slugifyName(basename(file, ".md"));
        if (!base) continue;
        let content: string;
        try {
          content = await readFile(file, "utf-8");
        } catch (err) {
          if (isSourceGoneError(err)) continue;
          throw err;
        }
        const noteClass = classifyAutoMemoryNote(basename(file), content);
        sources.push({
          corpusProjectId: project.id,
          slug: cap64(`${noteClass === "docs" ? NOTE_SLUG_PREFIX : ACTIVITY_SLUG_PREFIX}${base}`),
          sourceAbsPath: file,
          // Agent-trust: Claude Code authored these self-notes (see
          // AUTO_MEMORY_ORIGIN_CLASS).
          originClass: AUTO_MEMORY_ORIGIN_CLASS,
          ...(noteClass === "personal" ? { scope: "user" as const, ownerUser: hostUser } : {}),
          ...(noteClass === "activity" ? { activity: true } : {}),
        });
      }
    }
  }

  const resultsByProject = new Map<string, NativeMemoryIngestResult>();
  const resultFor = (projectId: string): NativeMemoryIngestResult => {
    let res = resultsByProject.get(projectId);
    if (!res) {
      res = { projectId, ingested: [], refreshed: [], removed: [] };
      resultsByProject.set(projectId, res);
    }
    return res;
  };

  // Every destination each source mirrors to this pass, keyed by source path, so
  // the reclaim pass below can tell a copy this pass still owns from one left
  // behind at an old destination.
  const destinations = new Map<string, Set<string>>();
  const seen = new Set<string>();
  for (const src of sources) {
    const key = `${src.corpusProjectId}/${src.slug}`;
    if (seen.has(key)) continue; // duplicate destination — first wins
    seen.add(key);
    const owned = destinations.get(src.sourceAbsPath) ?? new Set<string>();
    owned.add(key);
    destinations.set(src.sourceAbsPath, owned);

    const res = resultFor(src.corpusProjectId);
    const existing = await readKnowledgeFile(knowledgeDir, src.corpusProjectId, src.slug);

    if (existing && existing.nativeMemoryFrom == null) {
      // A curated doc (no marker) is authoritative — leave it alone.
      continue;
    }
    try {
      const desired = await buildMirrorDoc(src, existing);
      if (existing && mirrorIsCurrent(existing, desired)) continue;
      const doc = existing ? refreshedMirrorDoc(existing, desired, src.activity === true) : desired;
      await writeKnowledgeFile(knowledgeDir, src.corpusProjectId, doc);
      (existing ? res.refreshed : res.ingested).push(src.slug);
    } catch (err) {
      // The source was deleted between the directory scan that discovered it and
      // this read. Skip only this file so one racing/removed source never aborts
      // the whole pass; a later boot re-mirrors it if it reappears. Any other
      // failure is a real fault and still propagates.
      if (isSourceGoneError(err)) continue;
      throw err;
    }
  }

  // Reclaim stale mirrors in every corpus project. Only a doc carrying the
  // marker is ever removed (curated and project-docs-ingested docs are left
  // alone).
  for (const projectId of await corpusProjectIds(knowledgeDir)) {
    for (const doc of await listKnowledgeFiles(knowledgeDir, projectId)) {
      const marker = doc.nativeMemoryFrom;
      if (marker == null) continue; // not ours
      const homeTier = doc.slug.startsWith(HOME_SLUG_PREFIX);
      const misplacedHomeCopy = homeTier && projectId !== globalProjectId;
      const owned = destinations.get(marker);
      const remapped = owned !== undefined && !owned.has(`${projectId}/${doc.slug}`);
      const sourceGone =
        (!homeTier || includeHomeConfig) && !existsSync(marker) && existsSync(dirname(marker));
      if (!misplacedHomeCopy && !remapped && !sourceGone) continue;
      await deleteKnowledgeFile(knowledgeDir, projectId, doc.slug);
      resultFor(projectId).removed.push(doc.slug);
    }
  }

  const writeBack = await runWriteBack(baseDir, options.writeBack);

  return { results: [...resultsByProject.values()], writeBack };
}

/** Renders the managed KB-facts block written into CLAUDE.md. Pure and
 *  exported so a caller (or a test) can preview exactly what write-back emits. */
export function buildKbFactsBlock(facts: readonly WriteBackFact[]): string {
  const lines = facts.length
    ? facts.map((f) => `- **${f.title}** — ${f.body.trim()}`).join("\n")
    : "_No high-confidence facts to surface yet._";
  const body = [
    "## Standup — high-confidence knowledge (auto-written)",
    "",
    "Distilled from the shared knowledge base; edit through Standup, not here.",
    "",
    lines,
  ].join("\n");
  return `${KB_FACTS_BEGIN}\n${body}\n${KB_FACTS_END}`;
}

/**
 * The write-back seam. Returns undefined when disabled, so nothing reads or
 * writes CLAUDE.md by default. When enabled it always computes the block; it
 * only writes the file when `commit` is set (the live send), and even then only
 * when the block actually changes — the splice goes through the same shared
 * upsertManagedBlock the steering installer uses, so a re-run never duplicates.
 */
async function runWriteBack(
  baseDir: string,
  options: NativeMemoryWriteBackOptions | undefined
): Promise<NativeMemoryWriteBackResult | undefined> {
  if (!options?.enabled) return undefined;

  const targetPath = join(baseDir, ".claude", "CLAUDE.md");
  const facts = options.facts ?? [];
  const block = buildKbFactsBlock(facts);

  let committed = false;
  if (options.commit) {
    const existing = existsSync(targetPath) ? await readFile(targetPath, "utf-8") : "";
    const next = upsertManagedBlock(existing, block, KB_FACTS_BEGIN, KB_FACTS_END);
    if (next !== existing) {
      await mkdir(dirname(targetPath), { recursive: true });
      await writeFile(targetPath, next, "utf-8");
    }
    committed = true;
  }

  return {
    enabled: true,
    committed,
    targetPath,
    block,
    factCount: facts.length,
  };
}
