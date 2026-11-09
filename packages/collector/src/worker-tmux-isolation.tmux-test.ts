import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { workerTmuxSocket } from "@standup/shared/owner-token";
import { buildInteractiveLaunchArgv, paneTmuxDir, workerTmux } from "./tmux-launch.js";

/*
 * The teardown shape this guards: `TMUX_TMPDIR="$R/tmux" tmux kill-server`
 * in a pane with `$TMUX` set, which tmux follows over TMUX_TMPDIR, ends the
 * pane's whole server. A worker's pane runs on a server whose socket is in Standup's data
 * dir (`-S <dataDir>/tmux/workers`), with `$TMUX` and `$TMUX_PANE` removed
 * and TMUX_TMPDIR set to a dir of the launch's own, so a bare `tmux …` and a
 * `-L <name>` both reach servers in that dir.
 *
 * Real tmux, kept off every live server. Everything lives under one mkdtemp
 * dir (PRIV): the data dir is PRIV/data (DB_PATH), the test's clients run
 * with TMUX_TMPDIR=PRIV and no `$TMUX`, and the launch's dir is made under
 * PRIV (TMPDIR=PRIV). Every kill and
 * every check of a session the test makes itself names its socket with -S;
 * starting servers and the probes use -L or no socket, which resolve under
 * PRIV while it exists. Before any kill, a dry probe checks that each socket
 * a pane would reach is under PRIV. Every kill line a pane runs first reads
 * the socket it resolves to, refuses anything outside PRIV, and then kills by
 * that -S path, so a dir that goes away in between can't send it elsewhere.
 * A TMUX_TMPDIR that isn't a directory is never used for a kill: tmux skips
 * it for /tmp, where the default server is.
 *
 * Opt-in: the file name is outside `bun test`'s default glob, so a full
 * suite run never starts real tmux servers or kills them. Run it on purpose
 * with `bun run test:tmux` in packages/collector, which is
 * `env -u TMUX -u TMUX_PANE bun test ./src/worker-tmux-isolation.tmux-test.ts`.
 * The safety floor holds that run (its kills use computed -S sockets) for the
 * owner to review; session-scope.test.ts pins that.
 */

const hasTmux = Bun.which("tmux") !== null;
const uid = process.getuid?.() ?? 0;
const PRIV = mkdtempSync("/tmp/standup-worker-tmux-");
const savedTmpdir = process.env.TMPDIR;
const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: PRIV, TMUX_TMPDIR: PRIV, TERM: "xterm" };
process.env.DB_PATH = join(PRIV, "data", "standup.db");
const workersSocket = workerTmuxSocket();
const ownerSocket = join(PRIV, `tmux-${uid}`, "default");
let probeOk = false;

/** The launch argv for `id` running `harness`, with the launch's dir (paneTmuxDir) made under PRIV. */
function launchArgv(id: string, harness: string[]): { argv: string[]; dir: string } {
  process.env.TMPDIR = PRIV;
  try {
    const dir = paneTmuxDir(id);
    expect(dir.startsWith(`${PRIV}/`)).toBe(true);
    const argv = buildInteractiveLaunchArgv(id, PRIV, harness, id);
    expect(argv).toContain(`TMUX_TMPDIR=${dir}`);
    return { argv, dir };
  } finally {
    if (savedTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = savedTmpdir;
  }
}

/** A tmux argv for the test's own clients: never `$TMUX`, always under PRIV. */
function tmux(argv: string[]): number {
  return Bun.spawnSync(argv, { env, stdout: "ignore", stderr: "ignore" }).exitCode;
}

/** The socket path a tmux client with these args and `env` resolves to, read from display-message or its error. */
function resolvedSocket(argv: string[], withEnv: Record<string, string> = env): string {
  const res = Bun.spawnSync([...argv, "display-message", "-p", "#{socket_path}"], { env: withEnv, stdout: "pipe", stderr: "pipe" });
  const text = `${res.stdout?.toString() ?? ""}${res.stderr?.toString() ?? ""}`;
  return /(\/[^\s()]+)/.exec(text)?.[1] ?? `(unresolved: ${text.trim()})`;
}

/** The contents of `path` once something is written to it (a redirect creates it empty first). */
async function waitFor(path: string): Promise<string> {
  const read = () => (existsSync(path) ? readFileSync(path, "utf8").trim() : "");
  for (let i = 0; i < 100 && !read(); i++) await Bun.sleep(50);
  return read() || "(never written)";
}

/**
 * A shell line that reads the socket `tmux <args>` resolves to (display-message's
 * output, or the path in its "no server running on …" / "error connecting to …"
 * error) and, only when it is under PRIV, runs `tmux -S <that socket> <cmd>`,
 * writing `<tag>=<exit>` or `<tag>=refused:<what it read>`.
 */
function guarded(tag: string, args: string, cmd: string, out: string): string {
  return (
    `r=$(tmux ${args} display-message -p '#{socket_path}' 2>&1); p=\${r##* on }; p=\${p#error connecting to }; p=\${p%% (*}; ` +
    `case "$p" in "${PRIV}"/*) mkdir -p "\${p%/*}"; tmux -S "$p" ${cmd} 2>/dev/null; echo "${tag}=$?";; *) echo "${tag}=refused:$r";; esac >> ${out}`
  );
}

afterAll(() => {
  if (!hasTmux) return rmSync(PRIV, { recursive: true, force: true });
  const killServer = (socket: string) => Bun.spawnSync(["tmux", "-S", socket, "kill-server"], { env, stdout: "ignore", stderr: "ignore" });
  for (const socket of [workersSocket, ownerSocket]) killServer(socket);
  for (const id of ["probe", "w1", "w2"]) {
    const dir = join(PRIV, paneTmuxDir(id).split("/").pop()!);
    for (const name of ["default", "standup-workers"]) killServer(join(dir, `tmux-${uid}`, name));
  }
  rmSync(PRIV, { recursive: true, force: true });
});

describe.skipIf(!hasTmux)("a worker's tmux teardown can't reach the workers' server", () => {
  test("dry probe: every socket a test client and a worker pane resolve to is under the private dir", async () => {
    expect(workersSocket).toBe(join(PRIV, "data", "tmux", "workers"));
    expect(resolvedSocket(workerTmux())).toBe(workersSocket);
    expect(resolvedSocket(["tmux"])).toBe(ownerSocket);

    const out = join(PRIV, "probe.out");
    const script = [
      `echo "TMUX=\${TMUX:-unset} TMUX_PANE=\${TMUX_PANE:-unset} TMUX_TMPDIR=\${TMUX_TMPDIR:-unset}" > ${out}.env`,
      `tmux display-message -p '#{socket_path}' > ${out}.bare 2>&1`,
      `tmux -L standup-workers display-message -p '#{socket_path}' > ${out}.workers 2>&1`,
      "sleep 30",
    ].join("; ");
    const { argv, dir } = launchArgv("probe", ["sh", "-c", script]);
    expect(tmux(argv)).toBe(0);

    expect(await waitFor(`${out}.env`)).toBe(`TMUX=unset TMUX_PANE=unset TMUX_TMPDIR=${dir}`);
    const bare = await waitFor(`${out}.bare`);
    const workers = await waitFor(`${out}.workers`);
    expect(bare).toContain(join(dir, `tmux-${uid}`, "default"));
    expect(workers).toContain(join(dir, `tmux-${uid}`, "standup-workers"));
    for (const text of [bare, workers]) expect(/(\/[^\s()]+)/.exec(text)?.[1]?.startsWith(`${PRIV}/`)).toBe(true);
    Bun.spawnSync(["tmux", "-S", workersSocket, "kill-session", "-t", "=probe"], { env, stdout: "ignore", stderr: "ignore" });
    probeOk = true;
  });

  test("a TMUX_TMPDIR that isn't a directory resolves to /tmp, not to itself (read-only probe)", () => {
    const label = `standup-probe-${process.pid}-${Date.now()}`;
    const missing = { ...env, TMUX_TMPDIR: join(PRIV, "missing", "tmux") };
    // has-session on a label no server uses: it starts nothing and only reports the socket it looked for.
    const res = Bun.spawnSync(["tmux", "-L", label, "has-session"], { env: missing, stdout: "pipe", stderr: "pipe" });
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr?.toString() ?? "").toContain(`/tmp/tmux-${uid}/${label}`);
  });

  test("a bare and a -L standup-workers kill-server in a worker pane leave the workers' server running", async () => {
    if (!probeOk) throw new Error("the dry probe didn't pass, so no kill line runs");
    expect(tmux(["tmux", "-S", ownerSocket, "new-session", "-d", "-s", "owner", "sleep 30"])).toBe(0);
    const out = join(PRIV, "w1.out");
    mkdirSync(join(PRIV, "memload", "tmux"), { recursive: true });
    const script = [
      `echo "TMUX=\${TMUX:-unset}" > ${out}.env`,
      // A server of the worker's own, which its bare kill-server should end.
      guarded("decoy", "", "new-session -d -s decoy 'sleep 30'", `${out}.log`),
      // The incident line, with its TMUX_TMPDIR a directory under PRIV.
      `R=${join(PRIV, "memload")}; export TMUX_TMPDIR_SAVED="$TMUX_TMPDIR"; TMUX_TMPDIR="$R/tmux"; export TMUX_TMPDIR`,
      guarded("incident", "", "kill-server", `${out}.log`),
      'TMUX_TMPDIR="$TMUX_TMPDIR_SAVED"; export TMUX_TMPDIR',
      guarded("bare", "", "kill-server", `${out}.log`),
      guarded("workers", "-L standup-workers", "kill-server", `${out}.log`),
      `echo done >> ${out}.log`,
      "sleep 30",
    ].join("; ");
    const { argv, dir } = launchArgv("w1", ["sh", "-c", script]);
    expect(tmux(argv)).toBe(0);
    expect(tmux(launchArgv("w2", ["sleep", "30"]).argv)).toBe(0);

    expect(await waitFor(`${out}.env`)).toBe("TMUX=unset");
    for (let i = 0; i < 100 && !(existsSync(`${out}.log`) && readFileSync(`${out}.log`, "utf8").includes("done")); i++) await Bun.sleep(50);
    const log = readFileSync(`${out}.log`, "utf8");
    expect(log).not.toContain("refused");
    expect(log).toContain("decoy=0");
    expect(log).toContain("bare=0");

    // Both workers, the one that ran the teardown and its neighbour, are still there, and so is the owner's server.
    expect(tmux(["tmux", "-S", workersSocket, "has-session", "-t", "=w1"])).toBe(0);
    expect(tmux(["tmux", "-S", workersSocket, "has-session", "-t", "=w2"])).toBe(0);
    expect(tmux(["tmux", "-S", ownerSocket, "has-session", "-t", "=owner"])).toBe(0);
    // The bare kill-server reached the worker's own server, which held only its decoy.
    expect(tmux(["tmux", "-S", join(dir, `tmux-${uid}`, "default"), "has-session", "-t", "=decoy"])).not.toBe(0);
  });

  test("without the pane env, a kill-server from a pane ends every session on that pane's server", async () => {
    if (!probeOk) throw new Error("the dry probe didn't pass, so no kill line runs");
    const out = join(PRIV, "old.out");
    // The pre-fix shape: the pane keeps the `$TMUX` tmux sets.
    const script = [
      `echo "TMUX=\${TMUX:-unset}" > ${out}.env`,
      `case "$TMUX" in "${workersSocket}",*) tmux kill-server;; *) echo "refused:$TMUX" > ${out}.refused;; esac`,
      "sleep 30",
    ].join("; ");
    expect(tmux(["tmux", "-S", workersSocket, "new-session", "-d", "-s", "neighbour", "sleep 30"])).toBe(0);
    expect(tmux(["tmux", "-S", workersSocket, "new-session", "-d", "-s", "old", "sh", "-c", script])).toBe(0);
    expect(await waitFor(`${out}.env`)).toStartWith(`TMUX=${workersSocket},`);
    for (let i = 0; i < 100 && tmux(["tmux", "-S", workersSocket, "has-session", "-t", "=neighbour"]) === 0; i++) await Bun.sleep(50);
    expect(existsSync(`${out}.refused`)).toBe(false);
    expect(tmux(["tmux", "-S", workersSocket, "has-session", "-t", "=neighbour"])).not.toBe(0);
  });
});
