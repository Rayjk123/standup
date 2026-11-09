import type { Database } from "bun:sqlite";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  canonicalPath,
  findLaunchByCwd,
  findProjectByCwd,
  getProject,
  getProjects,
  getSession,
  isWithin,
  reassignSessionProject,
} from "@standup/store";
import { resolveWorktreeRoot } from "./launcher.js";
import { transcriptPathForSession } from "./transcript.js";

/**
 * Resolving (and persisting) the project a Claude session belongs to when the
 * session was registered under `scratch`.
 *
 * A session is homed once, at SessionStart, from its cwd. That misses a session
 * started from a non-repo directory (e.g. `$HOME`) whose real work is in a
 * launch worktree reached through an additional working directory (`--add-dir`,
 * `/add-dir`) or a later `cd`. This module re-resolves such a session from every
 * path it is known to touch — the caller's cwd, the cwds its hook payloads
 * report, and the working + additional directories Claude Code records in the
 * transcript's `environment` snapshot — and persists the first match on the
 * session row (keyed by the Claude session id), so it sticks across later cwd
 * changes. Subagent children inherit it. Only when nothing resolves does the
 * session stay in `scratch`, and callers surface a warning saying so.
 */

const SCRATCH = "scratch";
const GLOBAL = "global";
const WORKTREES_SEGMENT = /(?:^|\/)standup-worktrees\/([^/]+)(?:\/|$)/;

function isRealProjectId(id: string | null | undefined): id is string {
  return !!id && id !== SCRATCH && id !== GLOBAL;
}

/**
 * The project whose launch-worktree tree contains `path`. Launch worktrees are
 * created at `<worktreeRoot>/<projectId>/<slug>` (see launchSession), so a path
 * under a project's `<root>/<id>` names that project even after the launch row
 * is cleaned. A literal `standup-worktrees/<id>/` segment naming a registered
 * project also counts, covering a worktree root that has since been changed.
 */
export function projectIdFromWorktreePath(db: Database, path: string): string | null {
  const target = canonicalPath(path);
  for (const project of getProjects(db)) {
    if (!isRealProjectId(project.id)) continue;
    const tree = canonicalPath(join(resolveWorktreeRoot(db, project), project.id));
    if (isWithin(tree, target)) return project.id;
  }
  for (const candidate of [path, target]) {
    const id = WORKTREES_SEGMENT.exec(candidate)?.[1];
    if (isRealProjectId(id) && getProject(db, id)) return id;
  }
  return null;
}

/**
 * The project a single path belongs to: a live launch's worktree first (it can
 * sit outside the project's configured repos), then a configured repo, then the
 * launch-worktree layout. Null for a path none of them claim.
 */
export function projectIdForPath(db: Database, path: string): string | null {
  if (!path?.trim()) return null;
  const launch = findLaunchByCwd(db, path);
  if (isRealProjectId(launch?.projectId)) return launch.projectId;
  const project = findProjectByCwd(db, path);
  if (isRealProjectId(project?.id)) return project.id;
  return projectIdFromWorktreePath(db, path);
}

interface EnvironmentSnapshot {
  workingDirectory?: unknown;
  additionalWorkingDirectories?: unknown;
}

/** Per transcript: bytes consumed through the last complete line, and the dirs found so far. */
const transcriptDirsCache = new Map<string, { offset: number; dirs: string[] }>();

function snapshotDirs(line: string): string[] {
  if (!line.includes('"additionalWorkingDirectories"')) return [];
  let snapshot: EnvironmentSnapshot | undefined;
  try {
    const record = JSON.parse(line) as {
      attachment?: { type?: string; snapshot?: EnvironmentSnapshot };
    };
    if (record.attachment?.type !== "environment") return [];
    snapshot = record.attachment.snapshot;
  } catch {
    return [];
  }
  const found: string[] = [];
  if (typeof snapshot?.workingDirectory === "string") found.push(snapshot.workingDirectory);
  if (Array.isArray(snapshot?.additionalWorkingDirectories)) {
    for (const d of snapshot.additionalWorkingDirectories) {
      if (typeof d === "string") found.push(d);
    }
  }
  return found;
}

/**
 * Every working directory and additional working directory recorded in a Claude
 * Code transcript's `environment` attachments (JSONL), most recent snapshot
 * first. A resumed session keeps writing its original transcript, so earlier
 * snapshots (e.g. from the launch worktree) still count after a resume from
 * `$HOME`. Read incrementally: each call scans only the bytes appended since the
 * last one. Empty when the file is missing or has no snapshot.
 */
export function transcriptWorkingDirs(transcriptPath: string | null | undefined): string[] {
  if (!transcriptPath) return [];
  let size: number;
  try {
    size = statSync(transcriptPath).size;
  } catch {
    return [];
  }
  let cached = transcriptDirsCache.get(transcriptPath);
  if (!cached || size < cached.offset) cached = { offset: 0, dirs: [] };
  if (size === cached.offset) {
    transcriptDirsCache.set(transcriptPath, cached);
    return cached.dirs;
  }

  let chunk: string;
  try {
    const fd = openSync(transcriptPath, "r");
    try {
      const buf = Buffer.alloc(size - cached.offset);
      const read = readSync(fd, buf, 0, buf.length, cached.offset);
      chunk = buf.subarray(0, read).toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return cached.dirs;
  }

  // Only complete lines are consumed; a trailing partial line is re-read next time.
  const lastNewline = chunk.lastIndexOf("\n");
  if (lastNewline === -1) return cached.dirs;
  const complete = chunk.slice(0, lastNewline);
  const consumed = Buffer.byteLength(complete, "utf8") + 1;

  const fresh: string[] = [];
  const lines = complete.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    for (const d of snapshotDirs(lines[i])) if (!fresh.includes(d)) fresh.push(d);
  }
  const dirs = [...fresh, ...cached.dirs.filter((d) => !fresh.includes(d))];
  transcriptDirsCache.set(transcriptPath, { offset: cached.offset + consumed, dirs });
  return dirs;
}

/** Distinct cwds the session's most recent hook payloads reported, newest first. */
function recentEventCwds(db: Database, sessionId: string, limit = 200): string[] {
  const rows = db
    .query(
      `SELECT json_extract(payload_json, '$.cwd') AS cwd
         FROM events
        WHERE session_id = ?
        ORDER BY seq DESC
        LIMIT ?`
    )
    .all(sessionId, limit) as Array<{ cwd: string | null }>;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const { cwd } of rows) {
    if (cwd && !seen.has(cwd)) {
      seen.add(cwd);
      out.push(cwd);
    }
  }
  return out;
}

/**
 * Moves a session and its still-scratch subagent children into `projectId`,
 * then reports the move to `onRehomed` so the knowledge they wrote can follow.
 */
function persistSessionProject(
  db: Database,
  sessionId: string,
  projectId: string,
  onRehomed?: SessionRehomedListener
): boolean {
  const moved = reassignSessionProject(db, sessionId, projectId);
  const { changes } = db.run(
    "UPDATE sessions SET project_id = ? WHERE parent_session_id = ? AND project_id = 'scratch'",
    [projectId, sessionId]
  );
  if (moved || changes > 0) onRehomed?.(sessionId, projectId);
  return moved;
}

/** Called with a session moved out of scratch (its children included) and its new project. */
export type SessionRehomedListener = (sessionId: string, projectId: string) => void;

export interface SessionProjectResolution {
  projectId: string;
  /** True when the session was just moved out of scratch by this call. */
  moved: boolean;
  /** Set when nothing resolved and the caller is defaulting to scratch. */
  warning?: string;
}

export interface ResolveSessionProjectOptions {
  /** Extra paths to try first (e.g. the requesting tool call's cwd). */
  paths?: Array<string | null | undefined>;
  /** Whether to read the transcript's environment snapshots (default true). */
  transcript?: boolean;
  /** Whether to scan the cwds of the session's recent hook payloads (default true). */
  eventCwds?: boolean;
  /** Notified for each session this call moves out of scratch. */
  onRehomed?: SessionRehomedListener;
}

/**
 * Candidate sets already tried per session, so an unchanged miss is not
 * re-scanned on every call. Expires so a project registered afterward is still
 * picked up.
 */
const attempted = new Map<string, { signature: string; at: number }>();
const ATTEMPT_TTL_MS = 60_000;

/**
 * The project for a session, resolving and persisting it when the session is in
 * `scratch`. A session already homed in a real project is returned unchanged (a
 * one-way move — reassignSessionProject never re-homes a non-scratch session). A
 * subagent defers to its parent. Returns scratch with a warning only when no
 * candidate path resolves.
 */
export function resolveSessionProject(
  db: Database,
  sessionId: string,
  options: ResolveSessionProjectOptions = {}
): SessionProjectResolution {
  const session = getSession(db, sessionId);
  if (!session) {
    const paths = (options.paths ?? []).filter((p): p is string => !!p?.trim());
    for (const path of paths) {
      const projectId = projectIdForPath(db, path);
      if (projectId) return { projectId, moved: false };
    }
    return { projectId: SCRATCH, moved: false, warning: scratchWarning(paths) };
  }
  if (session.projectId !== SCRATCH) return { projectId: session.projectId, moved: false };

  if (session.parentSessionId) {
    const parent = resolveSessionProject(db, session.parentSessionId, options);
    if (parent.projectId !== SCRATCH) {
      const moved = reassignSessionProject(db, sessionId, parent.projectId);
      if (moved) options.onRehomed?.(sessionId, parent.projectId);
      return { projectId: parent.projectId, moved };
    }
  }

  const candidates: string[] = [];
  const push = (p: string | null | undefined) => {
    if (p?.trim() && !candidates.includes(p)) candidates.push(p);
  };
  for (const p of options.paths ?? []) push(p);
  push(session.cwd);
  if (options.eventCwds !== false) {
    for (const p of recentEventCwds(db, sessionId)) push(p);
  }
  if (options.transcript !== false) {
    for (const p of transcriptWorkingDirs(transcriptPathForSession(db, sessionId))) push(p);
  }

  const signature = candidates.join("\0");
  const prior = attempted.get(sessionId);
  const now = Date.now();
  if (!prior || prior.signature !== signature || now - prior.at > ATTEMPT_TTL_MS) {
    attempted.set(sessionId, { signature, at: now });
    for (const path of candidates) {
      const projectId = projectIdForPath(db, path);
      if (projectId) {
        attempted.delete(sessionId);
        const moved = persistSessionProject(db, sessionId, projectId, options.onRehomed);
        return { projectId, moved };
      }
    }
  }
  return { projectId: SCRATCH, moved: false, warning: scratchWarning(candidates) };
}

export function scratchWarning(paths: string[]): string {
  const where = paths.length > 0 ? ` (checked: ${paths.join(", ")})` : "";
  return (
    `Standup could not resolve a project for this session${where}, so it defaulted to ` +
    `the "scratch" project. Pass \`project\` explicitly, or work from a registered repo or a ` +
    `standup-worktrees/<project>/ launch worktree.`
  );
}

/** How many known project ids an unknown-project warning lists. */
const KNOWN_PROJECTS_LISTED = 8;

/**
 * Every project id a knowledge call may name: the registered projects, any
 * project that has knowledge docs in the store (a corpus synced from disk need
 * not be registered on this collector), and the reserved global and scratch
 * projects.
 */
export function knownProjectIds(db: Database): Set<string> {
  const ids = new Set<string>([GLOBAL, SCRATCH]);
  for (const project of getProjects(db)) ids.add(project.id);
  try {
    const rows = db.query("SELECT DISTINCT project_id FROM knowledge").all() as Array<{ project_id: string }>;
    for (const { project_id } of rows) if (project_id) ids.add(project_id);
  } catch {
    // No knowledge table yet: only the registry names projects.
  }
  return ids;
}

/**
 * The known project id `explicit` names: itself, or the known id it matches
 * case-insensitively. Null when it names no known project.
 */
export function matchKnownProject(known: ReadonlySet<string>, explicit: string): string | null {
  if (known.has(explicit)) return explicit;
  const lower = explicit.toLowerCase();
  for (const id of known) if (id.toLowerCase() === lower) return id;
  return null;
}

/**
 * The warning for a call that named a project Standup does not know and ran
 * under `resolved` instead. Lists up to KNOWN_PROJECTS_LISTED known ids, the
 * resolved project and `preferred` (its related projects) first, then the rest
 * alphabetically; scratch is left out since it is never a useful target.
 */
export function unknownProjectWarning(
  explicit: string,
  resolved: string,
  known: ReadonlySet<string>,
  preferred: readonly string[] = [],
  verb = "searched"
): string {
  const listed: string[] = [];
  const add = (id: string) => {
    if (id !== SCRATCH && known.has(id) && !listed.includes(id)) listed.push(id);
  };
  for (const id of [resolved, ...preferred]) add(id);
  for (const id of [...known].sort()) add(id);
  const shown = listed.slice(0, KNOWN_PROJECTS_LISTED);
  const more = listed.length > shown.length ? ", …" : "";
  const list = shown.length > 0 ? `${shown.join(", ")}${more}` : "none registered";
  return `Unknown project "${explicit}" — ${verb} ${resolved} instead. Known projects: ${list}.`;
}

/** Test seam: forget memoized misses and transcript reads. */
export function resetSessionProjectCaches(): void {
  attempted.clear();
  transcriptDirsCache.clear();
}
