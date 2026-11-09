import { useEffect, useState, type ReactNode } from "react";
import { useThemeName } from "../hooks/useTheme";
import { diagramWidth, errorText, renderMermaid, type MermaidResult } from "../lib/mermaid";
import { theme } from "./theme";

/**
 * A ```mermaid block drawn as its diagram, its code (`children`, the fence as
 * the renderer would show it) hidden behind a "Show source" toggle. Until the
 * diagram is drawn the block shows as code; one that can't be drawn stays
 * code, with a note saying why. A palette switch draws the diagram again in
 * the new palette, the old drawing showing until the new one is ready.
 */
export function MermaidBlock({ source, children }: { source: string; children: ReactNode }) {
  const palette = useThemeName();
  const [drawn, setDrawn] = useState<{ source: string; result: MermaidResult }>();
  /** The source the reader opened the code of; another source opens hidden again. */
  const [sourceShownFor, setSourceShownFor] = useState<string>();
  const sourceShown = sourceShownFor === source;
  useEffect(() => {
    let live = true;
    void renderMermaid(source, palette).then((result) => live && setDrawn({ source, result }));
    return () => {
      live = false;
    };
  }, [source, palette]);

  const result = drawn?.source === source ? drawn.result : undefined;
  if (result?.kind === "svg") {
    return (
      <div data-testid="mermaid-drawn">
        <div style={{ display: "flex", justifyContent: "flex-end", margin: "0 0 4px" }}>
          <button
            type="button"
            data-testid="mermaid-source-toggle"
            aria-expanded={sourceShown}
            onClick={() => setSourceShownFor(sourceShown ? undefined : source)}
            style={{
              background: "none",
              border: `1px solid ${theme.edge}`,
              borderRadius: 4,
              padding: "2px 8px",
              fontSize: 12,
              color: theme.dim,
              cursor: "pointer",
            }}
          >
            {sourceShown ? "Hide source" : "Show source"}
          </button>
        </div>
        {sourceShown && <div data-testid="mermaid-source">{children}</div>}
        <div data-testid="mermaid-diagram" style={{ margin: "0 0 8px", overflowX: "auto" }}>
          <img
            src={result.src}
            alt="Mermaid diagram"
            width={result.width}
            height={result.height}
            style={{ width: diagramWidth(result.width), maxWidth: "none", height: "auto" }}
          />
        </div>
      </div>
    );
  }
  return (
    <div data-testid={result ? "mermaid-error" : "mermaid-pending"}>
      {children}
      {result && <div style={{ margin: "-4px 0 8px", fontSize: 12, color: theme.waiting }}>{errorText(result.message)}</div>}
    </div>
  );
}
