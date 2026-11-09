import { useState } from "react";
import type { ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { formatGb, ramFreeableTitle } from "@standup/shared";
import type { RamFreeable, RamGroup, RamHost, RamLeftover, RamReport } from "@standup/shared";
import { Empty, Section, agoLabel, asOfLabel, stateLinkTarget } from "./StateCard";
import { theme } from "./theme";

const list = <T,>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const str = (value: unknown): string => (typeof value === "string" ? value : "");

/** A stored group with every field it is drawn by. */
function toGroup<T extends RamGroup>(value: unknown, i: number): T {
  const g = record(value);
  return {
    ...g,
    id: str(g.id) || `group-${i}`,
    label: str(g.label),
    rssBytes: num(g.rssBytes),
    processCount: num(g.processCount),
    pids: list<number>(g.pids),
    command: str(g.command),
  } as T;
}

/** A stored host reading with every number it is drawn by; null without a total. */
function toHost(value: unknown): RamHost | null {
  const h = record(value);
  if (num(h.totalBytes) <= 0) return null;
  return {
    totalBytes: num(h.totalBytes),
    usedBytes: num(h.usedBytes),
    availableBytes: num(h.availableBytes),
    swapTotalBytes: num(h.swapTotalBytes),
    swapUsedBytes: num(h.swapUsedBytes),
    standupBytes: num(h.standupBytes),
  };
}

const groupList = <T extends RamGroup>(value: unknown): T[] => list(value).map((g, i) => toGroup<T>(g, i));

/** A stored `/ram` card's data as a full RamReport: a missing section or field reads as empty. */
export function toRamReport(data: unknown, ranAt: string): RamReport {
  const d = record(data);
  const rest = record(d.otherRest);
  return {
    generatedAt: typeof d.generatedAt === "string" ? d.generatedAt : ranAt,
    host: toHost(d.host),
    top: groupList(d.top),
    workers: groupList(d.workers),
    standup: groupList(d.standup),
    leftovers: groupList<RamLeftover>(d.leftovers).map((l) => ({ ...l, kind: str(l.kind) || "process" })),
    other: groupList(d.other),
    otherRest: { count: num(rest.count), rssBytes: num(rest.rssBytes) },
    freeable: list<Record<string, unknown>>(d.freeable).map(
      (f) => ({ ...f, kind: str(f?.kind) || "process", pids: list<number>(f?.pids), count: num(f?.count), rssBytes: num(f?.rssBytes) }) as RamFreeable
    ),
    processError: typeof d.processError === "string" ? d.processError : null,
    summary: typeof d.summary === "string" ? d.summary : "",
  };
}

/** A leftover row's reason, as one short badge. */
const LEFTOVER_BADGE: Record<RamLeftover["reason"], string> = {
  job_closed: "job closed",
  session_ended: "session ended",
  pane_gone: "pane gone",
};

const SECTION_LABEL: Record<RamReport["top"][number]["section"], string> = {
  worker: "Worker",
  standup: "Standup",
  leftover: "Leftover",
  other: "Other",
};

/** " (11% of the total)", "under 1%" for a sliver, capped at 100: summed RSS counts shared pages more than once. */
function shareLabel(part: number, whole: number): string {
  if (whole <= 0 || part <= 0) return "";
  const pct = Math.min(100, Math.round((part / whole) * 100));
  return ` (${pct === 0 ? "under 1%" : `${pct}%`} of the total)`;
}

const tabular = { fontVariantNumeric: "tabular-nums" } as const;
/** Standup's share in the bar and its legend: blue, so the amber of "could be freed" means only that. */
const STANDUP_TONE = theme.running;
/** The rest of what is used: light enough to read against the bar's track. */
const USED_TONE = theme.dim;

function LegendChip({ color }: { color: string }) {
  return <span aria-hidden style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: color, marginRight: 5 }} />;
}

/** The memory bar: Standup's share (at least a sliver when it has any), the rest of what is used, and what is available. */
function MemoryBar({ host }: { host: RamHost }) {
  const width = (bytes: number) => `${host.totalBytes > 0 ? Math.max(0, Math.min(100, (bytes / host.totalBytes) * 100)) : 0}%`;
  const standup = Math.min(host.standupBytes, host.usedBytes);
  return (
    <div
      role="img"
      aria-label={`${formatGb(host.usedBytes)} used of ${formatGb(host.totalBytes)}, Standup ${formatGb(host.standupBytes)}, ${formatGb(host.availableBytes)} available`}
      style={{ display: "flex", height: 8, borderRadius: 4, overflow: "hidden", background: theme.edgeSoft }}
    >
      <span style={{ width: width(standup), minWidth: standup > 0 ? 3 : 0, background: STANDUP_TONE }} />
      <span style={{ width: width(host.usedBytes - standup), background: USED_TONE, opacity: 0.55 }} />
    </div>
  );
}

function Totals({ host }: { host: RamHost | null }) {
  if (!host) return <Empty>No memory reading on this host.</Empty>;
  return (
    <div data-testid="ram-totals" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 17, fontWeight: 700, color: theme.text, ...tabular }}>{formatGb(host.usedBytes)}</span>
        <span style={{ fontSize: 12.5, color: theme.dim, ...tabular }}>used of {formatGb(host.totalBytes)}</span>
        <span style={{ fontSize: 12.5, color: theme.dim, marginLeft: "auto", ...tabular }}>{formatGb(host.availableBytes)} available</span>
      </div>
      <MemoryBar host={host} />
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", fontSize: 11.5, color: theme.dim, ...tabular }}>
        <span>
          <LegendChip color={STANDUP_TONE} />
          Standup {formatGb(host.standupBytes)}
          {shareLabel(host.standupBytes, host.totalBytes)}
        </span>
        <span>
          <LegendChip color={USED_TONE} />
          Everything else {formatGb(Math.max(0, host.usedBytes - host.standupBytes))}
        </span>
        <span>{host.swapTotalBytes > 0 ? `Swap ${formatGb(host.swapUsedBytes)} of ${formatGb(host.swapTotalBytes)}` : "No swap"}</span>
      </div>
    </div>
  );
}

/** "pid 1, 2, 3, 4, 5 +3 more": a long list stays one line on a phone. */
function pidList(pids: number[], max = 5): string {
  return `pid ${pids.slice(0, max).join(", ")}${pids.length > max ? ` +${pids.length - max} more` : ""}`;
}

function GbCell({ bytes, tone }: { bytes: number; tone?: string }) {
  return (
    <span style={{ flexShrink: 0, fontSize: 12.5, fontWeight: 600, color: tone ?? theme.text, fontVariantNumeric: "tabular-nums", minWidth: 58, textAlign: "right" }}>
      {formatGb(bytes)}
    </span>
  );
}

/**
 * One group: its label (linked to its job), what it was attached to, the pids
 * and age, and its heaviest command (left out when `compact`, for the top five).
 */
function GroupRow({ group, nowMs, tone, badge, compact = false }: { group: RamGroup; nowMs: number; tone?: string; badge?: string; compact?: boolean }) {
  const location = useLocation();
  const title = (
    <span style={{ fontSize: 13, color: theme.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{group.label}</span>
  );
  const pids = `${pidList(group.pids)}${group.processCount > group.pids.length ? ` · ${group.processCount} processes` : ""}`;
  const age = group.startedAt ? ` · started ${agoLabel(group.startedAt, nowMs)}` : "";
  return (
    <div data-testid="ram-row" style={{ display: "flex", alignItems: "baseline", gap: 8, minWidth: 0 }}>
      <span style={{ width: 6, height: 6, borderRadius: 3, background: tone ?? theme.idle, flexShrink: 0, alignSelf: "flex-start", marginTop: 6 }} />
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 1 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 6, minWidth: 0, flexWrap: "wrap" }}>
          {group.href ? (
            <Link
              to={stateLinkTarget(group.href, location)}
              style={{ textDecoration: "underline", textDecorationColor: theme.edge, textUnderlineOffset: 3, minWidth: 0, maxWidth: "100%", display: "flex" }}
            >
              {title}
            </Link>
          ) : (
            title
          )}
          {badge && <span style={{ fontSize: 10.5, color: theme.dim }}>{badge}</span>}
        </div>
        {group.detail && <span style={{ fontSize: 11.5, color: theme.dim }}>{group.detail}</span>}
        <span style={{ fontSize: 11, color: theme.dim, ...tabular }}>
          {pids}
          {age}
        </span>
        {group.command && !compact && (
          <span
            title={group.command}
            style={{
              fontFamily: theme.mono,
              fontSize: 11,
              color: theme.dim,
              overflowWrap: "anywhere",
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
            }}
          >
            {group.command}
          </span>
        )}
      </div>
      <GbCell bytes={group.rssBytes} tone={tone === theme.stalled ? tone : undefined} />
    </div>
  );
}

/** A section that folds away, with its count and memory (plus any `extra` not listed) in the summary line. */
function Fold({
  title,
  testId,
  groups,
  extra = { count: 0, rssBytes: 0 },
  open,
  children,
}: {
  title: string;
  testId: string;
  groups: RamGroup[];
  extra?: { count: number; rssBytes: number };
  open?: boolean;
  children: ReactNode;
}) {
  const bytes = groups.reduce((n, g) => n + g.rssBytes, extra.rssBytes);
  return (
    <details data-testid={testId} open={open} style={{ borderTop: `1px solid ${theme.edgeSoft}` }}>
      <summary style={{ cursor: "pointer", fontSize: 12.5, color: theme.dim, padding: "11px 14px", lineHeight: "18px" }}>
        <span style={{ display: "inline-flex", gap: 8, alignItems: "baseline", width: "calc(100% - 18px)", ...tabular }}>
          <span style={{ color: theme.text, fontWeight: 600 }}>{title}</span>
          <span>{groups.length + extra.count}</span>
          <span style={{ marginLeft: "auto" }}>{formatGb(bytes)}</span>
        </span>
      </summary>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: "0 14px 12px" }}>{children}</div>
    </details>
  );
}

/** The command that stops `pids`, for the owner to run (or hand to Persona); /ram itself never runs it. */
export function stopCommand(pids: number[]): string {
  return `kill ${pids.join(" ")}`;
}

/** A link button that copies the stop command, and says so for a moment. */
function CopyStop({ pids }: { pids: number[] }) {
  const [copied, setCopied] = useState(false);
  const canCopy = typeof navigator !== "undefined" && !!navigator.clipboard;
  if (!canCopy || pids.length === 0) return null;
  return (
    <button
      type="button"
      data-testid="ram-copy-stop"
      onClick={() => {
        void navigator.clipboard.writeText(stopCommand(pids)).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        });
      }}
      style={{ background: "none", border: "none", padding: "4px 0", cursor: "pointer", fontSize: 11.5, fontWeight: 600, color: copied ? theme.done : theme.running, alignSelf: "flex-start" }}
    >
      {copied ? `Copied: ${stopCommand(pids)}` : "Copy stop command"}
    </button>
  );
}

function FreeableRow({ f }: { f: RamFreeable }) {
  return (
    <div data-testid="ram-freeable" style={{ display: "flex", alignItems: "baseline", gap: 8, fontSize: 12.5 }}>
      <span style={{ width: 6, height: 6, borderRadius: 3, background: theme.stalled, flexShrink: 0, alignSelf: "flex-start", marginTop: 6 }} />
      <span style={{ flex: 1, minWidth: 0, color: theme.text, display: "flex", flexDirection: "column" }}>
        <span>
          {ramFreeableTitle(f)}
          <span style={{ color: theme.dim, ...tabular }}> · {pidList(f.pids)}</span>
        </span>
        <CopyStop pids={f.pids} />
      </span>
      <GbCell bytes={f.rssBytes} tone={theme.stalled} />
    </div>
  );
}

/** The `/ram` card: host totals and the five heaviest, what could be freed, then folding sections per owner. */
export function RamCard({ report }: { report: RamReport }) {
  const nowMs = Date.parse(report.generatedAt);
  const freeableBytes = report.freeable.reduce((n, f) => n + f.rssBytes, 0);
  return (
    <div data-testid="ram-card" style={{ background: theme.surface, border: `1px solid ${theme.edge}`, borderRadius: 10, overflow: "hidden", minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, padding: "10px 14px", flexWrap: "wrap" }}>
        <span style={{ fontFamily: theme.mono, fontSize: 12.5, fontWeight: 700, color: theme.accent }}>/ram</span>
        <span style={{ fontSize: 13, fontWeight: 600, color: theme.text }}>What is using memory</span>
        <span style={{ marginLeft: "auto", fontSize: 11, color: theme.dim }}>as of {asOfLabel(report.generatedAt)}</span>
      </div>
      <div style={{ padding: "0 14px 12px" }}>
        <Totals host={report.host} />
      </div>

      {report.processError ? (
        <Section testId="ram-error" title="Processes">
          <Empty>{report.processError}</Empty>
        </Section>
      ) : (
        <>
          <Section testId="ram-top" title="Heaviest">
            {report.top.length === 0 ? (
              <Empty>No processes to show.</Empty>
            ) : (
              report.top.map((g) => (
                <GroupRow key={g.id} compact group={g} nowMs={nowMs} badge={SECTION_LABEL[g.section]} tone={g.section === "leftover" ? theme.stalled : g.section === "worker" ? theme.running : undefined} />
              ))
            )}
          </Section>

          <Section
            testId="ram-freeable"
            title="Could be freed"
            count={report.freeable.length > 0 ? formatGb(freeableBytes) : undefined}
            tone={theme.stalled}
          >
            {report.freeable.length === 0 ? (
              <Empty>
                {report.leftovers.length === 0
                  ? "Nothing: no leftovers from closed jobs or ended sessions."
                  : "Nothing cleanup would stop: each leftover's worker is still live, or its parent still runs."}
              </Empty>
            ) : (
              <>
                {report.freeable.map((f) => (
                  <FreeableRow key={`${f.kind}-${f.reason}`} f={f} />
                ))}
                {report.freeable.some((f) => f.reason !== "job_closed") && (
                  <span data-testid="ram-freeable-note" style={{ fontSize: 11.5, color: theme.dim }}>
                    Cleanup stops a closed job's leftovers on its own. For an ended session or a gone pane, close its job first, or stop the pids.
                  </span>
                )}
              </>
            )}
          </Section>

          <Fold testId="ram-leftovers" title="Leftovers" groups={report.leftovers}>
            {report.leftovers.length === 0 ? (
              <Empty>No process outlived its job, session or tmux pane.</Empty>
            ) : (
              report.leftovers.map((l: RamLeftover) => (
                <GroupRow
                  key={l.id}
                  group={{ ...l, label: `${l.kind}: ${l.label}` }}
                  nowMs={nowMs}
                  tone={l.stillLive || l.hasParent ? theme.running : theme.stalled}
                  badge={`${LEFTOVER_BADGE[l.reason] ?? "leftover"}${l.stillLive ? ", still live" : l.hasParent ? ", kept by its parent" : ""}`}
                />
              ))
            )}
          </Fold>
          <Fold testId="ram-workers" title="Workers" groups={report.workers}>
            {report.workers.length === 0 ? <Empty>No worker sessions are running.</Empty> : report.workers.map((g) => <GroupRow key={g.id} group={g} nowMs={nowMs} tone={theme.running} />)}
          </Fold>
          <Fold testId="ram-standup" title="Standup" groups={report.standup}>
            {report.standup.length === 0 ? <Empty>Standup's own processes weren't found.</Empty> : report.standup.map((g) => <GroupRow key={g.id} group={g} nowMs={nowMs} />)}
          </Fold>
          <Fold testId="ram-other" title="Everything else" groups={report.other} extra={report.otherRest}>
            {report.other.length === 0 ? <Empty>Nothing else is running.</Empty> : report.other.map((g) => <GroupRow key={g.id} group={g} nowMs={nowMs} />)}
            {report.otherRest.count > 0 && (
              <span style={{ fontSize: 11.5, color: theme.dim }}>
                And {report.otherRest.count} smaller process trees, {formatGb(report.otherRest.rssBytes)} together.
              </span>
            )}
          </Fold>
        </>
      )}

      <div style={{ padding: "8px 14px", borderTop: `1px solid ${theme.edgeSoft}`, fontSize: 11, color: theme.dim }}>
        Resident memory (RSS): memory shared between processes counts in each. /ram only reads; it stops nothing.
      </div>
    </div>
  );
}
