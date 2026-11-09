/**
 * Which collector the gateway may route to. The leader file names the lock
 * holder's ports, but a file alone can be stale (the leader crashed) or early
 * (the new leader hasn't bound yet), so a leader only counts once its own
 * `/health` reports the file's pid. A validated leader is cached until the
 * file's content changes, a request against it fails, or a background check
 * gets a definite answer that it is gone (refused, or another pid).
 */
import { GATEWAY_HOST, type LeaderInfo } from "@standup/shared/topology";

/** A leader whose /health matched; `key` identifies the exact file content. */
export interface ValidatedLeader {
  leader: LeaderInfo;
  key: string;
}

export interface LeaderResolverOptions {
  /** The current leader record (normally the parsed collector-leader.json). */
  source: () => LeaderInfo | undefined;
  /** Host the collector slots listen on. */
  host?: string;
  /** Per-check /health timeout. */
  healthTimeoutMs?: number;
}

/**
 * A /health check's verdict. `gone` is definite (connection refused, an
 * error status, or a different pid); `inconclusive` is a timeout or another
 * transport failure, which says nothing about whether the leader is still up.
 */
export type HealthVerdict = "ok" | "gone" | "inconclusive";

function isLeaderInfo(value: unknown): value is LeaderInfo {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  const port = (p: unknown) => typeof p === "number" && Number.isInteger(p) && p > 0 && p < 65536;
  return typeof v.pid === "number" && v.pid > 0 && port(v.httpPort) && port(v.wsPort);
}

export class LeaderResolver {
  private readonly source: () => LeaderInfo | undefined;
  private readonly host: string;
  private readonly healthTimeoutMs: number;
  private cached: ValidatedLeader | undefined;
  private inflight: { key: string; promise: Promise<ValidatedLeader | undefined> } | undefined;
  /** When a leader last validated (or was served from cache), epoch ms; 0 = never. */
  lastValidAt = 0;

  constructor(opts: LeaderResolverOptions) {
    this.source = opts.source;
    this.host = opts.host ?? GATEWAY_HOST;
    this.healthTimeoutMs = opts.healthTimeoutMs ?? 1000;
  }

  /** The cached validated leader, without touching the source. */
  current(): ValidatedLeader | undefined {
    return this.cached;
  }

  /**
   * The leader to route to now, or undefined when none validates. Concurrent
   * callers for the same file content share one /health check.
   */
  async resolve(): Promise<ValidatedLeader | undefined> {
    const leader = this.read();
    if (!leader) {
      this.cached = undefined;
      return undefined;
    }
    const key = JSON.stringify(leader);
    if (this.cached?.key === key) {
      this.lastValidAt = Date.now();
      return this.cached;
    }
    // The file moved on: whatever was cached is no longer the lock holder.
    this.cached = undefined;
    if (this.inflight?.key === key) return this.inflight.promise;
    const promise = this.validate(leader).then((verdict) => {
      if (this.inflight?.promise === promise) this.inflight = undefined;
      if (verdict !== "ok") return undefined;
      const validated = { leader, key };
      // A newer file may have been read while this check ran; only the
      // content that is still current may become the cached upstream.
      if (JSON.stringify(this.read()) === key) {
        this.cached = validated;
        this.lastValidAt = Date.now();
        return validated;
      }
      return undefined;
    });
    this.inflight = { key, promise };
    return promise;
  }

  /** Drops `leader` from the cache after a request against it failed. */
  invalidate(leader: ValidatedLeader): void {
    if (this.cached?.key === leader.key) this.cached = undefined;
  }

  /**
   * A fresh /health check of the current record even when it is cached: the
   * idle monitor uses it to notice a leader that died with no traffic flowing.
   * The cache keeps serving requests while the check runs, and only a
   * definite `gone` drops it: a slow /health from a busy leader does not.
   * Resolves true when the leader validated just now.
   */
  async check(): Promise<boolean> {
    const cached = this.cached;
    const leader = this.read();
    if (!cached || !leader || JSON.stringify(leader) !== cached.key) return (await this.resolve()) !== undefined;
    const verdict = await this.validate(leader);
    if (verdict === "ok") {
      this.lastValidAt = Date.now();
      return true;
    }
    if (verdict === "gone") this.invalidate(cached);
    return false;
  }

  private read(): LeaderInfo | undefined {
    try {
      const value = this.source();
      return isLeaderInfo(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }

  private async validate(leader: LeaderInfo): Promise<HealthVerdict> {
    let res: Response;
    try {
      res = await fetch(`http://${this.host}:${leader.httpPort}/health`, {
        signal: AbortSignal.timeout(this.healthTimeoutMs),
        keepalive: false,
      });
    } catch (err) {
      return (err as { code?: unknown } | null)?.code === "ConnectionRefused" ? "gone" : "inconclusive";
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return "gone";
    }
    try {
      const body = (await res.json()) as { pid?: unknown } | null;
      return body?.pid === leader.pid ? "ok" : "gone";
    } catch (err) {
      // A body that stalls past the timeout is a slow leader; one that
      // arrived but isn't JSON is not a collector's /health.
      return (err as { name?: unknown } | null)?.name === "TimeoutError" ? "inconclusive" : "gone";
    }
  }
}
