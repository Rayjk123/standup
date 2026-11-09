import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { join } from "path";
import { classifyToolCall } from "./classify.js";
import type { FloorVerdict } from "./gate.js";
import { buildLaunchFloorConfig } from "./launch.js";
import { config as harnessConfig, DATA, HOME, INSTALL, MIRRORS, probes, ROOT, VIRTUAL, WORKER_ENV } from "./scratch-harness.js";

/*
 * A worker's shell script in its own launch scratch dir cds into the
 * launch's worktree and runs scripts/zero-downtime-check.ts, a restart
 * rehearsal under a /tmp root the harness makes. The floor holds it, as an
 * ordinary or a HIGH RISK hold (its imported packages/shared/src/constants.ts
 * builds a `~/.local/share/standup/…` hint at load, which the floor reads as
 * naming Standup's data dir); it is never allowed outright. A script that climbs from the worktree to the live DB or
 * the owner token, and the same run from another launch's worktree, are
 * held as HIGH RISK too. The code read is this checkout's real source,
 * through the scratch harness's virtual worktree.
 */

const LAUNCH = "a1a1a1a1-0000-4000-8000-0000000000a1";
const SCRATCH = join(HOME, ".cache", "standup-scratch", LAUNCH);
const OTHER_WT = join(DATA, "worktrees", "standup", "landing-other-1");

const config = {
  ...buildLaunchFloorConfig(
    { launchId: LAUNCH, root: ROOT, workerToken: "x".repeat(64), replyPublicKey: "test" },
    { HOME, XDG_CACHE_HOME: join(HOME, ".cache"), DB_PATH: join(DATA, "standup.db"), STANDUP_INSTALL_DIR: INSTALL }
  ),
  floorPaths: harnessConfig.floorPaths,
};

/** The script the worker wrote, with `wt` and an extra line of its own. */
function script(wt: string, extra = ""): string {
  return `#!/bin/bash
set -u
wt=${wt}
out="$(dirname "$0")/rehearse"
mkdir -p "$out"
cd "$wt" || exit 2
${extra}
run() {
  local name="$1"; shift
  echo "== $name: $*"
  timeout 1800 bun run scripts/zero-downtime-check.ts --cleanup --with-migration --fill-db-mb 8192 --boot-timeout-s 3 "$@" > "$out/$name.log" 2>&1
  echo "exit=$?"
  grep -aE "A: (grew|the commit adds|restart .* done|took)|A: a new leader|userImpact" "$out/$name.log" | cut -c1-260 | head -8
}
run migrate-before-fix --from 46b824f2
run migrate-with-fix --from 3e7636dd
`;
}

const SCRIPTS: Record<string, string> = {
  "rehearse-migrate.sh": script(ROOT),
  "climbs-to-db.sh": script(ROOT, `cat "$wt/../../../standup.db" > "$out/db.copy"`),
  "reads-token.sh": script(ROOT, `cat "$wt/../../../secrets/owner.token"`),
  "other-launch.sh": script(OTHER_WT),
};

let savedEnvTmp: string | undefined;
let savedTmp: string | undefined;
beforeAll(() => {
  for (const [name, body] of Object.entries(SCRIPTS)) VIRTUAL[join(SCRATCH, name)] = body;
  savedEnvTmp = WORKER_ENV.TMPDIR;
  WORKER_ENV.TMPDIR = SCRATCH;
  savedTmp = process.env.TMPDIR;
  process.env.TMPDIR = SCRATCH;
});
afterAll(() => {
  for (const name of Object.keys(SCRIPTS)) delete VIRTUAL[join(SCRATCH, name)];
  WORKER_ENV.TMPDIR = savedEnvTmp!;
  if (savedTmp === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = savedTmp;
});
afterEach(() => MIRRORS.clear());

function shape(command: string): { action: string; reserved: boolean } {
  const v: FloorVerdict = classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd: ROOT }, config, probes());
  return { action: v.action, reserved: v.action === "hold" && v.ownerReserved === true };
}

describe("the restart rehearsal script", () => {
  test.each([
    ["through $TMPDIR", `bash "$TMPDIR/rehearse-migrate.sh"`],
    ["by its path", `bash ${join(SCRATCH, "rehearse-migrate.sh")}`],
  ])("is held, never allowed outright, %s", (_name, command) => {
    expect({ command, ...shape(command) }).toMatchObject({ command, action: "hold" });
  }, 300_000);

  test.each([
    ["a script that climbs from the worktree to the live DB", `bash "$TMPDIR/climbs-to-db.sh"`],
    ["a script that climbs from the worktree to the owner token", `bash "$TMPDIR/reads-token.sh"`],
  ])("%s is HIGH RISK", (_name, command) => {
    expect({ command, ...shape(command) }).toEqual({ command, action: "hold", reserved: true });
  }, 300_000);

  test("the same script run from another launch's worktree is HIGH RISK", () => {
    MIRRORS.add(OTHER_WT);
    expect(shape(`bash "$TMPDIR/other-launch.sh"`)).toEqual({ action: "hold", reserved: true });
  }, 300_000);
});
