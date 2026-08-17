import type { Database } from "bun:sqlite";

const MIGRATIONS = [
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

  // Migration 002: Launches (Phase 4)
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
  // Phase 4 reads project.setup to run a project's setup command in a fresh
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
  // 'worktree' so the collector-side gate on /api/knowledge/propose (phase-7
  // Step 2) can require it specifically — without that, any launch could
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
  // volume (e.g. a case-sensitive one for Brazil builds).
  `
  ALTER TABLE projects ADD COLUMN worktree_root TEXT;
  `,

  // Migration 011: projects.provision / projects.launch_subdir
  //
  // provision replaces `git worktree add` with a custom command that builds a
  // usable working dir (e.g. `brazil workspace create … --package …`).
  // launch_subdir is where inside it the agent starts and setup runs (e.g.
  // `src/<pkg>` for a Brazil workspace). Both NULL → default worktree behavior.
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
];

export function runMigrations(db: Database): void {
  // Get current version
  let currentVersion = 0;
  try {
    const row = db.query("SELECT MAX(version) as v FROM schema_version").get() as { v: number } | null;
    currentVersion = row?.v ?? 0;
  } catch {
    // Table doesn't exist yet, start from 0
  }

  // Run pending migrations, recording each version here rather than inside
  // the migration body — a migration that has to remember to stamp its own
  // version silently stops advancing the moment someone forgets.
  for (let i = currentVersion; i < MIGRATIONS.length; i++) {
    db.exec(MIGRATIONS[i]);
    db.run("INSERT OR IGNORE INTO schema_version (version) VALUES (?)", [i + 1]);
  }
}
