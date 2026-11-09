import type { PersonaUsage } from "./job-budget.js";

// ============================================================================
// Project Registry
// ============================================================================

/**
 * Which agent CLI a launch drives. `claude` is the default harness — observed
 * through hooks + its JSONL transcript and launched by launcher.ts, unchanged.
 * `codex` is the additive second harness: launched headless via `codex exec
 * --json` and observed through its JSONL event stream (see the Codex harness
 * adapter). Unset is treated as `claude`.
 */
export type HarnessId = "claude" | "codex";

export interface Project {
  id: string;
  name: string;
  emoji?: string;
  iconPath?: string;
  repos: string[];
  setup?: string;
  branch: string;
  /**
   * Extra CLI flags passed to `claude` when the console launches a session
   * for this project — e.g. `--permission-mode acceptEdits`. A single string,
   * tokenized into argv at launch (quotes honored); unset means no extra
   * flags. Not a shell command — that is `setup`. `--model`/`--effort` are
   * chosen per-launch in the composer and are not set here.
   */
  launchArgs?: string;
  /**
   * Where this project's launched worktrees are created. Overrides the global
   * `worktreeRoot` setting, which in turn overrides `STANDUP_WORKTREE_ROOT`
   * and the built-in default. A leading `~` is expanded. Useful when a repo
   * must be checked out onto a specific volume — e.g. a case-sensitive one
   * for a build that needs one.
   */
  worktreeRoot?: string;
  /**
   * Optional shell command that provisions a launch's working directory,
   * REPLACING the default `git worktree add`. Set it when a plain worktree
   * isn't a usable working dir — e.g. a package whose build needs a whole
   * workspace of checkouts (read with the workspace project layout, see the
   * collector's project-layout/layout.ts).
   *
   * Run once per launch from the parent of the target dir, with these vars in
   * the environment: `STANDUP_WORKDIR` (the dir to produce), its basename
   * `STANDUP_WORKDIR_NAME` (use for a `--name`), `STANDUP_REPO` (repos[0]),
   * `STANDUP_BRANCH`, `STANDUP_PROJECT`. The command must leave a ready
   * directory at `STANDUP_WORKDIR`. Generic — Standup knows nothing about what
   * it does; cleanup is a path-guarded `rm -rf` of that dir, not a git op.
   */
  provision?: string;
  /**
   * Subdirectory of the launch working dir to start the agent in (and run
   * `setup` from). For a provisioned workspace the package lives in its
   * packages dir (`packages/<pkg>`), so the agent should start there rather
   * than the workspace root. Empty means the working dir itself.
   */
  launchSubdir?: string;
  /**
   * Default launch mode. When true, launches for this project skip
   * `git worktree add` and run `claude` directly in `repos[0]` — reusing the
   * existing workspace instead of provisioning a fresh one. The composer can
   * still override this per launch. Cleanup leaves the working directory
   * untouched (it is the real repo), same as an adopted launch.
   *
   * Ignored when a `provision` command is set (that path always builds its own
   * dir) and when the project has no repo (nothing to reuse).
   */
  inPlace?: boolean;
  /**
   * How this project gates a ticket's developing -> needs_review transition
   * (the "review gate"), run when the implementation agent calls
   * mark_ready_for_review. "pause" (or unset) just waits for a human to mark
   * the ticket complete; "command" runs `reviewCommand` in the ticket's
   * worktree and extracts a review (pull request) URL onto the ticket's
   * `reviewUrl`; "review-agent" fires a short follow-up launchSession whose
   * task is to prepare the change for review (needed where opening a code
   * review is itself agentic). Unset is treated as "pause".
   */
  reviewProcess?: ReviewProcess;
  /**
   * Raw shell command run in the ticket's worktree when `reviewProcess` is
   * "command" — e.g. `gh pr create --fill`. Its stdout is captured and scanned
   * for a review (pull request) URL. Ignored for the other review processes.
   */
  reviewCommand?: string;
  /**
   * The code-review adapter this project's changes are reviewed through (see
   * the collector's code-review/adapter.ts). `generic` opts the project in to
   * a linked code review: its code_review stage always applies and its review
   * packets must link the review. `github-pr` composes a draft GitHub PR.
   * Unset auto-detects: an adapter whose code host the org profile names
   * matches a checkout's remote, else `github-pr` for a project with a repo.
   */
  codeReviewAdapter?: CodeReviewAdapterId;
  /**
   * Whether the daily-review fan-out runs for this project — a set of
   * read-only lens agents that propose tickets each day. Unset/false means no
   * automatic review.
   */
  dailyReviewActive?: boolean;
  /**
   * Which review lenses the daily-review fan-out uses for this project. Unset
   * falls back to the built-in REVIEW_LENSES set.
   */
  reviewLenses?: string[];
  /**
   * Whether a launch for this project goes through the plan-approval gate: the
   * agent must submit a plan (relevant files + plan + a machine-checkable
   * acceptance criterion) and wait for a human to approve it before doing the
   * work, and must satisfy the approved acceptance criterion before it may call
   * mark_ready_for_review. Opt-in and unset/false by default, so existing
   * launches are unaffected. A per-launch flag on the launch request overrides
   * this. Mirrors Devin Interactive Planning / Jules plan approval.
   */
  planGate?: boolean;
  /**
   * Whether this project's Claude launches run with permissions bypassed
   * (`--permission-mode bypassPermissions`) behind Standup's safety floor — a
   * PreToolUse hook that routes outward-facing and destructive steps (pushes,
   * deploys, mutating AWS calls outside personal accounts, deletes outside the
   * worktree, …) to Persona or the owner for a decision. Unset means true, the
   * default. false opts out: the session runs `--permission-mode auto` with
   * normal prompting and no floor hook. A per-launch flag on the launch request
   * overrides this. Claude-only; a Codex launch keeps its own posture.
   */
  bypassPermissions?: boolean;
  /**
   * Marks a reserved system project (e.g. the GLOBAL best-practices corpus,
   * id `global`). A reserved project is auto-ensured on boot, always spanned by
   * cross-project (corpus:"all") search and launch-time injection, and hidden
   * from the launchable-project UI (the new-session picker and the Work launch
   * sidebar) — knowledge can be contributed to it, but no session is launched
   * against it. Unset/false for every ordinary project.
   */
  reserved?: boolean;
  /**
   * Which agent CLI the console launches for this project (see HarnessId).
   * Unset means `claude` — the default harness, unchanged. `codex` launches a
   * headless `codex exec --json` session through the Codex harness adapter
   * instead, so a project can be driven by Codex without altering the Claude
   * path for every other project.
   */
  harness?: HarnessId;
  /**
   * The default SCOPE new knowledge authored under this project takes when the
   * author asserts none: 'global' promotes new docs to the whole corpus,
   * 'project' pins them project-local. Only these two are a project-level
   * default — per-doc 'user' scope is set on the document, not here. Unset means
   * no project override: authoring falls back to the global
   * `knowledge.default_scope` setting and finally to 'project' (the scope every
   * doc predating the scope dimension already had).
   */
  knowledgeScope?: "global" | "project";
  /**
   * Ids of projects that share this one's product (e.g. sibling repos of one
   * split product). The relation is symmetric — listing it on either side
   * relates both — and an agent's knowledge retrieval admits a related
   * project's project-scoped docs. Projects whose ids form a prefix family
   * (`a` and `a-b`) are related without being listed. See relatedProjects in
   * the collector.
   */
  related?: string[];
  /**
   * Whether this project's knowledge is served by the public knowledge API
   * (teammates reading over the tunnel). On unless the owner turns it off.
   * Stored only in the database: projects.toml neither sets nor exports it,
   * and a project upsert never changes it once the row exists (see
   * setProjectShareable).
   */
  shareable?: boolean;
}

export interface ProjectWithCounts extends Project {
  /** Knowledge docs indexed for this project. Computed, not persisted. */
  knowledgeDocs: number;
  /** Pending drafts awaiting review (phase-7 Step 5). Computed, not persisted. */
  pendingDrafts: number;
}

export interface ProjectConfig {
  project: Project[];
}

// ============================================================================
// Sessions
// ============================================================================

export type SessionStatus = "running" | "idle" | "waiting" | "stalled" | "done";

/**
 * Whether a session is a top-level root or a subagent child nested under a
 * parent. Unset is read as `root` — every session predating subsessions, and
 * every ordinary session, is a root; only a session created for a spawned
 * subagent is `subagent` (and carries a `parentSessionId`, `agentType`, `agentId`).
 */
export type SessionKind = "root" | "subagent";

/**
 * Why a session's record was ended without a SessionEnd hook proving its
 * process exited. `stale`: the reaper ended a monitored session for silence;
 * the process may still be running, so Resume refuses it.
 */
export type SessionEndReason = "stale";

export interface Session {
  id: string;
  projectId: string;
  title: string;
  cwd: string;
  parentSessionId?: string;
  status: SessionStatus;
  startedAt: Date;
  endedAt?: Date;
  /** Set when the record was ended without a SessionEnd hook (see SessionEndReason); unset otherwise. */
  endReason?: SessionEndReason;
  /**
   * True when hooks revived this ended session while its launch could not
   * have sent them (not live, hook-token proof retired, or pane gone): it was
   * resumed by hand, so its launch's pane says nothing about it. Unset
   * otherwise, and cleared by every end.
   */
  revivedOutsideLaunch?: boolean;
  /**
   * The most-recent transcript/event time for this session, else its start —
   * the recency the Work list orders by, so posting a new message bumps the
   * session to the top. Set by reads that derive it (getAllSessions); unset on
   * reads that don't.
   */
  lastActivityAt?: Date;
  /**
   * Root vs subagent-child (see SessionKind). Unset/`root` for every ordinary
   * session; `subagent` marks a child materialized from a SubagentStart hook and
   * nested under its `parentSessionId`.
   */
  kind?: SessionKind;
  /**
   * For a `subagent` child, the subagent's label (the Task subagent_type, e.g.
   * `code-reviewer`) — what the nested row is titled/badged by. Unset for a root.
   */
  agentType?: string;
  /**
   * For a `subagent` child, the subagent's correlation id from the hook payload,
   * stable across its SubagentStart/SubagentStop pair. Combined with the parent
   * id it forms the child's synthetic session id. Unset for a root.
   */
  agentId?: string;
  /**
   * The actor who first brought this session into being — the tunnel user who
   * dispatched its launch, else the host user for a session that appeared on
   * its own. Stamped write-once when the session first appears and never
   * overwritten (see setSessionCreatedActor). Unset for sessions created before
   * the collaboration model existed.
   */
  createdActor?: string;
  /**
   * The actor who currently owns this session — reassignable via the
   * assign-owner endpoint, unlike `createdActor`. Unset until someone claims it.
   */
  ownerActor?: string;
  /**
   * Aliases of everyone recorded as a participant of this session (they steered,
   * replied to, resolved, or dispatched it). Computed from `session_participants`
   * and attached to session responses so a client can decide whether a session is
   * "mine" — created, owned, or participated in — without a per-session lookup.
   * Not persisted on the session row; empty/absent when no one has acted yet.
   */
  participantActors?: string[];
  // Present on API responses that compute the silence meter; not persisted.
  activityTicks?: boolean[];
  /**
   * True when Standup owns this session's terminal — it launched or adopted
   * it — and can therefore read its screen, type into it, and stop it. A
   * monitored session belongs to the user's own terminal. Computed, not
   * persisted.
   */
  owned?: boolean;
  /**
   * True when this live root session is a worker of an open Persona job,
   * which Persona stops through the job rather than the console closing it.
   * Computed, not persisted; false on subagents (the console closes none).
   */
  personaWorker?: boolean;
  /**
   * Effort level read off the most recent hook payload for this session —
   * the ground truth even after a `/effort` change mid-session, unlike the
   * value chosen at launch. Computed, not persisted; unset until the first
   * hook fires.
   */
  liveEffort?: string;
  /**
   * Model off the most recent real assistant turn in the transcript —
   * ground truth even after a `/model` change mid-session. Computed, not
   * persisted; unset until the transcript has a real (non-synthetic) turn.
   */
  liveModel?: string;
  /**
   * Which agent CLI drove this session (see HarnessId), read from the launch
   * that started it — so the session/feed views can show whether it is a Claude
   * or a Codex session. Computed, not persisted here; unset (read as `claude`)
   * for a monitored session Standup didn't launch and for a Claude launch, which
   * records no harness.
   */
  harness?: HarnessId;
  /**
   * The Claude model recorded on the launch that drives this session — the
   * launch-time pick, updated when the session view switches it mid-session.
   * The fallback when `liveModel` hasn't been observed yet. Computed, not
   * persisted here; unset for a monitored session.
   */
  launchModel?: ClaudeModel;
  /** The Claude effort recorded on the session's launch, the `launchModel` counterpart. */
  launchEffort?: ClaudeEffort;
}

// ============================================================================
// Usage telemetry (token/cost)
// ============================================================================

/**
 * Per-session token usage and estimated cost, aggregated from the session's
 * transcript on read (see the collector's usage.ts). Token counts are always
 * present; `costUsd` is null when the session's model isn't in the pricing map
 * (its tokens are still counted). `totalTokens` is input + output + both cache
 * legs. `model` is the session's current (last real) model id, absent when the
 * transcript has no real assistant turn.
 */
export interface SessionUsage {
  sessionId: string;
  projectId: string;
  title: string;
  status: SessionStatus;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  costUsd: number | null;
  /**
   * The person this session's spend is attributed to — its persisted actor
   * (owner, else creator, for a Claude session; owner → creator → requester for
   * a Codex launch), resolved through the actor-merge tombstones. A real
   * tunnel-authenticated alias is attributed to that person. Null for
   * genuinely-unattributed spend: the anonymous sentinel (a raw non-loopback
   * client with no trusted tunnel identity) OR the host fallback identity a
   * no-tunnel / single-player session is stamped with (`$USER` else "local") —
   * both folded to null so host / single-player work buckets on its own rather
   * than being pinned to the host operator — as well as a Codex launch with no
   * requester. If there is no (trusted) user, the attribution is nullable.
   */
  user?: string | null;
}

/**
 * Fleet-wide token/cost totals summed across the per-session rows. `costUsd`
 * sums only the sessions with a known-model cost, and is null when NO session
 * is priceable — so a fleet entirely on an unknown model reports its spend as
 * unknown rather than a fabricated $0.00 that silently understates real cost.
 * `unpricedSessionCount` is how many sessions had real token usage the pricing
 * map couldn't price; when it is above zero, `costUsd` is a partial lower bound
 * (those sessions' tokens are in the token totals, but their spend is not in
 * `costUsd`), which the UI surfaces so the headline cost isn't read as complete.
 */
export interface FleetUsageTotals {
  sessionCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  costUsd: number | null;
  unpricedSessionCount: number;
}

/** GET /api/usage/fleet payload: one row per session plus fleet totals. */
export interface FleetUsage {
  sessions: SessionUsage[];
  totals: FleetUsageTotals;
  /**
   * The same per-session rows re-summed per attributed user, so the view can
   * show token cost by person. `user` is null for the genuinely-unattributed
   * bucket — the anonymous sentinel (a non-loopback client with no trusted
   * tunnel identity), the host fallback identity of no-tunnel / single-player
   * work (`$USER` else "local"), or a launch with no requester. Each bucket
   * carries the identical FleetUsageTotals shape as the fleet grand total, and
   * the buckets reconcile
   * to it — summing every bucket's legs equals `totals`. Optional so an older
   * collector that doesn't emit it stays wire-compatible (the client can group
   * `sessions` itself).
   */
  byUser?: Array<{ user: string | null } & FleetUsageTotals>;
}

/**
 * GET /api/usage/me payload: the signed-in viewer's own sessions (those whose
 * persisted owner, else creator, else launch requester is the viewer) and
 * their totals. `user` is the viewer the collector proved, never one the
 * client named.
 */
export interface UserUsage {
  user: string;
  sessions: SessionUsage[];
  totals: FleetUsageTotals;
  /**
   * The viewer's own Persona turns and per-job budgets, kept apart from
   * `totals` (which covers sessions only). Absent from older collectors.
   */
  persona?: PersonaUsage;
}

// ============================================================================
// Launches (console-started sessions)
// ============================================================================

export type LaunchStatus = "starting" | "running" | "failed" | "cleaned";

export type LaunchKind = "worktree" | "adopted" | "bootstrap";

/**
 * Which slow step a still-`starting` launch is in, so the console can show
 * real movement instead of a single "provisioning…" for the whole minutes-long
 * wait. `provisioning` = making the working dir (provision command or
 * `git worktree add`); `building` = the project `setup`/install command;
 * `starting` = trusting the dir and spawning the agent's tmux session.
 * `queued` = waiting, before any of those, for the host to have room for
 * another worker (memory and CPU headroom); it starts on its own when it does.
 */
export type LaunchPhase = "queued" | "provisioning" | "building" | "starting";

/**
 * A value accepted by `claude --model`, in either form the CLI takes: a family
 * ALIAS (`opus`), which always resolves to the newest model in that family, or a
 * PINNED model id (`claude-opus-4-8`), which holds the session on one version.
 * Both are passed through verbatim. A closed set — the server validates against
 * CLAUDE_MODELS, which must stay in sync with this union.
 */
export type ClaudeModel =
  | "opus"
  | "claude-opus-5"
  | "claude-opus-4-8"
  | "claude-opus-4-7"
  | "claude-opus-4-6"
  | "claude-opus-4-5"
  | "claude-opus-4-1"
  | "claude-opus-4"
  | "sonnet"
  | "claude-sonnet-5"
  | "claude-sonnet-4-6"
  | "claude-sonnet-4-5"
  | "claude-sonnet-4"
  | "claude-sonnet-3-7"
  | "haiku"
  | "claude-haiku-4-5"
  | "claude-haiku-4"
  | "claude-haiku-3-5"
  | "fable"
  | "claude-fable-5-1"
  | "claude-fable-5";

/** Levels accepted by `claude --effort`. */
export type ClaudeEffort = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * A Codex model id passed through to `codex exec -m`. Free-form (Codex's model
 * ids are open-ended and version with the CLI, and a Codex build fronted by a
 * different provider exposes different ids), so — unlike ClaudeModel — this is
 * not a closed enum: the UI offers CODEX_MODELS as a convenience list with a
 * free-text escape hatch, and any string is accepted. Kept distinct from
 * ClaudeModel so the two harnesses' model spaces never conflate.
 */
export type CodexModel = string;

/**
 * Reasoning-effort levels for a Codex launch, applied as a
 * `-c model_reasoning_effort=<level>` config override. A closed set (validated
 * server-side), deliberately separate from ClaudeEffort — the two ladders differ
 * (Codex starts at `minimal` and goes past `max` to `ultra`). Not every model
 * takes every level; CODEX_MODEL_CATALOG names each offered model's own levels.
 */
export type CodexEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

/** A Codex model the composer offers by name (see CODEX_MODEL_CATALOG). */
export interface CodexModelInfo {
  /** The id passed verbatim to `codex exec -m`. */
  id: CodexModel;
  /** Display name, as the Codex build's own model list names it. */
  label: string;
  /** The model's reasoning-effort levels; absent when not known, so every level is offered. */
  efforts?: CodexEffort[];
  /** The one the composer marks as the recommended pick. */
  recommended?: boolean;
}

/**
 * A launch's checkouts as read at one moment: each checkout's HEAD commit,
 * HEAD reflog length and a digest of those reflog entries, keyed by its
 * label and git dir (so a re-clone is another key), and the files already
 * changed then — each path, labelled as a not-applicable waiver reads it,
 * mapped to a digest of its mode and bytes.
 */
export interface LaunchCheckoutSnapshot {
  checkouts: Record<string, { head: string; reflog: number; log: string }>;
  dirty: Record<string, string>;
}

export interface Launch {
  id: string;
  /**
   * worktree = created its own checkout; adopted = resumed in place;
   * bootstrap = a knowledge-bootstrap run in its own worktree (a real
   * checkout, like worktree, but gated separately — see propose_knowledge's
   * collector-side check in server.ts).
   */
  kind: LaunchKind;
  projectId: string;
  task: string;
  worktreePath: string;
  branch: string;
  baseBranch?: string;
  tmuxSession?: string;
  sessionId?: string;
  status: LaunchStatus;
  error?: string;
  /** Chosen at launch and passed as `--model`; unset means the CLI's own default. */
  model?: ClaudeModel;
  /** Chosen at launch and passed as `--effort`; unset means the CLI's own default. */
  effort?: ClaudeEffort;
  /**
   * For a `codex` launch, the model passed through as `codex exec -m`; unset
   * means the Codex CLI's own default. Kept in its own column (never overloaded
   * onto `model`, which is Claude-typed) so the two harnesses' model spaces stay
   * unconflated. Always unset for a Claude launch.
   */
  codexModel?: CodexModel;
  /**
   * For a `codex` launch, the reasoning-effort level applied as
   * `-c model_reasoning_effort=<level>`; unset means the Codex CLI's own default.
   * Its own column, distinct from the Claude-typed `effort`. Always unset for a
   * Claude launch.
   */
  codexEffort?: CodexEffort;
  /**
   * True when the working dir was made by a project `provision` command rather
   * than `git worktree add`. Cleanup keys off this: a provisioned dir is
   * removed with a path-guarded `rm -rf` (it's a Standup-created dir under the
   * worktree root, e.g. a whole workspace of checkouts), never `git worktree remove`.
   */
  provisioned?: boolean;
  /**
   * A provisioned launch's checkouts as provisioning and setup left them,
   * before the agent started — what a not-applicable waiver reads the
   * launch against (pipeline engine readNoCodeCheckout).
   */
  provisionSnapshot?: LaunchCheckoutSnapshot;
  /**
   * True when the launch reuses the project's real repo checkout instead of
   * creating a worktree — the "reuse existing workspace" mode. Cleanup keys
   * off this: an in-place launch's `worktreePath` is the user's repo, and
   * `git worktree remove` there would destroy real work; the guard is the
   * same one the adopted-kind cleanup uses.
   */
  inPlace?: boolean;
  /**
   * The slow step currently running while `status` is still "starting".
   * Undefined once the launch is running/failed/cleaned. Drives the sidebar's
   * phase label ("provisioning workspace…" / "installing…" / "starting agent…").
   */
  phase?: LaunchPhase;
  /**
   * Accumulated stdout+stderr of the provision and setup/build commands,
   * streamed to the console while provisioning so the otherwise-invisible
   * workspace-create + build output is watchable. Capped to the tail. The
   * launch list and the hello-ok snapshot leave it out; a single-launch read
   * (GET /api/launches/:id) carries it.
   */
  log?: string;
  /**
   * The tunnel user who dispatched this launch (best-effort; unset for an
   * automatic launch with no requester, e.g. adoption or a review-agent run).
   * This is the launch's only client-visible actor, so it is what the "Mine"
   * lens judges a still-provisioning, sessionless launch by — before a session
   * attaches and carries the richer created/owner/participant attribution.
   */
  requester?: string;
  /**
   * Who launched this, as the collector itself resolved it: the request's
   * authenticated identity (never a body `actor` override), or the owner of
   * the Persona that launched it. Unset for an automatic or anonymous launch.
   * Unlike `requester`, a caller can't name someone else here, so it is what
   * a launch's work is attributed to wherever attribution grants access
   * (whose Review queue a launch's packet lands in).
   */
  launchedBy?: string;
  /**
   * Which agent CLI this launch spawned (see HarnessId). Unset/`claude` for the
   * default harness; `codex` for a headless `codex exec --json` launch. Records
   * the harness actually used so telemetry and cleanup can key off it.
   */
  harness?: HarnessId;
  /**
   * For a `codex` launch, the path to the JSONL sidecar its `codex exec --json`
   * event stream is tee'd to (the launcher supplies it). Fleet telemetry reads
   * this file to reconcile the run's per-turn token usage — Codex's analogue of
   * Claude's JSONL transcript. Unset for a Claude launch (its usage comes from
   * the transcript) and for a codex launch that predates this.
   */
  codexEventLog?: string;
  /**
   * When the launch's idle worker was stopped to free the host. The row stays
   * (its status is untouched), so its job can resume the session; cleared when
   * it is resumed.
   */
  reapedAt?: Date;
  /** Why the worker was reaped (e.g. idle past the threshold). Set with `reapedAt`. */
  reapReason?: string;
  /** True when the owner exempted this launch from idle reaping. */
  keepAlive: boolean;
  /**
   * The bypass-permissions choice the launch request made, overriding its
   * project's default. Unset when the request left it to the project. A
   * respawn of the launch's pane (an idle-paused worker resuming) reuses it.
   */
  bypassPermissions?: boolean;
  createdAt: Date;
}

/** How a registered worker process is addressed: a pid (and its group) or a systemd unit. */
export type LaunchProcessKind = "pid" | "unit";

/**
 * A long-lived process a worker started (a dev server, a tunnel) and
 * registered, so it can be stopped when its job closes. Live while `stoppedAt`
 * is unset.
 */
export interface LaunchProcess {
  id: string;
  launchId: string;
  jobId?: string;
  kind: LaunchProcessKind;
  pid?: number;
  pgid?: number;
  /** The systemd unit, for a `unit` process. */
  unit?: string;
  /** What the worker called it. */
  label: string;
  port?: number;
  /**
   * The process's identity at registration, to tell a reused pid from the one
   * registered: `<start epoch seconds>\t<ps args>`, or the args alone when the
   * start time wasn't known.
   */
  argsFingerprint?: string;
  /** ISO timestamp (SQLite `datetime('now')`). */
  registeredAt: string;
  stoppedAt?: string;
  stopReason?: string;
}

// ============================================================================
// Task runs (dispatcher lifecycle ledger)
// ============================================================================

/**
 * The lifecycle of a dispatched unit of work. `queued` the instant a launch is
 * requested; `running` once its tmux pane spawns; then a terminal state:
 * `succeeded`/`failed` self-reported by the agent (report_task), `cancelled`
 * when a human stops it, or `lost` when the reconciliation sweep finds its pane
 * gone past a grace window without a terminal report. See
 * ALLOWED_TASK_RUN_TRANSITIONS in @standup/store for the legal edges.
 */
export type TaskRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "lost";

/**
 * The best-of-N selection state of a run that is one of several parallel
 * attempts on the same ticket (see `attemptGroup`). `pending` while the human
 * has not yet picked a winner; `selected` for the one attempt whose branch
 * becomes the ticket's output (feeding the Publisher); `superseded` for the
 * losers. Undefined for an ordinary single-attempt run, which is never grouped.
 */
export type TaskRunAttemptStatus = "pending" | "selected" | "superseded";

/**
 * A durable ledger row for one dispatched launch — the state a coworker cares
 * about (did it finish? is it stuck?), distinct from the `launches` worktree/
 * tmux provisioning record it is created alongside. The two share
 * `worktreePath`, which links a run to the launch's tmux pane and to the
 * session that reports in from it.
 */
export interface TaskRun {
  id: string;
  /** Launch kind that produced this run: worktree | adopted | bootstrap. */
  kind: string;
  projectId: string;
  /** Session that reported in from this run's pane; unset until it does. */
  sessionId?: string;
  worktreePath: string;
  status: TaskRunStatus;
  /** Tunnel user who dispatched it (best-effort); unset for automatic runs. */
  requester?: string;
  createdAt: Date;
  /** Stamped on queued -> running. */
  startedAt?: Date;
  /** Stamped on any terminal transition. */
  endedAt?: Date;
  /** Heartbeat / liveness clock — bumped on every report and heartbeat. */
  lastEventAt?: Date;
  /** One-line result summary, set by report_task on a terminal report. */
  summary?: string;
  /** Failure message, set on failed/lost. */
  error?: string;
  /**
   * Groups the N parallel best-of-N attempts dispatched for one ticket — each
   * attempt is its own worktree + run, and they share this id. Undefined for an
   * ordinary single dispatch, which is never grouped.
   */
  attemptGroup?: string;
  /** Best-of-N selection state (see TaskRunAttemptStatus); unset when ungrouped. */
  attemptStatus?: TaskRunAttemptStatus;
}

// ============================================================================
// Best-of-N attempts (compare + pick)
// ============================================================================

/**
 * One parallel attempt on a ticket, as surfaced to the compare + pick UI: its
 * ledger `run` (carrying the attemptStatus), the `launch` that produced it (for
 * the branch/worktree), and the collected `diff` of that attempt's worktree
 * against its base branch. `diffTruncated` flags a diff clipped to the size cap;
 * `diffError` carries a read failure (a removed worktree, a git error) so the UI
 * shows why an attempt has no diff rather than a silent blank.
 */
export interface TicketAttempt {
  run: TaskRun;
  launch?: Launch;
  diff: string;
  diffTruncated?: boolean;
  diffError?: string;
}

/** GET /api/tickets/:id/attempts payload: the group id and its attempts. */
export interface TicketAttemptsResult {
  attemptGroup: string | null;
  attempts: TicketAttempt[];
}

// ============================================================================
// Orchestration profiles — a named, scoped develop → deploy → review workflow
// ============================================================================

/**
 * Where an orchestration profile lives. `global` is one account-wide profile
 * set (owner key `__global__`); `personal` is per-user (owner key = alias);
 * `project` is per-project (owner key = project id). The launch resolution walks
 * project → personal → global, mirroring how plan-gate and knowledge-scope
 * defaults layer.
 */
export type OrchestrationScope = "global" | "personal" | "project";

/**
 * One ordered step of an orchestration profile, discriminated by `kind`:
 *  - `gate`: a shell `command` that must exit 0 (run via checkAcceptanceCriterion).
 *  - `deploy`: a deploy step — either an explicit `command` or one derived from a
 *    `target` (account/role/command), which must exit 0.
 *  - `review`: a bounded adversarial-review loop — up to `rounds` (default from
 *    the profile's maxReviewRounds), blocking while a finding at or above
 *    `blockOnSeverity` survives; `lens` names an optional review lens.
 *  - `human_pause`: park the run and await a human, showing `prompt`.
 */
export type OrchestrationStep =
  | { kind: "gate"; name: string; command: string }
  | { kind: "deploy"; target?: DeployTarget; command?: string }
  | { kind: "review"; rounds?: number; blockOnSeverity?: "high" | "medium"; lens?: string }
  | { kind: "human_pause"; prompt: string };

/**
 * A named, scoped workflow injected into a launch as steering and enforced at
 * the completion choke. `steps` run in order; `maxReviewRounds` caps any review
 * step that omits its own `rounds`; `blockOnSeverity` is the account/profile-wide
 * threshold a review step inherits when it sets none.
 */
export interface OrchestrationProfile {
  name: string;
  scope: OrchestrationScope;
  steps: OrchestrationStep[];
  maxReviewRounds?: number;
  blockOnSeverity?: "high" | "medium";
}

/**
 * The absolute ceiling on a review-round budget, regardless of what a profile or
 * a per-step `rounds` configures. It bounds the number of fixer dispatches one
 * run can trigger, so a fat-fingered or hostile round count can never fan out an
 * unbounded number of sessions. Both the store's profile validation and the
 * gate's durable round-budget clamp enforce it.
 */
export const MAX_REVIEW_ROUNDS = 10;

/**
 * The lifecycle of one orchestration run. `queued` before its steps start;
 * `running` while it works — a run STAYS `running` across convergence rounds (the
 * round counter advances instead of re-entering `running`, which the ledger's
 * transition table forbids). Terminal: `succeeded`/`failed`/`cancelled`, `lost`
 * when the reconciliation sweep finds it silent past a grace window, or
 * `superseded` when a once-`succeeded` run is invalidated by later rework
 * (needs_review -> developing) so the stale success can no longer authorize the
 * new, un-reviewed change. See ALLOWED_ORCH_RUN_TRANSITIONS in @standup/store for
 * the legal edges.
 */
export type OrchestrationRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "lost"
  | "superseded";

/**
 * A durable ledger row for one orchestration run — the enforcement state a
 * profile drives a launch through. `ownerKey` is the resolved scope owner (alias
 * / project id / `__global__`). Timestamps are the raw stored UTC datetime
 * strings, not Date objects: this row is read/written by the gate loop and
 * shipped to the UI as-is.
 */
export interface OrchestrationRun {
  id: string;
  profileName: string;
  scope: OrchestrationScope;
  ownerKey: string;
  projectId?: string;
  ticketId?: string;
  sessionId?: string;
  launchId?: string;
  status: OrchestrationRunStatus;
  round: number;
  maxRounds: number;
  lastEventAt: string;
  createdAt: string;
  endedAt?: string;
  summary?: string;
  error?: string;
}

/**
 * The recorded outcome of one step evaluation within a run — which `stepIndex`
 * (its `kind`) was checked in which `round`, whether it `passed`, and an optional
 * `detail` (a command's failing output, a review's surviving finding).
 */
export interface OrchestrationGateResult {
  id: string;
  runId: string;
  round: number;
  stepIndex: number;
  kind: string;
  passed: boolean;
  detail?: string;
  createdAt: string;
}

// ============================================================================
// Identity provider (pluggable request-identity resolution)
// ============================================================================

/**
 * How a request's acting user is authenticated. `none` is today's default: no
 * auth challenge is issued — the user identifier is taken from a trusted request
 * source (see IdentityProviderConfig). An extensible union so a future mode
 * (e.g. an OIDC / bearer-token challenge) slots in here without disturbing the
 * resolver's call sites.
 */
export type AuthMode = "none";

/**
 * Where a request's user identifier comes from. Today the only source is an HTTP
 * header whose name is configurable — the default is
 * `{ type: "http-header", header: DEFAULT_IDENTITY_HEADER }`. A tagged union so a
 * future source (a cookie, a JWT claim) is an additive variant, not a rewrite.
 */
export type UserIdentifierSource = {
  type: "http-header";
  /** The request header carrying the acting user's identifier. */
  header: string;
};

/**
 * The pluggable identity provider for request-identity resolution. It
 * parameterizes the `auth` mode, the `userIdentifier` source (the header
 * name), and the trust knobs that decide when a source-supplied identifier is
 * honored. The identifier is trusted ONLY from a loopback source (when
 * `loopbackIsTrusted`) or a configured `trustedProxies` address — a
 * client-supplied header on a raw network bind is never trusted. The default
 * provider is `defaultIdentityConfig`.
 */
export interface IdentityProviderConfig {
  auth: AuthMode;
  userIdentifier: UserIdentifierSource;
  /**
   * Source addresses trusted to have injected a genuine identifier — a real
   * gateway in front that strips client-set copies (the tunnel's role). A
   * request from any other network source has its identifier ignored.
   */
  trustedProxies: string[];
  /**
   * Whether a loopback source is trusted to have set the identifier. True by
   * default: the tunnel forwards to loopback, and a same-host request is the
   * single-user default.
   */
  loopbackIsTrusted: boolean;
}

// ============================================================================
// Users (request identity)
// ============================================================================

/**
 * A person who has reached the collector, keyed by their alias. Behind an
 * authenticating tunnel that alias is stamped as the identity header
 * (`DEFAULT_IDENTITY_HEADER` unless configured); off the tunnel it falls back
 * to the host user. Upserted once per request, so
 * `firstSeen`/`lastSeen` bracket a teammate's activity — the identity
 * foundation the collaboration model (owner/participants) builds on. Like every
 * other row in the store, a rebuildable index, not a source of truth.
 */
export interface CurrentUser {
  alias: string;
  /** Human-friendly name; unset until something sets it (the alias reads as the name). */
  display?: string;
  firstSeen: Date;
  lastSeen: Date;
}

/**
 * The acting identity for a request — what `GET /api/whoami` returns. `user` is
 * the resolved alias (the tunnel-stamped alias, else the host user);
 * `tunnel` is true when it came from the identity header rather than
 * the host-user fallback; `record` is the stored users row for that alias.
 */
export interface WhoAmI {
  user: string;
  tunnel: boolean;
  record: CurrentUser;
}

// ============================================================================
// Per-user profile ("a CLAUDE.md for each user")
// ============================================================================

/**
 * Where a user deploys — injected into a launch's opening prompt as CONTEXT so
 * the agent knows the target, never as credentials. The agent authenticates
 * with its own ambient creds; Standup stores no secrets. Every field is
 * optional so a user can pin just the account, just a command, etc.
 */
export interface DeployTarget {
  /** AWS account id (or other target identifier). */
  account?: string;
  /** IAM role to assume, when the deploy needs one. */
  role?: string;
  /** The literal deploy command the user runs (e.g. a `cdk deploy …`). */
  command?: string;
}

/**
 * A per-user profile keyed by alias — "a CLAUDE.md for each user".
 * Stored server-side in the SHARED DB so it follows the user across the
 * gateway, and injected into the opening prompt of the sessions that user
 * launches (see launcher.ts) so the agent behaves per that user's prefs even
 * on a shared collector.
 *
 * `personalInstructions` is the freeform catch-all; `reviewRigor` and
 * `deployTarget` are the structured commons. Private-ish (visible to the user;
 * not a security boundary — one trusted team). Like every other row in the
 * store, a rebuildable index, not a source of truth.
 */
export interface UserPrefs {
  alias: string;
  /**
   * The project this profile is scoped to, when it is a per-(user, project)
   * overlay (§H) rather than the user's global profile. Undefined = the global
   * profile (§A); set = the overlay for that project. On a MERGED effective
   * profile (global + overlay, see mergeUserPrefs) it names the project the
   * merge was resolved for.
   */
  projectId?: string;
  /** Freeform markdown instructions, appended to the launching user's prompt. */
  personalInstructions?: string;
  /**
   * How thorough a review the user wants when they finish work — e.g. "run an
   * adversarial review that finds ALL High + Medium". Injected as instruction
   * and used as this user's default when they trigger a review flow.
   */
  reviewRigor?: string;
  /** Where this user deploys — injected as context (see DeployTarget). */
  deployTarget?: DeployTarget;
  updatedAt: Date;
}

// ============================================================================
// Collaboration model (actors / owner / participants)
// ============================================================================

/**
 * A collaborator on the team, keyed by their alias — seeded from the
 * tunnel identity. Distinct from `CurrentUser` (the raw per-request identity
 * ledger): an actor is the durable participant a session's owner/participant
 * edges point at, and can carry richer identity (a `githubLogin`) as the team
 * grows. Like every other row in the store, a rebuildable index.
 */
export interface Actor {
  id: string;
  /** Human-friendly name; unset until something sets it (the id reads as the name). */
  display?: string;
  /** GitHub handle, when known — unset otherwise. */
  githubLogin?: string;
  /**
   * Identity reconciliation: when set, this row has been folded into the actor
   * with this id (one human who showed up as two rows — e.g. a Slack `slack:U…`
   * actor and their alias actor). It's a tombstone — getActor resolves
   * through it to the canonical actor and getActors omits it. Unset for a
   * canonical (live) actor.
   */
  mergedInto?: string;
  firstSeen: Date;
  lastSeen: Date;
}

/**
 * One actor's involvement in one session — recorded best-effort when they
 * steer, reply to, or dispatch it. `contributionCount` bumps on each further
 * action; the row is created once per (session, actor) and the set is capped
 * per session (see MAX_SESSION_PARTICIPANTS in @standup/store).
 */
export interface SessionParticipant {
  sessionId: string;
  actorId: string;
  firstSeen: Date;
  contributionCount: number;
}

// ============================================================================
// Events (from Claude Code hooks)
// ============================================================================

export interface HookEvent {
  id: string;
  sessionId: string;
  seq: number;
  type: HookEventType;
  payload: Record<string, unknown>;
  createdAt: Date;
}

export type HookEventType =
  | "SessionStart"
  | "SessionEnd"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PostToolUse"
  | "PostToolUseFailure"
  | "SubagentStart"
  | "SubagentStop"
  | "Stop"
  | "Notification"
  | "Elicitation"
  | "ElicitationResult";

// ============================================================================
// Checkpoints
// ============================================================================

export type CheckpointSource = "structural" | "self-reported" | "auto";

export interface Checkpoint {
  id: string;
  sessionId: string;
  source: CheckpointSource;
  summary: string;
  createdAt: Date;
}

// ============================================================================
// Asks (blocking questions from agents)
// ============================================================================

export type AskStatus = "pending" | "answered" | "timeout" | "cancelled";
export type AskKind = "ask_human" | "permission_prompt";

export interface Ask {
  id: string;
  sessionId: string;
  kind: AskKind;
  question: string;
  options?: string[];
  answer?: string;
  status: AskStatus;
  createdAt: Date;
  resolvedAt?: Date;
  /** Who resolved it: a user's alias, or `persona:<owner>` for a Persona's decision. */
  answeredBy?: string;
  /**
   * Set only by the server, for an ask it raised itself rather than an agent:
   * `"standup_improvement"` for the self-fix launch's confirmation (Persona never
   * answers it on the owner's behalf) and `"idle_notice"` for a launched session's
   * idle "waiting for your input" notice (a turn end, not a permission dialog).
   * Absent on every agent-raised ask; no request body can set it.
   */
  gate?: string;
  /**
   * Set on an ask a running Persona will handle (the session is one of its
   * workers). Persona relays what needs the owner itself, so other surfaces
   * (Slack ask cards, pushes) don't deliver it to the human a second time.
   */
  personaHandled?: boolean;
  /**
   * Set (with `personaHandled`) on an ask an owner's approval card holds: who
   * decides the card (its approver, else its owner), i.e. whom it is
   * delivered to. A surface the card reaches leaves the ask to it; one it
   * doesn't reach delivers the ask itself, so the ask is still seen there.
   */
  cardDecider?: string;
}

// ============================================================================
// Steers (unsolicited human messages queued for delivery)
// ============================================================================

export type SteerStatus = "pending" | "delivered" | "cancelled";

export interface Steer {
  id: string;
  sessionId: string;
  body: string;
  status: SteerStatus;
  createdAt: Date;
  deliveredAt?: Date;
  /**
   * The one user this steer's body is for (a Human Review steer: a review
   * brief, or the owner's requested changes); its events go only to sockets
   * that proved that user, and others never read its body. Unset for an
   * ordinary steer.
   */
  audience?: string;
}

// ============================================================================
// Session messages (agent-to-agent mailbox) + shared task-list notes
// ============================================================================

export type SessionMessageStatus = "pending" | "delivered" | "cancelled";

/**
 * A message enqueued from one session for another, delivered on the target's
 * next turn through the same injection seam steers ride. `fromSessionId` /
 * `fromLabel` attribute it to the sending session/agent so the recipient reads
 * who it is coordinating with, not an anonymous instruction.
 */
export interface SessionMessage {
  id: string;
  toSessionId: string;
  fromSessionId?: string;
  fromLabel?: string;
  body: string;
  status: SessionMessageStatus;
  createdAt: Date;
  deliveredAt?: Date;
}

/**
 * One entry on the lightweight shared task-list every coordinating agent can
 * read and append to — the passive counterpart to a direct session message.
 * Project-scoped when a project is known (else a global board). `done` flips a
 * line struck-through once the work it names is finished.
 */
export interface SharedNote {
  id: string;
  projectId?: string;
  fromSessionId?: string;
  fromLabel?: string;
  body: string;
  done: boolean;
  createdAt: Date;
  updatedAt: Date;
}

// ============================================================================
// Knowledge-graph changes (curated-feed leg)
// ============================================================================

/**
 * The kinds of knowledge-graph mutation worth a curated-feed line: a doc
 * accepted into the corpus, removed from it, reconciled (a merge-accept folding
 * a regenerated draft into a human-authored doc), flagged as contradicting
 * another doc, or freshly distilled from a session.
 */
export type KnowledgeChangeKind =
  | "accepted"
  | "removed"
  | "reconciled"
  | "contradiction"
  | "distilled";

/**
 * A knowledge-graph mutation surfaced as a substantive item on the Slack feed.
 * Distinct from the `knowledge:draft` WS nudge, which only tells the Knowledge
 * tab / sidebar badge to refetch; this is the feed signal. Persisted (the
 * `knowledge_changes` table); /api/knowledge-changes lists the recent set.
 */
export interface KnowledgeChange {
  /** Stable id for feed keying and de-duplication. */
  id: string;
  projectId: string;
  /** The doc slug the change concerns — the subject doc for a contradiction. */
  slug: string;
  kind: KnowledgeChangeKind;
  /** The doc's human-readable title. */
  title: string;
  /** The session that authored or triggered the change, when one is resolvable. */
  sessionId?: string;
  /** For `contradiction`: the slugs flagged as opposing the subject doc. */
  contradicted?: string[];
  /** ISO timestamp the change occurred. */
  createdAt: string;
  /**
   * True when the doc is in the personal layer: the change is shown only to
   * `ownerUser`, and to nobody when the owner is unknown.
   */
  personal?: boolean;
  /** The personal doc's owner. */
  ownerUser?: string;
}

// ============================================================================
// Daily morning digest
// ============================================================================

/** Per-dimension item tallies a digest covers over its window. */
export interface DigestCounts {
  /** Projects that had any activity in the window. */
  projects: number;
  activeWork: number;
  taskRuns: number;
  checkpoints: number;
  knowledgeChanges: number;
  asks: number;
  launches: number;
}

/**
 * A once-a-day standup digest of the last ~24h across every project, posted at
 * the configured local hour (default 9am EST). Persisted (the `digests` table).
 * `body` is the model-summarized (or plainly rendered, on fallback) markdown
 * the Slack feed posts.
 */
export interface Digest {
  /** Stable id for feed keying and de-duplication. */
  id: string;
  /** ISO timestamp the digest was posted. */
  createdAt: string;
  /** ISO timestamp of the start of the covered window. */
  periodStart: string;
  /** ISO timestamp of the end of the covered window (when it was built). */
  periodEnd: string;
  /** The digest text — model summary, else the plainly rendered fallback. */
  body: string;
  /** The project ids the digest covered (empty on a quiet day). */
  projects: string[];
  /** Per-dimension tallies over the window. */
  counts: DigestCounts;
}

// ============================================================================
// Retrieval-usage telemetry
// ============================================================================

/**
 * Where a knowledge doc was retrieved: a `search_knowledge` / Knowledge-tab
 * search, a launch-time injection, a `get_knowledge_doc` fetch of a doc's
 * full body, or a hook push (KnowledgePushSurface). The signal ranking and
 * staleness prioritization consume.
 */
export type KnowledgeRetrievalSurface = "search" | "inject" | "doc_get" | KnowledgePushSurface;

/**
 * A doc a hook pushed into an agent's context unasked: `push:<hook event>`, or
 * `push:launch` for the push a Codex launch brief carries.
 */
export type KnowledgePushSurface = "push:SessionStart" | "push:UserPromptSubmit" | "push:PreToolUse" | "push:launch";

/**
 * Aggregated retrieval usage for one doc, keyed by the (project, slug) pair
 * knowledge docs are addressed by. Folded into /api/knowledge/stats and served
 * by /api/knowledge/usage so the Knowledge tab (and #4/#5) can see which docs
 * are actually pulled, when each was last touched, and — the feedback half —
 * how often each was pulled in a session that ultimately succeeded vs failed.
 */
export interface KnowledgeRetrievalUsage {
  docProject: string;
  docSlug: string;
  /** Total recorded retrievals across all surfaces. */
  retrievals: number;
  /** ISO timestamp of the most recent retrieval. */
  lastRetrievedAt: string;
  /**
   * The feedback signal: of `retrievals`, how many were correlated (via the
   * recorded `session_id`) to a session whose task run ended `succeeded`. This
   * is the "did it help" proxy #4 (usage-weighted ranking) and #5 (staleness
   * re-verification prioritization) consume to tell a high-value doc apart from
   * one that is retrieved often but rides along in sessions that fail. A
   * retrieval with no correlated session, or one still in flight or cancelled,
   * counts toward neither `succeededRetrievals` nor `failedRetrievals`.
   */
  succeededRetrievals: number;
  /**
   * The negative half of the same signal: of `retrievals`, how many were
   * correlated to a session whose task run ended `failed`. `lost` is NOT
   * counted here — a launch reconciled to `lost` exited without an explicit
   * report (unknown outcome, often a session that did good work but never
   * called report_task), so it must not be signed as a failure. Like
   * `succeededRetrievals`, a retrieval with no correlated session, or one still
   * in flight or cancelled, counts toward neither bucket.
   */
  failedRetrievals: number;
  /**
   * Of `retrievals`, how many actually rode into an agent: injected into a
   * launch's opening prompt (`injected = 1`).
   * The positive half of the injected-vs-dropped split — the measure of
   * whether a retrieved doc is really feeding the work. A `search`-surface
   * retrieval only ranks and carries no injected verdict (NULL), so it counts
   * toward neither `injected` nor `dropped`.
   */
  injected: number;
  /**
   * Of `retrievals`, how many were retrieved but DROPPED before reaching the
   * agent (`injected = 0`): squeezed out of a launch prompt by the char budget.
   * High here means a doc keeps surfacing yet
   * rarely makes the cut — the signal #4/#5 read to spot low-yield knowledge.
   */
  dropped: number;
  /**
   * Times the doc was retrieved as a candidate but held back by a gate (the
   * relevance floor, a verdict, confidence, origin, a layer or intent rule)
   * before it became a result. Not part of `retrievals`.
   */
  gated: number;
  /** get_knowledge_doc fetches of the doc's full body. Not part of `retrievals`. */
  docGets: number;
  /**
   * Of `docGets`, the fetches that followed the same session being handed the
   * doc by a search result or a launch injection: the surfaced doc was opened.
   */
  cited: number;
  /** The doc's knowledge layer as last recorded, when one was. */
  layer?: string;
  /** ISO timestamp of the latest returned hit or full-body fetch; absent when there is none. */
  lastUsedAt?: string;
}

/** Retrieval rows for one (layer, surface) pair. */
export interface KnowledgeRetrievalLayerRow {
  /** The doc's layer, or `unknown` for a row recorded before layers were. */
  layer: string;
  surface: KnowledgeRetrievalSurface;
  rows: number;
  /** Distinct docs among the rows. */
  docs: number;
  /** Rows for hits the surface returned. */
  returned: number;
  /** Rows for candidates a gate held back. */
  gated: number;
  /** Returned rows that rode into an agent (injected / cited). */
  injected: number;
}

/** Retrieval rows for one (drop reason, surface) pair; `returned` = no drop. */
export interface KnowledgeRetrievalDropRow {
  reason: string;
  surface: KnowledgeRetrievalSurface;
  rows: number;
  docs: number;
}

/** Retrieval rows broken down by layer and by drop reason. */
export interface KnowledgeRetrievalBreakdown {
  byLayer: KnowledgeRetrievalLayerRow[];
  byDropReason: KnowledgeRetrievalDropRow[];
}

/** A doc the usage views flag as unused. */
export interface KnowledgeDeadDoc {
  projectId: string;
  slug: string;
  title: string;
  layer: string;
  /** ISO timestamp of the doc's most recent retrieval row, if it has one. */
  lastRetrievedAt?: string;
}

/** A doc taking a large share of all returned retrievals. */
export interface KnowledgeHubDoc {
  projectId: string;
  slug: string;
  title: string;
  retrievals: number;
  /** retrievals / all returned retrievals, 0..1. */
  share: number;
}

/**
 * Corpus health read off retrieval telemetry: docs nothing retrieved within
 * `windowDays`, docs never opened after being surfaced (see
 * KnowledgeRetrievalUsage.cited), and the docs taking the
 * largest share of retrievals. Limited to docs the caller may browse.
 */
export interface KnowledgeUsageHealth {
  windowDays: number;
  /** Docs considered (the caller's browsable corpus, scoped to a project when asked). */
  docs: number;
  /** All docs unused in the window; `neverRetrieved` lists the first of them. */
  neverRetrievedCount: number;
  neverRetrieved: KnowledgeDeadDoc[];
  /** All docs never opened after being surfaced; `neverCited` lists the first of them. */
  neverCitedCount: number;
  neverCited: KnowledgeDeadDoc[];
  hubs: KnowledgeHubDoc[];
  /** Usage rows whose doc no longer exists in the corpus. */
  orphanedUsageDocs: number;
}

// ============================================================================
// Tickets (review kanban)
// ============================================================================

/**
 * Kanban columns. proposed / approved / developing / needs_review are the
 * "active" states; shipped and dismissed are terminal. See
 * ALLOWED_TICKET_TRANSITIONS in @standup/store for the legal edges.
 */
export type TicketStatus =
  | "proposed"
  | "approved"
  | "developing"
  | "needs_review"
  | "shipped"
  | "dismissed";

/**
 * A review "lens" — the adversarial angle a daily-review agent takes. The set
 * is data-driven (per-project daily-review config decides it), so this is an
 * open string rather than a closed union. Built-in lenses: `bugs`,
 * `best-practices`, `security`, `perf`.
 */
export type Lens = string;

/** Severity a review agent assigns to a proposed ticket. */
export type TicketSeverity = "low" | "medium" | "high" | "critical";

/** Per-project review gate — see Project.reviewProcess. */
export type ReviewProcess = "pause" | "command" | "review-agent";

/**
 * A code-review adapter's id — see Project.codeReviewAdapter. `generic`
 * takes any http(s) review URL (shaped by the org profile's codeReview
 * section); `github-pr` composes a draft GitHub PR.
 */
export type CodeReviewAdapterId = "generic" | "github-pr";

/** Every built-in code-review adapter id. */
export const CODE_REVIEW_ADAPTER_IDS: readonly CodeReviewAdapterId[] = ["generic", "github-pr"];

export interface Ticket {
  id: string;
  projectId: string;
  lens: Lens;
  title: string;
  body: string;
  severity: TicketSeverity;
  status: TicketStatus;
  /** Session of the review agent that proposed it (provenance; may be untracked). */
  proposedBySessionId?: string;
  /** Implementation launch fired on approval (approved -> developing). */
  launchId?: string;
  /** Session that implementation launch attached — the working session. */
  sessionId?: string;
  /**
   * The best-of-N attempt group when this ticket was dispatched as N parallel
   * attempts (each its own worktree + task_run, sharing this id). Set on a
   * multi-attempt dispatch; the compare + pick UI reads the group's runs by it.
   * Unset for an ordinary single dispatch.
   */
  attemptGroup?: string;
  /**
   * Tracking issue/task id this ticket resolves (an issue-tracker id).
   * Optional — set by the proposing agent when known — and threaded into the
   * review artifact, which links it.
   */
  issueId?: string;
  /**
   * Deep link back to the originating tracker task, when this ticket was
   * ingested from one (TrackerTask.url). Surfaced on the kanban card alongside
   * `issueId` so the task<->work-item mapping is visible and clickable. Unset
   * for tickets not originated from a tracker task.
   */
  taskUrl?: string;
  /** Review (pull request) URL produced by the review gate (command or review-agent). */
  reviewUrl?: string;
  /** Why the implementation agent reports it ready — set at developing -> needs_review. */
  readyReason?: string;
  /**
   * The one-line note from the most recent decoupled status report (POST
   * /api/tickets/:id/status). Recorded on any edge — approve, send-back, dismiss,
   * un-dismiss, ship — so a report's rationale is never dropped. Distinct from
   * readyReason, which is the ready summary specific to the needs_review edge.
   */
  note?: string;
  /**
   * The actor who last reported this ticket's status through the external status
   * setter (POST /api/tickets/:id/status) — an agent or user advancing the ticket
   * without a Standup-owned launch. Attribution for a decoupled status report.
   */
  reportedByActor?: string;
  /** Failure message from launch or the review gate; surfaced on the card. */
  error?: string;
  createdAt: Date; // == proposed time
  updatedAt: Date;
  approvedAt?: Date;
  developingAt?: Date;
  readyAt?: Date; // entered needs_review
  shippedAt?: Date;
  dismissedAt?: Date;
}

// ============================================================================
// Auto-review findings (reviewer/fixer split)
// ============================================================================

/**
 * Lifecycle of an auto-review finding:
 *  - `open`       — surfaced on the review-queue, awaiting a human decision.
 *  - `dispatched` — a human clicked "fix this finding", which fired a FRESH
 *                   fixer session seeded with the diff + this finding.
 *  - `dismissed`  — a human judged it noise and cleared it off the queue.
 *  - `superseded` — a later review pass over the same ticket replaced it, so it
 *                   drops off the queue without a human decision. Only still-`open`
 *                   findings are superseded — a `dispatched` one has a fixer in
 *                   flight and a `dismissed` one is already a human verdict.
 */
export type ReviewFindingStatus = "open" | "dispatched" | "dismissed" | "superseded";

/**
 * The validation-evidence bundle attached to a finding and handed to the fixer
 * at dispatch: the checks the reviewer ran, any screenshots it captured, and
 * the reviewed diff so the fixer sees the exact change the finding is about.
 * The reviewer emits `checks`/`screenshots` per finding; the collector fills
 * `diff` from the change it reviewed.
 */
export interface ReviewFindingEvidence {
  checks: string[];
  screenshots: string[];
  diff?: string;
}

/**
 * A single defect the auto-reviewer flagged over a ticket's diff on the
 * `developing → needs_review` edge. The reviewer is read-only and SEPARATE from
 * the fixer: it only records findings. Only High/critical findings surface on
 * the Work review-queue (de-noise); the fixer runs solely on an explicit human
 * "fix this finding" click, never autonomously.
 */
export interface ReviewFinding {
  id: string;
  /** The needs_review ticket the reviewed change belongs to. */
  ticketId: string;
  /** The reviewed implementation session (provenance; may be absent). */
  sessionId?: string;
  severity: TicketSeverity;
  title: string;
  body: string;
  /** Repo-relative file the finding anchors to, when the reviewer located one. */
  file?: string;
  line?: number;
  status: ReviewFindingStatus;
  /** The fresh fixer launch a human dispatched for this finding, once clicked. */
  fixLaunchId?: string;
  evidence: ReviewFindingEvidence;
  createdAt: Date;
  updatedAt: Date;
}

// ============================================================================
// Ticket publishing (the PR IS the unit of output)
// ============================================================================

/**
 * A composed draft pull-request payload — the exact request a live publish would
 * hand to `gh pr create --draft` / the GitHub API. `draft` is always true: a
 * shipped ticket mints a DRAFT PR for a human to finish and open.
 */
export interface DraftPrPayload {
  draft: true;
  title: string;
  body: string;
  /** The PR base branch (the change's launch base, else the project branch). */
  base?: string;
  /** The PR head branch (the ticket's implementation-worktree branch). */
  head?: string;
}

/**
 * The DRY-RUN preview of publishing a ticket's completed change as a draft PR —
 * the whole payload the Publisher seam assembles WITHOUT any git push or
 * gh/network call. A live publish (git push + `gh pr create --draft`) is a human
 * step done later; this build only ever composes and returns the preview, so the
 * `commands` are shown, never run, and `live` is always false.
 */
export interface TicketPublishPreview {
  ticketId: string;
  /** The head branch the change lives on, or undefined when no worktree branch is resolvable. */
  branch?: string;
  /** The PR base branch (the launch's base, else the project branch). */
  baseBranch?: string;
  /**
   * The reference commit message for the change: the ticket title as the subject,
   * the ticket body, then a blank line and the deduped `Co-authored-by` trailers.
   * git credits co-authorship from the commit, not the PR body, so those same
   * trailers are the ones the composed `git commit --amend --trailer` bakes onto
   * the branch's HEAD commit.
   */
  commitMessage: string;
  /** Deduped `Co-authored-by:` trailer lines, one per distinct session participant. */
  coAuthors: string[];
  /** The draft-PR request (title/body linking the ticket + findings, base, head, draft:true). */
  pr: DraftPrPayload;
  /**
   * The PR body paired with the exact path the composed `gh … --body-file` reads
   * — the `--body-file` sidesteps shell-escaping a multi-line body, but the file
   * must exist, so `contents` (identical to `pr.body`) and `path` are surfaced
   * together (the first composed command writes it). Mirrors the review-artifact
   * seam's `descriptionFile` so the human never has to guess the path/contents.
   */
  descriptionFile: { path: string; contents: string };
  /**
   * The shell commands a LIVE publish would run in order, composed for a human to
   * run and never executed in this build: write the `--body-file`, bake the
   * deduped `Co-authored-by` trailers onto the branch's HEAD commit
   * (`git commit --amend --trailer`, so co-authorship actually lands on a commit
   * git/GitHub read it from), push the head branch, and `gh pr create --draft`.
   */
  commands: string[];
  /** Always false in this build: a live publish (push + gh) is a human step. */
  live: false;
  /**
   * Gaps a human must resolve before a live publish — e.g. no resolvable worktree
   * branch (an in-place/scratch/adopted launch), so the PR head is unknown.
   */
  warnings: string[];
}

// ============================================================================
// Posting review findings to a PR (inline review comments)
// ============================================================================

/**
 * The GitHub review verdict a posted set of findings carries. Constrained to the
 * two non-approving events: `REQUEST_CHANGES` (the default when there is a
 * blocking finding — the change should not merge as-is) and `COMMENT` (advisory,
 * used when nothing blocking survives the filter). `APPROVE`/`PENDING` are
 * deliberately excluded — the auto-reviewer only ever raises concerns.
 */
export type ReviewCommentEvent = "COMMENT" | "REQUEST_CHANGES";

/**
 * One inline review comment anchored to a diff hunk — the exact `{path, line,
 * body}` shape the GitHub reviews API takes in a review's `comments` array.
 * `line` is the file's line number in the PR diff.
 */
export interface ReviewInlineComment {
  path: string;
  line: number;
  body: string;
}

/**
 * The DRY-RUN preview of posting a ticket's High/critical review findings to its
 * minted PR as inline review comments — the whole GitHub reviews-API payload
 * assembled WITHOUT any gh/network call. Only the highest-severity, still-active
 * findings that anchor to a `file:line` become inline `comments`; low/medium
 * findings are filtered out entirely, and a High finding with no location is
 * summarized into `body` rather than dropped. A live post (`gh api … reviews`) is
 * a human step done later, so the composed `commands` are shown, never run, and
 * `live` is always false.
 */
export interface ReviewCommentsPayload {
  /** The ticket whose findings these comments carry (provenance). */
  ticketId?: string;
  /** The review verdict — REQUEST_CHANGES when a blocking finding is present, else COMMENT. */
  event: ReviewCommentEvent;
  /** The review's top-level body: a one-line summary plus any High findings that had no location to anchor inline. */
  body: string;
  /** The inline comments, one per High/critical, still-active finding that anchors to a `file:line`. */
  comments: ReviewInlineComment[];
  /** The minted PR's number, once a human has opened it; absent pre-mint (a `<pr-number>` placeholder rides the command). */
  prNumber?: number;
  /** The `owner/repo` slug for the reviews-API path; absent when unresolved (a `<owner/repo>` placeholder rides the command). */
  repo?: string;
  /** The PR head branch the change lives on (from the publish preview), for reference. */
  branch?: string;
  /**
   * The reviews-API request payload written to `payloadFile` and read back by the
   * composed `gh api … --input` command — identical to `{event, body, comments}`.
   */
  reviewRequest: { event: ReviewCommentEvent; body: string; comments: ReviewInlineComment[] };
  /**
   * The payload JSON paired with the exact path the composed `gh api … --input`
   * reads — the file must exist, so `contents` and `path` are surfaced together
   * (the first composed command writes it). Mirrors the Publisher's `descriptionFile`.
   */
  payloadFile: { path: string; contents: string };
  /**
   * The shell commands a LIVE post would run in order, composed for a human to run
   * and never executed in this build: write the payload file, then `gh api
   * --method POST /repos/<repo>/pulls/<n>/reviews --input <file>`.
   */
  commands: string[];
  /**
   * Human-fill `<…>` placeholders present in `commands` that must be resolved
   * before running — the PR number and/or `owner/repo` when unknown at compose
   * time (pre-mint). Empty when the command is ready as-is.
   */
  placeholders: string[];
  /** Always false in this build: a live post (`gh api`) is a human step. */
  live: false;
  /** Gaps a human should note — e.g. High findings that had no location to anchor inline. */
  warnings: string[];
}

// ============================================================================
// Plan-approval gate (Devin/Jules-style pre-run plan approval)
// ============================================================================

/**
 * Lifecycle of a launch's plan-approval gate:
 *  - `awaiting_plan`   — the gated launch is live but the agent hasn't submitted
 *                        a plan yet (the state a gated launch is created in).
 *  - `awaiting_approval` — the agent submitted its plan; a human must approve or
 *                        edit it. The run is paused here (submit_plan blocks).
 *  - `approved`        — a human approved (possibly edited) the plan; the run is
 *                        released and the agent may proceed.
 *  - `rejected`        — a human rejected the plan; submit_plan returns the
 *                        rejection so the agent can revise and resubmit.
 */
export type PlanApprovalStatus =
  | "awaiting_plan"
  | "awaiting_approval"
  | "approved"
  | "rejected";

/**
 * A launch's plan-approval record. Keyed to the launch (and its worktree, so a
 * calling session's cwd resolves to it). The agent fills `relevantFiles`,
 * `plan`, and `acceptanceCriterion` via submit_plan; a human may edit any of
 * them on approve. `criterionMet` flips true once the acceptance criterion has
 * been satisfied (the collector runs it in the worktree), which is what unblocks
 * mark_ready_for_review.
 */
export interface PlanApproval {
  id: string;
  launchId: string;
  projectId: string;
  worktreePath: string;
  status: PlanApprovalStatus;
  /** Files the agent judged relevant to the task (its own survey). */
  relevantFiles: string[];
  /** The preliminary plan the agent proposes before doing the work. */
  plan?: string;
  /**
   * A machine-checkable acceptance criterion: a shell command run in the
   * launch's worktree that must exit 0 before the agent may mark the work ready.
   */
  acceptanceCriterion?: string;
  /** True once the acceptance criterion has passed at least once. */
  criterionMet: boolean;
  /** Who approved/edited the plan (the acting alias). */
  approvedBy?: string;
  createdAt: Date;
  updatedAt: Date;
  submittedAt?: Date;
  approvedAt?: Date;
}

// ============================================================================
// Feed items (unified view)
// ============================================================================

export type FeedItemKind = "checkpoint" | "ask" | "stall";

export interface FeedItem {
  id: string;
  kind: FeedItemKind;
  sessionId: string;
  timestamp: Date;
  data: Checkpoint | Ask | StallDetection;
}

export interface StallDetection {
  id: string;
  sessionId: string;
  reason: string;
  toolCalls: number;
  quietMinutes: number;
  createdAt: Date;
}

// ============================================================================
// Silence meter
// ============================================================================

export interface SilenceTick {
  minute: number; // 0-39 for last 40 minutes
  active: boolean;
}

export type SilenceStrip = SilenceTick[];
