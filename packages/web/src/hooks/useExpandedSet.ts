import { useState } from "react";

/**
 * Per-key expand/collapse state for lists that consolidate by default and
 * expand on demand — the child (subagent) lists in the sidebar and detail
 * pane, each keyed by its parent session id. A Set is the natural
 * shape: a key is present only while that row is expanded, so many roots track
 * their own toggle independently without a boolean per row.
 */
export interface ExpandedSet {
  /** The keys currently expanded. */
  expanded: Set<string>;
  /** Flip one key between expanded and collapsed. */
  toggle: (key: string) => void;
}

export function useExpandedSet(): ExpandedSet {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  return { expanded, toggle };
}
