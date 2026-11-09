import type { Database } from "bun:sqlite";
import { existsSync } from "fs";
import { homedir } from "os";
import { getLaunches, getProject, getProjects, getSession } from "@standup/store";
import { UNVERIFIABLE_VERDICT, parseContradictsClaim } from "@standup/knowledge";
import {
  chooseVerificationRepo,
  isCorpusProject,
  isWithin,
  unverifiableDispute,
  type RetryPendingDeps,
  type VerificationRepo,
} from "./knowledge-publish-verify.js";
import { resolveWorktreeRoot } from "./launcher.js";
import type { DraftDispute } from "./draft-verify.js";

export { isCorpusProject };

/**
 * Which repository checkouts a knowledge doc is fact-checked against, resolved
 * from the doc rather than from whichever session proposed it:
 *
 * - A doc of a real project: that project's checkout (chooseVerificationRepo).
 * - A doc of the reserved `global` or `scratch` corpus: the checkouts of the
 *   projects it is about — its source session's project first, then every
 *   registered project its body names deliberately (projectsNamedIn). The
 *   checkouts of projects only named are listed as `namedRepos`: findings
 *   against them alone leave the doc unverifiable, never disputed.
 *
 * Every checkout must be one the project it was resolved for may use
 * (repoMayServeProject), so a doc is never checked against another project's
 * repository. The repair pass at the bottom downgrades disputes recorded
 * against such a repository to `unverifiable`.
 */

/** Further checkouts a corpus doc is checked against, beyond the first. */
const MAX_ADDITIONAL_REPOS = 3;
/** Shortest repo directory name counted as a bare mention in a doc body. */
const MIN_REPO_NAME_LENGTH = 6;
/** Shortest project id counted as a bare mention in a doc body. */
const MIN_PROJECT_ID_LENGTH = 4;
/** Bare mentions of a project's id or repo name that count as naming it. */
const MIN_BARE_MENTIONS = 2;

/** Why a global or scratch doc could not be fact-checked. */
export function noResolvableRepoReason(projectId: string): string {
  return `unverifiable: no repo resolvable for a ${projectId} doc (no source project with a checkout, and no registered project with one named in it)`;
}

function expandHome(path: string): string {
  return path.replace(/^~(?=\/|$)/, homedir());
}

/** What the repo-ownership guard knows about the projects on this host. */
export interface RepoOwnership {
  /** The registered project ids. */
  projectIds(): string[];
  /** The project's configured repo roots, `~` expanded, existing or not. */
  roots(projectId: string): string[];
  /**
   * The innermost launch whose working directory contains `path`, if any:
   * its project, and whether that directory is a dedicated checkout — a
   * worktree Standup created under the worktree root — rather than a real
   * repo or session cwd the launch ran in place (an in-place or adopted
   * launch), which may contain any number of other projects' repos.
   */
  launchAt(path: string): { projectId: string; dedicated: boolean } | null;
  /** The shared git directory of the checkout at `path`, if it is one. */
  gitCommonDir(path: string): string | null;
}

/**
 * The projects the checkout at `path` demonstrably belongs to: the project of
 * the dedicated launch worktree it is in, else every project with a repo
 * containing it or containing the shared repository of the git worktree it
 * is. An in-place or adopted launch's directory may hold other projects'
 * repos, so its project owns `path` only when no registered repo does.
 */
export function repoOwners(path: string, own: RepoOwnership): string[] {
  const launch = own.launchAt(path);
  if (launch?.dedicated) return [launch.projectId];
  const common = own.gitCommonDir(path);
  const rooted = own
    .projectIds()
    .filter((id) => own.roots(id).some((r) => isWithin(path, r) || (!!common && isWithin(common, r))));
  return rooted.length === 0 && launch ? [launch.projectId] : rooted;
}

/** Whether one of `projectId`'s own registered repos contains `path`. */
export function isInProjectRoots(path: string, projectId: string, own: RepoOwnership): boolean {
  return own.roots(projectId).some((r) => isWithin(path, r));
}

/** Whether the checkout at `path` demonstrably belongs to `projectId` (repoOwners). */
export function repoBelongsToProject(path: string, projectId: string, own: RepoOwnership): boolean {
  return repoOwners(path, own).includes(projectId);
}

/**
 * The repo-ownership guard: whether the checkout at `path` may be used to
 * fact-check a doc of `projectId` — it belongs to that project, or to no
 * registered project at all (a session's own checkout of a project with no
 * repos registered). A checkout of another project's is never used.
 */
export function repoMayServeProject(path: string, projectId: string, own: RepoOwnership): boolean {
  const owners = repoOwners(path, own);
  return owners.length === 0 || owners.includes(projectId);
}

/** RepoOwnership over the store's projects and launches and the git on this host. */
export function dbRepoOwnership(db: Database): RepoOwnership {
  let launches: Array<{ path: string; projectId: string; dedicated: boolean }> | null = null;
  let roots: Map<string, string[]> | null = null;
  const projects = () => getProjects(db);
  const projectRoots = (): Map<string, string[]> =>
    (roots ??= new Map(projects().map((p) => [p.id, p.repos.map(expandHome)])));
  const commonDirs = new Map<string, string | null>();
  return {
    projectIds: () => [...projectRoots().keys()],
    roots: (projectId) => projectRoots().get(projectId) ?? [],
    launchAt(path) {
      if (launches === null) {
        const worktreeRoots = new Map(projects().map((p) => [p.id, resolveWorktreeRoot(db, p)]));
        launches = getLaunches(db)
          .map((l) => {
            const launchPath = expandHome(l.worktreePath);
            const worktreeRoot = worktreeRoots.get(l.projectId);
            const dedicated =
              l.kind !== "adopted" &&
              !l.inPlace &&
              !!worktreeRoot &&
              launchPath !== worktreeRoot.replace(/\/+$/, "") &&
              isWithin(launchPath, worktreeRoot);
            return { path: launchPath, projectId: l.projectId, dedicated };
          })
          .sort((a, b) => b.path.length - a.path.length);
      }
      const launch = launches.find((l) => isWithin(path, l.path));
      return launch ? { projectId: launch.projectId, dedicated: launch.dedicated } : null;
    },
    gitCommonDir(path) {
      if (commonDirs.has(path)) return commonDirs.get(path)!;
      let dir: string | null = null;
      if (existsSync(path)) {
        const proc = Bun.spawnSync(["git", "-C", path, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
          stdout: "pipe",
          stderr: "ignore",
        });
        const out = proc.exitCode === 0 ? proc.stdout.toString().trim() : "";
        dir = out || null;
      }
      commonDirs.set(path, dir);
      return dir;
    },
  };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The indices of every occurrence of `term` in `body` as a whole token. */
function tokenIndices(body: string, term: string): number[] {
  return [...body.matchAll(new RegExp(`(?:^|[^\\w-])(${escapeRegExp(term)})(?![\\w-])`, "g"))].map(
    (m) => m.index + m[0].length - m[1]!.length
  );
}

/** The index of `name`'s first use as a path segment or `owner/name`, or -1. */
function pathUseIndex(body: string, name: string): number {
  const match = new RegExp(`(?:[\\w.~-]/(${escapeRegExp(name)})(?![\\w-])|(?:^|[^\\w-])(${escapeRegExp(name)})/[\\w.])`).exec(
    body
  );
  if (!match) return -1;
  const term = match[1] ?? match[2]!;
  return match.index + match[0].indexOf(term);
}

function lastSegment(path: string): string {
  return path.replace(/\/+$/, "").split("/").pop() ?? "";
}

/**
 * The registered projects `body` names deliberately, in the order the body
 * first names them: by one of its repo paths, by its id in backticks, by a
 * repo's (distinctive, MIN_REPO_NAME_LENGTH+) directory name used as a path
 * segment or `owner/name`, or by at least
 * MIN_BARE_MENTIONS bare mentions of its id or repo names. A single passing
 * word ("docs", "core", "standup") does not name a project. The reserved
 * corpora are never matched.
 */
export function projectsNamedIn(body: string, projects: ReadonlyArray<{ id: string; repos: string[] }>): string[] {
  const found: Array<{ id: string; at: number }> = [];
  for (const project of projects) {
    if (isCorpusProject(project.id)) continue;
    const explicit: number[] = [body.indexOf(`\`${project.id}\``)];
    const bare: number[] = project.id.length >= MIN_PROJECT_ID_LENGTH ? tokenIndices(body, project.id) : [];
    for (const repo of project.repos) {
      for (const form of new Set([repo.replace(/\/+$/, ""), expandHome(repo).replace(/\/+$/, "")])) {
        if (form.includes("/") && form.length > 1) explicit.push(body.indexOf(form));
      }
      // A short directory name ("docs", "core") is an ordinary path segment.
      const name = lastSegment(expandHome(repo));
      if (name.length < MIN_REPO_NAME_LENGTH) continue;
      explicit.push(pathUseIndex(body, name));
      if (name !== project.id) bare.push(...tokenIndices(body, name));
    }
    const named = explicit.filter((p) => p >= 0);
    if (new Set(bare).size >= MIN_BARE_MENTIONS) named.push(...bare);
    if (named.length > 0) found.push({ id: project.id, at: Math.min(...named) });
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.id);
}

export interface ResolveVerificationInput {
  /** The project the doc is homed in. */
  targetProject: string;
  /** The proposing session's project and checkout, when a session proposed it. */
  proposerProject?: string | null;
  proposerRepo?: string | null;
  /** The project of the doc's source session or launch, for a doc with no
   *  proposer at hand (a later check of an accepted doc). */
  sourceProject?: string | null;
  body: string;
  /** The project's existing repo checkouts, primary first. */
  projectRepos(projectId: string): string[];
  /** The registered projects, for the mentions a corpus doc's body makes. */
  projects(): ReadonlyArray<{ id: string; repos: string[] }>;
  ownership?: RepoOwnership;
}

/**
 * The checkout(s) a doc is fact-checked against (see the module comment). A
 * corpus doc's first checkout is its source project's; the projects resolved
 * are listed on the result.
 */
export function resolveVerificationRepo(input: ResolveVerificationInput): VerificationRepo {
  const own = input.ownership;
  const belongsTo = own ? (path: string, projectId: string) => repoMayServeProject(path, projectId, own) : undefined;
  const { targetProject, proposerProject, proposerRepo } = input;
  if (!isCorpusProject(targetProject)) {
    return chooseVerificationRepo({ targetProject, proposerProject, proposerRepo, projectRepos: input.projectRepos, belongsTo });
  }

  const source = [proposerProject, input.sourceProject].find((p): p is string => !!p && !isCorpusProject(p)) ?? null;
  const resolved: Array<{ projectId: string; repo: string; named: boolean }> = [];
  const firstServing = (projectId: string): string | undefined =>
    input.projectRepos(projectId).find((r) => !belongsTo || belongsTo(r, projectId));
  const add = (projectId: string, repo: string | undefined, named: boolean): void => {
    if (!repo || resolved.some((r) => r.repo === repo)) return;
    if (belongsTo && !belongsTo(repo, projectId)) return;
    resolved.push({ projectId, repo, named });
  };
  if (source) {
    if (source === proposerProject && proposerRepo && (!belongsTo || belongsTo(proposerRepo, source))) {
      add(source, proposerRepo, false);
    } else {
      add(source, firstServing(source), false);
    }
  }
  const named = projectsNamedIn(
    input.body,
    input.projects().filter((p) => p.id !== source)
  );
  for (const projectId of named) {
    if (resolved.length > MAX_ADDITIONAL_REPOS) break;
    add(projectId, firstServing(projectId), true);
  }
  if (resolved.length === 0) return { repo: null, reason: noResolvableRepoReason(targetProject) };
  const [first, ...rest] = resolved;
  const namedRepos = resolved.filter((r) => r.named).map((r) => r.repo);
  return {
    repo: first!.repo,
    ...(rest.length > 0 ? { additionalRepos: rest.map((r) => r.repo) } : {}),
    projects: [...new Set(resolved.map((r) => r.projectId))],
    ...(namedRepos.length > 0 ? { namedRepos } : {}),
  };
}

/**
 * RetryPendingDeps.repoFor over resolveVerificationRepo: a pending doc is
 * retried against the checkout(s) the guarded resolver picks for it now, or
 * skipped when there is none. `sourceProject` gives a corpus doc's source
 * session's project.
 */
export function retryRepoFor(
  inputs: Pick<ResolveVerificationInput, "projectRepos" | "projects" | "ownership">,
  sourceProject: (projectId: string, slug: string) => string | null = () => null
): RetryPendingDeps["repoFor"] {
  return (projectId, slug, body) => {
    const target = resolveVerificationRepo({
      targetProject: projectId,
      sourceProject: sourceProject(projectId, slug),
      body,
      ...inputs,
    });
    if (target.repo === null) return null;
    return {
      repo: target.repo,
      additionalRepos: target.additionalRepos ?? [],
      namedRepos: target.namedRepos ?? [],
    };
  };
}

/** The project a doc's source session belongs to, if it is known. */
export function sourceSessionProject(db: Database, sourceSessionId: string | null | undefined): string | null {
  if (!sourceSessionId) return null;
  return getSession(db, sourceSessionId)?.projectId ?? null;
}

/** resolveVerificationRepo's registry inputs over the store. The ownership
 *  view caches projects and launches on first use, so a long-lived caller
 *  builds these afresh for each pass. */
export function dbVerificationInputs(
  db: Database
): Pick<ResolveVerificationInput, "projectRepos" | "projects"> & { ownership: RepoOwnership } {
  return {
    projectRepos: (projectId) =>
      (getProject(db, projectId)?.repos ?? []).map(expandHome).filter((r) => existsSync(r)),
    projects: () => getProjects(db),
    ownership: dbRepoOwnership(db),
  };
}

// --- Repair of disputes recorded against another project's repository -------

/**
 * Explicit phrases a fact-check uses when the repository it was handed is not
 * the one the doc describes: "the repository at <path> is the Standup
 * monorepo, not X", "… is the Standup project (…), not the billing-platform
 * project", "this is the wrong repository". Looser wording ("not defined in the
 * server package", "contains only X code") is ordinary finding prose and does
 * not count.
 */
const WRONG_REPO_PATTERNS: RegExp[] = [
  /\b(?:is|was)\s+(?:the|an?)\s+[^;\n]{0,160}?\b(?:project|repository|repo|monorepo|codebase|worktree|knowledge base)\b[^;\n]{0,160}?,\s*not\s+\S/i,
  /\b(?:wrong|different|unrelated)\s+(?:repository|repo|project|codebase)\b/i,
];
/** The text must also be about the repository checked, not just some module. */
const REPOSITORY_SUBJECT = /\b(?:repository|repo|worktree|codebase|provided path|specified path)\b/i;

/** Whether a dispute's text says the repository checked is not the doc's. */
export function saysWrongRepository(dispute: DraftDispute): boolean {
  const text = `${dispute.claim}\n${dispute.finding}`;
  return REPOSITORY_SUBJECT.test(text) && WRONG_REPO_PATTERNS.some((p) => p.test(text));
}

/** Whether `path` is a real location on this host: it exists, or lies in a
 *  registered repo or a launch's working directory. A root-relative string
 *  such as `/src/x.ts` or `/api/v1` is none of these. */
export function isKnownPath(path: string, own: RepoOwnership): boolean {
  if (existsSync(path)) return true;
  if (own.launchAt(path) !== null) return true;
  return own.projectIds().some((id) => isInProjectRoots(path, id, own));
}

/** The absolute paths a text names. */
export function absolutePathsIn(text: string): string[] {
  const paths = new Set<string>();
  for (const m of text.matchAll(/(?:^|[\s(`'"=:])((?:~|\/)(?:[\w.@+-]+\/)*[\w.@+-]+)/g)) {
    const path = expandHome(m[1]!.replace(/[.,:;]+$/, ""));
    if (path.split("/").filter(Boolean).length >= 2) paths.add(path);
  }
  return [...paths];
}

export interface DisputedDocRow {
  projectId: string;
  slug: string;
  disputes: DraftDispute[];
  /** The checkout the verdict was recorded against (verdict_repo_path). */
  verdictRepo: string | null;
  /** The checkout the publish fact-check recorded for the doc
   *  (knowledge_verifications.repo_path), for a verdict that predates
   *  verdict_repo_path. */
  publishRepo: string | null;
}

/**
 * Whether a disputed doc's dispute was produced against a repository outside
 * its project, and so says nothing about it.
 *
 * - The verdict's checkout is on record: the guard (repoMayServeProject)
 *   rejects it for the project, and it is not inside one of the project's own
 *   registered repos.
 * - Not on record: conservatively, a fact-check finding explicitly says the
 *   repository is a different project's AND every real path the findings name
 *   (isKnownPath; else the publish check's recorded checkout) lies outside the
 *   project.
 *
 * A reserved-corpus doc is never judged: it has no repository of its own to
 * compare against.
 */
export function isWrongRepoDispute(row: DisputedDocRow, own: RepoOwnership): boolean {
  return wrongRepoOf(row, own) !== null;
}

/** The repository outside the doc's project its dispute was produced against
 *  (see isWrongRepoDispute), or null for a dispute that stands. */
export function wrongRepoOf(row: DisputedDocRow, own: RepoOwnership): string | null {
  if (isCorpusProject(row.projectId)) return null;
  if (row.verdictRepo) {
    if (isInProjectRoots(row.verdictRepo, row.projectId, own)) return null;
    return repoMayServeProject(row.verdictRepo, row.projectId, own) ? null : row.verdictRepo;
  }
  const outside = (path: string) => !repoBelongsToProject(path, row.projectId, own);
  const findings = row.disputes.filter((d) => parseContradictsClaim(d.claim) === null && !d.origin);
  if (!findings.some(saysWrongRepository)) return null;
  const named = findings
    .flatMap((d) => absolutePathsIn(`${d.claim}\n${d.finding}\n${d.evidence}`))
    .filter((p) => isKnownPath(p, own));
  if (named.some((p) => isInProjectRoots(p, row.projectId, own))) return null;
  const paths = named.length > 0 ? named : row.publishRepo ? [row.publishRepo] : [];
  if (paths.length === 0 || !paths.every(outside)) return null;
  return row.publishRepo && paths.some((p) => isWithin(p, row.publishRepo!)) ? row.publishRepo : paths[0]!;
}

/** The reason recorded on a doc whose wrong-repository dispute was set aside. */
export function wrongRepoReason(projectId: string, repo: string): string {
  return `unverifiable: the fact-check ran against ${repo}, outside project ${projectId}`;
}

const WRONG_REPO_FINDING =
  "The fact-check ran against a repository of another project, so its findings say nothing about this doc and were set aside.";

/** The disputed docs, with the checkouts their verdicts were recorded against. */
export function disputedDocRows(db: Database): DisputedDocRow[] {
  const columns = (db.query("PRAGMA table_info(knowledge)").all() as Array<{ name: string }>).map((c) => c.name);
  if (!columns.includes("verdict")) return [];
  const verdictRepo = columns.includes("verdict_repo_path") ? "k.verdict_repo_path" : "NULL";
  const hasVerifications = !!db
    .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'knowledge_verifications'")
    .get();
  const rows = db
    .query(
      hasVerifications
        ? `SELECT k.project_id, k.slug, k.disputes_json, ${verdictRepo} AS verdict_repo_path, v.repo_path
             FROM knowledge k LEFT JOIN knowledge_verifications v ON v.id = k.project_id || '/' || k.slug
            WHERE k.verdict = 'disputed'`
        : `SELECT k.project_id, k.slug, k.disputes_json, ${verdictRepo} AS verdict_repo_path, NULL AS repo_path
             FROM knowledge k WHERE k.verdict = 'disputed'`
    )
    .all() as Array<{
    project_id: string;
    slug: string;
    disputes_json: string | null;
    verdict_repo_path: string | null;
    repo_path: string | null;
  }>;
  return rows.map((r) => {
    let disputes: DraftDispute[] = [];
    try {
      disputes = r.disputes_json ? (JSON.parse(r.disputes_json) as DraftDispute[]) : [];
    } catch {
      disputes = [];
    }
    return {
      projectId: r.project_id,
      slug: r.slug,
      disputes,
      verdictRepo: r.verdict_repo_path,
      publishRepo: r.repo_path,
    };
  });
}

export interface DisputeRepairDeps {
  rows(): DisputedDocRow[];
  ownership: RepoOwnership;
  recordVerdict(projectId: string, slug: string, verdict: string, disputes: DraftDispute[], repoPath: null): void;
}

/**
 * Downgrades every `disputed` verdict produced against a repository outside the
 * doc's project (isWrongRepoDispute) to `unverifiable`, keeping its
 * contradiction edges (then `contradicted`) and a note naming the repository.
 * Idempotent: a downgraded doc is no longer disputed, and a genuine dispute is
 * left alone. Returns the docs repaired.
 */
export function repairWrongRepoDisputes(deps: DisputeRepairDeps): Array<{ projectId: string; slug: string }> {
  const repaired: Array<{ projectId: string; slug: string }> = [];
  for (const row of deps.rows()) {
    const repo = wrongRepoOf(row, deps.ownership);
    if (repo === null) continue;
    const carried = row.disputes.filter((d) => parseContradictsClaim(d.claim) !== null);
    deps.recordVerdict(
      row.projectId,
      row.slug,
      carried.length > 0 ? "contradicted" : UNVERIFIABLE_VERDICT,
      [...carried, unverifiableDispute(wrongRepoReason(row.projectId, repo), WRONG_REPO_FINDING)],
      null
    );
    repaired.push({ projectId: row.projectId, slug: row.slug });
  }
  if (repaired.length > 0) {
    console.log(
      `[knowledge-verify] set aside ${repaired.length} dispute(s) checked against another project's repo: ${repaired
        .map((r) => `${r.projectId}/${r.slug}`)
        .join(", ")}`
    );
  }
  return repaired;
}

/** repairWrongRepoDisputes over the store, writing through `recordVerdict`. */
export function repairWrongRepoDisputesInDb(
  db: Database,
  recordVerdict: DisputeRepairDeps["recordVerdict"]
): Array<{ projectId: string; slug: string }> {
  return repairWrongRepoDisputes({ rows: () => disputedDocRows(db), ownership: dbRepoOwnership(db), recordVerdict });
}
