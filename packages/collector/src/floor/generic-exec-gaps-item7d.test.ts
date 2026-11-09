import { describe, expect, test } from "bun:test";
import { DATA, INSTALL, ROOT, bash, shape } from "./scratch-harness.js";

/*
 * An `--out`-style option names the file a program writes: it is no shell
 * redirect, and a value under /tmp or the worker's own worktree is the
 * worker's own ground. The same option naming the Standup data dir or the
 * install, and a real `>` redirect to either, still hold.
 */

const SHOTS = "/tmp/standup-screenshots-1000";

describe("an output option naming /tmp or the worktree", () => {
  const commands = [
    `bun scripts/pipeline-screenshot.ts http://127.0.0.1:5174/ --out ${SHOTS}/a.png`,
    "some-tool --out=/tmp/x.json",
    "some-tool --out /tmp/x.json",
    "some-tool --output /tmp/y",
    "tsc --outDir /tmp/z",
    "tsc -p . --outDir /tmp/z",
    "bun build x.ts --outfile /tmp/a.js",
    "bun build x.ts --outdir /tmp/dist",
    "git log --output=/tmp/l.txt",
    "git log -3 --output=/tmp/l.txt",
    `some-tool --out ${ROOT}/out.json`,
  ];
  for (const command of commands) {
    test(command, () => {
      expect({ command, verdict: shape(bash(command)) }).toEqual({ command, verdict: { action: "allow" } });
    });
  }
});

describe("an output option or redirect naming the data dir or the install still holds", () => {
  const commands = [
    `some-tool --out ${DATA}/x`,
    `some-tool --out=${DATA}/x`,
    `some-tool --out ~/.local/share/standup/x`,
    "some-tool --out=~/.local/share/standup/x",
    `bun build x.ts --outfile ${DATA}/a.js`,
    `bun build x.ts --outfile ${INSTALL}/a.js`,
    `bun build x.ts --outdir=${INSTALL}/dist`,
    `bun scripts/pipeline-screenshot.ts http://127.0.0.1:5174/ --out=${INSTALL}/a.png`,
    `git log --output=${DATA}/l.txt`,
    `echo hi > ${DATA}/x`,
    `echo hi > ${INSTALL}/x`,
    `some-tool --out /tmp/x.json > ${DATA}/x`,
    `bun scripts/pipeline-screenshot.ts http://127.0.0.1:5174/ --out ${DATA}/a.png`,
    `bun scripts/pipeline-screenshot.ts http://127.0.0.1:5174/ --out ${INSTALL}/a.png`,
  ];
  for (const command of commands) {
    test(command, () => {
      expect({ command, action: bash(command).action }).toEqual({ command, action: "hold" });
    });
  }
});
