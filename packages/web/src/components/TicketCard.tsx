import { useState } from "react";
import { useNavigate } from "react-router-dom";
import type {
  Ticket, TicketStatus, TicketSeverity, Session, ProjectWithCounts, Launch, TaskRun, TaskRunStatus,
  TaskRunAttemptStatus, TicketAttempt, ReviewFinding, TicketPublishPreview, ReviewCommentsPayload,
} from "@standup/shared";
import {
  LuCheck, LuX, LuArrowUpRight, LuExternalLink, LuRotateCw, LuWrench, LuGitPullRequest,
  LuMessageSquare, LuLayers,
} from "react-icons/lu";
import { alpha, theme } from "./theme";
import { ProjectIcon } from "./ProjectIcon";
import { safeHref } from "../lib/safeHref";

// Liveness color per dispatcher-ledger state (Phase 4). queued/cancelled are
// muted; running is live-blue; succeeded green; failed/lost are alarm tones.
const TASK_RUN_COLOR: Record<TaskRunStatus, string> = {
  queued: theme.faint, running: theme.running, succeeded: theme.checkpoint,
  failed: theme.waiting, cancelled: theme.faint, lost: theme.stalled,
};
const TASK_RUN_LABEL: Record<TaskRunStatus, string> = {
  queued: "queued", running: "running", succeeded: "succeeded",
  failed: "failed", cancelled: "cancelled", lost: "lost",
};

// Best-of-N attempt-selection colors: the picked winner reads green, the losers
// muted, an as-yet-unpicked attempt neutral.
const ATTEMPT_STATUS_COLOR: Record<TaskRunAttemptStatus, string> = {
  selected: theme.checkpoint, superseded: theme.faint, pending: theme.running,
};

const SEVERITY_COLOR: Record<TicketSeverity, string> = {
  critical: theme.waiting, high: theme.stalled, medium: theme.running, low: theme.faint,
};

const smallButton: React.CSSProperties = {
  fontSize: 11.5, fontWeight: 600, border: `1px solid ${theme.edge}`,
  borderRadius: 5, padding: "5px 10px", cursor: "pointer",
  background: "none", color: theme.text,
};
const primaryButton: React.CSSProperties = {
  fontSize: 11.5, fontWeight: 600, color: theme.ground, background: theme.checkpoint,
  border: "none", borderRadius: 5, padding: "6px 11px", cursor: "pointer",
};
const linkButton: React.CSSProperties = {
  background: "none", border: "none", padding: 0, cursor: "pointer",
  font: "inherit", fontSize: 11.5, color: theme.running,
  display: "inline-flex", alignItems: "center", gap: 4,
};

/** "3h ago" — coarse provenance, matching KnowledgePanel's timeAgo. */
export function timeAgo(d: Date | string): string {
  const mins = Math.round((Date.now() - new Date(d).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * Resolves the task run a ticket's card should reflect: its current launch's
 * run when that launch resolves, else the run its session reported into (an
 * older run whose launch row isn't loaded). taskRuns arrives newest-first, so
 * the first run per session / worktree wins. A run shares its launch's
 * worktree_path, so resolving through the CURRENT launch catches a freshly
 * re-dispatched run that has no session attached yet — matching by session
 * alone would keep pointing at the previous, terminal run and leave the card
 * looking stranded (and Re-dispatch enabled) mid-dispatch.
 */
export function ticketRunResolver(launches: Launch[], taskRuns: TaskRun[]): (t: Ticket) => TaskRun | undefined {
  const launchById = new Map(launches.map((l) => [l.id, l]));
  const runBySession = new Map<string, TaskRun>();
  const runByWorktree = new Map<string, TaskRun>();
  for (const r of taskRuns) {
    if (r.sessionId && !runBySession.has(r.sessionId)) runBySession.set(r.sessionId, r);
    if (!runByWorktree.has(r.worktreePath)) runByWorktree.set(r.worktreePath, r);
  }
  return (t) => {
    const launch = t.launchId ? launchById.get(t.launchId) : undefined;
    const byWorktree = launch ? runByWorktree.get(launch.worktreePath) : undefined;
    if (byWorktree) return byWorktree;
    return t.sessionId ? runBySession.get(t.sessionId) : undefined;
  };
}

/** Open High/critical findings grouped by the ticket they were flagged against. */
export function findingsByTicket(findings: ReviewFinding[]): Map<string, ReviewFinding[]> {
  const m = new Map<string, ReviewFinding[]>();
  for (const f of findings) {
    const list = m.get(f.ticketId);
    if (list) list.push(f);
    else m.set(f.ticketId, [f]);
  }
  return m;
}

/** The ticket actions the console wires to the collector's ticket routes. */
export interface TicketActions {
  onApprove: (id: string) => Promise<{ error?: string }>;
  onDismiss: (id: string) => Promise<{ error?: string }>;
  onShip: (id: string) => Promise<{ error?: string }>;
  // Dispatch an implementation launch. `attempts` (1..4) fans it out to N
  // parallel best-of-N attempts, each its own worktree; omitted/1 is a single run.
  onDispatch: (id: string, attempts?: number) => Promise<{ error?: string }>;
  // Fetch a ticket's best-of-N attempts (each run + launch + worktree diff) for
  // the compare view. Returns the collected attempts, or an error.
  onFetchAttempts: (id: string) => Promise<{ error?: string; attempts?: TicketAttempt[] }>;
  // Pick one attempt as the winner: its branch becomes the ticket output and the
  // other attempts are superseded.
  onPickAttempt: (id: string, taskRunId: string) => Promise<{ error?: string }>;
  // The decoupled status setter (POST /api/tickets/:id/status). Backs the rework
  // edges a card exposes: send a needs_review ticket back to developing, and
  // restore a dismissed ticket to the proposed queue.
  onStatus: (id: string, status: TicketStatus) => Promise<{ error?: string }>;
  // The PR is the unit of output: fetch a DRY-RUN draft-PR preview for a ticket
  // (branch, commit message + co-author trailers, PR title/body). Never pushes —
  // a live publish is a human step, so this only ever returns the preview.
  onPublish: (id: string) => Promise<{ error?: string; preview?: TicketPublishPreview }>;
  // The review-comment counterpart to Publish: fetch the DRY-RUN reviews-API
  // payload — the ticket's High/critical findings mapped to inline comments on
  // the minted PR. Never posts; a live post is a human step run from the command.
  onReviewComments: (id: string) => Promise<{ error?: string; payload?: ReviewCommentsPayload }>;
  // Fix this finding — fires a FRESH fixer session seeded with the finding + the
  // reviewed diff. The one explicit, human-triggered dispatch; never automatic.
  onFixFinding: (id: string) => Promise<{ error?: string }>;
  onDismissFinding: (id: string) => Promise<{ error?: string }>;
}

/**
 * The in-flight, error and dismiss-confirm state of one ticket's actions, keyed
 * by ticket or finding id. `perform` runs an action under its key, records its
 * error, and closes the dismiss confirm once an action on the ticket succeeds.
 */
function useTicketActionState(ticketId: string) {
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState(false);

  function setBusyFlag(key: string, on: boolean) {
    setBusy((prev) => { const n = new Set(prev); if (on) n.add(key); else n.delete(key); return n; });
  }
  async function perform(key: string, fn: (key: string) => Promise<{ error?: string }>) {
    setBusyFlag(key, true);
    setErrors((prev) => ({ ...prev, [key]: "" }));
    try {
      const res = await fn(key);
      if (res.error) setErrors((prev) => ({ ...prev, [key]: res.error! }));
      else if (key === ticketId) setConfirming(false);
    } finally { setBusyFlag(key, false); }
  }
  return { busy, errors, confirming, setConfirming, perform };
}

/** A ticket's severity dot and lens chip. */
export function TicketSeverityLens({ ticket }: { ticket: Ticket }) {
  return (
    <>
      <span data-testid="ticket-severity" title={`${ticket.severity} severity`} style={{
        width: 7, height: 7, borderRadius: 7,
        background: SEVERITY_COLOR[ticket.severity] ?? theme.faint, flexShrink: 0,
      }} />
      <span data-testid="ticket-lens" style={{
        fontFamily: theme.mono, fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase",
        color: theme.expert, border: `1px solid ${alpha(theme.expert, 0x44)}`, borderRadius: 3, padding: "1px 5px",
      }}>{ticket.lens}</span>
    </>
  );
}

/** Dismiss behind an "Abandon this?" confirm. */
function DismissControl({
  confirming, busy, onDismiss, onConfirmDismiss, onCancelDismiss,
}: {
  confirming: boolean;
  busy: boolean;
  onDismiss: () => void;
  onConfirmDismiss: () => void;
  onCancelDismiss: () => void;
}) {
  return confirming ? (
    <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
      <span style={{ fontSize: 11, color: theme.dim }}>Abandon this?</span>
      <button onClick={onDismiss} disabled={busy} style={{
        fontSize: 11.5, fontWeight: 600, color: theme.ground, background: theme.waiting,
        border: "none", borderRadius: 5, padding: "5px 11px", cursor: "pointer",
      }}>Dismiss</button>
      <button onClick={onCancelDismiss} style={{ ...linkButton, color: theme.faint }}>cancel</button>
    </span>
  ) : (
    <button onClick={onConfirmDismiss} style={{ ...linkButton, color: theme.waiting }}>
      <LuX /> dismiss
    </button>
  );
}

/**
 * A proposed ticket's one-glance triage: its severity and lens, with Approve
 * and a confirmed Dismiss bound to the console's ticket actions.
 */
export function TicketQuickActions({ ticket, actions }: { ticket: Ticket; actions: TicketActions }) {
  const { busy, errors, confirming, setConfirming, perform } = useTicketActionState(ticket.id);
  const id = ticket.id;
  const isBusy = busy.has(id);
  return (
    <div data-testid={`ticket-quick-${id}`} style={{ marginTop: 8 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <TicketSeverityLens ticket={ticket} />
        <span style={{ flex: 1 }} />
        <button onClick={() => perform(id, actions.onApprove)} disabled={isBusy} style={{ ...primaryButton, opacity: isBusy ? 0.6 : 1 }}>
          {isBusy ? "Approving…" : <><LuCheck style={{ verticalAlign: -2 }} /> Approve</>}
        </button>
        <DismissControl
          confirming={confirming}
          busy={isBusy}
          onDismiss={() => perform(id, actions.onDismiss)}
          onConfirmDismiss={() => setConfirming(true)}
          onCancelDismiss={() => setConfirming(false)}
        />
      </div>
      {errors[id] && <div style={{ fontSize: 11, color: theme.waiting, marginTop: 6 }}>{errors[id]}</div>}
    </div>
  );
}

/**
 * A ticket card bound to the console's ticket actions, holding its own
 * in-flight, error and dismiss-confirm state (keyed by ticket or finding id).
 * Opening the implementation goes to its session or, before one attaches, the
 * launch provisioning it — under the same /work/s/:id and /work/l/:id prefixes
 * WorkView navigates to.
 */
export function LiveTicketCard({
  ticket, project, session, run, findings, actions,
}: {
  ticket: Ticket;
  project?: ProjectWithCounts;
  session?: Session;
  run?: TaskRun;
  findings: ReviewFinding[];
  actions: TicketActions;
}) {
  const navigate = useNavigate();
  const { busy, errors, confirming, setConfirming, perform } = useTicketActionState(ticket.id);
  const id = ticket.id;
  const dismissed = ticket.status === "dismissed";

  return (
    <TicketCard
      ticket={ticket} project={project} session={session} run={run}
      busy={busy.has(id)} error={errors[id]} confirming={confirming}
      findings={dismissed ? [] : findings}
      isBusy={(fid) => busy.has(fid)} errorFor={(fid) => errors[fid]}
      onFixFinding={(fid) => perform(fid, actions.onFixFinding)}
      onDismissFinding={(fid) => perform(fid, actions.onDismissFinding)}
      onApprove={() => perform(id, actions.onApprove)}
      onShip={() => perform(id, actions.onShip)}
      onDispatch={(attempts) => perform(id, (k) => actions.onDispatch(k, attempts))}
      onFetchAttempts={() => actions.onFetchAttempts(id)}
      onPickAttempt={(rid) => actions.onPickAttempt(id, rid)}
      onSendBack={() => perform(id, (k) => actions.onStatus(k, "developing"))}
      onRestore={() => perform(id, (k) => actions.onStatus(k, "proposed"))}
      onPublish={() => actions.onPublish(id)}
      onReviewComments={() => actions.onReviewComments(id)}
      onDismiss={() => perform(id, actions.onDismiss)}
      onConfirmDismiss={() => setConfirming(true)}
      onCancelDismiss={() => setConfirming(false)}
      onOpen={() => {
        if (ticket.sessionId) navigate(`/work/s/${ticket.sessionId}`);
        else if (ticket.launchId) navigate(`/work/l/${ticket.launchId}`);
      }}
    />
  );
}

export function TicketCard({
  ticket, project, session, run, busy, error, confirming,
  findings, isBusy, errorFor, onFixFinding, onDismissFinding,
  onApprove, onShip, onDispatch, onFetchAttempts, onPickAttempt,
  onSendBack, onRestore, onPublish, onReviewComments, onDismiss, onConfirmDismiss, onCancelDismiss, onOpen,
}: {
  ticket: Ticket;
  project?: ProjectWithCounts;
  session?: Session;
  run?: TaskRun;
  busy: boolean;
  error?: string;
  confirming: boolean;
  findings: ReviewFinding[];
  isBusy: (findingId: string) => boolean;
  errorFor: (findingId: string) => string | undefined;
  onFixFinding: (findingId: string) => void;
  onDismissFinding: (findingId: string) => void;
  onApprove: () => void;
  onShip: () => void;
  onDispatch: (attempts?: number) => void;
  onFetchAttempts: () => Promise<{ error?: string; attempts?: TicketAttempt[] }>;
  onPickAttempt: (taskRunId: string) => Promise<{ error?: string }>;
  onSendBack: () => void;
  onRestore: () => void;
  onPublish: () => Promise<{ error?: string; preview?: TicketPublishPreview }>;
  onReviewComments: () => Promise<{ error?: string; payload?: ReviewCommentsPayload }>;
  onDismiss: () => void;
  onConfirmDismiss: () => void;
  onCancelDismiss: () => void;
  onOpen: () => void;
}) {
  const s = ticket.status;
  const canOpen = !!ticket.sessionId || !!ticket.launchId;
  // Dismiss is offered on any active column; shipped is a success terminal and
  // dismissed is already terminal, so neither gets it.
  const canDismiss = s === "proposed" || s === "approved" || s === "developing" || s === "needs_review";
  // A "stranded" card: its implementation launch failed (still approved, error
  // on the card) or its run failed / was lost (still developing). Offer a
  // re-dispatch so the work can be relaunched instead of dead-ending.
  const runStranded = run?.status === "failed" || run?.status === "lost";
  const stranded = (s === "approved" || s === "developing") && (runStranded || !!ticket.error);
  // A run actively in flight for this ticket. When a launch is provisioning it
  // may not have a run row yet, so a set launchId also counts as in-flight.
  const runLive = run?.status === "queued" || run?.status === "running";
  // Approved through the decoupled path (an external agent/user via
  // report_ticket_status, or /approve without ?dispatch) fires NO implementation
  // launch — the ticket has no launchId and nothing is running. That is not a
  // launch-in-progress; offer a Dispatch to start the work rather than a false
  // "launching…" that dead-ends.
  const awaitingDispatch = s === "approved" && !ticket.launchId && !runLive;
  const canDispatch = stranded || awaitingDispatch;
  // "launching implementation…" holds only while a launch is genuinely in flight:
  // one was fired (launchId) or a run is live, and it has not stranded.
  const launching = s === "approved" && (!!ticket.launchId || runLive) && !stranded;

  // Best-of-N: how many parallel attempts a Dispatch fans out to (1..4). Each is
  // its own worktree; the winner is picked from the compare panel below.
  const [attemptCount, setAttemptCount] = useState(1);
  // A ticket dispatched as multiple attempts carries the group; its compare +
  // pick panel is offered whenever that group exists.
  const hasAttempts = !!ticket.attemptGroup;

  // The PR is the unit of output: a ticket whose work is complete (in review or
  // shipped) can be published as a DRAFT PR. Clicking fetches the dry-run
  // preview and shows it inline; nothing is pushed (a live publish is a human
  // step done from the returned commands).
  const canPublish = s === "needs_review" || s === "shipped";
  const [preview, setPreview] = useState<TicketPublishPreview | null>(null);
  const [publishBusy, setPublishBusy] = useState(false);
  const [publishError, setPublishError] = useState<string>();
  const doPublish = async () => {
    setPublishBusy(true);
    setPublishError(undefined);
    try {
      const res = await onPublish();
      if (res.error) setPublishError(res.error);
      else if (res.preview) setPreview(res.preview);
    } finally {
      setPublishBusy(false);
    }
  };

  // The review-comment counterpart to Publish, offered on the same complete-work
  // columns: compose the dry-run reviews-API payload (the ticket's High/critical
  // findings as inline comments on the minted PR) and show it inline. Nothing is
  // posted — a live post is a human step run from the returned command.
  const [reviewPayload, setReviewPayload] = useState<ReviewCommentsPayload | null>(null);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewError, setReviewError] = useState<string>();
  const doReviewComments = async () => {
    setReviewBusy(true);
    setReviewError(undefined);
    try {
      const res = await onReviewComments();
      if (res.error) setReviewError(res.error);
      else if (res.payload) setReviewPayload(res.payload);
    } finally {
      setReviewBusy(false);
    }
  };

  return (
    <div data-testid={`ticket-card-${ticket.id}`} style={{
      background: theme.surface, border: `1px solid ${theme.edgeSoft}`,
      borderRadius: 8, padding: "10px 12px", marginBottom: 9,
    }}>
      {/* severity + lens + age */}
      <div style={{ display: "flex", gap: 7, alignItems: "center", flexWrap: "wrap", marginBottom: 6 }}>
        <TicketSeverityLens ticket={ticket} />
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 10.5, color: theme.faint }}>{timeAgo(ticket.updatedAt)}</span>
      </div>

      <div style={{ fontSize: 13, fontWeight: 700, color: theme.text, lineHeight: 1.35 }}>
        {ticket.title}
      </div>

      {ticket.body && (
        <div style={{
          fontSize: 12, color: theme.dim, marginTop: 5, lineHeight: 1.5,
          overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
        }}>{ticket.body}</div>
      )}

      {/* project attribution */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 7 }}>
        <span style={{ fontSize: 13, display: "inline-flex" }}><ProjectIcon project={project} size={13} /></span>
        <span style={{ fontSize: 11.5, color: theme.faint }}>{project?.name ?? ticket.projectId}</span>
      </div>

      {/* Dispatcher liveness (Phase 4 ledger): the run this ticket's impl
          session reports into — its status and how long since it last spoke,
          so a stalled or lost run reads at a glance without opening it. */}
      {run && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 7 }}>
          <span style={{
            width: 7, height: 7, borderRadius: 7, flexShrink: 0,
            background: TASK_RUN_COLOR[run.status],
          }} />
          <span style={{
            fontFamily: theme.mono, fontSize: 10, letterSpacing: "0.06em",
            textTransform: "uppercase", color: TASK_RUN_COLOR[run.status], fontWeight: 700,
          }}>{TASK_RUN_LABEL[run.status]}</span>
          {(run.status === "queued" || run.status === "running") && (
            <span style={{ fontSize: 10.5, color: theme.faint }}>
              · active {timeAgo(run.lastEventAt ?? run.startedAt ?? run.createdAt)}
            </span>
          )}
          {run.summary && (run.status === "succeeded" || run.status === "failed") && (
            <span style={{
              fontSize: 11, color: theme.dim, overflow: "hidden",
              textOverflow: "ellipsis", whiteSpace: "nowrap",
            }}>· {run.summary}</span>
          )}
        </div>
      )}

      {/* links: impl session + review url + originating task/issue id */}
      {(canOpen || ticket.reviewUrl || ticket.issueId) && (
        <div style={{ display: "flex", gap: 14, marginTop: 8, flexWrap: "wrap", alignItems: "center" }}>
          {canOpen && (
            <button onClick={onOpen} style={linkButton} title="Open the implementation session in Projects">
              <LuArrowUpRight /> {session?.title ? session.title : ticket.sessionId ? "open session" : "watch launch"}
            </button>
          )}
          {ticket.reviewUrl && (
            safeHref(ticket.reviewUrl) ? (
              <a href={safeHref(ticket.reviewUrl)!} target="_blank" rel="noreferrer" style={{ ...linkButton, textDecoration: "none" }}>
                <LuExternalLink /> review
              </a>
            ) : (
              <span title={ticket.reviewUrl} style={{ ...linkButton, cursor: "default", fontFamily: theme.mono, fontSize: 11 }}>
                review: {ticket.reviewUrl}
              </span>
            )
          )}
          {/* The task<->work-item mapping made visible: the tracking id, a link to
              the originating tracker task when its deep link was ingested. */}
          {ticket.issueId && (
            ticket.taskUrl ? (
              <a
                href={ticket.taskUrl}
                target="_blank"
                rel="noreferrer"
                title="Open the originating tracker task"
                style={{ ...linkButton, textDecoration: "none", fontFamily: theme.mono, fontSize: 11 }}
              >
                <LuExternalLink /> {ticket.issueId}
              </a>
            ) : (
              <span
                title="Tracking task/issue id"
                style={{ fontFamily: theme.mono, fontSize: 11, color: theme.faint }}
              >
                {ticket.issueId}
              </span>
            )
          )}
        </div>
      )}

      {/* Auto-review findings: the read-only reviewer's High/critical hits over
          this ticket's diff (de-noised — low/medium never reach here). Each
          offers a one-click "fix this" that fires a FRESH fixer session seeded
          with the finding + the reviewed diff, kept separate from the reviewer. */}
      {findings.length > 0 && (
        <div style={{ marginTop: 10, borderTop: `1px solid ${theme.edgeSoft}`, paddingTop: 9 }}>
          <div style={{
            fontFamily: theme.mono, fontSize: 9.5, letterSpacing: "0.1em", textTransform: "uppercase",
            color: theme.stalled, fontWeight: 700, marginBottom: 7,
          }}>
            Review findings · {findings.length}
          </div>
          {findings.map((f) => (
            <FindingRow
              key={f.id} finding={f}
              busy={isBusy(f.id)} error={errorFor(f.id)}
              onFix={() => onFixFinding(f.id)}
              onDismiss={() => onDismissFinding(f.id)}
            />
          ))}
        </div>
      )}

      {error && (
        <div style={{ fontFamily: theme.mono, fontSize: 11, color: theme.waiting, marginTop: 8, lineHeight: 1.5 }}>
          {error}
        </div>
      )}
      {/* Gate/launch failure recorded on the ticket, distinct from a per-action error. */}
      {ticket.error && !error && (
        <div style={{ fontFamily: theme.mono, fontSize: 11, color: theme.waiting, marginTop: 8, lineHeight: 1.5 }}>
          {ticket.error}
        </div>
      )}

      {publishError && (
        <div style={{ fontFamily: theme.mono, fontSize: 11, color: theme.waiting, marginTop: 8, lineHeight: 1.5 }}>
          {publishError}
        </div>
      )}
      {/* The composed draft-PR preview: a dry-run of the PR that shipping this
          ticket would open — nothing has been pushed. */}
      {preview && <PublishPreview preview={preview} />}

      {reviewError && (
        <div style={{ fontFamily: theme.mono, fontSize: 11, color: theme.waiting, marginTop: 8, lineHeight: 1.5 }}>
          {reviewError}
        </div>
      )}
      {/* The composed reviews-API payload: a dry-run of the inline review that
          would land on the minted PR — nothing has been posted. */}
      {reviewPayload && <ReviewCommentsPreview payload={reviewPayload} />}

      {/* Best-of-N compare + pick: the parallel attempts' diffs side by side and
          a one-click pick that makes one the ticket's output. */}
      {hasAttempts && <AttemptsPanel onFetch={onFetchAttempts} onPick={onPickAttempt} />}

      {/* actions */}
      <div style={{ display: "flex", gap: 8, marginTop: 10, alignItems: "center", flexWrap: "wrap" }}>
        {s === "proposed" && (
          <button onClick={onApprove} disabled={busy} style={{ ...primaryButton, opacity: busy ? 0.6 : 1 }}>
            {busy ? "Approving…" : <><LuCheck style={{ verticalAlign: -2 }} /> Approve</>}
          </button>
        )}
        {launching && (
          <span style={{ fontFamily: theme.mono, fontSize: 10.5, color: theme.running }}>
            launching implementation…
          </span>
        )}
        {s === "needs_review" && (
          <>
            <button onClick={onShip} disabled={busy} style={{ ...primaryButton, opacity: busy ? 0.6 : 1 }}>
              {busy ? "Shipping…" : <><LuCheck style={{ verticalAlign: -2 }} /> Mark shipped</>}
            </button>
            <button
              onClick={onSendBack}
              disabled={busy}
              title="Send this ticket back to developing — the review found more to do"
              style={{ ...linkButton, color: theme.stalled }}
            >
              <LuRotateCw /> send back
            </button>
          </>
        )}
        {s === "dismissed" && (
          <button
            onClick={onRestore}
            disabled={busy}
            title="Restore this dismissed ticket to the proposed queue"
            style={{ ...linkButton, color: theme.running }}
          >
            {busy ? "Restoring…" : <><LuRotateCw /> restore</>}
          </button>
        )}
        {canDispatch && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <button
              onClick={() => onDispatch(attemptCount)}
              disabled={busy}
              title={stranded
                ? "Fire a fresh implementation launch for this stranded ticket"
                : attemptCount > 1
                  ? `Launch ${attemptCount} parallel attempts for this approved ticket`
                  : "Launch an implementation session for this approved ticket"}
              style={{
                ...primaryButton, background: theme.running, opacity: busy ? 0.6 : 1,
              }}
            >
              {busy
                ? (stranded ? "Re-dispatching…" : "Dispatching…")
                : <><LuRotateCw style={{ verticalAlign: -2 }} /> {stranded ? "Re-dispatch" : "Dispatch"}{attemptCount > 1 ? ` ×${attemptCount}` : ""}</>}
            </button>
            {/* Best-of-N fan-out: how many parallel attempts this dispatch spawns. */}
            <select
              value={attemptCount}
              onChange={(e) => setAttemptCount(Number(e.target.value))}
              disabled={busy}
              title="Parallel attempts to dispatch (best-of-N)"
              style={{ ...smallButton, padding: "4px 6px", cursor: "pointer" }}
            >
              {[1, 2, 3, 4].map((n) => (
                <option key={n} value={n}>{n === 1 ? "1 attempt" : `${n} attempts`}</option>
              ))}
            </select>
          </span>
        )}
        {canPublish && (
          <button
            onClick={doPublish}
            disabled={publishBusy}
            title="Compose a draft PR for this change — a dry-run preview; nothing is pushed"
            style={{ ...smallButton, display: "inline-flex", alignItems: "center", gap: 5, opacity: publishBusy ? 0.6 : 1 }}
          >
            <LuGitPullRequest /> {publishBusy ? "Composing…" : preview ? "Refresh PR preview" : "Publish (draft PR)"}
          </button>
        )}
        {canPublish && (
          <button
            onClick={doReviewComments}
            disabled={reviewBusy}
            title="Compose inline review comments for the minted PR from the High findings — a dry-run; nothing is posted"
            style={{ ...smallButton, display: "inline-flex", alignItems: "center", gap: 5, opacity: reviewBusy ? 0.6 : 1 }}
          >
            <LuMessageSquare /> {reviewBusy ? "Composing…" : reviewPayload ? "Refresh review comments" : "Review comments"}
          </button>
        )}

        <span style={{ flex: 1 }} />

        {canDismiss && (
          <DismissControl
            confirming={confirming}
            busy={busy}
            onDismiss={onDismiss}
            onConfirmDismiss={onConfirmDismiss}
            onCancelDismiss={onCancelDismiss}
          />
        )}
      </div>
    </div>
  );
}

/**
 * One auto-review finding on a needs_review card: severity + title + location,
 * the reviewer's validation checks, and the two actions — "fix this" (the
 * explicit, human-triggered fixer dispatch) and dismiss (clear it off the queue).
 */
function FindingRow({
  finding, busy, error, onFix, onDismiss,
}: {
  finding: ReviewFinding;
  busy: boolean;
  error?: string;
  onFix: () => void;
  onDismiss: () => void;
}) {
  const checks = finding.evidence?.checks ?? [];
  return (
    <div style={{
      background: theme.raised, border: `1px solid ${theme.edgeSoft}`,
      borderRadius: 6, padding: "8px 10px", marginBottom: 7,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
        <span title={`${finding.severity} severity`} style={{
          width: 6, height: 6, borderRadius: 6, flexShrink: 0,
          background: SEVERITY_COLOR[finding.severity] ?? theme.stalled,
        }} />
        <span style={{ fontSize: 12, fontWeight: 700, color: theme.text, lineHeight: 1.3 }}>
          {finding.title}
        </span>
      </div>
      {finding.file && (
        <div style={{ fontFamily: theme.mono, fontSize: 10, color: theme.faint, marginBottom: 3 }}>
          {finding.file}{finding.line ? `:${finding.line}` : ""}
        </div>
      )}
      {finding.body && (
        <div style={{
          fontSize: 11.5, color: theme.dim, lineHeight: 1.45, marginBottom: 4,
          overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical",
        }}>{finding.body}</div>
      )}
      {checks.length > 0 && (
        <div style={{ fontSize: 10.5, color: theme.faint, marginBottom: 5 }}>
          checks: {checks.join(", ")}
        </div>
      )}
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <button
          onClick={onFix}
          disabled={busy}
          title="Dispatch a fresh session to fix this finding (seeded with the reviewed diff)"
          style={{ ...linkButton, color: theme.running, opacity: busy ? 0.6 : 1 }}
        >
          {busy ? "Dispatching…" : <><LuWrench /> fix this</>}
        </button>
        <button onClick={onDismiss} disabled={busy} style={{ ...linkButton, color: theme.faint }}>
          <LuX /> dismiss
        </button>
      </div>
      {error && (
        <div style={{ fontFamily: theme.mono, fontSize: 10.5, color: theme.waiting, marginTop: 5 }}>
          {error}
        </div>
      )}
    </div>
  );
}

/**
 * The best-of-N compare + pick panel on a card whose ticket was dispatched as
 * multiple parallel attempts. Fetches each attempt's worktree diff on open and
 * lists them for side-by-side comparison; each still-unpicked attempt offers a
 * "Pick this" that makes its branch the ticket output and supersedes the rest.
 * Collapsed by default so the card stays compact until a human wants to compare.
 */
function AttemptsPanel({
  onFetch,
  onPick,
}: {
  onFetch: () => Promise<{ error?: string; attempts?: TicketAttempt[] }>;
  onPick: (taskRunId: string) => Promise<{ error?: string }>;
}) {
  const [open, setOpen] = useState(false);
  const [attempts, setAttempts] = useState<TicketAttempt[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [pickingId, setPickingId] = useState<string>();

  const load = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const res = await onFetch();
      if (res.error) setError(res.error);
      else setAttempts(res.attempts ?? []);
    } finally {
      setBusy(false);
    }
  };

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && attempts === null) await load();
  };

  const pick = async (taskRunId: string) => {
    setPickingId(taskRunId);
    setError(undefined);
    try {
      const res = await onPick(taskRunId);
      if (res.error) setError(res.error);
      else await load(); // reflect the new selected/superseded states
    } finally {
      setPickingId(undefined);
    }
  };

  const label: React.CSSProperties = {
    fontFamily: theme.mono, fontSize: 9, letterSpacing: "0.1em", textTransform: "uppercase",
    color: theme.faint, fontWeight: 700, marginBottom: 3,
  };
  const anySelected = (attempts ?? []).some((a) => a.run.attemptStatus === "selected");

  return (
    <div style={{ marginTop: 10, borderTop: `1px solid ${theme.edgeSoft}`, paddingTop: 9 }}>
      <button
        onClick={toggle}
        style={{ ...linkButton, color: theme.expert, fontWeight: 700 }}
        title="Compare the parallel attempts and pick a winner"
      >
        <LuLayers /> {open ? "Hide attempts" : "Compare attempts"}
        {attempts ? ` · ${attempts.length}` : ""}
      </button>

      {open && (
        <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 8 }}>
          {busy && attempts === null && (
            <div style={{ fontSize: 11, color: theme.faint }}>Loading attempts…</div>
          )}
          {error && (
            <div style={{ fontFamily: theme.mono, fontSize: 10.5, color: theme.waiting, lineHeight: 1.5 }}>
              {error}
            </div>
          )}
          {attempts?.length === 0 && !busy && (
            <div style={{ fontSize: 11, color: theme.faint }}>No attempts recorded.</div>
          )}
          {attempts?.map((a, i) => {
            const status = a.run.attemptStatus ?? "pending";
            const selected = status === "selected";
            const superseded = status === "superseded";
            return (
              <div
                key={a.run.id}
                style={{
                  background: theme.raised, border: `1px solid ${selected ? theme.checkpoint : theme.edgeSoft}`,
                  borderRadius: 6, padding: "8px 10px", opacity: superseded ? 0.6 : 1,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                  <span style={{
                    fontFamily: theme.mono, fontSize: 10, fontWeight: 700, color: theme.text,
                  }}>attempt {i + 1}</span>
                  <span style={{
                    fontFamily: theme.mono, fontSize: 9, letterSpacing: "0.06em", textTransform: "uppercase",
                    color: ATTEMPT_STATUS_COLOR[status], fontWeight: 700,
                  }}>{status}</span>
                  <span style={{ flex: 1 }} />
                  {a.launch?.branch && (
                    <span style={{
                      fontFamily: theme.mono, fontSize: 9.5, color: theme.faint,
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 120,
                    }}>{a.launch.branch}</span>
                  )}
                </div>
                {a.diffError ? (
                  <div style={{ fontFamily: theme.mono, fontSize: 10, color: theme.stalled }}>
                    {a.diffError}
                  </div>
                ) : (
                  <pre style={{
                    fontFamily: theme.mono, fontSize: 10, lineHeight: 1.45, color: theme.dim,
                    background: theme.ground, border: `1px solid ${theme.edgeSoft}`, borderRadius: 5,
                    padding: "6px 8px", margin: 0, maxHeight: 160, overflow: "auto",
                    whiteSpace: "pre-wrap", wordBreak: "break-word",
                  }}>
                    {a.diff.trim() ? a.diff : "No changes yet."}
                    {a.diffTruncated ? "\n… (diff truncated)" : ""}
                  </pre>
                )}
                {!selected && !anySelected && (
                  <button
                    onClick={() => pick(a.run.id)}
                    disabled={!!pickingId}
                    title="Make this attempt's branch the ticket output and supersede the others"
                    style={{ ...linkButton, color: theme.checkpoint, marginTop: 6, opacity: pickingId ? 0.6 : 1 }}
                  >
                    {pickingId === a.run.id ? "Picking…" : <><LuCheck /> Pick this</>}
                  </button>
                )}
                {selected && (
                  <div style={{ ...label, color: theme.checkpoint, marginTop: 6, marginBottom: 0 }}>
                    Selected · feeds the Publisher
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * The composed draft-PR preview shown inline on a ticket card after Publish: the
 * head → base branch, the commit message (with Co-authored-by trailers), the PR
 * title/body, and the push + `gh pr create --draft` commands a human would run.
 * This is strictly a DRY RUN — nothing has been pushed and no PR exists yet, so
 * the panel leads with that and renders the commands as copyable text.
 */
function PublishPreview({ preview }: { preview: TicketPublishPreview }) {
  const mono: React.CSSProperties = {
    fontFamily: theme.mono, fontSize: 10.5, color: theme.dim, lineHeight: 1.5,
    whiteSpace: "pre-wrap", wordBreak: "break-word", margin: 0,
  };
  const label: React.CSSProperties = {
    fontFamily: theme.mono, fontSize: 9, letterSpacing: "0.1em", textTransform: "uppercase",
    color: theme.faint, fontWeight: 700, marginBottom: 3,
  };
  return (
    <div style={{
      marginTop: 10, borderTop: `1px solid ${theme.edgeSoft}`, paddingTop: 9,
      display: "flex", flexDirection: "column", gap: 8,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ display: "inline-flex", color: theme.checkpoint }}><LuGitPullRequest /></span>
        <span style={{
          fontFamily: theme.mono, fontSize: 9.5, letterSpacing: "0.1em", textTransform: "uppercase",
          color: theme.checkpoint, fontWeight: 700,
        }}>
          Draft PR · dry-run (not pushed)
        </span>
      </div>

      <div style={{ fontFamily: theme.mono, fontSize: 11, color: theme.text }}>
        {preview.branch ?? "(no branch)"} <span style={{ color: theme.faint }}>→</span> {preview.baseBranch ?? "(base)"}
      </div>

      <div>
        <div style={label}>PR title</div>
        <div style={{ fontSize: 12, color: theme.text, lineHeight: 1.4 }}>{preview.pr.title}</div>
      </div>

      <div>
        <div style={label}>PR body · written to {preview.descriptionFile.path}</div>
        <pre style={mono}>{preview.descriptionFile.contents}</pre>
      </div>

      <div>
        <div style={label}>Commit message</div>
        <pre style={mono}>{preview.commitMessage}</pre>
      </div>

      {preview.coAuthors.length > 0 && (
        <div>
          <div style={label}>Co-authors · {preview.coAuthors.length}</div>
          <pre style={mono}>{preview.coAuthors.join("\n")}</pre>
        </div>
      )}

      <div>
        <div style={label}>Commands (run by hand — this build never pushes)</div>
        <pre style={mono}>{preview.commands.join("\n")}</pre>
      </div>

      {preview.warnings.map((w, i) => (
        <div key={i} style={{ fontFamily: theme.mono, fontSize: 10.5, color: theme.stalled, lineHeight: 1.5 }}>
          {w}
        </div>
      ))}
    </div>
  );
}

/**
 * The composed reviews-API payload shown inline on a ticket card after "Review
 * comments": the review verdict, each High/critical finding as an inline
 * {path:line} comment on the minted PR, and the `gh api … /reviews` command a
 * human would run. Strictly a DRY RUN — nothing has been posted and the PR ref
 * may still carry `<owner/repo>`/`<pr-number>` placeholders — so it leads with
 * that and renders the command as copyable text.
 */
function ReviewCommentsPreview({ payload }: { payload: ReviewCommentsPayload }) {
  const mono: React.CSSProperties = {
    fontFamily: theme.mono, fontSize: 10.5, color: theme.dim, lineHeight: 1.5,
    whiteSpace: "pre-wrap", wordBreak: "break-word", margin: 0,
  };
  const label: React.CSSProperties = {
    fontFamily: theme.mono, fontSize: 9, letterSpacing: "0.1em", textTransform: "uppercase",
    color: theme.faint, fontWeight: 700, marginBottom: 3,
  };
  return (
    <div style={{
      marginTop: 10, borderTop: `1px solid ${theme.edgeSoft}`, paddingTop: 9,
      display: "flex", flexDirection: "column", gap: 8,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ display: "inline-flex", color: theme.stalled }}><LuMessageSquare /></span>
        <span style={{
          fontFamily: theme.mono, fontSize: 9.5, letterSpacing: "0.1em", textTransform: "uppercase",
          color: theme.stalled, fontWeight: 700,
        }}>
          Review · {payload.event} · dry-run (not posted)
        </span>
      </div>

      <div>
        <div style={label}>Body</div>
        <pre style={mono}>{payload.body}</pre>
      </div>

      <div>
        <div style={label}>Inline comments · {payload.comments.length}</div>
        {payload.comments.length === 0 ? (
          <div style={{ fontSize: 11, color: theme.faint }}>No High findings anchor to a diff line.</div>
        ) : (
          payload.comments.map((cm, i) => (
            <div key={i} style={{ marginBottom: 6 }}>
              <div style={{ fontFamily: theme.mono, fontSize: 10, color: theme.faint }}>
                {cm.path}:{cm.line}
              </div>
              <pre style={mono}>{cm.body}</pre>
            </div>
          ))
        )}
      </div>

      <div>
        <div style={label}>Command (run by hand — this build never posts)</div>
        <pre style={mono}>{payload.commands.join("\n")}</pre>
      </div>

      {payload.placeholders.map((p, i) => (
        <div key={`p${i}`} style={{ fontFamily: theme.mono, fontSize: 10.5, color: theme.running, lineHeight: 1.5 }}>
          fill: {p}
        </div>
      ))}
      {payload.warnings.map((w, i) => (
        <div key={`w${i}`} style={{ fontFamily: theme.mono, fontSize: 10.5, color: theme.stalled, lineHeight: 1.5 }}>
          {w}
        </div>
      ))}
    </div>
  );
}
