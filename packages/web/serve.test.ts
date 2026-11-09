import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import type { AddressInfo } from "net";
import { tmpdir } from "os";
import { join } from "path";
import { serveConsole, sourceFilesByDir, type ServedConsole } from "./serve";

/*
 * serve.ts must never build in the serving process: a rollup build peaks
 * above a gigabyte and watch mode keeps the module graph between rebuilds, so
 * a long-lived server that rebuilt in place grew with every merge. The app
 * here is a two-file page whose vite config records the pid of each build.
 */

// Real path: Vite resolves module ids to theirs, and a root spelled through a symlinked TMPDIR leaves index.html outside it.
const root = realpathSync(mkdtempSync(join(tmpdir(), "standup-serve-")));
const outDir = join(root, "dist");
const pidLog = join(root, "build-pids");
const main = join(root, "src", "main.js");
mkdirSync(join(root, "src"));
writeFileSync(join(root, "index.html"), '<!doctype html><html><body><script type="module" src="/src/main.js"></script></body></html>');
writeFileSync(main, 'document.body.append("v1");\n');
const configFile = join(root, "vite.config.mjs");
writeFileSync(
  configFile,
  `import { appendFileSync } from "fs";
export default {
  root: ${JSON.stringify(root)},
  logLevel: "silent",
  plugins: [{ name: "pid", apply: "build", buildStart() { appendFileSync(${JSON.stringify(pidLog)}, process.pid + "\\n"); } }],
  preview: { port: 0, host: "127.0.0.1" },
};
`,
);

let served: ServedConsole | undefined;
afterAll(async () => {
  await served?.close();
  rmSync(root, { recursive: true, force: true });
});

const buildPids = () => (existsSync(pidLog) ? readFileSync(pidLog, "utf8").trim().split("\n").map(Number) : []);
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function until(check: () => Promise<boolean> | boolean, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(100);
  }
}

/** The text of the entry chunk the served index.html loads. */
async function servedEntry(): Promise<string> {
  const { port } = served!.server.httpServer.address() as AddressInfo;
  const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
  const src = html.match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
  return src ? (await fetch(`http://127.0.0.1:${port}${src}`)).text() : "";
}

describe("serveConsole", () => {
  test("builds in short-lived child processes, never in the serving one, and rebuilds on a source change", async () => {
    served = await serveConsole({ configFile, outDir, watch: true, logLevel: "silent" });
    expect(await servedEntry()).toContain("v1");
    expect(buildPids()).toHaveLength(1);

    for (const version of ["v2", "v3", "v4"]) {
      writeFileSync(main, `document.body.append(${JSON.stringify(version)});\n`);
      await until(async () => (await servedEntry()).includes(version));
      await served.idle();
    }

    const pids = buildPids();
    expect(pids).toHaveLength(4);
    expect(pids).not.toContain(process.pid);
    expect(new Set(pids).size).toBe(4);
    expect(pids.filter(alive)).toEqual([]);
  }, 120_000);

  test("a failed rebuild leaves the last good build served, and the fix rebuilds", async () => {
    const before = buildPids().length;
    writeFileSync(main, "document.body.append(\n");
    await until(() => buildPids().length > before);
    await served!.idle();
    expect(await servedEntry()).toContain("v4");

    writeFileSync(main, 'document.body.append("v5");\n');
    await until(async () => (await servedEntry()).includes("v5"));
    expect(buildPids()).not.toContain(process.pid);
  }, 120_000);

  test("without watching, it waits for the build even when an earlier one is on disk", async () => {
    await served!.close();
    writeFileSync(join(outDir, "index.html.12345.tmp"), "staged by a killed build");
    writeFileSync(main, 'document.body.append("v6");\n');
    served = await serveConsole({ configFile, outDir, watch: false, logLevel: "silent" });
    expect(await servedEntry()).toContain("v6");
    expect(existsSync(join(outDir, "index.html.12345.tmp"))).toBe(false);
    expect(buildPids()).not.toContain(process.pid);
  }, 120_000);
});

describe("a server killed mid-build", () => {
  test("takes its build child with it, so nothing writes the output after it", async () => {
    const slowOut = join(root, "slow-dist");
    const slowLog = join(root, "slow-pids");
    const slowConfig = join(root, "vite.slow.config.mjs");
    writeFileSync(
      slowConfig,
      `import { appendFileSync } from "fs";
export default {
  root: ${JSON.stringify(root)},
  logLevel: "silent",
  plugins: [{ name: "slow", apply: "build", async buildStart() {
    appendFileSync(${JSON.stringify(slowLog)}, process.pid + "\\n");
    await new Promise((done) => setTimeout(done, 2000));
  } }],
  preview: { port: 0, host: "127.0.0.1" },
};
`,
    );
    const server = Bun.spawn([process.execPath, join(import.meta.dir, "serve.ts"), "--config", slowConfig, "--out-dir", slowOut], {
      cwd: root,
      stdio: ["ignore", "ignore", "ignore"],
    });
    // The pid once it's written, not just the file appendFileSync creates first.
    await until(() => existsSync(slowLog) && Number(readFileSync(slowLog, "utf8").trim()) > 0);
    const builder = Number(readFileSync(slowLog, "utf8").trim());
    server.kill("SIGKILL");
    await server.exited;
    // The build writes its output from the builder process before it exits, so
    // once the builder is gone nothing can write it: a builder left running
    // would finish its 2s build and write index.html before this wait ends.
    await until(() => !alive(builder), 5000);
    expect(existsSync(join(slowOut, "index.html"))).toBe(false);
  }, 60_000);
});

describe("sourceFilesByDir", () => {
  test("keeps files on disk, outside node_modules, .git and the build output", () => {
    const byDir = sourceFilesByDir(
      [
        "/app/src/main.tsx",
        "/app/src/lib/a.ts?worker",
        "/app/index.html",
        "\0vite/modulepreload-polyfill",
        "/app/node_modules/react/index.js",
        "/repo/.git/HEAD",
        "/app/dist/assets/x.js",
        "/repo/packages/shared/src/topology.ts",
      ],
      "/app/dist",
    );
    expect(Object.fromEntries([...byDir].map(([dir, names]) => [dir, [...names].sort()]))).toEqual({
      "/app/src": ["main.tsx"],
      "/app/src/lib": ["a.ts"],
      "/app": ["index.html"],
      "/repo/packages/shared/src": ["topology.ts"],
    });
  });
});
