import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { LuExternalLink } from "react-icons/lu";
import type { Ask, Checkpoint, PersonaApproval, PersonaFloorDecision, PersonaJob, PlanApproval, Session } from "@standup/shared";
import { approvalHeadline } from "@standup/shared";
import { alpha, theme, statusColors } from "./theme";
import { JOB_STATE } from "./jobStatus";
import { JobActions } from "./JobActions";
import { FloorDecisionList } from "./PersonaFloorDecisions";
import { TranscriptView } from "./TranscriptView";
import { PipelineRunList, splitRuns, usePipelineRuns } from "./PipelineSection";
import { ReviewTunnelList, useReviewTunnels } from "./ReviewTunnelPanel";
import { PipelineStrip, banner, ownerCanAct } from "./PipelineView";
import { JobBudgetBar } from "./JobBudgetBar";
import { useNarrow } from "../hooks/useNarrow";
import { isOpenJob, isOwnerFloorCard, jobNote, jobState, withUser } from "../lib/persona";
import { decisionLabel, newestFirst, type PipelineDecisionRecord } from "../lib/pipelineDecisions";
import { subscribePipelineConfigUpdates, subscribePipelineResync, subscribePipelineUpdates } from "../lib/pipelineUpdates";

/** How often the drawer re-reads checkpoints, asks and plans while open. */
const POLL_MS = 5000;

/** How many recent checkpoints the drawer reads to find the job's newest one. */
const CHECKPOINT_WINDOW = 200;

interface JobActivity {
  checkpoints: Checkpoint[];
  asks: Ask[];
  plans: PlanApproval[];
  /** Safety-floor holds Persona allowed once for this job, newest first. */
  floorDecisions: PersonaFloorDecision[];
}

const EMPTY_ACTIVITY: JobActivity = { checkpoints: [], asks: [], plans: [], floorDecisions: [] };

async function readJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(path);
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

/**
 * The job's workers' checkpoints, pending asks and pending plans, and the
 * floor holds Persona allowed once for it, re-read every `pollMs` while the
 * drawer is open. `tick` counts the reads, so the live transcript below can
 * refresh on the same beat. `user` reads another user's Persona (the host's
 * read-only view).
 */
function useJobActivity(job: PersonaJob | undefined, pollMs: number, user?: string): JobActivity & { tick: number } {
  const [activity, setActivity] = useState<JobActivity>(EMPTY_ACTIVITY);
  const [tick, setTick] = useState(0);
  const viewKeyRef = useRef<string | undefined>(undefined);
  const sessionKey = job?.sessionIds.join(",") ?? "";
  const launchKey = job?.launchIds.join(",") ?? "";

  useEffect(() => {
    if (!job) return;
    const sessionIds = new Set(job.sessionIds);
    const launchIds = new Set(job.launchIds);
    let cancelled = false;
    // Another job's (or user's) activity is cleared; the same job gaining a
    // worker keeps what's on screen until the next read lands.
    const viewKey = `${job.id}\n${user ?? ""}`;
    if (viewKeyRef.current !== viewKey) {
      viewKeyRef.current = viewKey;
      setActivity(EMPTY_ACTIVITY);
    }
    const load = async () => {
      const [checkpoints, asks, plans, floor] = await Promise.all([
        readJson<Checkpoint[]>(`/api/checkpoints?limit=${CHECKPOINT_WINDOW}`),
        readJson<Ask[]>("/api/asks/pending"),
        readJson<{ plans: PlanApproval[] }>("/api/plans/pending"),
        readJson<{ decisions: PersonaFloorDecision[] }>(
          withUser(`/api/persona/floor-decisions?jobId=${encodeURIComponent(job.id)}`, user)
        ),
      ]);
      if (cancelled) return;
      setActivity((prev) => ({
        checkpoints: (checkpoints ?? []).filter((c) => sessionIds.has(c.sessionId)),
        asks: (asks ?? []).filter((a) => sessionIds.has(a.sessionId)),
        plans: (plans?.plans ?? []).filter((p) => launchIds.has(p.launchId)),
        // A failed read keeps the list on screen rather than blanking it.
        floorDecisions: floor ? floor.decisions : prev.floorDecisions,
      }));
      setTick((t) => t + 1);
    };
    void load();
    const timer = setInterval(() => void load(), pollMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // The job object changes on every frame; its sessions and launches are what the reads depend on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.id, sessionKey, launchKey, pollMs, user]);

  return { ...activity, tick };
}

/**
 * The job's pipeline decisions, newest first: read on open, every `pollMs`,
 * on each pipeline update frame (a decision moves a run), on each change to
 * the job's pipeline layer (a pipeline_config:updated frame for the job) and
 * on each socket resync. A failed read keeps what is shown.
 */
function usePipelineDecisions(jobId: string | undefined, pollMs: number): PipelineDecisionRecord[] {
  const [decisions, setDecisions] = useState<PipelineDecisionRecord[]>([]);
  useEffect(() => {
    setDecisions([]);
    if (!jobId) return;
    let cancelled = false;
    const load = async () => {
      const data = await readJson<{ decisions?: PipelineDecisionRecord[] }>(
        `/api/pipeline/decisions?jobId=${encodeURIComponent(jobId)}`
      );
      if (cancelled || !data || !Array.isArray(data.decisions)) return;
      setDecisions(newestFirst(data.decisions));
    };
    void load();
    const timer = setInterval(() => void load(), pollMs);
    const unsubscribe = subscribePipelineUpdates(() => void load());
    const unsubscribeConfig = subscribePipelineConfigUpdates((change) => {
      if (change.jobId === jobId) void load();
    });
    const unsubscribeResync = subscribePipelineResync(() => void load());
    return () => {
      cancelled = true;
      clearInterval(timer);
      unsubscribe();
      unsubscribeConfig();
      unsubscribeResync();
    };
  }, [jobId, pollMs]);
  return decisions;
}

function time(value: string | Date | undefined): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function newest<T extends { createdAt: string | Date }>(rows: T[]): T | undefined {
  let best: T | undefined;
  for (const row of rows) {
    if (!best || new Date(row.createdAt).getTime() > new Date(best.createdAt).getTime()) best = row;
  }
  return best;
}

/** The worker the transcript opens on: the first live one, else the newest. */
function defaultSession(job: PersonaJob, sessionsById: Map<string, Session>): string | undefined {
  const live = job.sessionIds.find((id) => {
    const s = sessionsById.get(id);
    return s && !s.endedAt;
  });
  return live ?? job.sessionIds[job.sessionIds.length - 1];
}

/**
 * A read-only slide-over for one Persona job: its title, intent (goal and
 * acceptance), current state (status, Persona's latest note, the newest
 * checkpoint, what is waiting on a decision, the worker sessions, the
 * safety-floor holds Persona allowed once with their call and reason), the
 * pipeline gates Persona decided (skips, waivers, close-outs, escalations)
 * and a live view of each worker's transcript. The one decision made here is
 * a safety-floor hold only the owner can let run, on the same card the
 * Persona chat shows (renderFloorCard). Answering, steering and every other
 * approval happen in the Persona chat, which "Discuss in Persona" returns to
 * with the message tagged to this job.
 */
export function PersonaJobDrawer({
  jobId,
  job,
  sessions,
  approvals,
  onClose,
  onDiscuss,
  onShowMessages,
  onViewWorker,
  messageCount,
  user,
  renderFloorCard,
  pollMs = POLL_MS,
}: {
  jobId: string;
  /** Undefined while jobs load, or when the id names no job of this Persona. */
  job: PersonaJob | undefined;
  sessions: Session[];
  approvals: PersonaApproval[];
  onClose: () => void;
  /** Absent in a read-only view of another user's Persona, which hides "Discuss in Persona". */
  onDiscuss?: (jobId: string) => void;
  /** Shows the thread filtered to this job's messages; absent hides "Messages in thread". */
  onShowMessages?: (jobId: string) => void;
  /**
   * Opens a worker session in the Board's Live workers drawer: the one the transcript shows (the
   * live worker, else the newest, unless another is picked). Absent hides "View worker".
   */
  onViewWorker?: (sessionId: string) => void;
  /** How many loaded thread messages are tagged with this job; omitted from the label when unknown. */
  messageCount?: number;
  /** The Persona's user, in the host's read-only view of another user's Persona. */
  user?: string;
  /**
   * Renders a pending card on a safety-floor hold only the owner can let run
   * (the Persona chat's card, with Allow once and Deny); absent lists it as a line.
   */
  renderFloorCard?: (approval: PersonaApproval) => ReactNode;
  pollMs?: number;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const pipelineRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stripRef = useRef<HTMLDivElement | null>(null);
  const [shown, setShown] = useState(false);
  // Once the pipeline strip scrolls out of view, its status line moves up into the header.
  const [stripHidden, setStripHidden] = useState(false);
  const narrow = useNarrow();
  const sessionsById = useMemo(() => new Map(sessions.map((s) => [s.id, s])), [sessions]);
  const activity = useJobActivity(job, pollMs, user);
  // A worker's session ending, going done or resuming changes its run's worker state, so it re-reads the runs.
  const sessionsKey = (job?.sessionIds ?? [])
    .map((id) => {
      const s = sessionsById.get(id);
      return `${id}:${s?.endedAt ?? ""}:${s?.status === "done" ? "done" : ""}`;
    })
    .join(",");
  const pipeline = usePipelineRuns(job?.launchIds ?? [], pollMs, sessionsKey);
  const reviewTunnels = useReviewTunnels(job?.launchIds ?? [], pollMs);
  const liveTunnels = reviewTunnels.tunnels.filter((t) => t.status === "open");
  // The strip is the detail list's current runs (see splitRuns), less any whose pipeline is off.
  const decisions = usePipelineDecisions(job?.id, pollMs);
  const activeRuns = splitRuns(pipeline.runs).current.filter((r) => r.status !== "disabled");
  const [picked, setPicked] = useState<string | undefined>(undefined);
  const selectedSession =
    job && picked && job.sessionIds.includes(picked) ? picked : job ? defaultSession(job, sessionsById) : undefined;

  useEffect(() => {
    const frame = requestAnimationFrame(() => setShown(true));
    panelRef.current?.focus();
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const jobApprovals = job ? approvals.filter((a) => a.jobId === job.id && a.status === "pending") : [];
  // A floor hold on the owner's card is decided on the card, so its ask isn't listed again.
  const floorCards = renderFloorCard ? jobApprovals.filter(isOwnerFloorCard) : [];
  const pendingApprovals = jobApprovals.filter((a) => !floorCards.includes(a));
  const carded = new Set(floorCards.map((a) => a.args.askId));
  const pendingAsks = activity.asks.filter((a) => !carded.has(a.id));
  const latestCheckpoint = newest(activity.checkpoints);
  const state = job ? jobState(job) : undefined;
  const status = state ? JOB_STATE[state] : undefined;
  const note = job ? jobNote(job) : undefined;
  const titleId = `persona-job-drawer-${jobId}`;
  const actions = state === "needs_you" ? job?.view?.actions ?? [] : [];
  const revealPipeline =
    pipeline.runs.length > 0
      ? () => pipelineRef.current?.scrollIntoView?.({ behavior: "smooth", block: "nearest" })
      : undefined;
  // The header speaks for the run that needs the owner, if one does.
  const headRun = activeRuns.find((r) => ownerCanAct(r)) ?? activeRuns[0];
  const headBanner =
    stripHidden && headRun
      ? banner(headRun, headRun.definition.stages.find((s) => s.id === headRun.currentStage), ownerCanAct(headRun))
      : undefined;
  // Faint reads too low at header size, so ended and superseded runs use dim there.
  const headStatus = headBanner && { ...headBanner, color: headBanner.color === theme.faint ? theme.dim : headBanner.color };
  // The scroll region is position: relative so it is the strip's offsetParent.
  const measureStrip = () => {
    const el = scrollRef.current;
    const strip = stripRef.current;
    setStripHidden(!!el && !!strip && el.scrollTop >= strip.offsetTop + strip.offsetHeight);
  };
  // Cards and runs coming and going move the strip without a scroll event.
  useLayoutEffect(measureStrip, [activeRuns.length, floorCards.length]);
  const showStrip = () => {
    // The header line unmounts once the strip is back, so focus moves to the strip first.
    stripRef.current?.focus({ preventScroll: true });
    const reduce = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    scrollRef.current?.scrollTo?.({ top: 0, behavior: reduce ? "auto" : "smooth" });
  };
  const noWorkerNoteId = `${titleId}-no-worker`;
  const headerButtons = (
    <>
      {job && onViewWorker && (
        // aria-disabled rather than disabled, so the reason stays reachable and the button focusable.
        <button
          type="button"
          aria-disabled={selectedSession ? undefined : true}
          aria-describedby={selectedSession ? undefined : noWorkerNoteId}
          title={
            selectedSession
              ? `Open ${sessionName(selectedSession, sessionsById)} in Live workers`
              : "No worker session yet"
          }
          onClick={() => {
            if (selectedSession) onViewWorker(selectedSession);
          }}
          style={selectedSession ? secondaryButton : { ...secondaryButton, opacity: 0.5, cursor: "not-allowed" }}
        >
          View worker
        </button>
      )}
      {job && onDiscuss && (
        <button type="button" onClick={() => onDiscuss(job.id)} style={primaryButton}>
          Discuss in Persona
        </button>
      )}
    </>
  );

  return (
    <>
      <div
        data-testid="job-drawer-backdrop"
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          background: alpha(theme.scrim, 0.35),
          zIndex: 40,
          opacity: shown ? 1 : 0,
          transition: "opacity 160ms ease-out",
        }}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        style={{
          position: "fixed",
          top: 0,
          right: 0,
          bottom: 0,
          width: "min(760px, 100vw)",
          zIndex: 41,
          display: "flex",
          flexDirection: "column",
          background: theme.surface,
          borderLeft: `1px solid ${theme.edge}`,
          boxShadow: `-12px 0 32px ${alpha(theme.shadow, 0.35)}`,
          outline: "none",
          transform: shown ? "translateX(0)" : "translateX(100%)",
          transition: "transform 180ms ease-out",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 10,
            padding: "14px 18px 12px",
            borderBottom: `1px solid ${theme.edge}`,
            flexShrink: 0,
          }}
        >
          <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 5 }}>
            {status && (
              <div style={{ display: "flex", alignItems: "baseline", flexWrap: "wrap", gap: 10 }}>
                <span
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    textTransform: "uppercase",
                    letterSpacing: "0.04em",
                    padding: "1px 6px",
                    borderRadius: 4,
                    color: status.color,
                    background: alpha(status.color, 0x1f),
                  }}
                >
                  {status.label}
                </span>
                <JobActions
                  actions={actions}
                  onDiscuss={job && onDiscuss ? () => onDiscuss(job.id) : undefined}
                  onShowMessages={onShowMessages ? () => onShowMessages(jobId) : undefined}
                  onPipeline={revealPipeline}
                />
                {headStatus && (
                  <button
                    type="button"
                    data-testid="job-drawer-head-stage"
                    title={headStatus.text}
                    aria-label={`${headStatus.text}. Scroll back to the pipeline`}
                    onClick={showStrip}
                    style={{
                      ...linkButton,
                      fontSize: 11.5,
                      color: headStatus.color,
                      maxWidth: "100%",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      textAlign: "left",
                    }}
                  >
                    {headStatus.text} <span aria-hidden="true">↑</span>
                  </button>
                )}
              </div>
            )}
            <h2
              id={titleId}
              style={{ margin: 0, fontSize: 16, fontWeight: 700, color: theme.text, overflowWrap: "anywhere" }}
            >
              {job ? job.title : "Job not found"}
            </h2>
            {onShowMessages && (
              <button
                type="button"
                data-testid="job-drawer-messages"
                onClick={() => onShowMessages(jobId)}
                style={linkButton}
              >
                Messages in thread{messageCount !== undefined ? ` (${messageCount})` : ""}
              </button>
            )}
            {liveTunnels.map((t) => (
              // The branch build up for review, linked where it is always in view.
              <a
                key={t.id}
                href={t.url}
                target="_blank"
                rel="noreferrer"
                data-testid="job-drawer-review-tunnel"
                style={{ ...linkButton, textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 4, overflowWrap: "anywhere" }}
              >
                Review build: {t.url.replace(/^https:\/\//, "")} <LuExternalLink size={11} />
              </a>
            ))}
            {/* On a phone the actions take their own row, so the title keeps the width. */}
            {narrow && job && (onViewWorker || onDiscuss) && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 4 }}>{headerButtons}</div>
            )}
          </div>
          {!narrow && headerButtons}
          <button type="button" aria-label="Close" onClick={onClose} style={closeButton}>
            ×
          </button>
        </div>

        {!job ? (
          <div style={{ padding: 18, fontSize: 13, color: theme.dim }}>
            Persona has no job with id <code style={{ fontFamily: theme.mono }}>{jobId}</code>.
          </div>
        ) : (
          <>
            {/* The pipeline strip scrolls with the job's sections; only the header above stays put. */}
            <div
              ref={scrollRef}
              data-testid="job-drawer-scroll"
              onScroll={measureStrip}
              style={{
                position: "relative",
                flex: "1 1 0",
                minHeight: "min(160px, 25dvh)",
                overflowY: "auto",
                padding: "12px 18px",
                display: "flex",
                flexDirection: "column",
                gap: 14,
              }}
            >
              {/* First in the pane, so its Allow once and Deny show without scrolling. */}
              {floorCards.length > 0 && (
                <div data-testid="job-floor-cards">
                  {/* The card itself says whom it waits on and offers its buttons only to them. */}
                  <div style={fieldLabel}>Safety-floor hold only the owner can let run</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {floorCards.map((a) => (
                      <div key={a.id}>{renderFloorCard!(a)}</div>
                    ))}
                  </div>
                </div>
              )}
              {activeRuns.length > 0 && (
                <div
                  ref={stripRef}
                  tabIndex={-1}
                  role="group"
                  aria-label="Pipeline"
                  data-testid="job-drawer-pipeline-strip"
                  style={{ paddingBottom: 10, borderBottom: `1px solid ${theme.edge}`, display: "flex", flexDirection: "column", gap: 10 }}
                >
                  {activeRuns.map((run) => (
                    <PipelineStrip key={run.id} run={run} surface={theme.surface} />
                  ))}
                </div>
              )}
              <Section title="Intent">
                <Field label="Goal" value={job.goal} />
                {job.acceptance && <Field label="Done when" value={job.acceptance} />}
              </Section>

              <Section title="Current state">
                <div style={{ fontSize: 12, color: theme.dim }}>
                  <span style={{ color: status!.color, fontWeight: 600 }}>{status!.label}</span>
                  {" · updated "}
                  {time(job.updatedAt)}
                  {" · opened "}
                  {time(job.createdAt)}
                </div>
                {job.budget && (
                  <div>
                    <div style={fieldLabel}>Budget</div>
                    <JobBudgetBar budget={job.budget} open={isOpenJob(job)} />
                  </div>
                )}
                {note && <Field label="Persona's latest note" value={note} />}
                {job.outcome && !isOpenJob(job) && <Field label="Outcome" value={job.outcome} />}
                {latestCheckpoint && (
                  <Field
                    label={`Newest checkpoint · ${sessionName(latestCheckpoint.sessionId, sessionsById)} · ${time(latestCheckpoint.createdAt)}`}
                    value={latestCheckpoint.summary}
                  />
                )}
                {(pendingApprovals.length > 0 || pendingAsks.length > 0 || activity.plans.length > 0) && (
                  <div>
                    <div style={fieldLabel}>Waiting on a decision</div>
                    <ul style={{ margin: 0, paddingLeft: 16, display: "flex", flexDirection: "column", gap: 4 }}>
                      {pendingApprovals.map((a) => (
                        <li key={a.id} style={pendingItem}>
                          <b style={{ color: theme.waiting }}>Approval</b> — {approvalHeadline(a)}
                        </li>
                      ))}
                      {pendingAsks.map((a) => (
                        <li key={a.id} style={pendingItem}>
                          <b style={{ color: theme.waiting }}>{a.kind === "permission_prompt" ? "Permission" : "Question"}</b>{" "}
                          from {sessionName(a.sessionId, sessionsById)} — {a.question}
                        </li>
                      ))}
                      {activity.plans.map((p) => (
                        <li key={p.id} style={pendingItem}>
                          <b style={{ color: theme.waiting }}>Plan</b> awaiting approval — {firstLine(p.plan) || "(no plan text)"}
                        </li>
                      ))}
                    </ul>
                    <div style={{ fontSize: 11, color: theme.faint, marginTop: 4 }}>
                      Decide these in the Persona chat, or tell Persona what you want.
                    </div>
                  </div>
                )}
              </Section>

              {reviewTunnels.tunnels.length > 0 && (
                <Section title="Review tunnel">
                  {/* Tearing a tunnel down ends its branch build only; the worker is untouched. */}
                  <ReviewTunnelList tunnels={reviewTunnels.tunnels} onChanged={reviewTunnels.reload} readOnly={!onDiscuss} />
                </Section>
              )}

              <Section title={`Workers${job.sessionIds.length ? ` · ${job.sessionIds.length}` : ""}`}>
                {job.sessionIds.length === 0 ? (
                  <div style={{ fontSize: 12, color: theme.faint }}>
                    {job.launchIds.length > 0 ? "Starting…" : "No worker yet"}
                  </div>
                ) : (
                  <div role="tablist" aria-label="Worker sessions" style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                    {job.sessionIds.map((id) => {
                      const s = sessionsById.get(id);
                      const color = s ? statusColors[s.status] : theme.faint;
                      const selected = id === selectedSession;
                      return (
                        <button
                          key={id}
                          type="button"
                          role="tab"
                          aria-selected={selected}
                          onClick={() => setPicked(id)}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 7,
                            padding: "5px 8px",
                            borderRadius: 5,
                            border: `1px solid ${selected ? theme.edge : "transparent"}`,
                            background: selected ? theme.ground : "transparent",
                            cursor: "pointer",
                            textAlign: "left",
                          }}
                        >
                          <span style={{ width: 7, height: 7, borderRadius: 4, background: color, flexShrink: 0 }} />
                          <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: theme.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {s?.title || id.slice(0, 8)}
                          </span>
                          <span style={{ fontSize: 11, color }}>{s ? (s.endedAt ? "ended" : s.status) : "unknown"}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </Section>

              {activity.floorDecisions.length > 0 && (
                <Section title={`Allowed once by Persona · ${activity.floorDecisions.length}`}>
                  <FloorDecisionList decisions={activity.floorDecisions} />
                </Section>
              )}
              {decisions.length > 0 && (
                <div data-testid="job-drawer-pipeline-decisions">
                  <Section title="Pipeline decisions">
                    <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 8 }}>
                      {decisions.map((d) => (
                        <li key={d.id} data-decision={d.id} data-kind={d.kind} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                          <div style={pendingItem}>
                            <b style={{ color: d.kind === "escalate" ? theme.waiting : theme.expert }}>
                              {decisionLabel(d)}
                            </b>
                            {d.stage ? <span style={{ fontFamily: theme.mono, fontSize: 11, color: theme.dim }}> · {d.stage}</span> : null}
                            {d.reason ? ` — ${d.reason}` : ""}
                          </div>
                          <div style={{ fontSize: 11, color: theme.faint }}>
                            {d.actor}
                            {time(d.createdAt) ? ` · ${time(d.createdAt)}` : ""}
                          </div>
                        </li>
                      ))}
                    </ul>
                  </Section>
                </div>
              )}

              {pipeline.runs.length > 0 && (
                <div ref={pipelineRef} data-testid="job-drawer-pipeline-detail">
                  <Section title="Pipeline detail">
                    {/* Persona decides the gates; a stage's waive control here is the owner's override. */}
                    <div style={{ fontSize: 11, color: theme.faint }}>
                      Persona decides pipeline gates and escalates when it needs you.
                    </div>
                    <PipelineRunList runs={pipeline.runs} onRunChange={pipeline.setRun} surface={theme.surface} />
                  </Section>
                </div>
              )}
            </div>

            {/*
              Half the panel goes to the worker's transcript so a run of tool calls stays
              readable. On a cramped screen it gives way first, down to its own minimum,
              so the sections above keep room for a floor hold's Allow once and Deny.
            */}
            <div
              data-testid="job-drawer-transcript"
              style={{
                flex: selectedSession ? "0 1 50%" : "0 0 auto",
                minHeight: selectedSession ? "min(200px, 30dvh)" : undefined,
                overflow: "hidden",
                display: "flex",
                flexDirection: "column",
                borderTop: `1px solid ${theme.edge}`,
                background: theme.ground,
              }}
            >
              {selectedSession ? (
                <TranscriptView
                  key={selectedSession}
                  sessionId={selectedSession}
                  sessionEnded={!!sessionsById.get(selectedSession)?.endedAt}
                  eventSignal={activity.tick}
                  settings={sessionsById.get(selectedSession)}
                  readOnly
                  readOnlyNote="Read-only — to steer this worker, use Discuss in Persona."
                />
              ) : (
                <div id={noWorkerNoteId} style={{ padding: 18, fontSize: 12.5, color: theme.faint }}>
                  The worker's live activity shows here once Persona starts one.
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </>
  );
}

function sessionName(id: string, sessionsById: Map<string, Session>): string {
  return sessionsById.get(id)?.title || id.slice(0, 8);
}

function firstLine(text: string | undefined): string {
  const line = (text ?? "").split("\n").find((l) => l.trim()) ?? "";
  return line.length > 160 ? `${line.slice(0, 159)}…` : line;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={sectionTitle}>{title}</div>
      {children}
    </section>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={fieldLabel}>{label}</div>
      <div style={{ fontSize: 12.5, lineHeight: 1.5, color: theme.text, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
        {value}
      </div>
    </div>
  );
}

const sectionTitle: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: theme.faint,
};

const fieldLabel: CSSProperties = {
  fontSize: 10.5,
  fontWeight: 600,
  color: theme.faint,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  marginBottom: 2,
};

const pendingItem: CSSProperties = {
  fontSize: 12.5,
  color: theme.text,
  overflowWrap: "anywhere",
};

const primaryButton: CSSProperties = {
  flexShrink: 0,
  fontSize: 12,
  fontWeight: 700,
  padding: "6px 12px",
  borderRadius: 6,
  border: "none",
  background: theme.running,
  color: theme.ground,
  cursor: "pointer",
};

const secondaryButton: CSSProperties = {
  flexShrink: 0,
  fontSize: 12,
  fontWeight: 600,
  padding: "5px 12px",
  borderRadius: 6,
  border: `1px solid ${theme.edge}`,
  background: "transparent",
  color: theme.dim,
  cursor: "pointer",
};

const linkButton: CSSProperties = {
  alignSelf: "flex-start",
  border: "none",
  background: "transparent",
  padding: 0,
  minHeight: 24,
  fontSize: 12,
  fontWeight: 600,
  color: theme.running,
  cursor: "pointer",
};

const closeButton: CSSProperties = {
  flexShrink: 0,
  fontSize: 18,
  lineHeight: 1,
  padding: "4px 8px",
  borderRadius: 6,
  border: `1px solid ${theme.edge}`,
  background: "transparent",
  color: theme.dim,
  cursor: "pointer",
};
