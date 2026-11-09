/**
 * Identifying local processes before trusting or signalling them: whether a
 * pid is alive, its full command line, and whether that command line runs one
 * exact script path. A pid read from a record file may have been recycled by
 * an unrelated program, so the gateway, dev.ts and the redeploy check a
 * process's command line, not just its pid, before acting on it.
 *
 * Node-only, imported through the `@standup/shared/process-identity` subpath.
 * Self-contained, with only node:* imports, so Node can load it the same way
 * as topology.ts.
 */
import { spawnSync } from "node:child_process";
import { readlinkSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

/** Whether `pid` is a usable process id: a positive integer. */
export function validPid(pid: unknown): pid is number {
  return typeof pid === "number" && Number.isInteger(pid) && pid > 0;
}

/**
 * Whether `pid` exists (signal 0; EPERM still means it exists, under another
 * user). An exited but unreaped child reads as alive.
 */
export function pidAlive(pid: number): boolean {
  if (!validPid(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The full command line of `pid` from ps, or undefined when it isn't running or can't be read. */
export function commandLineOf(pid: number): string | undefined {
  if (!validPid(pid)) return undefined;
  try {
    const ps = spawnSync("ps", ["-ww", "-o", "args=", "-p", String(pid)], { encoding: "utf8", timeout: 2_000 });
    if (ps.status !== 0) return undefined;
    return ps.stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** `path` made absolute, plus its realpath when that differs (a symlinked checkout). */
export function cliPathsOf(path: string): string[] {
  const abs = resolve(path);
  try {
    const real = realpathSync(abs);
    return real === abs ? [abs] : [abs, real];
  } catch {
    return [abs];
  }
}

/** Whether `a` and `b` name the same path once made absolute, symlinks resolved where they exist. */
export function samePath(a: string, b: string): boolean {
  const ours = cliPathsOf(a);
  return cliPathsOf(b).some((p) => ours.includes(p));
}

/**
 * The working directory of `pid`: the /proc link on Linux, lsof elsewhere;
 * undefined when neither can tell.
 */
export function cwdOf(pid: number): string | undefined {
  if (!validPid(pid)) return undefined;
  try {
    return readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    // Not Linux, or not readable: fall back to lsof.
  }
  try {
    const lsof = spawnSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { encoding: "utf8", timeout: 2_000 });
    if (lsof.status !== 0) return undefined;
    const line = lsof.stdout.split("\n").find((l) => l.startsWith("n"));
    return line?.slice(1).trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether `cmdline` runs Standup's dev script (`bun run scripts/dev.ts`, from
 * the install dir, or with an absolute path). Any install's: see
 * runsInstallDevScript for one install's.
 */
export function runsDevScript(cmdline: string): boolean {
  return /(^|[\s/])scripts[/\\]dev\.ts(\s|$)/.test(cmdline);
}

const DEV_SCRIPT_ARG = /(^|[/\\])scripts[/\\]dev\.ts$/;

/**
 * Whether `cmdline` runs the dev script of the install at `installDir`: one
 * of its `…scripts/dev.ts` arguments is `<installDir>/scripts/dev.ts`, an
 * absolute argument compared directly and a relative one resolved against the
 * process's working directory (`cwd`, asked only when needed). Symlinks are
 * resolved on both sides. Undefined when only a relative argument names the
 * script and the working directory can't be read.
 */
export function runsInstallDevScript(cmdline: string, installDir: string, cwd: () => string | undefined): boolean | undefined {
  if (!runsDevScript(cmdline)) return false;
  const script = join(resolve(installDir), "scripts", "dev.ts");
  if (runsCliPath(cmdline, cliPathsOf(script))) return true;
  let unknown = false;
  let dir: string | undefined | null = null;
  for (const arg of cmdline.split(/\s+/)) {
    if (!DEV_SCRIPT_ARG.test(arg)) continue;
    if (isAbsolute(arg)) {
      if (samePath(arg, script)) return true;
      continue;
    }
    if (dir === null) dir = cwd();
    if (dir === undefined) unknown = true;
    else if (samePath(resolve(dir, arg), script)) return true;
  }
  return unknown ? undefined : false;
}

/** Whether `cmdline` passes one of `cliPaths` as a whole argument (not a prefix or suffix of a longer path). */
export function runsCliPath(cmdline: string, cliPaths: readonly string[]): boolean {
  for (const cliPath of cliPaths) {
    if (!cliPath) continue;
    let at = cmdline.indexOf(cliPath);
    while (at !== -1) {
      const before = at === 0 ? " " : cmdline[at - 1];
      const after = cmdline[at + cliPath.length] ?? " ";
      if (/\s/.test(before) && /\s/.test(after)) return true;
      at = cmdline.indexOf(cliPath, at + 1);
    }
  }
  return false;
}
