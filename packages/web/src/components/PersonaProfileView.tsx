import { useEffect, useState, type CSSProperties } from "react";
import { theme } from "./theme";

/**
 * What Persona knows about the signed-in owner, read-only: the profile its
 * system prompt carries every turn, by section, with how much of its budget
 * it uses and the titles of what did not fit. Self-fetches
 * GET /api/persona/profile, which answers only the owner the collector proved
 * and redacts as the prompt does. Nothing here edits the profile; the owner
 * asks Persona to remember or forget.
 */

type ProfileSection = "memory" | "feedback" | "notes" | "instructions";

interface ProfileBlock {
  section: ProfileSection;
  source?: "owner" | "auto-memory";
  heading: string;
  body: string;
  entries: number;
}

interface Omission {
  ref: string;
  section: ProfileSection;
  /** `budget`: the whole profile ran out of room; `section-cap`: the notes section's own share did. */
  reason: "budget" | "section-cap";
  title: string;
}

interface ProfileReply {
  chars: number;
  maxChars: number;
  sections: ProfileBlock[];
  omitted: Omission[];
  /** Refs of the CLAUDE.md and rules mirrors cut to fit. */
  trimmed: string[];
}

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; profile: ProfileReply }
  | { kind: "sign-in" }
  | { kind: "unavailable" }
  | { kind: "error"; message: string };

const notice: CSSProperties = { fontSize: 12.5, color: theme.dim, lineHeight: 1.5 };

/** The owner-facing name of a section; the headings themselves address Persona. */
function sectionLabel(block: ProfileBlock): string {
  switch (block.section) {
    case "memory":
      return "Memories you asked Persona to keep";
    case "feedback":
      return block.source === "auto-memory" ? "Claude Code auto-memory notes (unverified)" : "Feedback notes in your knowledge files (unverified)";
    case "notes":
      return "Notes in your knowledge files (unverified)";
    case "instructions":
      return "Your CLAUDE.md and rules";
  }
}

/** How many docs a section holds: files for CLAUDE.md and rules, else entries. */
function entryCount(block: ProfileBlock): string {
  if (block.section !== "instructions") return String(block.entries);
  return `${block.entries} ${block.entries === 1 ? "file" : "files"}`;
}

const count = (n: number) => n.toLocaleString("en-US");

// A summary keeps its list-item display, so the disclosure marker shows; the row layout lives in an inner span.
const summaryStyle: CSSProperties = {
  cursor: "pointer",
  fontSize: 13,
  fontWeight: 600,
  color: theme.text,
  padding: "8px 12px",
};

const summaryRow: CSSProperties = { display: "inline-flex", gap: 8, alignItems: "baseline", width: "calc(100% - 1.5em)" };

const bodyStyle: CSSProperties = {
  margin: 0,
  padding: "8px 12px 10px",
  borderTop: `1px solid ${theme.edge}`,
  fontFamily: theme.mono,
  fontSize: 11.5,
  lineHeight: 1.55,
  color: theme.dim,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  maxHeight: 360,
  overflowY: "auto",
};

const card: CSSProperties = { background: theme.surface, border: `1px solid ${theme.edge}`, borderRadius: 8 };

export function PersonaProfileView() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    let live = true;
    const settle = (next: LoadState) => {
      if (live) setState(next);
    };
    (async () => {
      try {
        const res = await fetch("/api/persona/profile");
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string; reason?: string };
          if (body.reason === "sign-in") return settle({ kind: "sign-in" });
          // The read gate answers 503 only when Persona is off on this collector.
          if (res.status === 503) return settle({ kind: "unavailable" });
          return settle({ kind: "error", message: body.error ?? `Couldn't load your profile (${res.status}).` });
        }
        settle({ kind: "ready", profile: (await res.json()) as ProfileReply });
      } catch {
        settle({ kind: "error", message: "Couldn't load your profile — the collector may be unreachable." });
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  const title = (
    <h3 style={{ fontSize: 13.5, fontWeight: 700, color: theme.text, margin: "0 0 4px" }}>What Persona knows about you</h3>
  );

  if (state.kind === "loading") return <div data-persona-profile="loading">{title}<div style={notice}>Loading…</div></div>;
  if (state.kind === "sign-in") {
    return (
      <div data-persona-profile="sign-in">
        {title}
        <div style={notice}>
          Sign in to the console as the owner to see what Persona knows about you. Ask the host for a sign-in link
          (<span style={{ fontFamily: theme.mono }}>bun run scripts/console-login.ts --user &lt;you&gt;</span>).
        </div>
      </div>
    );
  }
  if (state.kind === "unavailable") {
    return <div data-persona-profile="unavailable">{title}<div style={notice}>Persona is off on this collector.</div></div>;
  }
  if (state.kind === "error") {
    return <div data-persona-profile="error">{title}<div style={{ ...notice, color: theme.waiting }}>{state.message}</div></div>;
  }

  const { chars, maxChars, sections, omitted, trimmed = [] } = state.profile;
  const share = maxChars > 0 ? Math.min(1, chars / maxChars) : 0;
  const overBudget = omitted.filter((o) => o.reason === "budget");
  const capped = omitted.filter((o) => o.reason === "section-cap");
  const countStyle: CSSProperties = { fontFamily: theme.mono, fontSize: 11.5, fontWeight: 400, color: theme.faint };
  const omittedGroup = (key: string, items: Omission[], label: string, note: string, color: string) =>
    items.length > 0 && (
      <details data-persona-profile-omitted={key} style={{ ...card, borderColor: color }}>
        <summary style={summaryStyle}>
          <span style={summaryRow}>
            <span style={{ flex: 1, color }}>{label}</span>
            <span style={countStyle}>{items.length}</span>
          </span>
        </summary>
        <div style={{ ...bodyStyle, fontFamily: "inherit", fontSize: 12.5 }}>
          <div style={{ marginBottom: 6 }}>{note}</div>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {items.map((o) => (
              <li key={o.ref} title={o.ref}>{o.title}</li>
            ))}
          </ul>
        </div>
      </details>
    );
  return (
    <div data-persona-profile="ready">
      {title}
      <div style={{ ...notice, marginBottom: 10 }}>
        Read-only: the profile Persona reads every turn, redacted as it sees it. To change it, ask Persona to remember or forget something.
      </div>
      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 10, marginBottom: 10 }}>
        <div
          role="meter"
          aria-label="Profile budget used"
          aria-valuemin={0}
          aria-valuemax={maxChars}
          aria-valuenow={chars}
          aria-valuetext={`${count(chars)} of ${count(maxChars)} characters`}
          style={{ flex: "0 0 160px", height: 6, borderRadius: 3, background: theme.raised, border: `1px solid ${theme.edge}`, overflow: "hidden" }}
        >
          <div style={{ width: `${share * 100}%`, height: "100%", background: overBudget.length ? theme.stalled : theme.done }} />
        </div>
        <span data-persona-profile-usage style={{ fontFamily: theme.mono, fontSize: 11.5, color: theme.faint }}>
          {count(chars)} / {count(maxChars)} chars
          {omitted.length > 0 && <span style={{ color: overBudget.length ? theme.stalled : theme.faint }}> · {omitted.length} not shown</span>}
          {trimmed.length > 0 && <span title={trimmed.join("\n")}> · {trimmed.length} trimmed to fit</span>}
        </span>
      </div>
      {sections.length === 0 && omitted.length === 0 ? (
        <div style={{ ...notice, ...card, padding: "14px 12px" }}>Persona hasn't saved anything about you yet.</div>
      ) : (
        <div style={{ display: "grid", gap: 6 }}>
          {sections.map((block, i) => (
            <details key={`${block.section}-${i}`} data-persona-profile-section={block.section} style={card}>
              <summary style={summaryStyle} title={block.heading}>
                <span style={summaryRow}>
                  <span style={{ flex: 1 }}>{sectionLabel(block)}</span>
                  <span style={countStyle}>{entryCount(block)}</span>
                </span>
              </summary>
              <pre style={bodyStyle}>{block.body}</pre>
            </details>
          ))}
          {omittedGroup(
            "budget",
            overBudget,
            "Not shown to Persona — over budget",
            "These no longer fit in the profile's budget. Ask Persona to merge related memories to make room.",
            theme.stalled
          )}
          {omittedGroup(
            "section-cap",
            capped,
            "Notes not shown — past the notes section's share",
            "Notes in your knowledge files get a fixed share of the profile, so memories and your CLAUDE.md keep their room.",
            theme.edge
          )}
        </div>
      )}
    </div>
  );
}
