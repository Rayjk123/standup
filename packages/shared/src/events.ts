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
  tool_call_id: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response?: unknown; // only on PostToolUse
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
  | "launch:cleaned";

export interface WsMessage<T = unknown> {
  type: WsMessageType;
  payload: T;
  timestamp: string;
}
