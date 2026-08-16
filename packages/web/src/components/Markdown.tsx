import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

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
    <div className="text-[13px] leading-relaxed text-text">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p className="mb-2 mt-0">{children}</p>,
          h1: ({ children }) => (
            <h1 className="mb-[7px] mt-[14px] text-base font-bold">{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 className="mb-[7px] mt-[14px] text-[15px] font-bold">{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 className="mb-1.5 mt-3 text-[13.5px] font-bold">{children}</h3>
          ),
          ul: ({ children }) => <ul className="mb-2 mt-0 pl-5">{children}</ul>,
          ol: ({ children }) => <ol className="mb-2 mt-0 pl-5">{children}</ol>,
          li: ({ children }) => <li className="my-0.5">{children}</li>,
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer" className="text-running">
              {children}
            </a>
          ),
          blockquote: ({ children }) => (
            <blockquote className="mb-2 mt-0 border-l-2 border-edge pl-[11px] text-dim">
              {children}
            </blockquote>
          ),
          hr: () => <hr className="my-3 border-0 border-t border-edge-soft" />,
          // react-markdown v10 no longer passes `inline`; a fenced block
          // arrives wrapped in <pre>, so `pre` owns block styling and `code`
          // only styles the inline case.
          pre: ({ children }) => (
            <pre className="mb-2 mt-0 overflow-x-auto rounded-md border border-edge-soft bg-ground px-[11px] py-[9px] font-mono text-[11.5px] leading-relaxed">
              {children}
            </pre>
          ),
          code: ({ children, className }) => {
            const isBlock = !!className?.startsWith("language-");
            if (isBlock) {
              return <code className="font-mono">{children}</code>;
            }
            return (
              <code className="rounded-[3px] border border-edge-soft bg-ground px-1 py-px font-mono text-[11.5px]">
                {children}
              </code>
            );
          },
          // Wide tables scroll inside their own container rather than
          // stretching the message column.
          table: ({ children }) => (
            <div className="mb-2 mt-0 overflow-x-auto">
              <table className="w-full border-collapse text-xs">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="whitespace-nowrap border-b border-edge px-[9px] py-[5px] text-left font-semibold text-dim">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border-b border-edge-soft px-[9px] py-[5px] align-top">
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
