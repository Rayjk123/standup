// ============================================================================
// Project Registry
// ============================================================================

export interface Project {
  id: string;
  name: string;
  emoji?: string;
  iconPath?: string;
  repos: string[];
  setup?: string;
  expert?: string; // retrieval index name
  branch: string;
}

export interface ProjectWithCounts extends Project {
  /** Knowledge docs indexed for this project. Computed, not persisted. */
  knowledgeDocs: number;
}

export interface ProjectConfig {
  project: Project[];
}

// ============================================================================
// Sessions
// ============================================================================

export type SessionStatus = "running" | "idle" | "waiting" | "stalled";

export interface Session {
  id: string;
  projectId: string;
  title: string;
  cwd: string;
  parentSessionId?: string;
  status: SessionStatus;
  startedAt: Date;
  endedAt?: Date;
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
}

// ============================================================================
// Launches (console-started sessions)
// ============================================================================

export type LaunchStatus = "starting" | "running" | "failed" | "cleaned";

export type LaunchKind = "worktree" | "adopted";

/** Aliases accepted by `claude --model`. */
export type ClaudeModel = "opus" | "sonnet" | "haiku" | "fable";

/** Levels accepted by `claude --effort`. */
export type ClaudeEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface Launch {
  id: string;
  /** worktree = created its own checkout; adopted = resumed in place. */
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
  createdAt: Date;
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
}

// ============================================================================
// Expert exchanges
// ============================================================================

export interface ExpertExchange {
  id: string;
  sessionId: string;
  question: string;
  answer: string;
  region: string;
  sources: string[];
  createdAt: Date;
}

// ============================================================================
// Feed items (unified view)
// ============================================================================

export type FeedItemKind = "checkpoint" | "ask" | "expert" | "stall";

export interface FeedItem {
  id: string;
  kind: FeedItemKind;
  sessionId: string;
  timestamp: Date;
  data: Checkpoint | Ask | ExpertExchange | StallDetection;
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
