import { useState, type CSSProperties } from "react";
import type { PersonaCommitment, PersonaJob } from "@standup/shared";
import { alpha, theme } from "./theme";
import { absoluteTime, relativeTime } from "../lib/schedules";
import { COMMITMENTS_POLL_MS, useOpenCommitments } from "../hooks/useOpenCommitments";
import { commitmentWorker } from "../lib/liveWorkers";

/** Who owes a commitment, as the panel names them. */
export function commitmentOwnerLabel(c: Pick<PersonaCommitment, "assignee">): string {
  if (c.assignee === "persona") return "Persona";
  if (c.assignee === "owner") return "You";
  return `Worker ${(commitmentWorker(c.assignee) ?? "").slice(0, 8)}`;
}

/** overdue: Persona owes it past its stale time; stale: someone else's past it; fresh otherwise. */
export function commitmentState(c: Pick<PersonaCommitment, "assignee" | "staleAfter">, nowMs: number): "overdue" | "stale" | "fresh" {
  const stale = !!c.staleAfter && Date.parse(c.staleAfter) <= nowMs;
  if (!stale) return "fresh";
  return c.assignee === "persona" ? "overdue" : "stale";
}

/** Persona's overdue first, then the rest by who owes them (Persona, workers, you), each stalest first as served. */
export function sortCommitments(list: PersonaCommitment[], nowMs: number): PersonaCommitment[] {
  const who = (c: PersonaCommitment) => (c.assignee === "persona" ? 0 : c.assignee === "owner" ? 2 : 1);
  return list
    .map((c, i) => ({ c, i }))
    .sort((a, b) => {
      const sa = commitmentState(a.c, nowMs) === "overdue" ? 0 : 1;
      const sb = commitmentState(b.c, nowMs) === "overdue" ? 0 : 1;
      return sa - sb || who(a.c) - who(b.c) || a.i - b.i;
    })
    .map(({ c }) => c);
}

/** localStorage key holding "1" while the owner keeps the commitments list expanded. */
export const COMMITMENTS_EXPANDED_KEY = "standup:personaCommitmentsExpanded";

function readExpanded(): boolean {
  try {
    return typeof window !== "undefined" && window.localStorage.getItem(COMMITMENTS_EXPANDED_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * The open loops in Persona's commitments ledger, read-only: who owes each
 * next step, the step, its done-check and age, Persona's overdue ones first
 * and flagged. Rows of a job open its drawer. The ledger is Persona's working
 * memory more than the owner's, so it starts collapsed to its header (count and
 * overdue) and remembers per browser when the owner opens it. Renders nothing
 * while there are none (or before the first read), and re-reads every `pollMs`
 * while the tab is visible; a failed re-read keeps the list.
 */
export function CommitmentsPanel({
  jobs,
  onOpenJob,
  pollMs = COMMITMENTS_POLL_MS,
}: {
  jobs: PersonaJob[];
  onOpenJob: (id: string) => void;
  pollMs?: number;
}) {
  const { list, readAt: nowMs } = useOpenCommitments({ pollMs });
  const [expanded, setExpanded] = useState(readExpanded);

  if (!list || list.length === 0) return null;
  const titles = new Map(jobs.map((j) => [j.id, j.title]));
  const sorted = sortCommitments(list, nowMs);
  const overdue = sorted.filter((c) => commitmentState(c, nowMs) === "overdue").length;
  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    try {
      window.localStorage.setItem(COMMITMENTS_EXPANDED_KEY, next ? "1" : "0");
    } catch {
      // Private mode or a plain-http LAN origin: the choice just won't persist.
    }
  };

  return (
    <div data-testid="persona-commitments" style={{ borderTop: `1px solid ${theme.edge}`, marginTop: 6 }}>
      <button type="button" aria-expanded={expanded} onClick={toggle} style={sideToggleHeading}>
        <span>
          Commitments · {list.length} open
          {overdue > 0 && <span style={expanded ? { color: theme.waiting } : undefined}> · {overdue} overdue</span>}
        </span>
        <span aria-hidden>{expanded ? "▾" : "▸"}</span>
      </button>
      {expanded && <ul style={{ listStyle: "none", margin: 0, padding: "0 8px 6px", display: "flex", flexDirection: "column" }}>
        {sorted.map((c) => {
          const state = commitmentState(c, nowMs);
          const color = state === "overdue" ? theme.waiting : state === "stale" ? theme.dim : theme.running;
          const jobTitle = c.jobId ? titles.get(c.jobId) : undefined;
          return (
            <li key={c.id} data-testid="persona-commitment" data-state={state} style={row}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: theme.faint, flexWrap: "wrap" }}>
                <span style={{ ...chip, color, background: alpha(color, 0x1f) }}>
                  {state === "overdue" ? "Overdue" : commitmentOwnerLabel(c)}
                </span>
                {state === "overdue" && <span>{commitmentOwnerLabel(c)}</span>}
                {state === "stale" && <span>stale</span>}
                <span title={absoluteTime(c.openedAt)}>opened {relativeTime(c.openedAt, new Date(nowMs))}</span>
                {c.source === "auto" && <span>· by Standup</span>}
              </div>
              <div style={{ fontSize: 12.5, color: theme.text, lineHeight: 1.45, overflowWrap: "anywhere" }}>{c.action}</div>
              <div style={{ fontSize: 11.5, color: theme.dim, lineHeight: 1.4, overflowWrap: "anywhere" }}>
                <span style={{ color: theme.faint }}>Done when: </span>
                {c.doneCheck}
              </div>
              {c.jobId && (
                <button type="button" onClick={() => onOpenJob(c.jobId!)} style={jobLink}>
                  {jobTitle ?? `Job ${c.jobId.slice(0, 8)}`} ›
                </button>
              )}
            </li>
          );
        })}
      </ul>}
    </div>
  );
}

/** The header button of a collapsible section in Persona's side column. */
export const sideToggleHeading: CSSProperties = {
  width: "100%",
  display: "flex",
  justifyContent: "space-between",
  padding: "10px 14px",
  background: "transparent",
  border: "none",
  cursor: "pointer",
  textAlign: "left",
  fontFamily: "inherit",
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: theme.faint,
};

const row: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 3,
  padding: "7px 6px",
  borderBottom: `1px solid ${theme.edgeSoft}`,
  minWidth: 0,
};

const chip: CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  padding: "1px 6px",
  borderRadius: 4,
};

const jobLink: CSSProperties = {
  alignSelf: "flex-start",
  background: "transparent",
  border: "none",
  padding: 0,
  fontSize: 11,
  fontWeight: 600,
  color: theme.running,
  cursor: "pointer",
  textAlign: "left",
};
