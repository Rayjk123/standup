/**
 * Drain state for a collector shutting down for a restart. Once draining:
 *
 * - every NEW HTTP request is answered `503` with DRAINING_HEADER: refused —
 *   never processed, so the gateway may retry it against the next leader;
 * - every long wait (an ask_human long-poll, a safety-floor hold, a plan
 *   approval) is released: it throws DrainReleasedError, which the app's error
 *   handler turns into `503` with DRAINING_HEADER: released. The waited-on row
 *   is left pending, so the caller's retry (it carries its request id)
 *   re-attaches to it on the next leader.
 *
 * The warm-standby handover itself is leader.ts's.
 */
import type { MiddlewareHandler } from "hono";
import { DRAINING_HEADER, DRAINING_RELEASED, DRAINING_REFUSED } from "@standup/shared/topology";

/** Thrown out of a long wait the drain released. */
export class DrainReleasedError extends Error {
  constructor() {
    super("released: the collector is restarting");
    this.name = "DrainReleasedError";
  }
}

function drainingResponse(kind: typeof DRAINING_REFUSED | typeof DRAINING_RELEASED): Response {
  return new Response(JSON.stringify({ error: "draining" }), {
    status: 503,
    headers: { "content-type": "application/json", [DRAINING_HEADER]: kind },
  });
}

/** The answer to a request that arrived while draining. */
export const drainRefusedResponse = (): Response => drainingResponse(DRAINING_REFUSED);
/** The answer to a long wait the drain released. */
export const drainReleasedResponse = (): Response => drainingResponse(DRAINING_RELEASED);

export class Drain {
  private readonly controller = new AbortController();
  private tasks = 0;

  get draining(): boolean {
    return this.controller.signal.aborted;
  }

  /** Background tasks (see track) still running. */
  get pendingTasks(): number {
    return this.tasks;
  }

  /**
   * Counts `task` as in flight until it settles, so the shutdown waits for it
   * like an in-flight request. For work that outlives the request that started
   * it and records its outcome when the drain releases it.
   */
  track<T>(task: Promise<T>): Promise<T> {
    this.tasks++;
    const done = () => {
      this.tasks--;
    };
    void task.then(done, done);
    return task;
  }

  /** Aborts when draining begins; long waits listen on it. */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** Starts draining. True the first time, false when already draining. */
  begin(): boolean {
    if (this.draining) return false;
    this.controller.abort(new DrainReleasedError());
    return true;
  }

  /** Hono middleware refusing every request once draining; mount it first. */
  middleware(): MiddlewareHandler {
    return async (_c, next) => {
      if (this.draining) return drainRefusedResponse();
      await next();
    };
  }
}

/** The collector process's drain, which long waits observe unless handed another signal. */
export const processDrain = new Drain();

/**
 * Sleeps `ms`, or throws DrainReleasedError as soon as `signal` aborts
 * (immediately if it already has).
 */
export function sleepUnlessReleased(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new DrainReleasedError());
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DrainReleasedError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Kills the process group `pid` leads (a child spawned with `detached: true`),
 * falling back to the pid alone when it leads no group. Best-effort: a child
 * already gone is not an error.
 */
export function killProcessGroup(pid: number, signal: NodeJS.Signals = "SIGKILL"): void {
  // -0 and -1 would signal this process's own group, or every process it may.
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
}

/**
 * Kills `pid`'s process group as soon as `signal` aborts (immediately if it
 * already has), so a handler waiting on a child is released with the drain
 * instead of being cut at the drain timeout. Returns a disposer that stops
 * listening; call it once the child exits.
 */
export function killGroupOnRelease(pid: number, signal: AbortSignal | undefined): () => void {
  if (!signal) return () => {};
  const onAbort = () => killProcessGroup(pid);
  if (signal.aborted) {
    onAbort();
    return () => {};
  }
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

/** What a shutdown signal does: start the drain, nothing, or exit at once. */
export type ShutdownSignalAction = "drain" | "ignore" | "force";

/**
 * Classifies the shutdown signals a collector receives. The first starts the
 * drain. A repeat within `graceMs` of it is ignored: a terminal Ctrl+C delivers
 * SIGINT to the whole process group and dev.ts then relays a SIGTERM, which is
 * the same request, not an impatient second one. A repeat after that forces an
 * immediate exit.
 */
export function shutdownSignalGate(graceMs = 1_000, now: () => number = Date.now): () => ShutdownSignalAction {
  let firstAt: number | undefined;
  return () => {
    const t = now();
    if (firstAt === undefined) {
      firstAt = t;
      return "drain";
    }
    return t - firstAt > graceMs ? "force" : "ignore";
  };
}

/**
 * Resolves once `pending()` reaches 0 or `timeoutMs` passes; true when it
 * reached 0. Used to let in-flight requests finish after the listener stops.
 */
export async function waitForIdle(pending: () => number, timeoutMs: number, pollMs = 25): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (pending() > 0) {
    if (Date.now() >= deadline) return false;
    await Bun.sleep(pollMs);
  }
  return true;
}
