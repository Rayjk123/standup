/**
 * The gateway process's lifecycle, with every side effect injected so it is
 * unit-testable; cli.ts wires in the real ones.
 *
 * 1. Publish gateway.json marked `binding`, so dev.ts sees a live gateway
 *    rather than none while this one starts.
 * 2. Probe the public ports and decide (startup.ts bindDecision): another
 *    install's gateway there means exit EXIT_FOREIGN_GATEWAY.
 * 3. Only now, fully initialized, SIGTERM this install's gateways: the one
 *    gateway.json named and any found on the ports. Each stops listening at
 *    once on SIGTERM.
 * 4. Bind, retrying EADDRINUSE every FAST_BIND_RETRY_MS at first, so the
 *    ports go unserved for about one retry interval; this happens only when
 *    the gateway's own code changed. Past the retry window: exit
 *    EXIT_BIND_FAILED. A gateway that never binds puts back the gateway.json
 *    it replaced.
 * 5. Serving: rewrite gateway.json without `binding`, drain on SIGTERM/SIGINT,
 *    and exit once orphaned (startup.ts OrphanWatch) or idle.
 */
import {
  EXIT_BIND_FAILED,
  EXIT_FOREIGN_GATEWAY,
  type GatewayInfo,
  type GatewayStats,
  type PublicPorts,
} from "@standup/shared/topology";
import type { Gateway } from "./gateway.js";
import {
  FAST_BIND_PHASE_MS,
  FAST_BIND_RETRY_MS,
  OrphanWatch,
  bindDecision,
  bindWithRetry,
  type BindRetryOptions,
  type PortProbe,
} from "./startup.js";

/** How often a serving gateway checks whether it is orphaned. */
export const DEFAULT_ORPHAN_CHECK_MS = 1_000;
/** While a bind keeps failing, how often the ports are probed again for a gateway. */
export const DEFAULT_REPROBE_MS = 1_000;

export interface LifecycleDeps {
  /** This process's pid. */
  pid: number;
  dataDir: string;
  version: string;
  startedAt: string;
  /** The ports to bind, as configured (recorded while binding). */
  ports: PublicPorts;
  readInfo(): GatewayInfo | undefined;
  writeInfo(info: GatewayInfo): void;
  removeInfo(): void;
  /** Probes the public collector and ws ports for a gateway. */
  probe(): Promise<PortProbe[]>;
  /** Whether a gateway found on the ports is this install's and may be retired (retire.ts isRetirableOwnGateway). */
  ownsStats(stats: GatewayStats): boolean;
  /** Whether `pid` is a live process other than this one running this install's gateway CLI. */
  isOwnGateway(pid: number): boolean;
  kill(pid: number, signal: NodeJS.Signals): void;
  /** Binds the listeners; throws (EADDRINUSE) when a port is held. `onIdle` ends the gateway. */
  listen(onIdle: (reason: string) => void): Gateway;
  /** Whether the dev.ts recorded in dev.json is running. */
  devAlive(): boolean;
  /**
   * Why a collector may still come up without dev.ts (startup.ts
   * restartActivity), or undefined; while set the gateway is not orphaned.
   */
  restartActivity?(): string | undefined;
  orphanExitMs: number;
  orphanCheckMs?: number;
  reprobeMs?: number;
  /** Runs `fn` every `ms`; returns a cancel function. */
  every(ms: number, fn: () => void): () => void;
  /** Registers the SIGTERM/SIGINT handler. */
  onStopSignal(handler: (signal: NodeJS.Signals) => void): void;
  exit(code: number): void;
  log(message: string): void;
  /** Also shown on stderr. */
  error(message: string): void;
  now(): number;
  bindRetry?: Pick<BindRetryOptions, "sleep" | "timeoutMs">;
}

export type LifecycleOutcome =
  | { outcome: "serving"; gateway: Gateway; shutdown(reason: string, code: number): Promise<void> }
  | { outcome: "exited"; code: number };

class ForeignGatewayError extends Error {}
class StoppedWhileBinding extends Error {}

export async function runGateway(deps: LifecycleDeps): Promise<LifecycleOutcome> {
  const prior = deps.readInfo();
  let phase: "binding" | "serving" | "exiting" = "binding";
  let exitCode: number | undefined;
  const finish = (code: number): void => {
    if (exitCode !== undefined) return;
    exitCode = code;
    deps.exit(code);
  };

  try {
    deps.writeInfo({ pid: deps.pid, version: deps.version, ports: deps.ports, startedAt: deps.startedAt, dataDir: deps.dataDir, binding: true });
  } catch (err) {
    deps.log(`could not write gateway.json: ${String(err)}`);
  }

  // A gateway that never binds puts back the record it replaced, unless a
  // newer gateway has already recorded itself.
  const restorePrior = (): void => {
    try {
      if (deps.readInfo()?.pid !== deps.pid) return;
      if (prior) deps.writeInfo(prior);
      else deps.removeInfo();
    } catch (err) {
      deps.log(`could not restore gateway.json: ${String(err)}`);
    }
  };

  let gateway: Gateway | undefined;
  let cancelOrphanWatch: (() => void) | undefined;
  const shutdown = async (reason: string, code: number): Promise<void> => {
    if (phase === "exiting") return;
    phase = "exiting";
    cancelOrphanWatch?.();
    deps.log(`${reason}: draining`);
    try {
      await gateway?.stop();
    } catch (err) {
      deps.log(`stop failed: ${String(err)}`);
    }
    try {
      if (deps.readInfo()?.pid === deps.pid) deps.removeInfo();
    } catch (err) {
      deps.log(`could not remove gateway.json: ${String(err)}`);
    }
    deps.log(`exited (${reason})`);
    finish(code);
  };

  deps.onStopSignal((signal) => {
    if (phase === "binding") {
      // Not serving yet (a newer gateway retiring this one, or classic mode
      // stopping it): nothing to drain.
      phase = "exiting";
      deps.log(`${signal} while binding: exiting`);
      restorePrior();
      finish(0);
      return;
    }
    void shutdown(signal, 0);
  });

  const signalled = new Set<number>();
  const retire = (pid: number, why: string): void => {
    if (signalled.has(pid)) return;
    if (!deps.isOwnGateway(pid)) {
      deps.log(`pid ${pid} (${why}) is not a running gateway of this install; left alone`);
      return;
    }
    signalled.add(pid);
    deps.log(`retiring gateway pid ${pid} (${why})`);
    try {
      deps.kill(pid, "SIGTERM");
    } catch (err) {
      deps.log(`could not signal gateway ${pid}: ${String(err)}`);
    }
  };

  const decide = async (): Promise<void> => {
    const decision = bindDecision(await deps.probe(), deps.dataDir, deps.ownsStats, deps.pid);
    if (!decision.proceed) throw new ForeignGatewayError(decision.reason);
    for (const pid of decision.retire) retire(pid, "found serving the ports");
  };

  const reprobeMs = deps.reprobeMs ?? DEFAULT_REPROBE_MS;
  let lastProbeAt = deps.now();
  let lastRetryLogAt: number | undefined;
  let started: Gateway;
  try {
    await decide();
    if (phase !== "binding") throw new StoppedWhileBinding();
    if (prior && prior.pid !== deps.pid) retire(prior.pid, "named in gateway.json");
    started = await bindWithRetry(
      async () => {
        if (phase !== "binding") throw new StoppedWhileBinding();
        // A gateway that appeared on the ports since the last probe is
        // either retired too or refused.
        if (deps.now() - lastProbeAt >= reprobeMs) {
          lastProbeAt = deps.now();
          await decide();
          if (phase !== "binding") throw new StoppedWhileBinding();
        }
        return deps.listen((reason) => void shutdown(reason, 0));
      },
      {
        initialDelayMs: FAST_BIND_RETRY_MS,
        fastPhaseMs: FAST_BIND_PHASE_MS,
        ...deps.bindRetry,
        now: deps.now,
        onRetry: (err, delayMs) => {
          // Logged once a second at most: the fast phase retries every few ms.
          const at = deps.now();
          if (lastRetryLogAt !== undefined && at - lastRetryLogAt < 1_000) return;
          lastRetryLogAt = at;
          deps.log(`ports ${JSON.stringify(deps.ports)} in use (${String(err)}); retrying in ${delayMs}ms`);
        },
      },
    );
  } catch (err) {
    if (err instanceof StoppedWhileBinding) return { outcome: "exited", code: exitCode ?? 0 };
    restorePrior();
    if (err instanceof ForeignGatewayError) {
      deps.log(`refusing to start: ${err.message}`);
      deps.error(`standup gateway: refusing to start: ${err.message}`);
      finish(EXIT_FOREIGN_GATEWAY);
      return { outcome: "exited", code: EXIT_FOREIGN_GATEWAY };
    }
    deps.log(`failed to listen on ${JSON.stringify(deps.ports)}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    finish(EXIT_BIND_FAILED);
    return { outcome: "exited", code: EXIT_BIND_FAILED };
  }

  if (phase !== "binding") {
    await started.stop({ drainMs: 0 });
    return { outcome: "exited", code: exitCode ?? 0 };
  }
  gateway = started;
  phase = "serving";
  try {
    deps.writeInfo({ pid: deps.pid, version: deps.version, ports: started.ports, startedAt: deps.startedAt, dataDir: deps.dataDir });
  } catch (err) {
    deps.log(`could not write gateway.json: ${String(err)}`);
  }
  deps.log(`listening web=${started.ports.web} collector=${started.ports.collector} ws=${started.ports.ws} version=${deps.version.slice(0, 12)}`);

  const watch = new OrphanWatch(deps.orphanExitMs);
  let checking = false;
  let heldBy: string | undefined;
  cancelOrphanWatch = deps.every(deps.orphanCheckMs ?? DEFAULT_ORPHAN_CHECK_MS, () => {
    if (checking || phase !== "serving") return;
    checking = true;
    void (async () => {
      try {
        const devAlive = deps.devAlive();
        // A restart supervisor may be bringing a collector up itself while
        // dev.ts is gone (a standalone rollback): not orphaned meanwhile.
        let activity: string | undefined;
        if (!devAlive) {
          try {
            activity = deps.restartActivity?.();
          } catch (err) {
            deps.log(`could not read restart activity: ${String(err)}`);
          }
        }
        if (activity !== heldBy) {
          if (activity) deps.log(`the dev.ts recorded in dev.json is gone but ${activity}; staying up`);
          heldBy = activity;
        }
        // The leader is only re-checked once dev.ts is gone: until then the
        // verdict can't be "orphaned" whatever it says.
        if (!devAlive && !activity) await started.checkLeader().catch(() => false);
        if (phase !== "serving") return;
        if (watch.observe({ devAlive, restartActive: activity !== undefined, lastLeaderValidAt: started.lastLeaderValidAt(), now: deps.now() })) {
          deps.log(
            `the dev.ts recorded in dev.json is gone and no collector leader has validated for ${deps.orphanExitMs}ms; ` +
              "exiting to free the public ports (a gateway-mode dev.ts starts a new gateway)",
          );
          await shutdown("orphaned", 0);
        }
      } finally {
        checking = false;
      }
    })();
  });

  return { outcome: "serving", gateway: started, shutdown };
}
