import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { LuCheck } from "react-icons/lu";
import {
  DEFAULT_BRIEF_TIME,
  NOTIFY_CONDITIONS,
  PROJECT_NOTIFY_KINDS,
  resolveNotifyPrefs,
} from "@standup/shared";
import type { NotifyChannel, NotifyKind, NotifyOverride, NotifyPrefs } from "@standup/shared";
import { theme } from "./theme";
import { useNarrow } from "../hooks/useNarrow";

interface BriefRun {
  slot: string;
  status: "sent" | "silent" | "skipped";
  detail?: string;
}

interface ReportSchedule {
  id: string;
  title: string;
  cron: string;
  timezone: string;
}

export interface NotifyPrefsResponse {
  global: NotifyOverride | null;
  project: NotifyOverride | null;
  resolved: NotifyPrefs;
  projects: string[];
  /** Whether you have an ntfy topic of your own, which push needs to carry your brief and job updates. */
  privatePush?: boolean;
  brief: {
    enabled: boolean;
    auto: boolean;
    timezone: string;
    nextAt: string | null;
    reportSchedules: ReportSchedule[];
    recent: BriefRun[];
  };
}

interface Project {
  id: string;
  name?: string;
}

const KIND_LABEL: Record<NotifyKind, { title: string; hint: string }> = {
  decision: { title: "Decisions", hint: "Approval cards and Persona's questions" },
  progress: { title: "Progress", hint: "Persona's updates on your jobs as workers move" },
  done: { title: "Job done", hint: "A job Persona closed, done or not" },
  brief: { title: "Daily brief", hint: "Persona's morning summary of your jobs" },
};

const CONDITION_LABEL: Record<string, string> = {
  always: "Always",
  approvals_only: "Approvals only",
  needs_you: "Only when a job needs you",
  never: "Never (console only)",
  failures_only: "Only failures",
  actionable: "Only when something changed",
};

const CHANNEL_LABEL: Record<NotifyChannel, string> = { slack: "Slack DM", push: "Push" };

function writeHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  try {
    const tok = localStorage.getItem("standup.writeToken")?.trim();
    if (tok) headers["x-standup-write-token"] = tok;
  } catch {
    // No storage (private mode) — a loopback collector needs no token.
  }
  return headers;
}

/** A layer with empty route patches and an empty brief dropped, so a save carries only real choices. */
function compact(o: NotifyOverride): NotifyOverride {
  const out: NotifyOverride = {};
  const routes = Object.fromEntries(
    Object.entries(o.routes ?? {}).filter(([, r]) => r && (r.channels !== undefined || r.when !== undefined))
  );
  if (Object.keys(routes).length > 0) out.routes = routes as NotifyOverride["routes"];
  if (o.brief && (o.brief.enabled !== undefined || o.brief.time !== undefined)) out.brief = { ...o.brief };
  if (o.timezone) out.timezone = o.timezone;
  return out;
}

function when(iso: string | null | undefined, timezone: string): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString(undefined, { timeZone: timezone, weekday: "short", hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso;
  }
}

/**
 * Your notification routing: for each kind of Persona update, which channels
 * beyond the console it reaches and on which condition, plus your daily
 * brief. "All projects" edits your global layer; a project edits your layer
 * for it, which overrides the global one for that project's jobs. Edits stay
 * local until Save (PUT); Reset (DELETE) drops the layer.
 */
export function NotificationSettings() {
  const narrow = useNarrow();
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<string>("");
  const query = projectId ? `?project=${encodeURIComponent(projectId)}` : "";
  const [data, setData] = useState<NotifyPrefsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<NotifyOverride>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ lines: string[]; empty: boolean } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/notify-prefs${query}`);
      if (!res.ok) throw new Error(String(res.status));
      const next = (await res.json()) as NotifyPrefsResponse;
      setData(next);
      setDraft(compact((projectId ? next.project : next.global) ?? {}));
      setLoadError(null);
    } catch {
      setLoadError("Couldn't load your notification settings — reload to try again.");
    }
  }, [query, projectId]);

  useEffect(() => {
    // The previous scope's layer must not be saved into this one.
    setData(null);
    setError(null);
    setSaved(null);
    void load();
  }, [load]);

  useEffect(() => {
    fetch("/api/projects")
      .then((r) => (r.ok ? r.json() : []))
      .then((list: unknown) => setProjects(Array.isArray(list) ? (list as Project[]) : []))
      .catch(() => {});
  }, []);

  const resolved = useMemo(
    () => resolveNotifyPrefs(projectId ? [data?.global ?? null, draft] : [draft]),
    [data, draft, projectId]
  );

  function update(next: NotifyOverride) {
    setDraft(compact(next));
    setSaved(null);
  }

  function setRoute(kind: NotifyKind, patch: { channels?: NotifyChannel[]; when?: string }) {
    const routes = { ...(draft.routes ?? {}) } as Record<string, { channels?: NotifyChannel[]; when?: string }>;
    routes[kind] = { ...(routes[kind] ?? {}), ...patch };
    update({ ...draft, routes: routes as NotifyOverride["routes"] });
  }

  function toggleChannel(kind: NotifyKind, channel: NotifyChannel) {
    const current = resolved.routes[kind].channels;
    const next = current.includes(channel) ? current.filter((c) => c !== channel) : [...current, channel];
    setRoute(kind, { channels: next });
  }

  async function send(method: "PUT" | "DELETE", override: NotifyOverride = draft): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const res = await fetch(`/api/notify-prefs${query}`, {
        method,
        headers: writeHeaders(),
        ...(method === "PUT" ? { body: JSON.stringify({ override }) } : {}),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `${method === "PUT" ? "Save" : "Reset"} failed (${res.status})`);
        return false;
      }
      await load();
      setSaved(method === "PUT" ? "Saved." : "Reset — this layer no longer changes anything.");
      return true;
    } catch {
      setError("The collector may be unreachable.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  /** Turns the brief on and pauses the report schedules it replaces. */
  async function switchOver(schedules: ReportSchedule[]) {
    const ok = await send("PUT", compact({ ...draft, brief: { ...draft.brief, enabled: true } }));
    if (!ok) return;
    const failed: string[] = [];
    for (const s of schedules) {
      const res = await fetch(`/api/persona/schedules/${encodeURIComponent(s.id)}`, {
        method: "PATCH",
        headers: writeHeaders(),
        body: JSON.stringify({ enabled: false }),
      }).catch(() => null);
      if (!res?.ok) failed.push(s.title);
    }
    await load();
    if (failed.length > 0) setError(`The brief is on, but these schedules couldn't be paused: ${failed.join(", ")}`);
    else setSaved("Switched — the brief is on and your report schedule is paused (resume it from Schedules anytime).");
  }

  async function loadPreview() {
    try {
      const res = await fetch("/api/notify-prefs/brief/preview");
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { lines: string[]; empty: boolean };
      setPreview({ lines: body.lines, empty: body.empty });
    } catch {
      setError("Couldn't build the preview.");
    }
  }

  if (loadError) return <div style={{ ...mono, color: theme.waiting }}>{loadError}</div>;
  if (!data) return <div style={{ ...mono, color: theme.faint }}>Loading…</div>;

  const kinds: readonly NotifyKind[] = projectId ? PROJECT_NOTIFY_KINDS : (["decision", "progress", "done", "brief"] as const);
  const layerRoutes = draft.routes ?? {};
  const brief = data.brief;
  const briefOn = draft.brief?.enabled ?? brief.enabled;
  const reports = brief.reportSchedules;
  const timezone = resolved.timezone ?? brief.timezone;

  return (
    <div data-testid="notification-settings" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <label style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 12.5, color: theme.text }}>
        <span style={labelStyle}>Scope</span>
        <select aria-label="Notification scope" value={projectId} onChange={(e) => setProjectId(e.target.value)} style={input}>
          <option value="">All projects</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name ?? p.id}
              {data.projects.includes(p.id) ? " · customized" : ""}
            </option>
          ))}
        </select>
        <span style={{ ...help, marginTop: 0 }}>
          {projectId ? "Overrides your global routing for this project's jobs." : "Applies to every project unless a project overrides it."}
        </span>
      </label>

      {!projectId && (
        <div data-testid="brief-settings" style={card}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
            <div>
              <div style={{ fontSize: 13.5, fontWeight: 700, color: theme.text }}>Daily brief</div>
              <div style={help}>
                Persona writes it from your own jobs, approvals, reviews and pipelines: what it did, what waits on you, what's running.
              </div>
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: theme.text }}>
              <input
                type="checkbox"
                aria-label="Daily brief enabled"
                checked={briefOn}
                onChange={(e) => update({ ...draft, brief: { ...draft.brief, enabled: e.target.checked } })}
              />
              {briefOn ? "On" : "Off"}
            </label>
          </div>

          {reports.length > 0 && (draft.brief?.enabled ?? brief.auto) !== false && (
            <div data-testid="brief-switch-over" style={notice}>
              <div style={{ fontSize: 12.5, color: theme.text, fontWeight: 600 }}>
                {briefOn
                  ? "Your own report schedule runs too — you'd get two morning reports."
                  : "Your own report schedule still runs, so the brief is off for now."}
              </div>
              <ul style={{ margin: "6px 0", paddingLeft: 16, fontSize: 12, color: theme.dim }}>
                {reports.map((s) => (
                  <li key={s.id}>
                    “{s.title}” <span style={mono}>{s.cron}</span> · {s.timezone}
                  </li>
                ))}
              </ul>
              <div style={{ ...help, marginTop: 0, marginBottom: 8 }}>
                Switching turns the brief on and pauses {reports.length === 1 ? "it" : "them"}; nothing is deleted.
              </div>
              <button type="button" onClick={() => void switchOver(reports)} disabled={busy} style={{ ...primary, padding: "7px 14px" }}>
                Switch to the brief
              </button>
            </div>
          )}

          <div style={{ display: "grid", gridTemplateColumns: narrow ? "1fr" : "repeat(3, minmax(0, 1fr))", gap: 10, marginTop: 12 }}>
            <label style={field}>
              <span style={labelStyle}>Time</span>
              <input
                type="time"
                aria-label="Brief time"
                value={draft.brief?.time ?? resolved.brief.time ?? DEFAULT_BRIEF_TIME}
                onChange={(e) => update({ ...draft, brief: { ...draft.brief, time: e.target.value || undefined } })}
                style={input}
              />
            </label>
            <label style={field}>
              <span style={labelStyle}>Timezone</span>
              <input
                type="text"
                aria-label="Brief timezone"
                placeholder={brief.timezone}
                value={draft.timezone ?? ""}
                onChange={(e) => update({ ...draft, timezone: e.target.value.trim() || undefined })}
                style={input}
              />
            </label>
            <div style={field}>
              <span style={labelStyle}>Next brief</span>
              <span data-testid="brief-next" style={{ ...mono, color: theme.dim, padding: "5px 0" }}>
                {brief.enabled ? when(brief.nextAt, timezone) : "off"}
              </span>
            </div>
          </div>

          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 12 }}>
            <button type="button" onClick={() => void loadPreview()} style={{ ...secondary, padding: "6px 12px", fontSize: 12 }}>
              Preview what it would cover
            </button>
            {brief.recent.length > 0 && (
              <span style={{ ...help, marginTop: 0 }}>
                Last: {when(brief.recent[0]!.slot, timezone)} — {brief.recent[0]!.status}
                {brief.recent[0]!.detail ? ` (${brief.recent[0]!.detail})` : ""}
              </span>
            )}
          </div>
          {preview && (
            <pre data-testid="brief-preview" style={{ ...mono, ...previewBox }}>
              {preview.empty ? "Nothing changed and nothing waits on you — the brief would stay silent.\n\n" : ""}
              {preview.lines.join("\n")}
            </pre>
          )}
        </div>
      )}

      <div style={card}>
        <div style={{ fontSize: 13.5, fontWeight: 700, color: theme.text }}>Where each update goes</div>
        <div style={help}>Everything stays in your Persona console. Pick what also reaches you on Slack or your phone, and when.</div>
        <div style={{ display: "flex", flexDirection: "column", marginTop: 10 }}>
          {kinds.map((kind) => {
            const route = resolved.routes[kind];
            const inherited = projectId && !layerRoutes[kind];
            return (
              <div
                key={kind}
                data-route-row={kind}
                style={{
                  display: "grid",
                  gridTemplateColumns: narrow ? "1fr" : "minmax(0, 1.3fr) auto minmax(0, 1fr)",
                  gap: narrow ? 6 : 14,
                  alignItems: "center",
                  padding: "10px 0",
                  borderBottom: `1px solid ${theme.edgeSoft}`,
                }}
              >
                <div>
                  <div style={{ fontSize: 12.5, color: theme.text, fontWeight: 600 }}>
                    {KIND_LABEL[kind].title}
                    {inherited && <span style={{ ...mono, color: theme.faint, fontWeight: 400 }}> · from all projects</span>}
                  </div>
                  <div style={{ fontSize: 11.5, color: theme.faint }}>{KIND_LABEL[kind].hint}</div>
                </div>
                <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                  <label style={chip}>
                    <input type="checkbox" checked disabled aria-label={`${KIND_LABEL[kind].title}: console`} /> Console
                  </label>
                  {(["slack", "push"] as const).map((channel) => {
                    // Without a topic of your own, push carries decisions only.
                    const unavailable = channel === "push" && kind !== "decision" && data.privatePush === false;
                    return (
                      <label
                        key={channel}
                        style={{ ...chip, opacity: unavailable ? 0.5 : 1 }}
                        title={unavailable ? "Needs an ntfy topic of your own (NTFY_OWNER_TOPICS)" : undefined}
                      >
                        <input
                          type="checkbox"
                          aria-label={`${KIND_LABEL[kind].title}: ${CHANNEL_LABEL[channel]}`}
                          checked={!unavailable && route.channels.includes(channel)}
                          disabled={unavailable}
                          onChange={() => toggleChannel(kind, channel)}
                        />{" "}
                        {CHANNEL_LABEL[channel]}
                      </label>
                    );
                  })}
                </div>
                <select
                  aria-label={`${KIND_LABEL[kind].title}: when`}
                  value={route.when}
                  onChange={(e) => setRoute(kind, { when: e.target.value })}
                  style={input}
                >
                  {(NOTIFY_CONDITIONS[kind] as readonly string[]).map((c) => (
                    <option key={c} value={c}>
                      {CONDITION_LABEL[c] ?? c}
                    </option>
                  ))}
                </select>
              </div>
            );
          })}
        </div>
        <div style={help}>
          Approval cards always reach your Slack DM when Slack is connected, so you can decide from your phone.
          {data.privatePush === false && " Push carries your brief and job updates only once you have an ntfy topic of your own."}
        </div>
      </div>

      {error && (
        <div data-testid="notification-settings-error" style={{ ...mono, color: theme.waiting }}>
          {error}
        </div>
      )}
      {saved && !error && (
        <div style={{ ...mono, color: theme.checkpoint, display: "flex", alignItems: "center", gap: 5 }}>
          <LuCheck /> {saved}
        </div>
      )}

      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" onClick={() => void send("PUT")} disabled={busy} style={{ ...primary, opacity: busy ? 0.5 : 1 }}>
          {busy ? "Saving…" : "Save notifications"}
        </button>
        <button type="button" onClick={() => void send("DELETE")} disabled={busy} style={secondary}>
          Reset
        </button>
      </div>
    </div>
  );
}

const mono: CSSProperties = { fontFamily: theme.mono, fontSize: 11.5 };

const labelStyle: CSSProperties = {
  fontFamily: theme.mono,
  fontSize: 9.5,
  letterSpacing: "0.14em",
  textTransform: "uppercase",
  color: theme.faint,
};

const help: CSSProperties = { fontSize: 11.5, color: theme.faint, marginTop: 5, lineHeight: 1.5 };

const card: CSSProperties = { border: `1px solid ${theme.edgeSoft}`, borderRadius: 8, padding: "14px 14px 12px", background: theme.ground };

const notice: CSSProperties = {
  marginTop: 12,
  border: `1px solid ${theme.accent}`,
  background: theme.accentSoft,
  borderRadius: 6,
  padding: "10px 12px",
};

const field: CSSProperties = { display: "flex", flexDirection: "column", gap: 4, minWidth: 0 };

const chip: CSSProperties = { display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: theme.dim, whiteSpace: "nowrap" };

const previewBox: CSSProperties = {
  marginTop: 10,
  marginBottom: 0,
  padding: "10px 12px",
  background: theme.surface,
  border: `1px solid ${theme.edgeSoft}`,
  borderRadius: 6,
  color: theme.dim,
  whiteSpace: "pre-wrap",
  overflowX: "auto",
};

const input: CSSProperties = {
  fontSize: 12,
  color: theme.text,
  background: theme.surface,
  border: `1px solid ${theme.edge}`,
  borderRadius: 5,
  padding: "5px 7px",
  outline: "none",
  minWidth: 0,
};

const primary: CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: theme.ground,
  background: theme.checkpoint,
  border: "none",
  borderRadius: 6,
  padding: "9px 18px",
  cursor: "pointer",
};

const secondary: CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: theme.dim,
  background: "transparent",
  border: `1px solid ${theme.edge}`,
  borderRadius: 6,
  padding: "9px 18px",
  cursor: "pointer",
};
