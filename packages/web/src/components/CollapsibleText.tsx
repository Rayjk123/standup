import { useMemo, useState } from "react";
import { theme } from "./theme";
import { Markdown } from "./Markdown";

// A message/prompt this long is treated as "huge": collapsed to a preview by
// default and rendered as plain text rather than parsed as markdown. Sized so
// an ordinary agent turn (a few paragraphs, a fenced code block) still renders
// in full as markdown, while a pasted blob (a tens-of-KB JSON report) is capped.
const DEFAULT_MAX_CHARS = 2400;
const DEFAULT_MAX_LINES = 40;

function countLines(text: string): number {
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/** First `maxLines` lines, also hard-capped at `maxChars`, whichever is shorter. */
function makePreview(text: string, maxLines: number, maxChars: number): string {
  let slice = text.length > maxChars ? text.slice(0, maxChars) : text;
  const lines = slice.split("\n");
  if (lines.length > maxLines) slice = lines.slice(0, maxLines).join("\n");
  return slice;
}

function formatSize(n: number): string {
  return n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} chars`;
}

/**
 * Renders transcript / prompt text, collapsing a very long entry to a preview.
 *
 * Normal-size text renders exactly as before — as markdown (an agent turn) or,
 * with `markdown={false}`, as inheriting plain text (a launch's task title).
 * Content past the cap defaults COLLAPSED: a plain-text (never markdown) preview
 * in a bounded box with a Show more / Show less toggle. Keeping a huge pasted
 * blob out of the markdown parser and out of one unbounded block is what stops
 * the wall-of-text lag and the pane overflow. Even expanded, the full text stays
 * in its own bounded, internally-scrollable box so a 50KB paste can't blow the
 * surrounding layout.
 */
export function CollapsibleText({
  text,
  maxChars = DEFAULT_MAX_CHARS,
  maxLines = DEFAULT_MAX_LINES,
  markdown = true,
}: {
  text: string;
  maxChars?: number;
  maxLines?: number;
  /** Render normal-size content as markdown; huge content is always plain
   *  text/pre regardless (skipping the heavy parse is the whole point). */
  markdown?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const { isHuge, preview } = useMemo(() => {
    const huge = text.length > maxChars || countLines(text) > maxLines;
    return { isHuge: huge, preview: huge ? makePreview(text, maxLines, maxChars) : "" };
  }, [text, maxChars, maxLines]);

  if (!isHuge) {
    if (markdown) {
      return (
        <div style={{ wordBreak: "break-word" }}>
          <Markdown>{text}</Markdown>
        </div>
      );
    }
    return <span style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{text}</span>;
  }

  return (
    <div>
      <pre
        style={{
          margin: 0,
          fontFamily: theme.mono,
          fontSize: 11.5,
          lineHeight: 1.5,
          color: theme.dim,
          background: theme.ground,
          border: `1px solid ${theme.edgeSoft}`,
          borderRadius: 6,
          padding: "9px 11px",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          // Even expanded, keep the block bounded: the full paste scrolls inside
          // its own box while the transcript scrolls around it.
          maxHeight: expanded ? 480 : undefined,
          overflow: expanded ? "auto" : "hidden",
        }}
      >
        {expanded ? text : `${preview}\n…`}
      </pre>
      <button
        onClick={() => setExpanded((v) => !v)}
        style={{
          marginTop: 4,
          background: "none",
          border: `1px solid ${theme.edge}`,
          borderRadius: 4,
          padding: "2px 8px",
          cursor: "pointer",
          fontFamily: theme.mono,
          fontSize: 10.5,
          color: theme.faint,
        }}
      >
        {expanded ? "Show less" : `Show more (${formatSize(text.length)})`}
      </button>
    </div>
  );
}
