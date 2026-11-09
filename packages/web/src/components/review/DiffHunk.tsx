import type { CSSProperties } from "react";
import type { ReviewHunk } from "@standup/shared";
import { alpha, theme } from "../theme";

export type DiffLineKind = "add" | "del" | "meta" | "context";

/** Classifies a unified-diff line: `@@` hunk headers and `+++`/`---` file headers are meta. */
export function diffLineKind(line: string): DiffLineKind {
  if (line.startsWith("@@") || line.startsWith("+++") || line.startsWith("---")) return "meta";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "context";
}

/**
 * Added and removed lines are their status color on a faint wash of it; the
 * text keeps 4.5:1 or better on the wash over the hunk's ground in both
 * palettes (light: 6.1 and 6.2, dark: 8.3 and 5.6).
 */
const LINE_STYLES: Record<DiffLineKind, CSSProperties> = {
  add: { color: theme.done, background: alpha(theme.done, 0x17) },
  del: { color: theme.waiting, background: alpha(theme.waiting, 0x17) },
  meta: { color: theme.faint },
  context: { color: theme.text },
};

/** One diff hunk, collapsed to its file and header until opened. */
export function DiffHunk({ hunk, defaultOpen = false, narrow = false }: { hunk: ReviewHunk; defaultOpen?: boolean; narrow?: boolean }) {
  const lines = hunk.diff.replace(/\n$/, "").split("\n");
  return (
    <details
      open={defaultOpen}
      data-testid="diff-hunk"
      style={{ border: `1px solid ${theme.edge}`, borderRadius: 6, background: theme.ground, overflow: "hidden" }}
    >
      <summary
        style={{
          cursor: "pointer",
          padding: narrow ? "12px 10px" : "7px 10px",
          minHeight: narrow ? 44 : undefined,
          boxSizing: "border-box",
          fontFamily: theme.mono,
          fontSize: narrow ? 14 : 12.5,
          color: theme.text,
          background: theme.surface,
          overflowWrap: "anywhere",
        }}
      >
        <span>{hunk.file}</span>
        {hunk.header && <span style={{ color: theme.dim, marginLeft: 8 }}>{hunk.header}</span>}
      </summary>
      <pre
        style={{
          margin: 0,
          padding: "6px 0",
          overflowX: "auto",
          fontFamily: theme.mono,
          fontSize: narrow ? 13.5 : 12.5,
          lineHeight: 1.5,
        }}
      >
        <code style={{ display: "inline-block", minWidth: "100%" }}>
          {lines.map((line, i) => {
            const kind = diffLineKind(line);
            return (
              <span key={i} data-line={kind} style={{ display: "block", padding: "0 12px", whiteSpace: "pre", ...LINE_STYLES[kind] }}>
                {line || " "}
              </span>
            );
          })}
        </code>
      </pre>
    </details>
  );
}
