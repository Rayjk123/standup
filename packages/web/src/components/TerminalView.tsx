import { useState, type ReactNode } from "react";
import { LuArrowUp, LuChevronDown, LuChevronRight } from "react-icons/lu";
import { theme } from "./theme";
import { claudeModelLabel } from "../lib/launchOptions";
import { useStickyScroll } from "../hooks/useStickyScroll";
import { Markdown } from "./Markdown";
import { AskQuestionView } from "./AskQuestionView";
import { TranscriptReply } from "./TranscriptReply";
import type { SessionModelSettings } from "./TranscriptReply";
import { WorkingIndicator } from "./WorkingIndicator";
import { richRowTail, turnPhase } from "../lib/turnPhase";
import {
  useRichTranscript,
  type DiffHunk,
  type RichRow,
  type ToolResult,
} from "../hooks/useRichTranscript";

/**
 * A terminal-styled rendering of a session's conversation, the way Claude
 * Code's own TUI shows it: `>` user prompts, `⏺` bullets for the agent's turns
 * and tool calls, `⎿` result connectors, dimmed thinking, real structuredPatch
 * diffs, split stdout/stderr, plus the out-of-band events the card view drops —
 * compaction boundaries and mode changes.
 *
 * Reads the full-fidelity row stream from /transcript/rich (see
 * rich-transcript.ts). Not a byte-exact ANSI replay: live-only elements
 * (permission prompts, spinners, the ticking counter) are never in the
 * transcript, and subagent sub-transcripts / dollar cost are a later pass.
 */

const BULLET = "⏺";
const ELBOW = "⎿";
const GUTTER = 18;
const PREVIEW_LINES = 6;
const DIFF_PREVIEW_LINES = 16;
const MAX_OUTPUT_CHARS = 8000;

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function primaryArg(input: Record<string, unknown>): string {
  return (
    asString(input.file_path) ||
    asString(input.command) ||
    asString(input.pattern) ||
    asString(input.query) ||
    asString(input.url) ||
    asString(input.description)
  );
}

function toolHeader(name: string, input: Record<string, unknown>): string {
  if (name === "TodoWrite") return "Update Todos";
  const arg = primaryArg(input);
  return arg ? `${name}(${arg})` : name;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

/** A `[glyph][content]` row — the primitive every terminal line is built on. */
function Line({
  glyph,
  glyphColor,
  indent = 0,
  children,
  onClick,
}: {
  glyph: string;
  glyphColor: string;
  indent?: number;
  children: ReactNode;
  onClick?: () => void;
}) {
  return (
    <div
      onClick={onClick}
      style={{
        display: "flex",
        gap: 6,
        marginLeft: indent,
        cursor: onClick ? "pointer" : undefined,
      }}
    >
      <span style={{ width: GUTTER, flexShrink: 0, color: glyphColor, userSelect: "none" }}>
        {glyph}
      </span>
      <div style={{ minWidth: 0, flex: 1 }}>{children}</div>
    </div>
  );
}

function Diff({ hunks, expanded }: { hunks: DiffHunk[]; expanded: boolean }) {
  const rendered: { text: string; color: string; background: string; key: string }[] = [];
  hunks.forEach((h, hi) => {
    rendered.push({
      key: `h${hi}`,
      text: `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`,
      color: theme.running,
      background: "transparent",
    });
    h.lines.forEach((l, li) => {
      const sign = l[0];
      const color = sign === "+" ? theme.checkpoint : sign === "-" ? theme.waiting : theme.faint;
      const background =
        sign === "+"
          ? theme.termOk
          : sign === "-"
            ? theme.termErr
            : "transparent";
      rendered.push({ key: `h${hi}l${li}`, text: l, color, background });
    });
  });

  const shown = expanded ? rendered : rendered.slice(0, DIFF_PREVIEW_LINES);
  return (
    <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
      {shown.map((r) => (
        <div key={r.key} style={{ color: r.color, background: r.background }}>
          {r.text}
        </div>
      ))}
      {!expanded && rendered.length > DIFF_PREVIEW_LINES && (
        <div style={{ color: theme.faint, fontStyle: "italic" }}>
          … +{rendered.length - DIFF_PREVIEW_LINES} lines
        </div>
      )}
    </div>
  );
}

function OutputText({
  text,
  color,
  expanded,
}: {
  text: string;
  color: string;
  expanded: boolean;
}) {
  const lines = text.split("\n");
  if (!expanded && lines.length > PREVIEW_LINES) {
    return (
      <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", color }}>
        {lines.slice(0, PREVIEW_LINES).join("\n")}
        <div style={{ color: theme.faint, fontStyle: "italic" }}>
          … +{lines.length - PREVIEW_LINES} lines
        </div>
      </div>
    );
  }
  const capped =
    text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n… truncated` : text;
  return <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", color }}>{capped}</div>;
}

function TodoList({ todos }: { todos: { content?: string; status?: string }[] }) {
  return (
    <div>
      {todos.map((t, idx) => {
        const status = t.status ?? "pending";
        const glyph = status === "completed" ? "☒" : status === "in_progress" ? "▶" : "☐";
        const color =
          status === "completed"
            ? theme.checkpoint
            : status === "in_progress"
              ? theme.stalled
              : theme.dim;
        return (
          <div key={idx} style={{ color }}>
            {glyph}{" "}
            <span style={{ textDecoration: status === "completed" ? "line-through" : undefined }}>
              {t.content ?? ""}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function ToolResultView({ result, expanded }: { result: ToolResult; expanded: boolean }) {
  switch (result.kind) {
    case "diff":
      return <Diff hunks={result.hunks} expanded={expanded} />;
    case "bash": {
      const empty = !result.stdout && !result.stderr;
      return (
        <div>
          {result.stdout && (
            <OutputText text={result.stdout} color={theme.faint} expanded={expanded} />
          )}
          {result.stderr && (
            <OutputText text={result.stderr} color={theme.waiting} expanded={expanded} />
          )}
          {result.interrupted && (
            <div style={{ color: theme.stalled, fontStyle: "italic" }}>interrupted</div>
          )}
          {empty && !result.interrupted && (
            <div style={{ color: theme.faint, fontStyle: "italic" }}>(no output)</div>
          )}
        </div>
      );
    }
    case "write":
      return (
        <div style={{ color: theme.faint }}>
          Wrote {result.lineCount} lines to {result.filePath.split("/").pop() || result.filePath}
        </div>
      );
    case "read": {
      const of =
        result.totalLines && result.numLines && result.totalLines > result.numLines
          ? ` of ${result.totalLines}`
          : "";
      return (
        <div style={{ color: theme.faint }}>
          Read {result.numLines ?? "?"} lines{of}
        </div>
      );
    }
    case "todo":
      return <TodoList todos={result.todos} />;
    case "question":
      return <AskQuestionView questions={result.questions} mono />;
    case "agent":
      return (
        <div style={{ color: theme.expert }}>
          → {result.agentType ?? "agent"}
          {result.status ? ` · ${result.status}` : ""}
        </div>
      );
    case "text":
      return (
        <OutputText
          text={result.text}
          color={result.isError ? theme.waiting : theme.faint}
          expanded={expanded}
        />
      );
    case "pending":
      return <div style={{ color: theme.faint, fontStyle: "italic" }}>no result captured</div>;
  }
}

function Thinking({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <Line glyph="✻" glyphColor={theme.expert} onClick={() => setOpen((v) => !v)}>
        <span style={{ color: theme.faint, display: "inline-flex", alignItems: "center", gap: 4 }}>
          {open ? <LuChevronDown /> : <LuChevronRight />} Thinking…
        </span>
      </Line>
      {open && (
        <div
          style={{
            marginLeft: GUTTER + 6,
            marginTop: 2,
            color: theme.faint,
            fontStyle: "italic",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {text}
        </div>
      )}
    </div>
  );
}

function RowView({
  row,
  expanded,
  onToggle,
}: {
  row: RichRow;
  expanded: boolean;
  onToggle: () => void;
}) {
  switch (row.kind) {
    case "user":
      return (
        <Line glyph=">" glyphColor={theme.faint}>
          <span style={{ color: theme.text, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
            {row.text}
          </span>
          {row.sentBy && (
            <span style={{ color: theme.faint, marginLeft: 8 }}>— {row.sentBy}</span>
          )}
        </Line>
      );
    case "localCommand":
      return (
        <div>
          <Line glyph=">" glyphColor={theme.faint}>
            <span style={{ color: theme.running }}>
              {row.name}
              {row.args ? ` ${row.args}` : ""}
            </span>
          </Line>
          {row.stdout && (
            <div
              style={{
                marginLeft: GUTTER + 6,
                color: theme.faint,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {row.stdout}
            </div>
          )}
        </div>
      );
    case "taskNotification": {
      const c =
        row.status === "completed"
          ? theme.checkpoint
          : /fail|error/i.test(row.status)
            ? theme.waiting
            : theme.dim;
      return (
        <Line glyph="●" glyphColor={c}>
          <span style={{ color: theme.dim, wordBreak: "break-word" }}>{row.summary}</span>
        </Line>
      );
    }
    case "thinking":
      return <Thinking text={row.text} />;
    case "text":
      return (
        <Line glyph={BULLET} glyphColor={theme.checkpoint}>
          <div style={{ fontFamily: theme.mono }}>
            <Markdown>{row.text}</Markdown>
          </div>
        </Line>
      );
    case "tool": {
      const isError =
        (row.result.kind === "text" && row.result.isError) ||
        (row.result.kind === "bash" && !!row.result.stderr);
      return (
        <div>
          <Line
            glyph={BULLET}
            glyphColor={isError ? theme.waiting : theme.checkpoint}
            onClick={onToggle}
          >
            <span style={{ color: theme.text, wordBreak: "break-word" }}>
              {toolHeader(row.name, row.input)}
            </span>
          </Line>
          <Line glyph={ELBOW} glyphColor={theme.faint} indent={GUTTER} onClick={onToggle}>
            <ToolResultView result={row.result} expanded={expanded} />
          </Line>
        </div>
      );
    }
    case "compaction":
      return (
        <div
          style={{
            color: theme.stalled,
            borderTop: `1px dashed ${theme.edge}`,
            borderBottom: `1px dashed ${theme.edge}`,
            padding: "4px 0",
            margin: "4px 0",
          }}
        >
          ⟲ Conversation compacted ({row.trigger}): {formatTokens(row.preTokens)} →{" "}
          {formatTokens(row.postTokens)} tokens
        </div>
      );
    case "mode":
      return (
        <div style={{ color: theme.running, fontStyle: "italic" }}>— {row.label} —</div>
      );
  }
}

export function TerminalView({
  sessionId,
  sessionEnded,
  eventSignal,
  replyFocusSignal = 0,
  onReplyFocused,
  settings,
}: {
  sessionId: string;
  sessionEnded: boolean;
  eventSignal: number;
  /** Bumped by a "Jump in" to focus the reply box (spec F). */
  replyFocusSignal?: number;
  /** Called once the reply box has consumed the focus signal, so the owner
   * can reset it and avoid re-focusing on a later remount. */
  onReplyFocused?: () => void;
  /** The session's model/effort, for the reply box's switchers. */
  settings?: SessionModelSettings;
}) {
  const { page, loading, loadMore, reload } = useRichTranscript({
    sessionId,
    sessionEnded,
    eventSignal,
  });
  // Follow the tail: open on the latest output and stay pinned to the bottom as
  // it streams, unless the reader has scrolled up into history.
  const scrollRef = useStickyScroll(
    `${page?.totalRows ?? 0}:${page?.outputTokens ?? 0}:${eventSignal}`,
    sessionId
  );
  const [expandAll, setExpandAll] = useState(false);
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});

  const isExpanded = (id: string) => overrides[id] ?? expandAll;
  const toggle = (id: string) =>
    setOverrides((prev) => ({ ...prev, [id]: !isExpanded(id) }));
  const toggleExpandAll = () => {
    setExpandAll((v) => !v);
    setOverrides({});
  };

  if (loading && !page) {
    return (
      <div style={{ padding: "20px", fontFamily: theme.mono, fontSize: 12, color: theme.faint }}>
        Reading transcript…
      </div>
    );
  }

  // The newest row is what the live phase is read from — the window is a tail, so
  // its last row is the transcript's last row.
  const lastRow = page?.rows[page.rows.length - 1];
  // Whether a turn is running right now — same signal as the working indicator,
  // reused to gate the reply box's interrupt affordance.
  const tail = lastRow ? richRowTail(lastRow) : undefined;
  const working = !!turnPhase({
    tail,
    tailAt: lastRow?.timestamp,
    sessionEnded,
    now: Date.now(),
  });

  if (!page || page.totalRows === 0) {
    return (
      <div style={{ padding: "20px", fontFamily: theme.mono, fontSize: 12.5, color: theme.faint }}>
        No transcript found for this session. Standup reads Claude Code's own
        transcript file, which appears once the session has produced a turn.
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}>
      <div
        style={{
          display: "flex",
          gap: 14,
          alignItems: "center",
          padding: "8px 20px",
          fontFamily: theme.mono,
          fontSize: 10.5,
          color: theme.faint,
          borderBottom: `1px solid ${theme.edgeSoft}`,
          flexWrap: "wrap",
        }}
      >
        {page.model && <span style={{ color: theme.dim }}>{claudeModelLabel(page.model)}</span>}
        <span>{page.totalRows} rows</span>
        <span>{formatTokens(page.outputTokens)} output</span>
        <span>{formatTokens(page.contextTokens)} context</span>
        <span style={{ flex: 1 }} />
        <button
          onClick={toggleExpandAll}
          style={{
            background: "none",
            border: `1px solid ${theme.edge}`,
            borderRadius: 4,
            padding: "3px 8px",
            cursor: "pointer",
            fontFamily: theme.mono,
            fontSize: 10.5,
            color: expandAll ? theme.text : theme.faint,
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
          }}
        >
          {expandAll ? <LuChevronDown /> : <LuChevronRight />}
          {expandAll ? "collapse all" : "expand all"}
        </button>
        {page.hasMore && (
          <button
            onClick={loadMore}
            style={{
              background: "none",
              border: "none",
              padding: 0,
              cursor: "pointer",
              fontFamily: theme.mono,
              fontSize: 10.5,
              color: theme.running,
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
            }}
          >
            <LuArrowUp /> load earlier
          </button>
        )}
      </div>

      <div
        ref={scrollRef}
        style={{
          flex: 1,
          overflowY: "auto",
          minHeight: 0,
          background: theme.ground,
          fontFamily: theme.mono,
          fontSize: 12,
          lineHeight: 1.5,
          color: theme.text,
          padding: "14px 20px 18px",
        }}
      >
        {page.truncated && !page.hasMore && (
          <div style={{ color: theme.faint, fontStyle: "italic", marginBottom: 10 }}>
            — earlier history not loaded —
          </div>
        )}
        {page.rows.map((row) => (
          <div key={row.id} style={{ marginBottom: 8 }}>
            <RowView row={row} expanded={isExpanded(row.id)} onToggle={() => toggle(row.id)} />
          </div>
        ))}
      </div>

      {/* The live phase, above the reply box: the rows alone can't show movement
          between polls, so a busy session would otherwise look frozen. */}
      <WorkingIndicator
        mono
        tail={tail}
        tailAt={lastRow?.timestamp}
        sessionEnded={sessionEnded}
      />

      <TranscriptReply
        sessionId={sessionId}
        owned={page.owned}
        onSent={reload}
        working={working}
        terminal
        focusSignal={replyFocusSignal}
        onFocused={onReplyFocused}
        settings={settings}
      />
    </div>
  );
}
