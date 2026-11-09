-- Schema of a production Standup database at schema version 58, captured with
-- sqlite3 .schema (sqlite_master in rowid order). No data rows.
--
-- Omitted: the sqlite-vec virtual table knowledge_chunks_vec and its shadow
-- tables (knowledge_chunks_vec_*), which need the vec0 extension; the FTS5
-- shadow tables (knowledge_fts_data/_idx/_content/_docsize/_config), which
-- the CREATE VIRTUAL TABLE knowledge_fts statement below recreates; the
-- internal sqlite_sequence table; and the automatic indexes behind UNIQUE /
-- PRIMARY KEY constraints (they have no SQL of their own).
--
-- schema_version records 1..58 except 52, which is a reserved version
-- (RESERVED_MIGRATION_VERSIONS) and was never applied.

CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    emoji TEXT,
    icon_path TEXT,
    expert TEXT,
    branch TEXT DEFAULT 'main',
    repos_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  , setup TEXT, launch_args TEXT, worktree_root TEXT, provision TEXT, launch_subdir TEXT, review_process TEXT, review_command TEXT, daily_review_active INTEGER, review_lenses TEXT, in_place INTEGER, review_artifact_provider TEXT, plan_gate INTEGER NOT NULL DEFAULT 0, reserved INTEGER NOT NULL DEFAULT 0, harness TEXT, knowledge_scope TEXT, orchestration_profile TEXT, bypass_permissions INTEGER NOT NULL DEFAULT 1);
CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    seq INTEGER NOT NULL,
    type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(session_id, seq)
  );
CREATE INDEX idx_events_session ON events(session_id);
CREATE INDEX idx_events_type ON events(type);
CREATE TABLE asks (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    kind TEXT NOT NULL CHECK (kind IN ('ask_human', 'permission_prompt')),
    question TEXT NOT NULL,
    options_json TEXT,
    answer TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'answered', 'timeout', 'cancelled')),
    created_at TEXT DEFAULT (datetime('now')),
    resolved_at TEXT
  , gate TEXT, request_id TEXT, call_hash TEXT, floor_expires_at TEXT, floor_delivered_at TEXT);
CREATE INDEX idx_asks_session ON asks(session_id);
CREATE INDEX idx_asks_status ON asks(status);
CREATE TABLE steers (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    body TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'cancelled')),
    created_at TEXT DEFAULT (datetime('now')),
    delivered_at TEXT
  );
CREATE INDEX idx_steers_session ON steers(session_id);
CREATE INDEX idx_steers_status ON steers(status);
CREATE TABLE stall_detections (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    reason TEXT NOT NULL,
    tool_calls INTEGER DEFAULT 0,
    quiet_minutes INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
CREATE INDEX idx_stall_session ON stall_detections(session_id);
CREATE TABLE schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TEXT DEFAULT (datetime('now'))
  );
CREATE TABLE "checkpoints" (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    source TEXT NOT NULL CHECK (source IN ('structural', 'self-reported', 'auto')),
    summary TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
CREATE INDEX idx_checkpoints_session ON checkpoints(session_id);
CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
CREATE TABLE "sessions" (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id),
    title TEXT,
    cwd TEXT NOT NULL,
    parent_session_id TEXT REFERENCES sessions(id),
    status TEXT NOT NULL DEFAULT 'running'
      CHECK (status IN ('running', 'idle', 'waiting', 'stalled', 'done')),
    started_at TEXT DEFAULT (datetime('now')),
    ended_at TEXT
  , created_actor TEXT, owner_actor TEXT, kind TEXT, agent_type TEXT, agent_id TEXT);
CREATE INDEX idx_sessions_project ON sessions(project_id);
CREATE INDEX idx_sessions_status ON sessions(status);
CREATE TABLE tickets (
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
  , reported_by_actor TEXT, note TEXT, issue_id TEXT, task_url TEXT, attempt_group TEXT);
CREATE INDEX idx_tickets_project ON tickets(project_id);
CREATE INDEX idx_tickets_status ON tickets(status);
CREATE INDEX idx_tickets_launch ON tickets(launch_id);
CREATE TABLE "launches" (
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
  , requester TEXT, idempotency_key TEXT, harness TEXT, codex_event_log TEXT, codex_model TEXT, codex_effort TEXT, worker_token_hash TEXT);
CREATE INDEX idx_launches_project ON launches(project_id);
CREATE INDEX idx_launches_worktree ON launches(worktree_path);
CREATE TABLE transcript_events (
    session_id TEXT NOT NULL REFERENCES sessions(id),
    seq INTEGER NOT NULL,
    event_json TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (session_id, seq)
  );
CREATE TABLE transcript_event_identities (
    session_id TEXT NOT NULL REFERENCES sessions(id),
    event_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    idempotency_key TEXT,
    PRIMARY KEY (session_id, event_id)
  );
CREATE UNIQUE INDEX idx_transcript_event_idempotency
    ON transcript_event_identities(session_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
CREATE TABLE task_runs (
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
  , attempt_group TEXT, attempt_status TEXT);
CREATE INDEX idx_task_runs_project ON task_runs(project_id);
CREATE INDEX idx_task_runs_status ON task_runs(status);
CREATE INDEX idx_task_runs_worktree ON task_runs(worktree_path);
CREATE INDEX idx_task_runs_session ON task_runs(session_id);
CREATE TABLE users (
    alias TEXT PRIMARY KEY,
    display TEXT,
    first_seen TEXT DEFAULT (datetime('now')),
    last_seen TEXT DEFAULT (datetime('now'))
  , via_tunnel INTEGER NOT NULL DEFAULT 0);
CREATE TABLE actors (
    id TEXT PRIMARY KEY,
    display TEXT,
    github_login TEXT,
    merged_into TEXT REFERENCES actors(id),
    first_seen TEXT DEFAULT (datetime('now')),
    last_seen TEXT DEFAULT (datetime('now'))
  );
CREATE TABLE session_participants (
    session_id TEXT NOT NULL REFERENCES sessions(id),
    actor_id TEXT NOT NULL REFERENCES actors(id),
    first_seen TEXT DEFAULT (datetime('now')),
    contribution_count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (session_id, actor_id)
  );
CREATE INDEX idx_session_participants_actor
    ON session_participants(actor_id);
CREATE TABLE user_prefs (
    alias TEXT PRIMARY KEY,
    personal_instructions TEXT,
    review_rigor TEXT,
    deploy_target_json TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  , orchestration_profile TEXT);
CREATE TABLE user_project_prefs (
    alias TEXT NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id),
    personal_instructions TEXT,
    review_rigor TEXT,
    deploy_target_json TEXT,
    updated_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (alias, project_id)
  );
CREATE INDEX idx_user_project_prefs_alias
    ON user_project_prefs(alias);
CREATE TABLE plan_approvals (
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
CREATE INDEX idx_plan_approvals_launch ON plan_approvals(launch_id);
CREATE INDEX idx_plan_approvals_status ON plan_approvals(status);
CREATE TABLE "review_findings" (
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
CREATE INDEX idx_review_findings_ticket ON review_findings(ticket_id);
CREATE TABLE knowledge_changes (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    slug TEXT NOT NULL,
    kind TEXT NOT NULL
      CHECK (kind IN ('accepted', 'removed', 'reconciled', 'contradiction', 'distilled')),
    title TEXT NOT NULL,
    session_id TEXT,
    contradicted TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  , personal INTEGER, owner_user TEXT);
CREATE INDEX idx_knowledge_changes_created
    ON knowledge_changes(created_at);
CREATE INDEX idx_knowledge_changes_project
    ON knowledge_changes(project_id);
CREATE TABLE knowledge_resolutions (
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
CREATE INDEX idx_knowledge_resolutions_project
    ON knowledge_resolutions(project_id);
CREATE INDEX idx_knowledge_resolutions_status
    ON knowledge_resolutions(status);
CREATE UNIQUE INDEX idx_launches_idempotency
    ON launches(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_task_runs_attempt_group
    ON task_runs(attempt_group);
CREATE TABLE session_messages (
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
CREATE INDEX idx_session_messages_to ON session_messages(to_session_id);
CREATE INDEX idx_session_messages_status ON session_messages(status);
CREATE TABLE shared_notes (
    id TEXT PRIMARY KEY,
    project_id TEXT,
    from_session_id TEXT,
    from_label TEXT,
    body TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
CREATE INDEX idx_shared_notes_project ON shared_notes(project_id);
CREATE INDEX idx_sessions_parent ON sessions(parent_session_id);
CREATE TABLE digests (
    id TEXT PRIMARY KEY,
    created_at TEXT DEFAULT (datetime('now')),
    period_start TEXT NOT NULL,
    period_end TEXT NOT NULL,
    body TEXT NOT NULL,
    projects_json TEXT NOT NULL DEFAULT '[]',
    counts_json TEXT NOT NULL DEFAULT '{}'
  );
CREATE INDEX idx_digests_created ON digests(created_at);
CREATE TABLE knowledge (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        slug TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        tags_json TEXT,
        embedding_json TEXT,
        file_path TEXT NOT NULL,
        updated_at TEXT DEFAULT (datetime('now')),
        generated_from_sha TEXT,
        generated_at TEXT,
        related_json TEXT,
        -- Provenance. Fail-closed: a row of unknown origin is 'untrusted', so
        -- nothing launders into an agent's context by omission. Trusted write
        -- paths stamp a higher class explicitly.
        origin_class TEXT NOT NULL DEFAULT 'untrusted',
        source_session_id TEXT,
        -- Source-kind dimension, orthogonal to origin_class's
        -- trust. NOT NULL DEFAULT 'code' so an unclassified or backfilled row
        -- reads code-derived — every doc predating this column was.
        source_kind TEXT NOT NULL DEFAULT 'code',
        -- Scope + owning user (per-user knowledge). scope answers WHO a doc is
        -- for — 'project' (default, every legacy doc's behavior), 'global'
        -- (promoted to the whole corpus), or 'user' (owned by one user). NOT
        -- NULL DEFAULT 'project' so an unclassified or backfilled row reads
        -- project-scoped, exactly as it behaved before this dimension existed.
        -- owner_user names the owning user of a 'user'-scoped doc; nullable and
        -- NOT hard-FK'd (it keys to a user alias resolved at retrieval time).
        scope TEXT NOT NULL DEFAULT 'project',
        owner_user TEXT,
        -- Confidence bookkeeping. Nullable: a legacy doc asserts
        -- no opinion, and current confidence is DERIVED from these, never
        -- stored (see confidence.ts).
        confidence REAL,
        last_verified_at TEXT,
        half_life_days REAL,
        -- Re-verification result. Written by the re-verification
        -- cron (setDocVerdict), never by upsertDoc — so a resync preserves the
        -- flag. Nullable: a doc that has never been re-verified has no verdict.
        verdict TEXT,
        disputes_json TEXT, content_hash TEXT, content_first_seen TEXT, writer_stamp TEXT,
        UNIQUE(project_id, slug)
      );
CREATE INDEX idx_knowledge_project ON knowledge(project_id);
CREATE TABLE knowledge_edges (
        id TEXT PRIMARY KEY,
        src_doc_id TEXT NOT NULL,
        dst_doc_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        weight REAL,
        confidence REAL,
        evidence TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(src_doc_id, dst_doc_id, kind)
      );
CREATE INDEX idx_knowledge_edges_src ON knowledge_edges(src_doc_id);
CREATE INDEX idx_knowledge_edges_dst ON knowledge_edges(dst_doc_id);
CREATE TABLE knowledge_chunks (
        id TEXT PRIMARY KEY,
        knowledge_id TEXT NOT NULL REFERENCES knowledge(id) ON DELETE CASCADE,
        chunk_index INTEGER NOT NULL,
        text TEXT NOT NULL,
        embedding_json TEXT NOT NULL, chunker_version INTEGER,
        UNIQUE(knowledge_id, chunk_index)
      );
CREATE INDEX idx_chunks_knowledge ON knowledge_chunks(knowledge_id);
CREATE TABLE knowledge_graph_meta (
        id INTEGER PRIMARY KEY CHECK (id = 0),
        chunk_generation INTEGER NOT NULL DEFAULT 0
      , vector_search_suspended INTEGER NOT NULL DEFAULT 0);
CREATE TABLE knowledge_drafts (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        slug TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        tags_json TEXT,
        file_path TEXT NOT NULL,

        -- Provenance, stamped by the collector rather than the agent.
        generated_from_sha TEXT,
        generated_at TEXT,
        generated_by_launch_id TEXT,

        -- Review state. 'pending' is the only state a row lives in for long:
        -- accept moves the file and deletes the row, discard deletes both.
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'accepted', 'discarded')),

        -- Set on regenerate: the accepted doc this draft would overwrite.
        -- NULL on a first bootstrap, which is why review shows a preview
        -- then and a diff only on regeneration.
        replaces_slug TEXT,

        -- Source kind + confidence bookkeeping, stamped at propose
        -- time. Held on the row so a draft edit round-trips them; the accepted
        -- doc gets them from the draft file's frontmatter on accept.
        source_kind TEXT,
        confidence REAL,
        last_verified_at TEXT,
        half_life_days REAL,

        -- Scope + owning user the propose path stamped on the draft (per-user
        -- knowledge). Held on the row — RAW, nullable, no 'project' default,
        -- unlike the accepted knowledge table — so a body edit round-trips the
        -- draft's authored audience instead of dropping it and letting a fresh
        -- accept default the scopeless file to 'project'. Carried into the
        -- accepted doc from the draft file's frontmatter on accept.
        scope TEXT,
        owner_user TEXT,

        reviewed_at TEXT,
        updated_at TEXT DEFAULT (datetime('now')), verdict TEXT NOT NULL DEFAULT 'unverified', disputes_json TEXT,
        UNIQUE(project_id, slug)
      );
CREATE INDEX idx_knowledge_drafts_project
        ON knowledge_drafts(project_id);
CREATE TABLE orchestration_profiles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    scope TEXT NOT NULL,
    owner_key TEXT NOT NULL,
    definition_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(scope, owner_key, name)
  );
CREATE TABLE orchestration_runs (
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
CREATE TABLE orchestration_gate_results (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    round INTEGER NOT NULL,
    step_index INTEGER NOT NULL,
    kind TEXT NOT NULL,
    passed INTEGER NOT NULL,
    detail TEXT,
    created_at TEXT NOT NULL
  );
CREATE UNIQUE INDEX idx_orch_runs_active_ticket ON orchestration_runs(ticket_id) WHERE status IN ('queued','running');
CREATE INDEX idx_transcript_events_session_created
    ON transcript_events(session_id, created_at);
CREATE INDEX idx_events_session_created
    ON events(session_id, created_at);
CREATE TABLE persona_threads (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    channel TEXT NOT NULL DEFAULT 'console',
    external_ref TEXT,
    title TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  , audience TEXT NOT NULL DEFAULT 'private', claude_session_id TEXT);
CREATE INDEX idx_persona_threads_owner ON persona_threads(owner, channel);
CREATE TABLE persona_messages (
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
    created_at TEXT NOT NULL, recommended_option INTEGER, attachments_json TEXT,
    UNIQUE (thread_id, seq)
  );
CREATE UNIQUE INDEX idx_persona_messages_idem
    ON persona_messages(thread_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE TABLE persona_inbox (
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
CREATE INDEX idx_persona_inbox_due ON persona_inbox(owner, status, not_before);
CREATE TABLE persona_state (
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
CREATE TABLE persona_jobs (
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
CREATE INDEX idx_persona_jobs_owner ON persona_jobs(owner, status);
CREATE TABLE persona_job_launches (
    job_id TEXT NOT NULL,
    launch_id TEXT NOT NULL,
    persona_plan_gate INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    PRIMARY KEY (job_id, launch_id)
  );
CREATE INDEX idx_persona_job_launches_launch ON persona_job_launches(launch_id);
CREATE TABLE persona_approvals (
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
  , thread_id TEXT, hold_rule TEXT);
CREATE INDEX idx_persona_approvals_owner ON persona_approvals(owner, status);
CREATE INDEX idx_launches_session ON launches(session_id);
CREATE UNIQUE INDEX idx_persona_threads_external_ref
    ON persona_threads(owner, channel, external_ref) WHERE external_ref IS NOT NULL;
CREATE TABLE "knowledge_retrievals" (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_project TEXT NOT NULL,
    doc_slug TEXT NOT NULL,
    query TEXT NOT NULL,
    rank INTEGER NOT NULL,
    score REAL,
    surface TEXT NOT NULL CHECK (surface IN ('search', 'expert', 'inject', 'doc_get')),
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
    drop_reason TEXT
  );
CREATE INDEX idx_knowledge_retrievals_doc
    ON knowledge_retrievals(doc_project, doc_slug);
CREATE INDEX idx_knowledge_retrievals_created
    ON knowledge_retrievals(created_at);
CREATE INDEX idx_knowledge_retrievals_launch
    ON knowledge_retrievals(launch_id);
CREATE INDEX idx_knowledge_retrievals_session
    ON knowledge_retrievals(session_id);
CREATE TABLE "expert_exchanges" (
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
  );
CREATE INDEX idx_expert_session ON expert_exchanges(session_id);
CREATE INDEX idx_expert_created ON expert_exchanges(created_at);
CREATE TABLE plan_review_remarks (
      plan_id TEXT PRIMARY KEY,
      feedback TEXT,
      note TEXT,
      delivered INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
CREATE UNIQUE INDEX idx_asks_request_id ON asks(session_id, request_id) WHERE request_id IS NOT NULL;
CREATE TABLE knowledge_judgments (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        subject_slug TEXT NOT NULL,
        candidate_project_id TEXT,
        candidate_slug TEXT,
        outcome TEXT NOT NULL
          CHECK (outcome IN ('contradicts', 'consistent', 'judge_error', 'queued')),
        method TEXT,
        reason TEXT,
        attempts INTEGER NOT NULL DEFAULT 1,
        judged_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
CREATE INDEX idx_knowledge_judgments_subject
        ON knowledge_judgments(project_id, subject_slug);
CREATE TABLE knowledge_verifications (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        slug TEXT NOT NULL,
        body_hash TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        repo_path TEXT,
        last_outcome TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
CREATE TABLE code_symbols (
        project_id TEXT NOT NULL,
        repo_path TEXT NOT NULL,
        sha TEXT NOT NULL,
        file TEXT NOT NULL,
        line INTEGER NOT NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        signature TEXT
      );
CREATE INDEX idx_code_symbols_name ON code_symbols(project_id, name);
CREATE INDEX idx_code_symbols_file
        ON code_symbols(project_id, repo_path, file);
CREATE INDEX idx_knowledge_scope_owner ON knowledge(scope, owner_user);
CREATE VIRTUAL TABLE knowledge_fts USING fts5(
  id UNINDEXED, slug, title, body, tags, tokenize='porter unicode61'
);
CREATE TABLE knowledge_freshness (
  project_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  anchor_at TEXT,
  cap REAL,
  findings_json TEXT NOT NULL DEFAULT '[]',
  about_repo INTEGER NOT NULL DEFAULT 0,
  checked_at TEXT NOT NULL,
  PRIMARY KEY (project_id, slug)
);
CREATE TABLE persona_schedules (
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
CREATE INDEX idx_persona_schedules_due
    ON persona_schedules(owner, enabled, next_run_at);
CREATE TABLE persona_schedule_runs (
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
CREATE UNIQUE INDEX idx_persona_schedule_runs_slot
    ON persona_schedule_runs(schedule_id, scheduled_for) WHERE trigger != 'manual';
CREATE INDEX idx_persona_schedule_runs_schedule
    ON persona_schedule_runs(schedule_id, started_at);
CREATE INDEX idx_persona_schedule_runs_status
    ON persona_schedule_runs(owner, status);
CREATE TABLE persona_launch_queue (
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
CREATE INDEX idx_persona_launch_queue_owner
    ON persona_launch_queue(owner, status, created_at);
CREATE TABLE persona_signals (
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
CREATE INDEX idx_persona_signals_kind ON persona_signals(owner, kind, occurred_at);
CREATE INDEX idx_persona_signals_subject ON persona_signals(owner, subject);
CREATE TABLE persona_knowledge_decisions (
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
CREATE INDEX idx_persona_knowledge_decisions_owner
    ON persona_knowledge_decisions(owner, created_at);
CREATE INDEX idx_persona_knowledge_decisions_doc
    ON persona_knowledge_decisions(project_id, draft_slug);
CREATE TABLE persona_attachments (
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
CREATE INDEX idx_persona_attachments_turn
    ON persona_attachments(thread_id, batch_key, message_id);

INSERT INTO schema_version (version) VALUES
  (1), (2), (3), (4), (5), (6), (7), (8), (9), (10),
  (11), (12), (13), (14), (15), (16), (17), (18), (19), (20),
  (21), (22), (23), (24), (25), (26), (27), (28), (29), (30),
  (31), (32), (33), (34), (35), (36), (37), (38), (39), (40),
  (41), (42), (43), (44), (45), (46), (47), (48), (49), (50),
  (51), (53), (54), (55), (56), (57), (58);
