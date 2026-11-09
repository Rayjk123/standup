/**
 * A requestAnimationFrame loop throttled to `fps` that runs only while it is
 * wanted and the page is visible: it stops on `stop()` and whenever the tab
 * is hidden (visibilitychange), and resumes when the tab shows again. A
 * hidden or stopped loop schedules no frame at all.
 */

export interface FrameLoopDeps {
  requestFrame: (cb: (now: number) => void) => number;
  cancelFrame: (handle: number) => void;
  /** The document whose visibility gates the loop. */
  doc: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;
}

export interface FrameLoop {
  /** Starts the loop (a no-op when it already runs); `draw` gets the frame's tick count. */
  start(): void;
  /** Stops the loop and stops listening for visibility changes. */
  stop(): void;
  /** Whether a frame is scheduled right now. */
  readonly running: boolean;
}

function browserDeps(): FrameLoopDeps {
  return {
    requestFrame: (cb) => window.requestAnimationFrame(cb),
    cancelFrame: (handle) => window.cancelAnimationFrame(handle),
    doc: document,
  };
}

/**
 * `draw(tick)` runs at most `fps` times a second, where `tick` counts drawn
 * frames since the loop was made; frames that come sooner are skipped.
 */
export function createFrameLoop(draw: (tick: number) => void, fps: number, deps: FrameLoopDeps = browserDeps()): FrameLoop {
  const interval = 1000 / fps;
  let handle: number | null = null;
  let wanted = false;
  let last = -Infinity;
  let tick = 0;

  const frame = (now: number) => {
    handle = null;
    if (!wanted || deps.doc.visibilityState === "hidden") return;
    if (now - last >= interval) {
      // Keep to the fps grid rather than drifting by each frame's lateness;
      // after a long gap (the first frame, a stall) restart the grid at now.
      last = now - last < 2 * interval ? last + interval : now;
      draw(tick++);
    }
    handle = deps.requestFrame(frame);
  };

  const schedule = () => {
    if (handle === null && wanted && deps.doc.visibilityState !== "hidden") handle = deps.requestFrame(frame);
  };
  const unschedule = () => {
    if (handle !== null) deps.cancelFrame(handle);
    handle = null;
  };
  const onVisibility = () => {
    if (deps.doc.visibilityState === "hidden") unschedule();
    else {
      last = -Infinity;
      schedule();
    }
  };

  return {
    start() {
      if (wanted) return;
      wanted = true;
      last = -Infinity;
      deps.doc.addEventListener("visibilitychange", onVisibility);
      schedule();
    },
    stop() {
      wanted = false;
      unschedule();
      deps.doc.removeEventListener("visibilitychange", onVisibility);
    },
    get running() {
      return handle !== null;
    },
  };
}
