import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent, RefObject } from "react";
import type { PersonaJob } from "@standup/shared";
import { alpha, theme } from "./theme";
import { JOB_STATE } from "./jobStatus";
import { isOpenJob, jobState, sortJobs } from "../lib/persona";
import { shortJobId } from "./MessageJobTags";

/** How many jobs the `#` picker lists at once. */
const PICKER_LIMIT = 8;

/** A `#query` being typed: where the `#` sits and the text after it, up to the caret. */
export interface HashQuery {
  start: number;
  end: number;
  query: string;
}

/**
 * The `#query` the caret sits at the end of, if any. The `#` must start a
 * word (line start or after whitespace), so "C#" or "issue#4" never opens
 * the picker.
 */
export function hashQueryAt(text: string, caret: number): HashQuery | null {
  const m = /(^|\s)#([^\s#]*)$/.exec(text.slice(0, caret));
  if (!m) return null;
  const query = m[2] ?? "";
  return { start: caret - query.length - 1, end: caret, query };
}

/** The jobs matching a `#query`, open ones first: by title words, or by id prefix. */
export function matchJobs(jobs: PersonaJob[], query: string, limit = PICKER_LIMIT): PersonaJob[] {
  const q = query.trim().toLowerCase();
  const sorted = sortJobs(jobs);
  const ordered = [...sorted.filter(isOpenJob), ...sorted.filter((j) => !isOpenJob(j))];
  const hits = q
    ? ordered.filter((j) => j.title.toLowerCase().includes(q) || j.id.toLowerCase().startsWith(q))
    : ordered;
  return hits.slice(0, limit);
}

/** The label a tagged message carries: "re: <title>". */
export function jobTagLabel(title: string): string {
  return `re: ${title}`;
}

/**
 * The `#` job picker's state for one textarea. Call `syncCaret` whenever the
 * text or selection changes and route the textarea's keydown through
 * `onKeyDown` first (it returns true when it consumed the key). Picking a
 * job removes the `#query` from the draft and reports the job.
 */
export function useJobHashPicker({
  jobs,
  text,
  setText,
  inputRef,
  onPick,
}: {
  jobs: PersonaJob[];
  text: string;
  setText: (text: string) => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  onPick: (jobId: string) => void;
}) {
  const [caret, setCaret] = useState<number | null>(null);
  const [active, setActive] = useState(0);
  // The `#` the owner dismissed with Esc; a new `#` opens the picker again.
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const restoreCaret = useRef<number | null>(null);

  const query = caret === null ? null : hashQueryAt(text, caret);
  const open = query !== null && query.start !== dismissedAt;
  const matches = open ? matchJobs(jobs, query.query) : [];
  const queryKey = query ? `${query.start}:${query.query}` : "";

  useEffect(() => setActive(0), [queryKey]);

  useEffect(() => {
    const at = restoreCaret.current;
    const el = inputRef.current;
    if (at === null || !el) return;
    restoreCaret.current = null;
    el.focus();
    el.setSelectionRange(at, at);
  }, [text, inputRef]);

  const syncCaret = useCallback(() => {
    const el = inputRef.current;
    setCaret(el && el.selectionStart === el.selectionEnd ? el.selectionStart : null);
  }, [inputRef]);

  const pick = useCallback(
    (job: PersonaJob) => {
      if (!query) return;
      const next = text.slice(0, query.start) + text.slice(query.end);
      restoreCaret.current = query.start;
      setCaret(query.start);
      setText(next);
      onPick(job.id);
    },
    [query, text, setText, onPick]
  );

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!open || !query) return false;
      if (e.key === "Escape") {
        setDismissedAt(query.start);
        return true;
      }
      if (matches.length === 0) return false;
      if (e.key === "ArrowDown") {
        setActive((i) => (i + 1) % matches.length);
        return true;
      }
      if (e.key === "ArrowUp") {
        setActive((i) => (i - 1 + matches.length) % matches.length);
        return true;
      }
      if ((e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) || e.key === "Tab") {
        pick(matches[Math.min(active, matches.length - 1)]!);
        return true;
      }
      return false;
    },
    [open, query, matches, active, pick]
  );

  return { open, query: query?.query ?? "", matches, active, pick, onKeyDown, syncCaret };
}

/**
 * The "→ <job> · <short id>" chip above the composer while the thread is
 * filtered to one job: every message sent goes to that job. Its × clears the
 * filter, which routes sends back to the thread.
 */
export function JobRouteChip({ jobId, job, onClear }: { jobId: string; job?: PersonaJob; onClear: () => void }) {
  const color = job ? JOB_STATE[jobState(job)].color : theme.faint;
  const name = job?.title ?? `job ${shortJobId(jobId)}`;
  return (
    <span
      data-testid="composer-route-chip"
      data-job-id={jobId}
      title={`Messages you type here go to ${name}`}
      style={{
        alignSelf: "flex-start",
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        maxWidth: "100%",
        fontSize: 11.5,
        padding: "2px 4px 2px 9px",
        borderRadius: 11,
        border: `1px solid ${theme.accent}`,
        background: theme.accentSoft,
        color: theme.text,
      }}
    >
      <span aria-hidden style={{ color: theme.accent, fontWeight: 700 }}>
        →
      </span>
      <span style={{ width: 6, height: 6, borderRadius: 3, background: color, flexShrink: 0 }} />
      {job && (
        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{job.title}</span>
      )}
      <span style={{ fontFamily: theme.mono, fontSize: 10.5, color: theme.faint, flexShrink: 0 }}>{shortJobId(jobId)}</span>
      <button
        type="button"
        aria-label={`Stop sending to ${name}`}
        title="Clear the job filter; messages go to the thread"
        onClick={onClear}
        style={{
          border: "none",
          background: "transparent",
          color: theme.faint,
          cursor: "pointer",
          fontSize: 13,
          lineHeight: 1,
          padding: "0 4px",
        }}
      >
        ×
      </button>
    </span>
  );
}

/** The removable "re: <job>" chip above the composer. */
export function JobTagChip({ job, onRemove }: { job: PersonaJob; onRemove: () => void }) {
  const color = JOB_STATE[jobState(job)].color;
  return (
    <span
      data-testid="job-tag-chip"
      title={job.goal}
      style={{
        alignSelf: "flex-start",
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        maxWidth: "100%",
        fontSize: 11.5,
        padding: "2px 4px 2px 9px",
        borderRadius: 11,
        border: `1px solid ${alpha(color, 0x55)}`,
        background: alpha(color, 0x14),
        color: theme.text,
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: 3, background: color, flexShrink: 0 }} />
      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {jobTagLabel(job.title)}
      </span>
      <button
        type="button"
        aria-label="Remove job tag"
        onClick={onRemove}
        style={{
          border: "none",
          background: "transparent",
          color: theme.faint,
          cursor: "pointer",
          fontSize: 13,
          lineHeight: 1,
          padding: "0 4px",
        }}
      >
        ×
      </button>
    </span>
  );
}

/** The `#` picker's menu, floated above the composer. */
export function JobPickerMenu({
  matches,
  active,
  query,
  onPick,
}: {
  matches: PersonaJob[];
  active: number;
  query: string;
  onPick: (job: PersonaJob) => void;
}) {
  return (
    <div
      role="listbox"
      aria-label="Tag a job"
      style={{
        position: "absolute",
        left: 12,
        right: 12,
        bottom: "100%",
        marginBottom: 4,
        maxHeight: 260,
        overflowY: "auto",
        background: theme.surface,
        border: `1px solid ${theme.edge}`,
        borderRadius: 8,
        boxShadow: `0 6px 24px ${alpha(theme.shadow, 0.35)}`,
        padding: 4,
        zIndex: 20,
      }}
    >
      <div style={{ padding: "4px 8px 6px", fontSize: 10.5, color: theme.faint }}>
        Tag this message to a job · ↑↓ to choose, Enter to tag, Esc to close
      </div>
      {matches.length === 0 ? (
        <div style={{ padding: "6px 8px 8px", fontSize: 12, color: theme.faint }}>
          {query ? `No job matches "${query}"` : "No jobs yet"}
        </div>
      ) : (
        matches.map((job, i) => {
          const status = JOB_STATE[jobState(job)];
          return (
            <div
              key={job.id}
              role="option"
              aria-selected={i === active}
              // mousedown, not click: the textarea keeps focus and its caret.
              onMouseDown={(e) => {
                e.preventDefault();
                onPick(job);
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "6px 8px",
                borderRadius: 5,
                cursor: "pointer",
                background: i === active ? theme.ground : "transparent",
              }}
            >
              <span
                style={{
                  flexShrink: 0,
                  fontSize: 9.5,
                  fontWeight: 700,
                  textTransform: "uppercase",
                  padding: "1px 5px",
                  borderRadius: 4,
                  color: status.color,
                  background: alpha(status.color, 0x1f),
                }}
              >
                {status.label}
              </span>
              <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: theme.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {job.title}
              </span>
            </div>
          );
        })
      )}
    </div>
  );
}
