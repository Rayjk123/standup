import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  LuAlarmClock,
  LuCalendarClock,
  LuHistory,
  LuPause,
  LuPencil,
  LuPlay,
  LuPlus,
  LuTrash2,
  LuX,
  LuZap,
} from "react-icons/lu";
import type {
  PersonaSchedule,
  PersonaThreadSummary,
  PersonaWakeupSummary,
  ProjectWithCounts,
  ScheduleCatchUpPolicy,
  ScheduleKind,
  ScheduleOverlapPolicy,
} from "@standup/shared";
import { describeScheduleEnd } from "@standup/shared";
import { alpha, theme } from "./theme";
import { PersonaSignInBanner } from "./PersonaSignInBanner";
import { usePresence } from "../hooks/presence";
import { callerFields, threadLabel, type PersonaViewState } from "../lib/persona";
import {
  CATCH_UP_LABELS,
  scheduleAccess,
  KIND_LABELS,
  OVERLAP_LABELS,
  TRIGGER_LABELS,
  absoluteTime,
  blankScheduleForm,
  cadenceLabel,
  createSchedule,
  deleteSchedule,
  fetchScheduleRuns,
  fetchSchedules,
  formToCreateRequest,
  formToUpdateRequest,
  nextRunLabel,
  outcomeBadge,
  relativeTime,
  runDetail,
  runLinks,
  runScheduleNow,
  scheduleToForm,
  timezoneOptions,
  updateSchedule,
  validateScheduleForm,
  type OutcomeTone,
  type ScheduleForm,
  type ScheduleRunDetail,
} from "../lib/schedules";

/** A slow backstop for changes no frame announces (Persona scheduling a one-shot wakeup). */
const BACKSTOP_MS = 30_000;

const TONE_COLORS: Record<OutcomeTone, string> = {
  running: theme.running,
  done: theme.done,
  failed: theme.waiting,
  skipped: theme.stalled,
};

const th: React.CSSProperties = {
  textAlign: "left",
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
  textAlign: "left",
  padding: "8px 12px",
  fontSize: 12.5,
  color: theme.dim,
  borderBottom: `1px solid ${theme.edgeSoft}`,
  verticalAlign: "top",
};

const label: React.CSSProperties = {
  fontFamily: theme.mono,
  fontSize: 9.5,
  letterSpacing: "0.14em",
  textTransform: "uppercase",
  color: theme.faint,
  display: "block",
  marginBottom: 5,
};

const field: React.CSSProperties = {
  width: "100%",
  fontSize: 13,
  color: theme.text,
  background: theme.ground,
  border: `1px solid ${theme.edge}`,
  borderRadius: 6,
  padding: "8px 10px",
  outline: "none",
  boxSizing: "border-box",
};

const help: React.CSSProperties = { fontSize: 11.5, color: theme.faint, marginTop: 5, lineHeight: 1.5 };
const mono12: React.CSSProperties = { fontFamily: theme.mono, fontSize: 12 };
const errorText: React.CSSProperties = { fontFamily: theme.mono, fontSize: 11.5, color: theme.waiting, lineHeight: 1.5 };

const buttonStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  fontSize: 12.5,
  fontWeight: 600,
  color: theme.text,
  background: theme.raised,
  border: `1px solid ${theme.edge}`,
  borderRadius: 6,
  padding: "5px 12px",
  cursor: "pointer",
};

function iconButton(disabled: boolean): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "none",
    border: `1px solid ${theme.edge}`,
    borderRadius: 5,
    color: theme.dim,
    padding: 5,
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.4 : 1,
  };
}

function Badge({ text, color, title }: { text: string; color: string; title?: string }) {
  return (
    <span
      title={title}
      style={{
        fontSize: 10,
        fontWeight: 700,
        textTransform: "uppercase",
        letterSpacing: "0.04em",
        padding: "1px 6px",
        borderRadius: 4,
        color,
        background: alpha(color, 0x1f),
        whiteSpace: "nowrap",
      }}
    >
      {text}
    </span>
  );
}

// ── Schedules table ─────────────────────────────────────────────────────────

export interface SchedulesTableProps {
  schedules: PersonaSchedule[];
  now: Date;
  /** Pins absolute times to one zone (tests); the viewer's zone otherwise. */
  timeZone?: string;
  /** The schedule an action is in flight for. */
  busyId?: string | null;
  /** The schedule whose delete is awaiting confirmation. */
  confirmDeleteId?: string | null;
  /** An action's error, shown under its row. */
  rowErrors?: Record<string, string>;
  onToggle(schedule: PersonaSchedule): void;
  onRunNow(schedule: PersonaSchedule): void;
  onEdit(schedule: PersonaSchedule): void;
  onShowRuns(schedule: PersonaSchedule): void;
  onDelete(schedule: PersonaSchedule): void;
  onConfirmDelete(schedule: PersonaSchedule): void;
  onCancelDelete(): void;
  /** Rows show without their switch or edit actions (the host viewing another user's schedules). */
  readOnly?: boolean;
}

/** Every schedule with its cadence, next and last run, an enabled switch and its actions. */
export function SchedulesTable({
  schedules,
  now,
  timeZone,
  busyId,
  confirmDeleteId,
  rowErrors = {},
  onToggle,
  onRunNow,
  onEdit,
  onShowRuns,
  onDelete,
  onConfirmDelete,
  onCancelDelete,
  readOnly = false,
}: SchedulesTableProps) {
  if (schedules.length === 0) {
    return (
      <div style={{ padding: "14px 16px", fontSize: 12.5, color: theme.faint }}>
        {readOnly
          ? "No schedules."
          : `No schedules yet. Create one here, or ask Persona to set one up ("every weekday at 9, triage my asks").`}
      </div>
    );
  }
  return (
    <table style={{ width: "100%", borderCollapse: "collapse" }}>
      <thead>
        <tr>
          <th style={th}>Schedule</th>
          <th style={th}>Cadence</th>
          <th style={th}>Next run</th>
          <th style={th}>Last run</th>
          <th style={th}>Enabled</th>
          <th style={{ ...th, textAlign: "right" }}>Actions</th>
        </tr>
      </thead>
      <tbody>
        {schedules.map((s) => {
          const busy = busyId === s.id;
          const next = nextRunLabel(s, now, timeZone);
          const badge = s.lastOutcome ? outcomeBadge(s.lastOutcome) : null;
          const error = rowErrors[s.id];
          const end = describeScheduleEnd(s);
          const ended = Boolean(s.endedAt);
          const switchLabel = ended ? "ended" : s.enabled ? "on" : "paused";
          return (
            <tr key={s.id} data-schedule-id={s.id} style={{ opacity: busy ? 0.6 : 1 }}>
              <td style={td}>
                <div style={{ color: theme.text, fontWeight: 600, overflowWrap: "anywhere" }}>{s.title}</div>
                <div style={{ fontSize: 11, color: theme.faint, marginTop: 2 }}>
                  {KIND_LABELS[s.kind]}
                  {s.createdBy === "persona" ? " · set up by Persona" : ""}
                </div>
                {error && <div style={{ ...errorText, marginTop: 4 }}>{error}</div>}
              </td>
              <td style={td}>
                <div style={{ color: theme.text }}>{cadenceLabel(s, now)}</div>
                <div style={{ ...mono12, fontSize: 11, color: theme.faint, marginTop: 2 }}>{s.cron}</div>
                {end && (
                  <div data-schedule-end style={{ fontSize: 11.5, color: ended ? theme.stalled : theme.dim, marginTop: 3 }}>
                    {end}
                  </div>
                )}
              </td>
              <td style={{ ...td, whiteSpace: "nowrap" }}>
                <div style={{ color: s.enabled && s.nextRunAt ? theme.text : theme.faint }}>{next.primary}</div>
                {next.secondary && <div style={{ fontSize: 11, color: theme.faint, marginTop: 2 }}>{next.secondary}</div>}
              </td>
              <td style={{ ...td, whiteSpace: "nowrap" }}>
                {s.lastRunAt ? (
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    {badge && (
                      <Badge text={badge.label} color={TONE_COLORS[badge.tone]} title={s.lastOutcomeDetail ?? badge.label} />
                    )}
                    <span title={absoluteTime(s.lastRunAt, timeZone)} style={{ fontSize: 11.5 }}>
                      {relativeTime(s.lastRunAt, now)}
                    </span>
                  </div>
                ) : (
                  <span style={{ color: theme.faint }}>never</span>
                )}
              </td>
              <td style={td}>
                <button
                  type="button"
                  role="switch"
                  aria-checked={s.enabled}
                  aria-label={ended ? `${s.title} has ended` : `${s.enabled ? "Pause" : "Resume"} ${s.title}`}
                  title={
                    ended
                      ? "Ended: edit its end time or run limit to run it again"
                      : readOnly
                        ? s.enabled
                          ? "Enabled"
                          : "Paused"
                        : s.enabled
                          ? "Enabled: click to pause"
                          : "Paused: click to resume"
                  }
                  disabled={busy || readOnly || ended}
                  onClick={() => onToggle(s)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    background: "none",
                    border: `1px solid ${ended ? theme.stalled : s.enabled ? theme.checkpoint : theme.edge}`,
                    borderRadius: 5,
                    padding: "4px 9px",
                    cursor: busy || readOnly || ended ? "default" : "pointer",
                    fontSize: 11.5,
                    fontFamily: theme.mono,
                    color: ended ? theme.stalled : s.enabled ? theme.checkpoint : theme.faint,
                  }}
                >
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: "50%",
                      background: ended ? theme.stalled : s.enabled ? theme.checkpoint : theme.faint,
                    }}
                  />
                  {switchLabel}
                </button>
              </td>
              <td style={{ ...td, textAlign: "right" }}>
                {readOnly ? (
                  <button
                    type="button"
                    onClick={() => onShowRuns(s)}
                    title="Run history"
                    aria-label={`Run history of ${s.title}`}
                    style={iconButton(false)}
                  >
                    <LuHistory size={14} />
                  </button>
                ) : confirmDeleteId === s.id ? (
                  <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                    <span style={{ fontSize: 12, color: theme.dim }}>Delete this schedule?</span>
                    <button
                      type="button"
                      onClick={() => onDelete(s)}
                      disabled={busy}
                      style={{
                        fontSize: 12,
                        fontWeight: 600,
                        color: theme.ground,
                        background: theme.waiting,
                        border: "none",
                        borderRadius: 5,
                        padding: "5px 10px",
                        cursor: "pointer",
                      }}
                    >
                      Delete
                    </button>
                    <button
                      type="button"
                      onClick={onCancelDelete}
                      style={{ fontSize: 12, color: theme.dim, background: "none", border: "none", cursor: "pointer" }}
                    >
                      Keep
                    </button>
                  </span>
                ) : (
                  <span style={{ display: "inline-flex", gap: 6 }}>
                    <button
                      type="button"
                      onClick={() => onToggle(s)}
                      disabled={busy || ended}
                      title={ended ? "Ended: edit its end to run it again" : s.enabled ? "Pause" : "Resume"}
                      aria-label={ended ? `${s.title} has ended` : s.enabled ? `Pause ${s.title}` : `Resume ${s.title}`}
                      style={iconButton(busy || ended)}
                    >
                      {s.enabled ? <LuPause size={14} /> : <LuPlay size={14} />}
                    </button>
                    <button
                      type="button"
                      onClick={() => onRunNow(s)}
                      disabled={busy}
                      title="Run now"
                      aria-label={`Run ${s.title} now`}
                      style={iconButton(busy)}
                    >
                      <LuZap size={14} />
                    </button>
                    <button
                      type="button"
                      onClick={() => onEdit(s)}
                      disabled={busy}
                      title="Edit"
                      aria-label={`Edit ${s.title}`}
                      style={iconButton(busy)}
                    >
                      <LuPencil size={14} />
                    </button>
                    <button
                      type="button"
                      onClick={() => onShowRuns(s)}
                      title="Run history"
                      aria-label={`Run history of ${s.title}`}
                      style={iconButton(false)}
                    >
                      <LuHistory size={14} />
                    </button>
                    <button
                      type="button"
                      onClick={() => onConfirmDelete(s)}
                      disabled={busy}
                      title="Delete"
                      aria-label={`Delete ${s.title}`}
                      style={iconButton(busy)}
                    >
                      <LuTrash2 size={14} />
                    </button>
                  </span>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ── One-time wakeups ────────────────────────────────────────────────────────

export function WakeupsSection({
  wakeups,
  now,
  timeZone,
  threadName,
}: {
  wakeups: PersonaWakeupSummary[];
  now: Date;
  timeZone?: string;
  /** A thread's display name. */
  threadName(threadId: string | undefined): string;
}) {
  return (
    <section>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <LuAlarmClock size={15} color={theme.accent} />
        <h3 style={{ fontSize: 14, fontWeight: 700, color: theme.text, margin: 0 }}>One-time wakeups</h3>
      </div>
      <div style={{ ...help, marginTop: 0, marginBottom: 10 }}>
        Reminders Persona set for itself with schedule_wakeup. Each fires once in the thread that set it.
      </div>
      <div style={{ border: `1px solid ${theme.edge}`, borderRadius: 8, overflow: "hidden", background: theme.surface }}>
        {wakeups.length === 0 ? (
          <div style={{ padding: "14px 16px", fontSize: 12.5, color: theme.faint }}>No pending wakeups.</div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th}>Note</th>
                <th style={th}>Due</th>
                <th style={th}>Thread</th>
              </tr>
            </thead>
            <tbody>
              {wakeups.map((w) => (
                <tr key={w.id}>
                  <td style={{ ...td, color: theme.text, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{w.note}</td>
                  <td style={{ ...td, whiteSpace: "nowrap" }}>
                    {w.at ? (
                      <>
                        <div style={{ color: theme.text }}>{absoluteTime(w.at, timeZone)}</div>
                        <div style={{ fontSize: 11, color: theme.faint, marginTop: 2 }}>{relativeTime(w.at, now)}</div>
                      </>
                    ) : (
                      "now"
                    )}
                  </td>
                  <td style={{ ...td, whiteSpace: "nowrap" }}>{threadName(w.threadId)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

// ── Editor modal ────────────────────────────────────────────────────────────

export function ScheduleEditor({
  form,
  defaultTimezone,
  projects,
  error,
  busy,
  onChange,
  onSave,
  onCancel,
}: {
  form: ScheduleForm;
  defaultTimezone: string;
  projects: Pick<ProjectWithCounts, "id" | "name" | "reserved">[];
  error: string | null;
  busy: boolean;
  onChange(next: ScheduleForm): void;
  onSave(): void;
  onCancel(): void;
}) {
  const set = <K extends keyof ScheduleForm>(key: K, value: ScheduleForm[K]) => onChange({ ...form, [key]: value });
  const zones = useMemo(() => timezoneOptions(form.timezone, defaultTimezone), [form.timezone, defaultTimezone]);
  const preview = form.cron.trim().split(/\s+/).length === 5 && form.timezone.trim() ? cadenceLabel(form) : null;
  const creating = form.id === null;

  return (
    <div
      onClick={onCancel}
      style={{
        position: "fixed",
        inset: 0,
        background: alpha(theme.scrim, 0.55),
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "8vh",
        zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={creating ? "New schedule" : `Edit ${form.title}`}
        style={{
          width: "min(620px, 94vw)",
          maxHeight: "86vh",
          overflowY: "auto",
          background: theme.surface,
          border: `1px solid ${theme.edge}`,
          borderRadius: 10,
          padding: "18px 22px 22px",
          boxShadow: `0 18px 48px ${alpha(theme.shadow, 0.45)}`,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 18 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: theme.text }}>{creating ? "New schedule" : "Edit schedule"}</div>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            onClick={onCancel}
            aria-label="Close editor"
            style={{ background: "none", border: "none", color: theme.faint, cursor: "pointer", display: "flex", padding: 4 }}
          >
            <LuX size={15} />
          </button>
        </div>

        <div style={{ display: "grid", gap: 16 }}>
          <div>
            <span style={label}>Title</span>
            <input
              value={form.title}
              onChange={(e) => set("title", e.target.value)}
              placeholder="e.g. Morning triage"
              style={field}
            />
          </div>

          <div>
            <span style={label}>Kind</span>
            <select
              value={form.kind}
              onChange={(e) => set("kind", e.target.value as ScheduleKind)}
              disabled={!creating}
              style={{ ...field, ...mono12, cursor: creating ? "pointer" : "default", opacity: creating ? 1 : 0.6 }}
            >
              {(Object.keys(KIND_LABELS) as ScheduleKind[]).map((k) => (
                <option key={k} value={k} style={{ background: theme.raised }}>
                  {KIND_LABELS[k]}
                </option>
              ))}
            </select>
            <div style={help}>
              {creating
                ? "Wake Persona with a note, or launch a worker with a stored brief."
                : "A schedule's kind is fixed; create a new one to change it."}
            </div>
          </div>

          <div style={{ display: "flex", gap: 12 }}>
            <div style={{ flex: 1 }}>
              <span style={label}>Cron</span>
              <input
                value={form.cron}
                onChange={(e) => set("cron", e.target.value)}
                placeholder="0 9 * * 1-5"
                style={{ ...field, ...mono12 }}
              />
            </div>
            <div style={{ flex: 1 }}>
              <span style={label}>Timezone</span>
              <input
                value={form.timezone}
                onChange={(e) => set("timezone", e.target.value)}
                list="schedule-timezones"
                placeholder={defaultTimezone}
                style={{ ...field, ...mono12 }}
              />
              <datalist id="schedule-timezones">
                {zones.map((z) => (
                  <option key={z} value={z} />
                ))}
              </datalist>
            </div>
          </div>
          <div style={{ ...help, marginTop: -10 }}>
            {preview ? `Runs: ${preview}` : "Five fields: minute hour day-of-month month day-of-week."}
          </div>

          {form.kind === "wake_persona" ? (
            <div>
              <span style={label}>Note</span>
              <textarea
                value={form.note}
                onChange={(e) => set("note", e.target.value)}
                rows={4}
                placeholder="What Persona should do when it wakes, e.g. triage the overnight asks and summarize them for me"
                style={{ ...field, resize: "vertical", fontFamily: theme.sans }}
              />
            </div>
          ) : (
            <>
              <div>
                <span style={label}>Brief</span>
                <textarea
                  value={form.brief}
                  onChange={(e) => set("brief", e.target.value)}
                  rows={6}
                  placeholder="The task the launched worker starts from"
                  style={{ ...field, resize: "vertical", fontFamily: theme.sans }}
                />
              </div>
              <div style={{ display: "flex", gap: 12 }}>
                <div style={{ flex: 2 }}>
                  <span style={label}>Project</span>
                  <select
                    value={form.projectId}
                    onChange={(e) => set("projectId", e.target.value)}
                    style={{ ...field, ...mono12, cursor: "pointer" }}
                  >
                    <option value="" style={{ background: theme.raised }}>
                      (Persona picks)
                    </option>
                    {projects
                      .filter((p) => !p.reserved || p.id === form.projectId)
                      .map((p) => (
                        <option key={p.id} value={p.id} style={{ background: theme.raised }}>
                          {p.name}
                        </option>
                      ))}
                  </select>
                </div>
                <div style={{ flex: 1 }}>
                  <span style={label}>Model</span>
                  <input
                    value={form.model}
                    onChange={(e) => set("model", e.target.value)}
                    placeholder="default"
                    style={{ ...field, ...mono12 }}
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <span style={label}>Effort</span>
                  <input
                    value={form.effort}
                    onChange={(e) => set("effort", e.target.value)}
                    placeholder="default"
                    style={{ ...field, ...mono12 }}
                  />
                </div>
              </div>
            </>
          )}

          <div style={{ display: "flex", gap: 12 }}>
            <div style={{ flex: 1 }}>
              <span style={label}>Overlap</span>
              <select
                value={form.overlap}
                onChange={(e) => set("overlap", e.target.value as ScheduleOverlapPolicy)}
                style={{ ...field, cursor: "pointer" }}
              >
                {(Object.keys(OVERLAP_LABELS) as ScheduleOverlapPolicy[]).map((k) => (
                  <option key={k} value={k} style={{ background: theme.raised }}>
                    {OVERLAP_LABELS[k]}
                  </option>
                ))}
              </select>
            </div>
            <div style={{ flex: 1 }}>
              <span style={label}>After downtime</span>
              <select
                value={form.catchUp}
                onChange={(e) => set("catchUp", e.target.value as ScheduleCatchUpPolicy)}
                style={{ ...field, cursor: "pointer" }}
              >
                {(Object.keys(CATCH_UP_LABELS) as ScheduleCatchUpPolicy[]).map((k) => (
                  <option key={k} value={k} style={{ background: theme.raised }}>
                    {CATCH_UP_LABELS[k]}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div style={{ display: "flex", gap: 12 }}>
            <div style={{ flex: 2 }}>
              <span style={label}>Ends at</span>
              <input
                type="datetime-local"
                aria-label="Ends at"
                value={form.endsAt}
                onChange={(e) => set("endsAt", e.target.value)}
                style={{ ...field, ...mono12, colorScheme: theme.colorScheme }}
              />
            </div>
            <div style={{ flex: 1 }}>
              <span style={label}>Max runs</span>
              <input
                inputMode="numeric"
                aria-label="Max runs"
                value={form.maxRuns}
                onChange={(e) => set("maxRuns", e.target.value)}
                placeholder="no limit"
                style={{ ...field, ...mono12 }}
              />
            </div>
          </div>
          <div style={{ ...help, marginTop: -10 }}>
            Optional. No run fires after the end time, catch-up included; a new end time is read in{" "}
            {form.timezone.trim() || defaultTimezone}. Max runs counts runs that started, Run now included. Whichever comes
            first ends it — kept, with its history. Blank: runs until deleted.
          </div>
        </div>

        {error && <div style={{ ...errorText, marginTop: 14 }}>{error}</div>}

        <div style={{ display: "flex", gap: 8, marginTop: 18, alignItems: "center" }}>
          <button
            type="button"
            onClick={onSave}
            disabled={busy}
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: theme.ground,
              background: theme.checkpoint,
              border: "none",
              borderRadius: 6,
              padding: "9px 18px",
              cursor: busy ? "not-allowed" : "pointer",
              opacity: busy ? 0.5 : 1,
            }}
          >
            {busy ? "Saving…" : creating ? "Create schedule" : "Save changes"}
          </button>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            style={{
              fontSize: 13,
              color: theme.dim,
              background: "none",
              border: `1px solid ${theme.edge}`,
              borderRadius: 6,
              padding: "9px 16px",
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Run history drawer ──────────────────────────────────────────────────────

export function RunsDrawer({
  schedule,
  runs,
  loading,
  error,
  now,
  timeZone,
  onClose,
}: {
  schedule: PersonaSchedule;
  runs: ScheduleRunDetail[];
  loading: boolean;
  error: string | null;
  now: Date;
  timeZone?: string;
  onClose(): void;
}) {
  const end = describeScheduleEnd(schedule);
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: alpha(theme.scrim, 0.35), zIndex: 1000 }}>
      <aside
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={`Run history of ${schedule.title}`}
        style={{
          position: "absolute",
          top: 0,
          right: 0,
          bottom: 0,
          width: "min(520px, 96vw)",
          background: theme.surface,
          borderLeft: `1px solid ${theme.edge}`,
          boxShadow: `-12px 0 36px ${alpha(theme.shadow, 0.4)}`,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "14px 16px", borderBottom: `1px solid ${theme.edge}` }}>
          <LuHistory size={15} color={theme.accent} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: theme.text, overflowWrap: "anywhere" }}>{schedule.title}</div>
            <div style={{ fontSize: 11.5, color: theme.faint }}>{cadenceLabel(schedule, now)}</div>
            {end && <div style={{ fontSize: 11.5, color: schedule.endedAt ? theme.stalled : theme.faint }}>{end}</div>}
          </div>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            onClick={onClose}
            aria-label="Close run history"
            style={{ background: "none", border: "none", color: theme.faint, cursor: "pointer", display: "flex", padding: 4 }}
          >
            <LuX size={15} />
          </button>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "8px 16px 16px" }}>
          {error && <div style={{ ...errorText, margin: "8px 0" }}>{error}</div>}
          {loading && runs.length === 0 && <div style={{ fontSize: 12.5, color: theme.faint, padding: "8px 0" }}>Loading…</div>}
          {!loading && !error && runs.length === 0 && (
            <div style={{ fontSize: 12.5, color: theme.faint, padding: "8px 0" }}>No runs yet.</div>
          )}
          {runs.map((run) => {
            const badge = outcomeBadge(run.status);
            const detail = runDetail(run);
            const links = runLinks(run);
            return (
              <div key={run.id} style={{ padding: "10px 0", borderBottom: `1px solid ${theme.edgeSoft}` }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <Badge text={badge.label} color={TONE_COLORS[badge.tone]} />
                  <span style={{ fontSize: 11.5, color: theme.dim }}>{TRIGGER_LABELS[run.trigger]}</span>
                  <span style={{ flex: 1 }} />
                  <span title={absoluteTime(run.startedAt, timeZone)} style={{ fontSize: 11.5, color: theme.faint }}>
                    {relativeTime(run.startedAt, now)}
                  </span>
                </div>
                <div style={{ fontSize: 11.5, color: theme.faint, marginTop: 4 }}>
                  Started {absoluteTime(run.startedAt, timeZone)}
                  {run.endedAt ? ` · ended ${absoluteTime(run.endedAt, timeZone)}` : ""}
                </div>
                {detail && (
                  <div
                    style={{
                      fontSize: 12,
                      color: run.error ? theme.waiting : theme.dim,
                      marginTop: 4,
                      whiteSpace: "pre-wrap",
                      overflowWrap: "anywhere",
                    }}
                  >
                    {detail}
                  </div>
                )}
                {links.length > 0 && (
                  <div style={{ display: "flex", gap: 12, marginTop: 6, flexWrap: "wrap" }}>
                    {links.map((l) => (
                      <Link key={l.label} to={l.to} style={{ fontSize: 12, color: theme.running, textDecoration: "none" }}>
                        {l.label} →
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </aside>
    </div>
  );
}

// ── Page ────────────────────────────────────────────────────────────────────

/**
 * Persona's recurring schedules and pending one-shot wakeups. Self-fetches
 * `/api/persona/schedules`, refetches on every `persona:schedule` frame
 * (`signal`), and keeps a slow backstop poll for the wakeups, which no frame
 * announces. When this browser can't direct the viewer's Persona (the shared
 * state says it can't write, or a read or write here was refused `sign-in`),
 * the page shows the same sign-in banner as the Persona view and hides every
 * create and edit control; a host's refusal also raises the console's owner
 * sign-in notice through the shared fetch watcher.
 *
 * `?user=<alias>` in the page URL is the host's read-only view of that user's
 * schedules: the reads carry it and every edit action is hidden.
 */
export function SchedulesView({
  persona,
  projects,
  threads,
  consoleThreadId,
  signal,
}: {
  /** The shared Persona state, for whether this browser may change the viewer's schedules. */
  persona: PersonaViewState;
  projects: ProjectWithCounts[];
  threads: PersonaThreadSummary[];
  consoleThreadId: string | null;
  /** Bumped on every persona:schedule frame. */
  signal: number;
}) {
  const [schedules, setSchedules] = useState<PersonaSchedule[]>([]);
  const [wakeups, setWakeups] = useState<PersonaWakeupSummary[]>([]);
  const [defaultTimezone, setDefaultTimezone] = useState("UTC");
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());

  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const [editing, setEditing] = useState<ScheduleForm | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [runsFor, setRunsFor] = useState<string | null>(null);
  const [runs, setRuns] = useState<ScheduleRunDetail[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [runsError, setRunsError] = useState<string | null>(null);

  const [searchParams] = useSearchParams();
  const viewUser = searchParams.get("user")?.trim() || null;
  const { currentUser } = usePresence();
  const [refusedSignIn, setRefusedSignIn] = useState(false);
  const access = scheduleAccess(persona, currentUser, viewUser, refusedSignIn);
  const readOnly = !access.canWrite;
  const { hostAlias } = callerFields(persona.state);
  /** Notes a write refused `sign-in`, which turns the page read-only with the sign-in banner. */
  const noteRefusal = (result: { reason?: string }) => {
    if (result.reason === "sign-in") setRefusedSignIn(true);
  };

  const load = useCallback(async () => {
    const result = await fetchSchedules(fetch, viewUser);
    setNow(new Date());
    if (result.ok && result.data) {
      setSchedules(result.data.schedules);
      setWakeups(result.data.wakeups);
      setDefaultTimezone(result.data.defaultTimezone);
      setLoadError(null);
    } else if (result.reason === "sign-in") {
      // The sign-in banner says why; an error line would repeat it.
      setRefusedSignIn(true);
      setLoadError(null);
    } else {
      setLoadError(result.error ?? "Couldn't load schedules.");
    }
    setLoaded(true);
  }, [viewUser]);

  const loadRuns = useCallback(
    async (id: string) => {
      setRunsLoading(true);
      const result = await fetchScheduleRuns(id, fetch, viewUser);
      if (result.ok && result.data) {
        setRuns(result.data.runs);
        setRunsError(null);
      } else {
        setRunsError(result.error ?? "Couldn't load the run history.");
      }
      setRunsLoading(false);
    },
    [viewUser]
  );

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), BACKSTOP_MS);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    if (signal === 0) return;
    void load();
    if (runsFor) void loadRuns(runsFor);
  }, [signal, load, loadRuns, runsFor]);

  useEffect(() => {
    if (!editing && !runsFor) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setEditing(null);
      setRunsFor(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing, runsFor]);

  const setRowError = (id: string, error: string | undefined) =>
    setRowErrors((prev) => {
      const next = { ...prev };
      if (error) next[id] = error;
      else delete next[id];
      return next;
    });

  /** Runs one row action, holding the row busy and showing its error under it. */
  const rowAction = async (id: string, action: () => Promise<{ ok: boolean; error?: string; reason?: string }>) => {
    if (busyId) return;
    setBusyId(id);
    setRowError(id, undefined);
    try {
      const result = await action();
      if (!result.ok) {
        setRowError(id, result.error ?? "Request failed");
        noteRefusal(result);
      }
      await load();
    } finally {
      setBusyId(null);
    }
  };

  const threadName = useCallback(
    (threadId: string | undefined) => {
      if (!threadId || threadId === consoleThreadId) return "Console";
      const thread = threads.find((t) => t.id === threadId);
      return thread ? threadLabel(thread) : threadId.slice(0, 8);
    },
    [threads, consoleThreadId]
  );

  async function save() {
    if (!editing || saving) return;
    const invalid = validateScheduleForm(editing);
    if (invalid) {
      setFormError(invalid);
      return;
    }
    const original = editing.id ? schedules.find((s) => s.id === editing.id) : undefined;
    if (editing.id && !original) {
      setFormError("This schedule no longer exists.");
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const result = original
        ? await updateSchedule(original.id, formToUpdateRequest(editing, original))
        : await createSchedule(formToCreateRequest(editing));
      if (!result.ok) {
        setFormError(result.error ?? "Save failed");
        noteRefusal(result);
        return;
      }
      setEditing(null);
      await load();
    } finally {
      setSaving(false);
    }
  }

  const runsSchedule = runsFor ? schedules.find((s) => s.id === runsFor) : undefined;

  return (
    <div style={{ height: "100%", overflowY: "auto", padding: "20px 24px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 6 }}>
        <LuCalendarClock size={17} color={theme.accent} />
        <h2 style={{ fontSize: 17, fontWeight: 700, color: theme.text, margin: 0 }}>Schedules</h2>
        <div style={{ flex: 1 }} />
        <button type="button" onClick={() => void load()} style={buttonStyle}>
          Refresh
        </button>
        {!readOnly && (
          <button
            type="button"
            onClick={() => {
              setEditing(blankScheduleForm(defaultTimezone));
              setFormError(null);
            }}
            style={{ ...buttonStyle, color: theme.ground, background: theme.accent, border: "none" }}
          >
            <LuPlus size={14} /> New schedule
          </button>
        )}
      </div>
      {access.signInAs && (
        <div style={{ margin: "0 -24px 16px" }}>
          <PersonaSignInBanner as={access.signInAs} hostAlias={hostAlias} />
        </div>
      )}
      {viewUser !== null ? (
        <div style={{ ...help, marginTop: 0, marginBottom: 16 }}>
          Viewing <strong>{viewUser}</strong>'s schedules, read-only. <Link to="/schedules">Back to yours</Link>
        </div>
      ) : (
        <div style={{ ...help, marginTop: 0, marginBottom: 16 }}>
          Recurring jobs Persona runs for you: each either wakes Persona with a note or launches a worker with a stored
          brief. Times are read in each schedule's own timezone.
        </div>
      )}

      {loadError && <div style={{ ...errorText, marginBottom: 12 }}>{loadError}</div>}

      <SchedulesBody
        loaded={loaded}
        schedules={schedules}
        wakeups={wakeups}
        now={now}
        busyId={busyId}
        confirmDeleteId={confirmDeleteId}
        rowErrors={rowErrors}
        readOnly={readOnly}
        threadName={threadName}
        onToggle={(s) => void rowAction(s.id, () => updateSchedule(s.id, { enabled: !s.enabled }))}
        onRunNow={(s) =>
          void rowAction(s.id, async () => {
            const result = await runScheduleNow(s.id);
            if (result.ok && runsFor === s.id) void loadRuns(s.id);
            return result;
          })
        }
        onEdit={(s) => {
          setEditing(scheduleToForm(s));
          setFormError(null);
        }}
        onShowRuns={(s) => {
          setRunsFor(s.id);
          setRuns([]);
          setRunsError(null);
          void loadRuns(s.id);
        }}
        onConfirmDelete={(s) => {
          setConfirmDeleteId(s.id);
          setRowError(s.id, undefined);
        }}
        onCancelDelete={() => setConfirmDeleteId(null)}
        onDelete={(s) =>
          void rowAction(s.id, async () => {
            const result = await deleteSchedule(s.id);
            if (result.ok) setConfirmDeleteId(null);
            return result;
          })
        }
      />

      {editing && !readOnly && (
        <ScheduleEditor
          form={editing}
          defaultTimezone={defaultTimezone}
          projects={projects}
          error={formError}
          busy={saving}
          onChange={(next) => {
            setEditing(next);
            setFormError(null);
          }}
          onSave={() => void save()}
          onCancel={() => setEditing(null)}
        />
      )}

      {runsSchedule && (
        <RunsDrawer
          schedule={runsSchedule}
          runs={runs}
          loading={runsLoading}
          error={runsError}
          now={now}
          onClose={() => setRunsFor(null)}
        />
      )}
    </div>
  );
}

/** The page body: the schedules table and the one-time wakeups, from data alone. */
export function SchedulesBody({
  loaded,
  wakeups,
  threadName,
  ...table
}: SchedulesTableProps & {
  loaded: boolean;
  wakeups: PersonaWakeupSummary[];
  threadName(threadId: string | undefined): string;
}) {
  if (!loaded) return <div style={{ fontSize: 12.5, color: theme.faint }}>Loading…</div>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <div style={{ border: `1px solid ${theme.edge}`, borderRadius: 8, overflow: "hidden", background: theme.surface }}>
        <SchedulesTable {...table} />
      </div>
      <WakeupsSection wakeups={wakeups} now={table.now} timeZone={table.timeZone} threadName={threadName} />
    </div>
  );
}
