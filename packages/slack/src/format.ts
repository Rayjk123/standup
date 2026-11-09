// Pure formatting: Standup events → Slack text/Block Kit. No I/O here, so it's
// trivially testable and the side-effecting modules (feed.ts, asks.ts) stay thin.

import type { KnownBlock } from "@slack/types";
import type { WsMessage, Ask, Checkpoint, Launch, StallDetection, PlanApproval, KnowledgeChange, Digest } from "@standup/shared";
import { isRoutineCheckpoint, knowledgeChangeLine, digestHeadline, sessionShareUrl } from "@standup/shared";
import type { ActiveWorkItem } from "./collector-client.js";
import { redact } from "./redact.js";

/** Action id prefix for ask-option buttons; the collector ask id + answer ride in `value`. */
export const ASK_ACTION_PREFIX = "ask_answer:";

/** Action id prefix for plan-approval buttons; the plan id + decision ride in `value`. */
export const PLAN_ACTION_PREFIX = "plan_decide:";

/** Encoded in a button's `value` (Slack cap 2000 chars — questions/answers are short). */
export interface AskActionValue {
  askId: string;
  answer: string;
}

/** Encoded in a plan-approval button's `value`. */
export interface PlanActionValue {
  planId: string;
  decision: "approve" | "reject";
}

/** Final cap for a section's composed text — headroom under Slack's 3000 limit. */
const SECTION_CAP = 2900;

/** Cap for a session title in a feed line — bounded well under the section cap so the title never dominates. */
const TITLE_FEED_CAP = 120;

/** Final cap for a context element's composed text — same 3000 limit as a section. */
const CONTEXT_CAP = 2900;

/**
 * A mrkdwn section whose text is capped AFTER composition. Slack rejects the
 * WHOLE message when any one section's text exceeds 3000 chars, and escape()
 * only GROWS a string (each of &, <, > becomes a 4–5 char entity) — so a
 * per-piece truncate before escaping + concatenation can still overflow. Callers
 * escape and concatenate their pieces first, then hand the finished text here,
 * which truncates once (with an ellipsis) under the cap. Mirrors mirror-format's
 * section().
 */
function sectionText(text: string): KnownBlock {
  return { type: "section", text: { type: "mrkdwn", text: truncate(text, SECTION_CAP) } };
}

/**
 * A mrkdwn context element whose text is capped AFTER composition — the same
 * escape-then-cap discipline sectionText enforces. escape() only GROWS a string,
 * so a per-piece truncate before escaping can still overflow; callers escape and
 * compose first, then hand the finished text here, which truncates once under
 * Slack's 3000-char element limit (an over-cap context element is rejected as
 * invalid_blocks, which would fail the whole chat.update and strand the card).
 */
function contextText(text: string): KnownBlock {
  return { type: "context", elements: [{ type: "mrkdwn", text: truncate(text, CONTEXT_CAP) }] };
}

/**
 * The note for a closed ask card whose answer arrived elsewhere (web UI, another
 * surface). The answer is untrusted agent/UI text, so redact → escape → cap it:
 * un-escaped it could inject mrkdwn/links, and past ~3000 chars the context
 * element is rejected as invalid_blocks (the card would then never show the answer).
 */
export function answeredElsewhereNote(answer: string): string {
  return answer
    ? `✅ Answered elsewhere: ${truncate(escape(redact(answer)), CONTEXT_CAP)}`
    : "☑️ Resolved elsewhere (dismissed or timed out).";
}

/**
 * One feed line for the channel, or null to drop the event. `title` is the
 * resolved session title (caller looks it up); unused for launch events.
 * Deliberately low-noise: only the events a human watching a feed cares about.
 */
export function feedLine(msg: WsMessage, title: string | undefined): string | null {
  // Titles are capped at the source, but truncate here too so a legacy or
  // oversized one can't turn a feed line into a wall of text.
  const who = title ? `*${escape(truncate(redact(title), TITLE_FEED_CAP))}*` : "a session";
  switch (msg.type) {
    case "checkpoint:new": {
      const cp = msg.payload as Checkpoint;
      // Routine structural ticks (completed-todo / subagent-turn spam) are the
      // firehose — keep them out of the feed; only deliberate self-reported and
      // auto (turn-end / "done") checkpoints are worth a line.
      if (isRoutineCheckpoint(cp.source)) return null;
      return `🔖 ${who} — ${escape(truncate(redact(cp.summary), 500))}`;
    }
    case "ask:new": {
      const ask = msg.payload as Ask;
      const emoji = ask.kind === "permission_prompt" ? "🔐" : "❓";
      return `${emoji} ${who} needs input: ${escape(truncate(redact(ask.question), 300))}`;
    }
    case "stall:detected": {
      const st = msg.payload as StallDetection;
      return `🐌 ${who} looks stuck${st.reason ? `: ${escape(truncate(redact(st.reason), 160))}` : ""}`;
    }
    case "session:status": {
      const p = msg.payload as { status?: string };
      if (p.status === "done") return `🏁 ${who} finished`;
      if (p.status === "stalled") return `🐌 ${who} looks stalled`;
      return null; // running/idle/waiting are too chatty for a feed
    }
    case "launch:started": {
      const l = msg.payload as Launch;
      return `🚀 launched: ${escape(truncate(redact(l.task), 200))}`;
    }
    case "launch:stopped": {
      return `🛑 a launch was stopped`;
    }
    case "knowledge:change": {
      // The knowledge-graph-change leg: a doc accepted / removed / reconciled /
      // flagged as contradicting another / distilled. Shares one line formatter
      // with the web feed so both surfaces read identically.
      const kc = msg.payload as KnowledgeChange;
      return escape(truncate(redact(knowledgeChangeLine(kc)), 500));
    }
    case "digest:posted": {
      // The once-a-day standup digest: a bold headline over the summary body.
      // Compose the escaped headline + body first, then cap once under the
      // section limit (escape only grows the string, so a per-piece truncate
      // before escaping could still overflow and drop the whole line).
      const digest = msg.payload as Digest;
      const headline = `*${escape(digestHeadline(digest))}*`;
      const body = digest.body?.trim() ? `\n${escape(redact(digest.body.trim()))}` : "";
      return truncate(`${headline}${body}`, SECTION_CAP);
    }
    default:
      // event:new is content-free; steer / knowledge:draft (a sidebar refetch
      // nudge, not a feed line) / session:start-end are not fed.
      return null;
  }
}

/** DM message body for a fresh ask: the question, option buttons, and a free-text hint. */
export function askMessage(
  ask: Ask,
  sessionTitle: string,
  mentionUserId?: string,
): { text: string; blocks: KnownBlock[] } {
  const isPermission = ask.kind === "permission_prompt";
  const label = isPermission ? "🔐 Permission needed" : "❓ Question";
  const mention = mentionUserId ? `<@${mentionUserId}> ` : "";
  const blocks: KnownBlock[] = [
    // Header line: emoji + kind + session, so the two ask types read apart at a
    // glance instead of as one wall of text. Mention (when posted in a channel
    // thread) pings the recipient — the mention token stays UN-escaped so it
    // renders as a real ping; only the agent-authored title is escaped.
    sectionText(`${mention}*${label}*  ·  _${escape(redact(sessionTitle))}_`),
    // The question/detail on its own. Redact BEFORE escape (so a secret near the
    // cap is still scrubbed); sectionText caps the finished, escape-grown text so
    // an escape-heavy question can't push the section past 3000 and drop it all.
    sectionText(escape(redact(ask.question))),
  ];

  // A button's `value` is capped at 2000 chars; an over-cap element fails the
  // ENTIRE message. Drop options that wouldn't fit — they stay answerable by a
  // free-text reply (we must NOT truncate the value, which would submit a
  // corrupted answer to /resolve).
  const options = (ask.options ?? []).filter(
    (o) => o.trim().length > 0 && buttonValue(ask.id, o).length <= 2000,
  );
  if (options.length > 0) {
    // Slack allows ≤5 elements per actions block and requires a UNIQUE action_id
    // per element — hence the indexed suffix; the answer itself rides in `value`.
    for (let i = 0; i < options.length; i += 5) {
      const group = options.slice(i, i + 5);
      blocks.push({
        type: "actions",
        elements: group.map((opt, j) => ({
          type: "button",
          text: { type: "plain_text", text: truncate(opt, 72), emoji: true },
          action_id: `${ASK_ACTION_PREFIX}${i + j}`,
          value: buttonValue(ask.id, opt),
        })),
      });
    }
  }

  const hint = isPermission
    ? "💬 Reply in this thread with your input (e.g. the menu number or `yes`) — I'll type it into the session."
    : options.length > 0
      ? "💬 Tap an option, or reply in this thread to answer."
      : "💬 Reply in this thread to answer.";
  blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: hint }] });

  // Fallback text (notifications, no-blocks clients) — lead with the emoji + kind.
  return { text: `${mention}${label} · ${redact(sessionTitle)}: ${truncate(redact(ask.question), 200)}`, blocks };
}

/** Replacement blocks after the ask is answered — no buttons, shows the answer. */
export function answeredBlocks(question: string, answer: string, sessionTitle: string): KnownBlock[] {
  // Escape BEFORE capping (escape only grows the string), so an answer full of
  // <,>,& can't slip past the cap and get the context element rejected.
  return [
    sectionText(`✅ *Answered*  ·  _${escape(redact(sessionTitle))}_\n\n~${escape(redact(question))}~`),
    contextText(`↳ ${escape(redact(answer)) || "_(dismissed)_"}`),
  ];
}

/** Replacement blocks when an ask was resolved elsewhere / timed out / cancelled. */
export function closedBlocks(question: string, note: string, sessionTitle: string): KnownBlock[] {
  return [
    sectionText(`☑️ *Closed*  ·  _${escape(redact(sessionTitle))}_\n\n~${escape(redact(question))}~`),
    contextText(note),
  ];
}

/**
 * Owner-attention message for a plan awaiting approval — the plan-gate's route
 * to the owner (composes with the ask path's owner routing). Shows the proposed
 * plan, the machine-checkable acceptance criterion, and Approve/Reject buttons,
 * plus a link to the console's Live workers drawer (its plan-approval panel),
 * where the owner can edit before approving.
 */
export function planMessage(
  plan: PlanApproval,
  webUrl: string,
  mentionUserId?: string,
): { text: string; blocks: KnownBlock[] } {
  const mention = mentionUserId ? `<@${mentionUserId}> ` : "";
  const files = plan.relevantFiles.length
    ? `\n\n*Relevant files*\n${escape(redact(plan.relevantFiles.join("\n")))}`
    : "";
  const criterion = plan.acceptanceCriterion
    ? `\n\n*Acceptance criterion*\n\`${escape(redact(plan.acceptanceCriterion))}\``
    : "";
  const blocks: KnownBlock[] = [
    sectionText(`${mention}*📋 Plan awaiting your approval*  ·  _${escape(redact(plan.projectId))}_`),
    // Compose plan + criterion + files into ONE body, then cap once — capping
    // each piece before concatenation could still sum past the section limit.
    sectionText(`${escape(redact(plan.plan ?? "(no plan text)"))}${criterion}${files}`),
    {
      type: "actions",
      elements: [
        { type: "button", style: "primary", text: { type: "plain_text", text: "Approve", emoji: true }, action_id: `${PLAN_ACTION_PREFIX}approve`, value: planButtonValue(plan.id, "approve") },
        { type: "button", style: "danger", text: { type: "plain_text", text: "Reject", emoji: true }, action_id: `${PLAN_ACTION_PREFIX}reject`, value: planButtonValue(plan.id, "reject") },
      ],
    },
    { type: "context", elements: [{ type: "mrkdwn", text: `💬 Approve as-is or reject here, or open <${webUrl.replace(/\/+$/, "")}/work|Live workers> to edit the plan first.` }] },
  ];
  return { text: `${mention}📋 Plan awaiting approval · ${redact(plan.projectId)}: ${truncate(redact(plan.plan ?? ""), 200)}`, blocks };
}

/** Replacement blocks once a plan is resolved (approved / rejected, here or elsewhere). */
export function planResolvedBlocks(plan: PlanApproval, note: string): KnownBlock[] {
  const label = plan.status === "approved" ? "✅ *Plan approved*" : plan.status === "rejected" ? "🚫 *Plan rejected*" : "☑️ *Plan closed*";
  return [
    sectionText(`${label}  ·  _${escape(redact(plan.projectId))}_\n\n~${escape(redact(plan.plan ?? ""))}~`),
    contextText(note),
  ];
}

/** Cap on rendered activity rows so a busy team's snapshot stays compact and well under Block-Kit's block ceiling. */
const MAX_ACTIVITY_ITEMS = 12;

/** A glanceable status marker for an active-work row; falls back to a neutral dot. */
function statusDot(status: string): string {
  switch (status) {
    case "running":
      return "🟢";
    case "waiting":
      return "🟡";
    case "stalled":
      return "🐢";
    case "done":
      return "🏁";
    case "idle":
      return "🌙";
    case "paused":
      return "⏸️";
    default:
      return "⚪";
  }
}

/**
 * A compact, READ-ONLY Block-Kit summary of what's active right now — the
 * ephemeral activity layer surfaced into Slack. Per session: a status marker,
 * short title, harness, owner/actor, elapsed since last activity, current status,
 * and an "Open in Standup" deep link (the same session share link the mirror root
 * uses). Nothing here is durable — the caller posts it as a one-off snapshot.
 *
 * Each row is its own section whose escaped, composed text is capped once under
 * the 3000-char section limit (agent-authored title/actor are redacted → escaped
 * first), and only the first MAX_ACTIVITY_ITEMS rows render — the rest collapse
 * into a one-line "…and N more" so the message stays compact and under Slack's
 * block ceiling. When nothing is active it returns a real sentence (never a blank
 * bubble the send-guard would drop) naming the scope. When the cross-project
 * fan-out omitted projects past its ceiling (`omittedProjectCount`), a note says
 * so — a partial view is never presented as complete.
 */
export function activityMessage(
  items: ActiveWorkItem[],
  opts: { webUrl: string; label: string; now?: number; omittedProjectCount?: number },
): { text: string; blocks: KnownBlock[] } {
  const label = escape(opts.label);
  const omitted = opts.omittedProjectCount ?? 0;
  const omittedNote =
    omitted > 0 ? `${omitted} project${omitted === 1 ? "" : "s"} not shown — open Standup for the full picture.` : "";
  if (items.length === 0) {
    const sentence = `📭 Nothing active in ${label} right now.`;
    const text = omittedNote ? `${sentence} ${omittedNote}` : sentence;
    return { text, blocks: [sectionText(text)] };
  }

  const now = opts.now ?? Date.now();
  const shown = items.slice(0, MAX_ACTIVITY_ITEMS);
  const blocks: KnownBlock[] = [
    sectionText(`🛰️ *Active now in ${label}*  ·  ${items.length} session${items.length === 1 ? "" : "s"}`),
  ];
  for (const w of shown) {
    const title = escape(truncate(redact(w.title?.trim() || "Untitled"), TITLE_FEED_CAP));
    const link = `<${sessionShareUrl(opts.webUrl, w.sessionId)}|Open in Standup>`;
    const meta = [
      w.harness ? `🤖 ${escape(w.harness)}` : null,
      w.actor ? `👤 ${escape(redact(w.actor))}` : null,
      elapsedSince(w.lastActivityAt, now),
      link,
    ]
      .filter(Boolean)
      .join("  ·  ");
    blocks.push(sectionText(`${statusDot(w.status)} *${title}*  ·  _${escape(w.status)}_\n${meta}`));
  }
  const overflow = items.length - shown.length;
  if (overflow > 0) {
    blocks.push(contextText(`…and ${overflow} more — open Standup to see the rest.`));
  }
  if (omittedNote) blocks.push(contextText(omittedNote));
  return { text: `Active now in ${redact(opts.label)}: ${items.length} session${items.length === 1 ? "" : "s"}`, blocks };
}

/**
 * A short "3m ago" / "2h ago" / "just now" for an active-work row's last-activity
 * time. The collector stamps recency as a bare UTC sqlite datetime
 * (`YYYY-MM-DD HH:MM:SS`, no zone), which `Date.parse` would read as LOCAL time —
 * so a bare stamp is normalized to UTC first. An unparseable value renders no
 * elapsed fragment (the caller filters the empty string out) rather than "NaN".
 */
function elapsedSince(iso: string, now: number): string {
  const ms = parseTimestampMs(iso);
  if (Number.isNaN(ms)) return "";
  const secs = Math.max(0, Math.round((now - ms) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** Parse an ISO or a bare UTC sqlite datetime to epoch ms (NaN when unparseable). */
function parseTimestampMs(s: string): number {
  const t = (s ?? "").trim();
  const bare = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(t);
  return Date.parse(bare ? `${t.replace(" ", "T")}Z` : t);
}

/** Encode a plan button's carried decision, sharing the cap check with callers. */
function planButtonValue(planId: string, decision: PlanActionValue["decision"]): string {
  return JSON.stringify({ planId, decision } satisfies PlanActionValue);
}

/** Encode a button's carried answer, so callers share one definition of the cap check. */
function buttonValue(askId: string, answer: string): string {
  return JSON.stringify({ askId, answer } satisfies AskActionValue);
}

function truncate(s: string, max: number): string {
  const t = s ?? "";
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/** Escape Slack mrkdwn control chars so agent text can't inject formatting/links. */
function escape(s: string): string {
  return (s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
