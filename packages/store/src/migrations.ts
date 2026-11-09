import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "crypto";
import {
  CODE_REVIEW_ADAPTER_IDS,
  PIPELINE_CATALOG,
  registeredPipelineStageKinds,
  type BoardTaskLinks,
  type ReviewLinkKind,
} from "@standup/shared";

/**
 * The `knowledge_retrievals.surface` values of a hook push (migration 078): one
 * per hook event, and `push:launch` for the push a Codex launch brief carries.
 */
export const KNOWLEDGE_PUSH_SURFACES = [
  "push:SessionStart",
  "push:UserPromptSubmit",
  "push:PreToolUse",
  "push:launch",
] as const;

/**
 * The `knowledge_retrievals` shape from migration 053 on, as a CREATE for a
 * table named `name` — shared by the migration and by the ensureSchemaRepairs
 * rebuild so the two cannot drift. See migration 053 for the columns and 078
 * for the push surfaces.
 */
function knowledgeRetrievalsTableSql(name: string): string {
  const surfaces = ["search", "expert", "inject", "doc_get", ...KNOWLEDGE_PUSH_SURFACES].map((s) => `'${s}'`).join(", ");
  return `CREATE TABLE ${name} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_project TEXT NOT NULL,
    doc_slug TEXT NOT NULL,
    query TEXT NOT NULL,
    rank INTEGER NOT NULL,
    score REAL,
    surface TEXT NOT NULL CHECK (surface IN (${surfaces})),
    session_id TEXT,
    query_project TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    injected INTEGER,
    launch_id TEXT,
    components_json TEXT,
    algo_version TEXT,
    raw_score REAL,
    relevance REAL,
    layer TEXT,
    source_kind TEXT,
    scope TEXT,
    doc_owner TEXT,
    drop_reason TEXT,
    latency_ms INTEGER
  )`;
}

const KNOWLEDGE_RETRIEVALS_INDEXES_SQL = `
  CREATE INDEX IF NOT EXISTS idx_knowledge_retrievals_doc
    ON knowledge_retrievals(doc_project, doc_slug);
  CREATE INDEX IF NOT EXISTS idx_knowledge_retrievals_created
    ON knowledge_retrievals(created_at);
  CREATE INDEX IF NOT EXISTS idx_knowledge_retrievals_launch
    ON knowledge_retrievals(launch_id);
  CREATE INDEX IF NOT EXISTS idx_knowledge_retrievals_session
    ON knowledge_retrievals(session_id);
`;

/** The `expert_exchanges` shape from migration 053 on (see there), for a table named `name`. */
function expertExchangesTableSql(name: string): string {
  return `CREATE TABLE ${name} (
    id TEXT PRIMARY KEY,
    session_id TEXT REFERENCES sessions(id),
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    region TEXT,
    sources_json TEXT DEFAULT '[]',
    created_at TEXT DEFAULT (datetime('now')),
    synthesized INTEGER,
    fallback_reason TEXT,
    retrieved_json TEXT,
    project TEXT,
    actor TEXT
  )`;
}

const EXPERT_EXCHANGES_INDEXES_SQL = `
  CREATE INDEX IF NOT EXISTS idx_expert_session ON expert_exchanges(session_id);
  CREATE INDEX IF NOT EXISTS idx_expert_created ON expert_exchanges(created_at);
`;

/**
 * The `share_grants.resource_type` values: a review packet, a doc (migration
 * 080) and a doc folder with everything below it (migration 085).
 */
export const SHARE_GRANT_RESOURCE_TYPES = ["review", "doc", "folder"] as const;

/**
 * The `share_grants` shape as a CREATE for a table named `name` — shared by
 * migration 080 and by migration 085's rebuild so the two cannot drift. A
 * column added to share_grants later belongs here too: the rebuild refuses
 * to drop a column this CREATE lacks.
 */
function shareGrantsTableSql(name: string, ifNotExists = false): string {
  const types = SHARE_GRANT_RESOURCE_TYPES.map((t) => `'${t}'`).join(", ");
  return `CREATE TABLE ${ifNotExists ? "IF NOT EXISTS " : ""}${name} (
    id TEXT PRIMARY KEY,
    resource_type TEXT NOT NULL CHECK (resource_type IN (${types})),
    resource_id TEXT NOT NULL,
    owner TEXT NOT NULL,
    token TEXT NOT NULL,
    token_sha256 TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    revoked_at TEXT
  )`;
}

const SHARE_GRANTS_INDEXES_SQL = `
  CREATE UNIQUE INDEX IF NOT EXISTS idx_share_grants_live
    ON share_grants(resource_type, resource_id) WHERE revoked_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_share_grants_owner ON share_grants(owner, resource_type);
`;

/** Columns of `knowledge_retrievals` that migration 053 adds. */
const KNOWLEDGE_RETRIEVALS_053_COLUMNS = [
  "components_json",
  "algo_version",
  "raw_score",
  "relevance",
  "layer",
  "source_kind",
  "scope",
  "doc_owner",
  "drop_reason",
];

/** Columns of `expert_exchanges` that migration 053 adds. */
const EXPERT_EXCHANGES_053_COLUMNS = ["synthesized", "fallback_reason", "retrieved_json", "project", "actor"];

/**
 * Migrations 001..051, positional: entry i is schema version i + 1. Do not add
 * to this list — a new migration goes in VERSIONED_MIGRATIONS (below) with an
 * explicit version: the next number unused here, there, in
 * RESERVED_MIGRATION_VERSIONS, and on any branch in flight. runMigrations
 * applies each version not yet recorded, so branches that add migrations in
 * parallel land in either order.
 */
export const MIGRATIONS = [
  // Migration 001: Initial schema
  `
  -- Projects from registry (cached for fast lookup)
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    emoji TEXT,
    icon_path TEXT,
    expert TEXT,
    branch TEXT DEFAULT 'main',
    repos_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  -- Sessions from Claude Code
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id),
    title TEXT,
    cwd TEXT NOT NULL,
    parent_session_id TEXT REFERENCES sessions(id),
    status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'idle', 'waiting', 'stalled')),
    started_at TEXT DEFAULT (datetime('now')),
    ended_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);

  -- Raw events from hooks
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    seq INTEGER NOT NULL,
    type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(session_id, seq)
  );
  CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
  CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);

  -- Checkpoints (milestone summaries)
  CREATE TABLE IF NOT EXISTS checkpoints (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    source TEXT NOT NULL CHECK (source IN ('structural', 'self-reported')),
    summary TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_checkpoints_session ON checkpoints(session_id);

  -- Asks (blocking questions from agents)
  CREATE TABLE IF NOT EXISTS asks (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    kind TEXT NOT NULL CHECK (kind IN ('ask_human', 'permission_prompt')),
    question TEXT NOT NULL,
    options_json TEXT,
    answer TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'answered', 'timeout', 'cancelled')),
    created_at TEXT DEFAULT (datetime('now')),
    resolved_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_asks_session ON asks(session_id);
  CREATE INDEX IF NOT EXISTS idx_asks_status ON asks(status);

  -- Steers (unsolicited human messages)
  CREATE TABLE IF NOT EXISTS steers (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    body TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'cancelled')),
    created_at TEXT DEFAULT (datetime('now')),
    delivered_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_steers_session ON steers(session_id);
  CREATE INDEX IF NOT EXISTS idx_steers_status ON steers(status);

  -- Expert exchanges
  CREATE TABLE IF NOT EXISTS expert_exchanges (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    region TEXT,
    sources_json TEXT DEFAULT '[]',
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_expert_session ON expert_exchanges(session_id);

  -- Stall detections
  CREATE TABLE IF NOT EXISTS stall_detections (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    reason TEXT NOT NULL,
    tool_calls INTEGER DEFAULT 0,
    quiet_minutes INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_stall_session ON stall_detections(session_id);

  -- Schema version tracking
  CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TEXT DEFAULT (datetime('now'))
  );
  `,

  // Migration 002: Launches
  `
  -- A launch is a session the console started: its own git worktree, its own
  -- branch, optionally a tmux session to attach to. Kept separate from
  -- sessions because a launch exists before Claude Code ever reports in, and
  -- outlives the session if the worktree is left in place.
  CREATE TABLE IF NOT EXISTS launches (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    task TEXT NOT NULL,
    worktree_path TEXT NOT NULL UNIQUE,
    branch TEXT NOT NULL,
    base_branch TEXT,
    tmux_session TEXT,
    session_id TEXT,
    status TEXT NOT NULL DEFAULT 'starting'
      CHECK (status IN ('starting', 'running', 'failed', 'cleaned')),
    error TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_launches_project ON launches(project_id);
  CREATE INDEX IF NOT EXISTS idx_launches_worktree ON launches(worktree_path);
  `,

  // Migration 003: projects.setup
  //
  // The Project type always declared `setup`, and projects.toml documented
  // it, but the column never existed — upsertProject silently dropped it.
  // A launch reads project.setup to run a project's setup command in a fresh
  // worktree, so without this it silently skipped that step for every
  // project.
  `
  ALTER TABLE projects ADD COLUMN setup TEXT;
  `,

  // Migration 004: launches.kind
  //
  // Distinguishes a launch that created its own git worktree from one that
  // *adopted* an existing session by resuming it in place. The difference is
  // safety-critical: an adopted launch's working directory is the user's
  // real repository, and cleanup must never run `git worktree remove` there.
  //
  // Existing rows are all worktree launches, which is the safe default.
  `
  ALTER TABLE launches ADD COLUMN kind TEXT NOT NULL DEFAULT 'worktree'
    CHECK (kind IN ('worktree', 'adopted'));
  `,

  // Migration 005: checkpoints.source 'auto'
  //
  // A third checkpoint source for the Haiku-generated summaries in
  // auto-checkpoint.ts — distinct from an agent's own self-reported call and
  // from the structural ones derived straight from hook data (TodoWrite,
  // SubagentStop). SQLite can't ALTER a CHECK constraint in place, so the
  // table is recreated.
  `
  CREATE TABLE checkpoints_new (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    source TEXT NOT NULL CHECK (source IN ('structural', 'self-reported', 'auto')),
    summary TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
  INSERT INTO checkpoints_new SELECT * FROM checkpoints;
  DROP TABLE checkpoints;
  ALTER TABLE checkpoints_new RENAME TO checkpoints;
  CREATE INDEX IF NOT EXISTS idx_checkpoints_session ON checkpoints(session_id);
  `,

  // Migration 006: settings
  //
  // A small global key/value store for UI-toggleable switches — starting
  // with auto-checkpointing, which costs real money per call and needs to
  // be flippable without a collector restart (unlike STANDUP_NUDGE=1).
  `
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,

  // Migration 007: launches.model / launches.effort
  //
  // What to pass as `claude --model` / `--effort` at launch, chosen from the
  // composer. NULL means the CLI's own default — never forced.
  `
  ALTER TABLE launches ADD COLUMN model TEXT;
  ALTER TABLE launches ADD COLUMN effort TEXT;
  `,

  // Migration 008: launches.kind 'bootstrap'
  //
  // A bootstrap launch runs the knowledge-bootstrap agent in a real worktree
  // (a stable git HEAD is the point, not isolation) so propose_knowledge can
  // stamp provenance from it. It needs its own kind rather than reusing
  // 'worktree' so the collector-side gate on /api/knowledge/propose can
  // require it specifically — without that, any launch could
  // write into the knowledge base. Same table-recreation as migration 005;
  // SQLite can't ALTER a CHECK constraint in place.
  `
  CREATE TABLE launches_new (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    task TEXT NOT NULL,
    worktree_path TEXT NOT NULL UNIQUE,
    branch TEXT NOT NULL,
    base_branch TEXT,
    tmux_session TEXT,
    session_id TEXT,
    status TEXT NOT NULL DEFAULT 'starting'
      CHECK (status IN ('starting', 'running', 'failed', 'cleaned')),
    error TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    kind TEXT NOT NULL DEFAULT 'worktree'
      CHECK (kind IN ('worktree', 'adopted', 'bootstrap')),
    model TEXT,
    effort TEXT
  );
  INSERT INTO launches_new
    (id, project_id, task, worktree_path, branch, base_branch, tmux_session,
     session_id, status, error, created_at, kind, model, effort)
    SELECT id, project_id, task, worktree_path, branch, base_branch, tmux_session,
           session_id, status, error, created_at, kind, model, effort
    FROM launches;
  DROP TABLE launches;
  ALTER TABLE launches_new RENAME TO launches;
  CREATE INDEX IF NOT EXISTS idx_launches_project ON launches(project_id);
  CREATE INDEX IF NOT EXISTS idx_launches_worktree ON launches(worktree_path);
  `,

  // Migration 009: projects.launch_args
  //
  // Extra CLI flags to pass `claude` when the console launches a session for
  // a project (e.g. `--permission-mode acceptEdits`). Stored as a single
  // string, like `setup`, and tokenized into argv at launch. NULL means no
  // extra flags — never forced.
  `
  ALTER TABLE projects ADD COLUMN launch_args TEXT;
  `,

  // Migration 010: projects.worktree_root
  //
  // Per-project override for where launched worktrees are created. NULL falls
  // back to the global `worktree_root` setting, then STANDUP_WORKTREE_ROOT,
  // then the built-in default. Lets a project be checked out onto a specific
  // volume (e.g. a case-sensitive one a build needs).
  `
  ALTER TABLE projects ADD COLUMN worktree_root TEXT;
  `,

  // Migration 011: projects.provision / projects.launch_subdir
  //
  // provision replaces `git worktree add` with a custom command that builds a
  // usable working dir (e.g. a workspace tool checking several repos out).
  // launch_subdir is where inside it the agent starts and setup runs (e.g.
  // `packages/<pkg>` for a workspace). Both NULL → default worktree behavior.
  `
  ALTER TABLE projects ADD COLUMN provision TEXT;
  ALTER TABLE projects ADD COLUMN launch_subdir TEXT;
  `,

  // Migration 012: launches.provisioned
  //
  // Marks a launch whose working dir came from a project `provision` command
  // rather than `git worktree add`. Cleanup keys off it — a provisioned dir is
  // a path-guarded `rm -rf`, never `git worktree remove`. Existing rows are
  // all worktree launches (0), the safe default.
  `
  ALTER TABLE launches ADD COLUMN provisioned INTEGER NOT NULL DEFAULT 0;
  `,

  // Migration 013: sessions.status 'done'
  //
  // A turn-end classifier (auto-checkpoint-gated) marks a session 'done' when
  // the agent finished with nothing pending — distinct from 'idle' (stopped
  // mid-thought) and from a 'waiting' needs-you. SQLite can't ALTER a CHECK in
  // place, so the table is recreated. Eight tables FK-reference sessions, so
  // foreign keys are disabled for the swap (the SQLite-recommended procedure);
  // the data is copied verbatim and keys re-enabled after.
  `
  PRAGMA foreign_keys=OFF;
  CREATE TABLE sessions_new (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id),
    title TEXT,
    cwd TEXT NOT NULL,
    parent_session_id TEXT REFERENCES sessions(id),
    status TEXT NOT NULL DEFAULT 'running'
      CHECK (status IN ('running', 'idle', 'waiting', 'stalled', 'done')),
    started_at TEXT DEFAULT (datetime('now')),
    ended_at TEXT
  );
  INSERT INTO sessions_new
    SELECT id, project_id, title, cwd, parent_session_id, status, started_at, ended_at
    FROM sessions;
  DROP TABLE sessions;
  ALTER TABLE sessions_new RENAME TO sessions;
  CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
  PRAGMA foreign_keys=ON;
  `,

  // Migration 014: launch provisioning progress
  //
  // `phase` names which slow step a still-"starting" launch is in
  // (provisioning / building / starting); `log` accumulates the streamed
  // stdout+stderr of the provision and setup commands, so the console can show
  // the otherwise-invisible workspace-create + build output live while a
  // launch provisions.
  `
  ALTER TABLE launches ADD COLUMN phase TEXT;
  ALTER TABLE launches ADD COLUMN log TEXT;
  `,

  // Migration 015: tickets (review kanban)
  //
  // A ticket is a unit of work moving through the review kanban:
  // proposed -> approved -> developing -> needs_review -> shipped, plus a
  // terminal dismissed. proposed rows come from review agents (propose_ticket);
  // approving fires an implementation launch (launch_id) that auto-advances the
  // ticket to developing when its session reports in (reusing the
  // attachSessionToLaunch signal); the implementation agent self-reports ready
  // (needs_review) via mark_ready_for_review, which also runs the project's
  // review gate and records review_url. Per-transition timestamps are stamped
  // by updateTicketStatus. `lens` is deliberately un-CHECKed — the review-lens
  // set is data-driven config, not a fixed enum. launch_id / session_id /
  // *_session_id are FK-free (like launches.session_id) so a headless review
  // agent that never registered a session, or a not-yet-linked launch, can't
  // trip a foreign-key violation. `error` holds a launch or review-gate failure
  // message surfaced on the card.
  `
  CREATE TABLE IF NOT EXISTS tickets (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    lens TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    severity TEXT NOT NULL DEFAULT 'medium'
      CHECK (severity IN ('low', 'medium', 'high', 'critical')),
    status TEXT NOT NULL DEFAULT 'proposed'
      CHECK (status IN ('proposed', 'approved', 'developing', 'needs_review', 'shipped', 'dismissed')),
    proposed_by_session_id TEXT,
    launch_id TEXT,
    session_id TEXT,
    review_url TEXT,
    ready_reason TEXT,
    error TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    approved_at TEXT,
    developing_at TEXT,
    ready_at TEXT,
    shipped_at TEXT,
    dismissed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_tickets_project ON tickets(project_id);
  CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
  CREATE INDEX IF NOT EXISTS idx_tickets_launch ON tickets(launch_id);
  `,

  // Migration 016: projects.review_process / projects.review_command
  //
  // Per-project review gate run on developing -> needs_review. NULL
  // review_process means "pause" (just wait for a human). "command" runs
  // review_command (a raw shell command, e.g. `gh pr create`) in the ticket's
  // worktree and extracts a code review URL onto the ticket; "review-agent" fires a
  // short follow-up launch that prepares the change for review. review_command
  // is only meaningful when review_process = 'command'. Existing rows get NULL
  // (= pause), the safe default.
  `
  ALTER TABLE projects ADD COLUMN review_process TEXT;
  ALTER TABLE projects ADD COLUMN review_command TEXT;
  `,

  // Migration 017: projects.daily_review_active / projects.review_lenses
  //
  // Per-project daily-review fan-out config. daily_review_active (0/1) toggles
  // whether the scheduler runs the read-only lens agents for this project;
  // review_lenses is a JSON-encoded array of lens names, NULL falling back to
  // the built-in REVIEW_LENSES set. Existing rows get NULL (= inactive / default
  // lenses), the safe default.
  `
  ALTER TABLE projects ADD COLUMN daily_review_active INTEGER;
  ALTER TABLE projects ADD COLUMN review_lenses TEXT;
  `,

  // Migration 018: in-place launches
  //
  // projects.in_place — the per-project default for the composer's "reuse
  // existing workspace" toggle. When 1, launches skip `git worktree add` and
  // run `claude` directly in repos[0].
  //
  // launches.in_place — records whether a launch actually ran in-place, so
  // cleanup can refuse to touch the working dir (it is the real repo). Same
  // shape as `provisioned`, and read alongside `kind === "adopted"` in the
  // cleanup guard. Existing rows get 0, the safe default.
  //
  // Also drops the UNIQUE constraint on launches.worktree_path. It was fine
  // when every launch got its own slug-suffixed checkout, but both adopted
  // and (now) in-place launches store the real repo path — so a second launch
  // reusing the same repo hits a UNIQUE violation instead of starting. Same
  // table-recreation dance as prior CHECK-constraint migrations; FKs are
  // disabled during the swap (no rows point at launches, so no cascades).
  `
  ALTER TABLE projects ADD COLUMN in_place INTEGER;
  PRAGMA foreign_keys=OFF;
  CREATE TABLE launches_new (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    task TEXT NOT NULL,
    worktree_path TEXT NOT NULL,
    branch TEXT NOT NULL,
    base_branch TEXT,
    tmux_session TEXT,
    session_id TEXT,
    status TEXT NOT NULL DEFAULT 'starting'
      CHECK (status IN ('starting', 'running', 'failed', 'cleaned')),
    error TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    kind TEXT NOT NULL DEFAULT 'worktree'
      CHECK (kind IN ('worktree', 'adopted', 'bootstrap')),
    model TEXT,
    effort TEXT,
    provisioned INTEGER NOT NULL DEFAULT 0,
    phase TEXT,
    log TEXT,
    in_place INTEGER NOT NULL DEFAULT 0
  );
  INSERT INTO launches_new
    (id, project_id, task, worktree_path, branch, base_branch, tmux_session,
     session_id, status, error, created_at, kind, model, effort, provisioned,
     phase, log)
    SELECT id, project_id, task, worktree_path, branch, base_branch, tmux_session,
           session_id, status, error, created_at, kind, model, effort, provisioned,
           phase, log
    FROM launches;
  DROP TABLE launches;
  ALTER TABLE launches_new RENAME TO launches;
  CREATE INDEX IF NOT EXISTS idx_launches_project ON launches(project_id);
  CREATE INDEX IF NOT EXISTS idx_launches_worktree ON launches(worktree_path);
  PRAGMA foreign_keys=ON;
  `,

  // Migration 019: transcript events substrate
  //
  // A durable, per-session, sequence-numbered mirror of Claude Code's JSONL
  // transcript — the event-sourced shared state a projection reducer and any
  // future multi-device viewer read from, so the served transcript no longer
  // depends on each client tail-reading the file itself. JSONL stays the
  // ingest SOURCE; this is the canonical SERVED state, and (like every other
  // table here) a rebuildable index.
  //
  // transcript_events holds the ordered log — seq is monotonic per session.
  // transcript_event_identities maps a record's stable identity (its JSONL
  // uuid, and an optional idempotency_key for a future optimistic send path)
  // onto its seq, so re-ingesting the same file — or replaying a send — dedups
  // to the existing seq instead of appending a duplicate. The partial unique
  // index enforces send-idempotency only when a key is present; ingested
  // records carry none, so it never constrains them.
  `
  CREATE TABLE IF NOT EXISTS transcript_events (
    session_id TEXT NOT NULL REFERENCES sessions(id),
    seq INTEGER NOT NULL,
    event_json TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (session_id, seq)
  );

  CREATE TABLE IF NOT EXISTS transcript_event_identities (
    session_id TEXT NOT NULL REFERENCES sessions(id),
    event_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    idempotency_key TEXT,
    PRIMARY KEY (session_id, event_id)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_transcript_event_idempotency
    ON transcript_event_identities(session_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
  `,

  // Migration 020: task-run ledger + dispatcher lifecycle
  //
  // A durable record of every dispatched unit of work — the ledger OpenClaw
  // keeps as `task_runs`. Today a launch is fire-and-forget: `launchSession`
  // spawns a tmux pane and forgets it, so nothing records whether the work
  // succeeded, failed, or died with its pane. This table is that missing state
  // machine: launchSession writes a `queued` row, advances it to `running` when
  // the pane spawns, and terminal states are reported by the agent itself
  // (report_task -> succeeded/failed) or inferred by a reconciliation sweep
  // (dead pane past a grace window -> lost).
  //
  // Kept separate from `launches` deliberately: `launches` is the worktree/tmux
  // provisioning record (starting/running/failed/cleaned), while this is the
  // work lifecycle a coworker cares about (did it finish? is it stuck?). They
  // share `worktree_path`, which is how the sweep locates the launch's tmux
  // pane and how a reporting session's ledger row is found. FK-free on
  // session_id (like launches.session_id) so a row can exist before Claude Code
  // ever reports in. `last_event_at` is the heartbeat/liveness clock;
  // `requester` is the tunnel user who dispatched it (best-effort).
  `
  CREATE TABLE IF NOT EXISTS task_runs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL DEFAULT 'worktree',
    project_id TEXT NOT NULL REFERENCES projects(id),
    session_id TEXT,
    worktree_path TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued'
      CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'lost')),
    requester TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    started_at TEXT,
    ended_at TEXT,
    last_event_at TEXT,
    summary TEXT,
    error TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_task_runs_project ON task_runs(project_id);
  CREATE INDEX IF NOT EXISTS idx_task_runs_status ON task_runs(status);
  CREATE INDEX IF NOT EXISTS idx_task_runs_worktree ON task_runs(worktree_path);
  CREATE INDEX IF NOT EXISTS idx_task_runs_session ON task_runs(session_id);
  `,

  // Migration 021: users (tunnel identity)
  //
  // Every person who reaches the collector, keyed by their SSO alias. Behind
  // an authenticating tunnel that alias arrives in the tunnel provider's
  // identity header; off-tunnel it falls back to the host user. touchUser upserts a row per
  // request, so first_seen/last_seen bracket a teammate's activity — the
  // identity foundation the collaboration model (owner/participants) builds on.
  // display is null until something sets it (the alias reads as the name).
  `
  CREATE TABLE IF NOT EXISTS users (
    alias TEXT PRIMARY KEY,
    display TEXT,
    first_seen TEXT DEFAULT (datetime('now')),
    last_seen TEXT DEFAULT (datetime('now'))
  );
  `,

  // Migration 022: collaboration model — actors / owner / participants
  //
  // `actors` is the durable collaborator table the session ownership graph
  // points at, seeded from the tunnel alias (users). It's kept distinct from
  // `users` (the raw per-request identity ledger) so an actor can carry richer
  // identity — a github_login — without bloating the request-hot users upsert.
  //
  // `merged_into` reconciles one human's two actor rows into one: the same
  // teammate who answers an ask in Slack (a `slack:U…` actor) and drives
  // sessions through the tunnel (an SSO-alias actor) would otherwise be two
  // permanent, unlinkable rows that double-count them. A non-null value is a
  // tombstone pointing at the canonical row; getActor follows it and getActors
  // hides the folded rows (see mergeActors). Mirrors OpenClaw's
  // user_profiles.merged_into.
  //
  // `sessions` gains two attribution columns: `created_actor` (write-once — who
  // brought the session into being: the tunnel user who dispatched its launch,
  // else the host user) and `owner_actor` (reassignable — who currently owns
  // it). Added by ALTER, so both are NULL for pre-existing sessions, the honest
  // "unknown" default.
  //
  // `session_participants` records, best-effort, which actors touched a session
  // (steer/reply/dispatch), one row per (session, actor) with a bumping
  // contribution_count. Capped per session in code (see recordParticipant), not
  // by the schema. FK on actor_id — recordParticipant upserts the actor first,
  // so the reference always resolves.
  `
  CREATE TABLE IF NOT EXISTS actors (
    id TEXT PRIMARY KEY,
    display TEXT,
    github_login TEXT,
    merged_into TEXT REFERENCES actors(id),
    first_seen TEXT DEFAULT (datetime('now')),
    last_seen TEXT DEFAULT (datetime('now'))
  );

  ALTER TABLE sessions ADD COLUMN created_actor TEXT;
  ALTER TABLE sessions ADD COLUMN owner_actor TEXT;

  CREATE TABLE IF NOT EXISTS session_participants (
    session_id TEXT NOT NULL REFERENCES sessions(id),
    actor_id TEXT NOT NULL REFERENCES actors(id),
    first_seen TEXT DEFAULT (datetime('now')),
    contribution_count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (session_id, actor_id)
  );
  CREATE INDEX IF NOT EXISTS idx_session_participants_actor
    ON session_participants(actor_id);
  `,

  // Migration 023: user_prefs — per-user profile ("a CLAUDE.md for each user")
  //
  // A server-side profile keyed by the same SSO alias as `users`, kept in
  // the SHARED DB so it follows the person across the gateway. A sibling table
  // rather than columns on `users`: the profile is written rarely (a settings
  // save) and read at launch time, so it has no place on the per-request
  // touchUser upsert path.
  //
  // `personal_instructions` is the freeform catch-all appended to a launch's
  // opening prompt; `review_rigor` and `deploy_target_json` are the structured
  // commons. The deploy target is CONTEXT injected as instruction text
  // (account/role/command) — never credentials; the agent authenticates with
  // its own ambient creds. All three are nullable — a user who never opened
  // settings has no row, which getUserPrefs reads as "no personalization".
  `
  CREATE TABLE IF NOT EXISTS user_prefs (
    alias TEXT PRIMARY KEY,
    personal_instructions TEXT,
    review_rigor TEXT,
    deploy_target_json TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  );
  `,

  // Migration 024: launches.requester — the launch's client-visible actor
  //
  // The dispatching tunnel user, mirrored from the task_runs ledger onto the
  // launches row so the "Mine" lens can judge a still-provisioning, sessionless
  // launch by who started it. Without it a Launch carried no actor at all, so
  // "Mine" showed EVERY user's in-flight launch to everyone. NULL for launches
  // created before this and for automatic launches with no requester.
  `
  ALTER TABLE launches ADD COLUMN requester TEXT;
  `,

  // Migration 025: users.via_tunnel — did this identity connect as a person?
  //
  // The multiplayer signal (isMultiplayerMode) counts "people who connected",
  // but the users table is written on EVERY /api/* request — including an
  // agent/MCP phone-home (checkpoint, heartbeat, ask, …) that carries NO
  // tunnel identity header and so resolves to the host `$USER` (or "local").
  // On any host where `$USER` differs from a browser's tunnel-injected SSO
  // alias (macOS personal short-name, EC2 ec2-user/ubuntu, or the "local"
  // fallback), a single solo human produced two rows — their browser alias and
  // their own agents' host identity — and that tripped the ≥2 count into
  // multiplayer, silently flipping the launch default to a fresh worktree.
  //
  // via_tunnel marks the identities that actually arrived through the gateway
  // as a remote person (the header was present). It is sticky: MAX() on upsert
  // never downgrades a person's row to 0 on a later header-less request under
  // the same alias. countDistinctUsers counts only via_tunnel = 1 so agent
  // process identities no longer inflate the people count.
  `
  ALTER TABLE users ADD COLUMN via_tunnel INTEGER NOT NULL DEFAULT 0;
  `,

  // Migration 026: user_project_prefs — per-user, per-project overlay
  //
  // The per-(user, project) overlay layered on top of the global user_prefs
  // profile (migration 023), mirroring CLAUDE.md's global + per-project
  // layering: repo CLAUDE.md → project shared config → per-user global → this.
  //
  // A sibling table rather than a nullable project_id on user_prefs because that
  // table keys on `alias` as a true (NOT NULL) PRIMARY KEY — a composite
  // (alias, project_id) here keeps both key columns NOT NULL and leaves the
  // committed global table untouched. Same three profile fields as the global
  // row; the launcher MERGES the two at launch time (global
  // personal_instructions + this, both applied with the project text after;
  // project-overrides-global for the structured review_rigor / deploy_target).
  // Kept in the SHARED DB so it follows the user across the gateway like the global profile.
  //
  // FK on project_id so the overlay can't outlive its project — deleteProject
  // clears these rows before dropping the project (a reassign to `scratch` would
  // be wrong here: an overlay is config FOR a specific project, meaningless once
  // it's gone).
  `
  CREATE TABLE IF NOT EXISTS user_project_prefs (
    alias TEXT NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id),
    personal_instructions TEXT,
    review_rigor TEXT,
    deploy_target_json TEXT,
    updated_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (alias, project_id)
  );
  CREATE INDEX IF NOT EXISTS idx_user_project_prefs_alias
    ON user_project_prefs(alias);
  `,

  // Migration 027: knowledge_retrievals — retrieval-usage telemetry
  //
  // One row per (query, retrieved doc) hit, recorded best-effort as the
  // knowledge system is read: a search result, an expert-answer knowledge
  // source, or a launch-time injection. This is the usage signal ranking
  // (#4) and staleness re-verification prioritization (#5) consume — nothing
  // recorded which knowledge was actually retrieved before this.
  //
  // The feedback half — did the retrieval help? — is derived, not a stored
  // column: `session_id` correlates each retrieval to a session, and that
  // session's outcome already lives in the `task_runs` ledger. getRetrievalUsage
  // LEFT JOINs the two on session_id, so a doc retrieved mostly in sessions that
  // FAILED reads apart from one retrieved in sessions that succeeded — the
  // distinction #5 needs to re-verify frequently-surfaced-but-unhelpful facts.
  // Keeping the outcome out of this table avoids a denormalized copy that would
  // go stale when a run's terminal state is reported after the retrieval.
  //
  // The doc is identified by (doc_project, doc_slug) — the same stable pair
  // knowledge docs are keyed by — rather than the rebuildable SQLite doc id,
  // so a corpus re-index doesn't orphan the history. `query_project` is the
  // project context the query ran in (which can differ from the retrieved
  // doc's project on a cross-project "all" search). `rank` is the 0-based
  // position in the result list; `score` is the retrieval score (nullable —
  // an injection surface may not carry one). `session_id` is the correlated
  // calling session when known, left NULL for a project-scoped read from the
  // Knowledge tab that has no agent session. Recording is fire-and-forget:
  // a logging failure must never fail the search it is observing.
  `
  CREATE TABLE IF NOT EXISTS knowledge_retrievals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_project TEXT NOT NULL,
    doc_slug TEXT NOT NULL,
    query TEXT NOT NULL,
    rank INTEGER NOT NULL,
    score REAL,
    surface TEXT NOT NULL CHECK (surface IN ('search', 'expert', 'inject')),
    session_id TEXT,
    query_project TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_knowledge_retrievals_doc
    ON knowledge_retrievals(doc_project, doc_slug);
  CREATE INDEX IF NOT EXISTS idx_knowledge_retrievals_created
    ON knowledge_retrievals(created_at);
  `,

  // Migration 028: tickets.reported_by_actor — external status-report attribution
  //
  // The actor who last advanced a ticket through the decoupled status setter
  // (POST /api/tickets/:id/status). The ticket lifecycle no longer requires a
  // Standup-owned launch to move — an external agent or user reports/advances
  // status directly — so the reporting alias (resolveUserAlias) is recorded here
  // rather than being inferred from an implementation launch's created_actor.
  // NULL for tickets only ever moved by the launch-coupled paths (approve /
  // dispatch / the SessionStart auto-advance) and for rows created before this.
  `
  ALTER TABLE tickets ADD COLUMN reported_by_actor TEXT;
  `,

  // Migration 029: tickets.note — the note supplied with a status report
  //
  // The one-line note carried by the decoupled status setter (POST
  // /api/tickets/:id/status and the report_ticket_status MCP tool) on ANY
  // transition — what changed / why. ready_reason stays the specialized ready
  // summary read on the needs_review edge; this is the general status-change
  // note, recorded on every edge (approve, send-back, dismiss, un-dismiss, ship)
  // so a report's rationale is never dropped. NULL for rows never moved by a
  // note-bearing status report and for rows created before this.
  `
  ALTER TABLE tickets ADD COLUMN note TEXT;
  `,

  // Migration 030: projects.review_artifact_provider — the review-artifact seam
  //
  // Which code-review adapter a project's changes are reviewed through
  // (Project.codeReviewAdapter). NULL
  // auto-detects, so existing rows keep the auto-selected behavior.
  `
  ALTER TABLE projects ADD COLUMN review_artifact_provider TEXT;
  `,

  // Migration 031: tickets.issue_id — tracking issue/task id
  //
  // The tracking issue/task a ticket resolves (an issue-tracker id), set by
  // the proposing agent when known. Threaded into the review-artifact seam so
  // the composed review links it. NULL for rows filed without one and for rows
  // created before this.
  `
  ALTER TABLE tickets ADD COLUMN issue_id TEXT;
  `,

  // Migration 032: the plan-approval gate — projects.plan_gate + plan_approvals
  //
  // plan_gate opts a project into a Devin/Jules-style pre-run plan approval:
  // NULL/0 keeps every launch un-gated (today's behavior), 1 makes launches
  // pause for a human to approve the agent's plan before it works. The
  // plan_approvals table is the per-launch gate record: the agent submits its
  // relevant files + plan + a machine-checkable acceptance criterion, a human
  // approves (possibly editing) it, and criterion_met flips once the criterion
  // passes in the worktree — the signal that unblocks mark_ready_for_review.
  `
  ALTER TABLE projects ADD COLUMN plan_gate INTEGER NOT NULL DEFAULT 0;

  CREATE TABLE IF NOT EXISTS plan_approvals (
    id TEXT PRIMARY KEY,
    launch_id TEXT NOT NULL REFERENCES launches(id),
    project_id TEXT NOT NULL,
    worktree_path TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'awaiting_plan'
      CHECK (status IN ('awaiting_plan', 'awaiting_approval', 'approved', 'rejected')),
    relevant_files TEXT,
    plan TEXT,
    acceptance_criterion TEXT,
    criterion_met INTEGER NOT NULL DEFAULT 0,
    approved_by TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    submitted_at TEXT,
    approved_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_plan_approvals_launch ON plan_approvals(launch_id);
  CREATE INDEX IF NOT EXISTS idx_plan_approvals_status ON plan_approvals(status);
  `,

  // Migration 033: tickets.task_url — the originating tracker task's deep link
  //
  // A link back to the tracker task a ticket was ingested from (TrackerTask.url),
  // stored at ingest so the kanban card can surface a clickable link back to the
  // task alongside its id (the task<->work-item mapping made visible). NULL for
  // tickets not originated from a tracker task and for rows created before this.
  `
  ALTER TABLE tickets ADD COLUMN task_url TEXT;
  `,

  // Migration 034: review_findings — the auto-review reviewer/fixer split
  //
  // On the developing -> needs_review edge a read-only reviewer passes over the
  // ticket's diff and records what it finds here. Only High/critical rows surface
  // on the Work review-queue (de-noise). The reviewer is SEPARATE from the fixer:
  // `fix_launch_id` is the fresh fixer session a human dispatched for a finding,
  // and it is set ONLY by the explicit "fix this finding" click — never by the
  // reviewer. `evidence` is the validation-evidence bundle (checks + screenshots
  // + reviewed diff) handed to the fixer at dispatch.
  `
  CREATE TABLE IF NOT EXISTS review_findings (
    id TEXT PRIMARY KEY,
    ticket_id TEXT NOT NULL REFERENCES tickets(id),
    session_id TEXT,
    severity TEXT NOT NULL DEFAULT 'medium'
      CHECK (severity IN ('low', 'medium', 'high', 'critical')),
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    file TEXT,
    line INTEGER,
    status TEXT NOT NULL DEFAULT 'open'
      CHECK (status IN ('open', 'dispatched', 'dismissed')),
    fix_launch_id TEXT,
    evidence TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_review_findings_ticket ON review_findings(ticket_id);
  `,

  // Migration 035: review_findings.status 'superseded'
  //
  // A re-review of the same ticket (the needs_review -> developing -> needs_review
  // rework edge) must not stack a second set of findings on top of the first.
  // When a fresh pass runs, its still-`open` predecessors are marked 'superseded'
  // so they drop off the review-queue without a human decision — distinct from a
  // human 'dismissed' verdict and from a 'dispatched' finding whose fixer is in
  // flight. SQLite can't ALTER a CHECK constraint in place, so the table is
  // recreated (same pattern as migrations 005/008).
  `
  CREATE TABLE review_findings_new (
    id TEXT PRIMARY KEY,
    ticket_id TEXT NOT NULL REFERENCES tickets(id),
    session_id TEXT,
    severity TEXT NOT NULL DEFAULT 'medium'
      CHECK (severity IN ('low', 'medium', 'high', 'critical')),
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    file TEXT,
    line INTEGER,
    status TEXT NOT NULL DEFAULT 'open'
      CHECK (status IN ('open', 'dispatched', 'dismissed', 'superseded')),
    fix_launch_id TEXT,
    evidence TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  INSERT INTO review_findings_new SELECT * FROM review_findings;
  DROP TABLE review_findings;
  ALTER TABLE review_findings_new RENAME TO review_findings;
  CREATE INDEX IF NOT EXISTS idx_review_findings_ticket ON review_findings(ticket_id);
  `,

  // Migration 036: knowledge_changes — the durable backing for the feed's
  // knowledge leg
  //
  // A knowledge-graph mutation worth a curated-feed line: a doc accepted into
  // the corpus, removed, reconciled (a merge-accept), flagged as contradicting
  // another doc, or freshly distilled. Persisted so the change survives a
  // reload/reconnect the same way checkpoints/asks/expert consults do — the
  // hello-ok snapshot ships getRecentKnowledgeChanges and /api/knowledge-changes
  // re-reads it on a seq-gap resync; without this the feed's knowledge rows were
  // WS-only and vanished on every page load. `contradicted` holds the JSON array
  // of opposing slugs for a `contradiction` change, NULL otherwise. `session_id`
  // is the authoring/triggering session when one is resolvable (an ingested or
  // cron-flagged change has none). Project-scoped, not session-scoped.
  `
  CREATE TABLE IF NOT EXISTS knowledge_changes (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    slug TEXT NOT NULL,
    kind TEXT NOT NULL
      CHECK (kind IN ('accepted', 'removed', 'reconciled', 'contradiction', 'distilled')),
    title TEXT NOT NULL,
    session_id TEXT,
    contradicted TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_knowledge_changes_created
    ON knowledge_changes(created_at);
  CREATE INDEX IF NOT EXISTS idx_knowledge_changes_project
    ON knowledge_changes(project_id);
  `,

  // Migration 037: projects.reserved — the reserved/hidden system-project flag
  //
  // Marks a reserved system project such as the GLOBAL best-practices corpus
  // (id `global`): 1 means it is auto-ensured on boot, always spanned by
  // cross-project (corpus:"all") search and launch-time injection, and hidden
  // from the launchable-project UI. NULL/0 keeps a project ordinary (today's
  // behavior) — every existing row and every user-defined project.
  `
  ALTER TABLE projects ADD COLUMN reserved INTEGER NOT NULL DEFAULT 0;
  `,

  // Migration 038: knowledge_resolutions — the contradiction-resolver ledger
  //
  // A durable record of every automatic contradiction resolution the resolver
  // attempts over a flagged doc↔doc pair. When the coherence pass
  // detects a NEW `contradicts` edge, an in-process resolver proposes a
  // resolution — `rescope` (narrow both claims so they no longer conflict),
  // `merge` (combine into one doc and tombstone the other), or `supersede`
  // (tombstone the losing claim with confidence decay, keeping history). A
  // non-destructive proposal is auto-applied and recorded here with
  // status='applied'; a destructive one (a hard delete, or superseding a
  // human-authored `owner` or high-confidence claim) is NOT applied — it is
  // recorded status='needs_review' as the durable human-review queue entry
  // describing the proposed resolution for a human to accept.
  //
  // Project-scoped, not session-scoped: a contradiction flagged by an
  // unattended cron has no authoring session. `detail` holds the JSON of the
  // proposal specifics (rescope qualifiers / a merge note) plus the classifier's
  // reason, so a human reviewing a `needs_review` row sees exactly what was
  // proposed and why it was withheld. `winner_slug`/`loser_slug` are the two
  // docs of the conflicting pair; both are FK-free (like knowledge_changes) so a
  // row survives a corpus re-index that changes the rebuildable doc ids.
  `
  CREATE TABLE IF NOT EXISTS knowledge_resolutions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    winner_slug TEXT NOT NULL,
    loser_slug TEXT NOT NULL,
    type TEXT NOT NULL
      CHECK (type IN ('rescope', 'merge', 'supersede', 'delete')),
    status TEXT NOT NULL
      CHECK (status IN ('applied', 'needs_review')),
    auto_applied INTEGER NOT NULL DEFAULT 0,
    rationale TEXT NOT NULL DEFAULT '',
    detail TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_knowledge_resolutions_project
    ON knowledge_resolutions(project_id);
  CREATE INDEX IF NOT EXISTS idx_knowledge_resolutions_status
    ON knowledge_resolutions(status);
  `,

  // Migration 039: launches.idempotency_key — dedup a redelivered launch command
  //
  // A launch fired from a bot-directed Slack message can be redelivered (a missed
  // socket ack) or arrive after the adapter restarted with an empty in-memory
  // dedup, and POST /api/projects/:id/launch otherwise mints a fresh worktree +
  // tmux session on every call. This column records the caller's idempotency key
  // so a duplicate request resolves to the SAME launch instead of spawning a
  // second repo-modifying agent — the collector-side guard the steer/send path
  // already had (transcript_event_identities), now for the far costlier launch.
  // The partial UNIQUE index enforces it only when a key is present; internal and
  // automatic launches carry none, so it never constrains them.
  `
  ALTER TABLE launches ADD COLUMN idempotency_key TEXT;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_launches_idempotency
    ON launches(idempotency_key) WHERE idempotency_key IS NOT NULL;
  `,

  // Migration 040: best-of-N parallel attempts (compare + pick)
  //
  // A ticket can be dispatched as N parallel attempts (N in 1..4), each its own
  // git worktree + task_run. `attempt_group` on task_runs is the id those N runs
  // share (NULL for an ordinary single dispatch, which is never grouped);
  // `attempt_status` is the selection state once a human picks a winner
  // ('pending' while unresolved, 'selected' for the one whose branch becomes the
  // ticket output, 'superseded' for the losers — NULL when ungrouped). The same
  // group id is mirrored onto the ticket (`tickets.attempt_group`) so the
  // compare/pick UI resolves a ticket's attempts by it. All three are ALTER-added
  // and NULL for existing rows — the honest "not an attempt" default.
  `
  ALTER TABLE task_runs ADD COLUMN attempt_group TEXT;
  ALTER TABLE task_runs ADD COLUMN attempt_status TEXT;
  ALTER TABLE tickets ADD COLUMN attempt_group TEXT;
  CREATE INDEX IF NOT EXISTS idx_task_runs_attempt_group
    ON task_runs(attempt_group);
  `,

  // Migration 041: agent-to-agent coordination — session_messages + shared_notes
  //
  // session_messages is a per-session mailbox: a message enqueued from one
  // session (from_session_id) for another (to_session_id), delivered on the
  // target's next turn through the same injection seam steers ride (drained by
  // claimPendingMessages). It mirrors the `steers` table one-for-one — a
  // pending/delivered/cancelled lifecycle with a delivered_at stamp — but adds
  // the sender attribution (from_session_id / from_label) that makes it
  // agent-to-agent rather than human-to-agent. to_session_id has the sessions
  // FK so a message can't be queued for a session that never existed; the
  // enqueue endpoint checks the target first and reports an unknown target
  // gracefully rather than tripping the constraint. from_session_id is FK-free
  // (like launches.session_id) so a headless/external sender that never
  // registered a session row can still address a teammate.
  //
  // shared_notes is the lightweight shared task-list: an append-only board every
  // coordinating agent reads and posts to, scoped to a project when one is known
  // (project_id FK-free like knowledge_changes, so a scratch session with no
  // project posts to the global board). `done` strikes a line once its work is
  // finished.
  `
  CREATE TABLE IF NOT EXISTS session_messages (
    id TEXT PRIMARY KEY,
    to_session_id TEXT NOT NULL REFERENCES sessions(id),
    from_session_id TEXT,
    from_label TEXT,
    body TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'delivered', 'cancelled')),
    created_at TEXT DEFAULT (datetime('now')),
    delivered_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_session_messages_to ON session_messages(to_session_id);
  CREATE INDEX IF NOT EXISTS idx_session_messages_status ON session_messages(status);

  CREATE TABLE IF NOT EXISTS shared_notes (
    id TEXT PRIMARY KEY,
    project_id TEXT,
    from_session_id TEXT,
    from_label TEXT,
    body TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_shared_notes_project ON shared_notes(project_id);
  `,

  // Migration 042: harness selection (Codex, additive alongside Claude)
  //
  // projects.harness names which agent CLI the console launches for a project:
  // NULL/'claude' is the default harness (unchanged), 'codex' launches a
  // headless `codex exec --json` session through the Codex harness adapter.
  //
  // launches.harness records the harness a launch actually spawned;
  // launches.codex_event_log is the JSONL sidecar a codex launch's event stream
  // is tee'd to, which fleet telemetry reads to reconcile per-turn token usage
  // (Codex's analogue of Claude's JSONL transcript). Both NULL for a Claude
  // launch and for rows created before this — the safe, unchanged default.
  `
  ALTER TABLE projects ADD COLUMN harness TEXT;
  ALTER TABLE launches ADD COLUMN harness TEXT;
  ALTER TABLE launches ADD COLUMN codex_event_log TEXT;
  `,

  // Migration 043: projects.knowledge_scope — the per-project default scope new
  // knowledge takes when the author asserts none.
  //
  // NULL (the default for every existing and new project) means "no project
  // override" — authoring falls back to the global knowledge.default_scope
  // setting and finally to 'project', the scope every doc predating the scope
  // dimension already had. A value of 'global' promotes new docs authored under
  // the project to the whole corpus; 'project' pins them project-local. Only
  // these two are project-level defaults — per-doc 'user' scope is set on the
  // document, never as a project default. Additive and reversible: an unset
  // column leaves every project's authoring behavior exactly as it was.
  `
  ALTER TABLE projects ADD COLUMN knowledge_scope TEXT;
  `,

  // Migration 044: launches.codex_model / launches.codex_effort — the model and
  // reasoning effort a Codex launch was started with, at parity with the
  // Claude-typed launches.model / launches.effort.
  //
  // Kept in their OWN columns rather than overloading model/effort: those are
  // typed for the Claude enums, and conflating a free-form Codex model id or the
  // Codex effort ladder (see CodexEffort) onto them would blur the two
  // harnesses' distinct value spaces. Both NULL for a Claude launch and for rows
  // created before this — NULL means the Codex CLI's own default (an API caller
  // that omits them leaves them unset, exactly as an omitted --model does for
  // Claude). Additive and reversible.
  `
  ALTER TABLE launches ADD COLUMN codex_model TEXT;
  ALTER TABLE launches ADD COLUMN codex_effort TEXT;
  `,

  // Migration 045: subagent subsessions — nest a spawned subagent under its
  // parent session (OpenClaw-style parent -> child).
  //
  // `sessions.parent_session_id` has always existed (a self-referential FK,
  // migration 001) but was never populated — every row was a root. A subagent
  // now gets its OWN child session row, keyed by the synthetic id
  // `${parentSessionId}:${agentId}`, with parent_session_id pointing at the
  // session that spawned it. `kind` distinguishes a child ('subagent') from a
  // root (NULL, which every existing row reads as — the honest default);
  // `agent_type` is the subagent's label and `agent_id` its correlation key
  // across the SubagentStart/SubagentStop pair. The index makes the
  // children-of-a-parent lookup (getChildSessions) and the roots-only list
  // filter cheap. All three columns are nullable/additive and the index uses
  // IF NOT EXISTS, so the whole migration is additive, reversible, and
  // idempotent — safe for the live collector to re-run on every source edit.
  `
  CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_session_id);
  ALTER TABLE sessions ADD COLUMN kind TEXT;
  ALTER TABLE sessions ADD COLUMN agent_type TEXT;
  ALTER TABLE sessions ADD COLUMN agent_id TEXT;
  `,

  // Migration 046: digests — the durable backing for the daily-digest feed leg
  //
  // A once-a-day standup digest of the last ~24h across every project, posted at
  // the configured local hour (default 9am EST) by the digest cron. Persisted so
  // it survives a reload/reconnect the same way knowledge_changes does — the
  // hello-ok snapshot ships getRecentDigests and /api/digests re-reads it on a
  // seq-gap resync. `period_start`/`period_end` bracket the covered window;
  // `body` is the model-summarized (or plainly rendered) markdown the feed
  // renders; `projects_json` is the array of covered project ids and
  // `counts_json` the per-dimension tallies. A pure additive CREATE TABLE
  // (O(1), live-safe): merging reloads the collector, which then starts the cron.
  `
  CREATE TABLE IF NOT EXISTS digests (
    id TEXT PRIMARY KEY,
    created_at TEXT DEFAULT (datetime('now')),
    period_start TEXT NOT NULL,
    period_end TEXT NOT NULL,
    body TEXT NOT NULL,
    projects_json TEXT NOT NULL DEFAULT '[]',
    counts_json TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS idx_digests_created ON digests(created_at);
  `,

  // Migration 047: orchestration profiles + run ledger — a named, scoped
  // develop → deploy → review workflow.
  //
  // `orchestration_profiles` is the named-profile store keyed by (scope,
  // owner_key, name): owner_key is the alias for a personal profile, the
  // project id for a project profile, and the literal `__global__` for the one
  // account-wide set. `definition_json` holds the ordered steps plus the
  // profile-wide review knobs; the name/scope columns stay authoritative for the
  // UNIQUE lookup. `orchestration_runs` is the enforcement ledger — a run stays
  // `running` across convergence rounds (round advances instead of re-entering
  // `running`), which is why it does not reuse task_runs' transition table.
  // `orchestration_gate_results` records each step evaluation for the run's
  // history. All three are additive CREATE TABLE IF NOT EXISTS (self-healing).
  //
  // The two per-scope default columns (`projects.orchestration_profile`,
  // `user_prefs.orchestration_profile`) name the profile a launch adopts when it
  // asserts none; NULL everywhere means "no default at this scope". They are
  // added ONLY by the PRAGMA-guarded mirrors in ensureSchemaRepairs (matching
  // plan_gate / knowledge_scope), never by an ALTER in this migration body:
  // SQLite has no ADD COLUMN IF NOT EXISTS, so an ALTER here would throw
  // "duplicate column" when re-running a 047 that had already added one of the
  // columns before it aborted. Each guarded mirror adds its column exactly once.
  `
  CREATE TABLE IF NOT EXISTS orchestration_profiles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    scope TEXT NOT NULL,
    owner_key TEXT NOT NULL,
    definition_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(scope, owner_key, name)
  );
  CREATE TABLE IF NOT EXISTS orchestration_runs (
    id TEXT PRIMARY KEY,
    profile_name TEXT NOT NULL,
    scope TEXT NOT NULL,
    owner_key TEXT NOT NULL,
    project_id TEXT,
    ticket_id TEXT,
    session_id TEXT,
    launch_id TEXT,
    status TEXT NOT NULL,
    round INTEGER NOT NULL DEFAULT 0,
    max_rounds INTEGER NOT NULL DEFAULT 3,
    last_event_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    ended_at TEXT,
    summary TEXT,
    error TEXT
  );
  CREATE TABLE IF NOT EXISTS orchestration_gate_results (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    round INTEGER NOT NULL,
    step_index INTEGER NOT NULL,
    kind TEXT NOT NULL,
    passed INTEGER NOT NULL,
    detail TEXT,
    created_at TEXT NOT NULL
  );
  `,

  // Migration 048: knowledge_retrievals.injected / knowledge_retrievals.launch_id
  // — the injected-vs-dropped signal for retrieval telemetry.
  //
  // `injected` records whether a retrieved doc was ACTUALLY fed to the agent:
  // NULL = not-applicable (the ranking-only `search` surface, and every row that
  // predates this); 1 = injected into a launch's opening prompt or cited in an
  // ask_expert answer; 0 = retrieved but dropped (squeezed out of a launch prompt
  // by the char budget, or left uncited by ask_expert). This is the signal that
  // tells a doc that rode into the prompt apart from one retrieved and discarded
  // — the "is knowledge improving" measure, folded into getRetrievalUsage.
  //
  // `launch_id` correlates an `inject`-surface row to the launch whose opening
  // prompt fed it — inject rows carry no session_id because the session does not
  // exist yet at prompt-build time — and is indexed for a per-launch read.
  //
  // Both columns are added by bare ALTER here (SQLite has no ADD COLUMN IF NOT
  // EXISTS) and mirrored by PRAGMA-guarded repairs in ensureSchemaRepairs, so an
  // aborted upgrade that recorded past 048 without a column still self-heals.
  `
  ALTER TABLE knowledge_retrievals ADD COLUMN injected INTEGER;
  ALTER TABLE knowledge_retrievals ADD COLUMN launch_id TEXT;
  CREATE INDEX IF NOT EXISTS idx_knowledge_retrievals_launch
    ON knowledge_retrievals(launch_id);
  `,

  // Migration 049: recency indexes for the last-activity ordering.
  //
  // getAllSessions and getActiveWork order roots by their latest activity — a
  // per-session MAX(created_at) over transcript_events and events. Both tables
  // key on (session_id, seq) with created_at unindexed, so that MAX scans every
  // row in the session's partition. getAllSessions is UNBOUNDED (all roots, all
  // history), so a composite (session_id, created_at) index turns each subquery
  // into a single seek to the partition's newest row. Purely additive.
  `
  CREATE INDEX IF NOT EXISTS idx_transcript_events_session_created
    ON transcript_events(session_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_events_session_created
    ON events(session_id, created_at);
  `,

  // Migration 050: Persona — the always-on orchestrator's durable state.
  //
  // persona_threads/persona_messages hold the owner's conversation (seq per
  // thread; an idempotency key dedupes a retried send). persona_inbox is the
  // wake queue the single-flight turn loop drains — `processing` rows are reset
  // to `pending` on boot so a crash mid-turn loses nothing. persona_state keeps
  // the resumable Claude session id and the epoch/handoff note that rotates it.
  // persona_jobs are the units of work Persona delegates; persona_job_launches
  // links each to the launches it started (the ownership edge the event router
  // keys on; `persona_plan_gate` records whether Persona itself asked for the
  // plan gate). persona_approvals are actions the policy engine held for the
  // owner. All timestamps are ISO-8601 strings.
  //
  // launches(session_id) is indexed because the event router resolves every
  // session frame to its launch (and from there to a Persona job). asks.gate
  // marks an ask raised by a server-side confirmation gate (e.g. the self-fix
  // launch) rather than by an agent, so Persona never answers one on the owner's
  // behalf; NULL for every ordinary ask.
  `
  CREATE TABLE IF NOT EXISTS persona_threads (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    channel TEXT NOT NULL DEFAULT 'console',
    external_ref TEXT,
    title TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_persona_threads_owner ON persona_threads(owner, channel);

  CREATE TABLE IF NOT EXISTS persona_messages (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'persona', 'system')),
    text TEXT NOT NULL,
    actor TEXT,
    options_json TEXT,
    job_ids_json TEXT,
    approval_id TEXT,
    idempotency_key TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (thread_id, seq)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_persona_messages_idem
    ON persona_messages(thread_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

  CREATE TABLE IF NOT EXISTS persona_inbox (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    kind TEXT NOT NULL,
    thread_id TEXT,
    payload_json TEXT NOT NULL,
    coalesce_key TEXT,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'processing', 'done', 'failed', 'cancelled')),
    attempts INTEGER NOT NULL DEFAULT 0,
    not_before TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    processed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_persona_inbox_due ON persona_inbox(owner, status, not_before);

  CREATE TABLE IF NOT EXISTS persona_state (
    owner TEXT PRIMARY KEY,
    paused INTEGER NOT NULL DEFAULT 0,
    claude_session_id TEXT,
    epoch INTEGER NOT NULL DEFAULT 1,
    last_context_tokens INTEGER,
    handoff_note TEXT,
    last_turn_at TEXT,
    last_error TEXT,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS persona_jobs (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    title TEXT NOT NULL,
    goal TEXT NOT NULL,
    acceptance TEXT,
    status TEXT NOT NULL DEFAULT 'active'
      CHECK (status IN ('active', 'waiting_user', 'done', 'failed', 'cancelled')),
    outcome TEXT,
    note TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_persona_jobs_owner ON persona_jobs(owner, status);

  CREATE TABLE IF NOT EXISTS persona_job_launches (
    job_id TEXT NOT NULL,
    launch_id TEXT NOT NULL,
    persona_plan_gate INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    PRIMARY KEY (job_id, launch_id)
  );
  CREATE INDEX IF NOT EXISTS idx_persona_job_launches_launch ON persona_job_launches(launch_id);

  CREATE TABLE IF NOT EXISTS persona_approvals (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    job_id TEXT,
    action TEXT NOT NULL,
    summary TEXT NOT NULL,
    reason TEXT,
    args_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    result TEXT,
    decided_by TEXT,
    created_at TEXT NOT NULL,
    decided_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_persona_approvals_owner ON persona_approvals(owner, status);

  CREATE INDEX IF NOT EXISTS idx_launches_session ON launches(session_id);
  ALTER TABLE asks ADD COLUMN gate TEXT;
  `,

  // Migration 051: Persona threads bound to an outside channel (Slack).
  //
  // A thread with an external_ref (a Slack DM channel or `<channel>:<thread_ts>`)
  // is unique per (owner, channel, external_ref), so two adapters racing to bind
  // the same Slack thread converge on one Persona thread; console threads carry
  // no ref and are unaffected. persona_approvals.thread_id records the thread
  // whose turn raised a held action, so a decision is reported where the
  // request came from.
  //
  // persona_threads.audience says who can read a thread's replies (private:
  // the owner alone — the console and DMs; shared / external: other people),
  // so Persona keeps private context out of the others. A non-private thread
  // runs on its own Claude session (persona_threads.claude_session_id), never
  // the owner's private one. The columns are added by bare ALTER and mirrored
  // by PRAGMA-guarded repairs in ensureSchemaRepairs.
  `
  CREATE UNIQUE INDEX IF NOT EXISTS idx_persona_threads_external_ref
    ON persona_threads(owner, channel, external_ref) WHERE external_ref IS NOT NULL;
  ALTER TABLE persona_approvals ADD COLUMN thread_id TEXT;
  ALTER TABLE persona_threads ADD COLUMN audience TEXT NOT NULL DEFAULT 'private';
  ALTER TABLE persona_threads ADD COLUMN claude_session_id TEXT;
  `,

];

/** A migration declared with its own version number (see VERSIONED_MIGRATIONS). */
export interface VersionedMigration {
  version: number;
  /** Applies the migration; SQL is run with `db.exec`. */
  apply: string | ((db: Database) => void);
  /** True for an entry of MIGRATIONS, whose version is its position. */
  positional?: boolean;
}

function migration(version: number, apply: VersionedMigration["apply"]): VersionedMigration {
  return { version, apply };
}

/**
 * Versions no migration may use: they are already recorded in schema_version on
 * some databases for work that is not the migration a new entry would carry.
 *  - 52: recorded by pre-release builds of the retrieval-observability
 *    migration (now 053) and by a parallel branch's work-in-progress build.
 * A taken version above every declared one is declared as a no-op migration
 * instead (see 097): the next migration is numbered one past the highest
 * declared version, so it never reuses a taken one.
 */
export const RESERVED_MIGRATION_VERSIONS: readonly number[] = [52];

/**
 * Migrations from 053 on, each declared with an explicit version. To add one,
 * pick the next number not used by MIGRATIONS (positional: entry i is version
 * i + 1), by any entry here, or by RESERVED_MIGRATION_VERSIONS — including
 * numbers a parallel branch has taken — and append `migration(<n>, …)`.
 * Versions need not be contiguous or in order: runMigrations applies every one
 * not yet recorded in schema_version, in ascending version order, so two
 * branches that each add a migration land in either order. The migrations test
 * fails on a duplicate or reserved version.
 *
 * Because a migration can arrive after higher-numbered ones have run, it must
 * be idempotent — check the current shape before each change (a column or
 * table present, a CHECK already widened) rather than assume the schema it was
 * written against: a database booted by an older build may already hold an
 * equivalent change made by that build's ensureSchemaRepairs.
 */
export const VERSIONED_MIGRATIONS: VersionedMigration[] = [
  // Migration 053: retrieval observability.
  //
  // knowledge_retrievals records WHY a doc was (or was not) returned, not only
  // that it was:
  //  - `components_json`: the hit's numeric score fields as the surface saw
  //    them (score, rawScore, relevance and any signal/component breakdown),
  //    so a row can be decoded after the ranking changes.
  //  - `algo_version`: the retrieval algorithm revision that produced the row
  //    (ALGO_VERSION in @standup/knowledge), so score history across a ranking
  //    change is never compared on one scale.
  //  - `raw_score` / `relevance`: the absolute relevance figures denormalized
  //    out of components_json for SQL reads.
  //  - `layer` / `source_kind` / `scope` / `doc_owner`: the doc's placement at
  //    retrieval time; `doc_owner` is the owner of a personal-layer doc, so a
  //    usage view shows that row only to its owner even after the doc is gone.
  //  - `drop_reason`: NULL for a hit the surface returned; otherwise the gate
  //    that held a retrieved candidate back (floor, verdict, freshness,
  //    origin, foreign-intent, personal, native-memory, cutoff) or `budget` for
  //    a result squeezed out of a launch prompt by the char budget.
  //  - surface `doc_get`: a get_knowledge_doc fetch of a doc's full body.
  // SQLite cannot widen a CHECK in place, so the table is rebuilt with every
  // row copied verbatim (ids included).
  //
  // expert_exchanges is persisted for every ask, not only an agent session's:
  // `session_id` becomes nullable (still a sessions FK when set), and each row
  // records whether the answer was `synthesized` or the raw-passage fallback
  // (`fallback_reason` says why), the `retrieved_json` set behind it (refs,
  // relevance, cited flag), and the asking `project` / `actor`.
  //
  // knowledge_changes gains `personal` / `owner_user`: a change to a
  // personal-layer doc is shown only to that doc's owner.
  //
  // A function rather than SQL: each step checks the current shape first, so
  // it is safe to re-run after a crash part-way through, and a rebuild copies
  // whichever columns the existing table has (an aborted earlier upgrade can
  // leave it short of some). ensureSchemaRepairs runs the same function, which
  // heals a database recorded past 053 in the old shape.
  migration(53, (db) => ensureRetrievalObservabilityShape(db)),

  // Migration 054: Persona's recurring schedules.
  //
  // persona_schedules holds a cron expression with the IANA timezone it is
  // read in (fixed at creation, so a later default change never shifts it),
  // what a run does (`wake_persona` with a note, or `launch_job` with a brief,
  // project, model and effort), the overlap and catch-up policies, and the
  // scheduler's bookkeeping: `next_run_at` (UTC ISO; NULL while paused) and
  // the last run's time and outcome.
  //
  // persona_schedule_runs is the run history. The partial unique index on
  // (schedule_id, scheduled_for) is what keeps a slot from firing twice:
  // the scheduler claims a slot by inserting its run, so a restarted or
  // overlapping collector that reaches the same slot finds it taken. Manual
  // runs carry no slot and are left out of the index.
  migration(
    54,
    `
  CREATE TABLE IF NOT EXISTS persona_schedules (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    thread_id TEXT,
    title TEXT NOT NULL,
    cron TEXT NOT NULL,
    timezone TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('wake_persona', 'launch_job')),
    note TEXT,
    brief TEXT,
    project_id TEXT,
    model TEXT,
    effort TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    overlap TEXT NOT NULL DEFAULT 'skip' CHECK (overlap IN ('skip', 'allow')),
    catch_up TEXT NOT NULL DEFAULT 'run_once' CHECK (catch_up IN ('run_once', 'skip')),
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    next_run_at TEXT,
    last_run_at TEXT,
    last_outcome TEXT,
    last_outcome_detail TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_persona_schedules_due
    ON persona_schedules(owner, enabled, next_run_at);

  CREATE TABLE IF NOT EXISTS persona_schedule_runs (
    id TEXT PRIMARY KEY,
    schedule_id TEXT NOT NULL REFERENCES persona_schedules(id) ON DELETE CASCADE,
    owner TEXT NOT NULL,
    scheduled_for TEXT NOT NULL,
    trigger TEXT NOT NULL CHECK (trigger IN ('cron', 'catch_up', 'manual')),
    status TEXT NOT NULL CHECK (status IN ('starting', 'running', 'done', 'failed', 'skipped')),
    reason TEXT,
    error TEXT,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    job_id TEXT,
    launch_id TEXT,
    session_id TEXT,
    inbox_id TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_persona_schedule_runs_slot
    ON persona_schedule_runs(schedule_id, scheduled_for) WHERE trigger != 'manual';
  CREATE INDEX IF NOT EXISTS idx_persona_schedule_runs_schedule
    ON persona_schedule_runs(schedule_id, started_at);
  CREATE INDEX IF NOT EXISTS idx_persona_schedule_runs_status
    ON persona_schedule_runs(owner, status);
  `
  ),

  // Migration 055: Persona's launch queue.
  //
  // A Persona launch past its daily budget or active cap is queued rather
  // than held for the owner: the row keeps the launch_session arguments, the
  // thread it was asked from and why it waits. Persona's runtime starts queued
  // rows oldest first as room frees (`queued` → `started`, with the launch and
  // job), or records why one could not start (`failed`). A schedule run that
  // queued carries its id, so its launch keeps the run's idempotency key.
  migration(
    55,
    `
  CREATE TABLE IF NOT EXISTS persona_launch_queue (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    thread_id TEXT,
    args_json TEXT NOT NULL,
    task TEXT NOT NULL,
    reason TEXT NOT NULL,
    schedule_run_id TEXT,
    status TEXT NOT NULL DEFAULT 'queued'
      CHECK (status IN ('queued', 'started', 'failed', 'cancelled')),
    error TEXT,
    launch_id TEXT,
    job_id TEXT,
    created_at TEXT NOT NULL,
    settled_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_persona_launch_queue_owner
    ON persona_launch_queue(owner, status, created_at);
  `
  ),

  // Migration 056: Persona preference signals.
  //
  // persona_signals records owner behaviour as structured events for the
  // preference miner (docs/design/persona-preference-miner.md): which quick
  // reply the owner tapped, how they decided a hold, and the Persona actions a
  // later correction can point at. `actor` is only ever the owner or the
  // system — worker text never becomes a signal, and the CHECK has no value
  // for it. `value_json` holds kind-specific structured fields, never free
  // text; `excerpt` and `vector` are for later kinds and stay NULL for now.
  // The kind CHECK lists every kind the design names, so later phases add
  // capture without rebuilding the table.
  //
  // persona_approvals.hold_rule is the structured id of the policy rule an
  // approval was held under (@standup/shared hold-rules), so holds are grouped
  // by rule rather than by their prose reason.
  //
  // persona_messages.recommended_option is the index of the option Persona
  // recommends on an ask_user question; options_json keeps its shape.
  //
  // A function rather than SQL: each step checks the current shape, so it is
  // safe after a crash part-way through, and ensureSchemaRepairs runs it too.
  migration(56, (db) => ensurePersonaSignalsShape(db)),
  // Migration 057: Persona's knowledge-draft decisions.
  //
  // Persona accepts or rejects pending knowledge drafts itself
  // (decide_knowledge_draft); each decision is recorded here with Persona's
  // reason, so the owner can audit what was published or dropped and the
  // preference miner can learn from the owner's later corrections. `mode`
  // says whether the draft was a new doc or replaced `target_slug`; `edited`
  // marks an accept whose body Persona rewrote first, and `edited_body` keeps
  // that text. FK-free like knowledge_changes, so a row outlives the draft
  // and any re-index of the doc.
  migration(
    57,
    `
  CREATE TABLE IF NOT EXISTS persona_knowledge_decisions (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    project_id TEXT NOT NULL,
    draft_slug TEXT NOT NULL,
    target_slug TEXT,
    title TEXT NOT NULL,
    decision TEXT NOT NULL CHECK (decision IN ('accept', 'reject')),
    mode TEXT NOT NULL CHECK (mode IN ('new', 'replace')),
    edited INTEGER NOT NULL DEFAULT 0,
    edited_body TEXT,
    reason TEXT NOT NULL,
    verdict TEXT,
    generated_by_launch_id TEXT,
    thread_id TEXT,
    job_id TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_persona_knowledge_decisions_owner
    ON persona_knowledge_decisions(owner, created_at);
  CREATE INDEX IF NOT EXISTS idx_persona_knowledge_decisions_doc
    ON persona_knowledge_decisions(project_id, draft_slug);
  `
  ),
  // Migration 058: images Persona attaches to its replies.
  //
  // persona_attachments has one row per image Persona attached in a turn
  // (attach_image). `sha256` names the stored copy under the data dir's
  // persona-attachments/ (content-addressed, so the same image attached twice
  // is stored once). A row is staged for its turn (`thread_id`, `batch_key`)
  // with `message_id` NULL, and claimed by the reply the turn posts; only a
  // claimed row is ever served. persona_messages.attachments_json keeps the
  // claimed rows' public fields, so reading a thread needs no join.
  //
  // A function rather than SQL: each step checks the current shape, so it is
  // safe after a crash part-way through, and ensureSchemaRepairs runs it too.
  migration(58, (db) => ensurePersonaAttachmentsShape(db)),
  // Migration 059: per-user Persona.
  //
  // persona_approvals.approver is who must decide a card; NULL means its
  // owner. A guest Persona's floor holds are cards it owns but the host
  // decides, so a decider's queue is `approver = alias OR (approver IS NULL
  // AND owner = alias)` (idx_persona_approvals_approver serves the first arm).
  //
  // asks.answered_by is who resolved an ask or a floor hold, for the audit.
  //
  // persona_user_access is the host's allowlist of projects a guest's Persona
  // may launch into, one row per guest alias. No row means no launches.
  //
  // A function rather than SQL: each step checks the current shape, so it is
  // safe after a crash part-way through, and ensureSchemaRepairs runs it too.
  // Additive only, so it never rebuilds a populated table.
  migration(59, (db) => ensurePersonaUserAccessShape(db)),
  // Migration 062: review packets.
  //
  // review_packets holds what a worker hands a human for sign-off on the
  // Review tab: the intent, change areas, validation, risks and links (JSON
  // columns, in the shapes of @standup/shared's ReviewPacketDraft). A packet
  // starts as a `draft`, becomes `pending` when submitted, and is decided
  // `approved` or `changes_requested`; submitting again for the same owner and
  // launch marks the earlier pending packet `superseded`. `revision` counts
  // submissions per (owner, launch_id).
  //
  // review_comments are the human's remarks (`decision` set when left with
  // one), the owner's questions and their answers (`kind`,
  // `reply_to`, `via`: ensureReviewPacketsShape); review_media are captioned images and videos, stored
  // content-addressed by `sha256` under the data dir. Both cascade with their
  // packet.
  //
  // launches.launched_by is who the collector itself resolved as launching a
  // launch (never a caller-named actor), and launches.review_token_hash the
  // sha256 of the launch's review token: together they say whose Review queue
  // a worker's packet lands in and that the worker is that launch's.
  //
  // steers.audience names the one user a Human Review steer's body is for
  // (its brief, or the owner's requested changes); NULL for an ordinary steer.
  //
  // review_packets.submitted_by_session is the session the collector resolved
  // as submitting the packet's latest revision, submitted_by_root whether it
  // was the launch's own root worker session (1) or not (0), and
  // resubmitted_from_other_session whether that revision came from a
  // different session than the launch's previous one.
  //
  // A function rather than SQL, like 059: each step checks the current shape,
  // and ensureSchemaRepairs runs it too.
  migration(62, (db) => ensureReviewPacketsShape(db)),
  // Migration 063: projects.related_json — the ids a project lists under
  // `related` in projects.toml (a JSON array), the projects that share its
  // product. NULL means none listed. Knowledge retrieval reads the relation
  // symmetrically, so only one side needs to list it.
  //
  // A function rather than SQL: it checks for the column first, so it is safe
  // after a crash part-way through, and ensureSchemaRepairs runs it too.
  migration(63, (db) => ensureProjectsRelatedColumn(db)),
  // Migration 064: knowledge.verdict_repo_path — the repository checkout the
  // doc's current fact-check verdict was produced against, so a verdict from a
  // repo outside the doc's project can be told apart from a genuine one. NULL
  // for a verdict with no checkout behind it (a contradiction, an
  // unverifiable note) or one recorded before the column existed.
  //
  // A function rather than SQL: KnowledgeStore creates the knowledge table, so
  // on a fresh database it may not exist yet (KnowledgeStore adds the column
  // itself then), and the column check makes it safe to re-run.
  migration(64, (db) => ensureKnowledgeVerdictRepoColumn(db)),

  // Migration 065: derived Persona job state.
  //
  // The facts a job's displayed state is derived from that no other table
  // holds: when and by whom it was set waiting_user (waiting_since,
  // waiting_source `persona` | `handoff`; for a hand-off, the session that
  // raised it and when it next ran: waiting_session_id, worker_resumed_at),
  // the unanswered ask_user question about it (open_ask_message_id,
  // open_ask_at), the owner's latest reply about it (owner_responded_at), and
  // when its note was last set (note_at). All times ISO-8601; NULL when
  // unknown. A waiting_user row from before the tracking is dated from its
  // updated_at, so a later owner reply answers it too.
  //
  // idx_persona_approvals_job serves the per-job approval counts every
  // served job now carries.
  migration(65, (db) => ensurePersonaJobStateShape(db)),

  // Migration 066: job tags on Persona messages.
  //
  // persona_message_jobs has one row per (message, job) tag, with how it was
  // made (`source`: explicit > declared > inferred) and the owner of the
  // message's thread. Its primary key (message_id, job_id) serves both a
  // message's tags and the thread view's job filter. It is authoritative for a
  // message's jobs; the message's job_ids_json keeps the ids it was created
  // with (minus any the owner removed). Every run backfills it from
  // job_ids_json as `explicit` tags, so a message written by a build that only
  // set job_ids_json gets its tags; a message whose thread is gone is skipped.
  //
  // A function rather than SQL: each step checks the current shape, so it is
  // safe after a crash part-way through, and ensureSchemaRepairs runs it too.
  migration(66, (db) => ensurePersonaMessageJobsShape(db)),

  // Migration 067: the delivery pipeline.
  //
  // pipeline_configs holds each owner's pipeline overrides (@standup/shared
  // PipelineOverride), one row per layer: `project_id` '' is the owner's
  // global layer, any other value that project's layer.
  //
  // pipeline_runs is one run per launch: the definition resolved when the
  // launch started (frozen, so a later config change never reshapes a run in
  // flight) with its hash, the stage the worker is in, the run status and why
  // it waits on the owner, the facts computed from the change, and how many
  // consecutive Stop hooks it has blocked; what a waiting run waits for, and
  // the Persona job it set waiting (restored when the run moves again).
  //
  // pipeline_stage_attempts records each advance of a stage: its outcome, the
  // evidence given, and the stage the run moved to — counting rows by
  // (stage_id, next_stage) is how a loop edge's traversals are bounded.
  //
  // A function rather than SQL so ensureSchemaRepairs can run it too.
  migration(67, (db) => ensurePipelineShape(db)),

  // Migration 068: the public knowledge API.
  //
  // projects.shareable — whether the project's knowledge is served to
  // teammates over the public knowledge API; 1 (shared) unless the owner turns
  // it off. public_kb_calls is the API's access log: one row per request, with
  // the caller's alias (NULL when the request carried none), the endpoint, the
  // query text truncated to 200 characters, and the response status.
  //
  // A function rather than SQL so ensureSchemaRepairs can run it too.
  migration(68, (db) => ensurePublicKnowledgeShape(db)),

  // Migration 069: owner media on Persona messages.
  //
  // persona_attachments.media_json holds what the collector derived from an
  // owner upload (@standup/store PersonaAttachmentMedia): image dimensions, a
  // video's duration and the content-addressed still frames extracted for
  // Persona, the re-encoded JPEG model copy of an image, and why something
  // couldn't be shown. NULL for Persona's own attach_image rows. An owner
  // upload is staged with batch_key `upload:<uuid>`, which no turn's batch key
  // matches, and claimed by the owner's message that carries it.
  //
  // persona_session_images counts the image blocks each Claude session of
  // Persona's has been sent and their base64 bytes (the API's per-request
  // image and size limits cover the whole resumed history), so a turn that
  // would take a session past its budget starts a fresh one. Rows of sessions
  // no thread or Persona state names any more are pruned.
  //
  // persona_media_shares records which stored files (an upload, its frames,
  // its model copy) Persona passed to which worker through mediaIds:
  // `session_id` is the worker's session, or `launch:<id>` for a launch whose
  // session wasn't known yet. A floor hold on a worker reading one of those
  // files carries the collector's word on whether it was passed to it.
  //
  // A function rather than SQL: each step checks the current shape, so it is safe
  // after a crash part-way through, and ensureSchemaRepairs runs it too — so a
  // database that already holds this shape (under any recorded version) just
  // converges.
  migration(69, (db) => ensurePersonaAttachmentsShape(db)),

  // Migration 070: review tunnels.
  //
  // review_tunnels records each HTTPS tunnel Standup opened to a launch's
  // branch build for review: the port and processes it holds while live, and
  // why it was torn down once closed. Partial unique indexes keep at most one
  // live tunnel per launch, port and name, so two openings can never share a
  // port.
  migration(70, (db) => ensureReviewTunnelShape(db)),

  // Migration 072: the owner's audit of safety-floor holds Persona allowed
  // once on its own (answer_ask with no owner card).
  //
  // persona_floor_decisions has one row per allow: the ask and session it
  // answered, the job and thread it was made for, the floor's gate and
  // category, the held call as the floor showed it, Persona's reason, and who
  // answered (asks.answered_by). Kept regardless of the preference-signal
  // capture setting: an allow posts nothing in the thread, so this is the
  // only record of its call and reason.
  migration(
    72,
    `
  CREATE TABLE IF NOT EXISTS persona_floor_decisions (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    ask_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    job_id TEXT,
    thread_id TEXT,
    gate TEXT NOT NULL,
    category TEXT,
    call TEXT NOT NULL,
    reason TEXT NOT NULL,
    decided_by TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_persona_floor_decisions_owner
    ON persona_floor_decisions(owner, created_at);
  CREATE INDEX IF NOT EXISTS idx_persona_floor_decisions_job
    ON persona_floor_decisions(owner, job_id, created_at);
  `
  ),

  // Migration 073: Persona's cost ledger and per-job budgets.
  //
  // persona_turns has one row per Persona turn that ran: whose Persona
  // (`user`), the thread it answered, the jobs it is attributed to (a JSON
  // array; a turn's cost is split evenly across them), when it started and
  // how long it took, the cost, tokens and model its result JSON reported
  // (NULL when it reported none), its kind (`turn` | `handoff`) and the epoch
  // it ran in. reported_cost_usd is the result's total_cost_usd as reported
  // and claude_session_id the Claude session it ran on: a resumed session can
  // report its running total, and cost_usd is then the difference from the
  // session's previous turn. persona_turn_jobs has one row per (turn, job) with the job's
  // share of the turn's cost, which is what a job's Persona spend sums.
  //
  // persona_jobs gains the job's own budget (budget_usd, budget_minutes; NULL
  // inherits the owner's layers, 0 means no limit), its workers' cost as last
  // read from their transcripts (worker_usd_cached, spent_at), and the budget
  // level last announced for it (budget_level `near` | `exceeded`, NULL
  // below; budget_level_at), so each threshold notice fires once. Jobs that
  // exist when the columns are added get no limit (0), not the default.
  // waiting_ms sums the job's finished waiting_user periods (kept by a
  // trigger on waiting_since), which its time budget leaves out.
  //
  // persona_budget_prefs is each owner's default budget, one row per layer:
  // `project_id` '' is the owner's global layer, any other value that
  // project's layer, which overrides it.
  //
  // A function rather than SQL so ensureSchemaRepairs can run it too. It is
  // explicitly versioned, so a database that already recorded 074 and 075
  // still runs it.
  migration(73, (db) => ensurePersonaBudgetShape(db)),

  // Migration 074: the small-decision port (collector/src/decider).
  //
  // user_decider_prefs holds each user's per-decision backend choices
  // (@standup/shared DeciderBackendPrefs as JSON), one row per alias.
  //
  // decider_decisions is the audit log: one row per decision with the backend
  // that answered, the backend it was routed to, its latency and confidence,
  // and why it fell back.
  migration(74, (db) => ensureDeciderShape(db)),

  // Migration 075: persona_floor_decisions.check_flag — the reason the
  // advisory second check flagged the allow (a consent the owner never gave,
  // a step the job never asked for, …). NULL when it flagged nothing, was
  // off, or the row predates the column. The flag never held the call.
  //
  // A function rather than SQL: it checks for the column first, so it is safe
  // after a crash part-way through, and ensureSchemaRepairs runs it too.
  migration(75, (db) => ensurePersonaFloorDecisionCheckColumn(db)),

  // Migration 076: Persona's commitments ledger — the open loops it owes.
  //
  // persona_commitments has one row per promised next step: who owes it
  // (`assignee`: persona, worker:<sessionId> or owner), the action, the
  // checkable condition that says it is done, and when it goes stale. It is
  // an unordered set, read sorted by staleness. A row closes `done` only with
  // evidence of how its done-check was verified, or `dropped` with a reason
  // (both in closed_evidence). `auto_key` marks a row the collector opened on
  // a transition (a review approved, a pipeline complete, a worker ask, an
  // install fast-forward); the partial unique index keeps one open row per
  // key. `nudged_at` is when the collector last woke Persona about the row
  // being overdue. `hold_message_id` is the ask_user question Persona
  // escalated the row with: the owner holds it until they reply.
  migration(
    76,
    `
  CREATE TABLE IF NOT EXISTS persona_commitments (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    thread_id TEXT,
    job_id TEXT,
    assignee TEXT NOT NULL,
    action TEXT NOT NULL,
    done_check TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    source TEXT NOT NULL DEFAULT 'persona',
    auto_key TEXT,
    opened_at TEXT NOT NULL,
    stale_after TEXT,
    closed_at TEXT,
    closed_evidence TEXT,
    nudged_at TEXT,
    hold_message_id TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_persona_commitments_open
    ON persona_commitments(owner, status, stale_after);
  CREATE INDEX IF NOT EXISTS idx_persona_commitments_job
    ON persona_commitments(owner, job_id, status);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_persona_commitments_auto_key
    ON persona_commitments(owner, auto_key) WHERE status = 'open' AND auto_key IS NOT NULL;
  `
  ),

  // Migration 077: knowledge_retrievals.latency_ms — the collector-side
  // wall-clock milliseconds of the request that recorded the row (sync,
  // retrieval and ranking), the same figure on every row of one search. NULL on
  // a surface that does not time itself and on rows that predate the column.
  //
  // A function rather than SQL: it checks for the column first, so it is safe
  // after a crash part-way through, and ensureSchemaRepairs runs it too.
  migration(77, (db) => ensureKnowledgeRetrievalLatencyColumn(db)),

  // Migration 078: knowledge_retrievals surfaces for hook pushes
  // (KNOWLEDGE_PUSH_SURFACES) — `push:<event>` for the docs a SessionStart,
  // UserPromptSubmit or first-edit PreToolUse hook put into an agent's context,
  // and `push:launch` for the push a Codex launch brief carries.
  //
  // SQLite cannot widen a CHECK in place, so the table is rebuilt with every
  // row copied verbatim (ids included). A function rather than SQL: it checks
  // the table's shape first, so it is a no-op once widened and safe to re-run
  // after a crash, and ensureSchemaRepairs runs it too.
  migration(78, (db) => ensureKnowledgeRetrievalPushSurfaces(db)),

  // Migration 079: sharing a review packet read-only by link.
  // review_packets.share_enabled is the owner's toggle; share_token is the
  // link's secret (32 random bytes, base64url), minted afresh each time
  // sharing is turned on and cleared when it is turned off; share_token_sha256
  // is its digest, which the public share routes look the packet up by.
  //
  // A function rather than SQL: it checks for the columns first, so it is safe
  // after a crash part-way through, and ensureSchemaRepairs runs it too.
  migration(79, (db) => ensureReviewShareColumns(db)),

  // Migration 080: docs, and share links for any shareable resource.
  //
  // share_grants holds every read-only share link: one row per token minted,
  // for a review packet or a doc, live while revoked_at is NULL. At most one
  // grant per resource is live (the partial unique index); turning sharing on
  // again revokes it and mints another, so an old link never comes back. A
  // review packet's live share in review_packets' share columns (079) moves
  // here with the same token and digest, so existing links keep working, and
  // those columns are cleared; nothing reads them after this.
  //
  // doc_folders / docs / doc_assets are each owner's tree of working
  // documents: folders nest (parent_id NULL is the root), a doc is a markdown
  // body with a revision bumped on every body or name change (the body is
  // kept as its UTF-8 bytes in a BLOB: SQLite drops a leading byte-order mark
  // from text bound as UTF-16, which is how bun:sqlite binds strings), and an asset is
  // an image whose bytes live in a content-addressed copy named by sha256.
  // Names are unique within a folder across all three kinds, which the query
  // layer enforces; the unique indexes back it within each kind.
  //
  // A function, like 079, so ensureSchemaRepairs can run it again.
  migration(80, (db) => ensureDocsAndShareGrants(db)),

  // Migration 081: worker hygiene. launches.reaped_at / reap_reason record a
  // launch whose idle worker was stopped (its row stays, so the job can resume
  // it); keep_alive exempts a launch from reaping; bypass_permissions holds the
  // launch request's bypass override (NULL = the project's default), which a
  // resumed worker's respawn reuses. launch_processes is the
  // registry of long-lived processes (a pid/pgid or a systemd unit) a worker
  // started, so they can be stopped when its job closes; stopped_at is set
  // once one is stopped or found gone.
  //
  // A function rather than SQL: it checks for the columns first, so it is safe
  // after a crash part-way through, and ensureSchemaRepairs runs it too.
  migration(81, (db) => ensureWorkerHygieneShape(db)),

  // Migration 082: the Board — one task card per Persona job, review ticket
  // or program backlog item, keyed by (source, source_id), whose column is
  // derived from the live state behind it (see board.ts in @standup/shared).
  // The collector's board adapter keeps the rows current; this migration
  // creates the table and backfills a card for every existing ticket and job
  // from its stored status alone, which the adapter refines as it reprojects.
  //
  // A function rather than SQL: the backfill reads only the tables that exist
  // and inserts with INSERT OR IGNORE, so re-running it adds nothing and never
  // overwrites a card the adapter has refined. ensureSchemaRepairs creates the
  // table (not the backfill) on every boot.
  migration(82, (db) => ensureBoardShape(db)),

  // Migration 083: each Persona question's own answered state.
  // persona_messages.answered_at is when a question with quick replies stopped
  // needing an answer (the owner answered it, Persona set it aside, or every
  // job it is about closed); NULL while it is open. Several questions can be
  // open in a thread at once, each keeping its quick replies until answered.
  //
  // Adding the column backfills it with the rule the console used before: a
  // question the thread owner's message followed, or whose jobs have all
  // closed, counts as answered.
  //
  // A function rather than SQL: it checks for the column first, so it is safe
  // after a crash part-way through, and ensureSchemaRepairs runs it too.
  migration(83, (db) => ensurePersonaQuestionAnsweredColumn(db)),

  // Migration 085: a doc folder can be shared by link, with everything below
  // it. share_grants.resource_type's CHECK widens to take 'folder'; what a
  // folder link reaches is worked out from the live tree on every request,
  // so nothing else is stored for it.
  //
  // SQLite cannot widen a CHECK in place, so the table is rebuilt with every
  // row copied verbatim. A function rather than SQL: it checks the table's
  // shape first, so it is a no-op once widened, and ensureSchemaRepairs runs
  // it too.
  migration(85, (db) => ensureShareGrantsFolderType(db)),

  // Migration 086: persona_messages.command_json — the slash command a message
  // ran or answers (its name, args and, on the result message, the result
  // card's data). NULL on every ordinary message.
  //
  // A function rather than SQL: it checks for the column first, so it is safe
  // to run after a higher-numbered migration, and ensureSchemaRepairs runs it too.
  migration(86, (db) => ensurePersonaCommandShape(db)),

  // Migration 088: two marks for telling a session's own process apart from
  // a guess.
  //  - sessions.end_reason: why a session's record was ended when no
  //    SessionEnd hook did it. 'stale': the reaper ended a monitored session
  //    for silence, a guess the process may outlive. NULL for every other end
  //    and for a live session.
  //  - sessions.revived_outside_launch: 1 when hooks revived the ended
  //    session while its launch could not be what sent them (the launch was
  //    not live, its hook-token proof was retired, or its pane was gone) — it
  //    was resumed by hand. NULL otherwise; every end clears it.
  //
  // A function rather than SQL: it checks for the columns first, so it is safe
  // to run after a higher-numbered migration, and ensureSchemaRepairs runs it too.
  migration(88, (db) => ensureSessionEndMarkColumns(db)),

  // Migration 089: doc_chunks — the Docs tab's semantic index, kept apart
  // from knowledge_chunks so a doc never reaches knowledge search. Each row is
  // one chunk of a doc's body as embedded at `revision` by `embedder` (the
  // provider, model, width and chunker it was embedded with); a doc whose rows
  // carry another revision or embedder is re-embedded. The rows go with
  // their doc (ON DELETE CASCADE). `id` is never reused (AUTOINCREMENT), so
  // the count and sum of a set of rows' ids move whenever the set does.
  migration(
    89,
    `CREATE TABLE IF NOT EXISTS doc_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      embedder TEXT NOT NULL,
      text TEXT NOT NULL,
      embedding BLOB NOT NULL,
      UNIQUE (doc_id, seq)
    );`
  ),

  // Migration 090: persona_messages.reply_to_id — on an owner's quick-reply
  // tap, the id of the Persona question whose option was tapped, so the turn
  // and a consent check know which question the tap answers. NULL on every
  // other message.
  //
  // A function rather than SQL: it checks for the column first, so it is safe
  // to run after a higher-numbered migration, and ensureSchemaRepairs runs it too.
  migration(90, (db) => ensurePersonaReplyToColumn(db)),

  // Migration 091: persona_messages_fts — a full-text index over Persona's
  // thread messages, for its search_thread tool. Kept in step by an insert
  // trigger (a message's text never changes and messages are never deleted).
  //
  // A function rather than SQL: it backfills only while the trigger is
  // missing and skips messages already indexed, so it is a no-op once run, and
  // ensureSchemaRepairs runs it too (rebuildTable drops a table's triggers).
  migration(91, (db) => ensurePersonaMessagesFts(db)),
  // Migration 096: shareable docs and folders, and comments on a doc's
  // passages (queries/doc-sharing.ts, queries/doc-comments.ts).
  //  - `docs.shareable` / `doc_folders.shareable`: the owner's flag that lets
  //    every signed-in user read the doc, or every doc in the folder and below.
  //  - `doc_comments`: a top-level row is a signed-in reader's comment, with
  //    its author, anchor and state; a row with a parent_id is a reply from
  //    the doc agent or the doc's owner.
  migration(96, (db) => ensureDocSharingShape(db)),

  // Migration 097: a no-op that keeps version 97 in use. A database may
  // already record 97, and there a later migration numbered 97 would never
  // run. It is declared rather than listed in RESERVED_MIGRATION_VERSIONS
  // because it is the highest version taken: LATEST_SCHEMA_VERSION and every
  // tool that numbers the next migration one past the last declared one see it.
  migration(97, "SELECT 1"),
];

/** Adds the shareable columns and creates doc_comments (migration 096). Idempotent. */
export function ensureDocSharingShape(db: Database): void {
  for (const table of ["docs", "doc_folders"]) {
    const columns = (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
    if (columns.length > 0 && !columns.includes("shareable")) db.exec(`ALTER TABLE ${table} ADD COLUMN shareable INTEGER NOT NULL DEFAULT 0`);
  }
  db.exec(`
  CREATE TABLE IF NOT EXISTS doc_comments (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    doc_id TEXT NOT NULL,
    parent_id TEXT,
    author TEXT NOT NULL,
    author_kind TEXT NOT NULL CHECK (author_kind IN ('reader', 'agent', 'owner')),
    body TEXT NOT NULL,
    quote TEXT NOT NULL DEFAULT '',
    prefix TEXT NOT NULL DEFAULT '',
    suffix TEXT NOT NULL DEFAULT '',
    state TEXT CHECK (state IN ('pending', 'answered', 'waiting')),
    from_doc INTEGER NOT NULL DEFAULT 0,
    agent_tried INTEGER NOT NULL DEFAULT 0,
    resolved_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_doc_comments_doc ON doc_comments(doc_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_doc_comments_author ON doc_comments(author, author_kind, created_at);
  CREATE INDEX IF NOT EXISTS idx_doc_comments_owner ON doc_comments(owner, author_kind, created_at);
  `);
  const commentColumns = (db.query("PRAGMA table_info(doc_comments)").all() as Array<{ name: string }>).map((c) => c.name);
  if (!commentColumns.includes("from_doc")) db.exec("ALTER TABLE doc_comments ADD COLUMN from_doc INTEGER NOT NULL DEFAULT 0");
  if (!commentColumns.includes("agent_tried")) db.exec("ALTER TABLE doc_comments ADD COLUMN agent_tried INTEGER NOT NULL DEFAULT 0");
}

/** Messages one transaction of the persona_messages_fts backfill copies. */
const PERSONA_MESSAGES_FTS_CHUNK = 2_000;

/**
 * Creates persona_messages_fts and its insert trigger. Like knowledge_fts it
 * is a standalone FTS5 table keyed on an UNINDEXED id, with the porter
 * stemmer. While the table or its trigger is missing (a new database, or a
 * trigger a table rebuild dropped) it first indexes every message not yet indexed, one
 * rowid chunk per transaction, and creates the trigger last — so a backfill
 * cut short resumes on the next boot. Idempotent.
 */
export function ensurePersonaMessagesFts(db: Database): void {
  const has = (type: string, name: string) => !!db.query("SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?").get(type, name);
  if (!has("table", "persona_messages")) return;
  const indexed = has("table", "persona_messages_fts");
  if (indexed && has("trigger", "persona_messages_fts_insert")) return;
  // The trigger writes to the table, so without the table every message insert would fail.
  db.exec("DROP TRIGGER IF EXISTS persona_messages_fts_insert");
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS persona_messages_fts USING fts5(
    message_id UNINDEXED, text, tokenize='porter unicode61'
  )`);
  // A new table holds nothing yet; only a kept one needs the already-indexed check.
  const unindexed = indexed ? " AND id NOT IN (SELECT message_id FROM persona_messages_fts)" : "";
  let after = 0;
  for (;;) {
    const last = db
      .query("SELECT MAX(rowid) AS r FROM (SELECT rowid FROM persona_messages WHERE rowid > ? ORDER BY rowid LIMIT ?)")
      .get(after, PERSONA_MESSAGES_FTS_CHUNK) as { r: number | null };
    if (last.r === null) break;
    db.run(
      `INSERT INTO persona_messages_fts (message_id, text)
       SELECT id, text FROM persona_messages
        WHERE rowid > ? AND rowid <= ?${unindexed}`,
      [after, last.r]
    );
    after = last.r;
  }
  db.exec(`CREATE TRIGGER persona_messages_fts_insert AFTER INSERT ON persona_messages BEGIN
    INSERT INTO persona_messages_fts (message_id, text) VALUES (new.id, new.text);
  END`);
}

/** Adds persona_messages.reply_to_id where missing. Idempotent. */
export function ensurePersonaReplyToColumn(db: Database): void {
  const columns = (db.query("PRAGMA table_info(persona_messages)").all() as Array<{ name: string }>).map((c) => c.name);
  if (columns.length > 0 && !columns.includes("reply_to_id")) {
    db.exec("ALTER TABLE persona_messages ADD COLUMN reply_to_id TEXT");
  }
}

/** Adds sessions.end_reason and sessions.revived_outside_launch where missing. Idempotent. */
export function ensureSessionEndMarkColumns(db: Database): void {
  const columns = (db.query("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).map((c) => c.name);
  if (columns.length > 0 && !columns.includes("end_reason")) {
    db.exec("ALTER TABLE sessions ADD COLUMN end_reason TEXT");
  }
  if (columns.length > 0 && !columns.includes("revived_outside_launch")) {
    db.exec("ALTER TABLE sessions ADD COLUMN revived_outside_launch INTEGER");
  }
}

/** Adds persona_messages.command_json where missing. Idempotent. */
export function ensurePersonaCommandShape(db: Database): void {
  const columns = (db.query("PRAGMA table_info(persona_messages)").all() as Array<{ name: string }>).map((c) => c.name);
  if (columns.length > 0 && !columns.includes("command_json")) {
    db.exec("ALTER TABLE persona_messages ADD COLUMN command_json TEXT");
  }
}

/** Widens share_grants.resource_type's CHECK to every SHARE_GRANT_RESOURCE_TYPES value where it is narrower. Idempotent. */
export function ensureShareGrantsFolderType(db: Database): void {
  const table = db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'share_grants'").get() as { sql: string } | null;
  if (!table || SHARE_GRANT_RESOURCE_TYPES.every((t) => table.sql.includes(`'${t}'`))) return;
  rebuildTable(db, "share_grants", shareGrantsTableSql, SHARE_GRANTS_INDEXES_SQL);
}

/** Adds launches' reap/keep-alive/bypass columns and the launch_processes table where missing. Idempotent. */
export function ensureWorkerHygieneShape(db: Database): void {
  const columns = (db.query("PRAGMA table_info(launches)").all() as Array<{ name: string }>).map((c) => c.name);
  if (columns.length > 0) {
    if (!columns.includes("reaped_at")) db.exec("ALTER TABLE launches ADD COLUMN reaped_at TEXT");
    if (!columns.includes("reap_reason")) db.exec("ALTER TABLE launches ADD COLUMN reap_reason TEXT");
    if (!columns.includes("keep_alive")) db.exec("ALTER TABLE launches ADD COLUMN keep_alive INTEGER NOT NULL DEFAULT 0");
    if (!columns.includes("bypass_permissions")) db.exec("ALTER TABLE launches ADD COLUMN bypass_permissions INTEGER");
  }
  db.exec(`
  CREATE TABLE IF NOT EXISTS launch_processes (
    id TEXT PRIMARY KEY,
    launch_id TEXT NOT NULL,
    job_id TEXT,
    kind TEXT NOT NULL CHECK (kind IN ('pid', 'unit')),
    pid INTEGER,
    pgid INTEGER,
    unit TEXT,
    label TEXT NOT NULL,
    port INTEGER,
    args_fingerprint TEXT,
    registered_at TEXT NOT NULL DEFAULT (datetime('now')),
    stopped_at TEXT,
    stop_reason TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_launch_processes_launch ON launch_processes(launch_id);
  CREATE INDEX IF NOT EXISTS idx_launch_processes_job ON launch_processes(job_id);
  `);
}

const BOARD_TASKS_SQL = `
  CREATE TABLE IF NOT EXISTS board_tasks (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL CHECK (source IN ('job', 'ticket', 'backlog')),
    source_id TEXT NOT NULL,
    project_id TEXT,
    title TEXT NOT NULL,
    goal TEXT,
    status TEXT NOT NULL
      CHECK (status IN ('queued', 'coding', 'validation', 'live_check', 'in_review', 'waiting', 'done', 'failed')),
    flag TEXT,
    stage TEXT,
    waiting_on TEXT,
    links_json TEXT NOT NULL DEFAULT '{}',
    areas_json TEXT NOT NULL DEFAULT '{"files":[],"packages":[]}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    closed_at TEXT,
    UNIQUE (source, source_id)
  );
  CREATE INDEX IF NOT EXISTS idx_board_tasks_owner ON board_tasks(owner, status);
  CREATE INDEX IF NOT EXISTS idx_board_tasks_project ON board_tasks(project_id);
`;

/** Creates board_tasks and its indexes where missing. Idempotent. */
export function ensureBoardTable(db: Database): void {
  db.exec(BOARD_TASKS_SQL);
}

/** board_tasks, backfilled with a card for every ticket and Persona job that has none. Idempotent. */
export function ensureBoardShape(db: Database): void {
  ensureBoardTable(db);
  backfillBoardTasks(db);
}

/** A stored time as ISO-8601 UTC: SQLite's `YYYY-MM-DD HH:MM:SS` and ISO strings alike, else `$now`. */
function sqlIso(expr: string): string {
  return `COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', ${expr}), ${expr}, $now)`;
}

/**
 * Inserts a card for each ticket and Persona job without one, set-based. The
 * column mirrors ticketBoardStatus / jobStatusBoardStatus in @standup/shared
 * — the stored status alone. Tickets are team-wide (owner ""), as the Tickets
 * board is; a job's card is its owner's, in the project of its first launch.
 */
function backfillBoardTasks(db: Database): void {
  const tables = new Set(
    (db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name)
  );
  const params = { $now: new Date().toISOString() };
  const emptyAreas = `'{"files":[],"packages":[]}'`;
  if (tables.has("tickets")) {
    db.query(
      `INSERT OR IGNORE INTO board_tasks
         (id, owner, source, source_id, project_id, title, goal, status, flag, stage, waiting_on,
          links_json, areas_json, created_at, updated_at, closed_at)
       SELECT 'ticket:' || t.id, '', 'ticket', t.id, t.project_id, t.title, NULLIF(t.body, ''),
         CASE t.status
           WHEN 'proposed' THEN 'queued' WHEN 'approved' THEN 'queued' WHEN 'developing' THEN 'coding'
           WHEN 'needs_review' THEN 'in_review' WHEN 'shipped' THEN 'done' ELSE 'failed' END,
         CASE t.status WHEN 'dismissed' THEN 'cancelled' END,
         NULL,
         CASE t.status WHEN 'proposed' THEN 'owner approval' WHEN 'needs_review' THEN 'owner review' END,
         json_patch(json_patch(json_patch(json_object('ticketId', t.id),
           CASE WHEN t.launch_id IS NOT NULL THEN json_object('launchIds', json_array(t.launch_id)) ELSE '{}' END),
           CASE WHEN t.session_id IS NOT NULL THEN json_object('sessionIds', json_array(t.session_id)) ELSE '{}' END),
           CASE WHEN COALESCE(t.review_url, '') != '' THEN json_object('codeReview', json_object('url', t.review_url)) ELSE '{}' END),
         ${emptyAreas},
         ${sqlIso("t.created_at")},
         ${sqlIso("t.updated_at")},
         CASE t.status
           WHEN 'shipped' THEN ${sqlIso("COALESCE(t.shipped_at, t.updated_at)")}
           WHEN 'dismissed' THEN ${sqlIso("COALESCE(t.dismissed_at, t.updated_at)")} END
       FROM tickets t`
    ).run(params);
  }
  if (tables.has("persona_jobs")) {
    const project =
      tables.has("persona_job_launches") && tables.has("launches")
        ? `(SELECT l.project_id FROM persona_job_launches pjl JOIN launches l ON l.id = pjl.launch_id
             WHERE pjl.job_id = j.id ORDER BY pjl.created_at, pjl.rowid LIMIT 1)`
        : "NULL";
    db.query(
      `INSERT OR IGNORE INTO board_tasks
         (id, owner, source, source_id, project_id, title, goal, status, flag, stage, waiting_on,
          links_json, areas_json, created_at, updated_at, closed_at)
       SELECT 'job:' || j.id, j.owner, 'job', j.id, ${project}, j.title, NULLIF(j.goal, ''),
         CASE j.status
           WHEN 'waiting_user' THEN 'waiting' WHEN 'done' THEN 'done' WHEN 'failed' THEN 'failed'
           WHEN 'cancelled' THEN 'failed' ELSE 'queued' END,
         CASE j.status WHEN 'cancelled' THEN 'cancelled' END,
         NULL,
         CASE j.status WHEN 'waiting_user' THEN 'the owner' END,
         json_object('jobId', j.id),
         ${emptyAreas},
         ${sqlIso("j.created_at")},
         ${sqlIso("j.updated_at")},
         CASE WHEN j.status IN ('done', 'failed', 'cancelled') THEN ${sqlIso("j.updated_at")} END
       FROM persona_jobs j`
    ).run(params);
  }
}

/**
 * Creates share_grants and the doc tables where missing, and moves any live
 * review share still held in review_packets' columns into a grant with the
 * same token. Idempotent.
 */
export function ensureDocsAndShareGrants(db: Database): void {
  db.exec(shareGrantsTableSql("share_grants", true));
  db.exec(SHARE_GRANTS_INDEXES_SQL);
  db.exec(`
  CREATE TABLE IF NOT EXISTS doc_folders (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    parent_id TEXT REFERENCES doc_folders(id),
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_doc_folders_name
    ON doc_folders(owner, COALESCE(parent_id, ''), name);

  CREATE TABLE IF NOT EXISTS docs (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    folder_id TEXT REFERENCES doc_folders(id),
    name TEXT NOT NULL,
    body BLOB NOT NULL DEFAULT X'',
    revision INTEGER NOT NULL DEFAULT 1,
    bytes INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_docs_name ON docs(owner, COALESCE(folder_id, ''), name);

  CREATE TABLE IF NOT EXISTS doc_assets (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    folder_id TEXT REFERENCES doc_folders(id),
    name TEXT NOT NULL,
    mime TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_doc_assets_name ON doc_assets(owner, COALESCE(folder_id, ''), name);
  CREATE INDEX IF NOT EXISTS idx_doc_assets_sha ON doc_assets(sha256);
  `);

  const columns = (db.query("PRAGMA table_info(review_packets)").all() as Array<{ name: string }>).map((c) => c.name);
  if (!["share_enabled", "share_token", "share_token_sha256"].every((c) => columns.includes(c))) return;
  const move = db.transaction(() => {
    const live = db
      .query(
        `SELECT id, owner, share_token FROM review_packets
          WHERE share_enabled = 1 AND share_token IS NOT NULL`
      )
      .all() as Array<{ id: string; owner: string; share_token: string }>;
    const at = new Date().toISOString();
    for (const row of live) {
      // A packet that already has a live grant keeps it; the column copy is dropped either way.
      db.run(
        `INSERT OR IGNORE INTO share_grants (id, resource_type, resource_id, owner, token, token_sha256, created_at)
         VALUES (?, 'review', ?, ?, ?, ?, ?)`,
        [randomUUID(), row.id, row.owner, row.share_token, createHash("sha256").update(row.share_token).digest("hex"), at]
      );
    }
    db.run(
      `UPDATE review_packets SET share_enabled = 0, share_token = NULL, share_token_sha256 = NULL
        WHERE share_enabled != 0 OR share_token IS NOT NULL OR share_token_sha256 IS NOT NULL`
    );
  });
  move();
}

/** Adds persona_messages.answered_at where missing and backfills it. Idempotent. */
export function ensurePersonaQuestionAnsweredColumn(db: Database): void {
  const columns = (db.query("PRAGMA table_info(persona_messages)").all() as Array<{ name: string }>).map((c) => c.name);
  if (columns.length === 0 || columns.includes("answered_at")) return;
  // A slash command the owner ran (command_json, migration 086) is no reply.
  const notCommand = columns.includes("command_json") ? " AND r.command_json IS NULL" : "";
  db.transaction(() => {
    db.exec("ALTER TABLE persona_messages ADD COLUMN answered_at TEXT");
    db.exec(`
      UPDATE persona_messages AS m
         SET answered_at = (SELECT MIN(r.created_at) FROM persona_messages r
                              JOIN persona_threads t ON t.id = r.thread_id
                             WHERE r.thread_id = m.thread_id AND r.role = 'user' AND r.seq > m.seq
                               AND r.actor = t.owner${notCommand})
       WHERE m.role = 'persona' AND m.options_json IS NOT NULL`);
    const tagTable = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'persona_message_jobs'").get();
    const jobTable = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'persona_jobs'").get();
    if (tagTable && jobTable) {
      db.exec(`
        UPDATE persona_messages AS m SET answered_at = m.created_at
         WHERE m.role = 'persona' AND m.options_json IS NOT NULL AND m.answered_at IS NULL
           AND EXISTS (SELECT 1 FROM persona_message_jobs t WHERE t.message_id = m.id)
           AND NOT EXISTS (SELECT 1 FROM persona_message_jobs t JOIN persona_jobs j ON j.id = t.job_id
                            WHERE t.message_id = m.id AND j.status IN ('active', 'waiting_user'))`);
    }
    if (jobTable) {
      // A job's open question that now counts as answered is no longer one:
      // an open job moves on to its newest question still open, if any.
      const released = db
        .query(
          `UPDATE persona_jobs SET open_ask_message_id = NULL, open_ask_at = NULL
            WHERE open_ask_message_id IN (SELECT id FROM persona_messages WHERE answered_at IS NOT NULL)
           RETURNING id`
        )
        .all() as Array<{ id: string }>;
      if (tagTable && released.length > 0) {
        db.run(
          `WITH newest AS (
            SELECT t.job_id, m.id, m.created_at,
                   ROW_NUMBER() OVER (PARTITION BY t.job_id ORDER BY m.created_at DESC, m.seq DESC) AS n
              FROM persona_messages m JOIN persona_message_jobs t ON t.message_id = m.id
             WHERE m.role = 'persona' AND m.options_json IS NOT NULL AND m.answered_at IS NULL)
          UPDATE persona_jobs
             SET open_ask_message_id = newest.id, open_ask_at = newest.created_at
            FROM newest
           WHERE newest.job_id = persona_jobs.id AND newest.n = 1
             AND persona_jobs.status IN ('active', 'waiting_user')
             AND persona_jobs.id IN (SELECT value FROM json_each(?))`,
          [JSON.stringify(released.map((r) => r.id))]
        );
      }
    }
  })();
}

/** Adds review_packets' share columns and their lookup index where missing. Idempotent. */
export function ensureReviewShareColumns(db: Database): void {
  const columns = (db.query("PRAGMA table_info(review_packets)").all() as Array<{ name: string }>).map((c) => c.name);
  if (columns.length === 0) return;
  if (!columns.includes("share_enabled")) {
    db.exec("ALTER TABLE review_packets ADD COLUMN share_enabled INTEGER NOT NULL DEFAULT 0");
  }
  if (!columns.includes("share_token")) db.exec("ALTER TABLE review_packets ADD COLUMN share_token TEXT");
  if (!columns.includes("share_token_sha256")) db.exec("ALTER TABLE review_packets ADD COLUMN share_token_sha256 TEXT");
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_review_packets_share_token ON review_packets(share_token_sha256) WHERE share_token_sha256 IS NOT NULL"
  );
}

/** Rebuilds knowledge_retrievals where its surface CHECK predates the push surfaces. Idempotent. */
export function ensureKnowledgeRetrievalPushSurfaces(db: Database): void {
  const table = db
    .query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'knowledge_retrievals'")
    .get() as { sql: string } | null;
  if (!table || KNOWLEDGE_PUSH_SURFACES.every((s) => table.sql.includes(`'${s}'`))) return;
  rebuildTable(db, "knowledge_retrievals", knowledgeRetrievalsTableSql, KNOWLEDGE_RETRIEVALS_INDEXES_SQL);
}

/** Adds knowledge_retrievals.latency_ms where the table exists without it. Idempotent. */
export function ensureKnowledgeRetrievalLatencyColumn(db: Database): void {
  const columns = (db.query("PRAGMA table_info(knowledge_retrievals)").all() as Array<{ name: string }>).map(
    (c) => c.name
  );
  if (columns.length > 0 && !columns.includes("latency_ms")) {
    db.exec("ALTER TABLE knowledge_retrievals ADD COLUMN latency_ms INTEGER");
  }
}

/** Adds persona_floor_decisions.check_flag where the table exists without it. Idempotent. */
export function ensurePersonaFloorDecisionCheckColumn(db: Database): void {
  const columns = (db.query("PRAGMA table_info(persona_floor_decisions)").all() as Array<{ name: string }>).map((c) => c.name);
  if (columns.length > 0 && !columns.includes("check_flag")) {
    db.exec("ALTER TABLE persona_floor_decisions ADD COLUMN check_flag TEXT");
  }
}

/** Adds projects.shareable and creates the public_kb_calls log where missing. Idempotent. */
export function ensurePublicKnowledgeShape(db: Database): void {
  const columns = (db.query("PRAGMA table_info(projects)").all() as Array<{ name: string }>).map((c) => c.name);
  if (columns.length > 0 && !columns.includes("shareable")) {
    db.exec("ALTER TABLE projects ADD COLUMN shareable INTEGER NOT NULL DEFAULT 1");
  }
  db.exec(`
  CREATE TABLE IF NOT EXISTS public_kb_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    alias TEXT,
    endpoint TEXT NOT NULL,
    query TEXT,
    status INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_public_kb_calls_at ON public_kb_calls(at);
  `);
}

/** Creates review_tunnels and its live-row indexes where missing. Idempotent. */
export function ensureReviewTunnelShape(db: Database): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS review_tunnels (
    id TEXT PRIMARY KEY,
    launch_id TEXT NOT NULL,
    run_id TEXT,
    job_id TEXT,
    owner TEXT NOT NULL,
    project_id TEXT,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    port INTEGER NOT NULL,
    serve_pid INTEGER,
    tunnel_pid INTEGER,
    status TEXT NOT NULL CHECK (status IN ('opening', 'open', 'closed', 'failed')),
    error TEXT,
    close_reason TEXT,
    stop_unverified INTEGER NOT NULL DEFAULT 0,
    opened_at TEXT,
    expires_at TEXT,
    closed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_review_tunnels_live_port ON review_tunnels(port) WHERE status IN ('opening', 'open');
  CREATE UNIQUE INDEX IF NOT EXISTS idx_review_tunnels_live_name ON review_tunnels(name) WHERE status IN ('opening', 'open');
  CREATE UNIQUE INDEX IF NOT EXISTS idx_review_tunnels_live_launch ON review_tunnels(launch_id) WHERE status IN ('opening', 'open');
  CREATE INDEX IF NOT EXISTS idx_review_tunnels_launch ON review_tunnels(launch_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_review_tunnels_status ON review_tunnels(status);
  `);
  // stop_unverified marks a closed tunnel whose processes couldn't be checked
  // when it closed (ps failed), so a later sweep or reconcile retries that stop.
  const columns = (db.query("PRAGMA table_info(review_tunnels)").all() as Array<{ name: string }>).map((c) => c.name);
  if (!columns.includes("stop_unverified")) db.exec("ALTER TABLE review_tunnels ADD COLUMN stop_unverified INTEGER NOT NULL DEFAULT 0");
}

/** Creates the decider tables (migration 074). Idempotent. */
export function ensureDeciderShape(db: Database): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS user_decider_prefs (
    alias TEXT PRIMARY KEY,
    backends_json TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS decider_decisions (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    backend TEXT NOT NULL,
    routed_to TEXT NOT NULL,
    choice TEXT,
    confidence REAL,
    latency_ms INTEGER NOT NULL,
    fallback_reason TEXT,
    detail TEXT,
    alias TEXT,
    session_id TEXT,
    launch_id TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_decider_decisions_created ON decider_decisions(created_at);
  CREATE INDEX IF NOT EXISTS idx_decider_decisions_alias ON decider_decisions(alias, created_at);
  `);
}

/** Creates persona_turns and persona_budget_prefs and adds the persona_jobs budget columns where missing. Idempotent. */
export function ensurePersonaBudgetShape(db: Database): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS persona_turns (
    id TEXT PRIMARY KEY,
    user TEXT NOT NULL,
    thread_id TEXT,
    job_ids_json TEXT NOT NULL DEFAULT '[]',
    kind TEXT NOT NULL DEFAULT 'turn',
    ok INTEGER NOT NULL DEFAULT 1,
    started_at TEXT NOT NULL,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL,
    input_tokens INTEGER,
    output_tokens INTEGER,
    model TEXT,
    epoch INTEGER,
    claude_session_id TEXT,
    reported_cost_usd REAL
  );
  CREATE INDEX IF NOT EXISTS idx_persona_turns_user ON persona_turns(user, started_at);

  CREATE TABLE IF NOT EXISTS persona_turn_jobs (
    turn_id TEXT NOT NULL,
    job_id TEXT NOT NULL,
    share_usd REAL,
    PRIMARY KEY (turn_id, job_id)
  );
  CREATE INDEX IF NOT EXISTS idx_persona_turn_jobs_job ON persona_turn_jobs(job_id);

  CREATE TABLE IF NOT EXISTS persona_budget_prefs (
    alias TEXT NOT NULL,
    project_id TEXT NOT NULL DEFAULT '',
    budget_usd REAL,
    budget_minutes REAL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (alias, project_id)
  );
  `);
  const turnColumns = (db.query("PRAGMA table_info(persona_turns)").all() as Array<{ name: string }>).map((c) => c.name);
  for (const [column, type] of [
    ["claude_session_id", "TEXT"],
    ["reported_cost_usd", "REAL"],
  ] as const) {
    if (!turnColumns.includes(column)) db.exec(`ALTER TABLE persona_turns ADD COLUMN ${column} ${type}`);
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_persona_turns_session ON persona_turns(claude_session_id, started_at)");
  const have = (db.query("PRAGMA table_info(persona_jobs)").all() as Array<{ name: string }>).map((c) => c.name);
  if (have.length === 0) return;
  const addingBudgets = !have.includes("budget_usd");
  // One transaction, so a crash can't leave the columns added without the
  // backfill below (a re-run would then skip it).
  db.transaction(() => {
    for (const [column, type] of [
      ["budget_usd", "REAL"],
      ["budget_minutes", "REAL"],
      ["worker_usd_cached", "REAL"],
      ["spent_at", "TEXT"],
      ["budget_level", "TEXT"],
      ["budget_level_at", "TEXT"],
      ["waiting_ms", "REAL"],
    ] as const) {
      if (!have.includes(column)) db.exec(`ALTER TABLE persona_jobs ADD COLUMN ${column} ${type}`);
    }
    // Jobs opened before budgets existed get no limit rather than the default:
    // a long-open job would otherwise be over its budget the moment this lands
    // and its workers asked to stop with no notice.
    if (addingBudgets) db.exec("UPDATE persona_jobs SET budget_usd = 0, budget_minutes = 0");
  })();
  // Time a job spends waiting on the owner doesn't count against its time
  // budget: each waiting period is added to waiting_ms when it ends, whichever
  // write ends it.
  const columns = (db.query("PRAGMA table_info(persona_jobs)").all() as Array<{ name: string }>).map((c) => c.name);
  if (!columns.includes("waiting_since")) return;
  db.exec(`
  CREATE TRIGGER IF NOT EXISTS persona_jobs_waiting_ms
  AFTER UPDATE OF waiting_since ON persona_jobs
  WHEN OLD.waiting_since IS NOT NULL AND (NEW.waiting_since IS NULL OR NEW.waiting_since != OLD.waiting_since)
  BEGIN
    UPDATE persona_jobs
       SET waiting_ms = COALESCE(waiting_ms, 0) + MAX(0, (julianday('now') - julianday(OLD.waiting_since)) * 86400000)
     WHERE id = NEW.id;
  END;
  `);
}

/**
 * Adds the persona_jobs columns and the approvals index migration 065
 * introduces where missing, and the job's pipeline layer
 * (pipeline_override_json). Idempotent.
 */
export function ensurePersonaJobStateShape(db: Database): void {
  const have = (db.query("PRAGMA table_info(persona_jobs)").all() as Array<{ name: string }>).map((c) => c.name);
  if (have.length === 0) return;
  for (const column of [
    "waiting_since",
    "waiting_source",
    "waiting_session_id",
    "worker_resumed_at",
    "open_ask_message_id",
    "open_ask_at",
    "owner_responded_at",
    "note_at",
    "pipeline_override_json",
  ]) {
    if (!have.includes(column)) db.exec(`ALTER TABLE persona_jobs ADD COLUMN ${column} TEXT`);
  }
  db.exec(`UPDATE persona_jobs SET waiting_since = updated_at, waiting_source = 'persona'
            WHERE status = 'waiting_user' AND waiting_since IS NULL`);
  const approvals = (db.query("PRAGMA table_info(persona_approvals)").all() as Array<{ name: string }>).length > 0;
  if (approvals) db.exec("CREATE INDEX IF NOT EXISTS idx_persona_approvals_job ON persona_approvals(job_id, status)");
}

/** Adds knowledge.verdict_repo_path where the table exists without it. Idempotent. */
export function ensureKnowledgeVerdictRepoColumn(db: Database): void {
  const columns = (db.query("PRAGMA table_info(knowledge)").all() as Array<{ name: string }>).map((c) => c.name);
  if (columns.length > 0 && !columns.includes("verdict_repo_path")) {
    db.exec("ALTER TABLE knowledge ADD COLUMN verdict_repo_path TEXT");
  }
}

/** Adds projects.related_json where missing. Idempotent. */
export function ensureProjectsRelatedColumn(db: Database): void {
  const columns = (db.query("PRAGMA table_info(projects)").all() as Array<{ name: string }>).map((c) => c.name);
  if (columns.length > 0 && !columns.includes("related_json")) {
    db.exec("ALTER TABLE projects ADD COLUMN related_json TEXT");
  }
}

/**
 * Per-user notification routing. Applied from ensureSchemaRepairs rather than
 * as a numbered migration, so it composes with migrations other branches
 * append. Idempotent.
 *
 * notify_prefs: each user's notification layers, like pipeline_configs —
 * project_id '' is the user's global layer, any other value their layer for
 * that project.
 *
 * persona_messages.notify_json: how a Persona message was routed (its update
 * kind and channels), so a Slack bridge replaying the thread routes it the
 * same way.
 *
 * persona_brief_runs: one row per user per brief slot, written before the
 * brief is assembled, so a slot fires at most once across restarts. A
 * brief handed to Persona is `queued` until its reply posts (`sent`) or it
 * replies silent.
 */
export function ensureNotifyShape(db: Database): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS notify_prefs (
    owner TEXT NOT NULL,
    project_id TEXT NOT NULL DEFAULT '',
    override_json TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (owner, project_id)
  );
  CREATE TABLE IF NOT EXISTS persona_brief_runs (
    owner TEXT NOT NULL,
    slot TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued', 'sent', 'silent', 'skipped')),
    inbox_id TEXT,
    detail TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (owner, slot)
  );`);
  const columns = (db.query("PRAGMA table_info(persona_messages)").all() as Array<{ name: string }>).map((c) => c.name);
  if (columns.length > 0 && !columns.includes("notify_json")) {
    db.exec("ALTER TABLE persona_messages ADD COLUMN notify_json TEXT");
  }
}

/** Creates the delivery-pipeline tables where missing. Idempotent. */
export function ensurePipelineShape(db: Database): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS pipeline_configs (
    owner TEXT NOT NULL,
    project_id TEXT NOT NULL DEFAULT '',
    override_json TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (owner, project_id)
  );
  CREATE TABLE IF NOT EXISTS pipeline_runs (
    id TEXT PRIMARY KEY,
    launch_id TEXT NOT NULL UNIQUE,
    owner TEXT NOT NULL,
    project_id TEXT,
    definition_json TEXT NOT NULL,
    definition_hash TEXT NOT NULL,
    current_stage TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'waiting_user', 'complete', 'disabled')),
    waiting_reason TEXT,
    facts_json TEXT NOT NULL DEFAULT '{}',
    stop_blocks INTEGER NOT NULL DEFAULT 0,
    stage_entered_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_pipeline_runs_owner ON pipeline_runs(owner, status);
  CREATE TABLE IF NOT EXISTS pipeline_stage_attempts (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
    stage_id TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('passed', 'failed', 'skipped', 'waived')),
    evidence_json TEXT,
    reason TEXT,
    session_id TEXT,
    next_stage TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_pipeline_attempts_run ON pipeline_stage_attempts(run_id, created_at);
  `);
  // waiting_kind says what a waiting run waits for (owner_input | exhausted |
  // stalled); flagged_job_id / flagged_job_note name the Persona job the run
  // set waiting and the note it left, so the job is restored when the run
  // moves again — unless someone changed the job since.
  const runColumns = (db.query("PRAGMA table_info(pipeline_runs)").all() as Array<{ name: string }>).map((c) => c.name);
  for (const column of ["waiting_kind", "flagged_job_id", "flagged_job_note"]) {
    if (!runColumns.includes(column)) db.exec(`ALTER TABLE pipeline_runs ADD COLUMN ${column} TEXT`);
  }
  // epoch counts the rework rounds a reviewer sent the run back for; each
  // attempt carries the epoch it was recorded in, so loop and attempt budgets
  // count only the current round's attempts.
  if (!runColumns.includes("epoch")) db.exec("ALTER TABLE pipeline_runs ADD COLUMN epoch INTEGER NOT NULL DEFAULT 0");
  // disabled_reason says why a disabled run is off (opt_out | no_mcp |
  // attempt | other), so only a Best-of-N attempt's run is turned on by a
  // pick; review_handoff_at marks the review-agent gate handing the worker
  // the code review to cut, so the worker's report of it counts as the gate's once.
  for (const column of ["disabled_reason", "review_handoff_at"]) {
    if (!runColumns.includes(column)) db.exec(`ALTER TABLE pipeline_runs ADD COLUMN ${column} TEXT`);
  }
  // launch_override_json is the launch's own configuration layer and preset
  // the preset its definition was resolved from (full | light); both NULL on
  // runs started before them.
  for (const column of ["launch_override_json", "preset"]) {
    if (!runColumns.includes(column)) db.exec(`ALTER TABLE pipeline_runs ADD COLUMN ${column} TEXT`);
  }
  // parked_* mark a run whose worker was told to wait (on another job, say):
  // why, the job it waits on, who parked it (worker | persona), the actor and
  // when. While parked_at is set the worker's Stop goes through unblocked.
  // parked_messages_json lists the steers and teammate messages already
  // queued when the park was set, whose delivery doesn't un-park the run.
  for (const column of ["parked_reason", "parked_job_id", "parked_by", "parked_actor", "parked_at", "parked_messages_json"]) {
    if (!runColumns.includes(column)) db.exec(`ALTER TABLE pipeline_runs ADD COLUMN ${column} TEXT`);
  }
  const attemptColumns = (db.query("PRAGMA table_info(pipeline_stage_attempts)").all() as Array<{ name: string }>).map((c) => c.name);
  if (!attemptColumns.includes("epoch")) {
    db.exec("ALTER TABLE pipeline_stage_attempts ADD COLUMN epoch INTEGER NOT NULL DEFAULT 0");
  }
  // pipeline_decisions audits what each owner's Persona decided about a run's
  // stage (skip, waive, close out, escalate, accept wontfix, not applicable)
  // or a pipeline layer (config); run, job, project and stage are NULL where
  // the decision had none.
  db.exec(`
  CREATE TABLE IF NOT EXISTS pipeline_decisions (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    run_id TEXT,
    job_id TEXT,
    project_id TEXT,
    stage TEXT,
    kind TEXT NOT NULL,
    reason TEXT NOT NULL,
    actor TEXT NOT NULL,
    detail_json TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_pipeline_decisions_owner_job ON pipeline_decisions(owner, job_id);
  `);
}

/**
 * Creates persona_message_jobs where missing and backfills it from
 * persona_messages.job_ids_json: every id there without a row gets an
 * `explicit` one. Malformed or non-array job_ids_json is skipped. Idempotent:
 * an existing row is never changed, and a tag the owner removed stays removed
 * because removal drops the id from job_ids_json too.
 *
 * This relies on job_ids_json being written only when a message is inserted
 * (appendPersonaMessage) and only ever narrowed after that
 * (removePersonaMessageJobTag). Anything that rewrote it with ids the message
 * has no tag row for would have those tags reappear on the next boot.
 *
 * The backfill runs on every boot, so it only touches ids that have no row:
 * the check is a primary-key lookup per id, and a database whose tags are in
 * step inserts nothing.
 */
export function ensurePersonaMessageJobsShape(db: Database): void {
  const tableExists = (table: string): boolean =>
    db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) != null;
  db.transaction(() => {
    db.exec(`
    CREATE TABLE IF NOT EXISTS persona_message_jobs (
      message_id TEXT NOT NULL,
      job_id TEXT NOT NULL,
      owner TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('explicit', 'declared', 'inferred')),
      created_at TEXT NOT NULL,
      PRIMARY KEY (message_id, job_id)
    );
    `);
    if (!tableExists("persona_messages") || !tableExists("persona_threads")) return;
    db.exec(`
    INSERT OR IGNORE INTO persona_message_jobs (message_id, job_id, owner, source, created_at)
    SELECT m.id, j.value, t.owner, 'explicit', m.created_at
      FROM persona_messages m
      JOIN persona_threads t ON t.id = m.thread_id
      JOIN json_each(
        COALESCE(
          CASE WHEN json_valid(m.job_ids_json)
               THEN CASE WHEN json_type(m.job_ids_json) = 'array' THEN m.job_ids_json END
          END,
          '[]'
        )
      ) j
     WHERE m.job_ids_json IS NOT NULL
       AND t.owner IS NOT NULL
       AND j.type = 'text'
       AND j.value != ''
       AND NOT EXISTS (
         SELECT 1 FROM persona_message_jobs x WHERE x.message_id = m.id AND x.job_id = j.value
       )
     ORDER BY m.rowid, j.key
    `);
  })();
}

/**
 * Creates the review tables (migration 062) and adds review_packets'
 * submitter columns, launches.launched_by, launches.review_token_hash and
 * steers.audience where missing. Idempotent:
 * every step checks the current shape first.
 */
export function ensureReviewPacketsShape(db: Database): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS review_packets (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    project_id TEXT,
    launch_id TEXT,
    job_id TEXT,
    session_id TEXT,
    pipeline_run_id TEXT,
    branch TEXT,
    commit_sha TEXT,
    base_sha TEXT,
    title TEXT NOT NULL DEFAULT '',
    intent TEXT NOT NULL DEFAULT '',
    changes_json TEXT NOT NULL DEFAULT '[]',
    validation_json TEXT NOT NULL DEFAULT '{"samples":[]}',
    risks_json TEXT NOT NULL DEFAULT '{"risks":[],"questions":[]}',
    links_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'draft'
      CHECK (status IN ('draft', 'pending', 'approved', 'changes_requested', 'superseded')),
    revision INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    decided_at TEXT,
    decided_by TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_review_packets_owner_status
    ON review_packets(owner, status, created_at);
  CREATE INDEX IF NOT EXISTS idx_review_packets_launch
    ON review_packets(launch_id);
  CREATE TABLE IF NOT EXISTS review_comments (
    id TEXT PRIMARY KEY,
    packet_id TEXT NOT NULL REFERENCES review_packets(id) ON DELETE CASCADE,
    author TEXT NOT NULL,
    body TEXT NOT NULL,
    decision TEXT CHECK (decision IS NULL OR decision IN ('approved', 'changes_requested')),
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_review_comments_packet
    ON review_comments(packet_id, created_at);
  CREATE TABLE IF NOT EXISTS review_media (
    id TEXT PRIMARY KEY,
    packet_id TEXT NOT NULL REFERENCES review_packets(id) ON DELETE CASCADE,
    owner TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('image', 'video')),
    mime TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    caption TEXT NOT NULL DEFAULT '',
    position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_review_media_packet
    ON review_media(packet_id, position);
  CREATE INDEX IF NOT EXISTS idx_review_media_sha256
    ON review_media(sha256);
  CREATE INDEX IF NOT EXISTS idx_review_media_owner
    ON review_media(owner);
  `);
  const packetColumns = (db.query("PRAGMA table_info(review_packets)").all() as Array<{ name: string }>).map((c) => c.name);
  if (!packetColumns.includes("submitted_by_session")) db.exec("ALTER TABLE review_packets ADD COLUMN submitted_by_session TEXT");
  if (!packetColumns.includes("submitted_by_root")) {
    db.exec("ALTER TABLE review_packets ADD COLUMN submitted_by_root INTEGER NOT NULL DEFAULT 0");
  }
  if (!packetColumns.includes("resubmitted_from_other_session")) {
    db.exec("ALTER TABLE review_packets ADD COLUMN resubmitted_from_other_session INTEGER NOT NULL DEFAULT 0");
  }
  const launchColumns = (db.query("PRAGMA table_info(launches)").all() as Array<{ name: string }>).map((c) => c.name);
  if (launchColumns.length > 0) {
    if (!launchColumns.includes("launched_by")) db.exec("ALTER TABLE launches ADD COLUMN launched_by TEXT");
    if (!launchColumns.includes("review_token_hash")) db.exec("ALTER TABLE launches ADD COLUMN review_token_hash TEXT");
    db.exec("CREATE INDEX IF NOT EXISTS idx_launches_review_token_hash ON launches(review_token_hash)");
  }
  const steerColumns = (db.query("PRAGMA table_info(steers)").all() as Array<{ name: string }>).map((c) => c.name);
  if (steerColumns.length > 0 && !steerColumns.includes("audience")) db.exec("ALTER TABLE steers ADD COLUMN audience TEXT");
  // A comment's kind (a remark, the owner's question, or an answer to one), the
  // thread's opening question it belongs to, and who a question went to or an
  // answer came from (worker or persona; none for a question nobody could take).
  const commentColumns = (db.query("PRAGMA table_info(review_comments)").all() as Array<{ name: string }>).map((c) => c.name);
  if (!commentColumns.includes("kind")) {
    db.exec("ALTER TABLE review_comments ADD COLUMN kind TEXT NOT NULL DEFAULT 'comment' CHECK (kind IN ('comment', 'question', 'answer'))");
  }
  if (!commentColumns.includes("reply_to")) db.exec("ALTER TABLE review_comments ADD COLUMN reply_to TEXT");
  if (!commentColumns.includes("via")) {
    db.exec("ALTER TABLE review_comments ADD COLUMN via TEXT CHECK (via IS NULL OR via IN ('worker', 'persona', 'none'))");
  }
}

/**
 * Creates persona_user_access and adds persona_approvals.approver (with its
 * index) and asks.answered_by where missing. Idempotent: every step checks the
 * current shape first.
 */
export function ensurePersonaUserAccessShape(db: Database): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS persona_user_access (
    alias TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 1,
    launch_projects_json TEXT NOT NULL DEFAULT '[]',
    updated_by TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `);
  const columns = (table: string): string[] =>
    (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
  const approvalColumns = columns("persona_approvals");
  if (approvalColumns.length > 0) {
    if (!approvalColumns.includes("approver")) {
      db.exec("ALTER TABLE persona_approvals ADD COLUMN approver TEXT");
    }
    db.exec("CREATE INDEX IF NOT EXISTS idx_persona_approvals_approver ON persona_approvals(approver, status)");
  }
  const askColumns = columns("asks");
  if (askColumns.length > 0 && !askColumns.includes("answered_by")) {
    db.exec("ALTER TABLE asks ADD COLUMN answered_by TEXT");
  }
}

/**
 * Creates persona_attachments, adds its media_json (069) and
 * persona_messages.attachments_json where missing. Idempotent: every step
 * checks the current shape first.
 */
export function ensurePersonaAttachmentsShape(db: Database): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS persona_attachments (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    batch_key TEXT NOT NULL,
    message_id TEXT,
    sha256 TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    name TEXT NOT NULL,
    caption TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_persona_attachments_turn
    ON persona_attachments(thread_id, batch_key, message_id);
  CREATE TABLE IF NOT EXISTS persona_session_images (
    session_id TEXT PRIMARY KEY,
    images INTEGER NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS persona_media_shares (
    session_id TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    attachment_id TEXT NOT NULL,
    owner TEXT NOT NULL,
    shared_at TEXT NOT NULL,
    PRIMARY KEY (session_id, sha256)
  );
  `);
  const sessionImageColumns = (db.query("PRAGMA table_info(persona_session_images)").all() as Array<{ name: string }>).map(
    (c) => c.name
  );
  if (!sessionImageColumns.includes("base64_bytes")) {
    db.exec("ALTER TABLE persona_session_images ADD COLUMN base64_bytes INTEGER NOT NULL DEFAULT 0");
  }
  const attachmentColumns = (db.query("PRAGMA table_info(persona_attachments)").all() as Array<{ name: string }>).map(
    (c) => c.name
  );
  if (!attachmentColumns.includes("media_json")) {
    db.exec("ALTER TABLE persona_attachments ADD COLUMN media_json TEXT");
  }
  const messageColumns = (db.query("PRAGMA table_info(persona_messages)").all() as Array<{ name: string }>).map(
    (c) => c.name
  );
  if (messageColumns.length > 0 && !messageColumns.includes("attachments_json")) {
    db.exec("ALTER TABLE persona_messages ADD COLUMN attachments_json TEXT");
  }
}

/**
 * Creates persona_signals and adds the 056 columns where missing. Idempotent:
 * every step checks the current shape first.
 */
export function ensurePersonaSignalsShape(db: Database): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS persona_signals (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN (
      'approval', 'option_reply', 'correction', 'rewrite', 'ignored', 'routing',
      'activity', 'style_feedback', 'owner_length', 'request', 'persona_action')),
    actor TEXT NOT NULL CHECK (actor IN ('owner', 'system')),
    subject TEXT,
    value_json TEXT NOT NULL,
    excerpt TEXT,
    vector BLOB,
    thread_id TEXT,
    job_id TEXT,
    message_id TEXT,
    approval_id TEXT,
    audience TEXT NOT NULL DEFAULT 'private',
    channel TEXT,
    device TEXT,
    occurred_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_persona_signals_kind ON persona_signals(owner, kind, occurred_at);
  CREATE INDEX IF NOT EXISTS idx_persona_signals_subject ON persona_signals(owner, subject);
  `);
  const columns = (table: string): string[] =>
    (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
  const approvalColumns = columns("persona_approvals");
  if (approvalColumns.length > 0 && !approvalColumns.includes("hold_rule")) {
    db.exec("ALTER TABLE persona_approvals ADD COLUMN hold_rule TEXT");
  }
  const messageColumns = columns("persona_messages");
  if (messageColumns.length > 0 && !messageColumns.includes("recommended_option")) {
    db.exec("ALTER TABLE persona_messages ADD COLUMN recommended_option INTEGER");
  }
}

/** Every migration with its version: MIGRATIONS positionally, then VERSIONED_MIGRATIONS. */
export function allMigrations(): VersionedMigration[] {
  return [
    ...MIGRATIONS.map((sql, i) => ({ version: i + 1, apply: sql, positional: true })),
    ...VERSIONED_MIGRATIONS,
  ];
}

/**
 * Versions declared more than once across `migrations`, or declared at all when
 * reserved (RESERVED_MIGRATION_VERSIONS) — always empty for a sound list.
 */
export function duplicateMigrationVersions(
  migrations: VersionedMigration[] = allMigrations(),
  reserved: readonly number[] = RESERVED_MIGRATION_VERSIONS
): number[] {
  // A reserved version counts as already taken.
  const seen = new Set<number>(reserved);
  const duplicates = new Set<number>();
  for (const m of migrations) {
    if (seen.has(m.version)) duplicates.add(m.version);
    seen.add(m.version);
  }
  return [...duplicates].sort((a, b) => a - b);
}

/** The highest schema version this code knows. */
export const LATEST_SCHEMA_VERSION = Math.max(...allMigrations().map((m) => m.version));

/** The schema versions recorded in `db`; empty for a database never migrated. */
export function recordedSchemaVersions(db: Database): Set<number> {
  try {
    return new Set(
      (db.query("SELECT version FROM schema_version").all() as Array<{ version: number }>).map((r) => r.version)
    );
  } catch {
    // Table doesn't exist yet: nothing is recorded.
    return new Set();
  }
}

/** The migrations runMigrations would apply to `db`, in the order it applies them. */
export function pendingMigrations(
  db: Database,
  migrations: VersionedMigration[] = allMigrations()
): VersionedMigration[] {
  const recorded = recordedSchemaVersions(db);
  // A positional migration is pending when its version is above the highest
  // positional version recorded — the rule this runner has always applied, so
  // an existing database replays exactly what it did before. An explicitly
  // versioned one is pending until its own version is recorded, whatever ran
  // after it, so a migration that lands after a higher-numbered one still runs.
  const positionalVersions = new Set(migrations.filter((m) => m.positional).map((m) => m.version));
  const positionalDone = Math.max(0, ...[...recorded].filter((v) => positionalVersions.has(v)));
  return migrations
    .filter((m) => (m.positional ? m.version > positionalDone : !recorded.has(m.version)))
    .sort((x, y) => x.version - y.version);
}

/**
 * Refuses a database holding stored values this code does not recognize and
 * never writes, and logs a warning for unrecognized values it can write
 * (assertRecognizedStoredValues). Then applies every pending migration in
 * ascending version order, records each, then runs ensureSchemaRepairs.
 * `migrations` and `reserved` default to this
 * code's lists; they are parameters so a test can replay a list as another
 * branch would ship it.
 */
export function runMigrations(
  db: Database,
  migrations: VersionedMigration[] = allMigrations(),
  reserved: readonly number[] = RESERVED_MIGRATION_VERSIONS
): void {
  const duplicates = duplicateMigrationVersions(migrations, reserved);
  if (duplicates.length > 0) {
    throw new Error(`migration version(s) declared twice or reserved: ${duplicates.join(", ")}`);
  }
  // Checked before anything is applied, so a refused database is left as found.
  assertRecognizedStoredValues(db);
  const pending = pendingMigrations(db, migrations);

  // Each version is recorded here rather than inside the migration body — a
  // migration that has to remember to stamp its own version silently stops
  // advancing the moment someone forgets.
  for (const m of pending) {
    if (typeof m.apply === "string") db.exec(m.apply);
    else m.apply(db);
    db.run("INSERT OR IGNORE INTO schema_version (version) VALUES (?)", [m.version]);
  }

  ensureSchemaRepairs(db);
}

/**
 * Every key a board card's links_json may hold. The `satisfies` keeps the
 * list in step with BoardTaskLinks: a key missing here or not in the
 * interface fails the typecheck.
 */
const BOARD_LINK_KEYS: readonly string[] = Object.keys({
  jobId: true,
  launchIds: true,
  sessionIds: true,
  packetId: true,
  codeReview: true,
  tunnelUrl: true,
  ticketId: true,
  backlogItemId: true,
  runId: true,
} satisfies Record<keyof BoardTaskLinks, true>);

/** Every review packet link kind (ReviewLinkKind), kept in step with the type the same way. */
const REVIEW_PACKET_LINK_KINDS: readonly string[] = Object.keys({
  code_review: true,
  deploy: true,
  stack: true,
  other: true,
} satisfies Record<ReviewLinkKind, true>);

/**
 * The lens the collector's tracker sync (tracker/sync.ts TRACKER_LENS) stamps
 * on a ticket it ingests. That sync is the only writer of tickets.task_url.
 */
const TRACKER_TICKET_LENS = "tracker";

/** The values a stored row may hold, by what they name. */
export interface KnownStoredValues {
  /** Pipeline stage kinds (registered with registerPipelineStageKind). */
  stageKinds: readonly string[];
  /** Stage ids of the built-in pipeline catalog; a layer's own added stages count too. */
  stageIds: readonly string[];
  /** Code review adapter ids (projects.review_artifact_provider). */
  codeReviewAdapters: readonly string[];
  /** Keys of a board card's links_json. */
  boardLinkKeys: readonly string[];
  /** Kinds of a review packet's links. */
  reviewLinkKinds: readonly string[];
  /** The lens of a ticket ingested from the issue tracker. */
  trackerLens: string;
}

/** The values this code recognizes. Stage kinds are read when called, so kinds registered by then count. */
export function knownStoredValues(): KnownStoredValues {
  return {
    stageKinds: registeredPipelineStageKinds(),
    stageIds: PIPELINE_CATALOG.stages.map((s) => s.id),
    codeReviewAdapters: CODE_REVIEW_ADAPTER_IDS,
    boardLinkKeys: BOARD_LINK_KEYS,
    reviewLinkKinds: REVIEW_PACKET_LINK_KINDS,
    trackerLens: TRACKER_TICKET_LENS,
  };
}

/** Stored values of one kind that the code does not recognize. */
export interface UnrecognizedStoredValue {
  /** Where they are stored: `table.column`, with the JSON path inside the column where there is one. */
  where: string;
  /** What the code expects there. */
  expected: string;
  /** Each distinct value, with how many times it is stored; most frequent first. */
  values: Array<{ value: string; count: number }>;
  /**
   * `refuse`: only a build that stored these values under other ids writes
   * them, and the code would misread them without saying so; the database is
   * refused. `warn`: the current code can store them too, from the owner's
   * own config or from a layer that went stale, and handles them as `effect`
   * says; the database is kept and the values are reported.
   */
  severity: "refuse" | "warn";
  /** For a warning: what the code does with these values, and how to fix them. */
  effect?: string;
}

/** Thrown by assertRecognizedStoredValues; `findings` lists every refused kind of value, warnings left out. */
export class UnrecognizedStoredValuesError extends Error {
  readonly findings: UnrecognizedStoredValue[];
  constructor(message: string, findings: UnrecognizedStoredValue[]) {
    super(message);
    this.name = "UnrecognizedStoredValuesError";
    this.findings = findings;
  }
}

/** The column names of `table`; empty when the table does not exist. */
function storedColumns(db: Database, table: string): Set<string> {
  return new Set((db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name));
}

/**
 * `expr` when it holds a JSON object, else '{}': json_each and json_extract
 * over the result never raise on malformed or non-object text. CASE stops
 * at the first WHEN that holds, so json_type only sees valid JSON.
 */
function jsonObject(expr: string): string {
  return `(CASE WHEN NOT json_valid(${expr}) THEN '{}' WHEN json_type(${expr}) = 'object' THEN ${expr} ELSE '{}' END)`;
}

/** `expr` when it holds a JSON array, else '[]' (see jsonObject). */
function jsonArray(expr: string): string {
  return `(CASE WHEN NOT json_valid(${expr}) THEN '[]' WHEN json_type(${expr}) = 'array' THEN ${expr} ELSE '[]' END)`;
}

/**
 * Stored values the current code does not recognize.
 *
 * Refused (severity `refuse`), because no current code path writes them and
 * the code reads them as unset or as an unknown stage without saying why: a
 * pipeline stage kind no code registers, a stage of a well-formed run
 * definition that the run's current stage or an attempt does not match, a
 * board link key or review packet link kind the code doesn't define, and a
 * tracker-ingested ticket under another lens.
 *
 * Reported (severity `warn`), because the current code can store them and
 * copes with them: a code review adapter id (seeded from projects.toml as
 * written, and read as unset), a pipeline layer patching or adding after a
 * stage that no pipeline it applies to has (a layer goes stale when a stage
 * it relied on is removed, and resolving a pipeline drops it with an error),
 * and a run definition that is not a JSON object with a stages array.
 *
 * Read-only, and every check skips a table or column the database does not
 * have. Empty for a database this code wrote.
 */
export function unrecognizedStoredValues(db: Database, known: KnownStoredValues = knownStoredValues()): UnrecognizedStoredValue[] {
  const findings: UnrecognizedStoredValue[] = [];
  const has = (table: string, ...columns: string[]): boolean => {
    const present = storedColumns(db, table);
    return columns.every((c) => present.has(c));
  };
  /** Adds a finding for the rows `sql` returns: refused, or a warning when `effect` is given. */
  const collect = (where: string, expected: string, sql: string, params: Record<string, string> = {}, effect?: string): void => {
    const rows = db.query(sql).all(params) as Array<{ value: string | number | null; n: number }>;
    if (rows.length === 0) return;
    findings.push({
      where,
      expected,
      values: rows
        .map((r) => ({ value: String(r.value ?? ""), count: r.n }))
        .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value)),
      ...(effect ? { severity: "warn" as const, effect } : { severity: "refuse" as const }),
    });
  };
  const list = (values: readonly string[]): string => JSON.stringify(values);
  const oneOf = (values: readonly string[]): string => `one of ${values.join(", ")}`;

  if (has("projects", "review_artifact_provider")) {
    collect(
      "projects.review_artifact_provider",
      `unset or ${oneOf(known.codeReviewAdapters)}`,
      `SELECT review_artifact_provider AS value, COUNT(*) AS n FROM projects
       WHERE COALESCE(review_artifact_provider, '') != ''
         AND review_artifact_provider NOT IN (SELECT value FROM json_each($known))
       GROUP BY review_artifact_provider`,
      { $known: list(known.codeReviewAdapters) },
      "Read as unset, so the project has no code review adapter. Fix codeReviewAdapter in projects.toml and import " +
        "the file again (POST /api/projects/import); projects.toml seeds only an empty projects table."
    );
  }

  if (has("tickets", "lens", "task_url")) {
    collect(
      "tickets.lens (tickets with a task_url)",
      `"${known.trackerLens}", the lens of a ticket ingested from the issue tracker`,
      `SELECT lens AS value, COUNT(*) AS n FROM tickets
       WHERE COALESCE(task_url, '') != '' AND lens != $lens
       GROUP BY lens`,
      { $lens: known.trackerLens }
    );
  }

  if (has("board_tasks", "links_json")) {
    collect(
      "board_tasks.links_json keys",
      oneOf(known.boardLinkKeys),
      `SELECT l.key AS value, COUNT(*) AS n FROM board_tasks b, json_each(${jsonObject("b.links_json")}) l
       WHERE l.key NOT IN (SELECT value FROM json_each($known))
       GROUP BY l.key`,
      { $known: list(known.boardLinkKeys) }
    );
  }

  if (has("review_packets", "links_json")) {
    collect(
      "review_packets.links_json $[*].kind",
      oneOf(known.reviewLinkKinds),
      `SELECT json_extract(l.value, '$.kind') AS value, COUNT(*) AS n
       FROM review_packets p, json_each(${jsonArray("p.links_json")}) l
       WHERE l.type = 'object' AND json_extract(l.value, '$.kind') IS NOT NULL
         AND json_extract(l.value, '$.kind') NOT IN (SELECT value FROM json_each($known))
       GROUP BY 1`,
      { $known: list(known.reviewLinkKinds) }
    );
  }

  const runStages = (run: string): string => `json_each(${jsonObject(`${run}.definition_json`)}, '$.stages')`;
  // A run whose definition is a JSON object with a stages array; only such a
  // run's current stage and attempts are checked against its stages.
  const wellFormed = (run: string): string => {
    const d = `${run}.definition_json`;
    return `(CASE WHEN NOT json_valid(${d}) THEN 0 WHEN json_type(${d}) != 'object' THEN 0
             ELSE COALESCE(json_type(${d}, '$.stages'), '') = 'array' END)`;
  };
  const hasRuns = has("pipeline_runs", "id", "definition_json", "current_stage");
  if (hasRuns) {
    collect(
      "pipeline_runs.definition_json (run ids)",
      "a JSON object with a $.stages array",
      `SELECT r.id AS value, COUNT(*) AS n FROM pipeline_runs r WHERE NOT ${wellFormed("r")} GROUP BY r.id`,
      {},
      "The stored definition is damaged rather than written under other ids. Its run has no stages to advance " +
        "through; cancel the run and relaunch."
    );
    collect(
      "pipeline_runs.definition_json $.stages[*].kind",
      `a registered stage kind (${known.stageKinds.join(", ")})`,
      `SELECT json_extract(s.value, '$.kind') AS value, COUNT(DISTINCT r.id) AS n
       FROM pipeline_runs r, ${runStages("r")} s
       WHERE s.type = 'object' AND COALESCE(json_extract(s.value, '$.kind'), '') NOT IN (SELECT value FROM json_each($known))
       GROUP BY 1`,
      { $known: list(known.stageKinds) }
    );
    collect(
      "pipeline_runs.current_stage",
      "a stage of the run's own definition",
      `SELECT r.current_stage AS value, COUNT(*) AS n FROM pipeline_runs r
       WHERE ${wellFormed("r")}
         AND NOT EXISTS (SELECT 1 FROM ${runStages("r")} s
                         WHERE s.type = 'object' AND json_extract(s.value, '$.id') = r.current_stage)
       GROUP BY r.current_stage`
    );
  }
  if (hasRuns && has("pipeline_stage_attempts", "run_id", "stage_id")) {
    collect(
      "pipeline_stage_attempts.stage_id",
      "a stage of the attempt's run's definition",
      `SELECT a.stage_id AS value, COUNT(*) AS n
       FROM pipeline_stage_attempts a JOIN pipeline_runs r ON r.id = a.run_id
       WHERE ${wellFormed("r")}
         AND NOT EXISTS (SELECT 1 FROM ${runStages("r")} s
                         WHERE s.type = 'object' AND json_extract(s.value, '$.id') = a.stage_id)
       GROUP BY a.stage_id`
    );
  }

  // Pipeline configuration layers: each patches stages by id, and may add a
  // stage (with its kind) after another one. A launch layer is also checked
  // against its own run's frozen definition, whose stages it was resolved with.
  const layers = [
    { table: "pipeline_configs", column: "override_json", ownRun: false },
    { table: "persona_jobs", column: "pipeline_override_json", ownRun: false },
    { table: "pipeline_runs", column: "launch_override_json", ownRun: hasRuns },
  ].filter((l) => has(l.table, l.column));
  const added = new Set<string>();
  for (const { table, column } of layers) {
    const rows = db
      .query(
        `SELECT DISTINCT json_extract(a.value, '$.stage.id') AS id
         FROM ${table} t, json_each(${jsonObject(`t.${column}`)}, '$.add') a
         WHERE a.type = 'object' AND json_extract(a.value, '$.stage.id') IS NOT NULL`
      )
      .all() as Array<{ id: string | number }>;
    for (const r of rows) added.add(String(r.id));
  }
  const stageIds = [...new Set([...known.stageIds, ...added])];
  const staleLayer =
    "A pipeline resolved with this layer falls back to the layers below it and reports the error. Edit or clear " +
    "the layer.";
  for (const { table, column, ownRun } of layers) {
    const body = jsonObject(`t.${column}`);
    const stageIdsExpected =
      `a stage id of the pipeline catalog (${known.stageIds.join(", ")}) or one a layer adds` +
      (ownRun ? ", or a stage of the run's own definition" : "");
    const notOwnStage = (id: string): string =>
      ownRun
        ? `AND NOT EXISTS (SELECT 1 FROM ${runStages("t")} s WHERE s.type = 'object' AND json_extract(s.value, '$.id') = ${id})`
        : "";
    collect(
      `${table}.${column} $.stages keys`,
      stageIdsExpected,
      `SELECT p.key AS value, COUNT(*) AS n FROM ${table} t, json_each(${body}, '$.stages') p
       WHERE json_type(${body}, '$.stages') = 'object' AND p.key NOT IN (SELECT value FROM json_each($known))
         ${notOwnStage("p.key")}
       GROUP BY p.key`,
      { $known: list(stageIds) },
      staleLayer
    );
    collect(
      `${table}.${column} $.add[*].after`,
      stageIdsExpected,
      `SELECT json_extract(a.value, '$.after') AS value, COUNT(*) AS n FROM ${table} t, json_each(${body}, '$.add') a
       WHERE a.type = 'object' AND json_extract(a.value, '$.after') IS NOT NULL
         AND json_extract(a.value, '$.after') NOT IN (SELECT value FROM json_each($known))
         ${notOwnStage("json_extract(a.value, '$.after')")}
       GROUP BY 1`,
      { $known: list(stageIds) },
      staleLayer
    );
    collect(
      `${table}.${column} $.add[*].stage.kind`,
      `a registered stage kind (${known.stageKinds.join(", ")})`,
      `SELECT json_extract(a.value, '$.stage.kind') AS value, COUNT(*) AS n FROM ${table} t, json_each(${body}, '$.add') a
       WHERE a.type = 'object' AND json_extract(a.value, '$.stage.kind') IS NOT NULL
         AND json_extract(a.value, '$.stage.kind') NOT IN (SELECT value FROM json_each($known))
       GROUP BY 1`,
      { $known: list(known.stageKinds) }
    );
  }

  return findings;
}

/** At most this many distinct values of one finding are named in the error. */
const MAX_NAMED_VALUES = 5;

/** One line naming a finding's place, its values and what the code expects there. */
function findingLine(f: UnrecognizedStoredValue): string {
  const named = f.values
    .slice(0, MAX_NAMED_VALUES)
    .map((v) => `${JSON.stringify(v.value)} (${v.count}x)`)
    .join(", ");
  const more = f.values.length > MAX_NAMED_VALUES ? `, and ${f.values.length - MAX_NAMED_VALUES} more` : "";
  return `  - ${f.where}: ${named}${more}; expected ${f.expected}.${f.effect ? ` ${f.effect}` : ""}`;
}

/**
 * Checks `db` for stored values the current code does not recognize
 * (unrecognizedStoredValues). Warnings are passed to `warn` as one message,
 * and the database is kept. Refused findings come from a build that stored
 * those values under other ids; this code does not rewrite them, so it
 * throws UnrecognizedStoredValuesError, whose message names each place, its
 * values and what the code expects there, and says to start on a fresh
 * database. Warnings are passed on before it throws.
 */
export function assertRecognizedStoredValues(
  db: Database,
  known: KnownStoredValues = knownStoredValues(),
  warn: (message: string) => void = console.warn
): void {
  const findings = unrecognizedStoredValues(db, known);
  const warnings = findings.filter((f) => f.severity === "warn");
  const refused = findings.filter((f) => f.severity === "refuse");
  if (warnings.length > 0) {
    warn(["[store] The database holds stored values this build does not recognize; it keeps them:", ...warnings.map(findingLine)].join("\n"));
  }
  if (refused.length === 0) return;
  const file = db.filename && db.filename !== ":memory:" ? db.filename : "the database file";
  throw new UnrecognizedStoredValuesError(
    [
      "This database holds stored values this build of Standup does not recognize and no code path of this build " +
        "writes, most likely written by an earlier build that stored them under other ids. This build does not " +
        "rewrite them, and would misread them.",
      ...refused.map(findingLine),
      `Start on a fresh database: stop Standup, move ${file} and its -wal and -shm files aside, and start Standup ` +
        `again. See CHANGELOG.md, "Upgrading an existing install".`,
    ].join("\n"),
    refused
  );
}

/**
 * Idempotent column repairs for databases whose schema_version recorded before
 * a column was added to an already-created table. SQLite has no
 * `ADD COLUMN IF NOT EXISTS`, and `CREATE TABLE IF NOT EXISTS` silently skips a
 * table that already exists with an older shape — so a version bump can leave a
 * column missing with no way for the versioned migration to repair it.
 * PRAGMA-checked and safe to run on every startup.
 *
 * `actors.merged_into`: an early revision of migration 022 created `actors`
 * without it; the corrected CREATE never applied to databases that already had
 * the table, leaving getActors' `WHERE merged_into IS NULL` to throw
 * "no such column".
 *
 * `users.via_tunnel`: migration 025 adds it by ALTER; a database whose
 * schema_version already recorded past 025 without the column (e.g. an aborted
 * upgrade) would leave countDistinctUsers' `WHERE via_tunnel = 1` to throw.
 *
 * `tickets.reported_by_actor`: migration 028 adds it by ALTER; the same aborted-
 * upgrade case would leave the ticket status setter's write to a missing column.
 *
 * `tickets.issue_id`: migration 031 adds it by ALTER; the same aborted-upgrade
 * case would leave createTicket's insert of a tracking id hitting a missing column.
 *
 * `tickets.task_url`: migration 033 adds it by ALTER; the same aborted-upgrade
 * case would leave createTicket's insert of a tracker deep link hitting a missing column.
 *
 * `tickets.attempt_group` / `task_runs.attempt_group` / `task_runs.attempt_status`:
 * migration 040 adds them by ALTER; the same aborted-upgrade case would leave the
 * best-of-N dispatch/pick queries reading or writing a missing column.
 *
 * `projects.harness` / `launches.harness` / `launches.codex_event_log`:
 * migration 042 adds them by ALTER; the same aborted-upgrade case would leave the
 * harness-selection launch path and the codex fleet-usage read hitting a missing
 * column.
 *
 * `projects.knowledge_scope`: migration 043 adds it by ALTER; the same aborted-
 * upgrade case would leave the per-project default-scope resolver's read hitting a
 * missing column.
 *
 * `launches.codex_model` / `launches.codex_effort`: migration 044 adds them by
 * ALTER; the same aborted-upgrade case would leave the Codex launch path's write
 * and the launch mapper's read hitting a missing column.
 *
 * `sessions.kind` / `sessions.agent_type` / `sessions.agent_id`: migration 045
 * adds them by ALTER; the same aborted-upgrade case would leave the subsession
 * upsert's write and the session row mapper's read hitting a missing column. The
 * parent index is re-created with IF NOT EXISTS so an aborted upgrade recovers it too.
 *
 * `projects.orchestration_profile` / `user_prefs.orchestration_profile`:
 * migration 047 adds them by ALTER; the same aborted-upgrade case would leave the
 * per-project and per-user default-profile resolvers reading a missing column.
 *
 * `knowledge_retrievals.injected` / `knowledge_retrievals.launch_id`: migration
 * 048 adds them by ALTER (plus the launch index); the same aborted-upgrade case
 * would leave recordRetrievals' insert and getRetrievalUsage's injected/dropped
 * rollup hitting a missing column.
 *
 * `asks.gate`: migration 050 adds it by ALTER; the same aborted-upgrade case
 * would leave the ask insert and every ask row mapper hitting a missing column.
 *
 * `persona_approvals.thread_id`: migration 051 adds it by ALTER; the same
 * aborted-upgrade case would leave createPersonaApproval's insert failing.
 *
 * `persona_threads.audience` / `persona_threads.claude_session_id`: migration
 * 051 adds them by ALTER; the same aborted-upgrade case would leave the thread
 * mapper and the per-thread session writes hitting a missing column.
 *
 * `knowledge_retrievals` / `expert_exchanges` / `knowledge_changes`: migration
 * 053 rebuilds the first two (a widened surface CHECK, a nullable session_id)
 * and ALTERs the third; the same aborted-upgrade case is repaired by running
 * that migration's shape check again (ensureRetrievalObservabilityShape).
 *
 * `persona_signals` / `persona_approvals.hold_rule` /
 * `persona_messages.recommended_option`: migration 056 creates and adds them;
 * the same aborted-upgrade case is repaired by running its shape check again
 * (ensurePersonaSignalsShape).
 *
 * `persona_attachments` / `persona_messages.attachments_json`: migration 058
 * creates and adds them; the same aborted-upgrade case is repaired by running
 * its shape check again (ensurePersonaAttachmentsShape).
 *
 * `persona_attachments.media_json`: migration 068 adds it; the same
 * aborted-upgrade case is repaired by the same shape check.
 *
 * `persona_user_access` / `persona_approvals.approver` / `asks.answered_by`:
 * migration 059 creates and adds them; the same aborted-upgrade case is
 * repaired by running its shape check again (ensurePersonaUserAccessShape).
 *
 * `launches.launched_by` / `launches.review_token_hash` / `steers.audience` /
 * review_packets' submitter columns: migration 062 adds them beside the review tables; a database with the review tables but
 * without those columns is repaired by running its shape check again
 * (ensureReviewPacketsShape).
 *
 * `projects.related_json`: migration 063 adds it; the same aborted-upgrade case
 * is repaired by running its column check again (ensureProjectsRelatedColumn).
 *
 * `knowledge.verdict_repo_path`: migration 064 adds it; the same aborted-upgrade
 * case is repaired by running its column check again
 * (ensureKnowledgeVerdictRepoColumn).
 *
 * `persona_jobs.waiting_since` and the other derived-state columns: migration
 * 065 adds them; the same aborted-upgrade case is repaired by running its
 * shape check again (ensurePersonaJobStateShape).
 *
 * `persona_message_jobs`: migration 066 creates and backfills it; the same
 * aborted-upgrade case is repaired by running its shape check again
 * (ensurePersonaMessageJobsShape).
 *
 * `pipeline_configs` / `pipeline_runs` / `pipeline_stage_attempts`: migration
 * 067 creates them; ensurePipelineShape runs again here for the same case.
 *
 * `projects.shareable` / `public_kb_calls`: migration 068 adds them;
 * ensurePublicKnowledgeShape runs again here for the same case.
 *
 * `persona_turns` / `persona_turn_jobs` / `persona_budget_prefs` and the
 * persona_jobs budget columns: migration 073 creates them;
 * ensurePersonaBudgetShape runs again here for the same case.
 *
 * `persona_floor_decisions.check_flag`: migration 075 adds it; the same
 * aborted-upgrade case is repaired by running its column check again
 * (ensurePersonaFloorDecisionCheckColumn).
 *
 * `review_packets.share_enabled` / `share_token` / `share_token_sha256`:
 * migration 079 adds them; the same aborted-upgrade case is repaired by
 * running its column check again (ensureReviewShareColumns).
 *
 * `share_grants` / `doc_folders` / `docs` / `doc_assets`: migration 080
 * creates them and moves review_packets' live shares into grants;
 * ensureDocsAndShareGrants runs again here for the same case.
 *
 * `share_grants.resource_type` taking 'folder': migration 085 widens its
 * CHECK; ensureShareGrantsFolderType runs again here for the same case.
 *
 * `launches.reaped_at` / `reap_reason` / `keep_alive` / `bypass_permissions` and the
 * `launch_processes` table: migration 081 adds them; the same aborted-upgrade
 * case is repaired by running its shape check again (ensureWorkerHygieneShape).
 *
 * `pipeline_runs.launch_override_json` / `pipeline_runs.preset` and the
 * `pipeline_decisions` audit table: added here by ensurePipelineShape rather
 * than by a numbered migration; NULL columns mean a run started before them.
 *
 * `pipeline_runs.parked_reason` / `parked_job_id` / `parked_by` /
 * `parked_actor` / `parked_at`: a run's parked state, added here by
 * ensurePipelineShape; NULL parked_at means the run isn't parked.
 *
 * `persona_jobs.pipeline_override_json`: the job's pipeline layer, added by
 * ensurePersonaJobStateShape; NULL means the job sets none.
 *
 * `persona_schedules.pipeline`: added here by ALTER rather than by a numbered
 * migration; NULL means the schedule's launches run the delivery pipeline.
 *
 * `persona_schedules.ends_at` / `max_runs` / `run_count` / `ended_at` /
 * `end_reason`: a schedule's end bound and end state, added the same way;
 * NULL bounds mean it runs until deleted. `persona_schedule_runs.counted`
 * marks a run holding one of max_runs; 0 for runs from before it.
 *
 * `persona_schedules.watch` / `watch_state` / `watch_pending` / `watch_skips` /
 * `watch_changed_at`: a wake_persona schedule's watch and what it last saw,
 * added the same way; NULL `watch` wakes Persona on every run.
 */
function ensureSchemaRepairs(db: Database): void {
  const columns = (table: string): string[] =>
    (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
      (c) => c.name
    );

  const actorColumns = columns("actors");
  if (actorColumns.length > 0 && !actorColumns.includes("merged_into")) {
    db.exec("ALTER TABLE actors ADD COLUMN merged_into TEXT");
  }

  const userColumns = columns("users");
  if (userColumns.length > 0 && !userColumns.includes("via_tunnel")) {
    db.exec("ALTER TABLE users ADD COLUMN via_tunnel INTEGER NOT NULL DEFAULT 0");
  }

  const ticketColumns = columns("tickets");
  if (ticketColumns.length > 0 && !ticketColumns.includes("reported_by_actor")) {
    db.exec("ALTER TABLE tickets ADD COLUMN reported_by_actor TEXT");
  }
  if (ticketColumns.length > 0 && !ticketColumns.includes("issue_id")) {
    db.exec("ALTER TABLE tickets ADD COLUMN issue_id TEXT");
  }
  if (ticketColumns.length > 0 && !ticketColumns.includes("task_url")) {
    db.exec("ALTER TABLE tickets ADD COLUMN task_url TEXT");
  }
  if (ticketColumns.length > 0 && !ticketColumns.includes("attempt_group")) {
    db.exec("ALTER TABLE tickets ADD COLUMN attempt_group TEXT");
  }

  // Permission bypass, its safety floor, and state that must survive a
  // collector restart. Applied here, idempotently, rather than as a numbered
  // migration so it composes with migrations other branches append.
  //
  // projects.bypass_permissions: launches run with permissions bypassed and the
  // safety-floor hook installed unless a project opts out (0).
  //
  // asks.request_id: a caller-chosen id for the request that raised an ask, so
  // a waiter whose connection dropped (the collector restarted) re-attaches to
  // the same ask instead of raising a second one. Unique per session.
  //
  // plan_review_remarks: the note or feedback a plan decision carries, kept
  // until the worker's submit_plan call has received it.
  db.exec(`
    CREATE TABLE IF NOT EXISTS plan_review_remarks (
      plan_id TEXT PRIMARY KEY,
      feedback TEXT,
      note TEXT,
      delivered INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const askColumns = columns("asks");
  if (askColumns.length > 0 && !askColumns.includes("gate")) {
    db.exec("ALTER TABLE asks ADD COLUMN gate TEXT");
  }
  if (askColumns.length > 0 && !askColumns.includes("request_id")) {
    db.exec("ALTER TABLE asks ADD COLUMN request_id TEXT");
  }
  if (askColumns.length > 0) {
    db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_asks_request_id ON asks(session_id, request_id) WHERE request_id IS NOT NULL"
    );
  }
  // The safety floor's hold bookkeeping on its asks: call_hash pins the tool
  // call a hold was raised for (a re-attach must name the same call),
  // floor_expires_at is when its waiter gives up (a boot sweep times out holds
  // past it), and floor_delivered_at marks an allow already handed to the hook,
  // so an allow runs the call at most once.
  if (askColumns.length > 0 && !askColumns.includes("call_hash")) {
    db.exec("ALTER TABLE asks ADD COLUMN call_hash TEXT");
  }
  if (askColumns.length > 0 && !askColumns.includes("floor_expires_at")) {
    db.exec("ALTER TABLE asks ADD COLUMN floor_expires_at TEXT");
  }
  if (askColumns.length > 0 && !askColumns.includes("floor_delivered_at")) {
    db.exec("ALTER TABLE asks ADD COLUMN floor_delivered_at TEXT");
  }

  // launches.worker_token_hash: the sha256 of the launch's scoped worker
  // credential (FloorConfig.workerToken). Only the hash is kept; the hook
  // presents the token when it raises a hold for the launch.
  const launchTokenColumns = columns("launches");
  if (launchTokenColumns.length > 0 && !launchTokenColumns.includes("worker_token_hash")) {
    db.exec("ALTER TABLE launches ADD COLUMN worker_token_hash TEXT");
  }
  // launches.hook_token_hash: the sha256 of the token the launch's own hooks
  // present on /hook. launches.hook_auth: 1 once an event carrying it has
  // arrived, after which the session's tokenless events are ignored. Both are
  // NULL for a launch started before these hooks existed.
  if (launchTokenColumns.length > 0 && !launchTokenColumns.includes("hook_token_hash")) {
    db.exec("ALTER TABLE launches ADD COLUMN hook_token_hash TEXT");
  }
  if (launchTokenColumns.length > 0 && !launchTokenColumns.includes("hook_auth")) {
    db.exec("ALTER TABLE launches ADD COLUMN hook_auth INTEGER");
  }
  if (launchTokenColumns.length > 0) {
    db.exec("CREATE INDEX IF NOT EXISTS idx_launches_hook_token_hash ON launches(hook_token_hash)");
  }
  // sessions.hook_launch_id: the launch whose hook token last reported for the
  // session, so that launch may take the session back after a /resume.
  const sessionHookColumns = columns("sessions");
  if (sessionHookColumns.length > 0 && !sessionHookColumns.includes("hook_launch_id")) {
    db.exec("ALTER TABLE sessions ADD COLUMN hook_launch_id TEXT");
  }

  const personaApprovalColumns = columns("persona_approvals");
  if (personaApprovalColumns.length > 0 && !personaApprovalColumns.includes("thread_id")) {
    db.exec("ALTER TABLE persona_approvals ADD COLUMN thread_id TEXT");
  }

  if (personaApprovalColumns.length > 0) ensurePersonaSignalsShape(db);

  if (columns("persona_messages").length > 0) ensurePersonaAttachmentsShape(db);

  if (columns("persona_messages").length > 0) ensurePersonaMessageJobsShape(db);

  ensurePersonaCommandShape(db);

  ensurePersonaReplyToColumn(db);

  ensureSessionEndMarkColumns(db);

  if (personaApprovalColumns.length > 0) ensurePersonaUserAccessShape(db);

  if (columns("review_packets").length > 0) ensureReviewPacketsShape(db);

  ensurePersonaJobStateShape(db);

  ensurePipelineShape(db);

  ensureReviewTunnelShape(db);
  ensureNotifyShape(db);
  ensureDeciderShape(db);
  ensurePersonaBudgetShape(db);

  const personaThreadColumns = columns("persona_threads");
  if (personaThreadColumns.length > 0 && !personaThreadColumns.includes("audience")) {
    db.exec("ALTER TABLE persona_threads ADD COLUMN audience TEXT NOT NULL DEFAULT 'private'");
  }
  if (personaThreadColumns.length > 0 && !personaThreadColumns.includes("claude_session_id")) {
    db.exec("ALTER TABLE persona_threads ADD COLUMN claude_session_id TEXT");
  }

  // persona_schedules.pipeline: 0 when a launch_job schedule's worker runs
  // without the delivery pipeline; NULL (the default) runs it with one.
  const personaScheduleColumns = columns("persona_schedules");
  if (personaScheduleColumns.length > 0 && !personaScheduleColumns.includes("pipeline")) {
    db.exec("ALTER TABLE persona_schedules ADD COLUMN pipeline INTEGER");
  }
  // persona_schedules end bound: `ends_at` (UTC ISO) and `max_runs` (NULL:
  // unbounded), `run_count` (runs fired, counted against max_runs),
  // and `ended_at` / `end_reason` once the bound ended it.
  const scheduleEndColumns: Array<[string, string]> = [
    ["ends_at", "TEXT"],
    ["max_runs", "INTEGER"],
    ["run_count", "INTEGER NOT NULL DEFAULT 0"],
    ["ended_at", "TEXT"],
    ["end_reason", "TEXT"],
    // A wake_persona schedule's watch: `watch` (ScheduleWatch JSON, NULL:
    // none), `watch_state` (its baseline), `watch_pending` (what its latest
    // wake reported), `watch_skips` (runs skipped with nothing changed) and
    // `watch_changed_at`.
    ["watch", "TEXT"],
    ["watch_state", "TEXT"],
    ["watch_pending", "TEXT"],
    ["watch_skips", "INTEGER NOT NULL DEFAULT 0"],
    ["watch_changed_at", "TEXT"],
  ];
  for (const [column, type] of scheduleEndColumns) {
    if (personaScheduleColumns.length > 0 && !personaScheduleColumns.includes(column)) {
      db.exec(`ALTER TABLE persona_schedules ADD COLUMN ${column} ${type}`);
    }
  }
  // persona_schedule_runs.counted: 1 while the run holds a max_runs count
  // (given back if its launch never starts).
  const scheduleRunColumns = columns("persona_schedule_runs");
  if (scheduleRunColumns.length > 0 && !scheduleRunColumns.includes("counted")) {
    db.exec("ALTER TABLE persona_schedule_runs ADD COLUMN counted INTEGER NOT NULL DEFAULT 0");
  }

  const taskRunColumns = columns("task_runs");
  if (taskRunColumns.length > 0 && !taskRunColumns.includes("attempt_group")) {
    db.exec("ALTER TABLE task_runs ADD COLUMN attempt_group TEXT");
  }
  if (taskRunColumns.length > 0 && !taskRunColumns.includes("attempt_status")) {
    db.exec("ALTER TABLE task_runs ADD COLUMN attempt_status TEXT");
  }

  const projectColumns = columns("projects");
  if (
    projectColumns.length > 0 &&
    !projectColumns.includes("review_artifact_provider")
  ) {
    db.exec("ALTER TABLE projects ADD COLUMN review_artifact_provider TEXT");
  }
  if (projectColumns.length > 0 && !projectColumns.includes("bypass_permissions")) {
    db.exec("ALTER TABLE projects ADD COLUMN bypass_permissions INTEGER NOT NULL DEFAULT 1");
  }
  if (projectColumns.length > 0 && !projectColumns.includes("plan_gate")) {
    db.exec("ALTER TABLE projects ADD COLUMN plan_gate INTEGER NOT NULL DEFAULT 0");
  }
  if (projectColumns.length > 0 && !projectColumns.includes("reserved")) {
    db.exec("ALTER TABLE projects ADD COLUMN reserved INTEGER NOT NULL DEFAULT 0");
  }
  if (projectColumns.length > 0 && !projectColumns.includes("harness")) {
    db.exec("ALTER TABLE projects ADD COLUMN harness TEXT");
  }
  if (projectColumns.length > 0 && !projectColumns.includes("knowledge_scope")) {
    db.exec("ALTER TABLE projects ADD COLUMN knowledge_scope TEXT");
  }
  if (projectColumns.length > 0 && !projectColumns.includes("orchestration_profile")) {
    db.exec("ALTER TABLE projects ADD COLUMN orchestration_profile TEXT");
  }
  ensureProjectsRelatedColumn(db);
  ensureKnowledgeVerdictRepoColumn(db);
  ensurePublicKnowledgeShape(db);
  ensurePersonaFloorDecisionCheckColumn(db);
  ensureReviewShareColumns(db);
  ensureDocsAndShareGrants(db);
  ensureShareGrantsFolderType(db);
  ensureWorkerHygieneShape(db);
  ensurePersonaQuestionAnsweredColumn(db);

  const userPrefsColumns = columns("user_prefs");
  if (
    userPrefsColumns.length > 0 &&
    !userPrefsColumns.includes("orchestration_profile")
  ) {
    db.exec("ALTER TABLE user_prefs ADD COLUMN orchestration_profile TEXT");
  }

  const launchColumns = columns("launches");
  if (launchColumns.length > 0 && !launchColumns.includes("harness")) {
    db.exec("ALTER TABLE launches ADD COLUMN harness TEXT");
  }
  if (launchColumns.length > 0 && !launchColumns.includes("codex_event_log")) {
    db.exec("ALTER TABLE launches ADD COLUMN codex_event_log TEXT");
  }
  if (launchColumns.length > 0 && !launchColumns.includes("codex_model")) {
    db.exec("ALTER TABLE launches ADD COLUMN codex_model TEXT");
  }
  if (launchColumns.length > 0 && !launchColumns.includes("codex_effort")) {
    db.exec("ALTER TABLE launches ADD COLUMN codex_effort TEXT");
  }
  if (launchColumns.length > 0 && !launchColumns.includes("provision_snapshot")) {
    db.exec("ALTER TABLE launches ADD COLUMN provision_snapshot TEXT");
  }

  const sessionColumns = columns("sessions");
  if (sessionColumns.length > 0 && !sessionColumns.includes("kind")) {
    db.exec("ALTER TABLE sessions ADD COLUMN kind TEXT");
  }
  if (sessionColumns.length > 0 && !sessionColumns.includes("agent_type")) {
    db.exec("ALTER TABLE sessions ADD COLUMN agent_type TEXT");
  }
  if (sessionColumns.length > 0 && !sessionColumns.includes("agent_id")) {
    db.exec("ALTER TABLE sessions ADD COLUMN agent_id TEXT");
  }
  if (sessionColumns.length > 0) {
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_session_id)"
    );
  }

  const orchestrationRunColumns = columns("orchestration_runs");
  if (orchestrationRunColumns.length > 0) {
    // At most one active (queued/running) run per ticket: a DB-level guard so
    // two concurrent kick-off POSTs can't both pass the check-then-insert in
    // ensureOrchestrationRun and mint duplicate live runs. Partial so a ticket's
    // terminal run history never conflicts, and NULL ticket_ids stay distinct.
    //
    // Reconcile BEFORE creating the index. A database written under earlier code
    // that lacked this guard may already hold two or more active runs for one
    // ticket; because this repair runs on every boot, an unguarded CREATE UNIQUE
    // INDEX against such data would throw and brick startup. For each offending
    // ticket keep the most-recent active run (max created_at, tiebreak rowid) and
    // retire the rest to `lost`. Idempotent: a no-op once at most one active run
    // remains per ticket.
    const dupTickets = db
      .query(
        `SELECT ticket_id FROM orchestration_runs
          WHERE ticket_id IS NOT NULL AND status IN ('queued','running')
          GROUP BY ticket_id HAVING COUNT(*) > 1`
      )
      .all() as Array<{ ticket_id: string }>;
    for (const { ticket_id } of dupTickets) {
      const active = db
        .query(
          `SELECT id FROM orchestration_runs
            WHERE ticket_id = ? AND status IN ('queued','running')
            ORDER BY created_at DESC, rowid DESC`
        )
        .all(ticket_id) as Array<{ id: string }>;
      // Keep the first (most recent); retire every older active run.
      for (const { id } of active.slice(1)) {
        db.run(
          `UPDATE orchestration_runs
              SET status = 'lost',
                  ended_at = datetime('now'),
                  last_event_at = datetime('now'),
                  error = 'superseded — duplicate active run reconciled at migration'
            WHERE id = ? AND status IN ('queued','running')`,
          [id]
        );
      }
    }

    // The dedup above makes the create succeed on the normal path; the try/catch
    // is a last-resort guard so an unresolved violation logs and continues rather
    // than rethrowing and bricking boot.
    try {
      db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_orch_runs_active_ticket ON orchestration_runs(ticket_id) WHERE status IN ('queued','running')"
      );
    } catch (e) {
      console.error(
        "[migrations] could not create idx_orch_runs_active_ticket; continuing without the active-run guard",
        e
      );
    }
  }

  const knowledgeRetrievalColumns = columns("knowledge_retrievals");
  if (
    knowledgeRetrievalColumns.length > 0 &&
    !knowledgeRetrievalColumns.includes("injected")
  ) {
    db.exec("ALTER TABLE knowledge_retrievals ADD COLUMN injected INTEGER");
  }
  if (
    knowledgeRetrievalColumns.length > 0 &&
    !knowledgeRetrievalColumns.includes("launch_id")
  ) {
    db.exec("ALTER TABLE knowledge_retrievals ADD COLUMN launch_id TEXT");
  }
  if (knowledgeRetrievalColumns.length > 0) {
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_knowledge_retrievals_launch ON knowledge_retrievals(launch_id)"
    );
  }

  // Mirror of Migration 053: a no-op once every table has the 053 shape.
  ensureRetrievalObservabilityShape(db);
  // Mirror of Migration 077.
  ensureKnowledgeRetrievalLatencyColumn(db);
  // Mirror of Migration 078.
  ensureKnowledgeRetrievalPushSurfaces(db);
  // Mirror of Migration 082: the table only; the backfill runs once, with the migration.
  ensureBoardTable(db);
  // Mirror of Migration 091: a no-op while the insert trigger is in place.
  ensurePersonaMessagesFts(db);
  // Mirror of Migration 096, so a column added to doc_comments after a build recorded 096 still lands.
  ensureDocSharingShape(db);

  // Mirror of Migration 049 — the recency indexes backing the last-activity
  // ordering in getAllSessions/getActiveWork, recreated on every boot so a
  // database that recorded past 049 without them still self-heals.
  const transcriptEventColumns = columns("transcript_events");
  if (transcriptEventColumns.length > 0) {
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_transcript_events_session_created ON transcript_events(session_id, created_at)"
    );
  }
  const eventColumns = columns("events");
  if (eventColumns.length > 0) {
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_events_session_created ON events(session_id, created_at)"
    );
  }
}

/**
 * Brings knowledge_retrievals, expert_exchanges and knowledge_changes to the
 * migration-053 shape: a knowledge_retrievals table without the doc_get
 * surface or the observability columns, or an expert_exchanges table whose
 * session_id is still NOT NULL or lacks the exchange columns, is rebuilt with
 * its rows copied; knowledge_changes gets its privacy columns by ALTER. Every
 * step checks the current shape first, so it is idempotent and safe to re-run
 * after an interrupted run. A table that does not exist is left alone.
 */
function ensureRetrievalObservabilityShape(db: Database): void {
  const info = (table: string) =>
    db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string; notnull: number }>;
  const retrievals = db
    .query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'knowledge_retrievals'")
    .get() as { sql: string } | null;
  const retrievalColumns = info("knowledge_retrievals").map((c) => c.name);
  if (
    retrievals &&
    (!retrievals.sql.includes("'doc_get'") ||
      KNOWLEDGE_RETRIEVALS_053_COLUMNS.some((c) => !retrievalColumns.includes(c)))
  ) {
    rebuildTable(db, "knowledge_retrievals", knowledgeRetrievalsTableSql, KNOWLEDGE_RETRIEVALS_INDEXES_SQL);
  }
  const exchangeInfo = info("expert_exchanges");
  if (
    exchangeInfo.length > 0 &&
    (exchangeInfo.some((c) => c.name === "session_id" && c.notnull === 1) ||
      EXPERT_EXCHANGES_053_COLUMNS.some((c) => !exchangeInfo.some((i) => i.name === c)))
  ) {
    rebuildTable(db, "expert_exchanges", expertExchangesTableSql, EXPERT_EXCHANGES_INDEXES_SQL);
  }
  ensureKnowledgeChangeColumns(db);
}

/**
 * Adds knowledge_changes' `personal` / `owner_user` columns (migration 053)
 * where the table exists without them. Idempotent; the knowledge-data
 * migrations' schema step runs it too, so a backfill of those columns plans
 * against the shape the collector gives the table.
 */
export function ensureKnowledgeChangeColumns(db: Database): void {
  const changeColumns = (db.query("PRAGMA table_info(knowledge_changes)").all() as Array<{ name: string }>).map(
    (c) => c.name
  );
  if (changeColumns.length > 0 && !changeColumns.includes("personal")) {
    db.exec("ALTER TABLE knowledge_changes ADD COLUMN personal INTEGER");
  }
  if (changeColumns.length > 0 && !changeColumns.includes("owner_user")) {
    db.exec("ALTER TABLE knowledge_changes ADD COLUMN owner_user TEXT");
  }
}

/**
 * Rebuilds `table` to the shape `createSql` declares, copying every row over the
 * columns the old and new shapes share (a column only the new shape has reads
 * NULL / its default), then recreating `indexesSql`. A column the new shape
 * lacks is refused (the rebuild throws) unless it is named in `dropped`, so a
 * shape change never discards data silently. Foreign keys are off for
 * the swap, the SQLite-recommended procedure, and restored to their prior
 * setting; the copy runs in one transaction so a failure leaves the old table.
 */
export function rebuildTable(
  db: Database,
  table: string,
  createSql: (name: string) => string,
  indexesSql: string,
  dropped: readonly string[] = []
): void {
  const fkOn = (db.query("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys === 1;
  const scratch = `${table}_rebuild`;
  const oldColumns = (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (c) => c.name
  );
  if (fkOn) db.exec("PRAGMA foreign_keys=OFF");
  try {
    db.transaction(() => {
      db.exec(`DROP TABLE IF EXISTS ${scratch}`);
      db.exec(createSql(scratch));
      const newColumns = (db.query(`PRAGMA table_info(${scratch})`).all() as Array<{ name: string }>).map(
        (c) => c.name
      );
      const lost = oldColumns.filter((c) => !newColumns.includes(c) && !dropped.includes(c));
      if (lost.length > 0) {
        throw new Error(`rebuilding ${table} would drop column(s) ${lost.join(", ")} not listed as dropped`);
      }
      const shared = oldColumns.filter((c) => newColumns.includes(c)).join(", ");
      db.exec(`INSERT INTO ${scratch} (${shared}) SELECT ${shared} FROM ${table}`);
      db.exec(`DROP TABLE ${table}`);
      db.exec(`ALTER TABLE ${scratch} RENAME TO ${table}`);
      if (indexesSql.trim()) db.exec(indexesSql);
    })();
  } finally {
    if (fkOn) db.exec("PRAGMA foreign_keys=ON");
  }
}
