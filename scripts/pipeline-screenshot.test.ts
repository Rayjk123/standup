import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "fs/promises";
import { existsSync, readFileSync, realpathSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { pathToFileURL } from "url";
import { collectorPortSet } from "../packages/shared/src/topology";
import {
  CHROMIUM_ARGS,
  CONTEXT_OPTIONS,
  SETUP_STEPS,
  checkOutPath,
  defaultOutDir,
  defaultPlaywrightDir,
  installHint,
  installNetworkGuard,
  installRoot,
  parseArgs,
  placeOutput,
  playwrightDir,
  playwrightDirRefusal,
  prepareOutDir,
  resolvePlaywright,
  runSetup,
  setupEnv,
  stagingPath,
  unsafeDirReason,
  urlRefusal,
  userSymlinkOn,
  webSocketRefusal,
} from "./pipeline-screenshot";
import type { GuardContext } from "./pipeline-screenshot";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "standup-shot-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("pipeline-screenshot parseArgs", () => {
  test("applies defaults", () => {
    expect(parseArgs(["http://localhost:5173/", "--out", "/tmp/shots/a.png"])).toEqual({
      url: "http://localhost:5173/",
      out: "/tmp/shots/a.png",
      width: 1440,
      height: 900,
      fullPage: false,
      waitFor: undefined,
      waitMs: 0,
    });
  });

  test("--out is optional", () => {
    expect(parseArgs(["http://localhost:5173/"]).out).toBeUndefined();
  });

  test("reads every flag in any order", () => {
    const args = parseArgs([
      "--width", "1280", "--full-page", "http://127.0.0.1/", "--height", "600",
      "--wait-for", "[data-testid=dag]", "--wait-ms", "250", "--out", "/tmp/b.PNG",
    ]);
    expect(args).toEqual({
      url: "http://127.0.0.1/",
      out: "/tmp/b.PNG",
      width: 1280,
      height: 600,
      fullPage: true,
      waitFor: "[data-testid=dag]",
      waitMs: 250,
    });
  });

  test("refuses a relative or non-png --out", () => {
    expect(() => parseArgs(["http://localhost/", "--out", "shots/a.png"])).toThrow(/absolute/);
    expect(() => parseArgs(["http://localhost/", "--out", "/tmp/a.jpg"])).toThrow(/\.png/);
  });

  test("shoots desktop viewports only: no phone or tablet widths", () => {
    for (const width of ["390", "414", "768", "1023"]) {
      expect(() => parseArgs(["http://x/", "--out", "/tmp/a.png", "--width", width])).toThrow(/--width must be at least 1024/);
    }
    expect(parseArgs(["http://x/", "--out", "/tmp/a.png", "--width", "1024"]).width).toBe(1024);
  });

  test("rejects missing pieces and bad values", () => {
    expect(() => parseArgs(["--out", "/tmp/a.png"])).toThrow(/missing URL/);
    expect(() => parseArgs(["http://x/", "--out"])).toThrow(/needs a value/);
    expect(() => parseArgs(["http://x/", "--out", "/tmp/a.png", "--width", "0"])).toThrow(/positive integer/);
    expect(() => parseArgs(["http://x/", "--out", "/tmp/a.png", "--wait-ms", "-1"])).toThrow(/non-negative/);
    expect(() => parseArgs(["http://x/", "--out", "/tmp/a.png", "--bogus"])).toThrow(/unknown flag/);
    expect(() => parseArgs(["http://x/", "--allow-remote"])).toThrow(/unknown flag/);
    expect(() => parseArgs(["http://x/", "http://y/", "--out", "/tmp/a.png"])).toThrow(/extra argument/);
  });
});

describe("pipeline-screenshot urlRefusal", () => {
  test("allows loopback http(s) on any port and data: URLs", () => {
    for (const u of [
      "http://localhost:5173/x",
      "https://localhost/",
      "http://127.0.0.1:15173/?view=ui",
      "http://[::1]:8080/",
      "http://LOCALHOST/",
      "data:text/html,<p>hi</p>",
    ]) {
      expect(urlRefusal(u, [])).toBeNull();
    }
  });

  test("refuses remote hosts, lookalikes and other schemes", () => {
    expect(urlRefusal("https://example.com/?d=secret", [])).toMatch(/not local/);
    expect(urlRefusal("http://localhost.evil.test/", [])).toMatch(/not local/);
    expect(urlRefusal("http://127.0.0.2/", [])).toMatch(/not local/);
    expect(urlRefusal("http://user@example.com@localhost.evil/", [])).toMatch(/not local/);
    expect(urlRefusal("ftp://localhost/", [])).toMatch(/can't be captured/);
    expect(urlRefusal("javascript:alert(1)", [])).toMatch(/can't be captured/);
    expect(urlRefusal("not a url", [])).toMatch(/not a valid URL/);
  });

  test("allows file: URLs only under the roots, by realpath", async () => {
    await withTempDir(async (dir) => {
      const root = realpathSync(dir);
      const inside = join(root, "page.html");
      await writeFile(inside, "<p>hi</p>");
      expect(urlRefusal(pathToFileURL(inside).href, [root])).toBeNull();
      expect(urlRefusal(pathToFileURL(inside).href, ["/nonexistent-root"])).toMatch(/outside the screenshot roots/);
      expect(urlRefusal(pathToFileURL(join(root, "absent.html")).href, [root])).toMatch(/does not exist/);
      // A symlink inside the root that points out of it is judged by its target.
      const other = await mkdtemp(join(tmpdir(), "standup-shot-other-"));
      try {
        await writeFile(join(other, "x.html"), "x");
        const sub = join(root, "sub");
        await mkdir(sub);
        await symlink(join(other, "x.html"), join(sub, "link.html"));
        expect(urlRefusal(pathToFileURL(join(sub, "link.html")).href, [sub])).toMatch(/outside the screenshot roots/);
      } finally {
        await rm(other, { recursive: true, force: true });
      }
    });
  });
});

describe("pipeline-screenshot webSocketRefusal", () => {
  test("allows ws(s) on loopback only", () => {
    for (const u of ["ws://localhost:5173/ws", "wss://127.0.0.1/", "ws://[::1]:9/", "ws://LocalHost/"]) {
      expect(webSocketRefusal(u)).toBeNull();
    }
    expect(webSocketRefusal("wss://echo.example.com/")).toMatch(/not local/);
    expect(webSocketRefusal("ws://93.184.216.34/")).toMatch(/not local/);
    expect(webSocketRefusal("ws://localhost.evil.test/")).toMatch(/not local/);
    expect(webSocketRefusal("http://localhost/")).toMatch(/can't be opened/);
    expect(webSocketRefusal("nope")).toMatch(/not a valid URL/);
  });
});

describe("pipeline-screenshot keeps the capture off the collector", () => {
  const collector = [...collectorPortSet({})];

  test("every collector port (public HTTP and WebSocket, which the gateway serves, and each slot's) is refused for pages, subrequests and WebSockets", () => {
    expect(collector.length).toBeGreaterThanOrEqual(6);
    for (const port of collector) {
      for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
        expect(urlRefusal(`http://${host}:${port}/api/asks`, [])).toMatch(/collector/);
        expect(urlRefusal(`https://${host}:${port}/`, [])).toMatch(/collector/);
        expect(webSocketRefusal(`ws://${host}:${port}/ws`)).toMatch(/collector/);
      }
    }
  });

  test("ports moved by COLLECTOR_PORT / WS_PORT are refused, and the console stays reachable", () => {
    const moved = collectorPortSet({ COLLECTOR_PORT: "17790", WS_PORT: "17791" });
    expect(urlRefusal("http://localhost:17790/api/asks", [], moved)).toMatch(/collector/);
    expect(webSocketRefusal("ws://localhost:17791/", moved)).toMatch(/collector/);
    for (const page of ["http://localhost:5173/", "http://127.0.0.1:5397/review", "http://localhost:15173/"]) {
      expect(urlRefusal(page, [])).toBeNull();
    }
  });

  test("the network guard refuses a subrequest or redirect to the collector", async () => {
    const calls: string[] = [];
    const ctx: { routeHandler?: (r: unknown) => Promise<void> | void } = {};
    const context = {
      route: async (_u: string, h: (r: never) => Promise<void> | void) => {
        ctx.routeHandler = h as (r: unknown) => Promise<void> | void;
      },
      routeWebSocket: async () => {},
      on: () => undefined,
    };
    await installNetworkGuard(context as unknown as GuardContext, [], () => true);
    const port = [...collectorPortSet()][0]!;
    const route = (url: string) => ({ request: () => ({ url: () => url }), abort: async () => void calls.push(`abort ${url}`), continue: async () => void calls.push(`continue ${url}`) });
    await ctx.routeHandler!(route(`http://127.0.0.1:${port}/api/floor/hold`));
    await ctx.routeHandler!(route("http://localhost:5173/app.js"));
    expect(calls).toEqual([`abort http://127.0.0.1:${port}/api/floor/hold`, "continue http://localhost:5173/app.js"]);
  });
});

describe("pipeline-screenshot network guard", () => {
  function fakeContext() {
    const ctx = {
      routeHandler: null as null | ((r: any) => unknown),
      wsHandler: null as null | ((w: any) => unknown),
      wsPattern: null as RegExp | null,
      pageHandler: null as null | ((p: any) => void),
      route: async (_url: string, h: (r: any) => unknown) => { ctx.routeHandler = h; },
      routeWebSocket: async (pattern: RegExp, h: (w: any) => unknown) => { ctx.wsPattern = pattern; ctx.wsHandler = h; },
      on: (_event: string, h: (p: any) => void) => { ctx.pageHandler = h; },
    };
    return ctx;
  }

  test("aborts remote requests, closes remote WebSockets and stray pages", async () => {
    const ctx = fakeContext();
    const refused: string[] = [];
    const capture = { close: async () => {}, closed: false };
    await installNetworkGuard(ctx as unknown as GuardContext, [], (p) => p === capture, (url) => refused.push(url));

    const calls: string[] = [];
    const route = (url: string) => ({
      request: () => ({ url: () => url }),
      abort: async () => { calls.push(`abort ${url}`); },
      continue: async () => { calls.push(`continue ${url}`); },
    });
    await ctx.routeHandler!(route("http://127.0.0.1:9/app.js"));
    await ctx.routeHandler!(route("https://example.com/beacon?d=x"));
    expect(calls).toEqual(["continue http://127.0.0.1:9/app.js", "abort https://example.com/beacon?d=x"]);

    expect(ctx.wsPattern!.test("wss://anything/")).toBe(true);
    const ws = (url: string) => ({
      url: () => url,
      close: () => { calls.push(`close ${url}`); },
      connectToServer: () => { calls.push(`connect ${url}`); },
    });
    await ctx.wsHandler!(ws("ws://localhost:9/live"));
    await ctx.wsHandler!(ws("wss://93.184.216.34/exfil"));
    expect(calls.slice(2)).toEqual(["connect ws://localhost:9/live", "close wss://93.184.216.34/exfil"]);
    expect(refused).toEqual(["https://example.com/beacon?d=x", "wss://93.184.216.34/exfil"]);

    const popup = { closed: false, close: async () => { popup.closed = true; } };
    ctx.pageHandler!(capture);
    ctx.pageHandler!(popup);
    expect(popup.closed).toBe(true);
    expect(capture.closed).toBe(false);
  });

  test("Chromium resolves only localhost, keeps WebRTC off UDP and blocks service workers", () => {
    expect(CHROMIUM_ARGS).toContain("--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1");
    expect(CHROMIUM_ARGS).toContain("--force-webrtc-ip-handling-policy=disable_non_proxied_udp");
    expect(CONTEXT_OPTIONS.serviceWorkers).toBe("block");
  });
});

describe("pipeline-screenshot directories", () => {
  test("the Playwright install defaults to the per-user cache", () => {
    expect(defaultPlaywrightDir({}, "/home/u")).toBe("/home/u/.cache/standup/playwright");
    expect(defaultPlaywrightDir({ XDG_CACHE_HOME: "/var/cache/u" }, "/home/u")).toBe("/var/cache/u/standup/playwright");
    expect(defaultPlaywrightDir({ XDG_CACHE_HOME: "relative" }, "/home/u")).toBe("/home/u/.cache/standup/playwright");
  });

  test("the install hint is the helper's own --setup, not a shell line", () => {
    const hint = installHint("/home/u/.cache/standup/playwright", "/opt/standup/scripts/pipeline-screenshot.ts");
    expect(hint).toStartWith('bun "/opt/standup/scripts/pipeline-screenshot.ts" --setup');
    expect(hint).toContain("/home/u/.cache/standup/playwright");
    expect(hint).not.toContain("bun add");
    expect(hint).not.toContain("&&");
  });

  test("the default output directory is per-uid", () => {
    expect(defaultOutDir(1000)).toBe("/tmp/standup-screenshots-1000");
  });

  test("unsafeDirReason refuses group/world-writable, foreign-owned and missing dirs", async () => {
    await withTempDir(async (dir) => {
      const uid = process.getuid!();
      await chmod(dir, 0o755);
      expect(unsafeDirReason(dir, uid)).toBeNull();
      expect(unsafeDirReason(dir, uid, 0o700)).toMatch(/expected 700/);
      await chmod(dir, 0o775);
      expect(unsafeDirReason(dir, uid)).toMatch(/group- or world-writable/);
      await chmod(dir, 0o707);
      expect(unsafeDirReason(dir, uid)).toMatch(/group- or world-writable/);
      await chmod(dir, 0o700);
      expect(unsafeDirReason(dir, uid + 1)).toMatch(/owned by uid/);
      expect(unsafeDirReason(join(dir, "absent"), uid)).toMatch(/does not exist/);
      await writeFile(join(dir, "f"), "");
      expect(unsafeDirReason(join(dir, "f"), uid)).toMatch(/not a directory/);
    });
  });

  test("prepareOutDir creates a missing directory 0700 and refuses an unsafe one", async () => {
    await withTempDir(async (dir) => {
      const uid = process.getuid!();
      const fresh = join(dir, "fresh");
      expect(prepareOutDir(join(fresh, "a.png"), uid)).toBe(fresh);
      expect(statSync(fresh).mode & 0o777).toBe(0o700);
      const shared = join(dir, "shared");
      await mkdir(shared);
      await chmod(shared, 0o777);
      expect(() => prepareOutDir(join(shared, "a.png"), uid)).toThrow(/group- or world-writable/);
    });
  });
});

describe("pipeline-screenshot output placement", () => {
  test("installRoot is the realpath of the directory above scripts/", async () => {
    await withTempDir(async (dir) => {
      await mkdir(join(dir, "install", "scripts"), { recursive: true });
      await symlink(join(dir, "install"), join(dir, "alias"));
      expect(installRoot(join(dir, "alias", "scripts"))).toBe(realpathSync(join(dir, "install")));
    });
  });

  test("checkOutPath refuses a target inside the install, however its dir is reached, and a non-file at the target", async () => {
    await withTempDir(async (dir) => {
      const install = join(dir, "install");
      await mkdir(join(install, "scripts"), { recursive: true });
      await mkdir(join(dir, "shots"));
      await symlink(join(install, "scripts"), join(dir, "shots", "into"));
      const root = realpathSync(install);
      expect(checkOutPath(join(dir, "shots", "a.png"), root)).toBeNull();
      expect(checkOutPath(join(install, "a.png"), root)).toMatch(/inside the Standup install/);
      expect(checkOutPath(join(dir, "shots", "into", "a.png"), root)).toMatch(/inside the Standup install/);
      await symlink(join(install, "scripts", "x.ts"), join(dir, "shots", "link.png"));
      expect(checkOutPath(join(dir, "shots", "link.png"), root)).toMatch(/not a regular file/);
      await mkdir(join(dir, "shots", "d.png"));
      expect(checkOutPath(join(dir, "shots", "d.png"), root)).toMatch(/not a regular file/);
      await writeFile(join(dir, "shots", "old.png"), "old");
      expect(checkOutPath(join(dir, "shots", "old.png"), root)).toBeNull();
      // A dir not made yet is judged by where it would land, so it is checked before anything is created.
      expect(checkOutPath(join(dir, "absent", "a.png"), root)).toBeNull();
      expect(checkOutPath(join(install, "scripts", "new", "deeper", "a.png"), root)).toMatch(/inside the Standup install/);
      expect(checkOutPath(join(dir, "shots", "into", "new", "a.png"), root)).toMatch(/inside the Standup install/);
    });
  });

  test("checkOutPath refuses /proc and /dev targets, which may stand for any other place", () => {
    for (const out of ["/proc/self/cwd/a.png", "/proc/self/root/tmp/a.png", "/dev/shm/a.png", "/dev/stdout"]) {
      expect(checkOutPath(out, "/nonexistent-install")).toMatch(/under \/proc or \/dev/);
    }
  });

  test("placeOutput renames over a regular file and replaces nothing else", async () => {
    await withTempDir(async (dir) => {
      const out = join(dir, "a.png");
      const staged = stagingPath(out);
      expect(staged.startsWith(join(dir, ".capture-"))).toBe(true);
      expect(staged.endsWith(".png")).toBe(true);
      await writeFile(staged, "new");
      placeOutput(staged, out);
      expect(readFileSync(out, "utf8")).toBe("new");
      const again = stagingPath(out);
      await writeFile(again, "newer");
      placeOutput(again, out);
      expect(readFileSync(out, "utf8")).toBe("newer");

      const victim = join(dir, "victim.ts");
      await writeFile(victim, "floor code");
      const link = join(dir, "link.png");
      await symlink(victim, link);
      const third = stagingPath(link);
      await writeFile(third, "capture");
      expect(() => placeOutput(third, link)).toThrow(/not a regular file/);
      expect(readFileSync(victim, "utf8")).toBe("floor code");
      expect(existsSync(third)).toBe(false);
    });
  });

  test("a symlinked output dir, or one under a symlink, is refused", async () => {
    await withTempDir(async (dir) => {
      const uid = process.getuid!();
      await mkdir(join(dir, "real"), { mode: 0o700 });
      await symlink(join(dir, "real"), join(dir, "linked"));
      expect(userSymlinkOn(join(dir, "linked", "a.png"))).toBe(join(dir, "linked"));
      expect(userSymlinkOn(join(dir, "real", "a.png"))).toBeNull();
      expect(() => prepareOutDir(join(dir, "linked", "a.png"), uid)).toThrow(/is a symlink/);
      expect(() => prepareOutDir(join(dir, "linked", "sub", "a.png"), uid)).toThrow(/is a symlink/);
      expect(existsSync(join(dir, "real", "sub"))).toBe(false);
      expect(unsafeDirReason(join(dir, "linked"), uid)).toMatch(/is a symlink/);
    });
  });
});

describe("pipeline-screenshot Playwright dir and --setup", () => {
  test("playwrightDir honours STANDUP_PLAYWRIGHT_DIR, else the per-user cache", () => {
    expect(playwrightDir({ STANDUP_PLAYWRIGHT_DIR: "/opt/pw" })).toBe("/opt/pw");
    expect(playwrightDir({ XDG_CACHE_HOME: "/var/cache/u" })).toBe("/var/cache/u/standup/playwright");
  });

  test("a Playwright dir that is a symlink, dangling or not, or under one, is refused", async () => {
    await withTempDir(async (dir) => {
      const uid = process.getuid!();
      await mkdir(join(dir, "elsewhere"), { mode: 0o700 });
      await symlink(join(dir, "elsewhere"), join(dir, "pw"));
      await symlink(join(dir, "missing"), join(dir, "dangling"));
      expect(playwrightDirRefusal(join(dir, "pw"), uid)).toMatch(/is a symlink/);
      expect(playwrightDirRefusal(join(dir, "dangling"), uid)).toMatch(/is a symlink/);
      expect(playwrightDirRefusal(join(dir, "pw", "inner"), uid)).toMatch(/is a symlink/);
      expect(playwrightDirRefusal(join(dir, "absent"), uid)).toBeNull();
      expect(playwrightDirRefusal(join(dir, "elsewhere"), uid)).toBeNull();
    });
  });

  test("the setup environment drops what changes what Bun installs or where", () => {
    const env = setupEnv("/home/u/.cache/standup/playwright", { PATH: "/usr/bin", HOME: "/home/u", BUN_OPTIONS: "--preload=/tmp/x.ts", NODE_OPTIONS: "-r x", npm_config_registry: "http://evil", PLAYWRIGHT_BROWSERS_PATH: "/tmp/b", XDG_CACHE_HOME: "/var/cache/u", BUN_INSTALL_CACHE_DIR: "/home/u/.bun/install/cache" });
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/u", XDG_CACHE_HOME: "/var/cache/u", BUN_INSTALL_CACHE_DIR: "/home/u/.cache/standup/playwright/.bun-cache" });
  });

  test("Playwright is copied in from a cache of the toolchain's own, not hard-linked from the shared one", () => {
    expect(SETUP_STEPS.find((s) => s[0] === "add")).toEqual(["add", "--backend=copyfile", "playwright"]);
  });

  test("runSetup creates the dir 0700 and runs each step with Bun's argv in it, no shell", async () => {
    await withTempDir(async (dir) => {
      const log = join(dir, "calls.log");
      const fakeBun = join(dir, "fake-bun");
      await writeFile(fakeBun, `#!/bin/sh\necho "$(pwd) [$BUN_INSTALL_CACHE_DIR] [$BUN_OPTIONS] $*" >> ${JSON.stringify(log)}\n`);
      await chmod(fakeBun, 0o755);
      const pw = join(dir, "cache", "standup", "playwright");
      const outer = process.env.BUN_OPTIONS;
      process.env.BUN_OPTIONS = "--preload=/tmp/evil.ts";
      try {
        expect(runSetup(pw, fakeBun)).toBe(0);
      } finally {
        if (outer === undefined) delete process.env.BUN_OPTIONS;
        else process.env.BUN_OPTIONS = outer;
      }
      expect(statSync(pw).mode & 0o777).toBe(0o700);
      const real = realpathSync(pw);
      expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(SETUP_STEPS.map((s) => `${real} [${join(pw, ".bun-cache")}] [] ${s.join(" ")}`));
    });
  });

  test("runSetup refuses a symlinked dir and stops at a failing step", async () => {
    await withTempDir(async (dir) => {
      await mkdir(join(dir, "elsewhere"));
      await symlink(join(dir, "elsewhere"), join(dir, "pw"));
      expect(runSetup(join(dir, "pw"), "/bin/true")).toBe(1);
      expect(runSetup(join(dir, "fresh"), "/bin/false")).toBe(1);
    });
  });
});

describe("pipeline-screenshot resolvePlaywright", () => {
  test("returns null when the install dir lacks playwright", async () => {
    await withTempDir(async (dir) => {
      expect(resolvePlaywright(join(dir, "absent"))).toBeNull();
      await writeFile(join(dir, "package.json"), "{}");
      expect(resolvePlaywright(dir)).toBeNull();
    });
  });
});
