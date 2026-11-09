import type { ProcessRow, ProcessSystem, TunnelHost } from "./process-registry.js";

/**
 * An in-memory ProcessSystem: a process table the test sets, signals recorded
 * instead of sent. A SIGTERM'd process exits unless listed in `ignoresTerm`;
 * SIGKILL always ends it. Signalling a group ends every member.
 */
export class FakeProcessSystem implements ProcessSystem {
  selfPid: number;
  rows: ProcessRow[];
  signals: Array<{ target: number; sig: NodeJS.Signals }> = [];
  stoppedUnits: string[] = [];
  /** Units whose stop fails. */
  failingUnits = new Set<string>();
  /** Pids that survive SIGTERM. */
  ignoresTerm = new Set<number>();
  sleeps: number[] = [];
  /** Each worker tmux session's pane pid. */
  panes = new Map<string, number>();
  /** The tunnel service; unset, none is listed. */
  tunnels?: TunnelHost;
  private readonly ownUid: number;

  constructor(rows: ProcessRow[] = [], opts: { selfPid?: number; uid?: number } = {}) {
    this.rows = rows.map((r) => ({ ...r }));
    this.selfPid = opts.selfPid ?? 4000;
    this.ownUid = opts.uid ?? 1000;
  }

  processTable = (): ProcessRow[] | null => this.rows.map((r) => ({ ...r }));

  argsOf = (pid: number): string | null => this.rows.find((r) => r.pid === pid)?.args.trim() ?? null;

  startedOf = (pid: number): number | null => this.rows.find((r) => r.pid === pid)?.started ?? null;

  panePid = (tmuxSession: string): number | null => this.panes.get(tmuxSession) ?? null;

  isAlive = (target: number): boolean =>
    target < 0 ? this.rows.some((r) => r.pgid === -target) : this.rows.some((r) => r.pid === target);

  signal = (target: number, sig: NodeJS.Signals): boolean => {
    this.signals.push({ target, sig });
    const hit = this.rows.filter((r) => (target < 0 ? r.pgid === -target : r.pid === target));
    if (hit.length === 0) return false;
    if (sig === "SIGKILL" || sig === "SIGTERM") {
      const ends = hit.filter((r) => sig === "SIGKILL" || !this.ignoresTerm.has(r.pid)).map((r) => r.pid);
      this.rows = this.rows.filter((r) => !ends.includes(r.pid));
    }
    return true;
  };

  stopUnit = async (unit: string): Promise<boolean> => {
    this.stoppedUnits.push(unit);
    return !this.failingUnits.has(unit);
  };

  uid = (): number => this.ownUid;

  sleep = async (ms: number): Promise<void> => {
    this.sleeps.push(ms);
  };

  /** Replaces `pid`'s command line, as if the pid had been reused. */
  reuse(pid: number, args: string, started?: number): void {
    const row = this.rows.find((r) => r.pid === pid);
    if (!row) return;
    row.args = args;
    if (started !== undefined) row.started = started;
  }
}
