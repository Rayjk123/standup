import { useCallback, useEffect, useRef, useState } from "react";
import type { PersonaUsage, SessionUsage, UserUsage } from "@standup/shared";
import { theme, statusColors } from "./theme";
import { JobBudgetBar } from "./JobBudgetBar";
import { claudeModelLabel } from "../lib/launchOptions";
import { formatTokens, formatUsd, unpricedNote } from "../lib/usageFormat";
import { useNarrow } from "../hooks/useNarrow";

/**
 * The signed-in viewer's own token usage and estimated cost: headline totals
 * plus one row per session they own. Self-fetches GET /api/usage/me, which
 * scopes to the viewer the collector proved (never one the client names), so
 * the section shows nobody else's spend. A viewer the collector can't prove
 * gets a sign-in prompt instead of figures. A session whose model isn't in
 * the pricing map shows its tokens with a "—" cost, and the headline notes how
 * many such sessions there are so the total reads as a partial lower bound.
 */

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; data: UserUsage }
  | { kind: "sign-in" }
  | { kind: "error"; message: string };

const th: React.CSSProperties = {
  textAlign: "right",
  padding: "7px 12px",
  fontSize: 11,
  fontWeight: 600,
  color: theme.faint,
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  borderBottom: `1px solid ${theme.edge}`,
  whiteSpace: "nowrap",
};

const td: React.CSSProperties = {
  textAlign: "right",
  padding: "8px 12px",
  fontSize: 12.5,
  fontFamily: theme.mono,
  color: theme.dim,
  borderBottom: `1px solid ${theme.edgeSoft}`,
  whiteSpace: "nowrap",
};

const notice: React.CSSProperties = {
  padding: "24px 16px",
  textAlign: "center",
  color: theme.dim,
  fontSize: 13,
  lineHeight: 1.5,
};

function StatCard({ label, value, accent, note }: { label: string; value: string; accent?: boolean; note?: string }) {
  return (
    <div
      style={{
        minWidth: 0,
        background: theme.surface,
        border: `1px solid ${theme.edge}`,
        borderRadius: 8,
        padding: "12px 14px",
      }}
    >
      <div style={{ fontSize: 11, color: theme.faint, textTransform: "uppercase", letterSpacing: "0.05em" }}>{label}</div>
      <div
        style={{
          fontSize: 22,
          fontWeight: 700,
          fontFamily: theme.mono,
          marginTop: 4,
          color: accent ? theme.accent : theme.text,
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {value}
      </div>
      {note && <div style={{ fontSize: 11, color: theme.stalled, marginTop: 4 }}>{note}</div>}
    </div>
  );
}

function sessionLabel(s: SessionUsage): string {
  return s.title || s.sessionId.slice(0, 8);
}

/** The phone layout: one card per session, its cost and total on the first line. */
function SessionCards({ sessions }: { sessions: SessionUsage[] }) {
  return (
    <div style={{ display: "grid", gap: 8 }}>
      {sessions.map((s) => (
        <div
          key={s.sessionId}
          style={{ background: theme.surface, border: `1px solid ${theme.edge}`, borderRadius: 8, padding: "10px 12px" }}
        >
          <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
            <span style={{ color: statusColors[s.status], fontSize: 10 }}>●</span>
            <span
              style={{
                flex: 1,
                minWidth: 0,
                fontSize: 13,
                color: theme.text,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {sessionLabel(s)}
            </span>
            <span style={{ fontFamily: theme.mono, fontSize: 13, color: s.costUsd === null ? theme.faint : theme.accent }}>
              {formatUsd(s.costUsd)}
            </span>
          </div>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: "2px 12px",
              marginTop: 5,
              fontFamily: theme.mono,
              fontSize: 11.5,
              color: theme.faint,
            }}
          >
            <span>{s.model ? claudeModelLabel(s.model) : "unknown model"}</span>
            <span>{formatTokens(s.totalTokens)} total</span>
            <span>{formatTokens(s.inputTokens)} in</span>
            <span>{formatTokens(s.outputTokens)} out</span>
            <span>{formatTokens(s.cacheReadTokens)} cache read</span>
          </div>
        </div>
      ))}
    </div>
  );
}

/** The desktop layout: every token leg in its own column. */
function SessionTable({ sessions }: { sessions: SessionUsage[] }) {
  return (
    <div style={{ border: `1px solid ${theme.edge}`, borderRadius: 8, overflowX: "auto", background: theme.surface }}>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th style={{ ...th, textAlign: "left" }}>Session</th>
            <th style={{ ...th, textAlign: "left" }}>Model</th>
            <th style={th}>Input</th>
            <th style={th}>Output</th>
            <th style={th}>Cache read</th>
            <th style={th}>Cache write</th>
            <th style={th}>Total</th>
            <th style={th}>Est. cost</th>
          </tr>
        </thead>
        <tbody>
          {sessions.map((s) => (
            <tr key={s.sessionId}>
              <td
                style={{
                  ...td,
                  textAlign: "left",
                  fontFamily: theme.sans,
                  color: theme.text,
                  maxWidth: 300,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                <span style={{ color: statusColors[s.status], marginRight: 7, fontSize: 10 }}>●</span>
                {sessionLabel(s)}
              </td>
              <td style={{ ...td, textAlign: "left" }}>{s.model ? claudeModelLabel(s.model) : "—"}</td>
              <td style={td}>{formatTokens(s.inputTokens)}</td>
              <td style={td}>{formatTokens(s.outputTokens)}</td>
              <td style={td}>{formatTokens(s.cacheReadTokens)}</td>
              <td style={td}>{formatTokens(s.cacheCreationTokens)}</td>
              <td style={{ ...td, color: theme.text }}>{formatTokens(s.totalTokens)}</td>
              <td style={{ ...td, color: s.costUsd === null ? theme.faint : theme.accent }}>{formatUsd(s.costUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function YourUsageSection() {
  const narrow = useNarrow();
  const [includeEnded, setIncludeEnded] = useState(false);
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  // Only the latest load may land, so a slow reply to a toggle the viewer has
  // since flipped back can't overwrite the newer figures.
  const latest = useRef(0);

  const load = useCallback(async () => {
    const seq = ++latest.current;
    const settle = (next: LoadState) => {
      if (seq === latest.current) setState(next);
    };
    try {
      const res = await fetch(`/api/usage/me${includeEnded ? "?all=1" : ""}`);
      if (res.status === 403) return settle({ kind: "sign-in" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        return settle({ kind: "error", message: body.error ?? `Couldn't load your usage (${res.status}).` });
      }
      settle({ kind: "ready", data: (await res.json()) as UserUsage });
    } catch {
      settle({ kind: "error", message: "Couldn't load your usage — the collector may be unreachable." });
    }
  }, [includeEnded]);

  useEffect(() => {
    void load();
  }, [load]);

  const controls = (
    <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, color: theme.dim, cursor: "pointer" }}>
        <input type="checkbox" checked={includeEnded} onChange={(e) => setIncludeEnded(e.target.checked)} />
        Include ended
      </label>
      <div style={{ flex: 1 }} />
      <button
        onClick={() => void load()}
        style={{
          fontSize: 12.5,
          fontWeight: 600,
          color: theme.text,
          background: theme.raised,
          border: `1px solid ${theme.edge}`,
          borderRadius: 6,
          padding: "5px 12px",
          cursor: "pointer",
        }}
      >
        Refresh
      </button>
    </div>
  );

  if (state.kind === "loading") return <div style={notice}>Loading…</div>;
  if (state.kind === "sign-in") {
    return (
      <div style={notice}>
        Sign in to the console to see your own usage. Ask the host for a sign-in link
        (<span style={{ fontFamily: theme.mono }}>bun run scripts/console-login.ts --user &lt;you&gt;</span>).
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <div>
        {controls}
        <div style={{ ...notice, color: theme.waiting }}>{state.message}</div>
      </div>
    );
  }

  const { sessions, totals } = state.data;
  return (
    <div>
      {controls}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: narrow ? "repeat(2, minmax(0, 1fr))" : "repeat(4, minmax(0, 1fr))",
          gap: 10,
          marginBottom: 16,
        }}
      >
        <StatCard label="Est. cost" value={formatUsd(totals.costUsd)} accent note={unpricedNote(totals)} />
        <StatCard label="Total tokens" value={formatTokens(totals.totalTokens)} />
        <StatCard label="Output tokens" value={formatTokens(totals.outputTokens)} />
        <StatCard label="Sessions" value={String(totals.sessionCount)} />
      </div>
      {sessions.length === 0 ? (
        <div style={{ ...notice, border: `1px solid ${theme.edge}`, borderRadius: 8, background: theme.surface }}>
          {includeEnded ? "None of your sessions has recorded usage yet." : "None of your active sessions has recorded usage yet."}
        </div>
      ) : narrow ? (
        <SessionCards sessions={sessions} />
      ) : (
        <SessionTable sessions={sessions} />
      )}
      {state.data.persona && <PersonaSpend persona={state.data.persona} includeEnded={includeEnded} />}
    </div>
  );
}

const subheading: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  color: theme.text,
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  margin: "22px 0 10px",
};

/**
 * Persona's own spend — every turn it ran for the viewer — and each of the
 * viewer's jobs against its time and spend budget (its workers plus Persona's
 * share of the turns about it).
 */
function PersonaSpend({ persona, includeEnded }: { persona: PersonaUsage; includeEnded: boolean }) {
  const narrow = useNarrow();
  return (
    <div>
      <div style={subheading}>Persona</div>
      <div
        data-testid="persona-usage-row"
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "baseline",
          gap: "4px 16px",
          background: theme.surface,
          border: `1px solid ${theme.edge}`,
          borderRadius: 8,
          padding: "10px 14px",
          fontFamily: theme.mono,
          fontSize: 12.5,
          color: theme.dim,
        }}
      >
        <span style={{ fontFamily: theme.sans, color: theme.text, fontWeight: 600 }}>Persona (orchestrator)</span>
        <span style={{ color: theme.accent, fontWeight: 700 }}>{formatUsd(persona.costUsd)}</span>
        <span>{persona.turns} turn{persona.turns === 1 ? "" : "s"}, all time</span>
        <span>{formatTokens(persona.inputTokens)} in (incl. cache)</span>
        <span>{formatTokens(persona.outputTokens)} out</span>
      </div>
      <div style={subheading}>Jobs</div>
      {persona.jobs.length === 0 ? (
        <div style={{ ...notice, border: `1px solid ${theme.edge}`, borderRadius: 8, background: theme.surface }}>
          {includeEnded ? "You have no Persona jobs yet." : "You have no open Persona jobs, and none closed today."}
        </div>
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          {persona.jobs.map((j) => (
            <div
              key={j.jobId}
              data-testid="persona-job-spend"
              style={{
                display: "grid",
                gridTemplateColumns: narrow ? "1fr" : "minmax(0, 1.2fr) minmax(0, 1fr)",
                gap: narrow ? 8 : 16,
                alignItems: "center",
                background: theme.surface,
                border: `1px solid ${theme.edge}`,
                borderRadius: 8,
                padding: "10px 14px",
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13, color: theme.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {j.title}
                </div>
                <div style={{ fontFamily: theme.mono, fontSize: 11.5, color: theme.faint, marginTop: 3 }}>
                  {j.status} · workers {formatUsd(j.budget.workerUsd)} · Persona {formatUsd(j.budget.personaUsd)} · total{" "}
                  <span style={{ color: theme.accent }}>{formatUsd(j.budget.spentUsd)}</span>
                </div>
              </div>
              <JobBudgetBar budget={j.budget} compact open={j.status === "active" || j.status === "waiting_user"} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
