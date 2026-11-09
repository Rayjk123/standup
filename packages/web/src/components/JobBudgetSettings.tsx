import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { LuCheck } from "react-icons/lu";
import { JOB_BUDGET_DEFAULTS, JOB_BUDGET_MAX_MINUTES, JOB_BUDGET_MAX_USD, formatMinutes } from "@standup/shared";
import type { JobBudgetLayer, JobBudgetSource, ResolvedJobBudget } from "@standup/shared";
import { theme } from "./theme";

interface JobBudgetResponse {
  global: JobBudgetLayer | null;
  project: JobBudgetLayer | null;
  resolved: ResolvedJobBudget;
  defaults?: { usd: number | null; minutes: number | null };
}

type TimeUnit = "minutes" | "hours";

interface ProjectOption {
  id: string;
  name?: string;
  reserved?: boolean;
}

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

/** A spend layer value as the form shows it: blank inherits, 0 is the No limit box. */
function toUsdField(v: number | null | undefined): { text: string; noLimit: boolean } {
  if (v === null || v === undefined) return { text: "", noLimit: false };
  return v === 0 ? { text: "", noLimit: true } : { text: String(v), noLimit: false };
}

/** A time layer value as the form shows it: an hour or more in tenths of an hour in hours, anything else in minutes. */
function toTimeField(v: number | null | undefined): { text: string; unit: TimeUnit; noLimit: boolean } {
  if (v === null || v === undefined) return { text: "", unit: "hours", noLimit: false };
  if (v === 0) return { text: "", unit: "hours", noLimit: true };
  return v >= 60 && v % 6 === 0
    ? { text: String(v / 60), unit: "hours", noLimit: false }
    : { text: String(v), unit: "minutes", noLimit: false };
}

/** The time text re-expressed in `to`, so switching the unit keeps the same length of time. */
function convertTime(text: string, to: TimeUnit): string {
  const t = text.trim();
  if (!/^\d+(\.\d+)?$/.test(t)) return text;
  const n = Number(t);
  const converted = to === "minutes" ? Math.round(n * 60 * 100) / 100 : Math.round((n / 60) * 100) / 100;
  // A value too small to show in the new unit is left as typed rather than turned into 0 (no limit).
  return n > 0 && converted === 0 ? text : String(converted);
}

/** The input's text as a number, null when blank, or an error. */
function fromField(text: string, max: number, example: string): { value: number | null } | { error: string } {
  const t = text.trim().replace(/^\$/, "");
  if (!t) return { value: null };
  if (!/^\d+(\.\d+)?$/.test(t)) return { error: `must be a plain number from 0 to ${max} (like ${example})` };
  const n = Number(t);
  if (n > max) return { error: `must be at most ${max}` };
  return { value: n };
}

/** "no spend limit, 8h" — a resolved budget in words. */
function describeDefaults(d: { usd: number | null; minutes: number | null }): string {
  const usd = d.usd === null ? "no spend limit" : `$${d.usd}`;
  const minutes = d.minutes === null ? "no time limit" : formatMinutes(d.minutes);
  return `${usd}, ${minutes}`;
}

const SOURCE_LABEL: Record<JobBudgetSource, string> = {
  job: "the job",
  project: "your project setting",
  user: "your default",
  default: "Standup's default",
};

const label: CSSProperties = {
  display: "block",
  fontSize: 11,
  fontWeight: 600,
  color: theme.faint,
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  marginBottom: 5,
};

const field: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  fontSize: 13,
  fontFamily: theme.mono,
  color: theme.text,
  background: theme.ground,
  border: `1px solid ${theme.edge}`,
  borderRadius: 6,
  padding: "8px 10px",
};

const help: CSSProperties = { fontSize: 11.5, color: theme.faint, marginTop: 5, lineHeight: 1.5 };

const noLimitBox: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  fontSize: 12.5,
  color: theme.dim,
  marginTop: 6,
  cursor: "pointer",
};

/**
 * Your default time and spend budget for each Persona job: one for every
 * project, and an override per project that wins over it. Blank inherits the
 * layer beneath (your default, then Standup's); No limit saves 0. Time is set
 * in minutes or hours and saved in minutes. A job's
 * budget covers its workers and Persona's own turns on it; at 80% Persona is
 * told, and at 100% its workers are asked to checkpoint and stop and new
 * launches for it wait for your approval.
 */
export function JobBudgetSettings() {
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [projectId, setProjectId] = useState("");
  const [data, setData] = useState<JobBudgetResponse | null>(null);
  const [usd, setUsd] = useState("");
  const [usdNoLimit, setUsdNoLimit] = useState(false);
  const [time, setTime] = useState("");
  const [timeUnit, setTimeUnit] = useState<TimeUnit>("hours");
  const [timeNoLimit, setTimeNoLimit] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const query = projectId ? `?project=${encodeURIComponent(projectId)}` : "";
  // Only the latest read or write may land, so a slow reply for the project
  // switched away from can't fill the form shown for another.
  const latest = useRef(0);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/projects")
      .then((r) => (r.ok ? r.json() : []))
      .then((list: ProjectOption[]) => {
        if (!cancelled && Array.isArray(list)) setProjects(list.filter((p) => !p.reserved));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const seed = useCallback(
    (next: JobBudgetResponse) => {
      setData(next);
      const layer = (projectId ? next.project : next.global) ?? {};
      const u = toUsdField(layer.usd);
      setUsd(u.text);
      setUsdNoLimit(u.noLimit);
      const t = toTimeField(layer.minutes);
      setTime(t.text);
      setTimeUnit(t.unit);
      setTimeNoLimit(t.noLimit);
    },
    [projectId]
  );

  const load = useCallback(async () => {
    const seq = ++latest.current;
    try {
      const res = await fetch(`/api/job-budget${query}`);
      if (seq !== latest.current) return;
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `Couldn't load your job budget (${res.status}).`);
        return;
      }
      const next = (await res.json()) as JobBudgetResponse;
      if (seq !== latest.current) return;
      seed(next);
      setError(null);
    } catch {
      if (seq === latest.current) setError("Couldn't load your job budget — the collector may be unreachable.");
    }
  }, [query, seed]);

  useEffect(() => {
    setData(null);
    setUsd("");
    setUsdNoLimit(false);
    setTime("");
    setTimeUnit("hours");
    setTimeNoLimit(false);
    setSaved(null);
    void load();
  }, [load]);

  async function send(requested: "PUT" | "DELETE") {
    if (busy) return;
    let body: string | undefined;
    if (requested === "PUT") {
      const u = usdNoLimit ? { value: 0 } : fromField(usd, JOB_BUDGET_MAX_USD, "25 or 2.50");
      const hours = timeUnit === "hours";
      const t = timeNoLimit
        ? { value: 0 }
        : fromField(time, hours ? JOB_BUDGET_MAX_MINUTES / 60 : JOB_BUDGET_MAX_MINUTES, hours ? "8 or 1.5" : "90");
      if ("error" in u) return setError(`Spend ${u.error}.`);
      if ("error" in t) return setError(`Time ${t.error}.`);
      // Time is saved in whole minutes; a positive one that rounds to 0 would read as no limit.
      const minutes = t.value === null ? null : Math.round(hours ? t.value * 60 : t.value);
      if (t.value !== null && t.value > 0 && minutes === 0) return setError("Time must be at least 1 minute.");
      body = JSON.stringify({ usd: u.value, minutes });
    }
    // Saving two blank fields is the same as dropping the layer.
    const blank = !usdNoLimit && !usd.trim() && !timeNoLimit && !time.trim();
    const method = requested === "PUT" && blank ? "DELETE" : requested;
    const seq = ++latest.current;
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const res = await fetch(`/api/job-budget${query}`, {
        method,
        headers: writeHeaders(),
        ...(method === "PUT" ? { body } : {}),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        if (seq !== latest.current) return;
        setError(err.error ?? `${requested === "PUT" ? "Save" : "Reset"} failed (${res.status}).`);
        return;
      }
      const next = (await res.json()) as JobBudgetResponse;
      if (seq !== latest.current) return;
      seed(next);
      setSaved(
        method === "PUT"
          ? "Saved — applies to your open and future jobs that have no budget of their own."
          : "Reset — this layer no longer changes anything."
      );
    } catch {
      if (seq === latest.current) setError("The collector may be unreachable.");
    } finally {
      setBusy(false);
    }
  }

  const defaults = data?.defaults ?? JOB_BUDGET_DEFAULTS;
  const below = projectId ? "your default" : `Standup's default (${describeDefaults(defaults)})`;
  const belowUsd = projectId ? "your default" : `Standup's default (${defaults.usd === null ? "no limit" : `$${defaults.usd}`})`;
  const belowTime = projectId
    ? "your default"
    : `Standup's default (${defaults.minutes === null ? "no limit" : formatMinutes(defaults.minutes)})`;
  const resolved = data?.resolved;
  const button = (primary: boolean): CSSProperties => ({
    fontSize: 13,
    fontWeight: 600,
    color: primary ? theme.ground : theme.text,
    background: primary ? theme.checkpoint : theme.raised,
    border: primary ? "none" : `1px solid ${theme.edge}`,
    borderRadius: 6,
    padding: "8px 16px",
    cursor: busy ? "not-allowed" : "pointer",
    opacity: busy ? 0.5 : 1,
  });

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div>
        <label style={label} htmlFor="job-budget-project">
          Applies to
        </label>
        <select
          id="job-budget-project"
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
          style={{ ...field, fontFamily: theme.sans }}
        >
          <option value="">Every project (your default)</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name || p.id}
            </option>
          ))}
        </select>
        <div style={help}>
          {projectId
            ? "A project setting overrides your default for jobs whose first worker runs in that project."
            : "Your default for every job, unless a project setting overrides it."}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 14 }}>
        <div>
          <label style={label} htmlFor="job-budget-usd">
            Spend per job (USD)
          </label>
          <input
            id="job-budget-usd"
            inputMode="decimal"
            value={usdNoLimit ? "" : usd}
            disabled={usdNoLimit}
            onChange={(e) => {
              setUsd(e.target.value);
              setSaved(null);
            }}
            placeholder={usdNoLimit ? "no limit" : `inherit ${belowUsd}`}
            aria-describedby="job-budget-help"
            style={{ ...field, opacity: usdNoLimit ? 0.5 : 1 }}
          />
          <label style={noLimitBox}>
            <input
              id="job-budget-usd-unlimited"
              type="checkbox"
              aria-label="No spend limit"
              checked={usdNoLimit}
              onChange={(e) => {
                setUsdNoLimit(e.target.checked);
                setSaved(null);
              }}
            />
            No limit
          </label>
        </div>
        <div>
          <label style={label} htmlFor="job-budget-minutes">
            Time per job
          </label>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              id="job-budget-minutes"
              inputMode="decimal"
              value={timeNoLimit ? "" : time}
              disabled={timeNoLimit}
              onChange={(e) => {
                setTime(e.target.value);
                setSaved(null);
              }}
              placeholder={timeNoLimit ? "no limit" : `inherit ${belowTime}`}
              aria-describedby="job-budget-help"
              style={{ ...field, flex: 1, minWidth: 0, opacity: timeNoLimit ? 0.5 : 1 }}
            />
            <select
              id="job-budget-time-unit"
              aria-label="Time unit"
              value={timeUnit}
              disabled={timeNoLimit}
              onChange={(e) => {
                const unit = e.target.value as TimeUnit;
                if (unit !== timeUnit) setTime(convertTime(time, unit));
                setTimeUnit(unit);
                setSaved(null);
              }}
              style={{ ...field, width: "auto", fontFamily: theme.sans, opacity: timeNoLimit ? 0.5 : 1 }}
            >
              <option value="hours">hours</option>
              <option value="minutes">minutes</option>
            </select>
          </div>
          <label style={noLimitBox}>
            <input
              id="job-budget-minutes-unlimited"
              type="checkbox"
              aria-label="No time limit"
              checked={timeNoLimit}
              onChange={(e) => {
                setTimeNoLimit(e.target.checked);
                setSaved(null);
              }}
            />
            No limit
          </label>
        </div>
      </div>
      <div id="job-budget-help" style={{ ...help, marginTop: -8 }}>
        Blank inherits {below}; No limit (or 0) means none. A job's budget covers its workers and Persona's own turns on it;
        time spent waiting on you doesn't count. At 80% Persona is told; at 100% its workers are asked to checkpoint
        and stop (nothing is killed) and new launches for it wait for your approval. To give one job more, tell
        Persona — its request comes to you to approve.
      </div>

      {resolved && (
        <div
          data-testid="job-budget-resolved"
          style={{
            fontSize: 12.5,
            color: theme.dim,
            background: theme.ground,
            border: `1px solid ${theme.edgeSoft}`,
            borderRadius: 6,
            padding: "9px 12px",
          }}
        >
          {projectId
            ? `A job whose first worker runs in ${projects.find((p) => p.id === projectId)?.name || projectId} gets`
            : "A new job gets"}{" "}
          <b style={{ color: theme.text }}>{resolved.usd === null ? "no spend limit" : `$${resolved.usd.toFixed(2)}`}</b>{" "}
          <span style={{ color: theme.faint }}>(from {SOURCE_LABEL[resolved.source.usd]})</span> and{" "}
          <b style={{ color: theme.text }}>{resolved.minutes === null ? "no time limit" : formatMinutes(resolved.minutes)}</b>{" "}
          <span style={{ color: theme.faint }}>(from {SOURCE_LABEL[resolved.source.minutes]})</span>.
        </div>
      )}

      <div role="status" aria-live="polite">
        {error && <div style={{ fontFamily: theme.mono, fontSize: 11.5, color: theme.waiting }}>{error}</div>}
        {saved && !error && (
          <div style={{ fontFamily: theme.mono, fontSize: 11.5, color: theme.checkpoint, display: "flex", alignItems: "center", gap: 5 }}>
            <LuCheck /> {saved}
          </div>
        )}
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <button onClick={() => void send("PUT")} disabled={busy || !data} style={button(true)}>
          {busy ? "Saving…" : "Save budget"}
        </button>
        <button onClick={() => void send("DELETE")} disabled={busy || !data} style={button(false)}>
          Reset this layer
        </button>
      </div>
    </div>
  );
}
