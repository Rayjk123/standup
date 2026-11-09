import { useState, useEffect, useRef } from "react";
import { LuCheck } from "react-icons/lu";
import type { Project, ReviewProcess } from "@standup/shared";
import { REVIEW_LENSES } from "@standup/shared";
import { alpha, theme } from "./theme";

const label: React.CSSProperties = {
  fontFamily: theme.mono, fontSize: 9.5, letterSpacing: "0.14em",
  textTransform: "uppercase", color: theme.faint, display: "block", marginBottom: 5,
};
const field: React.CSSProperties = {
  width: "100%", fontSize: 13, color: theme.text, background: theme.ground,
  border: `1px solid ${theme.edge}`, borderRadius: 6, padding: "8px 10px", outline: "none",
};

const PROCESS_HELP: Record<ReviewProcess, string> = {
  pause: "When an agent marks a ticket ready for review it just waits for you — no command, no follow-up agent.",
  command: "Runs the command below in the ticket's worktree (e.g. gh pr create). Its stdout is scanned for a pull request or code review URL, saved onto the ticket.",
  "review-agent": "Fires a short follow-up agent in the worktree to prepare the change for review following the repo's conventions (e.g. opening a pull request on its code host). Its result URL is saved onto the ticket.",
};

/**
 * Per-project review-gate + daily-review config. Modeled on ProjectEditor:
 * local state seeded from the project, one Save that PATCHes just these
 * fields through the shared onSaveProject path (which relies on the
 * projects:updated broadcast to refresh — no local project mutation here).
 */
export function ReviewSettings({
  project, onSave,
}: {
  project: Project;
  onSave: (patch: Partial<Project>) => Promise<{ error?: string }>;
}) {
  const [reviewProcess, setReviewProcess] = useState<ReviewProcess>(project.reviewProcess ?? "pause");
  const [reviewCommand, setReviewCommand] = useState(project.reviewCommand ?? "");
  const [dailyReviewActive, setDailyReviewActive] = useState(!!project.dailyReviewActive);
  // undefined reviewLenses ⇒ all lenses (the scheduler's default), so the
  // checkboxes start fully checked rather than empty.
  const [lenses, setLenses] = useState<string[]>(project.reviewLenses ?? [...REVIEW_LENSES]);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Re-seed when switching projects while this panel stays mounted, or when a
  // projects:updated broadcast lands with new values.
  useEffect(() => {
    setReviewProcess(project.reviewProcess ?? "pause");
    setReviewCommand(project.reviewCommand ?? "");
    setDailyReviewActive(!!project.dailyReviewActive);
    setLenses(project.reviewLenses ?? [...REVIEW_LENSES]);
    setSaved(false); setError(null);
  }, [project.id, project.reviewProcess, project.reviewCommand, project.dailyReviewActive, project.reviewLenses]);

  useEffect(() => () => { if (savedTimer.current) clearTimeout(savedTimer.current); }, []);

  function toggleLens(lens: string) {
    setLenses((prev) => (prev.includes(lens) ? prev.filter((l) => l !== lens) : [...prev, lens]));
  }

  async function save() {
    if (busy) return;
    setBusy(true); setError(null); setSaved(false);
    const patch: Partial<Project> = {
      reviewProcess,
      // "" clears the override on the server (body.x || undefined), matching
      // how ProjectEditor handles optional string fields.
      reviewCommand: reviewProcess === "command" ? reviewCommand.trim() : "",
      dailyReviewActive,
      reviewLenses: lenses,
    };
    try {
      const res = await onSave(patch);
      if (res.error) setError(res.error);
      else {
        setSaved(true);
        if (savedTimer.current) clearTimeout(savedTimer.current);
        savedTimer.current = setTimeout(() => setSaved(false), 2500);
      }
    } finally { setBusy(false); }
  }

  return (
    <div style={{ padding: "16px 20px 8px", maxWidth: 620 }}>
      <div style={{ fontSize: 13.5, fontWeight: 700, marginBottom: 12 }}>Review &amp; daily review</div>

      <div style={{ display: "grid", gap: 16 }}>
        <div>
          <span style={label}>Review gate — runs when an agent marks a ticket ready</span>
          <select value={reviewProcess} onChange={(e) => setReviewProcess(e.target.value as ReviewProcess)} style={field}>
            <option value="pause">Pause — wait for me</option>
            <option value="command">Run a command</option>
            <option value="review-agent">Fire a review-prep agent</option>
          </select>
          <div style={{ fontSize: 11.5, color: theme.faint, marginTop: 5, lineHeight: 1.5 }}>
            {PROCESS_HELP[reviewProcess]}
          </div>
        </div>

        {reviewProcess === "command" && (
          <div>
            <span style={label}>Review command</span>
            <textarea
              value={reviewCommand} onChange={(e) => setReviewCommand(e.target.value)} rows={2}
              placeholder="gh pr create --fill --base main"
              style={{ ...field, fontFamily: theme.mono, fontSize: 12, resize: "vertical" }}
            />
            <div style={{ fontSize: 11.5, color: theme.faint, marginTop: 5, lineHeight: 1.5 }}>
              Runs in the ticket's worktree. First URL in its stdout is saved as the ticket's review link.
            </div>
          </div>
        )}

        <label style={{ display: "flex", gap: 9, alignItems: "flex-start", cursor: "pointer" }}>
          <input
            type="checkbox" checked={dailyReviewActive}
            onChange={(e) => setDailyReviewActive(e.target.checked)}
            style={{ marginTop: 2 }}
          />
          <span>
            <span style={{ fontSize: 13, color: theme.text }}>Daily review</span>
            <div style={{ fontSize: 11.5, color: theme.faint, marginTop: 3, lineHeight: 1.5 }}>
              Once a day, fan out one read-only review agent per selected lens over this project's
              first repo; each proposes at most one ticket.
            </div>
          </span>
        </label>

        {dailyReviewActive && (
          <div>
            <span style={label}>Lenses</span>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {REVIEW_LENSES.map((lens) => {
                const on = lenses.includes(lens);
                return (
                  <button key={lens} onClick={() => toggleLens(lens)} style={{
                    fontFamily: theme.mono, fontSize: 11, fontWeight: 600,
                    borderRadius: 5, padding: "5px 10px", cursor: "pointer",
                    border: `1px solid ${on ? theme.expert : theme.edge}`,
                    background: on ? alpha(theme.expert, 0x1a) : "transparent",
                    color: on ? theme.expert : theme.faint,
                  }}>{lens}</button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {error && (
        <div style={{ fontFamily: theme.mono, fontSize: 11.5, color: theme.waiting, marginTop: 14 }}>{error}</div>
      )}
      {saved && !error && (
        <div style={{ fontFamily: theme.mono, fontSize: 11.5, color: theme.checkpoint, marginTop: 14, display: "flex", alignItems: "center", gap: 5 }}>
          <LuCheck /> Saved
        </div>
      )}

      <div style={{ marginTop: 16, borderBottom: `1px solid ${theme.edgeSoft}`, paddingBottom: 20 }}>
        <button onClick={() => void save()} disabled={busy} style={{
          fontSize: 13, fontWeight: 600, color: theme.ground, background: theme.checkpoint,
          border: "none", borderRadius: 6, padding: "9px 18px",
          cursor: busy ? "not-allowed" : "pointer", opacity: busy ? 0.5 : 1,
        }}>{busy ? "Saving…" : "Save review settings"}</button>
      </div>
    </div>
  );
}
