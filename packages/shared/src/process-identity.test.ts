import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliPathsOf, commandLineOf, cwdOf, pidAlive, runsCliPath, runsDevScript, runsInstallDevScript, samePath, validPid } from "./process-identity.js";

describe("self-contained module", () => {
  test("imports only node:* modules", () => {
    const source = readFileSync(join(import.meta.dir, "process-identity.ts"), "utf8");
    const specifiers = [...source.matchAll(/^\s*import\b[^;]*?\bfrom\s+["']([^"']+)["']/gm)].map((m) => m[1]);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) expect(specifier).toStartWith("node:");
  });
});

describe("validPid", () => {
  test("accepts positive integers only", () => {
    expect(validPid(1)).toBe(true);
    for (const bad of [0, -1, 1.5, Number.NaN, "12", undefined, null]) expect(validPid(bad)).toBe(false);
  });
});

describe("pidAlive", () => {
  test("this process is alive; an unused pid and an invalid one are not", () => {
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(2 ** 22 + 12345)).toBe(false);
    expect(pidAlive(0)).toBe(false);
    expect(pidAlive(-1)).toBe(false);
  });
});

describe("commandLineOf", () => {
  test("reads a real process's arguments, and nothing once it has exited", async () => {
    const child = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
    try {
      expect(commandLineOf(child.pid)).toContain("sleep 30");
    } finally {
      child.kill("SIGKILL");
      await child.exited;
    }
    expect(commandLineOf(child.pid)).toBeUndefined();
    expect(commandLineOf(0)).toBeUndefined();
  });
});

describe("runsCliPath", () => {
  const cli = "/opt/standup/packages/gateway/src/cli.ts";
  test("matches the path only as a whole argument", () => {
    expect(runsCliPath(`/usr/bin/bun run ${cli}`, [cli])).toBe(true);
    expect(runsCliPath(`bun ${cli} --flag`, [cli])).toBe(true);
    expect(runsCliPath(cli, [cli])).toBe(true);
    expect(runsCliPath(`bun ${cli}x`, [cli])).toBe(false);
    expect(runsCliPath(`bun /other${cli}`, [cli])).toBe(false);
    expect(runsCliPath("bun run packages/gateway/src/cli.ts", [cli])).toBe(false);
    expect(runsCliPath("sleep 30", [cli])).toBe(false);
    expect(runsCliPath("anything", [""])).toBe(false);
  });

  test("any of several paths matches", () => {
    expect(runsCliPath(`bun ${cli}`, ["/elsewhere/cli.ts", cli])).toBe(true);
  });
});

describe("runsDevScript", () => {
  test("recognizes dev.ts run relatively or absolutely, and nothing else", () => {
    expect(runsDevScript("bun run scripts/dev.ts")).toBe(true);
    expect(runsDevScript("/home/u/.bun/bin/bun /opt/standup/scripts/dev.ts")).toBe(true);
    expect(runsDevScript("bun run scripts/dev-topology.ts")).toBe(false);
    expect(runsDevScript("bun run scripts/dev.tsx")).toBe(false);
    expect(runsDevScript("vim notes/dev.ts")).toBe(false);
  });
});

describe("runsInstallDevScript", () => {
  test("an absolute argument must be this install's dev.ts; the cwd is never asked", () => {
    const noCwd = () => {
      throw new Error("cwd asked");
    };
    expect(runsInstallDevScript("bun /opt/standup/scripts/dev.ts", "/opt/standup", noCwd)).toBe(true);
    expect(runsInstallDevScript("bun /opt/standup/scripts/dev.ts", "/opt/standup/", noCwd)).toBe(true);
    expect(runsInstallDevScript("bun /opt/other/scripts/dev.ts", "/opt/standup", noCwd)).toBe(false);
    expect(runsInstallDevScript("bun run scripts/dev-topology.ts", "/opt/standup", noCwd)).toBe(false);
    expect(runsInstallDevScript("sleep 30", "/opt/standup", noCwd)).toBe(false);
  });

  test("a relative argument is resolved against the process's cwd", () => {
    expect(runsInstallDevScript("bun run scripts/dev.ts", "/opt/standup", () => "/opt/standup")).toBe(true);
    expect(runsInstallDevScript("bun run scripts/dev.ts", "/opt/standup", () => "/opt/other")).toBe(false);
    expect(runsInstallDevScript("bun run ../standup/scripts/dev.ts", "/opt/standup", () => "/opt/other")).toBe(true);
    expect(runsInstallDevScript("bun run scripts/dev.ts", "/opt/standup", () => undefined)).toBeUndefined();
  });

  test("a symlinked install is the same install on either side", () => {
    const base = mkdtempSync(join(tmpdir(), "process-identity-"));
    try {
      const real = join(base, "real");
      mkdirSync(join(real, "scripts"), { recursive: true });
      writeFileSync(join(real, "scripts", "dev.ts"), "");
      const link = join(base, "link");
      symlinkSync(real, link);
      expect(runsInstallDevScript(`bun ${join(link, "scripts", "dev.ts")}`, real, () => undefined)).toBe(true);
      expect(runsInstallDevScript(`bun ${join(real, "scripts", "dev.ts")}`, link, () => undefined)).toBe(true);
      expect(runsInstallDevScript("bun run scripts/dev.ts", link, () => realpathSync(real))).toBe(true);
      expect(samePath(link, real)).toBe(true);
      expect(samePath(join(base, "missing"), real)).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("cwdOf", () => {
  test("reads a real process's working directory", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "process-identity-cwd-")));
    const child = Bun.spawn(["sleep", "30"], { cwd: dir, stdout: "ignore", stderr: "ignore" });
    try {
      const cwd = cwdOf(child.pid);
      expect(cwd === undefined || samePath(cwd, dir)).toBe(true);
      if (process.platform === "linux") expect(cwd).toBe(dir);
    } finally {
      child.kill("SIGKILL");
      await child.exited;
      rmSync(dir, { recursive: true, force: true });
    }
    expect(cwdOf(0)).toBeUndefined();
  });
});

describe("cliPathsOf", () => {
  test("is absolute and adds the realpath of a symlinked checkout", () => {
    const base = mkdtempSync(join(tmpdir(), "process-identity-"));
    try {
      const real = join(base, "real");
      mkdirSync(real);
      writeFileSync(join(real, "cli.ts"), "");
      const link = join(base, "link");
      symlinkSync(real, link);
      expect(cliPathsOf(join(link, "cli.ts"))).toEqual([join(link, "cli.ts"), join(realpathSync(real), "cli.ts")]);
      expect(cliPathsOf(join(realpathSync(real), "cli.ts"))).toEqual([join(realpathSync(real), "cli.ts")]);
      expect(cliPathsOf(join(base, "missing", "cli.ts"))).toEqual([join(base, "missing", "cli.ts")]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
