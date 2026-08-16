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
