import { useCallback, useEffect, useLayoutEffect, useRef } from "react";

/**
 * Whether the reader is selecting text inside `el`: a mouse button is held
 * down in it (a drag may be starting) or a non-empty selection touches it.
 */
function selectingWithin(el: HTMLElement, pointerDown: boolean): boolean {
  if (pointerDown) return true;
  const selection = el.ownerDocument.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;
  return (
    (selection.anchorNode !== null && el.contains(selection.anchorNode)) ||
    (selection.focusNode !== null && el.contains(selection.focusNode))
  );
}

/**
 * Keeps a scroll container pinned to the bottom as content grows — the natural
 * reading position for a live conversation or terminal — while leaving the user
 * alone the moment they scroll up to read history.
 *
 *  - Lands at the bottom the instant the container mounts and whenever
 *    `resetKey` changes (e.g. switching sessions), so a freshly opened view
 *    starts on the latest turn, not the top.
 *  - When `contentKey` changes (a new turn, streamed output), auto-scrolls to
 *    the bottom only if the user was already near it; if they've scrolled up,
 *    their position is preserved — so following the tail never yanks them away
 *    from something they're reading.
 *  - Holds still while the user is selecting text inside the container (mouse
 *    held down, or a non-empty selection there). Scrolling under a drag moves
 *    the content past the pointer and stretches the selection across whole
 *    paragraphs. Content that arrived meanwhile is followed once the selection
 *    clears.
 *
 * Returns a callback ref to attach to the scrollable element. A callback ref
 * (not a plain ref + effect) is deliberate: the element is mounted behind a
 * loading guard, so it can appear on a later render than the component's first,
 * and the callback fires exactly when the node attaches.
 */
export function useStickyScroll(
  contentKey: unknown,
  resetKey: unknown
): (node: HTMLDivElement | null) => void {
  const elRef = useRef<HTMLDivElement | null>(null);
  // Whether the view is following the tail (true) or the user has scrolled up
  // into history (false). Any content arriving while false is left off-screen.
  const stuck = useRef(true);
  const seenReset = useRef<unknown>(undefined);
  // A mouse button went down inside the container and hasn't been released.
  const pointerDown = useRef(false);
  // Content arrived while a selection held the scroll.
  const deferred = useRef(false);

  const onScroll = useCallback(() => {
    const el = elRef.current;
    if (!el) return;
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    // A little slack so being a few px off the exact bottom still counts as
    // "following" — sub-pixel rounding and the reply box otherwise unstick it.
    stuck.current = gap < 80;
  }, []);

  const onMouseDown = useCallback(() => {
    pointerDown.current = true;
  }, []);

  const setRef = useCallback(
    (node: HTMLDivElement | null) => {
      const prev = elRef.current;
      if (prev) {
        prev.removeEventListener("scroll", onScroll);
        prev.removeEventListener("mousedown", onMouseDown);
      }
      elRef.current = node;
      if (node) {
        node.addEventListener("scroll", onScroll, { passive: true });
        node.addEventListener("mousedown", onMouseDown);
        node.scrollTop = node.scrollHeight;
        stuck.current = true;
      }
    },
    [onScroll, onMouseDown]
  );

  // Once the selection ends, catch up on whatever arrived during it.
  useEffect(() => {
    const catchUp = () => {
      const el = elRef.current;
      if (!el || !deferred.current || selectingWithin(el, pointerDown.current)) return;
      deferred.current = false;
      if (stuck.current) el.scrollTop = el.scrollHeight;
    };
    const onMouseUp = () => {
      pointerDown.current = false;
      catchUp();
    };
    document.addEventListener("mouseup", onMouseUp);
    document.addEventListener("selectionchange", catchUp);
    return () => {
      document.removeEventListener("mouseup", onMouseUp);
      document.removeEventListener("selectionchange", catchUp);
    };
  }, []);

  // Switching sessions: snap back to the bottom and re-pin.
  useLayoutEffect(() => {
    if (seenReset.current === resetKey) return;
    seenReset.current = resetKey;
    stuck.current = true;
    deferred.current = false;
    const el = elRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [resetKey]);

  // New content: follow the tail unless the user has scrolled up or is
  // selecting text.
  useLayoutEffect(() => {
    const el = elRef.current;
    if (!el || !stuck.current) return;
    if (selectingWithin(el, pointerDown.current)) {
      deferred.current = true;
      return;
    }
    el.scrollTop = el.scrollHeight;
  }, [contentKey]);

  return setRef;
}
