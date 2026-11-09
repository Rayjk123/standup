import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { scratchDataDirBase } from "@standup/store";
import { runStep } from "./launcher.js";

/**
 * A launch step's timeout has to end the step even when something the step
 * started outlives it or holds its output pipes. Every process these tests
 * start writes its own pid to a file; liveness is checked, and cleanup done,
 * only for those recorded pids.
 */

// A base short enough for the tmux socket made under it.
const root = mkdtempSync(join(scratchDataDirBase("launcher-step-timeout-"), "launcher-step-timeout-"));
/** Recorded pids, each with its start time so a reused pid is never mistaken for it. */
const recorded = new Map<number, string>();
const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, TMUX_TMPDIR: root };

/** The /proc/<pid>/stat fields after the parenthesised command name (field 3 onward), or null once it's gone. */
function statFields(pid: number): string[] | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  } catch {
    return null;
  }
}

/** Records `pid` for cleanup, keyed to the process that holds it now. */
function record(pid: number): void {
  const fields = statFields(pid);
  if (fields) recorded.set(pid, fields[19]!);
}

/** Reads the pids a step wrote to `file`, one per line, and records them for cleanup. */
function pidsFrom(file: string): number[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .map((line) => parseInt(line.trim()))
    .filter((pid) => pid > 0);
}

/** True while `pid` is a running (not zombie) process. */
function alive(pid: number): boolean {
  const fields = statFields(pid);
  return fields !== null && fields[0] !== "Z";
}

/** The process group and session `pid` belongs to. */
function groupAndSession(pid: number): { pgrp: number; sid: number } {
  const fields = statFields(pid)!;
  return { pgrp: parseInt(fields[2]!), sid: parseInt(fields[3]!) };
}

async function waitUntilDead(pids: number[], withinMs: number): Promise<number[]> {
  const deadline = Date.now() + withinMs;
  for (;;) {
    const living = pids.filter(alive);
    if (living.length === 0 || Date.now() > deadline) return living;
    await Bun.sleep(25);
  }
}

afterAll(() => {
  for (const [pid, startTime] of recorded) {
    if (!alive(pid) || statFields(pid)?.[19] !== startTime) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  rmSync(root, { recursive: true, force: true });
});

describe("runStep", () => {
  test("a timeout kills the step's whole process group, including a backgrounded grandchild", async () => {
    const pidFile = join(root, "group.pids");
    const script = `sleep 600 & echo $! >> '${pidFile}'; echo $$ >> '${pidFile}'; exec sleep 600`;
    const started = Date.now();
    const result = await runStep(["/bin/sh", "-c", script], { cwd: root, env, timeoutMs: 200 });
    const elapsed = Date.now() - started;

    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.output).toContain("timed out");
    expect(elapsed).toBeLessThan(3000);

    const pids = pidsFrom(pidFile);
    for (const pid of pids) record(pid);
    expect(pids).toHaveLength(2);
    expect(await waitUntilDead(pids, 1000)).toEqual([]);
  });

  test("a throwing output handler abandons the step and kills its group", async () => {
    const pidFile = join(root, "abandoned.pids");
    const script = `echo $$ >> '${pidFile}'; echo started; exec sleep 600`;
    const step = runStep(["/bin/sh", "-c", script], {
      cwd: root,
      env,
      timeoutMs: 60_000,
      onChunk: () => {
        throw new Error("log store closed");
      },
    });
    await expect(step).rejects.toThrow("log store closed");

    const pids = pidsFrom(pidFile);
    for (const pid of pids) record(pid);
    expect(pids).toHaveLength(1);
    expect(await waitUntilDead(pids, 1000)).toEqual([]);
  });

  test("a step that ignores SIGTERM is SIGKILLed after the grace period", async () => {
    const pidFile = join(root, "stubborn.pids");
    const script = `trap '' TERM; echo $$ >> '${pidFile}'; while :; do sleep 1; done`;
    const started = Date.now();
    const result = await runStep(["/bin/sh", "-c", script], { cwd: root, env, timeoutMs: 200 });

    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(4500);
    const pids = pidsFrom(pidFile);
    for (const pid of pids) record(pid);
    expect(await waitUntilDead(pids, 1000)).toEqual([]);
  });

  test("a descendant that escaped the group and holds the pipe can't keep a finished step pending", async () => {
    const pidFile = join(root, "escaped.pids");
    const script = `setsid sh -c 'echo $$ >> "${pidFile}"; exec sleep 600' & sleep 0.2; echo done`;
    const started = Date.now();
    const result = await runStep(["/bin/sh", "-c", script], { cwd: root, env, timeoutMs: 60_000 });

    expect(result.ok).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.output).toBe("done");
    expect(Date.now() - started).toBeLessThan(5000);
    // It escaped on purpose, so the step leaves it alone; cleanup kills it.
    const escaped = pidsFrom(pidFile);
    expect(escaped).toHaveLength(1);
    for (const pid of escaped) record(pid);
  });

  test("reports output and exit status, streaming chunks as they arrive", async () => {
    const chunks: string[] = [];
    const ok = await runStep(["/bin/sh", "-c", "echo out; echo err >&2"], {
      cwd: root,
      env,
      onChunk: (chunk) => chunks.push(chunk),
    });
    expect(ok).toEqual({ ok: true, output: expect.stringContaining("out"), timedOut: false });
    expect(ok.output).toContain("err");
    expect(chunks.join("")).toContain("out");

    const failed = await runStep(["/bin/sh", "-c", "exit 3"], { cwd: root, env });
    expect(failed).toEqual({ ok: false, output: "", timedOut: false });
  });

  // A tmux bootstrap runs through the same step runner. Its server must not be
  // in the step's process group, or a timed-out `new-session` would take every
  // pane down with it.
  const hasTmux = Bun.spawnSync(["which", "tmux"]).exitCode === 0;
  test.skipIf(!hasTmux)("the tmux server a step starts daemonizes out of the step's process group", async () => {
    const socket = join(root, "tmux.sock");
    const tmux = (...args: string[]) =>
      Bun.spawnSync(["tmux", "-S", socket, ...args], { env, cwd: root });

    try {
      const result = await runStep(["tmux", "-S", socket, "new-session", "-d", "-s", "step-test", "sleep 600"], {
        cwd: root,
        env,
        timeoutMs: 10_000,
      });
      expect(result.ok).toBe(true);

      // Read-only probe: the server answering is the one on the private socket.
      expect(tmux("display-message", "-p", "#{socket_path}").stdout.toString().trim()).toBe(socket);
      const serverPid = parseInt(tmux("display-message", "-p", "#{pid}").stdout.toString().trim());
      expect(serverPid).toBeGreaterThan(0);
      record(serverPid);

      const { pgrp, sid } = groupAndSession(serverPid);
      expect(sid).toBe(serverPid);
      expect(pgrp).toBe(serverPid);
    } finally {
      tmux("kill-server");
    }
  });
});
