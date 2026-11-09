import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { DocComment, DocCommentAnchor } from "@standup/shared";
import { DOC_COMMENT_BODY_MAX, anchorAt, locateAnchor } from "@standup/shared";
import { useNarrow } from "../../hooks/useNarrow";
import { relativeTime } from "../../lib/schedules";
import { alpha, theme } from "../theme";
import { COMMENT_ARIA_SHORTCUT, COMMENT_ICON, COMMENT_LABEL, COMMENT_SHORTCUT, TOOLBAR_ICON, isCommentShortcut } from "./commentIcon";
import { leaveComment, listComments, replyToComment, resolveComment } from "./sharingApi";

/**
 * A doc's comments in a margin beside it. Each comment's passage is found
 * again in the rendered doc (`root`) on every change to either, and drawn
 * with the CSS Custom Highlight API, which marks text without touching the
 * DOM (so the owner's editor never sees it). Anyone selects text to comment
 * on it; the owner always has the margin, sees every comment, and replies to
 * or resolves any open one. Comments and replies show as plain text.
 */

/** How often the comments are re-read while the agent is replying, and otherwise. */
const POLL_PENDING_MS = 3_000;
const POLL_IDLE_MS = 20_000;
const HIGHLIGHT_ANSWERED = "doc-comment";
const HIGHLIGHT_WAITING = "doc-comment-waiting";
const HIGHLIGHT_FOCUS = "doc-comment-focus";
/** How long a clicked card's passage stays marked. */
const FOCUS_MARK_MS = 1_400;
/** The comment chip's height and its distance from the selection: the editor toolbar's 32px item with its 6px margin. */
const CHIP_SIZE = 44;
const CHIP_GAP = 8;
const MARGIN_CLASS = "doc-comments";
const CHIP_ITEM_CLASS = "doc-comment-chip-item";
const ACTION_CLASS = "doc-comment-action";
/** On the doc while a comment is being written: the editor's formatting toolbar stays out of the way. */
const COMPOSING_CLASS = "doc-commenting";
/** Node.TEXT_NODE and Node.ELEMENT_NODE. */
const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

export interface DocCommentsSummary {
  total: number;
  waiting: number;
}

/**
 * What isn't the doc's own text: the editor's UI drawn into the doc (list
 * labels, code-block tools and previews, menus). Left out of the text index,
 * so a passage reads the same in the owner's editor and a reader's view.
 * Named one by one: `[contenteditable='false']` would also take code blocks,
 * which ProseMirror marks so because their node view has no contentDOM.
 */
const NOT_DOC_TEXT = [
  "button",
  ".label-wrapper",
  ".milkdown-toolbar",
  ".milkdown-slash-menu",
  ".milkdown-code-block .tools",
  ".milkdown-code-block .preview-panel",
  ".milkdown-code-block .cm-gutters",
  ".milkdown-code-block .cm-panels",
  ".cm-announced",
  ".language-picker",
  ".milkdown-image-block .placeholder",
  ".milkdown-image-block .confirm",
  ".drag-preview",
].join(", ");

/** The doc's rendered text in `root` and where each of its text nodes starts in it. */
function textIndex(root: HTMLElement): { text: string; nodes: Array<{ node: Text; start: number }> } {
  const nodes: Array<{ node: Text; start: number }> = [];
  let text = "";
  // Document order, as textContent reads it.
  const visit = (node: Node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === TEXT_NODE) {
        nodes.push({ node: child as Text, start: text.length });
        text += (child as Text).data;
      } else if (child.nodeType === ELEMENT_NODE && !(child as Element).matches(NOT_DOC_TEXT)) visit(child);
    }
  };
  visit(root);
  return { text, nodes };
}

/** A Range over `[start, end)` of the index's text, or null. */
function rangeAt(index: ReturnType<typeof textIndex>, start: number, end: number): Range | null {
  const find = (at: number, isEnd: boolean) => {
    for (const { node, start: s } of index.nodes) {
      const e = s + node.data.length;
      if (isEnd ? at > s && at <= e : at >= s && at < e) return { node, offset: at - s };
    }
    return null;
  };
  const a = find(start, false);
  const b = find(end, true);
  if (!a || !b) return null;
  const range = document.createRange();
  range.setStart(a.node, a.offset);
  range.setEnd(b.node, b.offset);
  return range;
}

/** Where `range` falls in the index's text, or null when it isn't inside `root` or holds none of it. */
function offsetsOf(root: HTMLElement, index: ReturnType<typeof textIndex>, range: Range): { start: number; end: number } | null {
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  let start: number | null = null;
  let end: number | null = null;
  for (const { node, start: s } of index.nodes) {
    // A boundary inside an indexed text node; otherwise the first and last indexed nodes the range holds.
    if (node === range.startContainer) start = s + range.startOffset;
    else if (start === null && range.comparePoint(node, 0) === 0) start = s;
    if (node === range.endContainer) end = s + range.endOffset;
    else if (range.comparePoint(node, node.length) === 0) end = s + node.length;
  }
  return start !== null && end !== null && end > start ? { start, end } : null;
}

/**
 * Where Crepe's selection toolbar never shows: it needs ProseMirror itself
 * focused, and inside a code block CodeMirror holds the focus.
 */
const NO_EDITOR_TOOLBAR = ".milkdown-code-block";

/**
 * The passage the page's selection holds in `root`, where it is on screen,
 * and whether it is where the editor's toolbar doesn't show; null when
 * there's no text selected there.
 */
function selectedPassage(root: HTMLElement): { anchor: DocCommentAnchor; rect: DOMRect; inCode: boolean } | null {
  const sel = window.getSelection();
  const range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
  if (!range || range.collapsed) return null;
  // The doc is indexed only for a real selection, not on every keystroke.
  const index = textIndex(root);
  const at = offsetsOf(root, index, range);
  if (!at || !index.text.slice(at.start, at.end).trim()) return null;
  const container = range.commonAncestorContainer;
  const element = container.nodeType === ELEMENT_NODE ? (container as Element) : container.parentElement;
  return { anchor: anchorAt(index.text, at.start, at.end), rect: range.getBoundingClientRect(), inCode: !!element?.closest(NO_EDITOR_TOOLBAR) };
}

let stylesAdded = false;
/**
 * The highlight colours: amber for an answered passage, blue for one still
 * waiting (mock D), and a stronger amber for the passage of the card just
 * clicked. Also what inline styles can't reach in the margin: placeholders,
 * hover on the owner's text actions, and a keyboard focus ring.
 */
function addHighlightStyles(): void {
  if (stylesAdded || typeof document === "undefined") return;
  stylesAdded = true;
  const style = document.createElement("style");
  style.textContent = `
    ::highlight(${HIGHLIGHT_ANSWERED}) { background-color: ${alpha(theme.accent, 0x33)}; text-decoration: underline 2px ${theme.accent}; }
    ::highlight(${HIGHLIGHT_WAITING}) { background-color: ${alpha(theme.running, 0x22)}; text-decoration: underline 2px ${theme.running}; }
    ::highlight(${HIGHLIGHT_FOCUS}) { background-color: ${alpha(theme.accent, 0x66)}; text-decoration: underline 2px ${theme.accent}; }
    .${COMPOSING_CLASS} .milkdown .milkdown-toolbar { display: none; }
    .${CHIP_ITEM_CLASS} svg { width: 24px; height: 24px; fill: ${TOOLBAR_ICON}; }
    .${CHIP_ITEM_CLASS}:hover { background: ${theme.hover} !important; }
    .${CHIP_ITEM_CLASS}:active { background: ${theme.raised} !important; }
    .${CHIP_ITEM_CLASS}:focus-visible { outline: 2px solid ${theme.running}; outline-offset: 1px; }
    .${MARGIN_CLASS} ::placeholder { color: ${theme.dim}; }
    .${MARGIN_CLASS} .${ACTION_CLASS}:hover:not(:disabled) { color: ${theme.text}; }
    .${MARGIN_CLASS} :is(button, input, textarea):focus-visible { outline: 2px solid ${theme.running}; outline-offset: 1px; }
  `;
  document.head.appendChild(style);
}

type Highlights = { set(name: string, h: unknown): void; delete(name: string): void };
/** The page's highlight registry, where the browser has one. */
function highlightRegistry(): { registry: Highlights; make: (ranges: Range[]) => unknown } | null {
  const css = (globalThis as { CSS?: { highlights?: Highlights } }).CSS;
  const Ctor = (globalThis as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
  return css?.highlights && Ctor ? { registry: css.highlights, make: (ranges) => new Ctor(...ranges) } : null;
}

const card = {
  border: `1px solid ${theme.edge}`,
  borderRadius: 8,
  padding: "10px 12px",
  background: theme.surface,
  display: "flex",
  flexDirection: "column",
  gap: 6,
} as const;

const input = {
  flex: 1,
  minWidth: 0,
  padding: "7px 10px",
  borderRadius: 6,
  border: `1px solid ${theme.edge}`,
  background: theme.ground,
  color: theme.text,
  fontSize: 13,
  fontFamily: "inherit",
} as const;

const button = {
  padding: "4px 12px",
  borderRadius: 5,
  border: `1px solid ${theme.edge}`,
  background: "transparent",
  color: theme.text,
  fontSize: 12.5,
  cursor: "pointer",
} as const;

const primary = { ...button, background: theme.accent, borderColor: theme.accent, color: theme.ground, fontWeight: 600 } as const;

/** A text-only action: the owner's Reply, Resolve and Reopen on a card. */
const quiet = { border: "none", background: "transparent", padding: "6px 4px", margin: "-6px -4px", color: theme.dim, fontSize: 12, fontWeight: 600, cursor: "pointer" } as const;

function Tag({ state, resolved, role }: { state: DocComment["state"]; resolved: boolean; role: "owner" | "reader" }) {
  const waiting = !resolved && state === "waiting";
  const text = resolved
    ? "Resolved"
    : state === "pending"
      ? "Agent is replying…"
      : state === "answered"
        ? "Answered"
        : role === "owner"
          ? "Waiting for you"
          : "Waiting for the owner";
  return (
    <span
      data-testid="doc-comment-state"
      style={{
        marginLeft: "auto",
        flexShrink: 0,
        fontSize: 11,
        padding: "1px 6px",
        borderRadius: 8,
        border: `1px solid ${waiting ? alpha(theme.running, 0x55) : theme.edge}`,
        color: waiting ? theme.running : theme.dim,
      }}
    >
      {text}
    </span>
  );
}

/** One comment's card: who left it, its text, the replies, and the owner's Reply, Resolve or Reopen. */
function CommentCard({
  comment,
  role,
  onFocus,
  onReply,
  onResolve,
}: {
  comment: DocComment;
  role: "owner" | "reader";
  onFocus: () => void;
  onReply: (body: string) => Promise<string | null>;
  onResolve: (resolved: boolean) => Promise<string | null>;
}) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = async (run: () => Promise<string | null>) => {
    setBusy(true);
    setError(null);
    const err = await run();
    setBusy(false);
    if (err) setError(err);
    return err;
  };
  const owner = role === "owner";
  // A waiting comment is the one the owner has to answer, so its reply box is already open.
  const [replyOpen, setReplyOpen] = useState(false);
  const replying = owner && !comment.resolved && (replyOpen || (comment.state === "waiting" && !comment.byOwner));
  /** The owner sees their own name as "You"; readers see the owner's alias, marked as the owner. */
  const ownerName = (alias: string | undefined) => (owner ? "You" : alias);
  const ownerMark = owner ? "" : " · owner";
  return (
    <div data-testid="doc-comment" style={card} onClick={onFocus}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
        <span style={{ fontSize: 12, color: theme.dim, minWidth: 0, overflowWrap: "anywhere" }}>
          <b style={{ color: theme.text, fontWeight: 600 }}>{comment.byOwner ? ownerName(comment.author) : comment.author}</b>
          {comment.byOwner ? ownerMark : ""} · {relativeTime(comment.createdAt)}
        </span>
        {/* The owner's own comment waits on no one, so only its resolved state is worth a tag. */}
        {(!comment.byOwner || comment.resolved) && <Tag state={comment.state} resolved={comment.resolved} role={role} />}
      </div>
      <div style={{ color: theme.text, fontSize: 13, lineHeight: 1.45, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{comment.body}</div>
      {comment.replies.map((r) => (
        <div
          key={r.id}
          data-testid="doc-comment-reply"
          style={{ borderLeft: `2px solid ${theme.accent}`, paddingLeft: 10, color: theme.text, fontSize: 13, lineHeight: 1.45 }}
        >
          <div style={{ fontSize: 12, color: theme.dim, marginBottom: 2 }}>
            <b style={{ color: theme.text, fontWeight: 600 }}>{r.authorKind === "agent" ? "Doc agent" : ownerName(r.author)}</b>
            {r.authorKind === "agent" && r.fromDoc ? " · from the doc" : r.authorKind === "owner" ? ownerMark : ""}
          </div>
          <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{r.body}</div>
        </div>
      ))}
      {replying && (
        <form
          style={{ display: "flex", gap: 6 }}
          onClick={(e) => e.stopPropagation()}
          onSubmit={(e) => {
            e.preventDefault();
            if (!draft.trim() || busy) return;
            void act(() => onReply(draft.trim())).then((err) => {
              if (err) return;
              setDraft("");
              setReplyOpen(false);
            });
          }}
        >
          <input
            data-testid="doc-comment-reply-input"
            aria-label="Reply"
            placeholder="Reply…"
            autoFocus={replyOpen}
            value={draft}
            maxLength={DOC_COMMENT_BODY_MAX}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && !draft.trim()) setReplyOpen(false);
            }}
            style={input}
          />
          {draft.trim() && (
            <button type="submit" data-testid="doc-comment-reply-send" disabled={busy} style={primary}>
              Reply
            </button>
          )}
        </form>
      )}
      {owner && (
        // The owner's actions sit in one fixed place, as quiet links, so nothing moves under the pointer.
        <div style={{ display: "flex", gap: 14, justifyContent: "flex-end" }} onClick={(e) => e.stopPropagation()}>
          {!comment.resolved && !replying && (
            <button type="button" className={ACTION_CLASS} data-testid="doc-comment-reply-open" onClick={() => setReplyOpen(true)} style={quiet}>
              Reply
            </button>
          )}
          <button
            type="button"
            data-testid={comment.resolved ? "doc-comment-reopen" : "doc-comment-resolve"}
            disabled={busy}
            onClick={() => void act(() => onResolve(!comment.resolved))}
            className={ACTION_CLASS}
            style={quiet}
          >
            {comment.resolved ? "Reopen" : "Resolve"}
          </button>
        </div>
      )}
      {error && (
        <div role="alert" style={{ color: theme.waiting, fontSize: 12 }}>
          {error}
        </div>
      )}
    </div>
  );
}

export interface DocCommentsProps {
  docId: string;
  /** The element the doc renders into; its text is what passages are found in. */
  root: RefObject<HTMLElement | null>;
  role: "owner" | "reader";
  /** Called with the counts the pane's header shows. */
  onSummary?: (summary: DocCommentsSummary) => void;
  /** Changes when the doc's content is replaced (a new revision), so passages are found again at once. */
  contentKey?: unknown;
  /**
   * For a doc with a toolbar of its own (the owner's editor): receives the
   * function that starts a comment on the current selection, for that
   * toolbar's Comment item, and null when the margin goes. Without it, a
   * selection shows the comment chip instead.
   */
  bindStartComment?: (start: (() => void) | null) => void;
}

/** The comment margin for one doc (see the module comment). */
export function DocComments({ docId, root, role, onSummary, contentKey, bindStartComment }: DocCommentsProps) {
  const [comments, setComments] = useState<DocComment[]>([]);
  const [error, setError] = useState<string | null>(null);
  /** Where the comment chip goes (its centre and top, in the viewport) while there is a selection. */
  const [selection, setSelection] = useState<{ x: number; y: number } | null>(null);
  const [composing, setComposing] = useState<DocCommentAnchor | null>(null);
  const [composerFocused, setComposerFocused] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [showResolved, setShowResolved] = useState(false);
  /** Where each comment's passage is now, by id (absent: an orphan); bumped as the doc re-renders. */
  const [located, setLocated] = useState<Map<string, number>>(() => new Map());
  const ranges = useRef<Map<string, Range>>(new Map());
  const narrow = useNarrow();

  // A failed read keeps the comments last read; the next poll tries again.
  /** Bumped by every change made here; a read started before one lands is dropped, so it can't undo it. */
  const localChange = useRef(0);
  const load = useCallback(async () => {
    const started = localChange.current;
    try {
      const read = await listComments(docId);
      if (started === localChange.current) setComments(read);
    } catch {
      // Nothing to show: the margin stays as it was.
    }
  }, [docId]);

  const pending = comments.some((c) => c.state === "pending");
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    const t = setInterval(() => void load(), pending ? POLL_PENDING_MS : POLL_IDLE_MS);
    return () => clearInterval(t);
  }, [load, pending]);

  useEffect(() => {
    onSummary?.({
      total: comments.filter((c) => !c.resolved).length,
      // The owner's own comment never waits on them, whatever state an older row was left in.
      waiting: comments.filter((c) => !c.resolved && !c.byOwner && c.state === "waiting").length,
    });
  }, [comments, onSummary]);

  // Finds every open comment's passage and draws it; again whenever the doc's DOM changes.
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    addHighlightStyles();
    const highlights = highlightRegistry();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const draw = () => {
      const index = textIndex(el);
      const answered: Range[] = [];
      const waiting: Range[] = [];
      const at = new Map<string, number>();
      ranges.current = new Map();
      for (const c of comments) {
        const found = locateAnchor(index.text, c.anchor);
        const range = found && rangeAt(index, found.start, found.end);
        if (!found || !range) continue;
        at.set(c.id, found.start);
        ranges.current.set(c.id, range);
        if (c.resolved) continue;
        (c.state === "waiting" && !c.byOwner ? waiting : answered).push(range);
      }
      // The passage a comment is being written on stays marked while the composer is open.
      const draft = composing && locateAnchor(index.text, composing);
      const draftRange = draft && rangeAt(index, draft.start, draft.end);
      if (draftRange) waiting.push(draftRange);
      setLocated((prev) => (prev.size === at.size && [...at].every(([k, v]) => prev.get(k) === v) ? prev : at));
      if (highlights) {
        highlights.registry.set(HIGHLIGHT_ANSWERED, highlights.make(answered));
        highlights.registry.set(HIGHLIGHT_WAITING, highlights.make(waiting));
      }
    };
    draw();
    const observer = new MutationObserver(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(draw, 150);
    });
    observer.observe(el, { subtree: true, childList: true, characterData: true });
    return () => {
      observer.disconnect();
      if (timer) clearTimeout(timer);
      highlights?.registry.delete(HIGHLIGHT_ANSWERED);
      highlights?.registry.delete(HIGHLIGHT_WAITING);
    };
  }, [root, comments, contentKey, composing]);

  // While the composer has focus the editor's formatting toolbar is hidden; back in the doc, it works as usual.
  useEffect(() => {
    const el = root.current;
    if (!el || !composing || !composerFocused) return;
    el.classList.add(COMPOSING_CLASS);
    return () => el.classList.remove(COMPOSING_CLASS);
  }, [root, composing, composerFocused]);

  // A composer opened below the margin's fold is brought into view.
  const composerRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (composing) composerRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [composing]);

  // The one way a comment starts, from the editor toolbar's Comment item or the reader's chip.
  /** Whether a comment was started: false when the page's selection holds no text of this doc. */
  const startComment = useCallback((): boolean => {
    const el = root.current;
    const picked = el && selectedPassage(el);
    if (!picked) return false;
    setComposing(picked.anchor);
    setSelection(null);
    return true;
  }, [root]);
  useEffect(() => {
    if (!bindStartComment) return;
    bindStartComment(startComment);
    return () => bindStartComment(null);
  }, [bindStartComment, startComment]);

  // A selection the doc's own toolbar doesn't offer Comment on (all of a reader's; in the editor, one
  // inside a code block) gets the comment chip above it. Mod-Alt-M starts a comment from the keyboard.
  const editorToolbar = !!bindStartComment;
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const onUp = () => {
      const picked = selectedPassage(el);
      if (!picked || (editorToolbar && !picked.inCode)) {
        setSelection(null);
        return;
      }
      const { rect } = picked;
      // Above the selection, as the editor's toolbar sits; below it when there's no room above inside the doc
      // (so it never covers the pane's header); never off screen.
      const above = rect.top - CHIP_SIZE - CHIP_GAP;
      const x = Math.min(Math.max(rect.left + rect.width / 2, CHIP_SIZE / 2 + CHIP_GAP), window.innerWidth - CHIP_SIZE / 2 - CHIP_GAP);
      setSelection({ x, y: above >= el.getBoundingClientRect().top + CHIP_GAP ? above : rect.bottom + CHIP_GAP });
    };
    // On the document: a reader's selection leaves focus on the page, not in the doc. The key is taken only when a comment starts.
    const onKey = (e: KeyboardEvent) => {
      if (isCommentShortcut(e) && startComment()) e.preventDefault();
    };
    // The chip is placed in the viewport, so a scroll would leave it behind: it goes until the next selection.
    const onScroll = () => setSelection(null);
    // A selection cleared or moved out of the doc (a click in the sidebar) takes the chip with it.
    const onSelectionChange = () => {
      const sel = window.getSelection();
      const range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
      if (!range || range.collapsed || !el.contains(range.commonAncestorContainer)) setSelection(null);
    };
    el.addEventListener("mouseup", onUp);
    el.addEventListener("keyup", onUp);
    document.addEventListener("keydown", onKey);
    el.addEventListener("scroll", onScroll);
    document.addEventListener("selectionchange", onSelectionChange);
    return () => {
      el.removeEventListener("mouseup", onUp);
      el.removeEventListener("keyup", onUp);
      document.removeEventListener("keydown", onKey);
      el.removeEventListener("scroll", onScroll);
      document.removeEventListener("selectionchange", onSelectionChange);
    };
  }, [root, editorToolbar, startComment]);

  const failure = (err: unknown) => (err instanceof Error ? err.message : String(err));
  const replace = (next: DocComment) => {
    localChange.current++;
    setComments((prev) => prev.map((c) => (c.id === next.id ? next : c)));
  };

  // The composer goes while it has focus, so no blur reaches it: its focus is cleared here.
  const closeComposer = () => {
    setComposing(null);
    setComposerFocused(false);
  };

  const send = async () => {
    if (!composing || !draft.trim() || sending) return;
    setSending(true);
    try {
      const made = await leaveComment(docId, draft.trim(), composing);
      localChange.current++;
      setComments((prev) => [...prev, made]);
      closeComposer();
      setDraft("");
      setError(null);
    } catch (err) {
      setError(failure(err));
    } finally {
      setSending(false);
    }
  };

  const { open, orphans, resolved } = useMemo(() => {
    const byPosition = (a: DocComment, b: DocComment) => located.get(a.id)! - located.get(b.id)!;
    return {
      open: comments.filter((c) => !c.resolved && located.has(c.id)).sort(byPosition),
      orphans: comments.filter((c) => !c.resolved && !located.has(c.id)),
      resolved: comments.filter((c) => c.resolved),
    };
  }, [comments, located]);

  // A clicked card's passage is scrolled to and marked for a moment, so it's clear which text it is on.
  const focusMark = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (focusMark.current) clearTimeout(focusMark.current);
      highlightRegistry()?.registry.delete(HIGHLIGHT_FOCUS);
    },
    []
  );
  const focus = (id: string) => {
    const range = ranges.current.get(id);
    if (!range) return;
    range.startContainer.parentElement?.scrollIntoView({ block: "center", behavior: "smooth" });
    const highlights = highlightRegistry();
    if (!highlights) return;
    const mark = highlights.make([range]) as { priority?: number };
    // Painted over the answered and waiting marks, which are set again on every redraw.
    mark.priority = 1;
    highlights.registry.set(HIGHLIGHT_FOCUS, mark);
    if (focusMark.current) clearTimeout(focusMark.current);
    focusMark.current = setTimeout(() => highlights.registry.delete(HIGHLIGHT_FOCUS), FOCUS_MARK_MS);
  };

  const cardFor = (c: DocComment) => (
    <CommentCard
      key={c.id}
      comment={c}
      role={role}
      onFocus={() => focus(c.id)}
      onReply={async (body) => {
        try {
          replace(await replyToComment(docId, c.id, body));
          return null;
        } catch (err) {
          return failure(err);
        }
      }}
      onResolve={async (value) => {
        try {
          replace(await resolveComment(docId, c.id, value));
          return null;
        } catch (err) {
          return failure(err);
        }
      }}
    />
  );

  // The owner always has the margin on a desktop; otherwise it shows once there is something in it.
  const empty = comments.length === 0 && composing === null && error === null;
  const visible = !empty || (role === "owner" && !narrow);
  return (
    <>
      {selection && !composing && (
        // Drawn as a one-item copy of the editor's selection toolbar (Crepe's .milkdown-toolbar).
        <div
          data-testid="doc-comment-chip"
          role="toolbar"
          aria-label="Selection"
          style={{
            position: "fixed",
            left: selection.x,
            top: selection.y,
            transform: "translateX(-50%)",
            zIndex: 20,
            display: "flex",
            background: theme.surface,
            borderRadius: 8,
            boxShadow: `0 1px 3px ${alpha(theme.shadow, 0x80)}`,
          }}
        >
          <button
            type="button"
            className={CHIP_ITEM_CLASS}
            data-testid="doc-comment-start"
            title={`${COMMENT_LABEL} (${COMMENT_SHORTCUT})`}
            aria-label={COMMENT_LABEL}
            aria-keyshortcuts={COMMENT_ARIA_SHORTCUT}
            // Mousedown would clear the selection before the click lands.
            onMouseDown={(e) => e.preventDefault()}
            onClick={startComment}
            style={{ width: 32, height: 32, margin: 6, padding: 4, border: "none", borderRadius: 4, background: "transparent", cursor: "pointer", display: "flex" }}
            dangerouslySetInnerHTML={{ __html: COMMENT_ICON }}
          />
        </div>
      )}
      {visible && (
        <aside
          data-testid="doc-comments"
          className={MARGIN_CLASS}
          aria-label="Comments"
          style={{
            width: 340,
            flexShrink: 0,
            boxSizing: "border-box",
            padding: "18px 16px",
            borderLeft: `1px solid ${theme.edgeSoft}`,
            background: theme.hover,
            overflowY: "auto",
            display: "flex",
            flexDirection: "column",
            gap: 12,
            fontSize: 13,
          }}
        >
          {/* One keyed list, so a card that moves between sections (its passage edited away, say) keeps its reply draft. */}
          {[
            empty && (
              <div key="empty" data-testid="doc-comments-empty" style={{ fontSize: 12.5, color: theme.faint, lineHeight: 1.5 }}>
                No comments yet. Select text to leave one.
              </div>
            ),
            ...open.map(cardFor),
            composing && (
            <form
              key="composer"
              ref={composerRef}
              data-testid="doc-comment-composer"
              style={card}
              onFocus={() => setComposerFocused(true)}
              onBlur={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setComposerFocused(false);
              }}
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
            >
              <div style={{ fontSize: 12, color: theme.dim, overflowWrap: "anywhere" }}>On “{composing.quote.length > 80 ? `${composing.quote.slice(0, 79)}…` : composing.quote}”</div>
              <textarea
                autoFocus
                data-testid="doc-comment-input"
                aria-label="Comment"
                placeholder={role === "owner" ? "Leave a note…" : "Ask a question or leave a note…"}
                value={draft}
                maxLength={DOC_COMMENT_BODY_MAX}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send();
                  if (e.key === "Escape") closeComposer();
                }}
                style={{ ...input, minHeight: 60, resize: "vertical", borderColor: theme.running }}
              />
              {role === "owner" && (
                <div data-testid="doc-comment-visibility" style={{ fontSize: 11.5, color: theme.dim }}>
                  Readers see this once the doc is shared.
                </div>
              )}
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <button type="button" data-testid="doc-comment-cancel" onClick={closeComposer} style={button}>
                  Cancel
                </button>
                <button type="submit" data-testid="doc-comment-send" disabled={sending || !draft.trim()} style={primary}>
                  Comment
                </button>
              </div>
            </form>
            ),
            error && (
              <div key="error" role="alert" style={{ color: theme.waiting, fontSize: 12.5 }}>
                {error}
              </div>
            ),
            orphans.length > 0 && (
              <div key="orphans" data-testid="doc-comments-orphans" style={{ fontSize: 11.5, color: theme.faint, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                Passage removed
              </div>
            ),
            ...orphans.map(cardFor),
            resolved.length > 0 && (
              <button
                key="resolved-toggle"
                type="button"
                data-testid="doc-comments-resolved-toggle"
                onClick={() => setShowResolved((v) => !v)}
                style={{ ...button, border: "none", padding: 0, color: theme.running, textAlign: "left" }}
              >
                {showResolved ? "Hide" : "Show"} {resolved.length} resolved
              </button>
            ),
            ...(showResolved ? resolved.map(cardFor) : []),
          ]}
        </aside>
      )}
    </>
  );
}
