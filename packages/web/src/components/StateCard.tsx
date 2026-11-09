import type { ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { formatGb, restartLooksOff } from "@standup/shared";
import type { StateHealth, StateInFlightItem, StateItem, StateReport } from "@standup/shared";
import { alpha, theme } from "./theme";

/** "just now", "12 min ago", "3 h ago", "2 days ago" — from `iso` to `nowMs`. */
export function agoLabel(iso: string | undefined, nowMs: number): string {
  if (!iso) return "";
  const ms = nowMs - Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  if (ms < 0) return "in the future";
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.floor(h / 24)} days ago`;
}

/** "3 h 12 min", "2 days 4 h". */
export function durationLabel(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h ${min % 60} min`;
  return `${Math.floor(h / 24)} days ${h % 24} h`;
}

const list = <T,>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/**
 * A stored `/state` card's data as a full StateReport: a card written by an
 * older collector may lack a section, which reads as empty.
 */
export function toStateReport(data: unknown, ranAt: string): StateReport {
  const d = record(data);
  const waiting = record(d.waiting);
  const inFlight = record(d.inFlight);
  const health = record(d.health);
  const verdict = record(d.verdict);
  const stages = list<StateReport["inFlight"]["stages"][number]>(inFlight.stages).map((g) => ({ ...g, jobs: list<StateInFlightItem>(g?.jobs) }));
  return {
    generatedAt: typeof d.generatedAt === "string" ? d.generatedAt : ranAt,
    waiting: {
      jobs: list(waiting.jobs),
      questions: list(waiting.questions),
      approvals: list(waiting.approvals),
      reviews: list(waiting.reviews),
    },
    inFlight: {
      total: typeof inFlight.total === "number" ? inFlight.total : stages.reduce((n, g) => n + g.jobs.length, 0),
      stalled: typeof inFlight.stalled === "number" ? inFlight.stalled : 0,
      stages,
    },
    holds: list(d.holds),
    health: {
      collector: record(health.collector) as StateHealth["collector"],
      restart: (health.restart ?? null) as StateHealth["restart"],
      host: (health.host ?? null) as StateHealth["host"],
      schedules: list(health.schedules),
      budgets: list(health.budgets),
      commitments: list(health.commitments),
    },
    verdict: {
      needYou: typeof verdict.needYou === "number" ? verdict.needYou : 0,
      lookOff: typeof verdict.lookOff === "number" ? verdict.lookOff : 0,
      line: typeof verdict.line === "string" ? verdict.line : "",
    },
  };
}

/** "3:12 PM" for today, else "Oct 5, 3:12 PM". */
export function asOfLabel(iso: string, now: Date = new Date()): string {
  const at = new Date(iso);
  const time = at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return at.toDateString() === now.toDateString() ? time : `${at.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

const sectionTitle = { fontSize: 11, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase", color: theme.dim } as const;

export function Section({ title, count, tone, testId, children }: { title: string; count?: string; tone?: string; testId: string; children: ReactNode }) {
  return (
    <section data-testid={testId} style={{ display: "flex", flexDirection: "column", gap: 6, padding: "10px 14px", borderTop: `1px solid ${theme.edgeSoft}` }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span style={sectionTitle}>{title}</span>
        {count && <span style={{ fontSize: 11.5, color: tone ?? theme.faint }}>{count}</span>}
      </div>
      {children}
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div style={{ fontSize: 12.5, color: theme.dim }}>{children}</div>;
}

/**
 * Where `href` goes from `location`: a link into the Persona view keeps the
 * view's other params (its job filter), so opening a job doesn't clear them.
 */
export function stateLinkTarget(href: string, location: { pathname: string; search: string }): string {
  const [path, query = ""] = href.split("?");
  if (path !== "/persona" || location.pathname !== "/persona") return href;
  const params = new URLSearchParams(location.search);
  for (const [k, v] of new URLSearchParams(query)) params.set(k, v);
  const search = params.toString();
  return search ? `${path}?${search}` : path!;
}

function ItemRow({ item, nowMs, badge, tone }: { item: StateItem; nowMs: number; badge?: string; tone?: string }) {
  const location = useLocation();
  const title = (
    <span style={{ fontSize: 13, color: theme.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
      {item.title}
    </span>
  );
  return (
    <div data-testid="state-item" style={{ display: "flex", alignItems: "baseline", gap: 8, minWidth: 0 }}>
      <span style={{ width: 6, height: 6, borderRadius: 3, background: tone ?? theme.idle, flexShrink: 0, alignSelf: "center" }} />
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        {item.href ? (
          <Link to={stateLinkTarget(item.href, location)} style={{ textDecoration: "none", minWidth: 0, display: "flex" }}>
            {title}
          </Link>
        ) : (
          title
        )}
        {item.detail && <span style={{ fontSize: 11.5, color: theme.dim }}>{item.detail}</span>}
      </div>
      {badge && (
        <span style={{ flexShrink: 0, fontSize: 10, fontWeight: 700, textTransform: "uppercase", padding: "1px 6px", borderRadius: 4, color: theme.stalled, background: alpha(theme.stalled, 0x1f) }}>
          {badge}
        </span>
      )}
      {item.at && <span style={{ flexShrink: 0, fontSize: 11, color: theme.faint }}>{agoLabel(item.at, nowMs)}</span>}
    </div>
  );
}

function Group({ label, items, nowMs, tone }: { label: string; items: StateItem[]; nowMs: number; tone?: string }) {
  if (items.length === 0) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: 11.5, color: theme.faint }}>
        {label} ({items.length})
      </span>
      {items.map((i) => (
        <ItemRow key={i.id} item={i} nowMs={nowMs} tone={tone} />
      ))}
    </div>
  );
}

function HealthRow({ label, ok, children }: { label: string; ok: boolean; children: ReactNode }) {
  return (
    <div data-testid="state-health-row" data-ok={ok ? "true" : "false"} style={{ display: "flex", gap: 10, alignItems: "baseline", fontSize: 12.5 }}>
      <span style={{ width: 8, height: 8, borderRadius: 4, flexShrink: 0, alignSelf: "center", background: ok ? theme.done : theme.stalled }} />
      <span style={{ width: 110, flexShrink: 0, color: theme.dim }}>{label}</span>
      <div style={{ flex: 1, minWidth: 0, color: theme.text, display: "flex", flexDirection: "column", gap: 3 }}>{children}</div>
    </div>
  );
}

function restartLine(r: StateHealth["restart"], nowMs: number): { ok: boolean; text: string } {
  if (!r) return { ok: true, text: "No restarts on record" };
  const when = agoLabel(r.at, nowMs);
  const ok = !restartLooksOff(r, nowMs);
  if (r.outcome === "ok") return { ok, text: `Went fine, ${when}` };
  if (r.outcome === "rolled-back") return { ok, text: `Rolled back to the previous version, ${when}${r.error ? `: ${r.error}` : ""}` };
  if (r.outcome === "failed") return { ok, text: `Failed, ${when}${r.error ? `: ${r.error}` : ""}` };
  return { ok: true, text: `In progress, asked for ${when}` };
}

function hostLine(h: NonNullable<StateHealth["host"]>): string {
  const parts: string[] = [];
  if (h.memAvailableBytes !== undefined) {
    parts.push(`${formatGb(h.memAvailableBytes)} free${h.memTotalBytes ? ` of ${formatGb(h.memTotalBytes)}` : ""}`);
  }
  if (h.load1 !== undefined && h.cores !== undefined) parts.push(`CPU load ${h.load1.toFixed(1)} across ${h.cores} cores`);
  const allowed = Number.isFinite(h.effectiveCap) ? h.effectiveCap : h.cap;
  parts.push(
    `${h.active} of ${h.cap} sessions running${h.hostLimited ? ` (only ${allowed} allowed while the host is busy)` : ""}${h.queued > 0 ? `, ${h.queued} queued` : ""}`
  );
  return parts.join(" · ");
}

function StageGroup({ title, jobs, nowMs }: { title: string; jobs: StateInFlightItem[]; nowMs: number }) {
  return (
    <div data-testid="state-stage" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: 11.5, color: theme.faint }}>
        {title} ({jobs.length})
      </span>
      {jobs.map((j) => (
        <ItemRow
          key={j.id}
          item={{ ...j, detail: `${j.detail ?? ""}${j.lastActivityAt ? ` · last worker activity ${agoLabel(j.lastActivityAt, nowMs)}` : ""}`, at: undefined }}
          nowMs={nowMs}
          tone={j.stalled ? theme.stalled : theme.running}
          badge={j.stalled ? "Stalled" : undefined}
        />
      ))}
    </div>
  );
}

/** The `/state` card: what waits on the owner, what runs, what's held, and health, then the verdict. */
export function StateCard({ report }: { report: StateReport }) {
  const nowMs = Date.parse(report.generatedAt);
  const { waiting, inFlight, holds, health, verdict } = report;
  const waitingCount = waiting.jobs.length + waiting.questions.length + waiting.approvals.length + waiting.reviews.length;
  const restart = restartLine(health.restart, nowMs);
  const verdictTone = verdict.lookOff > 0 ? theme.stalled : verdict.needYou > 0 ? theme.waiting : theme.done;
  return (
    <div
      data-testid="state-card"
      style={{ background: theme.surface, border: `1px solid ${theme.edge}`, borderRadius: 10, overflow: "hidden", minWidth: 0 }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, padding: "10px 14px" }}>
        <span style={{ fontFamily: theme.mono, fontSize: 12.5, fontWeight: 700, color: theme.accent }}>/state</span>
        <span style={{ fontSize: 13, fontWeight: 600, color: theme.text }}>The state of everything</span>
        <span style={{ marginLeft: "auto", fontSize: 11, color: theme.faint }}>
          as of {asOfLabel(report.generatedAt)} · times are as of then
        </span>
      </div>

      <Section testId="state-waiting" title="Waiting on you" count={waitingCount > 0 ? plural(waitingCount, "thing") : undefined} tone={theme.waiting}>
        {waitingCount === 0 ? (
          <Empty>Nothing is waiting on you.</Empty>
        ) : (
          <>
            <Group label="Approvals" items={waiting.approvals} nowMs={nowMs} tone={theme.waiting} />
            <Group label="Questions from Persona" items={waiting.questions} nowMs={nowMs} tone={theme.waiting} />
            <Group label="Reviews" items={waiting.reviews} nowMs={nowMs} tone={theme.waiting} />
            <Group label="Jobs waiting for you" items={waiting.jobs} nowMs={nowMs} tone={theme.waiting} />
          </>
        )}
      </Section>

      <Section
        testId="state-in-flight"
        title="In flight"
        count={inFlight.total > 0 ? `${plural(inFlight.total, "job")}${inFlight.stalled > 0 ? `, ${inFlight.stalled} stalled` : ""}` : undefined}
        tone={inFlight.stalled > 0 ? theme.stalled : undefined}
      >
        {inFlight.total === 0 ? (
          <Empty>No jobs are running.</Empty>
        ) : (
          inFlight.stages.map((g) => <StageGroup key={g.stage || "none"} title={g.title} jobs={g.jobs} nowMs={nowMs} />)
        )}
      </Section>

      <Section testId="state-holds" title="Holds" count={holds.length > 0 ? plural(holds.length, "hold") : undefined} tone={theme.waiting}>
        {holds.length === 0 ? (
          <Empty>No worker is held waiting on an answer.</Empty>
        ) : (
          holds.map((h) => <ItemRow key={h.id} item={h} nowMs={nowMs} tone={theme.waiting} />)
        )}
      </Section>

      <Section testId="state-health" title="Health">
        <HealthRow label="Collector" ok>
          <span>
            {health.collector.uptimeMs !== undefined ? `Up for ${durationLabel(health.collector.uptimeMs)}` : "Running"}
            {health.collector.head ? ` · version ${health.collector.head.slice(0, 8)}` : ""}
          </span>
        </HealthRow>
        <HealthRow label="Last restart" ok={restart.ok}>
          <span>{restart.text}</span>
        </HealthRow>
        <HealthRow label="Host" ok={!health.host?.hostLimited}>
          <span>{health.host ? hostLine(health.host) : "No reading"}</span>
        </HealthRow>
        <HealthRow label="Schedules" ok={health.schedules.length === 0}>
          {health.schedules.length === 0 ? <span>All ran on time</span> : health.schedules.map((s) => <ItemRow key={s.id} item={s} nowMs={nowMs} tone={theme.stalled} />)}
        </HealthRow>
        <HealthRow label="Budgets" ok={health.budgets.length === 0}>
          {health.budgets.length === 0 ? <span>No job is near its budget</span> : health.budgets.map((b) => <ItemRow key={b.id} item={b} nowMs={nowMs} tone={theme.stalled} />)}
        </HealthRow>
        <HealthRow label="Commitments" ok={health.commitments.length === 0}>
          {health.commitments.length === 0 ? (
            <span>Nothing overdue</span>
          ) : (
            health.commitments.map((c) => <ItemRow key={c.id} item={c} nowMs={nowMs} tone={theme.stalled} />)
          )}
        </HealthRow>
      </Section>

      <div
        data-testid="state-verdict"
        style={{ padding: "10px 14px", borderTop: `1px solid ${theme.edge}`, fontSize: 13.5, fontWeight: 700, color: verdictTone, background: alpha(verdictTone, 0x14) }}
      >
        {verdict.line}
      </div>
    </div>
  );
}
