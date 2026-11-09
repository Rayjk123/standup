#!/usr/bin/env bun
/*
 * The console load-time check, in one command: load-time.measure.ts against a
 * production build, on a throwaway install (a scratch collector seeded with a
 * heavy owner's history, its own data dir, token, tmux socket and ports, no
 * gateway, review tunnels, digest, Slack or ntfy, and fake-claude.ts in place
 * of Claude), held to the budgets in load-budgets.ts. Nothing it runs reads or
 * writes the live install.
 *
 *   bun run perf:console                    5 cold loads (and their warm reloads), PASS/FAIL per budget
 *   bun run perf:console --runs 9           more loads per median
 *   bun run perf:console --serve-only       seed and serve, printing the console URL, a sign-in URL and
 *                                           the collector's pid, until SIGINT/SIGTERM (for a recording)
 *   bun run perf:console --keep             leave the scratch dir behind (its path is printed)
 *
 * Any other flag goes to load-time.measure.ts as it is: --mode dev, --dist <dir>, --throttle tunnel,
 * --screenshots <dir>, --json <file>, --web-port/--api-port/--ws-port N (each unset port is a free one
 * in 30000-31999). --seed none and --seed-<volume> N work only with --serve-only: the budgets hold
 * for the default volumes, so a measured run refuses any other.
 *
 * It exits 0 when every budget holds and 1 on any breach, with one `PASS <metric>: ...` or
 * `FAIL <metric>: ...` line per budget. A load that never became usable, a failed live-update check, a
 * page error, or the measurement itself failing (`FAIL measurement: <message>`) also exits 1. The ms
 * budget holds for the worst cold load, not the median; the byte budgets need the default seed volumes.
 *
 * The scratch dir is a fresh `mktemp -d` under /tmp. Playwright comes from STANDUP_PLAYWRIGHT_DIR (the
 * package dir, .../node_modules/playwright), else ${XDG_CACHE_HOME:-~/.cache}/standup/playwright/
 * node_modules/playwright; its browsers from PLAYWRIGHT_BROWSERS_PATH as Playwright itself reads it.
 */
import { existsSync, mkdtempSync, rmSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const args = process.argv.slice(2);
const has = (name: string) => args.includes(`--${name}`);
const keep = has("keep");
const passed = args.filter((a) => a !== "--keep");
const serveOnly = has("serve-only");

function playwrightDir(): string {
  const configured = process.env.STANDUP_PLAYWRIGHT_DIR?.trim();
  const cache = process.env.XDG_CACHE_HOME?.trim() || join(homedir(), ".cache");
  const dir = configured || join(cache, "standup/playwright/node_modules/playwright");
  if (!existsSync(join(dir, "package.json"))) {
    throw new Error(`no Playwright at ${dir}: set STANDUP_PLAYWRIGHT_DIR to a node_modules/playwright package dir`);
  }
  return dir;
}

// Resolved first, so a missing Playwright leaves no scratch dir behind.
const playwright = serveOnly ? undefined : playwrightDir();
const scratch = mkdtempSync("/tmp/standup-console-perf-");
const measure = join(import.meta.dir, "load-time.measure.ts");
const command = ["bun", measure, "--scratch", scratch];
if (playwright) command.push("--playwright", playwright, "--budgets");
if (!has("mode")) command.push("--mode", "prod");
if (!has("runs") && !serveOnly) command.push("--runs", "5");
command.push(...passed);
console.log(`scratch ${scratch}`);

const child = Bun.spawn(command, { stdio: ["inherit", "inherit", "inherit"] });
// A signal reaches the measurement, which stops its collector, console and
// browser itself and exits once the collector has; this process waits for
// that before removing the scratch dir.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (child.exitCode === null) child.kill(signal);
  });
}
const code = await child.exited;
if (keep) console.log(`kept ${scratch}`);
else rmSync(scratch, { recursive: true, force: true });
process.exit(code);
