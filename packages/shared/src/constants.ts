import type { ClaudeModel, CodexEffort, CodexModelInfo, IdentityProviderConfig } from "./types.js";

// ============================================================================
// Server configuration
// ============================================================================

export const DEFAULT_COLLECTOR_PORT = 7777;
export const DEFAULT_WS_PORT = 7778;

/**
 * Bumped when the WS `hello-ok` handshake or the frame contract changes shape.
 * The client can compare it against what it was built for and fall back to REST
 * rather than trust frames it may not understand.
 */
export const WS_PROTOCOL_VERSION = 1;

/**
 * Header a service process (the Slack adapter) sets on its WS upgrade to say it
 * relays frames to shared places rather than showing them to one person. Such a
 * connection never receives a frame addressed to one user and boots from the
 * shared snapshot, whatever identity it resolves to. Setting it only narrows
 * what a connection receives, so it needs no authentication.
 */
export const SERVICE_CLIENT_HEADER = "x-standup-service-client";

/**
 * Where, under Standup's data dir, the socket of the tmux server that hosts
 * every launched worker's pane lives (`tmux -S <dataDir>/tmux/workers`; see
 * workerTmuxSocket). It is not under /tmp, so no bare `tmux …`, `-L <name>`
 * or TMUX_TMPDIR a worker uses reaches it, and the safety floor's hold on
 * Standup's data covers any command that names or links to it.
 */
export const WORKER_TMUX_SOCKET_SUBPATH = "tmux/workers";

/** The workers' socket under the default data dir, as an owner types it in a terminal. */
export const WORKER_TMUX_SOCKET_HINT = `~/.local/share/standup/${WORKER_TMUX_SOCKET_SUBPATH}`;

// ============================================================================
// Timeouts and limits
// ============================================================================

export const ASK_HUMAN_DEFAULT_TIMEOUT_S = 3600; // 1 hour
export const ASK_HUMAN_MAX_TIMEOUT_S = 86400; // 24 hours

export const SILENCE_METER_MINUTES = 40;
export const STALL_THRESHOLD_MINUTES = 30;

// Max events retained per session before rolling into summaries
export const MAX_EVENTS_PER_SESSION = 1000;

// ============================================================================
// Stuckness detection thresholds
// ============================================================================

export const STUCKNESS = {
  // Same grep/glob pattern repeated with empty results
  REPEATED_EMPTY_SEARCH: 3,
  // Consecutive non-zero Bash exit codes
  CONSECUTIVE_BASH_FAILURES: 5,
  // Tool calls without Edit/Write (reading, not progressing)
  READ_ONLY_TOOL_CHAIN: 20,
  // Same file read N times within a turn
  FILE_REREAD_THRESHOLD: 4,
  // Cooldown between nudges (minutes)
  NUDGE_COOLDOWN_MINUTES: 15,
} as const;

// ============================================================================
// Session titles
// ============================================================================

/**
 * The longest a stored session title may run — a title, not a sentence. Every
 * write path caps to this so no title is ever a wall of text (the Work view
 * stays readable and the Slack feed doesn't flood). Shared so the store, the
 * collector, and the Haiku title cleaner all agree on one bound.
 */
export const MAX_TITLE_CHARS = 70;

/**
 * Bounds a title to `max` chars, collapsing internal whitespace to a single
 * line and truncating on a word boundary (with an ellipsis) when it overruns —
 * so a capped title reads as words, not a mid-word stump. Falls back to a hard
 * cut when there is no usable word boundary in range (e.g. one long token), so
 * the result is never longer than `max`. Pure and idempotent.
 */
export function capTitle(raw: string, max: number = MAX_TITLE_CHARS): string {
  const collapsed = raw.replace(/\s+/g, " ").trim();
  // Count by code points so a cut never lands inside a surrogate pair, which
  // would leave a lone half-emoji that renders as a replacement glyph.
  const points = Array.from(collapsed);
  if (points.length <= max) return collapsed;
  const hard = points.slice(0, max - 1).join("");
  const lastSpace = hard.lastIndexOf(" ");
  const body = lastSpace >= Math.floor(max / 2) ? hard.slice(0, lastSpace) : hard;
  return `${body.trimEnd()}…`;
}

// ============================================================================
// Status colors (for consistency with UI)
// ============================================================================

export const STATUS_COLORS = {
  running: "#4C9EF5",
  idle: "#48536A",
  waiting: "#FF6B84",
  stalled: "#F0A93B",
} as const;

// ============================================================================
// Review lenses (daily-review fan-out)
// ============================================================================

/** Built-in review lenses used by the daily-review fan-out when a project sets none. */
export const REVIEW_LENSES = ["bugs", "best-practices", "security", "perf"] as const;

// ============================================================================
// Harnesses (agent CLIs a launch can drive)
// ============================================================================

/**
 * The agent CLIs the console can launch (see HarnessId). `claude` is the
 * default harness and stays first; `codex` is the additive second one. The
 * server validates a per-launch harness choice against this set, and the
 * composer offers it. Keep in sync with the HarnessId union.
 */
export const HARNESS_IDS = ["claude", "codex"] as const;

/**
 * Reasoning-effort levels a Codex launch may request (see CodexEffort). The
 * server validates a per-launch `codexEffort` against this set, and the composer
 * offers it. Keep in sync with the CodexEffort union. Distinct from the Claude
 * effort ladder — Codex starts at `minimal` and goes past `max` to `ultra`.
 */
export const CODEX_EFFORTS: CodexEffort[] = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

/**
 * Named Codex models for the composer, empty by default. Model ids vary with
 * the Codex build and the provider behind it, so the composer offers the CLI's
 * own default model and a free-text id. A fork may add entries, recommended
 * first, each with the reasoning-effort levels its Codex build reports for it
 * (`codex debug models` lists both); an entry with no `efforts` is offered
 * every level. An entry is no promise a model is reachable: the provider can
 * still refuse one, which fails the launch with the provider's error.
 */
export const CODEX_MODEL_CATALOG: CodexModelInfo[] = [];

/**
 * The ids of CODEX_MODEL_CATALOG, empty by default. A convenience list, NOT an
 * allowlist: Codex model ids are free-form (CodexModel) and vary with the build
 * and the provider fronting it, so the composer pairs this list with a free-text
 * entry and the server accepts any string.
 *
 * Asserting none is its own choice: no `-m` is passed, so the Codex CLI's own
 * configured model (`model` in ~/.codex/config.toml) governs — the same way an
 * omitted Claude `--model` leaves the CLI's default in place.
 */
export const CODEX_MODELS: string[] = CODEX_MODEL_CATALOG.map((m) => m.id);

/**
 * Models a Claude launch may request (see ClaudeModel), in the order the
 * composer offers them: each family's `latest` alias followed by that family's
 * pinned versions. The server validates a per-launch `model` against this set,
 * and both the composer and the running-session model switcher offer it. Keep in
 * sync with the ClaudeModel union.
 */
export const CLAUDE_MODELS: ClaudeModel[] = [
  "opus",
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-opus-4-5",
  "claude-opus-4-1",
  "claude-opus-4",
  "sonnet",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "claude-sonnet-4-5",
  "claude-sonnet-4",
  "claude-sonnet-3-7",
  "haiku",
  "claude-haiku-4-5",
  "claude-haiku-4",
  "claude-haiku-3-5",
  "fable",
  "claude-fable-5-1",
  "claude-fable-5",
];

/** The reasoning effort the composer pre-selects for a Codex launch. */
export const CODEX_DEFAULT_EFFORT: CodexEffort = "medium";

// ============================================================================
// Identity provider (pluggable request-identity resolution)
// ============================================================================

/**
 * The default request header carrying the acting user's identity. An
 * authenticating tunnel or proxy (see the collector's TunnelProvider and
 * `STANDUP_TUNNEL_IDENTITY_HEADER`) stamps the user it authenticated as this
 * header, stripping any client-set copy — so behind it the header is a
 * verified, unforgeable identity. The default identity provider reads it
 * unless an authenticating tunnel names another header, or
 * `STANDUP_IDENTITY_HEADER` names the one a deployment's proxy carries
 * identity under (see resolveIdentityHeader).
 */
export const DEFAULT_IDENTITY_HEADER = "x-tunnel-user";

/**
 * The default identity provider. `auth: "none"` (no challenge), the user
 * identifier read from `DEFAULT_IDENTITY_HEADER`, a loopback source trusted
 * (an authenticating tunnel forwards to loopback), and no extra trusted
 * proxies. The collector narrows `loopbackIsTrusted` to the tunnel provider in
 * force. A fresh object each call so a caller may mutate its own copy without
 * affecting others.
 */
export function defaultIdentityConfig(): IdentityProviderConfig {
  return {
    auth: "none",
    userIdentifier: { type: "http-header", header: DEFAULT_IDENTITY_HEADER },
    trustedProxies: [],
    loopbackIsTrusted: true,
  };
}

/**
 * What the identity-header choice needs from the tunnel provider in force:
 * whether it opens tunnels, and the header its service stamps with the user it
 * authenticated (unset when it authenticates no one).
 */
export interface TunnelIdentity {
  enabled: boolean;
  identityHeader?: string;
}

/**
 * The request header that names the acting user, lower-cased: `explicit`
 * (`STANDUP_IDENTITY_HEADER`) when set, else the header an enabled
 * authenticating tunnel stamps, else `DEFAULT_IDENTITY_HEADER`. A disabled
 * provider's header, or a provider that authenticates no one, never names it.
 * The collector (which reads the header, with its resolved TunnelProvider) and
 * the console proxy (which binds a user session to it, with the provider as
 * tunnelIdentityFromEnv reads it) both resolve the name here, so they read the
 * same header. Whether the header is trusted on loopback is the collector's
 * decision.
 */
export function resolveIdentityHeader(explicit: string | undefined, tunnel?: TunnelIdentity): string {
  const header = explicit?.trim();
  const tunnelHeader = tunnel?.enabled ? tunnel.identityHeader?.trim() : undefined;
  return (header || tunnelHeader || DEFAULT_IDENTITY_HEADER).toLowerCase();
}

// ============================================================================
// Reserved projects
// ============================================================================

/**
 * Id of the reserved GLOBAL knowledge corpus — the home for generic knowledge
 * (best practices, general notes) that isn't tied to any one repo. It is
 * auto-ensured on boot, always spanned by cross-project (corpus:"all") search
 * and launch-time injection, and hidden from the launchable-project UI. A
 * `reserved` project: contribute knowledge to it, but you can't launch a
 * session against it.
 */
export const GLOBAL_PROJECT_ID = "global";

// ============================================================================
// Hooks
// ============================================================================

/**
 * The Claude Code hook events Standup reports to the collector's `/hook`
 * route: the global hooks setup-hooks installs, and the token-carrying hooks
 * a launched worker gets beside them (buildFloorHookSettings).
 */
export const STANDUP_HOOK_EVENTS = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  // A failed call gets this instead of PostToolUse; without it the call never reads as finished.
  "PostToolUseFailure",
  "SubagentStart",
  "SubagentStop",
  "Stop",
  "Notification",
] as const;

/**
 * Client-side timeout (seconds) on the hooks whose reply carries pushed
 * knowledge (the collector's knowledge-push.ts), for both the global hooks and
 * a launched worker's token-carrying hooks. The collector bounds its own
 * search to a quarter second and fails open; this bounds the wait on a
 * collector that is down or wedged, so the agent proceeds without the context
 * instead of stalling. The other events keep Claude Code's default.
 */
export const HOOK_CLIENT_TIMEOUT_SECONDS: Readonly<Partial<Record<string, number>>> = {
  SessionStart: 5,
  UserPromptSubmit: 5,
  PreToolUse: 5,
};
