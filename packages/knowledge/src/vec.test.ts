import { expect, test, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "path";
import { tmpdir } from "os";
import { writeFileSync, rmSync, existsSync } from "fs";
import { KnowledgeStore } from "./store.js";
import { searchKnowledge } from "./search.js";
import { registerEmbeddingProvider } from "./embeddings.js";
import {
  isVecAvailable,
  vecExplicitlyDisabled,
  tryEnableSqliteVecExtension,
  enableSqliteVecExtension,
  VEC_PROBE_BUNDLED,
} from "./vec.js";
import type { KnowledgeDoc } from "./types.js";

function doc(overrides: Partial<KnowledgeDoc> = {}): KnowledgeDoc {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    projectId: "proj",
    slug: "doc",
    title: "Doc",
    body: "body",
    updatedAt: new Date("2026-08-16T00:00:00Z"),
    filePath: "/x/doc.md",
    ...overrides,
  };
}

describe("sqlite-vec KNN ⇄ brute-force parity (subprocess)", () => {
  // Enabling sqlite-vec requires Database.setCustomSQLite, a one-shot process
  // global that must run before any connection opens — impossible to guarantee
  // inside the shared `bun test` process, so the parity check runs in its own
  // process. It seeds one corpus and asserts KNN search and the linear scan
  // return the same ranked docs across many scenarios (see vec-parity.ts).
  test("KNN returns the same top-K as the brute-force scan, or falls back", () => {
    const runner = join(import.meta.dir, "vec-parity.ts");
    const proc = Bun.spawnSync(["bun", "run", runner], {
      env: { ...process.env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = proc.stdout.toString() + proc.stderr.toString();

    if (proc.exitCode === 2) {
      // sqlite-vec can't load here (bun's default SQLite has no extension
      // loading, and no extension-capable SQLite was found). The KNN path is
      // unavailable and search runs the brute-force scan — the documented
      // fallback. Nothing to compare; the in-process tests below cover it.
      console.warn(
        "[vec.test] sqlite-vec unavailable on this host — KNN parity skipped, fallback path in effect"
      );
      expect(out).toContain("unavailable");
      return;
    }

    // Any nonzero-and-not-2 exit is a genuine failure; surface the log. A
    // MISMATCH means the KNN and brute-force arms diverged; a SCOPE LEAK means
    // the vec path returned an out-of-audience doc (a cross-user/cross-project
    // scope-gate hole the parity check alone would not catch).
    expect(out).not.toContain("PARITY MISMATCH");
    expect(out).not.toContain("SCOPE LEAK");
    expect(proc.exitCode).toBe(0);
  });
});

describe("vec capability gating", () => {
  test("STANDUP_DISABLE_VEC forces the fallback regardless of host support", () => {
    const prev = process.env.STANDUP_DISABLE_VEC;
    process.env.STANDUP_DISABLE_VEC = "1";
    try {
      const db = new Database(":memory:");
      expect(vecExplicitlyDisabled()).toBe(true);
      expect(isVecAvailable(db)).toBe(false);
      expect(new KnowledgeStore(db).vecReady()).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.STANDUP_DISABLE_VEC;
      else process.env.STANDUP_DISABLE_VEC = prev;
    }
  });

  test("isVecAvailable never throws — an unloadable extension resolves to false", () => {
    // On bun's default SQLite this is false (no dynamic extension loading); on
    // a host whose process opened against an extension-capable SQLite it may be
    // true. Either way the probe must resolve to a boolean without throwing.
    const db = new Database(":memory:");
    expect(typeof isVecAvailable(db)).toBe("boolean");
  });
});

describe("tryEnableSqliteVecExtension — default auto-enable + guard", () => {
  // Restore the two env vars each test drives, so tests don't bleed into each
  // other or into the rest of the suite.
  function withEnv(
    vars: Record<string, string | undefined>,
    fn: () => void
  ): void {
    const prev: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(vars)) {
      prev[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      fn();
    } finally {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  const probeScript = join(import.meta.dir, "vec-probe.ts");
  function probeExit(...args: string[]): number | null {
    return Bun.spawnSync(["bun", "run", probeScript, ...args], {
      stdout: "ignore",
      stderr: "ignore",
    }).exitCode;
  }

  // Whether bun's own SQLite runs sqlite-vec with no swap. This is the one
  // behavior that legitimately differs by platform: bun's Linux build statically
  // links a SQLite that loads extensions (and ignores setCustomSQLite), while its
  // macOS build cannot load extensions at all.
  const bundledCapable = probeExit(VEC_PROBE_BUNDLED) === 0;

  test("the bundled-SQLite capability matches the platform's bun build", () => {
    if (process.platform === "linux") expect(bundledCapable).toBe(true);
    if (process.platform === "darwin") expect(bundledCapable).toBe(false);
  });

  test("STANDUP_DISABLE_VEC forces it off without probing any candidate", () => {
    withEnv({ STANDUP_DISABLE_VEC: "1" }, () => {
      expect(tryEnableSqliteVecExtension()).toBe(false);
      expect(enableSqliteVecExtension()).toEqual({ enabled: false, library: null, rejected: [] });
    });
  });

  test("an absent candidate is a clean no-op — never swaps, process stays intact", () => {
    const missing = join(tmpdir(), `standup-vec-missing-${process.pid}.dylib`);
    rmSync(missing, { force: true });
    withEnv({ STANDUP_DISABLE_VEC: undefined, STANDUP_SQLITE_PATH: missing }, () => {
      // Nothing to probe and nothing installed; vec is on exactly when the
      // bundled SQLite runs it on its own.
      expect(enableSqliteVecExtension()).toEqual({
        enabled: bundledCapable,
        library: null,
        rejected: [],
      });
      // The parent never touched setCustomSQLite, so a database still opens.
      const db = new Database(":memory:");
      expect(db.query("SELECT 1 as x").get()).toEqual({ x: 1 });
      db.close();
    });
  });

  test("a candidate that exists but is not an extension-capable SQLite never poisons the parent", () => {
    // The exact disaster the child-process guard prevents: setCustomSQLite on a
    // non-SQLite file THROWS and strands EVERY database open in that process. By
    // probing in a throwaway child, the poison stays in the child — the parent
    // sees a non-zero exit, skips the swap, and stays healthy. The bogus file is
    // reported rejected and is never the installed library on any platform; vec
    // is still on where the bundled SQLite runs it (Linux) and off where it
    // cannot (macOS).
    const bad = join(tmpdir(), `standup-vec-bad-${process.pid}.dylib`);
    writeFileSync(bad, "this is not a sqlite shared library");
    try {
      withEnv({ STANDUP_DISABLE_VEC: undefined, STANDUP_SQLITE_PATH: bad }, () => {
        expect(enableSqliteVecExtension()).toEqual({
          enabled: bundledCapable,
          library: null,
          rejected: [bad],
        });
        expect(tryEnableSqliteVecExtension()).toBe(bundledCapable);
        const db = new Database(":memory:");
        expect(db.query("SELECT 1 as x").get()).toEqual({ x: 1 });
        db.close();
      });
    } finally {
      rmSync(bad, { force: true });
    }
  });

  test("auto-enables when the extension is available, else falls back cleanly (subprocess)", () => {
    // tryEnableSqliteVecExtension may call setCustomSQLite (a one-shot process
    // global), so it can only be exercised end-to-end in its own process. The
    // runner reports ENABLED on a capable host (and proves sqlite-vec really
    // loads) or FALLBACK on a host without the extension; either way it must open
    // a database without throwing. BROKEN (reported on but the extension does not
    // load) or any throw fails.
    const runner = join(import.meta.dir, "vec-autoenable-check.ts");
    const proc = Bun.spawnSync(["bun", "run", runner], {
      env: { ...process.env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = proc.stdout.toString() + proc.stderr.toString();
    expect(out).not.toContain("AUTOENABLE BROKEN");
    expect(out).toMatch(/AUTOENABLE (ENABLED|FALLBACK)/);
    expect(proc.exitCode).toBe(0);
    // Where the bundled SQLite runs sqlite-vec, auto-enable needs no library and
    // must turn the KNN path on.
    if (bundledCapable) expect(out).toContain("AUTOENABLE ENABLED");
  });

  test("vec-probe rejects a non-SQLite file and a missing argument (never throws to the parent)", () => {
    const bad = join(tmpdir(), `standup-probe-bad-${process.pid}.txt`);
    const missing = join(tmpdir(), `standup-probe-missing-${process.pid}.dylib`);
    writeFileSync(bad, "not a sqlite library");
    rmSync(missing, { force: true });
    try {
      // Rejected on every platform, including where the bundled SQLite could run
      // sqlite-vec by itself: the probe validates the candidate, not the host.
      expect(probeExit(bad)).not.toBe(0);
      expect(probeExit(missing)).not.toBe(0);
      expect(probeExit()).not.toBe(0);
    } finally {
      rmSync(bad, { force: true });
    }
  });

  test("vec-probe accepts a real SQLite library only where setCustomSQLite installs it", () => {
    // On Linux a genuine system libsqlite3 is a valid SQLite, but bun ignores
    // setCustomSQLite, so the library would never serve a connection and the
    // probe must not vouch for it. On macOS Homebrew's extension-capable SQLite
    // is installed by setCustomSQLite, so the probe accepts it. A host with
    // neither library present has nothing on disk to assert against.
    const linuxLib = [
      "/usr/lib64/libsqlite3.so.0",
      "/usr/lib/x86_64-linux-gnu/libsqlite3.so.0",
      "/usr/lib/aarch64-linux-gnu/libsqlite3.so.0",
    ].find((p) => existsSync(p));
    const macLib = [
      "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib",
      "/usr/local/opt/sqlite/lib/libsqlite3.dylib",
    ].find((p) => existsSync(p));
    if (process.platform === "linux" && linuxLib) {
      expect(probeExit(linuxLib)).not.toBe(0);
    }
    if (process.platform === "darwin" && macLib) {
      expect(probeExit(macLib)).toBe(0);
    }
  });
});

describe("embedding search over the active path", () => {
  // Exercises whichever path is live in THIS process (the brute-force scan
  // under bun's default SQLite): a seeded, embedded corpus must return its docs
  // ranked by cosine so the fallback is proven end-to-end through searchKnowledge.
  test("embedded docs are recalled and ranked by cosine similarity", async () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    const cosVec = (cos: number) => [cos, Math.sqrt(1 - cos * cos), 0];

    store.upsertDoc(doc({ id: "near", projectId: "proj", slug: "near", title: "Near" }));
    store.upsertChunk({
      id: "near-c",
      knowledgeId: "near",
      chunkIndex: 0,
      text: "near chunk",
      embedding: cosVec(0.9),
    });
    store.upsertDoc(doc({ id: "far", projectId: "proj", slug: "far", title: "Far" }));
    store.upsertChunk({
      id: "far-c",
      knowledgeId: "far",
      chunkIndex: 0,
      text: "far chunk",
      embedding: cosVec(0.3),
    });

    registerEmbeddingProvider({
      id: "vec-test-fake",
      defaultModel: "m",
      async embed() {
        return [1, 0, 0];
      },
    });

    const results = await searchKnowledge(db, "proj", "unmatched query text", "vec-test-fake", {
      limit: 5,
    });

    expect(results.map((r) => r.slug).sort()).toEqual(["far", "near"]);
    const near = results.find((r) => r.slug === "near")!;
    const far = results.find((r) => r.slug === "far")!;
    expect(near.score).toBeGreaterThan(far.score);
  });

  test("getChunksByIds returns [] for no ids and hydrates the requested chunks", () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    store.upsertDoc(doc({ id: "d", projectId: "proj", slug: "d", title: "D", sourceKind: "spec" }));
    store.upsertChunk({
      id: "d-c",
      knowledgeId: "d",
      chunkIndex: 0,
      text: "chunk text",
      embedding: [1, 0, 0],
    });

    expect(store.getChunksByIds([])).toEqual([]);
    const hydrated = store.getChunksByIds(["d-c"]);
    expect(hydrated.length).toBe(1);
    expect(hydrated[0].knowledgeId).toBe("d");
    expect(hydrated[0].sourceKind).toBe("spec");
    expect(hydrated[0].embedding).toEqual([1, 0, 0]);
  });
});
