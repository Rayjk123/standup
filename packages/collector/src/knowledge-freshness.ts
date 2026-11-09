import type { Database } from "bun:sqlite";
import {
  belowFloorSince,
  deriveConfidence,
  isConfidenceEligibleForInjection,
  layerOf,
  MIN_INJECTION_CONFIDENCE,
  withConfidenceCap,
  withConfidenceDefaults,
  type ConfidenceEvidence,
  type ConfidenceInputs,
} from "@standup/knowledge";
import { getProjects, getSetting, setSetting } from "@standup/store";
import type { Project } from "@standup/shared";
import { isModelReverifyEnabled, isReverifyEnabled, projectReverifyOperational } from "./knowledge-staleness.js";

/**
 * The freshness half of the injection gate, shared by launch injection and
 * search_knowledge so the two judge a doc identically.
 *
 * A doc's confidence inputs are DERIVED on every read (withConfidenceDefaults)
 * from what it asserts plus its own dates and body, then capped by the
 * evidence pass's CURRENT findings for it. Neither the defaults nor the caps
 * are written into the doc: the findings live in `knowledge_freshness`, which
 * each evidence pass replaces for the project it checked, so a finding that no
 * longer holds stops capping on the next pass.
 *
 * Decay takes a doc out of injection only where something will lift it back
 * (isRecoverable): the model re-verification pass is on for its project, the
 * project's repo is a git checkout the last evidence pass could read, the doc
 * is about that repo, and the pass is actually producing verdicts — the
 * project's last model pass reached a verdict on at least one doc, and this
 * doc's current body has had fewer than MAX_REVERIFY_ATTEMPTS fact-checks end
 * without one (error / unverified). Anywhere else a doc that has decayed below the floor
 * stays injectable but is demoted below fresh docs and marked "stale since
 * <date>" (staleSince) — time alone never silently removes a doc nobody can
 * re-verify. An explicit write-down below the floor (a refutation) still gates
 * it out everywhere.
 */

/** One doc's current evidence-pass state. */
export interface FreshnessRecord {
  slug: string;
  /** The date the doc stands as of when the pass knows better than the index (a repo mirror's last source commit). */
  anchorAt?: string;
  /** The lowest cap among the findings, or undefined when none caps. */
  cap?: number;
  findings: ConfidenceEvidence[];
  /** Whether the model pass could fact-check the doc against the repo (isAboutRepo). */
  aboutRepo?: boolean;
}

const TABLE_SQL = `CREATE TABLE IF NOT EXISTS knowledge_freshness (
  project_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  anchor_at TEXT,
  cap REAL,
  findings_json TEXT NOT NULL DEFAULT '[]',
  about_repo INTEGER NOT NULL DEFAULT 0,
  checked_at TEXT NOT NULL,
  PRIMARY KEY (project_id, slug)
)`;

export function ensureFreshnessTable(db: Database): void {
  db.run(TABLE_SQL);
  const columns = new Set(
    (db.query("PRAGMA table_info(knowledge_freshness)").all() as Array<{ name: string }>).map((c) => c.name)
  );
  if (!columns.has("about_repo")) {
    db.run("ALTER TABLE knowledge_freshness ADD COLUMN about_repo INTEGER NOT NULL DEFAULT 0");
  }
}

/**
 * Replaces everything recorded for `projectId` with `records` (a doc with
 * nothing to say — no anchor, cap, findings or repo link — is not stored), in
 * one transaction: the table always holds exactly the last pass's view, and a
 * pass that could not run (records = []) clears the project's old findings.
 */
export function replaceProjectFreshness(
  db: Database,
  projectId: string,
  records: readonly FreshnessRecord[],
  checkedAt: string
): void {
  ensureFreshnessTable(db);
  db.transaction(() => {
    db.run("DELETE FROM knowledge_freshness WHERE project_id = ?", [projectId]);
    for (const r of records) {
      if (!r.anchorAt && r.cap === undefined && r.findings.length === 0 && !r.aboutRepo) continue;
      db.run(
        "INSERT INTO knowledge_freshness (project_id, slug, anchor_at, cap, findings_json, about_repo, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [projectId, r.slug, r.anchorAt ?? null, r.cap ?? null, JSON.stringify(r.findings), r.aboutRepo ? 1 : 0, checkedAt]
      );
    }
  })();
}

/** What the last pass recorded for `projectId`, by slug. Empty when the table does not exist yet. */
export function readProjectFreshness(db: Database, projectId: string): Map<string, FreshnessRecord> {
  try {
    const rows = db
      .query("SELECT slug, anchor_at, cap, findings_json, about_repo FROM knowledge_freshness WHERE project_id = ?")
      .all(projectId) as Array<{
      slug: string;
      anchor_at: string | null;
      cap: number | null;
      findings_json: string;
      about_repo: number;
    }>;
    return new Map(
      rows.map((r) => [
        r.slug,
        {
          slug: r.slug,
          anchorAt: r.anchor_at ?? undefined,
          cap: r.cap ?? undefined,
          findings: JSON.parse(r.findings_json) as ConfidenceEvidence[],
          aboutRepo: r.about_repo === 1,
        },
      ])
    );
  } catch {
    return new Map();
  }
}

/** Fact-checks a doc body may end without a verdict before decay stops gating it out. */
export const MAX_REVERIFY_ATTEMPTS = 3;

/** Outcomes of a model re-verification that are a verdict on the doc; error and unverified are not. */
const VERDICT_OUTCOMES = new Set(["clean", "disputed", "contradicted"]);

export function isReverifyVerdict(outcome: string): boolean {
  return VERDICT_OUTCOMES.has(outcome);
}

/** The model pass's record for one doc's current body. */
export interface ReverifyAttemptState {
  /** Consecutive fact-checks of this body that ended without a verdict. */
  attempts: number;
  lastOutcome?: string;
  lastAttemptAt?: string;
}

const ATTEMPTS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS knowledge_reverify_attempts (
  project_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_outcome TEXT,
  last_attempt_at TEXT NOT NULL,
  PRIMARY KEY (project_id, slug)
)`;

function contentHash(body: string): string {
  return Bun.hash(body).toString(16);
}

interface StoredAttempt extends ReverifyAttemptState {
  bodyHash: string;
}

/** The model pass's attempt records for `projectId`, by slug. Empty when the table does not exist yet. */
export function readProjectReverifyAttempts(db: Database, projectId: string): Map<string, StoredAttempt> {
  try {
    const rows = db
      .query("SELECT slug, body_hash, attempts, last_outcome, last_attempt_at FROM knowledge_reverify_attempts WHERE project_id = ?")
      .all(projectId) as Array<{
      slug: string;
      body_hash: string;
      attempts: number;
      last_outcome: string | null;
      last_attempt_at: string;
    }>;
    return new Map(
      rows.map((r) => [
        r.slug,
        {
          bodyHash: r.body_hash,
          attempts: r.attempts,
          lastOutcome: r.last_outcome ?? undefined,
          lastAttemptAt: r.last_attempt_at,
        },
      ])
    );
  } catch {
    return new Map();
  }
}

/** The state recorded for `body` in `records` (an edited body starts over). */
export function attemptStateFor(
  records: ReadonlyMap<string, StoredAttempt>,
  slug: string,
  body: string
): ReverifyAttemptState {
  const r = records.get(slug);
  if (!r || r.bodyHash !== contentHash(body)) return { attempts: 0 };
  return { attempts: r.attempts, lastOutcome: r.lastOutcome, lastAttemptAt: r.lastAttemptAt };
}

/**
 * Records one model fact-check of `body`: a verdict resets the body's count of
 * verdict-less attempts, anything else adds one.
 */
export function recordReverifyAttempt(
  db: Database,
  projectId: string,
  slug: string,
  body: string,
  outcome: string,
  at: string
): void {
  db.run(ATTEMPTS_TABLE_SQL);
  const prior = attemptStateFor(readProjectReverifyAttempts(db, projectId), slug, body);
  const attempts = isReverifyVerdict(outcome) ? 0 : prior.attempts + 1;
  db.run(
    `INSERT OR REPLACE INTO knowledge_reverify_attempts (project_id, slug, body_hash, attempts, last_outcome, last_attempt_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [projectId, slug, contentHash(body), attempts, outcome, at]
  );
}

function modelVerdictsKey(projectId: string): string {
  return `knowledge_reverify_model_verdicts:${projectId}`;
}

/** Records whether a model pass that fact-checked at least one doc reached a verdict on any. */
export function recordModelPassVerdicts(db: Database, projectId: string, producedVerdict: boolean): void {
  setSetting(db, modelVerdictsKey(projectId), producedVerdict ? "1" : "0");
}

/**
 * Whether the project's last model pass reached a verdict on at least one doc.
 * True before any pass has fact-checked a doc: the switch alone is the promise
 * until the first pass shows otherwise.
 */
export function lastModelPassProducedVerdict(db: Database, projectId: string): boolean {
  try {
    return getSetting(db, modelVerdictsKey(projectId)) !== "0";
  } catch {
    return true;
  }
}

/** The fields of a search hit (or stored doc) the gate reads; the rest is looked up by project and slug. */
export interface FreshnessHit {
  projectId: string;
  slug: string;
  scope?: string;
  sourceKind?: string;
  confidence?: number;
  lastVerifiedAt?: string;
  halfLifeDays?: number;
}

export interface FreshnessGate {
  /** The doc's derived confidence inputs, capped by its current findings. */
  inputs(hit: FreshnessHit): ConfidenceInputs;
  /** Current (decayed) confidence as of the gate's clock. */
  currentConfidence(hit: FreshnessHit): number | undefined;
  /** Whether a re-verification will lift this doc back if it decays (see the module doc). */
  isRecoverable(hit: FreshnessHit): boolean;
  /** Whether the doc passes the freshness half of the injection gate. */
  eligible(hit: FreshnessHit): boolean;
  /**
   * When an injectable doc's decayed confidence fell below the floor — set
   * only for a doc decay does not gate out (no recovery path), which consumers
   * demote below fresh docs and mark. Undefined for a doc still above it.
   */
  staleSince(hit: FreshnessHit): string | undefined;
}

/** A stored timestamp (ISO or SQLite `YYYY-MM-DD HH:MM:SS`, UTC) as ISO, or undefined. */
function storedIso(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.includes("T") || !value.includes(" ") ? value : `${value.replace(" ", "T")}Z`;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

interface StoredFields {
  body: string;
  generated_at: string | null;
  updated_at: string | null;
  content_first_seen: string | null;
  scope: string | null;
  source_kind: string | null;
}

/**
 * The freshness gate over `db` as of `now`. Lookups (projects, findings,
 * stored dates and bodies) are memoized for the gate's life — make one per
 * request or launch. A hit with no stored row (a backend that is not this DB)
 * is judged on what it carries alone.
 */
export function freshnessGate(db: Database, now: Date = new Date()): FreshnessGate {
  let projects: Map<string, Project>;
  try {
    projects = new Map(getProjects(db).map((p) => [p.id, p]));
  } catch {
    projects = new Map();
  }
  const modelOn = new Map<string, boolean>();
  const projectRecoverable = (projectId: string): boolean => {
    let known = modelOn.get(projectId);
    if (known === undefined) {
      const project = projects.get(projectId);
      known =
        !!project &&
        projectReverifyOperational(project, isReverifyEnabled(db, projectId)) &&
        isModelReverifyEnabled(db, project) &&
        lastModelPassProducedVerdict(db, projectId);
      modelOn.set(projectId, known);
    }
    return known;
  };
  const findingsByProject = new Map<string, Map<string, FreshnessRecord>>();
  const memo = new Map<string, ConfidenceInputs>();
  let stored: ((projectId: string, slug: string) => StoredFields | null) | null = null;
  const lookup = (projectId: string, slug: string): StoredFields | null => {
    if (!stored) {
      try {
        const q = db.query(
          "SELECT body, generated_at, updated_at, content_first_seen, scope, source_kind FROM knowledge WHERE project_id = ? AND slug = ?"
        );
        stored = (p, s) => (q.get(p, s) as StoredFields | null) ?? null;
      } catch {
        try {
          const q = db.query(
            "SELECT body, generated_at, updated_at, NULL AS content_first_seen, scope, source_kind FROM knowledge WHERE project_id = ? AND slug = ?"
          );
          stored = (p, s) => (q.get(p, s) as StoredFields | null) ?? null;
        } catch {
          stored = () => null;
        }
      }
    }
    return stored(projectId, slug);
  };
  const attemptsByProject = new Map<string, Map<string, StoredAttempt>>();
  const attemptsFor = (projectId: string): Map<string, StoredAttempt> => {
    let m = attemptsByProject.get(projectId);
    if (!m) {
      m = readProjectReverifyAttempts(db, projectId);
      attemptsByProject.set(projectId, m);
    }
    return m;
  };
  const findingsFor = (projectId: string): Map<string, FreshnessRecord> => {
    let m = findingsByProject.get(projectId);
    if (!m) {
      m = readProjectFreshness(db, projectId);
      findingsByProject.set(projectId, m);
    }
    return m;
  };

  const inputs = (hit: FreshnessHit): ConfidenceInputs => {
    const key = `${hit.projectId}/${hit.slug}`;
    const known = memo.get(key);
    if (known) return known;
    const row = lookup(hit.projectId, hit.slug);
    const asserted: ConfidenceInputs = {
      confidence: hit.confidence,
      lastVerifiedAt: hit.lastVerifiedAt,
      halfLifeDays: hit.halfLifeDays,
    };
    const record = findingsFor(hit.projectId).get(hit.slug);
    const derived = row
      ? withConfidenceDefaults({
          ...asserted,
          body: row.body,
          generatedAt: storedIso(row.generated_at),
          contentFirstSeen: storedIso(row.content_first_seen),
          updatedAt: storedIso(row.updated_at),
          anchorAt: record?.anchorAt,
        })
      : asserted;
    const out = withConfidenceCap(derived, record?.cap);
    memo.set(key, out);
    return out;
  };

  /** Personal docs (the owner's own config and memories) and activity notes (dated by their own date) never decay. */
  const decays = (hit: FreshnessHit): boolean => {
    const row = lookup(hit.projectId, hit.slug);
    const layer = layerOf({
      scope: row?.scope ?? hit.scope,
      sourceKind: row?.source_kind ?? hit.sourceKind,
      slug: hit.slug,
    });
    return layer !== "personal" && layer !== "activity";
  };

  const isRecoverable = (hit: FreshnessHit): boolean => {
    if (!decays(hit)) return false;
    if (!projectRecoverable(hit.projectId) || findingsFor(hit.projectId).get(hit.slug)?.aboutRepo !== true) return false;
    const body = lookup(hit.projectId, hit.slug)?.body;
    if (body === undefined) return true;
    return attemptStateFor(attemptsFor(hit.projectId), hit.slug, body).attempts < MAX_REVERIFY_ATTEMPTS;
  };

  return {
    inputs,
    currentConfidence: (hit) => deriveConfidence(inputs(hit), now),
    isRecoverable,
    eligible: (hit) => isConfidenceEligibleForInjection(inputs(hit), { reverifyActive: isRecoverable(hit), now }),
    staleSince: (hit) => {
      if (!decays(hit)) return undefined;
      const i = inputs(hit);
      const current = deriveConfidence(i, now);
      if (current === undefined || current >= MIN_INJECTION_CONFIDENCE || isRecoverable(hit)) return undefined;
      return belowFloorSince(i);
    },
  };
}

/**
 * `items` with each stale one (staleSince set) moved just after the last fresh
 * item from the same project that ranked below it; every other item keeps its
 * place. Decay with no recovery path demotes a doc in ranking instead of
 * removing it, and demotes it behind the docs most likely to have superseded
 * it — fresher ones about the same project — rather than behind whatever else
 * matched: a stale runbook that is still the only answer stays where its
 * relevance put it, marked.
 */
export function demoteStale<T extends { projectId: string }>(
  items: readonly T[],
  staleSince: (item: T) => string | undefined
): T[] {
  const out = [...items];
  const stale = out.map((item) => !!staleSince(item));
  for (let i = out.length - 1; i >= 0; i--) {
    if (!stale[i]) continue;
    let j = -1;
    for (let k = out.length - 1; k > i; k--) {
      if (!stale[k] && out[k].projectId === out[i].projectId) {
        j = k;
        break;
      }
    }
    if (j === -1) continue;
    const [item] = out.splice(i, 1);
    const [flag] = stale.splice(i, 1);
    out.splice(j, 0, item);
    stale.splice(j, 0, flag);
  }
  return out;
}
