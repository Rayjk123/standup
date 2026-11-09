import { watch, type FSWatcher } from "fs";
import { mkdir, readdir, readFile, stat, unlink, writeFile } from "fs/promises";
import { join, basename, sep } from "path";
import matter from "gray-matter";
import { GLOBAL_PROJECT_ID } from "@standup/shared";
import { DEFAULT_SOURCE_KIND, DEFAULT_SCOPE, SCOPES } from "./types.js";
import type {
  KnowledgeDoc,
  KnowledgeFrontmatter,
  KnowledgeDraft,
  DraftFrontmatter,
  KnowledgeHistoryVersion,
  Scope,
} from "./types.js";
import { HISTORY_SUBDIR, historySlugOf, normalizeInstant } from "./temporal.js";
import { randomUUID } from "crypto";

const DRAFTS_SUBDIR = ".drafts";
// Name prefix of the fence files flushWatchEvents writes at the top of the
// knowledge directory. Not a .md file and not a directory, so no project and
// no loader ever reads one.
const FENCE_PREFIX = ".standup-watch-fence-";

/**
 * Normalizes a frontmatter timestamp to a string. js-yaml (via gray-matter)
 * auto-parses an UNQUOTED ISO-8601 / date scalar — the natural way a human
 * writes a YAML date — into a JS Date, but these fields land in TEXT columns
 * that bun:sqlite refuses to bind a Date to ("Binding expected string, …"),
 * which would abort the whole sync. Since the frontmatter contract explicitly
 * invites hand-authored `last_verified_at:` / `generated_at:`, coerce a Date
 * back to its ISO string here so the quoted and unquoted spellings behave
 * identically. Absent stays undefined (never "") so downstream NULL checks hold.
 */
function coerceTimestamp(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" ? value : String(value);
}

/**
 * Normalizes frontmatter `tags` to a string list. A hand-written
 * `tags: 'a,b,c'` parses as one string, which would reach the index as a
 * non-array and fail every write that joins the tags, so a string is split on
 * commas. Non-string entries are dropped; anything else reads as absent.
 */
export function coerceTags(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.filter((t): t is string => typeof t === "string");
  if (typeof value === "string") {
    return value
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
  }
  return undefined;
}

/**
 * Coerces a frontmatter scope to a known enum value, falling back to `fallback`
 * (the project's default scope) when absent or out-of-set. A hand-authored typo
 * or casing slip (`gobal`, `Global`) falls outside the closed SCOPES set, so it
 * reads back as the fallback rather than persisting an invalid enum that would
 * later match no retrieval window. Absent reads the fallback too. Mirrors how
 * the store fail-closes its other enums to a known value rather than trusting
 * the input verbatim. The fallback is DEFAULT_SCOPE ('project') for an ordinary
 * project, but 'global' for the reserved GLOBAL corpus (see loadProject).
 */
function coerceScope(value: Scope | undefined, fallback: Scope = DEFAULT_SCOPE): Scope {
  return value !== undefined && SCOPES.includes(value) ? value : fallback;
}

/**
 * The project a watcher event under the knowledge directory touched: the first
 * segment of its relative path, null when the event names no path, and
 * undefined for a change loadProject cannot see (anything under `.drafts/`, or
 * a path that is not inside any project directory).
 */
export function watchedProjectOf(filename: string | Buffer | null | undefined): string | null | undefined {
  if (filename === null || filename === undefined) return null;
  const segments = filename.toString().split(sep).filter(Boolean);
  if (segments.length === 0) return null;
  if (segments.length > 1 && segments[1] === DRAFTS_SUBDIR) return undefined;
  return segments[0];
}

export class KnowledgeLoader {
  private knowledgeDir: string;
  private watcher?: FSWatcher;
  /** Fence file name → resolves its flushWatchEvents wait (see there). */
  private fenceWaiters = new Map<string, () => void>();
  private fenceCount = 0;

  constructor(knowledgeDir: string) {
    this.knowledgeDir = knowledgeDir;
  }

  async loadProject(projectId: string): Promise<KnowledgeDoc[]> {
    const projectDir = join(this.knowledgeDir, projectId);
    const docs: KnowledgeDoc[] = [];

    // A doc physically homed in the reserved GLOBAL corpus dir exists to reach
    // every session, so its default scope is 'global', not 'project'. Pre-existing
    // best-practice docs there carry no `scope:` frontmatter; without this they'd
    // resolve to DEFAULT_SCOPE ('project') and — since their project_id is 'global',
    // not the asking project — fall out of the strict scope gate entirely, silently
    // dropping the whole global KB from launch injection and scoped search. An
    // explicit in-set `scope:` is still honored (a deliberately user/project-scoped
    // doc placed here stays that way); only the absent/typo'd case reads 'global'.
    // Deriving it here (rather than only backfilling the DB) is what lets the
    // correct scope survive the mtime-skip resync.
    const defaultScope: Scope =
      projectId === GLOBAL_PROJECT_ID ? "global" : DEFAULT_SCOPE;

    try {
      const files = await readdir(projectDir);

      for (const file of files) {
        // Also excludes .drafts and .history: readdir returns the directory name
        // unqualified, which fails this same check. Relied on rather than
        // asserted here — see loader.test.ts for the assertion, since Step 1
        // makes this load-bearing instead of accidental.
        if (!file.endsWith(".md")) continue;

        const filePath = join(projectDir, file);
        const [content, fileStat] = await Promise.all([
          readFile(filePath, "utf-8"),
          stat(filePath),
        ]);
        const { data, content: body } = matter(content);
        const frontmatter = data as KnowledgeFrontmatter;

        const slug = basename(file, ".md");

        docs.push({
          id: randomUUID(),
          projectId,
          slug,
          title: frontmatter.title ?? slug,
          body: body.trim(),
          tags: coerceTags(frontmatter.tags),
          // The file's real mtime, not "now" — this is what lets syncProject
          // skip re-embedding unchanged files on every lazy resync.
          updatedAt: fileStat.mtime,
          filePath,
          // Carried over when acceptDraftFile moves a draft up — undefined
          // (not "") for a human-authored doc, per the empty-string-is-not-
          // NULL gotcha in runbook.md.
          generatedFromSha: frontmatter.generated_from_sha,
          generatedAt: coerceTimestamp(frontmatter.generated_at),
          // `edges:` is accepted as an alias for `related:` — either names
          // explicit graph edges the compile pass materializes.
          related: frontmatter.related ?? frontmatter.edges,
          // Provenance read off the file. A doc sitting in the user's own
          // knowledge directory is authored within the single trust boundary
          // (see Phase 1 — sessions run as the host user), so an unasserted
          // class resolves to `owner` here, mirroring how OpenClaw classes a
          // user's own memory-workspace files. That keeps hand-written docs
          // eligible for the auto-injection gate rather than
          // silently excluded. The store's fail-closed `untrusted` default
          // still guards any programmatic upsert that goes around the loader
          // (e.g. a future untrusted/remote ingest), which stamps its class
          // explicitly; frontmatter that declares `origin_class` is honored.
          // A `scope: user` file is the exception: it would put words in its
          // owner's mouth, and any process running as the host user can write
          // one, so an unasserted class there reads `agent` — only a write the
          // collector made for the owner says otherwise.
          originClass:
            frontmatter.origin_class ??
            (coerceScope(frontmatter.scope, defaultScope) === "user" ? "agent" : "owner"),
          sourceSessionId: frontmatter.source_session_id,
          // Source kind + confidence bookkeeping (roadmap r2). An unasserted
          // sourceKind reads 'unclassified' — a doc is not presumed to be a
          // code fact; the confidence fields stay undefined when absent so a
          // doc with no opinion isn't handed a fabricated one.
          sourceKind: frontmatter.source_kind ?? DEFAULT_SOURCE_KIND,
          // Scope + owning user (per-user knowledge). An unasserted OR out-of-set
          // scope reads the project's default scope ('project' for an ordinary
          // project, 'global' for the reserved GLOBAL corpus) — a doc belongs to
          // its project unless promoted, and a hand-authored typo coerces to the
          // default rather than persisting an invalid enum; ownerUser stays
          // undefined unless the file names one (a 'user'-scoped doc).
          scope: coerceScope(frontmatter.scope, defaultScope),
          ownerUser: frontmatter.owner_user,
          confidence: frontmatter.confidence,
          lastVerifiedAt: coerceTimestamp(frontmatter.last_verified_at),
          halfLifeDays: frontmatter.half_life_days,
          // Validity interval, raw: the store resolves an absent valid_from.
          validFrom: normalizeInstant(frontmatter.valid_from),
          validTo: normalizeInstant(frontmatter.valid_to),
          supersededBy: typeof frontmatter.superseded_by === "string" ? frontmatter.superseded_by : undefined,
        });
      }
    } catch (err) {
      // Directory doesn't exist yet, that's fine
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }

    return docs;
  }

  /**
   * Mirrors loadProject over `.drafts/` instead of the project directory.
   * Kept as a separate method (rather than a flag on loadProject) because the
   * two produce different shapes — a draft has no embedding and carries
   * review provenance loadProject's callers don't expect.
   */
  async loadDrafts(projectId: string): Promise<KnowledgeDraft[]> {
    const draftsDir = join(this.knowledgeDir, projectId, DRAFTS_SUBDIR);
    const drafts: KnowledgeDraft[] = [];

    try {
      const files = await readdir(draftsDir);

      for (const file of files) {
        if (!file.endsWith(".md")) continue;

        const filePath = join(draftsDir, file);
        const [content, fileStat] = await Promise.all([
          readFile(filePath, "utf-8"),
          stat(filePath),
        ]);
        const { data, content: body } = matter(content);
        const frontmatter = data as DraftFrontmatter;

        const slug = basename(file, ".md");

        drafts.push({
          id: randomUUID(),
          projectId,
          slug,
          title: frontmatter.title ?? slug,
          body: body.trim(),
          tags: coerceTags(frontmatter.tags),
          filePath,
          updatedAt: fileStat.mtime,
          generatedFromSha: frontmatter.generated_from_sha,
          generatedAt: coerceTimestamp(frontmatter.generated_at),
          generatedByLaunchId: frontmatter.generated_by_launch_id,
          replacesSlug: frontmatter.replaces_slug,
          // Source kind + confidence bookkeeping (roadmap r2), carried so a
          // draft edit round-trips them and accept lands them on the doc.
          sourceKind: frontmatter.source_kind,
          confidence: frontmatter.confidence,
          lastVerifiedAt: coerceTimestamp(frontmatter.last_verified_at),
          halfLifeDays: frontmatter.half_life_days,
          // Scope + owning user, carried RAW (undefined when absent, no
          // 'project' default) for the same reason as source_kind: a body edit
          // must round-trip the draft's authored audience rather than drop it
          // and let a fresh accept default the scopeless file to 'project' —
          // silently widening a scope='user' note to the whole project. loadProject
          // applies the 'project'/'global' default on ingest of the ACCEPTED doc.
          scope: frontmatter.scope,
          ownerUser: frontmatter.owner_user,
          // The verification pass lives in the database, not the file, so a
          // draft freshly read off disk always starts here — upsertDraft
          // deliberately never writes these two columns, so a real verdict
          // already on the row survives this object overwriting everything
          // else on resync.
          verdict: "unverified",
          disputes: [],
        });
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }

    return drafts;
  }

  /**
   * The closed versions under `<project>/.history/` (see archiveDocVersion). A
   * file without a parseable `valid_to` is not a closed version and is skipped.
   * Read with the project's default scope rules, like loadProject.
   */
  async loadHistory(projectId: string): Promise<KnowledgeHistoryVersion[]> {
    const historyDir = join(this.knowledgeDir, projectId, HISTORY_SUBDIR);
    const defaultScope: Scope = projectId === GLOBAL_PROJECT_ID ? "global" : DEFAULT_SCOPE;
    const versions: KnowledgeHistoryVersion[] = [];
    let files: string[];
    try {
      files = await readdir(historyDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return versions;
      throw err;
    }
    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      const filePath = join(historyDir, file);
      const [content, fileStat] = await Promise.all([readFile(filePath, "utf-8"), stat(filePath)]);
      const { data, content: body } = matter(content);
      const frontmatter = data as KnowledgeFrontmatter;
      const validTo = normalizeInstant(frontmatter.valid_to);
      if (!validTo) continue;
      const slug = historySlugOf(file);
      const scope = coerceScope(frontmatter.scope, defaultScope);
      versions.push({
        id: randomUUID(),
        projectId,
        slug,
        title: frontmatter.title ?? slug,
        body: body.trim(),
        tags: coerceTags(frontmatter.tags),
        filePath,
        updatedAt: fileStat.mtime,
        validFrom: normalizeInstant(frontmatter.valid_from),
        validTo,
        supersededBy: typeof frontmatter.superseded_by === "string" ? frontmatter.superseded_by : undefined,
        originClass: frontmatter.origin_class ?? (scope === "user" ? "agent" : "owner"),
        sourceKind: frontmatter.source_kind ?? DEFAULT_SOURCE_KIND,
        scope,
        ownerUser: frontmatter.owner_user,
        generatedFromSha: frontmatter.generated_from_sha,
      });
    }
    return versions;
  }

  async loadAll(projectIds: string[]): Promise<Map<string, KnowledgeDoc[]>> {
    const result = new Map<string, KnowledgeDoc[]>();

    for (const projectId of projectIds) {
      const docs = await this.loadProject(projectId);
      result.set(projectId, docs);
    }

    return result;
  }

  /**
   * Watches the whole knowledge directory (one recursive watcher, so a project
   * directory created later is covered too) and reports which project each
   * change touched, without reading anything: `onChange(projectId)` for a
   * change under `<projectId>/`, `onChange(null)` when the event names no file
   * and the project is unknown. Changes under a project's `.drafts/` are not
   * reported — loadProject never reads them. Every kind of event counts (an
   * editor's write-to-temp-then-rename save surfaces as a rename of the final
   * name, a deleted or renamed project directory as an event on its name).
   * `onError` fires once if the watcher cannot start or stops on its own; the
   * caller must then stop trusting the change reports. Resolves once the
   * watcher is attached, so a change made after it resolves is reported.
   */
  async startWatching(
    onChange: (projectId: string | null) => void,
    onError: (err: unknown) => void
  ): Promise<void> {
    this.stopWatching();
    let failed = false;
    const fail = (err: unknown) => {
      if (failed) return;
      failed = true;
      onError(err);
    };
    try {
      await mkdir(this.knowledgeDir, { recursive: true });
      const watcher = watch(this.knowledgeDir, { recursive: true }, (_event, filename) => {
        const name = filename?.toString();
        if (name?.startsWith(FENCE_PREFIX)) {
          this.fenceWaiters.get(name)?.();
          return;
        }
        const projectId = watchedProjectOf(filename);
        if (projectId !== undefined) onChange(projectId);
      });
      watcher.on("error", fail);
      watcher.on("close", () => {
        if (this.watcher === watcher) fail(new Error("knowledge watcher closed"));
      });
      this.watcher = watcher;
    } catch (err) {
      fail(err);
    }
  }

  /**
   * Waits until the watcher has delivered every event for a change made before
   * this call. A watcher reports changes asynchronously, so a file written just
   * before a search may not have been reported yet; this writes a uniquely
   * named fence file at the top of the knowledge directory and waits for its
   * own event — the events of one watcher arrive in order, so everything
   * before it has been reported by then. Resolves false when the fence's event
   * does not arrive within `timeoutMs` (or nothing is being watched): the
   * caller cannot rely on the reports this time.
   */
  async flushWatchEvents(timeoutMs: number): Promise<boolean> {
    if (!this.watcher) return false;
    const name = `${FENCE_PREFIX}${process.pid}-${++this.fenceCount}`;
    const path = join(this.knowledgeDir, name);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const seen = new Promise<boolean>((resolve) => {
      this.fenceWaiters.set(name, () => resolve(true));
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    try {
      await writeFile(path, "");
      return await seen;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
      this.fenceWaiters.delete(name);
      await unlink(path).catch(() => {});
    }
  }

  stopWatching(): void {
    const watcher = this.watcher;
    this.watcher = undefined;
    watcher?.close();
  }
}
