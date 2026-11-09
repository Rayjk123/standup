import { lazy, memo, Suspense, useMemo, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { theme } from "./theme";
import { markdownImage } from "../lib/markdownImage";
import { mermaidFenceSource } from "../lib/mermaidFence";

/** A diagram's code block as it stands, for when the diagram can't be drawn at all. */
function CodeOnly({ children }: { source: string; children: ReactNode }) {
  return <>{children}</>;
}

// Drawing a diagram loads only once a text has one. Until then it shows as
// code, and should the chunk fail to load it stays code.
const MermaidBlock = lazy(() =>
  import("./MermaidBlock").then(
    (m) => ({ default: m.MermaidBlock }),
    () => ({ default: CodeOnly })
  )
);

const REMARK_PLUGINS = [remarkGfm];

// react-markdown v10 no longer passes `inline`; a fenced block
// arrives wrapped in <pre>, so `pre` owns block styling and `code`
// only styles the inline case.
const CodeBlock: NonNullable<Components["pre"]> = ({ children }) => (
  <pre
    style={{
      background: theme.ground,
      border: `1px solid ${theme.edgeSoft}`,
      borderRadius: 6,
      padding: "9px 11px",
      margin: "0 0 8px",
      overflowX: "auto",
      fontFamily: theme.mono,
      fontSize: 11.5,
      lineHeight: 1.5,
    }}
  >
    {children}
  </pre>
);

/** A fenced block that draws a ```mermaid fence as its diagram (see MermaidBlock). */
const DiagramCodeBlock: NonNullable<Components["pre"]> = (props) => {
  const source = mermaidFenceSource(props.node);
  const code = <CodeBlock {...props} />;
  if (source === undefined || !source.trim()) return code;
  return (
    <Suspense fallback={code}>
      <MermaidBlock source={source}>{code}</MermaidBlock>
    </Suspense>
  );
};

/**
 * Element renderers shared by every `Markdown`. They live at module scope so
 * each element type keeps its identity across renders: react-markdown uses
 * these functions as component types, and a fresh function per render makes
 * React remount every paragraph, list item and code span — replacing the DOM
 * under any text the reader has selected.
 */
const BASE_COMPONENTS: Components = {
  p: ({ children }) => (
    <p style={{ margin: "0 0 8px" }}>{children}</p>
  ),
  h1: ({ children }) => (
    <h1 style={{ fontSize: 16, fontWeight: 700, margin: "14px 0 7px" }}>
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 style={{ fontSize: 15, fontWeight: 700, margin: "14px 0 7px" }}>
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 style={{ fontSize: 13.5, fontWeight: 700, margin: "12px 0 6px" }}>
      {children}
    </h3>
  ),
  ul: ({ children }) => (
    <ul style={{ margin: "0 0 8px", paddingLeft: 20 }}>{children}</ul>
  ),
  ol: ({ children }) => (
    <ol style={{ margin: "0 0 8px", paddingLeft: 20 }}>{children}</ol>
  ),
  li: ({ children }) => (
    <li style={{ margin: "2px 0" }}>{children}</li>
  ),
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      style={{ color: theme.running }}
    >
      {children}
    </a>
  ),
  blockquote: ({ children }) => (
    <blockquote
      style={{
        margin: "0 0 8px",
        paddingLeft: 11,
        borderLeft: `2px solid ${theme.edge}`,
        color: theme.dim,
      }}
    >
      {children}
    </blockquote>
  ),
  hr: () => (
    <hr
      style={{
        border: "none",
        borderTop: `1px solid ${theme.edgeSoft}`,
        margin: "12px 0",
      }}
    />
  ),
  pre: CodeBlock,
  code: ({ children, className }) => {
    // A fenced block is wrapped in <pre>, which owns the block styling;
    // this <code> should then be bare. Language-tagged fences carry a
    // `language-` class, but a language-less fence (```\n…\n```, common
    // for command output) has none — so also treat multi-line content
    // as a block, else it gets the inline box nested inside the <pre>.
    const text =
      typeof children === "string"
        ? children
        : Array.isArray(children)
          ? children.join("")
          : "";
    const isBlock = !!className?.startsWith("language-") || text.includes("\n");
    if (isBlock) {
      return <code style={{ fontFamily: theme.mono }}>{children}</code>;
    }
    return (
      <code
        style={{
          fontFamily: theme.mono,
          fontSize: 11.5,
          background: theme.ground,
          border: `1px solid ${theme.edgeSoft}`,
          borderRadius: 3,
          padding: "1px 4px",
        }}
      >
        {children}
      </code>
    );
  },
  // Wide tables scroll inside their own container rather than
  // stretching the message column.
  table: ({ children }) => (
    <div style={{ overflowX: "auto", margin: "0 0 8px" }}>
      <table
        style={{
          borderCollapse: "collapse",
          fontSize: 12,
          width: "100%",
        }}
      >
        {children}
      </table>
    </div>
  ),
  th: ({ children }) => (
    <th
      style={{
        textAlign: "left",
        padding: "5px 9px",
        borderBottom: `1px solid ${theme.edge}`,
        color: theme.dim,
        fontWeight: 600,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td
      style={{
        padding: "5px 9px",
        borderBottom: `1px solid ${theme.edgeSoft}`,
        verticalAlign: "top",
      }}
    >
      {children}
    </td>
  ),
};

function imageRenderer(allowRemoteImages: boolean): Components["img"] {
  return ({ src, alt }) => {
    const image = markdownImage(
      typeof src === "string" ? src : undefined,
      alt,
      allowRemoteImages
    );
    if (image.kind === "img") {
      return <img src={image.src} alt={image.alt} style={{ maxWidth: "100%" }} />;
    }
    if (image.kind === "link") {
      return (
        <a
          href={image.href}
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: theme.running }}
        >
          [{image.label}]
        </a>
      );
    }
    return <span style={{ color: theme.dim }}>[{image.label}]</span>;
  };
}

const LINKED_IMAGES = imageRenderer(false);
const INLINE_IMAGES = imageRenderer(true);

/**
 * Markdown rendering for agent output.
 *
 * Agents write markdown constantly — headings, lists, tables, fenced code —
 * and showing it as raw text makes a transcript far harder to read than the
 * terminal it came from.
 *
 * Raw HTML is deliberately not enabled (no rehype-raw). Transcript content is
 * model output and can contain anything; react-markdown escapes HTML by
 * default and that default is worth keeping.
 *
 * Images never load by default: an http(s) image renders as a link and any
 * other source as text (see `markdownImage`), so rendering agent text can't
 * make the browser fetch. `allowRemoteImages` opts a view with trusted
 * content back in to inline http(s) images.
 *
 * `diagrams` draws ```mermaid fences as their diagrams; Mermaid itself is
 * fetched only when a text has one (see lib/mermaid).
 *
 * `components` replaces individual element renderers for one caller without
 * changing them anywhere else. Pass a module-level object: a new object each
 * render re-parses the text and, with new renderer functions, remounts the
 * rendered elements.
 *
 * This module carries the whole markdown stack (react-markdown, remark-gfm,
 * micromark), so callers use `Markdown` from ./Markdown, which loads it on
 * demand.
 */
export interface MarkdownProps {
  children: string;
  components?: Components;
  allowRemoteImages?: boolean;
  diagrams?: boolean;
}

export const MarkdownRenderer = memo(function MarkdownRenderer({
  children,
  components,
  allowRemoteImages = false,
  diagrams = false,
}: MarkdownProps) {
  const merged = useMemo<Components>(
    () => ({
      ...BASE_COMPONENTS,
      img: allowRemoteImages ? INLINE_IMAGES : LINKED_IMAGES,
      ...(diagrams ? { pre: DiagramCodeBlock } : {}),
      ...components,
    }),
    [components, allowRemoteImages, diagrams]
  );
  return (
    <div style={{ fontSize: 13, lineHeight: 1.6, color: theme.text }}>
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={merged}>
        {children}
      </ReactMarkdown>
    </div>
  );
});
