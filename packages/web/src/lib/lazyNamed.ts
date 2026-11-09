import { createElement, lazy, type ComponentProps, type ComponentType } from "react";
import { isChunkLoadError, reloadForNewBuild } from "./chunkReload";

export type Preloadable<T extends ComponentType<any>> = ComponentType<ComponentProps<T>> & {
  /** Starts loading the component's chunk ahead of its first render; safe to call repeatedly. */
  preload(): Promise<unknown>;
};

/** Waits before each retry of a failed chunk load during a render. */
export const RETRY_DELAYS_MS = [500, 1500];

/**
 * Load cycles (each one try plus the RETRY_DELAYS_MS retries) a view may fail
 * in a row before it stops retrying for the life of the page.
 */
export const MAX_FAILED_CYCLES = 3;

/**
 * Bumped by retryFailedViews. A view whose load failed before the current
 * epoch gets a fresh React.lazy on its next render; one that failed in this
 * epoch keeps its rejected lazy, so the failure reaches its error boundary.
 */
let epoch = 0;

/** Lets every view whose chunk failed to load try again on its next render (see ViewBoundary). */
export function retryFailedViews(): void {
  epoch++;
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/**
 * React.lazy over a module's named export, with a `preload` that warms the
 * chunk before the component is first rendered (an idle prefetch, say). A
 * failed preload is forgotten so a later one retries. A render retries the
 * load (`retryDelaysMs`) before failing; the failure then reaches the nearest
 * error boundary, and once retryFailedViews has run (the boundary resetting
 * on a tab change, say) the next render starts over with a fresh React.lazy,
 * which would otherwise cache the rejection for the life of the page, up to
 * MAX_FAILED_CYCLES failed cycles in a row. A chunk
 * that still can't be fetched while online may reload the page onto the
 * current build (see chunkReload.ts).
 */
export function lazyNamed<M, K extends keyof M>(
  load: () => Promise<M>,
  name: K,
  { retryDelaysMs = RETRY_DELAYS_MS }: { retryDelaysMs?: readonly number[] } = {}
): Preloadable<M[K] & ComponentType<any>> {
  type C = M[K] & ComponentType<any>;
  let pending: Promise<M> | undefined;
  const preload = (): Promise<M> =>
    (pending ??= load().then(
      (m) => {
        // The chunk is here, however it got loaded: a view stopped at the cap may recover.
        failedCycles = 0;
        return m;
      },
      (err) => {
        pending = undefined;
        throw err;
      }
    ));
  let failedIn: number | undefined;
  let failedCycles = 0;
  // Once a view has failed, its chunk is warmed again whenever the browser
  // comes back online or the tab is shown again (an outage over, a laptop
  // woken), until a load succeeds: that lifts the cap, so the next navigation
  // renders the view. One pair of listeners per view at a time.
  let waiting = false;
  const retryWhenBack = () => {
    if (waiting || typeof window === "undefined" || typeof document === "undefined") return;
    waiting = true;
    const attempt = () => {
      if (document.visibilityState === "hidden") return;
      window.removeEventListener("online", attempt);
      document.removeEventListener("visibilitychange", attempt);
      void preload().then(
        () => (waiting = false),
        () => {
          // The network may be up before fetches work: keep waiting for the next chance.
          waiting = false;
          retryWhenBack();
        }
      );
    };
    window.addEventListener("online", attempt);
    document.addEventListener("visibilitychange", attempt);
  };
  const fresh = () =>
    lazy(async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          return { default: (await preload())[name] as C };
        } catch (err) {
          if (attempt < retryDelaysMs.length) {
            await sleep(retryDelaysMs[attempt]!);
            continue;
          }
          failedIn = epoch;
          const online = typeof navigator === "undefined" || navigator.onLine !== false;
          // A cycle failed while offline says nothing about the chunk: it doesn't count toward the cap.
          if (online) failedCycles++;
          retryWhenBack();
          if (online && isChunkLoadError(err)) reloadForNewBuild();
          throw err;
        }
      }
    });
  let current = fresh();
  const Component = (props: ComponentProps<C>) => {
    // Only a retry asked for after the failure, and only up to
    // MAX_FAILED_CYCLES in a row: past that the error stays up and its
    // Reload button is the way back.
    if (failedIn !== undefined && failedIn < epoch && failedCycles < MAX_FAILED_CYCLES) {
      failedIn = undefined;
      current = fresh();
    }
    return createElement(current, props);
  };
  return Object.assign(Component, { preload });
}
