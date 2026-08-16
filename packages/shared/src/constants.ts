// ============================================================================
// Server configuration
// ============================================================================

export const DEFAULT_COLLECTOR_PORT = 7777;
export const DEFAULT_WS_PORT = 7778;

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
// Status colors (for consistency with UI)
// ============================================================================

export const STATUS_COLORS = {
  running: "#4C9EF5",
  idle: "#48536A",
  waiting: "#FF6B84",
  stalled: "#F0A93B",
} as const;
