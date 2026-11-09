import { useState } from "react";
import { LuChevronDown, LuChevronRight, LuFileText } from "react-icons/lu";
import type { SharedWithMe } from "@standup/shared";
import { alpha, theme } from "../theme";

/**
 * The Docs tab's "Shared with me" section under the owner's own tree: other
 * users' shareable docs, grouped by owner, each by its path in the owner's
 * tree. Hidden while nothing is shared.
 */
export function SharedWithMeList({
  shared,
  selectedDocId,
  onOpen,
}: {
  shared: SharedWithMe[];
  selectedDocId: string | null;
  onOpen: (docId: string) => void;
}) {
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set());
  if (shared.length === 0) return null;
  return (
    <section data-testid="docs-shared-with-me" aria-label="Shared with me" style={{ marginTop: 14, paddingTop: 10, borderTop: `1px solid ${theme.edgeSoft}`, fontSize: 13 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: theme.dim, textTransform: "uppercase", letterSpacing: "0.04em", padding: "0 8px 6px" }}>Shared with me</div>
      {shared.map(({ owner, docs }) => {
        const open = !closed.has(owner);
        return (
          <div key={owner}>
            <button
              type="button"
              data-testid="docs-shared-owner"
              aria-expanded={open}
              onClick={() =>
                setClosed((prev) => {
                  const next = new Set(prev);
                  if (next.has(owner)) next.delete(owner);
                  else next.add(owner);
                  return next;
                })
              }
              style={{ display: "flex", alignItems: "center", gap: 4, width: "100%", padding: "3px 6px", border: "none", background: "none", color: theme.dim, cursor: "pointer", font: "inherit" }}
            >
              {open ? <LuChevronDown size={12} /> : <LuChevronRight size={12} />}
              {owner}
            </button>
            {open &&
              docs.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  data-testid="docs-shared-doc"
                  title={`${owner}/${d.path}`}
                  onClick={() => onOpen(d.id)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    width: "100%",
                    padding: "3px 6px 3px 22px",
                    border: "none",
                    borderRadius: 4,
                    background: d.id === selectedDocId ? alpha(theme.running, 0x22) : "none",
                    color: theme.text,
                    cursor: "pointer",
                    font: "inherit",
                    textAlign: "left",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  <LuFileText size={13} style={{ flexShrink: 0, color: theme.dim }} />
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{d.path}</span>
                </button>
              ))}
          </div>
        );
      })}
    </section>
  );
}
