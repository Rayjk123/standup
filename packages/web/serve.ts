#!/usr/bin/env bun
/**
 * Serves the console from a production build rather than the vite dev server:
 *
 *   bun serve.ts [--config <vite config>] [--out-dir <dir>] [--no-watch]
 *
 * It builds the app (`vite build`, no typecheck: `bun run build` owns that),
 * then serves the build with `vite preview` on the config's `preview` port,
 * which carries the same /api and /ws proxies and owner sign-in route as the
 * dev server (see vite.config.ts). The dev server sends every source module
 * as its own request, hundreds on a cold load; the build is a handful of
 * hashed, compressed, cached chunks (static-assets.ts).
 *
 * Every build runs in its own short-lived child process (`bun serve.ts
 * --build-once`), never in the serving one. A rollup build of the console
 * peaks above a gigabyte, and a watch-mode build keeps the whole module graph
 * (about 300 MB of heap) between rebuilds; done in the long-lived server, each
 * rebuild left its resident size higher than the last, as the allocator kept
 * the peak. A child returns all of it to the system when it exits, and the
 * server holds only vite preview.
 *
 * With watching on (the default) a source change, such as a merge into the
 * install, rebuilds in place and the next page load picks it up: each build
 * reports the files it read, and the server watches those. Hashed
 * assets of earlier builds (this process's or an earlier one's) stay on disk
 * for ASSET_GRACE_MS, so a page still open on an older build can lazy-load its
 * chunks; past that, opening a tab reloads the page onto the current build
 * (see src/lib/chunkReload.ts). A change to the vite config or a local module it
 * imports restarts the build and the server.
 *
 * A broken build never takes the console down while an earlier one is on
 * disk: a failed rebuild, a failed first build after a restart, and a config
 * that no longer loads all leave the last good build served.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unwatchFile,
  utimesSync,
  watch as watchDir,
  watchFile,
  writeFileSync,
  type FSWatcher,
} from "fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "path";
import { build, preview, resolveConfig, type Plugin, type PreviewServer } from "vite";

/** How long a hashed asset outlives the build that last wrote it. */
export const ASSET_GRACE_MS = 24 * 60 * 60 * 1000;

export interface ServeOptions {
  /** The vite config; vite's own lookup (vite.config.ts) when absent. */
  configFile?: string;
  /** Where the build goes; `dist-serve` beside this file when absent, apart from `bun run build`'s `dist`, which that empties. */
  outDir?: string;
  /** Rebuild on source changes (default true). */
  watch?: boolean;
  logLevel?: "info" | "warn" | "error" | "silent";
}

export interface ServedConsole {
  server: PreviewServer;
  outDir: string;
  /** Settles once no build is in flight or waiting to start. */
  idle(): Promise<void>;
  close(): Promise<void>;
}

/**
 * The build's pages: index.html, and mermaid-frame.html, the page diagrams are
 * drawn in (src/lib/mermaid.ts), which the console names only by its path.
 */
export const PAGES = ["index.html", "mermaid-frame.html"] as const;

/**
 * The `<outDir>/assets` files the served pages (PAGES) reach: those they
 * name, then every asset named in one of those, and so on (an entry's static
 * and dynamic imports, a chunk's own imports, a worker). Matching by file name
 * is enough: hashed names don't occur by chance.
 */
export function liveAssets(outDir: string): Set<string> {
  const dir = join(outDir, "assets");
  const live = new Set<string>();
  let names: string[];
  const pages: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return live;
  }
  for (const page of PAGES) {
    try {
      pages.push(readFileSync(join(outDir, page), "utf8"));
    } catch {
      // Not built (yet): nothing of it to keep.
    }
  }
  const present = new Set(names);
  const queue = pages;
  while (queue.length) {
    for (const [word] of queue.pop()!.matchAll(ASSET_NAME)) {
      // A name run on from the text before it (`x.Foo-1.js`) is one of the word's dotted suffixes.
      let name: string | undefined = word;
      while (name && !present.has(name)) {
        const dot = name.indexOf(".");
        name = dot >= 0 && name.indexOf(".", dot + 1) >= 0 ? name.slice(dot + 1) : undefined;
      }
      if (!name || live.has(name)) continue;
      live.add(name);
      // Only text assets name others; a font or image is kept, not read.
      if (!/\.(m?js|css|html)$/.test(name)) continue;
      try {
        queue.push(readFileSync(join(dir, name), "utf8"));
      } catch {
        // Unreadable or gone: nothing further to follow.
      }
    }
  }
  return live;
}

/** A word that could be an emitted asset's file name: vite's names are `[\w.-]` only. */
const ASSET_NAME = /[\w-]+(?:\.[\w-]+)+/g;

/**
 * Restarts the grace period of the build index.html serves now, as a new
 * build replaces it: grace runs from the time a build stopped being served,
 * not from when it was written, so a page opened on it a minute ago keeps its
 * chunks for a full ASSET_GRACE_MS however old the build is.
 */
export function retireServedBuild(outDir: string, nowMs: number = Date.now()): void {
  const at = nowMs / 1000;
  for (const name of liveAssets(outDir)) {
    try {
      utimesSync(join(outDir, "assets", name), at, at);
    } catch {
      // Gone already.
    }
  }
}

/**
 * Removes `<outDir>/assets` files last written before `cutoffMs`, except the
 * ones the served index.html reaches (liveAssets): an old build stays whole
 * while it is the one served, however long ago it was written.
 */
export function pruneAssets(outDir: string, cutoffMs: number): string[] {
  const dir = join(outDir, "assets");
  const removed: string[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return removed;
  }
  const live = liveAssets(outDir);
  for (const name of names) {
    if (live.has(name)) continue;
    const file = join(dir, name);
    try {
      if (statSync(file).mtimeMs < cutoffMs) {
        rmSync(file, { force: true });
        removed.push(name);
      }
    } catch {
      // Gone already.
    }
  }
  return removed;
}

/**
 * Writes the pages (PAGES) only after every chunk is on disk, renaming each
 * into place, index.html last: rollup writes a build's files in parallel, and
 * a page load that got a new page before its entry chunk existed would come
 * up blank.
 */
export function indexHtmlLast(): Plugin {
  let pages: { fileName: string; source: string | Uint8Array }[] = [];
  return {
    name: "standup-index-html-last",
    apply: "build",
    enforce: "post",
    generateBundle(_options, bundle) {
      pages = [];
      // index.html last, so a console that loads it finds the frame page already in place.
      for (const name of [...PAGES].reverse()) {
        const asset = bundle[name];
        if (asset?.type !== "asset") continue;
        pages.push({ fileName: asset.fileName, source: asset.source });
        delete bundle[name];
      }
    },
    writeBundle(options) {
      if (!pages.length || !options.dir) return;
      const dir = options.dir;
      const staged = pages.map((page) => {
        const target = join(dir, page.fileName);
        const path = `${target}.${process.pid}.tmp`;
        writeFileSync(path, page.source);
        return { path, target };
      });
      // The build being replaced starts its grace period now.
      retireServedBuild(dir);
      for (const { path, target } of staged) renameSync(path, target);
      pages = [];
    },
  };
}

/** What a `--build-once` child sends its parent: the files its build read. */
interface BuildReport {
  watchFiles: string[];
}

/**
 * The one build a `--build-once` child runs: the console into `outDir`, then
 * the prune that follows a good build. Only a build that succeeded rewrote
 * every file it emits, so only then is anything older than it by the grace
 * period (and not reached from the served index.html) unneeded. `report`
 * receives the files the build read, failed or not, for the server to watch.
 */
export async function buildOnce(opts: ServeOptions, outDir: string, report: (files: string[]) => void): Promise<void> {
  const started = Date.now();
  const watchFiles: Plugin = {
    name: "standup-watch-files",
    apply: "build",
    buildEnd() {
      // Dependencies are never watched; leaving them out keeps the IPC message small.
      report(this.getWatchFiles().filter((id) => !/[\\/]node_modules[\\/]/.test(id)));
    },
  };
  await build({
    configFile: opts.configFile,
    logLevel: opts.logLevel ?? "info",
    plugins: [indexHtmlLast(), watchFiles],
    build: { outDir, emptyOutDir: false, watch: null },
  });
  pruneAssets(outDir, started - ASSET_GRACE_MS);
}

/**
 * The source files among a build's watch files, by directory: module ids
 * that name a file on disk (no virtual `\0` ids, no query), outside
 * node_modules, .git and the build output, as vite's own build watcher skips.
 */
export function sourceFilesByDir(files: readonly string[], outDir: string): Map<string, Set<string>> {
  const byDir = new Map<string, Set<string>>();
  const out = resolve(outDir) + sep;
  for (const id of files) {
    const file = id.split("?")[0]!;
    if (!isAbsolute(file) || file.startsWith(out) || /[\\/](node_modules|\.git)[\\/]/.test(file)) continue;
    const dir = dirname(file);
    let names = byDir.get(dir);
    if (!names) byDir.set(dir, (names = new Set()));
    names.add(basename(file));
  }
  return byDir;
}

/** How long the server waits after a source change for more before it rebuilds. */
export const REBUILD_DEBOUNCE_MS = 100;

interface Builder {
  /** Settles once no build is in flight or waiting to start. */
  idle(): Promise<void>;
  /** Stops watching and ends a build in flight. */
  close(): Promise<void>;
}

/** The longest a restart waits for the old build in flight to finish writing. */
export const IDLE_WAIT_MS = 60_000;

/** The command line of a `--build-once` child for `opts`. */
function buildCommand(opts: ServeOptions, outDir: string): string[] {
  return [
    process.execPath,
    join(import.meta.dir, "serve.ts"),
    "--build-once",
    "--out-dir",
    outDir,
    ...(opts.configFile ? ["--config", opts.configFile] : []),
    "--log-level",
    opts.logLevel ?? "info",
  ];
}

/**
 * Builds the console into `outDir` in a child process, then, when watching,
 * again in a fresh child each time a file the last build read changes (a
 * change during a build queues one more). With an earlier build's index.html
 * on disk the first build runs in the background, so a (re)start serves that
 * build at once and swaps in the new index.html when it lands (indexHtmlLast);
 * a failed build then leaves the earlier one served, and the next change
 * rebuilds. Without one, it waits for the first build and fails when that does.
 */
async function buildConsole(opts: ServeOptions, outDir: string): Promise<Builder> {
  const watch = opts.watch ?? true;
  // Earlier builds' assets survive a restart too: pages a previous server
  // process served may still be open, and the served build is never pruned.
  mkdirSync(outDir, { recursive: true });
  pruneAssets(outDir, Date.now() - ASSET_GRACE_MS);
  // A build child killed between staging index.html and renaming it into
  // place (indexHtmlLast) leaves its staged copy behind.
  for (const name of readdirSync(outDir)) {
    if (/^(index|mermaid-frame)\.html\.\d+\.tmp$/.test(name)) rmSync(join(outDir, name), { force: true });
  }
  const lastGood = existsSync(join(outDir, "index.html"));

  let closed = false;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let again = false;
  let watchers: FSWatcher[] = [];
  let idleWaiters: (() => void)[] = [];
  const busy = () => Boolean(running || child || timer);
  const settle = () => {
    if (busy()) return;
    for (const done of idleWaiters) done();
    idleWaiters = [];
  };

  // Watches the files the last good build read. A failed build read only the
  // modules up to its error, so its files are added to the watched set rather
  // than replacing it, as rollup's watcher does; one that reported none (its
  // config didn't load) leaves the set as it is.
  let watched: string[] = [];
  const watchSources = (files: string[] | undefined, ok: boolean) => {
    if (!watch || closed || !files?.length) return;
    watched = ok ? files : [...new Set([...watched, ...files])];
    for (const w of watchers) w.close();
    watchers = [];
    for (const [dir, names] of sourceFilesByDir(watched, outDir)) {
      try {
        watchers.push(watchDir(dir, (_event, name) => name && names.has(String(name)) && schedule()));
      } catch (err) {
        // A directory gone since the build read it has nothing to watch; any
        // other failure (the inotify watch limit) leaves its changes unseen.
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") console.error(`[serve] can't watch ${dir}: ${(err as Error).message}`);
      }
    }
  };

  /** Runs one build child; resolves with whether it succeeded. */
  const runBuild = async (): Promise<boolean> => {
    let files: string[] | undefined;
    const proc = Bun.spawn(buildCommand(opts, outDir), {
      // The environment as this process has it now: left out, Bun hands the
      // child the one this process started with, before any change to it.
      env: process.env,
      stdio: ["ignore", "inherit", "inherit"],
      serialization: "json",
      ipc(message: BuildReport) {
        files = message.watchFiles;
      },
    });
    child = proc;
    const code = await proc.exited;
    child = undefined;
    watchSources(files, code === 0);
    if (code !== 0 && !closed) console.error(`[serve] build failed (exit ${code}); serving the last good build`);
    return code === 0;
  };

  /** Builds until no change is queued; resolves with whether the last build succeeded. */
  const rebuild = async (): Promise<boolean> => {
    if (running) {
      again = true;
      return true;
    }
    running = true;
    let ok = false;
    try {
      do {
        again = false;
        ok = await runBuild();
      } while (again && !closed);
    } finally {
      running = false;
      settle();
    }
    return ok;
  };

  function schedule(): void {
    if (closed) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void rebuild();
    }, REBUILD_DEBOUNCE_MS);
  }

  const builder: Builder = {
    idle: () => (busy() ? new Promise<void>((done) => idleWaiters.push(done)) : Promise.resolve()),
    async close() {
      closed = true;
      clearTimeout(timer);
      timer = undefined;
      for (const w of watchers) w.close();
      watchers = [];
      const running = child;
      running?.kill();
      await running?.exited;
      settle();
    },
  };

  // In flight from the start; a failure is logged by runBuild. Without
  // watching, the build is waited for even when an earlier one is on disk.
  const first = rebuild();
  if (watch && lastGood) return builder;
  if (!(await first) && !lastGood) {
    await builder.close();
    throw new Error("the first build failed and there is no earlier build to serve");
  }
  return builder;
}

/** Builds the console into `outDir` and serves it; see the file comment. */
export async function serveConsole(opts: ServeOptions = {}): Promise<ServedConsole> {
  const outDir = resolve(opts.outDir ?? join(import.meta.dir, "dist-serve"));
  const builder = await buildConsole(opts, outDir);
  try {
    const server = await preview({ configFile: opts.configFile, logLevel: opts.logLevel ?? "info", build: { outDir } });
    return served(server, outDir, builder);
  } catch (err) {
    await builder.close();
    throw err;
  }
}

/** The builder behind each served console, for a restart to stop before the server. */
const builders = new WeakMap<ServedConsole, Builder>();

function served(server: PreviewServer, outDir: string, builder: Builder): ServedConsole {
  const result: ServedConsole = {
    server,
    outDir,
    idle: builder.idle,
    async close() {
      await builder.close();
      // vite's close also drops open sockets (a /ws proxied through the old
      // server) and its own SIGTERM listener.
      await server.close();
    },
  };
  builders.set(result, builder);
  return result;
}

/**
 * Restarts `current` onto the config as it is now: the config is loaded
 * first, and while it doesn't load the old build and server stay up. The old
 * builder is stopped once its build in flight has finished writing, so it
 * can't land an old index.html over the new build's; the old server keeps
 * serving what is on disk while the new build runs, and is closed only to hand
 * the port over.
 */
export async function restartConsole(current: ServedConsole, opts: ServeOptions): Promise<ServedConsole> {
  await resolveConfig({ configFile: opts.configFile, logLevel: "silent" }, "build", "production", "production", true);
  await Promise.race([current.idle(), new Promise((done) => setTimeout(done, IDLE_WAIT_MS))]);
  await builders.get(current)?.close();
  const builder = await buildConsole(opts, current.outDir);
  await current.server.close();
  try {
    const server = await preview({ configFile: opts.configFile, logLevel: opts.logLevel ?? "info", build: { outDir: current.outDir } });
    return served(server, current.outDir, builder);
  } catch (err) {
    await builder.close();
    throw err;
  }
}

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (import.meta.main && process.argv.includes("--build-once")) {
  // A build child (see buildConsole): one build, its watch files to the parent, then exit.
  const outDir = resolve(flag("out-dir") ?? join(import.meta.dir, "dist-serve"));
  const logLevel = flag("log-level") as ServeOptions["logLevel"];
  // A server gone mid-build (a signal before its handlers are in place, a
  // crash, SIGKILL) closes the IPC channel: the build stops with it, so it
  // can't write the output directory under the next server's build.
  process.on("disconnect", () => process.exit(1));
  try {
    await buildOnce({ configFile: flag("config"), logLevel }, outDir, (watchFiles) => process.send?.({ watchFiles } satisfies BuildReport));
    process.exit(0);
  } catch (err) {
    console.error(`[serve] build failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
} else if (import.meta.main) {
  const configArg = flag("config");
  const outArg = flag("out-dir");
  const opts: ServeOptions = {
    configFile: configArg ? (isAbsolute(configArg) ? configArg : resolve(configArg)) : undefined,
    outDir: outArg ? resolve(outArg) : undefined,
    watch: !process.argv.includes("--no-watch"),
  };
  let current = await serveConsole(opts);
  current.server.printUrls();

  // The source watch follows the app's sources, not the vite config, so a
  // change to the config (or a local module it imports, such as owner-proxy.ts;
  // packages such as @standup/shared are not among its configFileDependencies)
  // restarts the build and the server, as vite's dev server restarts itself.
  // A config that doesn't load leaves the running server as it is; a change
  // made while a restart runs queues one more.
  let restarting = false;
  let again = false;
  const restart = async (): Promise<void> => {
    if (restarting) {
      again = true;
      return;
    }
    restarting = true;
    try {
      do {
        again = false;
        try {
          current = await restartConsole(current, opts);
          watchConfig();
        } catch (err) {
          console.error(`[serve] restart failed: ${err instanceof Error ? err.message : err}`);
          // Past the config check the old server is already closed: nothing serves.
          if (!current.server.httpServer.listening) process.exit(1);
        }
      } while (again);
    } finally {
      restarting = false;
    }
  };
  const watched = new Set<string>();
  const watchConfig = () => {
    for (const file of watched) unwatchFile(file);
    watched.clear();
    for (const dep of current.server.config.configFileDependencies) {
      const file = resolve(current.server.config.root, dep);
      watched.add(file);
      watchFile(file, { interval: 1000 }, (now, before) => {
        if (now.mtimeMs === before.mtimeMs) return;
        console.log(`[serve] ${dep} changed; restarting`);
        void restart();
      });
    }
  };
  if (opts.watch) watchConfig();

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      for (const file of watched) unwatchFile(file);
      void current.close().finally(() => process.exit(0));
    });
  }
}
