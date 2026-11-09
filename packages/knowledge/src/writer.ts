import { readFile, writeFile, unlink, mkdir, readdir, rename, link, stat } from "fs/promises";
import { existsSync } from "fs";
import { join, basename } from "path";
import matter from "gray-matter";
import { DEFAULT_SOURCE_KIND } from "./types.js";
import { coerceTags } from "./loader.js";
import { accountIdsRedactedFor, redactOptionsFor, redactSecrets } from "./redact.js";
import { frontmatterBody, spliceBody, spliceFrontmatter, type FrontmatterPatch } from "./frontmatter-splice.js";
import { HISTORY_SUBDIR, historySlugOf, historyStamp, normalizeInstant } from "./temporal.js";
import type { KnowledgeFrontmatter, OriginClass, Scope, SourceKind } from "./types.js";

/**
 * File-level CRUD for knowledge docs.
 *
 * Markdown files on disk stay the source of truth rather than the database:
 * they are editable outside the console, greppable, and survive the database
 * being deleted. SQLite is an index over them, rebuilt by sync.
 */

export interface KnowledgeDocInput {
  slug: string;
  title: string;
  body: string;
  tags?: string[];
  // Explicit graph edges (`related:` in frontmatter), each a `slug` or
  // `projectId/slug` target. The graph compile pass turns these into
  // knowledge_edges; markdown stays authoritative. Written only when present,
  // so a caller that asserts none leaves the frontmatter untouched.
  related?: string[];
  // Provenance — see writeKnowledgeFile's doc comment for who is responsible
  // for carrying this over on an edit, and why.
  generatedFromSha?: string;
  generatedAt?: string;
  // Trust class + authoring session (see OriginClass / loader.ts). Like
  // `related` above, writeKnowledgeFile only writes what it is handed, so an
  // edit route that rewrites a doc must read these back off the existing file
  // and pass them through — otherwise the full rewrite drops them and the doc
  // silently reverts to the loader's fail-safe `owner` default with its
  // session→doc provenance edge severed. The PUT edit route does exactly that.
  originClass?: OriginClass;
  sourceSessionId?: string;
  // Source kind + confidence bookkeeping (roadmap r2). Like the provenance
  // fields above, writeKnowledgeFile only writes what it is handed — the
  // caller decides whether an edit carries these over (the PUT route does).
  sourceKind?: SourceKind;
  // Scope + owning user (per-user knowledge). Like the fields above,
  // writeKnowledgeFile only writes what it is handed — the caller decides
  // whether an edit carries these over. A user-scoped doc names its owner in
  // `ownerUser`; a global/project doc leaves it undefined.
  scope?: Scope;
  ownerUser?: string;
  confidence?: number;
  lastVerifiedAt?: string;
  halfLifeDays?: number;
  // Absolute path of the Claude Code native-memory file this doc mirrors, when
  // written by the native-memory ingest. Emitted as the `native_memory_from`
  // marker so a re-ingest can tell its own auto-mirrored files (safe to refresh
  // or remove) apart from a hand-authored corpus doc, which never carries it.
  nativeMemoryFrom?: string;
  // When the written body became current (`valid_from`, see temporal.ts).
  // Written only when handed, like the fields above.
  validFrom?: string;
}

export interface KnowledgeDocFile {
  slug: string;
  title: string;
  body: string;
  tags: string[];
  updatedAt: Date;
  generatedFromSha?: string;
  generatedAt?: string;
  // Explicit graph edges (`related:`/`edges:`) and provenance (trust class +
  // authoring session), surfaced raw off the file — undefined when the file
  // asserts none, NOT the loader's `owner` default — so an edit route can
  // round-trip exactly what was on disk without stamping a class the doc never
  // carried. The graph derives its cross-project edges and session→doc
  // provenance from these, so a rewrite that dropped them would sever them.
  related?: string[];
  originClass?: OriginClass;
  sourceSessionId?: string;
  // Source kind + confidence bookkeeping (roadmap r2). sourceKind is always
  // concrete ('unclassified' when the file asserts none); the confidence fields stay
  // undefined for a doc that never asserted an opinion.
  sourceKind: SourceKind;
  // Scope + owning user, surfaced raw off the file — undefined when the file
  // asserts none, NOT the loader's 'project' default — so an edit route can
  // round-trip exactly what was on disk without stamping a scope the doc never
  // carried. (The loader applies the 'project' default on ingest.)
  scope?: Scope;
  ownerUser?: string;
  confidence?: number;
  lastVerifiedAt?: string;
  halfLifeDays?: number;
  // The native-memory ingest marker, surfaced raw off the file — undefined for
  // a doc that never carried it. Lets the ingest round-trip the marker and tell
  // its own auto-mirrored files apart from a hand-authored corpus doc.
  nativeMemoryFrom?: string;
}

/**
 * Slugs become filenames and are used in URLs, so they are constrained
 * rather than sanitized — silently rewriting what someone typed makes the
 * doc hard to find again.
 */
export function isValidSlug(slug: unknown): slug is string {
  // typeof first: RegExp.test coerces its argument, so undefined would be
  // tested as the string "undefined" and pass.
  return typeof slug === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/i.test(slug);
}

/** Longest tag accepted on a write; a tag is a label, not prose. */
export const MAX_TAG_LENGTH = 48;
/** Most tags one doc may carry. */
export const MAX_TAGS = 16;

/**
 * Normalizes caller-supplied tags into the stored list: an array of strings or
 * one comma-separated string, each trimmed and lowercased, empties and
 * duplicates dropped. A tag must be letters, digits, `-`, `_`, `.`, `/` or `:`
 * (it renders as a chip and keys tag-overlap scoring, so whitespace and
 * punctuation would split or collide). Returns an error naming the first
 * offending value rather than silently dropping it.
 */
export function normalizeTags(
  input: unknown
): { ok: true; tags: string[] | undefined } | { ok: false; error: string } {
  if (input === undefined || input === null) return { ok: true, tags: undefined };
  let raw: unknown[];
  if (typeof input === "string") raw = input.split(",");
  else if (Array.isArray(input)) raw = input.flatMap((t) => (typeof t === "string" ? t.split(",") : [t]));
  else return { ok: false, error: "tags must be an array of strings or a comma-separated string" };
  const tags: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string") {
      return { ok: false, error: "tags must be an array of strings or a comma-separated string" };
    }
    const tag = value.trim().toLowerCase();
    if (!tag) continue;
    if (tag.length > MAX_TAG_LENGTH || !/^[a-z0-9][a-z0-9._:/-]*$/.test(tag)) {
      return {
        ok: false,
        error: `invalid tag "${tag.slice(0, MAX_TAG_LENGTH)}": tags are up to ${MAX_TAG_LENGTH} letters, digits, "-", "_", ".", "/" or ":"`,
      };
    }
    if (!tags.includes(tag)) tags.push(tag);
  }
  if (tags.length > MAX_TAGS) return { ok: false, error: `at most ${MAX_TAGS} tags per doc` };
  return { ok: true, tags: tags.length > 0 ? tags : undefined };
}

/**
 * Whether a project id or slug can name one path segment under the knowledge
 * dir: non-empty, not `.` or `..`, and free of path separators and NUL. A
 * route parameter decodes `%2F`, so without this check `../other/doc` would
 * reach a file outside its project. Looser than isValidSlug because the
 * loader indexes any `*.md` file name as a slug.
 */
export function isSafePathSegment(segment: string): boolean {
  return segment.length > 0 && segment !== "." && segment !== ".." && !/[/\\\0]/.test(segment);
}

function safeIds(projectId: string, slug: string): boolean {
  return isSafePathSegment(projectId) && isSafePathSegment(slug);
}

function assertSafeIds(projectId: string, slug: string): void {
  if (!safeIds(projectId, slug)) {
    throw new Error("Project id and slug must each be a single path segment.");
  }
}

function docPath(knowledgeDir: string, projectId: string, slug: string): string {
  assertSafeIds(projectId, slug);
  return join(knowledgeDir, projectId, `${slug}.md`);
}

function draftPath(knowledgeDir: string, projectId: string, slug: string): string {
  assertSafeIds(projectId, slug);
  return join(knowledgeDir, projectId, ".drafts", `${slug}.md`);
}

/**
 * The title and body a doc is written with: redacted under the options its
 * placement calls for (redactOptionsFor — the "full" tier for the personal
 * layer and global content, the "signature" tier plus account ids for a
 * project-scoped team doc). Every accepted-doc and draft write converges
 * here, so no publish path lands an unredacted secret in the corpus.
 * Idempotent, so text a caller already redacted passes through unchanged.
 */
function redactedText(projectId: string, doc: KnowledgeDocInput): { title: string; body: string } {
  const opts = redactOptionsFor({ projectId, scope: doc.scope, sourceKind: doc.sourceKind, slug: doc.slug });
  return { title: redactSecrets(doc.title, opts), body: redactSecrets(doc.body, opts) };
}

export async function listKnowledgeFiles(
  knowledgeDir: string,
  projectId: string
): Promise<KnowledgeDocFile[]> {
  if (!isSafePathSegment(projectId)) return [];
  const dir = join(knowledgeDir, projectId);
  if (!existsSync(dir)) return [];

  const files = (await readdir(dir)).filter((f) => f.endsWith(".md"));
  const docs: KnowledgeDocFile[] = [];

  for (const file of files) {
    const doc = await readKnowledgeFile(knowledgeDir, projectId, basename(file, ".md"));
    if (doc) docs.push(doc);
  }

  return docs.sort((a, b) => a.slug.localeCompare(b.slug));
}

export async function readKnowledgeFile(
  knowledgeDir: string,
  projectId: string,
  slug: string
): Promise<KnowledgeDocFile | null> {
  if (!safeIds(projectId, slug)) return null;
  const path = docPath(knowledgeDir, projectId, slug);
  if (!existsSync(path)) return null;

  try {
    const raw = await readFile(path, "utf-8");
    const { data, content } = matter(raw);
    const frontmatter = data as {
      title?: string;
      tags?: string[];
      generated_from_sha?: string;
      generated_at?: string;
      related?: string[];
      edges?: string[];
      origin_class?: OriginClass;
      source_session_id?: string;
      source_kind?: SourceKind;
      scope?: Scope;
      owner_user?: string;
      confidence?: number;
      last_verified_at?: string;
      half_life_days?: number;
      native_memory_from?: string;
    };
    const { mtime } = await Bun.file(path).stat();

    return {
      slug,
      title: frontmatter.title ?? slug,
      body: content.trim(),
      tags: coerceTags(frontmatter.tags) ?? [],
      updatedAt: mtime,
      // undefined (not ""), same empty-string-is-not-NULL discipline as
      // loader.ts — Step 6 keys "is this generated" off exactly this.
      generatedFromSha: frontmatter.generated_from_sha,
      generatedAt: frontmatter.generated_at,
      // `edges:` is an alias for `related:` (loader.ts honors both); either
      // names explicit graph edges. Provenance is read raw — undefined stays
      // undefined so a round-tripping edit never fabricates an origin_class the
      // file did not carry (the loader applies the `owner` default on ingest).
      related: frontmatter.related ?? frontmatter.edges,
      originClass: frontmatter.origin_class,
      sourceSessionId: frontmatter.source_session_id,
      // Source kind is always concrete; an unasserted file reads 'unclassified'
      // (roadmap r2). The confidence fields stay undefined when absent so a
      // doc with no opinion isn't handed a fabricated one.
      sourceKind: frontmatter.source_kind ?? DEFAULT_SOURCE_KIND,
      // Scope + owning user read raw — undefined stays undefined so a
      // round-tripping edit never fabricates a scope the file did not carry
      // (the loader applies the 'project' default on ingest).
      scope: frontmatter.scope,
      ownerUser: frontmatter.owner_user,
      confidence: frontmatter.confidence,
      lastVerifiedAt: frontmatter.last_verified_at,
      halfLifeDays: frontmatter.half_life_days,
      // Read raw — undefined for a doc that never carried the marker, so a
      // hand-authored corpus doc is never mistaken for an ingest-owned one.
      nativeMemoryFrom: frontmatter.native_memory_from,
    };
  } catch {
    return null;
  }
}

/**
 * Writes only what `doc` carries — it does not look up what's already on
 * disk, so whether an edit preserves the doc's provenance and graph edges is
 * entirely the caller's decision. It CAN re-emit every frontmatter field
 * (`related`, `origin_class`, `source_session_id`, `generated_from_sha`, the
 * confidence stamp), but only those it is handed — a rewrite that omits them
 * drops them. The general PUT /api/projects/:id/knowledge/:slug route reads the
 * existing file first (readKnowledgeFile surfaces all of these) and passes them
 * back through, because a typo fix on a distilled doc must not silently make
 * staleness forget the doc was generated, sever its cross-project `related:`
 * edges, or revert its trust class to the loader's `owner` default. The
 * merge-accept path in server.ts calls this *without* that carry-over on
 * purpose instead: merging is combining two documents' worth of content into
 * one, a large enough act that the result is fairly called partly the human's
 * own, unlike a plain edit.
 */
export async function writeKnowledgeFile(
  knowledgeDir: string,
  projectId: string,
  doc: KnowledgeDocInput
): Promise<void> {
  if (!isValidSlug(doc.slug)) {
    throw new Error(
      "Slug must be letters, numbers and hyphens — it becomes a filename."
    );
  }

  assertSafeIds(projectId, doc.slug);
  const dir = join(knowledgeDir, projectId);
  await mkdir(dir, { recursive: true });
  const { title, body } = redactedText(projectId, doc);

  // gray-matter's stringify handles escaping, which hand-rolling YAML would
  // get wrong the first time a title contains a colon.
  const contents = matter.stringify(body.trim() + "\n", {
    title,
    ...(doc.tags?.length ? { tags: doc.tags } : {}),
    ...(doc.related?.length ? { related: doc.related } : {}),
    ...(doc.generatedFromSha ? { generated_from_sha: doc.generatedFromSha } : {}),
    ...(doc.generatedAt ? { generated_at: doc.generatedAt } : {}),
    ...(doc.originClass ? { origin_class: doc.originClass } : {}),
    ...(doc.sourceSessionId ? { source_session_id: doc.sourceSessionId } : {}),
    ...(doc.sourceKind ? { source_kind: doc.sourceKind } : {}),
    ...(doc.scope ? { scope: doc.scope } : {}),
    ...(doc.ownerUser ? { owner_user: doc.ownerUser } : {}),
    // `!= null` (not truthiness): confidence 0 is a real, meaningful value.
    ...(doc.confidence != null ? { confidence: doc.confidence } : {}),
    ...(doc.lastVerifiedAt ? { last_verified_at: doc.lastVerifiedAt } : {}),
    ...(doc.halfLifeDays != null ? { half_life_days: doc.halfLifeDays } : {}),
    ...(doc.nativeMemoryFrom ? { native_memory_from: doc.nativeMemoryFrom } : {}),
    ...(doc.validFrom ? { valid_from: doc.validFrom } : {}),
  });

  await writeFile(docPath(knowledgeDir, projectId, doc.slug), contents, "utf-8");
}

/**
 * Patches ONLY the named frontmatter keys of an existing accepted doc, leaving
 * its body and every other frontmatter field untouched. This is what the
 * re-verification pass (roadmap r5) uses to write back `confidence` and
 * `last_verified_at` without disturbing a doc's `origin_class`,
 * `source_session_id`, `related`, `generated_from_sha`, etc. — a full rewrite
 * through writeKnowledgeFile re-emits only the fields it is HANDED, so the
 * re-verify pass (which has no reason to load and re-pass all of a doc's
 * provenance just to bump two fields) uses this key-level patch instead.
 *
 * The edit is textual (spliceFrontmatter): only the named keys' lines change,
 * so comments, date formats, flow lists and every other byte of the file stay
 * as written. A key whose patch value is undefined is left alone.
 *
 * A patch that moves the doc into a placement whose redaction is wider — a
 * scope=global or personal-layer doc redacts account ids, a project doc does
 * not — re-redacts the body and title under the new placement, so a doc
 * written under project scope never reaches the global set carrying the
 * account ids project scope keeps. A patched title is redacted under the
 * resulting placement either way.
 *
 * Returns false when the doc file does not exist.
 */
export async function updateDocFrontmatter(
  knowledgeDir: string,
  projectId: string,
  slug: string,
  patch: Partial<KnowledgeFrontmatter>
): Promise<boolean> {
  if (!safeIds(projectId, slug)) return false;
  const path = docPath(knowledgeDir, projectId, slug);
  if (!existsSync(path)) return false;

  const raw = await readFile(path, "utf-8");
  const { data } = matter(raw);
  const edits: FrontmatterPatch = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) edits[key] = value as FrontmatterPatch[string];
  }
  const placement = (fm: Record<string, unknown>) => ({
    projectId,
    slug,
    scope: typeof fm.scope === "string" ? fm.scope : undefined,
    sourceKind: typeof fm.source_kind === "string" ? fm.source_kind : undefined,
  });
  const before = placement(data);
  const after = placement({ ...data, ...edits });
  const opts = redactOptionsFor(after);
  const widened = accountIdsRedactedFor(after) && !accountIdsRedactedFor(before);

  if (typeof edits.title === "string") edits.title = redactSecrets(edits.title, opts);
  else if (widened && typeof data.title === "string") {
    const title = redactSecrets(data.title, opts);
    if (title !== data.title) edits.title = title;
  }
  let next = spliceFrontmatter(raw, edits);
  if (widened) {
    const body = frontmatterBody(next);
    const redacted = redactSecrets(body, opts);
    if (redacted !== body) next = spliceBody(next, redacted);
  }
  if (next !== raw) await writeFile(path, next, "utf-8");
  return true;
}

/** A doc file split into its raw front matter and body, as gray-matter reads it. */
export interface RawDocFile {
  data: Record<string, unknown>;
  content: string;
}

/**
 * Reads a doc file's raw front matter and body, every key kept (including
 * markers and keys this package does not model), or null when the file is
 * absent. Timestamps gray-matter parsed into Dates come back as ISO strings.
 * The pair round-trips through writeRawDocFile for an edit that must change
 * only what it names.
 */
export async function readRawDocFile(
  knowledgeDir: string,
  projectId: string,
  slug: string
): Promise<RawDocFile | null> {
  if (!safeIds(projectId, slug)) return null;
  const path = docPath(knowledgeDir, projectId, slug);
  if (!existsSync(path)) return null;
  const { data, content } = matter(await readFile(path, "utf-8"));
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    normalized[key] = value instanceof Date ? value.toISOString() : value;
  }
  return { data: normalized, content };
}

/** Writes a doc file from raw front matter and body (see readRawDocFile). */
export async function writeRawDocFile(
  knowledgeDir: string,
  projectId: string,
  slug: string,
  file: RawDocFile
): Promise<void> {
  await writeFile(docPath(knowledgeDir, projectId, slug), matter.stringify(file.content, file.data), "utf-8");
}

/**
 * Deletes an accepted doc and every closed version of it under
 * `<project>/.history/`, so a removed doc leaves no copy of its text behind;
 * the next sync drops the history rows whose file is gone.
 */
export async function deleteKnowledgeFile(
  knowledgeDir: string,
  projectId: string,
  slug: string
): Promise<boolean> {
  if (!safeIds(projectId, slug)) return false;
  const path = docPath(knowledgeDir, projectId, slug);
  if (!existsSync(path)) return false;
  await unlink(path);
  const dir = join(knowledgeDir, projectId, HISTORY_SUBDIR);
  for (const file of await historyFilesOf(dir, slug)) await unlink(join(dir, file));
  return true;
}

/** How many closed versions archiveDocVersion keeps per doc; older ones are deleted. */
export const HISTORY_VERSIONS_KEPT = 10;

/**
 * A history file name `<slug>.<stamp>[-n].md` split into `<slug>.<stamp>` and
 * its collision counter `n`, the bare name counting as 1.
 */
function historyFileKey(file: string): [string, number] {
  const stem = file.slice(0, -".md".length);
  // historyStamp ends in the instant's `Z`, so only a counter follows it.
  const counter = /Z-(\d+)$/.exec(stem);
  return counter ? [stem.slice(0, counter.index + 1), Number(counter[1])] : [stem, 1];
}

/**
 * The history file names of one doc in a `.history/` dir, oldest first: by
 * stamp (the version's valid_from, which sorts by time), then by collision
 * counter numerically.
 */
async function historyFilesOf(dir: string, slug: string): Promise<string[]> {
  let files: string[];
  try {
    files = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return files
    .filter((file) => file.endsWith(".md") && historySlugOf(file) === slug)
    .sort((a, b) => {
      const [stampA, nA] = historyFileKey(a);
      const [stampB, nB] = historyFileKey(b);
      if (stampA !== stampB) return stampA < stampB ? -1 : 1;
      return nA - nB;
    });
}

/** How moveDocFile ended: moved, refused because the target slug exists, or no source file. */
export type DocMoveOutcome = "moved" | "exists" | "missing";

/**
 * Moves an accepted doc file `{from}/{slug}.md` to `{to}/{slug}.md` with its
 * bytes untouched, so every frontmatter key (scope, owner, provenance,
 * confidence) travels as written. Never overwrites: the target is created with
 * a hard link, which fails atomically when the slug already exists in `to`,
 * and only then is the source unlinked.
 */
export async function moveDocFile(
  knowledgeDir: string,
  fromProjectId: string,
  toProjectId: string,
  slug: string
): Promise<DocMoveOutcome> {
  if (!safeIds(fromProjectId, slug) || !safeIds(toProjectId, slug)) return "missing";
  const from = docPath(knowledgeDir, fromProjectId, slug);
  const to = docPath(knowledgeDir, toProjectId, slug);
  await mkdir(join(knowledgeDir, toProjectId), { recursive: true });
  try {
    await link(from, to);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return "exists";
    if (code === "ENOENT") return "missing";
    throw err;
  }
  await unlink(from);
  return "moved";
}

export interface KnowledgeDraftInput extends KnowledgeDocInput {
  // generatedFromSha/generatedAt come from KnowledgeDocInput.
  generatedByLaunchId?: string;
  replacesSlug?: string;
  // The session that authored this draft, and the trust class it earns.
  // Stamped by the collector rather than the agent, and carried into the
  // accepted doc's frontmatter on acceptDraftFile's rename — that is what
  // lets loadProject populate KnowledgeDoc.sourceSessionId/originClass so the
  // graph derives session→doc + doc→doc provenance edges for the real
  // authoring pipeline, not only for hand-written frontmatter.
  sourceSessionId?: string;
  originClass?: OriginClass;
}

export async function writeDraftFile(
  knowledgeDir: string,
  projectId: string,
  draft: KnowledgeDraftInput
): Promise<void> {
  if (!isValidSlug(draft.slug)) {
    throw new Error(
      "Slug must be letters, numbers and hyphens — it becomes a filename."
    );
  }

  assertSafeIds(projectId, draft.slug);
  const dir = join(knowledgeDir, projectId, ".drafts");
  await mkdir(dir, { recursive: true });
  const { title, body } = redactedText(projectId, draft);

  const contents = matter.stringify(body.trim() + "\n", {
    title,
    ...(draft.tags?.length ? { tags: draft.tags } : {}),
    ...(draft.related?.length ? { related: draft.related } : {}),
    ...(draft.generatedFromSha ? { generated_from_sha: draft.generatedFromSha } : {}),
    ...(draft.generatedAt ? { generated_at: draft.generatedAt } : {}),
    ...(draft.generatedByLaunchId ? { generated_by_launch_id: draft.generatedByLaunchId } : {}),
    ...(draft.replacesSlug ? { replaces_slug: draft.replacesSlug } : {}),
    ...(draft.originClass ? { origin_class: draft.originClass } : {}),
    ...(draft.sourceSessionId ? { source_session_id: draft.sourceSessionId } : {}),
    // Source kind + confidence bookkeeping (roadmap r2). Written into the
    // draft frontmatter so acceptDraftFile's plain rename carries them up into
    // the accepted doc, where loadProject reads them back.
    ...(draft.sourceKind ? { source_kind: draft.sourceKind } : {}),
    // Scope + owning user, written into the draft frontmatter for the same
    // reason: acceptDraftFile's rename carries them up onto the accepted doc,
    // where loadProject reads them back (a proposed scope survives to accept).
    ...(draft.scope ? { scope: draft.scope } : {}),
    ...(draft.ownerUser ? { owner_user: draft.ownerUser } : {}),
    ...(draft.confidence != null ? { confidence: draft.confidence } : {}),
    ...(draft.lastVerifiedAt ? { last_verified_at: draft.lastVerifiedAt } : {}),
    ...(draft.halfLifeDays != null ? { half_life_days: draft.halfLifeDays } : {}),
  });

  await writeFile(draftPath(knowledgeDir, projectId, draft.slug), contents, "utf-8");
}

/** How archiveDocVersion closes the version it keeps. */
export interface DocVersionClose {
  /** When the version stopped being current (ISO-8601). */
  closedAt: string;
  /** The `project/slug` that replaced it; defaults to the doc itself. */
  supersededBy?: string;
  /** The body about to replace it: an identical body keeps no version. */
  nextBody?: string;
}

/**
 * Keeps the current version of an accepted doc as a closed history file,
 * `<project>/.history/<slug>.<stamp>.md`, before something replaces its body.
 * The copy is the file byte for byte except its validity keys: `valid_from`
 * (the file's own, else generated_at, else its mtime), `valid_to` = closedAt
 * and `superseded_by`, and the title and body redacted under the doc's
 * placement (redactOptionsFor). Only the newest HISTORY_VERSIONS_KEPT versions
 * of a doc are kept; older ones are deleted. The loader skips `.history/`
 * like `.drafts/`, so the copy never joins the corpus; it is indexed apart
 * (knowledge_history) and reached only by an `asOf` search. Returns the history file's path, or null
 * when there is no doc or the replacing body is the same text.
 */
export async function archiveDocVersion(
  knowledgeDir: string,
  projectId: string,
  slug: string,
  close: DocVersionClose
): Promise<string | null> {
  if (!safeIds(projectId, slug)) return null;
  const path = docPath(knowledgeDir, projectId, slug);
  if (!existsSync(path)) return null;
  const raw = await readFile(path, "utf-8");
  if (close.nextBody !== undefined && frontmatterBody(raw).trim() === close.nextBody.trim()) return null;

  const { data } = matter(raw);
  const { mtime } = await stat(path);
  const declared =
    normalizeInstant(data.valid_from) ?? normalizeInstant(data.generated_at) ?? mtime.toISOString();
  // A start after the close (a future-dated generated_at) would make an
  // interval no instant falls in.
  const validFrom = declared > close.closedAt ? close.closedAt : declared;
  const opts = redactOptionsFor({
    projectId,
    slug,
    scope: typeof data.scope === "string" ? data.scope : undefined,
    sourceKind: typeof data.source_kind === "string" ? data.source_kind : undefined,
  });
  const patch: FrontmatterPatch = {
    valid_from: validFrom,
    valid_to: close.closedAt,
    superseded_by: close.supersededBy ?? `${projectId}/${slug}`,
  };
  if (typeof data.title === "string") {
    const title = redactSecrets(data.title, opts);
    if (title !== data.title) patch.title = title;
  }
  let contents = spliceFrontmatter(raw, patch);
  const body = frontmatterBody(contents);
  const redactedBody = redactSecrets(body, opts);
  if (redactedBody !== body) contents = spliceBody(contents, redactedBody);

  const dir = join(knowledgeDir, projectId, HISTORY_SUBDIR);
  await mkdir(dir, { recursive: true });
  const stamp = historyStamp(validFrom);
  // Past the highest counter already used for this stamp, so a version never
  // takes a name retention freed and sorts after every earlier one.
  const base = `${slug}.${stamp}`;
  let n = 1;
  for (const file of await historyFilesOf(dir, slug)) {
    const [fileBase, counter] = historyFileKey(file);
    if (fileBase === base) n = Math.max(n, counter + 1);
  }
  for (; ; n++) {
    const target = join(dir, n === 1 ? `${slug}.${stamp}.md` : `${slug}.${stamp}-${n}.md`);
    try {
      await writeFile(target, contents, { encoding: "utf-8", flag: "wx" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      continue;
    }
    const versions = await historyFilesOf(dir, slug);
    const kept = new Set(versions.slice(-HISTORY_VERSIONS_KEPT));
    kept.add(basename(target));
    for (const file of versions) if (!kept.has(file)) await unlink(join(dir, file));
    return target;
  }
}

/**
 * Moves `.drafts/{slug}.md` up to `{slug}.md`. A rename rather than a
 * re-serialization through gray-matter, which would risk reformatting the
 * provenance frontmatter the point of this function is to preserve.
 *
 * When the move replaces an accepted doc with a different body, the prior
 * version is kept first (archiveDocVersion: closed at the accept time,
 * superseded by the doc itself) and the draft's `valid_from` is spliced to the
 * accept time, so the replaced claim is closed rather than overwritten. A
 * replace with the same body keeps no version and leaves the doc's validity as
 * it was.
 */
export async function acceptDraftFile(
  knowledgeDir: string,
  projectId: string,
  slug: string,
  options: { acceptedAt?: Date } = {}
): Promise<boolean> {
  if (!safeIds(projectId, slug)) return false;
  const from = draftPath(knowledgeDir, projectId, slug);
  if (!existsSync(from)) return false;

  const to = docPath(knowledgeDir, projectId, slug);
  await mkdir(join(knowledgeDir, projectId), { recursive: true });
  if (existsSync(to)) {
    const acceptedAt = (options.acceptedAt ?? new Date()).toISOString();
    const draft = await readFile(from, "utf-8");
    const archived = await archiveDocVersion(knowledgeDir, projectId, slug, {
      closedAt: acceptedAt,
      nextBody: frontmatterBody(draft),
    });
    if (archived) {
      await writeFile(
        from,
        spliceFrontmatter(draft, { valid_from: acceptedAt, valid_to: null, superseded_by: null }),
        "utf-8"
      );
    }
  }
  await rename(from, to);
  return true;
}

/** Whether a pending draft (`.drafts/{slug}.md`) exists for the slug; false for unsafe ids. */
export function draftFileExists(knowledgeDir: string, projectId: string, slug: string): boolean {
  return safeIds(projectId, slug) && existsSync(draftPath(knowledgeDir, projectId, slug));
}

export async function deleteDraftFile(
  knowledgeDir: string,
  projectId: string,
  slug: string
): Promise<boolean> {
  if (!safeIds(projectId, slug)) return false;
  const path = draftPath(knowledgeDir, projectId, slug);
  if (!existsSync(path)) return false;
  await unlink(path);
  return true;
}
