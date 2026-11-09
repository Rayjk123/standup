import { useCallback, useEffect, useRef, useState } from "react";
import { theme } from "./theme";
import { relativeTime } from "../lib/schedules";

/**
 * The signed-in owner's playbook library: one row per playbook Persona has
 * saved or offered, with when it applies and how often it has been reused.
 * Self-fetches GET /api/persona/playbooks, which answers only the owner the
 * collector proved; anyone else gets a sign-in prompt. The owner keeps or
 * drops a pending playbook and retires an accepted one through
 * POST /api/persona/playbooks/:slug/:decision; a pending playbook can also be
 * accepted from Persona's card in the owner's thread.
 */

interface PlaybookOutcome {
  jobId: string;
  status: string;
  outcome: string | null;
}

interface PlaybookRow {
  slug: string;
  title: string;
  status: "accepted" | "pending";
  whenToUse: string;
  updatedAt: string | null;
  fromJobId: string | null;
  usage: { count: number; lastUsedAt: string | null; lastOutcome: PlaybookOutcome | null };
}

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; playbooks: PlaybookRow[] }
  | { kind: "sign-in" }
  | { kind: "unavailable" }
  | { kind: "error"; message: string };

type PlaybookDecision = "accept" | "reject" | "retire";

const notice: React.CSSProperties = {
  padding: "24px 16px",
  textAlign: "center",
  color: theme.dim,
  fontSize: 13,
  lineHeight: 1.5,
};

const OUTCOME_CLIP = 140;
const RELATIVE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** A recent time reads relative ("3d ago"); an older one reads as a date. */
function whenLabel(iso: string, now: Date = new Date()): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return iso;
  if (Math.abs(now.getTime() - at) < RELATIVE_WINDOW_MS) return relativeTime(iso, now);
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function usageLine(usage: PlaybookRow["usage"]): string {
  const times = `Used ${usage.count} ${usage.count === 1 ? "time" : "times"}`;
  return usage.lastUsedAt ? `${times} · last ${whenLabel(usage.lastUsedAt)}` : times;
}

function StatusPill({ status }: { status: PlaybookRow["status"] }) {
  const accepted = status === "accepted";
  const color = accepted ? theme.done : theme.stalled;
  return (
    <span
      style={{
        flexShrink: 0,
        fontSize: 11,
        fontWeight: 600,
        padding: "2px 8px",
        borderRadius: 999,
        border: `1px solid ${color}`,
        color,
        whiteSpace: "nowrap",
      }}
    >
      {accepted ? "Accepted" : "Awaiting your OK"}
    </span>
  );
}

const actionButton: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: theme.text,
  background: theme.raised,
  border: `1px solid ${theme.edge}`,
  borderRadius: 6,
  padding: "3px 10px",
  cursor: "pointer",
};

function PlaybookItem({ playbook, onDecided }: { playbook: PlaybookRow; onDecided: () => void }) {
  const { usage } = playbook;
  const last = usage.lastOutcome;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const decide = async (decision: PlaybookDecision) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/persona/playbooks/${encodeURIComponent(playbook.slug)}/${decision}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !body.ok) {
        setError(body.error ?? `Couldn't update this playbook (${res.status}).`);
        setBusy(false);
        return;
      }
      setBusy(false);
      onDecided();
    } catch {
      setError("Couldn't update this playbook — the collector may be unreachable.");
      setBusy(false);
    }
  };

  const button = (label: string, decision: PlaybookDecision) => (
    <button
      data-playbook-action={decision}
      disabled={busy}
      onClick={() => void decide(decision)}
      style={{ ...actionButton, cursor: busy ? "default" : "pointer", opacity: busy ? 0.6 : 1 }}
    >
      {label}
    </button>
  );

  return (
    <div
      data-playbook={playbook.slug}
      data-playbook-status={playbook.status}
      style={{ background: theme.surface, border: `1px solid ${theme.edge}`, borderRadius: 8, padding: "10px 12px" }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 13,
            fontWeight: 600,
            color: theme.text,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {playbook.title}
        </span>
        <StatusPill status={playbook.status} />
      </div>
      {playbook.whenToUse && (
        <div
          title={playbook.whenToUse}
          style={{
            marginTop: 4,
            fontSize: 12.5,
            color: theme.dim,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {playbook.whenToUse}
        </div>
      )}
      <div style={{ marginTop: 5, fontFamily: theme.mono, fontSize: 11.5, color: theme.faint }}>{usageLine(usage)}</div>
      {last && (
        <div style={{ marginTop: 3, fontSize: 11.5, color: theme.faint, lineHeight: 1.45 }}>
          <span style={{ fontFamily: theme.mono }}>{last.status}</span>
          {last.outcome && <span> — {clip(last.outcome, OUTCOME_CLIP)}</span>}
        </div>
      )}
      {playbook.status === "pending" && (
        <div style={{ marginTop: 5, fontSize: 11.5, color: theme.stalled }}>
          Keep it here, or approve Persona's card in your thread.
        </div>
      )}
      <div style={{ marginTop: 8, display: "flex", gap: 6 }}>
        {playbook.status === "pending" ? (
          <>
            {button("Keep", "accept")}
            {button("Drop", "reject")}
          </>
        ) : (
          button("Retire", "retire")
        )}
      </div>
      {error && <div style={{ marginTop: 5, fontSize: 11.5, color: theme.waiting }}>{error}</div>}
    </div>
  );
}

export function PlaybooksSection() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  // Only the latest load may land, so a slow reply can't overwrite a newer one.
  const latest = useRef(0);

  const load = useCallback(async () => {
    const seq = ++latest.current;
    const settle = (next: LoadState) => {
      if (seq === latest.current) setState(next);
    };
    try {
      const res = await fetch("/api/persona/playbooks");
      if (res.status === 403) return settle({ kind: "sign-in" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string; reason?: string };
        if (res.status === 503 && body.reason === "unavailable") return settle({ kind: "unavailable" });
        return settle({ kind: "error", message: body.error ?? `Couldn't load your playbooks (${res.status}).` });
      }
      const body = (await res.json()) as { playbooks?: PlaybookRow[] };
      settle({ kind: "ready", playbooks: body.playbooks ?? [] });
    } catch {
      settle({ kind: "error", message: "Couldn't load your playbooks — the collector may be unreachable." });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const controls = (
    <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
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
        Sign in to the console as the owner to see your playbooks. Ask the host for a sign-in link
        (<span style={{ fontFamily: theme.mono }}>bun run scripts/console-login.ts --user &lt;you&gt;</span>).
      </div>
    );
  }
  if (state.kind === "unavailable") {
    return <div style={notice}>Persona is off on this collector, so there are no playbooks to show.</div>;
  }
  if (state.kind === "error") {
    return (
      <div>
        {controls}
        <div style={{ ...notice, color: theme.waiting }}>{state.message}</div>
      </div>
    );
  }

  const { playbooks } = state;
  return (
    <div>
      {controls}
      {playbooks.length === 0 ? (
        <div style={{ ...notice, border: `1px solid ${theme.edge}`, borderRadius: 8, background: theme.surface }}>
          No playbooks yet. When a multi-launch job closes as done, Persona offers to save how it went as a playbook;
          accepted ones are reused in later briefs.
        </div>
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          {playbooks.map((p) => (
            <PlaybookItem key={`${p.status}:${p.slug}`} playbook={p} onDecided={() => void load()} />
          ))}
        </div>
      )}
    </div>
  );
}
