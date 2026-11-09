import { lazyNamed } from "../lib/lazyNamed";

/*
 * The console's tabs other than Persona, each its own chunk. Persona is the
 * owner's landing view and stays in the first load; every other tab loads
 * when it is first opened, or earlier from prefetchViews once the console's
 * snapshot has landed and the page is idle, so a tab switch rarely waits.
 */
export const SchedulesView = lazyNamed(() => import("./SchedulesView"), "SchedulesView");
export const WorkView = lazyNamed(() => import("./WorkView"), "WorkView");
export const ReviewView = lazyNamed(() => import("./review/ReviewView"), "ReviewView");
export const KnowledgeView = lazyNamed(() => import("./KnowledgeView"), "KnowledgeView");
/** The Docs tab; its editor is a further chunk of its own, loaded when a doc opens. */
export const DocsView = lazyNamed(() => import("./docs/DocsView"), "DocsView");
export const BoardView = lazyNamed(() => import("./BoardView"), "BoardView");
export const ProjectsView = lazyNamed(() => import("./ProjectsView"), "ProjectsView");
export const YouView = lazyNamed(() => import("./YouView"), "YouView");
/** The Burrow: every worker as an animated pixel-art bunny. */
export const BurrowView = lazyNamed(() => import("./BurrowView"), "BurrowView");
/**
 * Persona's job drawer, opened from a job row: it carries the transcript and
 * pipeline views, which the thread itself never needs.
 */
export const PersonaJobDrawer = lazyNamed(() => import("./PersonaJobDrawer"), "PersonaJobDrawer");

/** In tab order: the one most likely opened next loads first. */
const PREFETCH = [
  PersonaJobDrawer,
  SchedulesView,
  BoardView,
  // The Board's Live workers drawer.
  WorkView,
  ReviewView,
  ProjectsView,
  KnowledgeView,
  DocsView,
  BurrowView,
  YouView,
];

/** How long after the console's snapshot lands prefetching waits, leaving the network to the views' own data. */
export const PREFETCH_DELAY_MS = 1500;

/**
 * Loads every tab's chunk, one at a time, once the browser is idle after
 * PREFETCH_DELAY_MS. A failed prefetch is ignored: opening the tab retries.
 * Returns a cancel function.
 */
export function prefetchViews(): () => void {
  let cancelled = false;
  const idle = (fn: () => void) =>
    typeof window.requestIdleCallback === "function" ? window.requestIdleCallback(fn, { timeout: 3000 }) : window.setTimeout(fn, 0);
  const timer = window.setTimeout(
    () =>
      idle(async () => {
        for (const view of PREFETCH) {
          if (cancelled) return;
          await view.preload().catch(() => {});
        }
      }),
    PREFETCH_DELAY_MS
  );
  return () => {
    cancelled = true;
    window.clearTimeout(timer);
  };
}
