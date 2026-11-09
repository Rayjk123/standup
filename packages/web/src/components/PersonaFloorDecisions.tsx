import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { Link } from "react-router-dom";
import type { PersonaFloorDecision, PersonaJob } from "@standup/shared";
import { alpha, theme } from "./theme";
import { personaCall } from "../lib/persona";

/** How many of the viewer's floor allows the You tab lists. */
const YOU_DECISION_LIMIT = 200;
/** How often the You tab re-reads them. */
const YOU_DECISION_POLL_MS = 5000;

/** The floor gate as the owner reads it. */
function gateLabel(gate: string): string {
  return gate === "safety_floor_owner" ? "owner gate" : gate === "safety_floor" ? "Persona gate" : gate;
}

function when(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/**
 * Safety-floor holds Persona allowed once on its own, newest first: each with
 * its category and gate, when, the held call and Persona's reason. With
 * `jobTitles` each row also links to its job's drawer.
 */
export function FloorDecisionList({
  decisions,
  jobTitles,
}: {
  decisions: PersonaFloorDecision[];
  /** Job titles by id; when given, each row names and links its job. */
  jobTitles?: Map<string, string>;
}) {
  return (
    <ul data-testid="floor-decisions" style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
      {decisions.map((d) => (
        <li key={d.id} data-testid="floor-decision" style={row}>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, fontSize: 11.5, color: theme.dim }}>
            <span style={chip}>Allowed once</span>
            {d.category && <span style={{ ...chip, color: theme.dim, background: theme.raised }}>{d.category}</span>}
            <span>{gateLabel(d.gate)}</span>
            <span style={{ color: theme.faint }}>·</span>
            <span title={d.createdAt}>{when(d.createdAt)}</span>
            <span style={{ color: theme.faint }}>·</span>
            <span>{d.decidedBy}</span>
            {jobTitles && d.jobId && (
              <>
                <span style={{ color: theme.faint }}>·</span>
                <Link to={`/persona?job=${encodeURIComponent(d.jobId)}`} style={{ color: theme.running, textDecoration: "none" }}>
                  {jobTitles.get(d.jobId) ?? d.jobId.slice(0, 8)}
                </Link>
              </>
            )}
          </div>
          <pre style={call} tabIndex={0} aria-label="Held call">
            {d.call}
          </pre>
          <div style={{ fontSize: 12.5, lineHeight: 1.5, color: theme.text, overflowWrap: "anywhere" }}>
            <span style={{ color: theme.faint }}>Reason: </span>
            {d.reason}
          </div>
        </li>
      ))}
    </ul>
  );
}

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; decisions: PersonaFloorDecision[]; jobTitles: Map<string, string> }
  | { kind: "off" }
  | { kind: "sign-in" }
  | { kind: "error"; message: string };

/**
 * The You tab's audit of the viewer's Persona: every safety-floor hold it
 * allowed once without an owner card, with the call, reason and job. These
 * post nothing in the Persona chat, so this and the job drawer are where the
 * owner reviews them. Re-read every `pollMs`, so a new allow shows without a
 * reload; a failed re-read keeps the list on screen.
 */
export function PersonaDecisionsSection({ pollMs = YOU_DECISION_POLL_MS }: { pollMs?: number }) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const [decisions, jobs] = await Promise.all([
        personaCall<{ decisions: PersonaFloorDecision[] }>(`/floor-decisions?limit=${YOU_DECISION_LIMIT}`),
        personaCall<{ jobs: PersonaJob[] }>("/jobs"),
      ]);
      if (cancelled) return;
      setState((prev) => {
        if (!decisions.ok) {
          if (prev.kind === "ready" && !decisions.forbidden) return prev;
          if (decisions.forbidden) return { kind: "sign-in" };
          if (decisions.disabled) return { kind: "off" };
          return { kind: "error", message: decisions.error ?? "Couldn't load" };
        }
        const jobTitles = jobs.ok
          ? new Map((jobs.data?.jobs ?? []).map((j) => [j.id, j.title]))
          : prev.kind === "ready"
            ? prev.jobTitles
            : new Map<string, string>();
        return { kind: "ready", decisions: decisions.data?.decisions ?? [], jobTitles };
      });
    };
    void load();
    const timer = setInterval(() => void load(), pollMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [pollMs]);

  if (state.kind === "loading") return <div style={notice}>Loading…</div>;
  if (state.kind === "off") return <div style={notice}>Persona isn't running for you on this collector.</div>;
  if (state.kind === "sign-in") return <div style={notice}>Sign in to the console to see your Persona's floor allows.</div>;
  if (state.kind === "error") return <div style={{ ...notice, color: theme.waiting }}>{state.message}</div>;
  if (state.decisions.length === 0) {
    return <div style={notice}>Persona hasn't allowed any safety-floor holds on its own yet.</div>;
  }
  return <FloorDecisionList decisions={state.decisions} jobTitles={state.jobTitles} />;
}

const row: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 5,
  padding: "8px 10px",
  borderRadius: 6,
  border: `1px solid ${theme.edgeSoft}`,
  background: theme.ground,
  minWidth: 0,
};

const chip: CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  padding: "1px 6px",
  borderRadius: 4,
  color: theme.checkpoint,
  background: alpha(theme.checkpoint, 0x1f),
};

const call: CSSProperties = {
  margin: 0,
  maxHeight: 96,
  overflow: "auto",
  fontFamily: theme.mono,
  fontSize: 11.5,
  lineHeight: 1.45,
  color: theme.text,
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
};

const notice: CSSProperties = {
  padding: "16px 4px",
  color: theme.dim,
  fontSize: 13,
  lineHeight: 1.5,
};
