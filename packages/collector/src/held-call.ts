import type { Database } from "bun:sqlite";
import {
  cancelAsk,
  countAsksWithRequestBase,
  createAsk,
  getAskByRequestId,
  getFloorAskState,
  getPendingAsksBySession,
  getPermissionAskCandidateIds,
  getPermissionAskToolUseId,
  getRecentEventsBySession,
  permissionAskRequestId,
  permissionCandidatesRequestId,
} from "@standup/store";
import type { Ask, HookEvent } from "@standup/shared";
import { floorAnswerAllows, floorCallHash, isFloorGate } from "./floor/gate.js";
import { IDLE_NOTICE_GATE } from "./persona/policy.js";

/*
 * Which tool call a permission notice is about.
 *
 * Claude Code's Notification hook carries only the top-level session id and a
 * message: the terminal UI's "Claude needs your permission" names no tool, the
 * SDK's "… to use <tool>" names one. It fires once a dialog has been open a
 * few seconds. Background subagents share the session and keep starting and
 * finishing other calls meanwhile, so the newest PreToolUse is usually not the
 * call behind the dialog.
 *
 * The call behind a dialog has started and not finished: no PostToolUse (or
 * PostToolUseFailure) with its tool_use_id, and its thread has not ended (the
 * main thread's Stop or UserPromptSubmit, a subagent's SubagentStop). PreToolUse
 * hooks finish before Claude Code's own permission check runs, so a call the
 * safety floor is still holding has no dialog yet, and one the floor refused
 * never gets one. A call the floor allowed still goes through that check,
 * which can open a real dialog (Claude Code's bypass-immune checks). When
 * more than one call could be behind the dialog, the ask is tied to none: it
 * lists them and records their ids. Claude Code shows one dialog at a time,
 * so a notice for a different call means the earlier dialog closed.
 */

/** How many of a session's newest events are scanned to list its unfinished calls. */
const SCAN_EVENTS = 500;

export interface HeldToolCall {
  toolName: string;
  toolInput: unknown;
  /** The call's tool_use_id, when its PreToolUse carried one. */
  toolUseId?: string;
  /** The subagent that made the call; undefined for the main thread. */
  agentId?: string;
  cwd?: string;
  event: HookEvent;
}

const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

const isPostEvent = (type: string) => type === "PostToolUse" || type === "PostToolUseFailure";

/** The tool a "Claude needs your permission to use <tool>" notice names, or undefined. */
export function noticeToolName(message: unknown): string | undefined {
  if (typeof message !== "string") return undefined;
  const match = /needs your permission to use\s+(\S+)/.exec(message);
  return match?.[1]?.replace(/[.,;:!?]+$/, "") || undefined;
}

function callOf(e: HookEvent): HeldToolCall {
  const p = e.payload as Record<string, unknown>;
  const toolUseId = text(p.tool_use_id);
  const agentId = text(p.agent_id);
  // Kept as sent, the way the floor's hook reads it, so the floor's call hash matches.
  const cwd = typeof p.cwd === "string" && p.cwd ? p.cwd : undefined;
  return {
    toolName: typeof p.tool_name === "string" ? p.tool_name : "",
    toolInput: p.tool_input ?? null,
    ...(toolUseId ? { toolUseId } : {}),
    ...(agentId ? { agentId } : {}),
    ...(cwd ? { cwd } : {}),
    event: e,
  };
}

/**
 * The session's started-but-unfinished tool calls among its newest events,
 * newest first. A PostToolUse with no tool_use_id finishes nothing: it can't
 * say which call it ended.
 */
export function unfinishedToolCalls(db: Database, sessionId: string): HeldToolCall[] {
  const events = getRecentEventsBySession(db, sessionId, SCAN_EVENTS);
  const finished = new Set<string>();
  const endedAgents = new Set<string>();
  let mainTurnClosed = false;
  const calls: HeldToolCall[] = [];
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    const type = e.type as string;
    const p = e.payload as Record<string, unknown>;
    if (type === "UserPromptSubmit" || type === "Stop") {
      mainTurnClosed = true;
      continue;
    }
    if (type === "SubagentStop") {
      const agentId = text(p.agent_id);
      if (agentId) endedAgents.add(agentId);
      continue;
    }
    const toolUseId = text(p.tool_use_id);
    if (isPostEvent(type)) {
      if (toolUseId) finished.add(toolUseId);
      continue;
    }
    if (type !== "PreToolUse") continue;
    if (toolUseId && finished.has(toolUseId)) continue;
    const call = callOf(e);
    if (call.agentId ? endedAgents.has(call.agentId) : mainTurnClosed) continue;
    calls.push(call);
  }
  return calls;
}

/** What one tool call's PreToolUse recorded, found by its tool_use_id, and whether the call is over. */
export interface CallRecord {
  call: HeldToolCall;
  /** It finished (a PostToolUse) or its thread ended since it started. */
  over: boolean;
}

/**
 * The call `toolUseId` of this session, looked up by id rather than within a
 * window of recent events, or null when no PreToolUse for it was recorded.
 */
export function findToolCall(db: Database, sessionId: string, toolUseId: string): CallRecord | null {
  const pre = db
    .query(
      `SELECT * FROM events
        WHERE session_id = ? AND type = 'PreToolUse' AND json_extract(payload_json, '$.tool_use_id') = ?
        ORDER BY seq DESC LIMIT 1`
    )
    .get(sessionId, toolUseId) as { id: number; session_id: string; seq: number; type: string; payload_json: string; created_at: string } | null;
  if (!pre) return null;
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(pre.payload_json) as Record<string, unknown>;
  } catch {
    // An unreadable payload names no thread; the call reads as main-thread.
  }
  const call = callOf({
    id: String(pre.id),
    sessionId: pre.session_id,
    seq: pre.seq,
    type: "PreToolUse",
    payload,
    createdAt: new Date(pre.created_at),
  });
  const finished = db
    .query(
      `SELECT 1 FROM events
        WHERE session_id = ? AND seq > ? AND type IN ('PostToolUse', 'PostToolUseFailure')
          AND json_extract(payload_json, '$.tool_use_id') = ?
        LIMIT 1`
    )
    .get(sessionId, pre.seq, toolUseId);
  const threadEnded = call.agentId
    ? db
        .query(
          `SELECT 1 FROM events
            WHERE session_id = ? AND seq > ? AND type = 'SubagentStop' AND json_extract(payload_json, '$.agent_id') = ?
            LIMIT 1`
        )
        .get(sessionId, pre.seq, call.agentId)
    : db
        .query(`SELECT 1 FROM events WHERE session_id = ? AND seq > ? AND type IN ('Stop', 'UserPromptSubmit') LIMIT 1`)
        .get(sessionId, pre.seq);
  return { call, over: !!finished || !!threadEnded };
}

/**
 * The safety-floor hold raised for `call` (the floor's hook holds a call under
 * its tool_use_id), whatever its status, or null when the floor raised none
 * for this exact call: a hold whose recorded call differs from the
 * PreToolUse's is someone else's.
 */
export function floorHoldForCall(db: Database, sessionId: string, call: HeldToolCall): Ask | null {
  if (!call.toolUseId) return null;
  const ask = getAskByRequestId(db, sessionId, call.toolUseId);
  if (!ask || !isFloorGate(ask.gate)) return null;
  const input = call.toolInput && typeof call.toolInput === "object" && !Array.isArray(call.toolInput) ? (call.toolInput as Record<string, unknown>) : {};
  const expected = floorCallHash({ toolName: call.toolName, toolInput: input, cwd: call.cwd ?? "" });
  return getFloorAskState(db, ask.id)?.callHash === expected ? ask : null;
}

/** Whether `call` can be behind a dialog as far as the floor goes: it holds no pending or refused hold for it. */
function floorLetsDialogShow(hold: Ask | null): boolean {
  if (!hold) return true;
  return hold.status === "answered" && floorAnswerAllows(hold.answer);
}

/** The call a permission notice is about, when one can be told, and every call it could be. */
export interface NoticeTarget {
  call: HeldToolCall | null;
  candidates: HeldToolCall[];
}

/** Tools whose call never opens a permission dialog of its own: a subagent launch stays unfinished while the subagent runs. */
const NO_DIALOG_TOOLS = new Set(["Agent", "Task"]);

/**
 * The calls a permission notice could be about: unfinished calls to the tool
 * it names (any tool when it names none) that the floor isn't holding and
 * didn't refuse, leaving out subagent launches. It is tied to one only when
 * that is the only candidate; otherwise to none, and the ask lists them.
 *
 * A call denied or dismissed in the terminal records no PostToolUse, so it
 * stays a candidate until its thread ends. Hook events don't say which batch
 * a call belongs to (read-only calls run side by side and finish in any
 * order), so no later call is taken to show it over: listing a dead call is
 * safe, dropping one whose dialog is open is not.
 */
export function noticeTarget(db: Database, sessionId: string, toolName?: string): NoticeTarget {
  const candidates: HeldToolCall[] = [];
  for (const call of unfinishedToolCalls(db, sessionId)) {
    if (NO_DIALOG_TOOLS.has(call.toolName)) continue;
    if (toolName && call.toolName !== toolName) continue;
    if (!floorLetsDialogShow(floorHoldForCall(db, sessionId, call))) continue;
    candidates.push(call);
  }
  return { call: candidates.length === 1 ? candidates[0]! : null, candidates };
}

/** One call as an ask shows it: the tool and its input, clipped. */
export function describeCall(call: HeldToolCall): string {
  const inputText = call.toolInput ? JSON.stringify(call.toolInput) : "";
  return `${call.toolName}${inputText ? ` — ${inputText.slice(0, 300)}` : ""}`;
}

/**
 * An ambiguous notice's text: the calls the open dialog could be for, newest
 * first, marking any the floor allowed (Claude Code's own check can still
 * open a dialog for those).
 */
export function describeCandidates(db: Database, sessionId: string, candidates: HeldToolCall[]): string | null {
  if (candidates.length < 2) return null;
  // Every one is listed: an answer could approve any of them.
  const shown = candidates.map((c) => {
    const allowed = floorHoldForCall(db, sessionId, c) ? " (the safety floor allowed this one)" : "";
    return `- ${describeCall(c)}${allowed}`;
  });
  return [`A permission dialog is open for one of ${candidates.length} calls still in flight; check the terminal for which:`, ...shown].join("\n");
}

/** The candidate calls an ask tied to no one call recorded that are still in flight, or null when it recorded none. */
export function untiedAskCandidates(db: Database, ask: Ask): HeldToolCall[] | null {
  const ids = getPermissionAskCandidateIds(db, ask.id);
  if (!ids) return null;
  const live: HeldToolCall[] = [];
  for (const id of ids) {
    const record = findToolCall(db, ask.sessionId, id);
    if (record && !record.over && floorLetsDialogShow(floorHoldForCall(db, ask.sessionId, record.call))) live.push(record.call);
  }
  return live;
}

/**
 * Why a pending permission ask no longer has a dialog behind it: the call it
 * is tied to is over (it finished or its thread ended), or the floor now holds
 * or refused it; or every call an untied ask listed is over. Null when it may
 * still have one (an idle notice, an untied ask that listed no calls, a call
 * whose PreToolUse isn't on record, or a call still waiting).
 */
export function staleCallReason(db: Database, ask: Ask): string | null {
  if (ask.kind !== "permission_prompt" || ask.gate === IDLE_NOTICE_GATE) return null;
  const toolUseId = getPermissionAskToolUseId(db, ask.id);
  if (!toolUseId) {
    const live = untiedAskCandidates(db, ask);
    return live && live.length === 0 ? "Every call this prompt could be for already finished" : null;
  }
  const record = findToolCall(db, ask.sessionId, toolUseId);
  if (!record) return null;
  if (record.over) return `Call ${toolUseId} already finished`;
  if (!floorLetsDialogShow(floorHoldForCall(db, ask.sessionId, record.call))) return `The safety floor holds or refused call ${toolUseId}`;
  return null;
}

/**
 * Why a pending permission ask can't be answered from Standup though its
 * dialog may be open: it is tied to no call, recorded none (a candidate's
 * PreToolUse carried no tool_use_id), and more than one call is in flight, so
 * an answer could approve one nobody was shown. Null when it can.
 */
export function unanswerableReason(db: Database, ask: Ask): string | null {
  if (ask.kind !== "permission_prompt" || ask.gate === IDLE_NOTICE_GATE) return null;
  if (getPermissionAskToolUseId(db, ask.id) || getPermissionAskCandidateIds(db, ask.id)) return null;
  const inFlight = noticeTarget(db, ask.sessionId).candidates.length;
  return inFlight > 1
    ? `Standup can't tell which of the ${inFlight} calls in flight this dialog is for, so it won't answer it; answer in the terminal`
    : null;
}

/**
 * Raises a permission ask for `target`: tied to its call when there is one,
 * else recording every candidate call when all carry ids. A later ask with
 * the same id base gets the next numbered id.
 */
export function createPermissionAsk(
  db: Database,
  sessionId: string,
  question: string,
  target: NoticeTarget | null,
  opts: { gate?: string } = {}
): Ask {
  const ids = (target?.candidates ?? []).map((c) => c.toolUseId).filter((id): id is string => !!id);
  const base = target?.call?.toolUseId
    ? permissionAskRequestId(target.call.toolUseId)
    : ids.length > 0 && ids.length === target?.candidates.length
      ? permissionCandidatesRequestId(ids)
      : null;
  if (!base) return createAsk(db, sessionId, "permission_prompt", question, undefined, opts);
  const n = countAsksWithRequestBase(db, sessionId, base);
  return createAsk(db, sessionId, "permission_prompt", question, undefined, { ...opts, requestId: n > 0 ? `${base}#${n}` : base });
}

/**
 * The main-thread AskUserQuestion call a permission ask is about, while it is
 * in flight: the call it is tied to, or the only candidate of an untied ask.
 * Null otherwise; menu keystrokes are then not the question's to send.
 */
export function askQuestionCall(db: Database, ask: Ask): HeldToolCall | null {
  const tied = getPermissionAskToolUseId(db, ask.id);
  const call = tied ? findToolCall(db, ask.sessionId, tied) : null;
  const question = tied ? (call && !call.over ? call.call : null) : noticeTarget(db, ask.sessionId).call;
  return question?.toolName === "AskUserQuestion" && !question.agentId ? question : null;
}

/**
 * Whether pending ask `ask` already stands for the dialog `target` describes,
 * so the notice raises nothing new. Claude Code shows one dialog at a time and
 * notifies once per dialog. A tied ask stands only while the notice can still
 * be about its call alone: once other calls could be behind the dialog, it is
 * replaced by an ask listing them all, since a dialog can close without its
 * ask (a reply sent to the pane, an attached terminal) and an answer would
 * then approve a call the ask never showed.
 */
export function askStandsFor(db: Database, ask: Ask, target: NoticeTarget): boolean {
  const tied = getPermissionAskToolUseId(db, ask.id);
  if (target.call?.toolUseId) return tied === target.call.toolUseId;
  if (tied) return false;
  const recorded = getPermissionAskCandidateIds(db, ask.id);
  const now = target.candidates.map((c) => c.toolUseId ?? "").sort();
  return recorded ? recorded.join(",") === now.join(",") : now.length === 0 || now.every((id) => !id);
}

/**
 * Retires a session's pending permission asks that no longer have a dialog
 * behind them (see staleCallReason). An untied ask that recorded no calls is
 * retired when nothing it could be about is in flight on `untied:
 * "when-idle"`; any untied ask is retired on `untied: "always"` (a new
 * main-thread prompt). An idle notice is retired only on `idleNotices`.
 * Returns the retired asks.
 */
export function retirePermissionAsks(
  db: Database,
  sessionId: string,
  opts: { untied?: "always" | "when-idle"; idleNotices?: boolean } = {}
): Ask[] {
  const retired: Ask[] = [];
  let inFlight: boolean | undefined;
  for (const ask of getPendingAsksBySession(db, sessionId)) {
    if (ask.kind !== "permission_prompt") continue;
    let retire: boolean;
    if (ask.gate === IDLE_NOTICE_GATE) {
      retire = !!opts.idleNotices;
    } else if (getPermissionAskToolUseId(db, ask.id)) {
      retire = staleCallReason(db, ask) !== null;
    } else if (opts.untied === "always" || staleCallReason(db, ask) !== null) {
      retire = true;
    } else if (opts.untied === "when-idle" && !getPermissionAskCandidateIds(db, ask.id)) {
      inFlight ??= noticeTarget(db, sessionId).candidates.length > 0;
      retire = !inFlight;
    } else {
      retire = false;
    }
    if (!retire) continue;
    cancelAsk(db, ask.id);
    retired.push({ ...ask, status: "cancelled" });
  }
  return retired;
}
