// ============================================================================
// Claude Code Hook Event Payloads
// Verify exact field names against: https://code.claude.com/docs/en/hooks
// ============================================================================

export interface BaseHookPayload {
  session_id: string;
  cwd: string;
  transcript_path: string;
  hook_event_name: string;
}

export interface SessionStartPayload extends BaseHookPayload {
  hook_event_name: "SessionStart";
  source: "startup" | "resume" | "clear";
}

export interface SessionEndPayload extends BaseHookPayload {
  hook_event_name: "SessionEnd";
  reason?: string;
}

export interface UserPromptSubmitPayload extends BaseHookPayload {
  hook_event_name: "UserPromptSubmit";
  prompt: string;
}

export interface ToolUsePayload extends BaseHookPayload {
  hook_event_name: "PreToolUse" | "PostToolUse";
  /**
   * Correlates a Pre with its Post. Verified field name — it is
   * `tool_use_id`, not `tool_call_id`.
   *
   * A PreToolUse whose id never appears in a PostToolUse means the tool
   * failed: Claude Code does not emit PostToolUse for a failed call. That
   * absence is the only signal a failure happened, so anything reasoning
   * about failures has to match on this rather than inspect tool_response.
   */
  tool_use_id: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response?: unknown; // only on PostToolUse
  duration_ms?: number; // only on PostToolUse
}

export interface SubagentPayload extends BaseHookPayload {
  hook_event_name: "SubagentStart" | "SubagentStop";
  subagent_id: string;
  subagent_type: string;
  description?: string;
}

export interface StopPayload extends BaseHookPayload {
  hook_event_name: "Stop";
}

export interface NotificationPayload extends BaseHookPayload {
  hook_event_name: "Notification";
  notification_type: "permission_prompt" | "idle_prompt" | "auth_success";
  message?: string;
}

export interface ElicitationPayload extends BaseHookPayload {
  hook_event_name: "Elicitation" | "ElicitationResult";
  elicitation_id: string;
  result?: unknown; // only on ElicitationResult
}

export type HookPayload =
  | SessionStartPayload
  | SessionEndPayload
  | UserPromptSubmitPayload
  | ToolUsePayload
  | SubagentPayload
  | StopPayload
  | NotificationPayload
  | ElicitationPayload;

// ============================================================================
// WebSocket messages (collector -> UI)
// ============================================================================

export type WsMessageType =
  | "session:start"
  | "session:end"
  | "session:status"
  | "event:new"
  | "checkpoint:new"
  | "ask:new"
  | "ask:resolved"
  | "steer:queued"
  | "steer:delivered"
  | "expert:exchange"
  | "stall:detected"
  | "projects:updated"
  | "launch:started"
  | "launch:stopped"
  | "session:deleted"
  | "launch:cleaned";

export interface WsMessage<T = unknown> {
  type: WsMessageType;
  payload: T;
  timestamp: string;
}
