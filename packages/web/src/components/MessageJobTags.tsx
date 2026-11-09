import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { PersonaJob, PersonaJobTagSource, PersonaMessage, PersonaMessageJobTag } from "@standup/shared";
import { alpha, theme } from "./theme";
import { JOB_STATE } from "./jobStatus";
import { byRecentActivity, isOpenJob, jobState, messageJobTags, sortJobs, threadJobCounts } from "../lib/persona";

/** The minimum height of a tappable control on a narrow (touch) screen. */
const TOUCH_TARGET = 32;

/** A job id as chips show it: its first eight characters. */
export function shortJobId(id: string): string {
  return id.slice(0, 8);
}

/** What hovering a tag says about how it was made. */
const SOURCE_TITLES: Record<PersonaJobTagSource, string> = {
  explicit: "Tagged to this job",
  declared: "Persona tagged this message to the job",
  inferred: "Suggested tag — inferred from what Persona did",
};

/** How a screen reader names a tag's source, after the job. */
const SOURCE_LABELS: Record<PersonaJobTagSource, string> = {
  explicit: "tagged",
  declared: "tagged by Persona",
  inferred: "suggested tag",
};

/**
 * One job tag on a message: "<title> · <short id>", opening the job's drawer.
 * An `inferred` tag is drawn dashed and muted, and carries a remove button
 * when `onRemove` is given; explicit and declared tags are solid and fixed.
 */
export function MessageJobChip({
  tag,
  job,
  touch = false,
  onOpen,
  onRemove,
}: {
  tag: PersonaMessageJobTag;
  job?: PersonaJob;
  /** Sizes the chip for a finger rather than a pointer. */
  touch?: boolean;
  onOpen: (jobId: string) => void;
  onRemove?: (jobId: string) => void;
}) {
  const inferred = tag.source === "inferred";
  const color = job ? JOB_STATE[jobState(job)].color : theme.faint;
  const title = job?.title;
  const removable = inferred && onRemove;
  return (
    <span
      data-testid="message-job-tag"
      data-source={tag.source}
      data-job-id={tag.jobId}
      title={SOURCE_TITLES[tag.source]}
      style={{
        display: "inline-flex",
        alignItems: "center",
        maxWidth: "100%",
        minHeight: touch ? TOUCH_TARGET : undefined,
        borderRadius: 11,
        border: inferred ? `1px dashed ${theme.edge}` : `1px solid ${alpha(color, 0x55)}`,
        background: inferred ? "transparent" : alpha(color, 0x14),
        opacity: inferred ? 0.8 : 1,
      }}
    >
      <button
        type="button"
        aria-label={`${title ?? `job ${shortJobId(tag.jobId)}`}, ${SOURCE_LABELS[tag.source]}`}
        onClick={() => onOpen(tag.jobId)}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
          minWidth: 0,
          minHeight: touch ? TOUCH_TARGET : undefined,
          fontSize: 11,
          padding: removable ? "1px 2px 1px 8px" : "1px 8px",
          border: "none",
          background: "transparent",
          color: inferred ? theme.dim : theme.text,
          cursor: "pointer",
        }}
      >
        <span style={{ width: 6, height: 6, borderRadius: 3, background: color, flexShrink: 0 }} />
        {title && (
          <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</span>
        )}
        {title && <span style={{ color: theme.faint }}>·</span>}
        <span style={{ fontFamily: theme.mono, fontSize: 10.5, color: theme.faint, flexShrink: 0 }}>{shortJobId(tag.jobId)}</span>
      </button>
      {removable && (
        <button
          type="button"
          aria-label={`Remove tag ${title ?? shortJobId(tag.jobId)}`}
          title="Remove this suggested tag"
          onClick={() => onRemove(tag.jobId)}
          style={{
            alignSelf: "stretch",
            minWidth: touch ? TOUCH_TARGET : undefined,
            border: "none",
            background: "transparent",
            color: theme.faint,
            cursor: "pointer",
            fontSize: 13,
            lineHeight: 1,
            padding: "0 6px 0 3px",
          }}
        >
          ×
        </button>
      )}
    </span>
  );
}

const JUSTIFY: Record<"start" | "center" | "end", CSSProperties["justifyContent"]> = {
  start: "flex-start",
  center: "center",
  end: "flex-end",
};

/** A message's job tags as one wrapping row of chips; nothing when it has none. */
export function MessageJobChips({
  message,
  jobsById,
  align,
  touch,
  onOpen,
  onRemove,
}: {
  message: PersonaMessage;
  jobsById: Map<string, PersonaJob>;
  align: "start" | "center" | "end";
  touch?: boolean;
  onOpen: (jobId: string) => void;
  /** Removes an inferred tag; absent in a read-only view. */
  onRemove?: (message: PersonaMessage, jobId: string) => void;
}) {
  const tags = messageJobTags(message);
  if (tags.length === 0) return null;
  return (
    <div
      data-testid="message-job-tags"
      style={{ display: "flex", gap: 5, flexWrap: "wrap", justifyContent: JUSTIFY[align], maxWidth: "100%" }}
    >
      {tags.map((tag) => (
        <MessageJobChip
          key={tag.jobId}
          tag={tag}
          job={jobsById.get(tag.jobId)}
          touch={touch}
          onOpen={onOpen}
          onRemove={onRemove ? (jobId) => onRemove(message, jobId) : undefined}
        />
      ))}
    </div>
  );
}

/** One row of the filter's job list. */
interface FilterOption {
  jobId: string;
  job?: PersonaJob;
  /** Held messages in the thread tagged with it; absent for a job the thread doesn't mention. */
  count?: number;
}

/** How many closed jobs the filter lists besides those the thread is tagged with or the filter holds. */
export const RECENT_CLOSED_JOBS = 8;

/**
 * The jobs the filter offers, each with its count of held messages tagged
 * with it: every open job (needs-you first, then most recently active), then
 * the closed ones, most recently active first whether done, failed or
 * cancelled — those the thread is tagged with or the filter holds, and the
 * RECENT_CLOSED_JOBS most recently active others. A tagged or selected
 * job the jobs list doesn't know closes the list, so it can still be picked
 * or cleared.
 */
export function filterOptions(
  messages: PersonaMessage[],
  jobs: PersonaJob[],
  jobsById: Map<string, PersonaJob>,
  selected: string[]
): { active: FilterOption[]; closed: FilterOption[] } {
  const counts = new Map(threadJobCounts(messages).map(({ jobId, count }) => [jobId, count]));
  const chosen = new Set(selected);
  const option = (job: PersonaJob): FilterOption => ({ jobId: job.id, job, count: counts.get(job.id) });
  const active = sortJobs(jobs.filter(isOpenJob)).map(option);
  const closed: FilterOption[] = [];
  let recent = 0;
  for (const job of byRecentActivity(jobs.filter((j) => !isOpenJob(j)))) {
    if (counts.has(job.id) || chosen.has(job.id) || recent++ < RECENT_CLOSED_JOBS) closed.push(option(job));
  }
  for (const jobId of new Set([...counts.keys(), ...selected])) {
    if (!jobsById.has(jobId)) closed.push({ jobId, count: counts.get(jobId) });
  }
  return { active, closed };
}

/**
 * "Filter by job": a button opening a checklist of jobs. On a wide screen it
 * drops down under the button; on a narrow one it is a full-width bottom
 * sheet over a backdrop. Esc, a click outside, or the backdrop closes it.
 */
export function JobFilterControl({
  messages,
  jobs,
  jobsById,
  selected,
  narrow,
  onChange,
}: {
  messages: PersonaMessage[];
  jobs: PersonaJob[];
  jobsById: Map<string, PersonaJob>;
  /** The job ids filtered to; empty when the filter is off. */
  selected: string[];
  narrow: boolean;
  onChange: (jobIds: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const options = useMemo(
    () => (open ? filterOptions(messages, jobs, jobsById, selected) : { active: [], closed: [] }),
    [open, messages, jobs, jobsById, selected]
  );
  const chosen = new Set(selected);

  // Opening moves focus into the list, onto its first row ("All").
  useEffect(() => {
    if (open) panelRef.current?.querySelector<HTMLInputElement>("input[type=checkbox]")?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  const toggle = (jobId: string) =>
    onChange(chosen.has(jobId) ? selected.filter((id) => id !== jobId) : [...selected, jobId]);

  const rowStyle = (checked: boolean): CSSProperties => ({
    display: "flex",
    alignItems: "center",
    gap: 8,
    minHeight: narrow ? 40 : TOUCH_TARGET,
    padding: "2px 8px",
    borderRadius: 5,
    cursor: "pointer",
    background: checked ? theme.ground : "transparent",
  });

  const row = (o: FilterOption) => (
    <label key={o.jobId} data-testid="job-filter-option" data-job-id={o.jobId} style={rowStyle(chosen.has(o.jobId))}>
      <input
        type="checkbox"
        checked={chosen.has(o.jobId)}
        onChange={() => toggle(o.jobId)}
        style={{ width: 16, height: 16, margin: 0, accentColor: theme.accent, flexShrink: 0 }}
      />
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: 4,
          flexShrink: 0,
          background: o.job ? JOB_STATE[jobState(o.job)].color : theme.faint,
        }}
      />
      <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: theme.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {o.job?.title ?? "Unknown job"}
      </span>
      <span style={{ fontFamily: theme.mono, fontSize: 10.5, color: theme.faint, flexShrink: 0 }}>{shortJobId(o.jobId)}</span>
      {o.count !== undefined && (
        <span
          title={`${o.count} message${o.count === 1 ? "" : "s"} in this thread`}
          style={{ fontSize: 11, color: theme.dim, minWidth: 18, textAlign: "right", flexShrink: 0 }}
        >
          {o.count}
        </span>
      )}
    </label>
  );

  const panel = (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Filter by job"
      data-testid="job-filter-popover"
      data-variant={narrow ? "sheet" : "popover"}
      style={narrow ? sheetStyle : popoverStyle}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "4px 8px 6px" }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: theme.text }}>Filter by job</span>
        {selected.length > 0 && (
          <button type="button" onClick={() => onChange([])} style={{ ...textButton, minHeight: narrow ? TOUCH_TARGET : undefined }}>
            Clear
          </button>
        )}
      </div>
      <label data-testid="job-filter-all" style={rowStyle(selected.length === 0)}>
        <input
          type="checkbox"
          checked={selected.length === 0}
          onChange={() => onChange([])}
          style={{ width: 16, height: 16, margin: 0, accentColor: theme.accent, flexShrink: 0 }}
        />
        <span style={{ flex: 1, fontSize: 12.5, color: theme.text }}>All</span>
        <span style={{ fontSize: 11, color: theme.faint }}>whole thread</span>
      </label>
      {options.active.length === 0 && options.closed.length === 0 && (
        <div style={{ padding: "6px 8px 8px", fontSize: 12, color: theme.faint }}>No jobs to filter by yet</div>
      )}
      {options.active.length > 0 && (
        <>
          <div style={sectionLabel}>Active</div>
          {options.active.map(row)}
        </>
      )}
      {options.closed.length > 0 && (
        <>
          <div style={sectionLabel}>Recently closed</div>
          {options.closed.map(row)}
        </>
      )}
    </div>
  );

  return (
    <div ref={rootRef} style={{ position: "relative", flexShrink: 0 }}>
      <button
        ref={buttonRef}
        type="button"
        data-testid="job-filter-button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        style={{
          fontSize: 11.5,
          fontWeight: 600,
          minHeight: narrow ? TOUCH_TARGET : 24,
          padding: "2px 10px",
          borderRadius: 6,
          border: `1px solid ${selected.length > 0 ? theme.accent : theme.edge}`,
          background: selected.length > 0 ? theme.accentSoft : "transparent",
          color: selected.length > 0 ? theme.accent : theme.dim,
          cursor: "pointer",
        }}
      >
        {selected.length > 0 ? `Filtered by job · ${selected.length}` : "Filter by job"}
      </button>
      {open && narrow && (
        <div
          data-testid="job-filter-backdrop"
          onClick={() => setOpen(false)}
          style={{ position: "fixed", inset: 0, background: alpha(theme.scrim, 0.35), zIndex: 30 }}
        />
      )}
      {open && panel}
    </div>
  );
}

/**
 * The strip shown while the thread is filtered: how many messages match, the
 * jobs filtered to (each removable), and Clear.
 */
export function JobFilterBar({
  count,
  selected,
  jobsById,
  narrow,
  onChange,
}: {
  count: number;
  selected: string[];
  jobsById: Map<string, PersonaJob>;
  narrow: boolean;
  onChange: (jobIds: string[]) => void;
}) {
  return (
    <div
      data-testid="job-filter-bar"
      style={{
        display: "flex",
        alignItems: "center",
        flexWrap: "wrap",
        gap: 6,
        padding: "6px 14px",
        borderBottom: `1px solid ${theme.edge}`,
        background: theme.accentSoft,
        fontSize: 12,
        color: theme.dim,
        flexShrink: 0,
      }}
    >
      <span>
        Showing {count} message{count === 1 ? "" : "s"} for
      </span>
      {selected.map((id) => {
        const job = jobsById.get(id);
        return (
          <span
            key={id}
            data-testid="job-filter-chip"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              maxWidth: "100%",
              minHeight: narrow ? TOUCH_TARGET : undefined,
              fontSize: 11,
              padding: "1px 2px 1px 8px",
              borderRadius: 11,
              border: `1px solid ${theme.edge}`,
              background: theme.surface,
              color: theme.text,
            }}
          >
            {job && <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{job.title}</span>}
            <span style={{ fontFamily: theme.mono, fontSize: 10.5, color: theme.faint }}>{shortJobId(id)}</span>
            <button
              type="button"
              aria-label={`Stop filtering by ${job?.title ?? shortJobId(id)}`}
              onClick={() => onChange(selected.filter((s) => s !== id))}
              style={{
                alignSelf: "stretch",
                minWidth: narrow ? TOUCH_TARGET : undefined,
                border: "none",
                background: "transparent",
                color: theme.faint,
                cursor: "pointer",
                fontSize: 13,
                lineHeight: 1,
                padding: "0 5px",
              }}
            >
              ×
            </button>
          </span>
        );
      })}
      <span style={{ color: theme.faint }}>·</span>
      <button
        type="button"
        data-testid="job-filter-clear"
        onClick={() => onChange([])}
        style={{ ...textButton, minHeight: narrow ? TOUCH_TARGET : undefined }}
      >
        Clear
      </button>
    </div>
  );
}

const popoverStyle: CSSProperties = {
  position: "absolute",
  top: "100%",
  right: 0,
  marginTop: 4,
  width: 340,
  maxWidth: "calc(100vw - 24px)",
  maxHeight: 360,
  overflowY: "auto",
  background: theme.surface,
  border: `1px solid ${theme.edge}`,
  borderRadius: 8,
  boxShadow: `0 6px 24px ${alpha(theme.shadow, 0.35)}`,
  padding: 4,
  zIndex: 31,
};

const sheetStyle: CSSProperties = {
  position: "fixed",
  left: 0,
  right: 0,
  bottom: 0,
  maxHeight: "70vh",
  overflowY: "auto",
  background: theme.surface,
  borderTop: `1px solid ${theme.edge}`,
  borderRadius: "12px 12px 0 0",
  boxShadow: `0 -8px 28px ${alpha(theme.shadow, 0.4)}`,
  padding: "10px 8px calc(12px + env(safe-area-inset-bottom))",
  zIndex: 31,
};

const sectionLabel: CSSProperties = {
  padding: "6px 8px 3px",
  fontSize: 10.5,
  fontWeight: 700,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: theme.faint,
};

const textButton: CSSProperties = {
  border: "none",
  background: "transparent",
  color: theme.running,
  fontSize: 12,
  fontWeight: 600,
  padding: "0 4px",
  cursor: "pointer",
};
