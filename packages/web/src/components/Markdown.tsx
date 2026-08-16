import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { theme } from "./theme";

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
 */
export function Markdown({ children }: { children: string }) {
  return (
    <div style={{ fontSize: 13, lineHeight: 1.6, color: theme.text }}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
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
          // react-markdown v10 no longer passes `inline`; a fenced block
          // arrives wrapped in <pre>, so `pre` owns block styling and `code`
          // only styles the inline case.
          pre: ({ children }) => (
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
          ),
          code: ({ children, className }) => {
            const isBlock = !!className?.startsWith("language-");
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
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
