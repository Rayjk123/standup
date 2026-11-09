import { expect, test, describe, afterAll } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, realpath } from "fs/promises";
import { join } from "path";
import { homedir, tmpdir } from "os";
import { createStore, getSession, upsertProject } from "@standup/store";
import { createServer } from "./server.js";
import { AUTO_CHECKPOINT_CWD, isInternalCwd } from "./internal-cwd.js";

/**
 * Hooks that must never materialize a session row: Standup's own internal
 * subprocesses (whatever spelling of the home directory their cwd uses), and a
 * headless run whose only delivered hook is SessionEnd.
 */

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

function setUp() {
  const store = createStore(":memory:");
  upsertProject(store.db, { id: "scratch", name: "scratch", branch: "main", repos: [] });
  const app = createServer(store, () => {}, null);
  return { store, app };
}

function hook(app: ReturnType<typeof createServer>, body: Record<string, unknown>) {
  return app.request("/hook", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("isInternalCwd", () => {
  test("matches the reserved root by its homedir() spelling and its real path", async () => {
    expect(isInternalCwd(AUTO_CHECKPOINT_CWD)).toBe(true);
    expect(isInternalCwd(join(AUTO_CHECKPOINT_CWD, "expert"))).toBe(true);
    const real = await realpath(AUTO_CHECKPOINT_CWD);
    expect(isInternalCwd(real)).toBe(true);
    expect(isInternalCwd(join(real, "digest"))).toBe(true);
  });

  test("does not match a sibling that merely shares the prefix", () => {
    expect(isInternalCwd(AUTO_CHECKPOINT_CWD + "-other")).toBe(false);
    expect(isInternalCwd(homedir())).toBe(false);
  });
});

describe("/hook phantom sessions", () => {
  test("a lone SessionEnd for an unknown session creates no row", async () => {
    const { store, app } = setUp();
    await hook(app, { session_id: "ghost", cwd: "/tmp", hook_event_name: "SessionEnd" });
    expect(getSession(store.db, "ghost")).toBeNull();
    store.close();
  });

  test("SessionEnd still ends a session the collector already knows", async () => {
    const { store, app } = setUp();
    await hook(app, { session_id: "real", cwd: "/tmp", hook_event_name: "SessionStart" });
    await hook(app, { session_id: "real", cwd: "/tmp", hook_event_name: "SessionEnd" });
    expect(getSession(store.db, "real")?.endedAt).toBeTruthy();
    store.close();
  });

  test("an internal subprocess reached through a symlinked home creates no row", async () => {
    const { store, app } = setUp();
    const base = await mkdtemp(join(tmpdir(), "standup-phantom-"));
    dirs.push(base);
    // A symlink to the internal root stands in for the alternate spelling; the
    // hook reports the resolved path, exactly as Claude Code does.
    await mkdir(AUTO_CHECKPOINT_CWD, { recursive: true });
    const link = join(base, "internal-link");
    await symlink(AUTO_CHECKPOINT_CWD, link);
    const resolved = await realpath(link);
    await hook(app, { session_id: "internal", cwd: resolved, hook_event_name: "SessionStart" });
    expect(getSession(store.db, "internal")).toBeNull();
    store.close();
  });
});
