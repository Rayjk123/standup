import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { LuFileText, LuSearch } from "react-icons/lu";
import type { DocSearchHit } from "@standup/shared";
import { DOC_SEARCH_QUERY_MAX } from "@standup/shared";
import { useNarrow } from "../../hooks/useNarrow";
import { alpha, theme } from "../theme";
import { searchDocs } from "./api";
import { highlightParts, searchTerms } from "./searchText";

/** How long typing pauses before the search runs. */
export const SEARCH_DEBOUNCE_MS = 120;

/** A touch screen with no keyboard to speak of: the key hints mean nothing there. */
const TOUCH_QUERY = "(hover: none) and (pointer: coarse)";

/** The dialog's arrival: a short exponential ease-out. */
const ENTER_TIMING = { duration: 160, easing: "cubic-bezier(0.16, 1, 0.3, 1)" } as const;

const optionId = (id: string) => `docs-search-hit-${id}`;

function Key({ children }: { children: ReactNode }) {
  return (
    <kbd style={{ fontFamily: theme.mono, fontSize: 10, lineHeight: "14px", color: theme.dim, border: `1px solid ${theme.edge}`, borderRadius: 3, padding: "0 4px" }}>
      {children}
    </kbd>
  );
}

function Highlighted({ text, terms }: { text: string; terms: readonly string[] }) {
  return (
    <>
      {highlightParts(text, terms).map((part, i) =>
        part.hit ? (
          <mark key={i} style={{ background: theme.accentSoft, color: theme.accent, borderRadius: 2 }}>
            {part.text}
          </mark>
        ) : (
          <span key={i}>{part.text}</span>
        )
      )}
    </>
  );
}

/**
 * The Docs tab's search dialog: name and path matches first, then body
 * matches and docs close in meaning. ↑↓ choose a doc, Enter (or a click) opens it, Esc or a click
 * outside closes the dialog and gives the focus back to where it was. While
 * a newer query is still being searched, the last results stay listed
 * (dimmed) but Enter waits for the new ones.
 */
export function DocSearch({ onOpen, onClose }: { onOpen: (docId: string) => void; onClose: () => void }) {
  const [query, setQuery] = useState("");
  /** The latest results and the query they answer. */
  const [result, setResult] = useState<{ query: string; hits: DocSearchHit[] }>({ query: "", hits: [] });
  const [active, setActive] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // Read while rendering, before the input takes the focus.
  const [opener] = useState(() => (typeof document !== "undefined" ? (document.activeElement as HTMLElement | null) : null));
  const trimmed = query.trim();
  const { hits } = result;
  const fresh = result.query === trimmed;
  const terms = useMemo(() => searchTerms(result.query), [result.query]);
  const touch = useNarrow(TOUCH_QUERY);
  const backdropRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // The dialog drops in from just above its place; with reduced motion it only fades.
  useLayoutEffect(() => {
    const still = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    backdropRef.current?.animate?.([{ opacity: 0 }, { opacity: 1 }], ENTER_TIMING);
    dialogRef.current?.animate?.(
      still ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, transform: "translateY(-6px)" }, { opacity: 1, transform: "none" }],
      ENTER_TIMING
    );
  }, []);

  const close = () => {
    onClose();
    opener?.focus?.();
  };

  useEffect(() => {
    setError(null);
    if (!trimmed) {
      setResult({ query: "", hits: [] });
      return;
    }
    const abort = new AbortController();
    const timer = setTimeout(() => {
      searchDocs(trimmed, abort.signal)
        .then((next) => {
          if (abort.signal.aborted) return;
          setResult({ query: trimmed, hits: next });
          setActive(0);
        })
        .catch((err: unknown) => {
          if (!abort.signal.aborted) setError(err instanceof Error ? err.message : String(err));
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [trimmed]);

  const current = hits[Math.min(active, hits.length - 1)];
  useEffect(() => {
    if (current) document.getElementById(optionId(current.id))?.scrollIntoView?.({ block: "nearest" });
  }, [current]);

  // On the dialog, so Esc closes it wherever in it the focus is; the input is its only stop for Tab.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "Tab") {
      e.preventDefault();
    } else if (e.key === "ArrowDown" && hits.length) {
      e.preventDefault();
      setActive((i) => (i + 1) % hits.length);
    } else if (e.key === "ArrowUp" && hits.length) {
      e.preventDefault();
      setActive((i) => (i - 1 + hits.length) % hits.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (current && fresh) onOpen(current.id);
    }
  };

  const status = !trimmed
    ? "Type to search your docs by name, path or text."
    : error
      ? `Couldn't search: ${error}`
      : !fresh && hits.length === 0
        ? "Searching…"
        : fresh && hits.length === 0
          ? `No docs match “${trimmed}”.${terms.length > 1 ? " Try fewer words, or say it another way." : ""}`
          : null;

  return (
    <div
      ref={backdropRef}
      data-testid="docs-search-backdrop"
      onMouseDown={(e) => {
        if (e.target !== e.currentTarget) return;
        // The press itself would move the focus to the page once it is given back.
        e.preventDefault();
        close();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 50,
        display: "flex",
        justifyContent: "center",
        alignItems: "flex-start",
        paddingTop: "12vh",
        background: alpha(theme.scrim, 0.55),
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Search docs"
        data-testid="docs-search"
        onKeyDown={onKeyDown}
        // A press anywhere in the dialog leaves the focus in the input.
        onMouseDown={(e) => {
          if (!(e.target instanceof HTMLInputElement)) e.preventDefault();
        }}
        style={{
          width: "min(600px, calc(100vw - 32px))",
          maxHeight: "70vh",
          display: "flex",
          flexDirection: "column",
          background: theme.surface,
          border: `1px solid ${theme.edge}`,
          borderRadius: 10,
          boxShadow: `0 18px 48px ${alpha(theme.shadow, 0.45)}`,
          overflow: "hidden",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", borderBottom: `1px solid ${theme.edgeSoft}` }}>
          <LuSearch size={15} color={theme.faint} aria-hidden />
          <input
            autoFocus
            data-testid="docs-search-input"
            role="combobox"
            aria-label="Search docs"
            aria-expanded={hits.length > 0}
            aria-controls="docs-search-results"
            aria-activedescendant={current ? optionId(current.id) : undefined}
            aria-autocomplete="list"
            placeholder="Search docs"
            maxLength={DOC_SEARCH_QUERY_MAX}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ flex: 1, minWidth: 0, border: "none", outline: "none", background: "transparent", color: theme.text, caretColor: theme.accent, fontSize: 14 }}
          />
          {!touch && <Key>Esc</Key>}
        </div>
        <div
          id="docs-search-results"
          role="listbox"
          aria-label="Matching docs"
          aria-busy={!fresh}
          style={{ overflowY: "auto", padding: hits.length ? 4 : 0, opacity: fresh ? 1 : 0.55, transition: "opacity 120ms ease-out" }}
        >
          {hits.map((hit, i) => {
            const selected = hit === current;
            const slash = hit.path.lastIndexOf("/");
            // A doc found by meaning holds none of the query's words, so nothing in it is marked.
            const marked = hit.match === "meaning" ? [] : terms;
            return (
              <div
                key={hit.id}
                id={optionId(hit.id)}
                role="option"
                aria-selected={selected}
                data-testid="docs-search-hit"
                data-doc-id={hit.id}
                onMouseMove={() => setActive(i)}
                // mousedown, not click: the input keeps focus until the doc opens.
                onMouseDown={(e) => {
                  e.preventDefault();
                  if (e.button === 0) onOpen(hit.id);
                }}
                style={{
                  display: "flex",
                  gap: 8,
                  padding: "8px 10px",
                  borderRadius: 6,
                  cursor: "pointer",
                  background: selected ? theme.raised : "transparent",
                  boxShadow: selected ? `inset 2px 0 0 ${theme.accent}` : "none",
                }}
              >
                <LuFileText size={14} color={selected ? theme.accent : theme.faint} style={{ flexShrink: 0, marginTop: 2 }} aria-hidden />
                <div style={{ minWidth: 0, flex: 1, display: "flex", flexDirection: "column", gap: 2 }}>
                  <div style={{ fontSize: 13, color: theme.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    <Highlighted text={hit.path.slice(slash + 1)} terms={marked} />
                  </div>
                  {slash > 0 && (
                    <div style={{ fontSize: 11.5, color: theme.dim, fontFamily: theme.mono, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      <Highlighted text={hit.path.slice(0, slash)} terms={marked} />
                    </div>
                  )}
                  {hit.snippet && (
                    <div data-testid="docs-search-snippet" style={{ fontSize: 12, color: theme.dim, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      <Highlighted text={hit.snippet} terms={marked} />
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        {/* Mounted throughout, so a screen reader hears each new message. */}
        <div data-testid="docs-search-status" role="status" style={{ padding: status ? 14 : 0, fontSize: 12.5, color: error ? theme.waiting : theme.dim }}>
          {status}
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
            minHeight: 14,
            padding: "6px 12px",
            borderTop: `1px solid ${theme.edgeSoft}`,
            fontSize: 10.5,
            color: theme.dim,
          }}
        >
          <span data-testid="docs-search-count" aria-live="polite" style={{ fontVariantNumeric: "tabular-nums" }}>
            {hits.length > 0 && `Showing ${hits.length} ${hits.length === 1 ? "doc" : "docs"}`}
          </span>
          {!touch && (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4, whiteSpace: "nowrap" }}>
              <Key>↑↓</Key> to choose · <Key>Enter</Key> to open · <Key>Esc</Key> to close
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
