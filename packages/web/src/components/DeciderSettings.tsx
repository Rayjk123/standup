import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { LuCheck } from "react-icons/lu";
import { DECIDER_BACKENDS } from "@standup/shared";
import type {
  DeciderBackendId,
  DeciderBackendPrefs,
  DeciderConfigView,
  DeciderDecisionRecord,
  DecisionKind,
} from "@standup/shared";
import { theme } from "./theme";
import { useNarrow } from "../hooks/useNarrow";

/** What each decision is, in the words the You tab shows. */
const KIND_LABELS: Record<DecisionKind, { title: string; help: string }> = {
  project: {
    title: "Project routing",
    help: "Which project a launch with no project belongs to.",
  },
  turn_end: {
    title: "Turn-end classifier",
    help: "Whether a session that stopped needs you, is done, or is idle.",
  },
  effort: {
    title: "Effort suggestion",
    help: "A suggested reasoning effort for a task. Shown in the composer, never applied.",
  },
  model: {
    title: "Model suggestion",
    help: "A suggested model for a task. Shown in the composer, never applied.",
  },
};

const BACKEND_LABELS: Record<DeciderBackendId, string> = {
  claude: "claude -p",
};

/** A select value: a backend, or "" for "inherit the layer below". */
type Choice = DeciderBackendId | "";

const th: CSSProperties = {
  textAlign: "left",
  padding: "7px 10px",
  fontSize: 11,
  fontWeight: 600,
  color: theme.faint,
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  borderBottom: `1px solid ${theme.edge}`,
  whiteSpace: "nowrap",
};
const td: CSSProperties = {
  padding: "8px 10px",
  fontSize: 12.5,
  color: theme.dim,
  borderBottom: `1px solid ${theme.edgeSoft}`,
  verticalAlign: "top",
};
const select: CSSProperties = {
  fontSize: 12.5,
  color: theme.text,
  background: theme.ground,
  border: `1px solid ${theme.edge}`,
  borderRadius: 6,
  padding: "4px 6px",
};
const badge: CSSProperties = {
  display: "inline-block",
  fontSize: 10.5,
  fontWeight: 600,
  padding: "1px 7px",
  borderRadius: 999,
  border: `1px solid ${theme.edge}`,
  color: theme.faint,
  marginLeft: 6,
  whiteSpace: "nowrap",
};

function toChoices(prefs: DeciderBackendPrefs): Record<DecisionKind, Choice> {
  return {
    project: prefs.project ?? "",
    turn_end: prefs.turn_end ?? "",
    effort: prefs.effort ?? "",
    model: prefs.model ?? "",
  };
}

function toPrefs(choices: Record<DecisionKind, Choice>): DeciderBackendPrefs {
  const out: DeciderBackendPrefs = {};
  for (const [kind, value] of Object.entries(choices) as Array<[DecisionKind, Choice]>) {
    if (value) out[kind] = value;
  }
  return out;
}

function sameChoices(a: Record<DecisionKind, Choice>, b: Record<DecisionKind, Choice>): boolean {
  return (Object.keys(a) as DecisionKind[]).every((k) => a[k] === b[k]);
}

/** "84 ms" or "4.5 s". */
function formatLatency(ms: number | null): string {
  if (ms === null) return "—";
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function formatConfidence(c: number | null): string {
  return c === null ? "—" : c.toFixed(2);
}

/**
 * The viewer's decision settings: which backend answers each of Standup's
 * small decisions, for them (their layer) and for everyone (the global layer,
 * which only the owner can change), with the routing that results and their
 * recent decisions. Each select offers every backend in DECIDER_BACKENDS.
 */
export function DeciderSettings() {
  const narrow = useNarrow();
  const [config, setConfig] = useState<DeciderConfigView | null>(null);
  const [decisions, setDecisions] = useState<DeciderDecisionRecord[]>([]);
  const [everyone, setEveryone] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mine, setMine] = useState<Record<DecisionKind, Choice>>(toChoices({}));
  const [global, setGlobal] = useState<Record<DecisionKind, Choice>>(toChoices({}));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Seeds the server's view; `keep` holds the draft of a layer whose save didn't happen.
  const seed = useCallback((next: DeciderConfigView, keep: { mine?: boolean; global?: boolean } = {}) => {
    setConfig(next);
    if (!keep.mine) setMine(toChoices(next.user));
    if (!keep.global) setGlobal(toChoices(next.global));
  }, []);

  // Only the latest request's reply lands, so a quick toggle can't leave one
  // view's rows under the other's heading.
  const decisionsRequest = useRef(0);
  const loadDecisions = useCallback(async (all: boolean) => {
    const seq = ++decisionsRequest.current;
    try {
      const res = await fetch(`/api/decider/decisions?limit=12${all ? "&all=1" : ""}`);
      const rows = res.ok ? ((await res.json()) as DeciderDecisionRecord[]) : null;
      if (rows && seq === decisionsRequest.current) setDecisions(rows);
    } catch {
      // The audit list is secondary; the settings still render without it.
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/decider/config");
        if (res.status === 403) {
          setLoadError("Sign in to the console to see and change your decision settings.");
          return;
        }
        if (!res.ok) throw new Error(String(res.status));
        seed((await res.json()) as DeciderConfigView);
        setLoadError(null);
      } catch {
        setLoadError("Couldn't load your decision settings — reload to try again.");
      }
    })();
  }, [seed]);

  useEffect(() => {
    void loadDecisions(everyone);
  }, [loadDecisions, everyone]);

  if (loadError) return <div style={{ fontSize: 13, color: theme.dim }}>{loadError}</div>;
  if (!config) return <div style={{ fontSize: 13, color: theme.faint }}>Loading…</div>;

  const dirtyMine = !sameChoices(mine, toChoices(config.user));
  const dirtyGlobal = config.isOwner && !sameChoices(global, toChoices(config.global));

  const put = async (url: string, prefs: DeciderBackendPrefs): Promise<DeciderConfigView> => {
    const res = await fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ backends: prefs }),
    });
    if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`);
    return (await res.json()) as DeciderConfigView;
  };

  // Your own layer first, so a refused global write never costs you your own;
  // each successful write reseeds what the server now holds.
  const save = async () => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      if (dirtyMine) seed(await put("/api/decider/prefs", toPrefs(mine)), { global: dirtyGlobal });
      if (dirtyGlobal) seed(await put("/api/decider/global", toPrefs(global)));
      setSaved(true);
      void loadDecisions(everyone);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const edit = (setter: typeof setMine, current: Record<DecisionKind, Choice>, kind: DecisionKind, value: Choice) => {
    setSaved(false);
    setter({ ...current, [kind]: value });
  };

  const options = (inheritLabel: string) => (
    <>
      <option value="">{inheritLabel}</option>
      {DECIDER_BACKENDS.map((b) => (
        <option key={b} value={b}>
          {BACKEND_LABELS[b]}
        </option>
      ))}
    </>
  );

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ fontSize: 12.5, color: theme.dim, lineHeight: 1.55 }}>
        Each decision runs on a decision backend. The built-in backend is <code>claude -p</code>, a headless Claude
        call that takes a few seconds. Recent decisions are listed below, with their answer, latency and confidence.
      </div>

      <div style={{ border: `1px solid ${theme.edge}`, borderRadius: 8, overflowX: "auto", background: theme.surface }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={th}>Decision</th>
              <th style={th}>You</th>
              <th style={th}>Everyone</th>
              <th style={th}>Runs on</th>
            </tr>
          </thead>
          <tbody>
            {config.kinds.map((k) => {
              const meta = KIND_LABELS[k.kind];
              return (
                <tr key={k.kind} data-testid={`decider-row-${k.kind}`}>
                  <td style={{ ...td, minWidth: narrow ? 140 : 220 }}>
                    <div style={{ color: theme.text, fontWeight: 600 }}>
                      {meta.title}
                      {k.suggestionOnly && <span style={badge}>suggestion only</span>}
                    </div>
                    <div style={{ fontSize: 11.5, color: theme.faint, marginTop: 3, lineHeight: 1.45 }}>
                      {meta.help}
                    </div>
                  </td>
                  <td style={td}>
                    <select
                      aria-label={`${meta.title}: your backend`}
                      style={select}
                      value={mine[k.kind]}
                      disabled={busy}
                      onChange={(e) => edit(setMine, mine, k.kind, e.target.value as Choice)}
                    >
                      {options("Use everyone's")}
                    </select>
                  </td>
                  <td style={td}>
                    <select
                      aria-label={`${meta.title}: everyone's backend`}
                      title={config.isOwner ? undefined : "Only the owner can change everyone's setting"}
                      style={select}
                      value={global[k.kind]}
                      disabled={busy || !config.isOwner}
                      onChange={(e) => edit(setGlobal, global, k.kind, e.target.value as Choice)}
                    >
                      {options(`Default (${BACKEND_LABELS[k.defaultBackend] ?? k.defaultBackend})`)}
                    </select>
                  </td>
                  <td style={{ ...td, whiteSpace: "nowrap" }}>
                    <span style={{ color: theme.text, fontFamily: theme.mono }}>
                      {BACKEND_LABELS[k.backend] ?? k.backend}
                    </span>
                    <div style={{ fontSize: 11, color: theme.faint, marginTop: 3 }}>
                      {k.source === "user" ? "your setting" : k.source === "global" ? "everyone's setting" : "default"}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <button
          type="button"
          onClick={() => void save()}
          disabled={busy || (!dirtyMine && !dirtyGlobal)}
          style={{
            fontSize: 12.5,
            fontWeight: 600,
            padding: "6px 14px",
            borderRadius: 6,
            border: `1px solid ${theme.accent}`,
            background: theme.accentSoft,
            color: theme.text,
            cursor: busy || (!dirtyMine && !dirtyGlobal) ? "default" : "pointer",
            opacity: busy || (!dirtyMine && !dirtyGlobal) ? 0.55 : 1,
          }}
        >
          {busy ? "Saving…" : "Save"}
        </button>
        {saved && (
          <span style={{ fontSize: 12, color: theme.accent }}>
            <LuCheck size={12} style={{ verticalAlign: -1 }} /> Saved
          </span>
        )}
        {error && <span style={{ fontSize: 12, color: theme.stalled }}>{error}</span>}
        {!config.isOwner && (
          <span style={{ fontSize: 11.5, color: theme.faint }}>Only the owner can change everyone's setting.</span>
        )}
      </div>

      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 6 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: theme.dim }}>
            {everyone ? "Everyone's recent decisions" : "Your recent decisions"}
          </div>
          {config.isOwner && (
            <label style={{ fontSize: 11.5, color: theme.faint, display: "inline-flex", alignItems: "center", gap: 5 }}>
              <input type="checkbox" checked={everyone} onChange={(e) => setEveryone(e.target.checked)} />
              everyone's, including unattributed turn-end decisions
            </label>
          )}
        </div>
        {decisions.length === 0 ? (
          <div style={{ fontSize: 12, color: theme.faint }}>None yet.</div>
        ) : (
          <div style={{ border: `1px solid ${theme.edge}`, borderRadius: 8, overflowX: "auto", background: theme.surface }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={th}>When</th>
                  <th style={th}>Decision</th>
                  <th style={th}>Answer</th>
                  <th style={th}>Backend</th>
                  <th style={th}>Latency</th>
                  <th style={th}>Confidence</th>
                  <th style={th}>Fallback</th>
                </tr>
              </thead>
              <tbody>
                {decisions.map((d) => (
                  <tr key={d.id}>
                    <td style={{ ...td, whiteSpace: "nowrap", fontFamily: theme.mono, fontSize: 11.5 }}>
                      {new Date(d.createdAt).toLocaleString()}
                      {everyone && <div style={{ color: theme.faint }}>{d.alias ?? "unattributed"}</div>}
                    </td>
                    <td style={td}>{KIND_LABELS[d.kind]?.title ?? d.kind}</td>
                    <td style={{ ...td, fontFamily: theme.mono, color: theme.text }}>{d.choice ?? "—"}</td>
                    <td style={{ ...td, fontFamily: theme.mono }}>{BACKEND_LABELS[d.backend] ?? d.backend}</td>
                    <td style={{ ...td, fontFamily: theme.mono }}>{formatLatency(d.latencyMs)}</td>
                    <td style={{ ...td, fontFamily: theme.mono }}>{formatConfidence(d.confidence)}</td>
                    <td style={{ ...td, fontFamily: theme.mono, fontSize: 11.5 }} title={d.detail ?? undefined}>
                      {d.fallbackReason?.replace(/_/g, " ") ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
