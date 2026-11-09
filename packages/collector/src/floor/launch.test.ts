import { expect, test, describe } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { dirname, resolve } from "path";
import { createLaunch, createSession, createStore, getLaunch, upsertProject } from "@standup/store";
import { PERSONA_CWD } from "../internal-cwd.js";
import { activeOwnerSecrets } from "../owner-secret.js";
import { DEFAULT_FLOOR_WAIT_S, DEFAULT_SHARED_BRANCHES, FLOOR_DIR, FLOOR_HOOK_PATH, decodeFloorConfig, encodeFloorConfig } from "./gate.js";
import {
  buildLaunchFloorConfig,
  claudeSettingsFiles,
  collectorBaseUrl,
  dropScratchTempEnv,
  floorTmpDirs,
  floorUnavailableReason,
  floorRootReason,
  floorSourcePaths,
  floorWaitSeconds,
  parsePersonalAwsAccounts,
  DEFAULT_NONPROD_AWS_ACCOUNTS,
  DEFAULT_PERSONAL_AWS_ACCOUNTS,
  floorWorktreeRoots,
  launchScratchId,
  nonProdAwsAccounts,
  ownerHosts,
  standupHosts,
  SCRATCH_ROOT_REASON,
  type FloorFs,
} from "./launch.js";
import { serverFloorConfig } from "./routes.js";
import { orgProfilePath, setActiveOrgProfile } from "../org-profile/load.js";
import { exampleCorpProfile } from "../org-profile/fixtures/example-corp.js";
import { commandTunnelProvider, disabledTunnelProvider } from "../tunnels/provider.js";

/**
 * The launcher's half of the safety floor: the per-launch FloorConfig built
 * from the launch and the collector's env, and the fail-closed check that
 * refuses to bypass when the hook can't run.
 */

/** A fake filesystem holding exactly `files`; a dir lists the files directly in it. */
function fakeFs(files: Record<string, string>): FloorFs {
  return {
    exists: (p) => p in files,
    read: (p) => files[p],
    list: (dir) => Object.keys(files).filter((f) => dirname(f) === dir).map((f) => f.slice(dir.length + 1)),
  };
}

const HOOK = "/opt/standup/floor/hook.ts";
const HOME = "/home/owner";
const ROOT = "/wt/proj/slug";

describe("buildLaunchFloorConfig", () => {
  test("carries the launch, the shared branches plus the project branch, and the env knobs", () => {
    const config = buildLaunchFloorConfig(
      { launchId: "L1", root: "/no/such/root", projectBranch: "feature-base" },
      {
        COLLECTOR_PORT: "8888",
        DB_PATH: "/data/standup/standup.db",
        STANDUP_PERSONAL_AWS_ACCOUNTS: " 444455556666, nope ,123,444455556666,111122223333 ",
        STANDUP_FLOOR_WAIT_S: "120",
      }
    );
    expect(config.v).toBe(1);
    expect(config.collectorUrl).toBe("http://127.0.0.1:8888");
    expect(config.launchId).toBe("L1");
    expect(config.root).toBe("/no/such/root");
    expect(config.sharedBranches).toEqual([...DEFAULT_SHARED_BRANCHES, "feature-base"]);
    expect(config.personalAwsAccounts).toEqual(["444455556666", "111122223333"]);
    expect(config.waitSeconds).toBe(120);
    expect(config.standupDataDir).toBe("/data/standup");
    // The org profile file, at its default place under the Standup config dir, is floor ground too.
    expect(config.floorPaths).toEqual([...floorSourcePaths(), orgProfilePath({})]);
    expect(config.floorPaths).toContain(FLOOR_DIR);
    // The built-in profile isn't carried: an absent one means it.
    expect(config.orgProfile).toBeUndefined();
    expect(FLOOR_DIR).toBe(dirname(FLOOR_HOOK_PATH));
  });

  test("carries the install dir, the protected paths, fixed temp dirs, a fresh worker token and the reply key", () => {
    const env = { DB_PATH: "/data/standup/standup.db", STANDUP_INSTALL_DIR: "/opt/standup/", XDG_CACHE_HOME: "/cache" };
    const a = buildLaunchFloorConfig({ launchId: "L1", root: "/no/such/root" }, env);
    const b = buildLaunchFloorConfig({ launchId: "L2", root: "/no/such/root" }, env);
    expect(a.installDir).toBe("/opt/standup");
    expect(a.protectedPaths).toEqual([
      "/data/standup/secrets",
      "/data/standup/worker-tokens",
      "/data/standup/review-media",
      "/data/standup/review-scratch",
      PERSONA_CWD,
    ]);
    expect(a.privatePaths).toContainEqual({ path: "/cache/standup-scratch", category: "standup-ops", reason: SCRATCH_ROOT_REASON });
    expect(a.tmpDirs).toContain("/tmp");
    expect(a.tmpDirs).toContain("/var/tmp");
    expect({ scratchDir: a.scratchDir, scratchRoot: a.scratchRoot }).toEqual({ scratchDir: "/cache/standup-scratch/L1", scratchRoot: "/cache/standup-scratch" });
    expect(b.scratchDir).toBe("/cache/standup-scratch/L2");
    // A launch id no scratch dir can be named after gets none, and its scratch root stays private.
    const odd = buildLaunchFloorConfig({ launchId: "../L4", root: "/r" }, env);
    expect({ scratchDir: odd.scratchDir, privateRoot: odd.privatePaths?.some((p) => p.path === "/cache/standup-scratch") }).toEqual({ scratchDir: undefined, privateRoot: true });
    expect(a.workerToken).toMatch(/^[0-9a-f]{64}$/);
    expect(b.workerToken).not.toBe(a.workerToken);
    expect(a.replyPublicKey).toBe(activeOwnerSecrets().replyPublicKey);
    expect(buildLaunchFloorConfig({ launchId: "L3", root: "/r", workerToken: "x".repeat(40), replyPublicKey: "k" }, env)).toMatchObject({
      workerToken: "x".repeat(40),
      replyPublicKey: "k",
    });
    // What the launcher builds is what the hook accepts.
    expect(decodeFloorConfig(encodeFloorConfig(a))).toEqual(a);
  });

  test("temp dirs are the OS temp dir, /tmp and /var/tmp, deduped, without trailing slashes", () => {
    const fromTmp = floorTmpDirs("/tmp/");
    expect(fromTmp[0]).toBe("/tmp");
    expect(new Set(fromTmp).size).toBe(fromTmp.length);
    const dirs = floorTmpDirs("/var/folders/xy/T/");
    expect(dirs[0]).toBe("/var/folders/xy/T");
    expect(new Set(dirs).size).toBe(dirs.length);
  });

  test("an OS temp dir at or below the scratch root is no temp dir; one beside it is", () => {
    const root = "/cache/standup-scratch";
    for (const osTmp of [`${root}/L1`, `${root}/L1/`, root, `${root}/L1/../L2/t`]) {
      expect({ osTmp, dirs: floorTmpDirs(osTmp, root).filter((d) => d.startsWith(root)) }).toEqual({ osTmp, dirs: [] });
    }
    expect(floorTmpDirs(`${root}-x/t`, root)[0]).toBe(`${root}-x/t`);
    expect(floorTmpDirs("/tmp/", root)).toContain("/tmp");
  });

  test("a TMPDIR, TMP or TEMP the collector inherits at or below the scratch root is dropped from its env", () => {
    const root = "/cache/standup-scratch";
    const env: Record<string, string | undefined> = { TMPDIR: `${root}/L1`, TMP: `${root}-x/t`, TEMP: root, HOME: `${root}/L1` };
    expect(dropScratchTempEnv(env, root)).toEqual(["TMPDIR", "TEMP"]);
    expect(env).toEqual({ TMP: `${root}-x/t`, HOME: `${root}/L1` });
    const clean: Record<string, string | undefined> = { TMPDIR: "/tmp" };
    expect(dropScratchTempEnv(clean, root)).toEqual([]);
    expect(clean).toEqual({ TMPDIR: "/tmp" });
  });

  test("a project branch already in the defaults is not duplicated; defaults apply without env", () => {
    const config = buildLaunchFloorConfig({ launchId: "L2", root: "/no/such/root", projectBranch: "main" }, {});
    expect(config.sharedBranches).toEqual(DEFAULT_SHARED_BRANCHES);
    expect(config.personalAwsAccounts).toEqual([...DEFAULT_PERSONAL_AWS_ACCOUNTS]);
    expect([...DEFAULT_PERSONAL_AWS_ACCOUNTS]).toEqual([]);
    expect(buildLaunchFloorConfig({ launchId: "L2", root: "/r" }, { STANDUP_PERSONAL_AWS_ACCOUNTS: "" }).personalAwsAccounts).toEqual([]);
    expect(config.waitSeconds).toBe(DEFAULT_FLOOR_WAIT_S);
    expect(config.collectorUrl).toBe("http://127.0.0.1:7777");
  });
});

describe("the scratch dir of a resumed session", () => {
  const env = { DB_PATH: "/data/standup/standup.db", XDG_CACHE_HOME: "/cache" };

  test("a scratch id names the scratch dir, travels in the config and decodes as the launch's own", () => {
    const config = buildLaunchFloorConfig({ launchId: "L2", root: "/r", scratchId: "L1" }, env);
    expect({ scratchDir: config.scratchDir, scratchId: config.scratchId }).toEqual({ scratchDir: "/cache/standup-scratch/L1", scratchId: "L1" });
    expect(decodeFloorConfig(encodeFloorConfig(config))).toEqual(config);
    // The launch's own id as its scratch id adds nothing to the config.
    expect(buildLaunchFloorConfig({ launchId: "L2", root: "/r", scratchId: "L2" }, env)).not.toHaveProperty("scratchId");
    // A scratch id no dir can be named for gets no scratch dir.
    expect(buildLaunchFloorConfig({ launchId: "L2", root: "/r", scratchId: "../L1" }, env).scratchDir).toBeUndefined();
  });

  test("an adopted launch's scratch id is its session's first launch, from the store; any other launch's is its own", () => {
    const store = createStore(":memory:");
    upsertProject(store.db, { id: "p", name: "p", branch: "main", repos: [] });
    createSession(store.db, { id: "s1", projectId: "p", title: "t", cwd: "/wt/s1", status: "idle" });
    const base = { projectId: "p", task: "t", worktreePath: "/wt/s1", branch: "b", sessionId: "s1", status: "running" as const };
    createLaunch(store.db, { ...base, id: "first", tmuxSession: "standup-first" });
    createLaunch(store.db, { ...base, id: "again", kind: "adopted", tmuxSession: "standup-again" });
    createLaunch(store.db, { ...base, id: "lone", kind: "adopted", sessionId: undefined, tmuxSession: "standup-lone" });
    const first = getLaunch(store.db, "first")!;
    const again = getLaunch(store.db, "again")!;
    expect(launchScratchId(store.db, first)).toBe("first");
    expect(launchScratchId(store.db, again)).toBe("first");
    expect(launchScratchId(store.db, getLaunch(store.db, "lone")!)).toBe("lone");
    // The collector classifies the adopted launch's calls under the same scratch dir its pane's TMPDIR names.
    const server = serverFloorConfig(store.db, again, {}, env);
    expect({ launchId: server.launchId, scratchId: server.scratchId, scratchDir: server.scratchDir }).toEqual({ launchId: "again", scratchId: "first", scratchDir: "/cache/standup-scratch/first" });
    expect(decodeFloorConfig(encodeFloorConfig(server)).scratchDir).toBe("/cache/standup-scratch/first");
    expect(serverFloorConfig(store.db, first, {}, env)).toMatchObject({ launchId: "first", scratchDir: "/cache/standup-scratch/first" });
    expect(serverFloorConfig(store.db, first, {}, env)).not.toHaveProperty("scratchId");
  });
});

describe("env parsing", () => {
  test("personal AWS accounts keep only 12-digit ids", () => {
    expect(parsePersonalAwsAccounts(undefined)).toEqual([]);
    expect(parsePersonalAwsAccounts("")).toEqual([]);
    expect(parsePersonalAwsAccounts("1234567890123,abcdefghijkl,123456789012")).toEqual(["123456789012"]);
  });

  test("the wait falls back to the default unless it is a positive number", () => {
    expect(floorWaitSeconds(undefined)).toBe(DEFAULT_FLOOR_WAIT_S);
    expect(floorWaitSeconds("0")).toBe(DEFAULT_FLOOR_WAIT_S);
    expect(floorWaitSeconds("-5")).toBe(DEFAULT_FLOOR_WAIT_S);
    expect(floorWaitSeconds("soon")).toBe(DEFAULT_FLOOR_WAIT_S);
    expect(floorWaitSeconds(" 45 ")).toBe(45);
  });

  test("an org profile other than the default is carried to the hook and read back exactly", () => {
    setActiveOrgProfile(exampleCorpProfile());
    try {
      const config = buildLaunchFloorConfig({ launchId: "L1", root: "/r" }, { STANDUP_HOST_USER: "carol" });
      expect(config.orgProfile).toEqual(exampleCorpProfile());
      expect(config.ownerHosts).toEqual(["devbox-carol-*"]);
      expect(decodeFloorConfig(encodeFloorConfig(config)).orgProfile).toEqual(exampleCorpProfile());
      // A carried profile with an entry that doesn't validate makes the whole config malformed.
      const forged = { ...config, orgProfile: { ...exampleCorpProfile(), outwardRules: [{ pattern: "(", category: "outward", reason: "x" }] } };
      expect(() => decodeFloorConfig(encodeFloorConfig(forged as never))).toThrow("malformed safety-floor config");
    } finally {
      setActiveOrgProfile();
    }
  });

  test("owner hosts, Standup hosts and non-prod accounts default from the owner login and are configurable", () => {
    const defaults = buildLaunchFloorConfig({ launchId: "L1", root: "/r" }, { STANDUP_HOST_USER: "alice" });
    // The default org profile names no owner hosts, and no tunnel provider serves a Standup host.
    expect(defaults.ownerHosts).toEqual([]);
    expect(defaults.standupHosts).toEqual([]);
    // An org profile's owner-host globs and a tunnel provider's host fill them in.
    expect(ownerHosts(undefined, "Carol", exampleCorpProfile().ownerHostPatterns)).toEqual(["devbox-carol-*"]);
    const tunnels = commandTunnelProvider({ create: "t {port} {name}", url: "https://{name}.tunnels.example.com" });
    expect(standupHosts(undefined, "Carol", tunnels)).toEqual(["carol-standup.tunnels.example.com"]);
    expect(standupHosts(undefined, "carol", disabledTunnelProvider)).toEqual([]);
    expect(defaults.nonProdAwsAccounts).toEqual([...DEFAULT_NONPROD_AWS_ACCOUNTS]);
    expect([...DEFAULT_NONPROD_AWS_ACCOUNTS]).toEqual([]);
    const set = buildLaunchFloorConfig(
      { launchId: "L1", root: "/r" },
      { USER: "alice", STANDUP_FLOOR_OWNER_HOSTS: "Build-Box-1, devbox-alice-*", STANDUP_FLOOR_STANDUP_HOSTS: "", STANDUP_FLOOR_NONPROD_AWS_ACCOUNTS: "111122223333,bad" }
    );
    expect(set.ownerHosts).toEqual(["build-box-1", "devbox-alice-*"]);
    expect(set.standupHosts).toEqual([]);
    expect(set.nonProdAwsAccounts).toEqual(["111122223333"]);
    expect(decodeFloorConfig(encodeFloorConfig(set))).toEqual(set);
    expect(ownerHosts(undefined, "local")).toEqual([]);
    expect(ownerHosts(undefined, "a*b")).toEqual([]);
    expect(standupHosts(undefined, "local")).toEqual([]);
    expect(nonProdAwsAccounts("")).toEqual([]);
  });

  test("worktree roots: the data dir's, the env, the setting and the project's; never / or home", () => {
    const roots = floorWorktreeRoots("/data/standup", { STANDUP_WORKTREE_ROOT: "/wt", STANDUP_FLOOR_WORKTREE_ROOTS: "~/more, /, ~" }, ["~/setting-root", null, " /proj-root "], "/home/owner");
    expect(roots).toEqual(["/data/standup/worktrees", "/wt", "/home/owner/more", "/home/owner/setting-root", "/proj-root"]);
    expect(floorWorktreeRoots("/data/standup", {}, [], "/home/owner")).toEqual(["/data/standup/worktrees"]);
    const config = buildLaunchFloorConfig({ launchId: "L1", root: "/r", worktreeRoots: ["/proj-root"] }, { DB_PATH: "/data/standup/standup.db" });
    expect(config.worktreeRoots).toContain("/data/standup/worktrees");
    expect(config.worktreeRoots).toContain("/proj-root");
    expect(decodeFloorConfig(encodeFloorConfig(config))).toEqual(config);
  });

  test("the collector URL follows a specific bind host and stays loopback for a wildcard bind", () => {
    expect(collectorBaseUrl({ STANDUP_BIND_HOST: "0.0.0.0" })).toBe("http://127.0.0.1:7777");
    expect(collectorBaseUrl({ STANDUP_BIND_HOST: "10.0.0.5", COLLECTOR_PORT: "9000" })).toBe("http://10.0.0.5:9000");
  });
});

describe("floorSourcePaths", () => {
  test("covers the floor dir, the persona policy and org-profile modules the classifier imports, and the shared package", () => {
    expect(floorSourcePaths("/opt/standup/packages/collector/src/floor")).toEqual([
      "/opt/standup/packages/collector/src/floor",
      "/opt/standup/packages/collector/src/persona/policy.ts",
      "/opt/standup/packages/collector/src/persona/consent-target.ts",
      "/opt/standup/packages/collector/src/persona/owner-speech.ts",
      "/opt/standup/packages/collector/src/persona/review-noun.ts",
      "/opt/standup/packages/collector/src/org-profile",
      "/opt/standup/packages/shared",
    ]);
    const real = floorSourcePaths();
    expect(real.some((p) => p.endsWith("/packages/collector/src/persona/policy.ts"))).toBe(true);
    expect(real.some((p) => p.endsWith("/packages/shared"))).toBe(true);
  });

  test("covers every source file the hook loads through its relative imports", () => {
    const covered = floorSourcePaths();
    const within = (file: string) => covered.some((p) => file === p || file.startsWith(`${p}/`));
    // A statement's own specifiers: `import … from "./x.js"`, `export … from "../y.js"`, `import "./z.js"`.
    const specifiers = (text: string) => [...text.matchAll(/^(?:import|export)\b[^;]*?["'](\.{1,2}\/[^"']+)["']/gm)].map((m) => m[1]!);
    const sourceOf = (from: string, spec: string): string | null => {
      const target = resolve(dirname(from), spec);
      for (const candidate of [target.replace(/\.js$/, ".ts"), `${target}.ts`, `${target}/index.ts`, target]) {
        if (candidate.endsWith(".ts") && existsSync(candidate)) return candidate;
      }
      return null;
    };
    const seen = new Set<string>();
    const queue = [FLOOR_HOOK_PATH];
    while (queue.length > 0) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      for (const spec of specifiers(readFileSync(file, "utf8"))) {
        const next = sourceOf(file, spec);
        if (next) queue.push(next);
      }
    }
    expect([...seen].some((f) => f.endsWith("/persona/review-noun.ts"))).toBe(true);
    expect([...seen].filter((f) => !within(f))).toEqual([]);
  });
});

describe("floorRootReason", () => {
  const env = { DB_PATH: "/data/standup/standup.db", STANDUP_INSTALL_DIR: "/opt/standup" };

  test("a root that is, or sits above, the home dir, the data dir or the install dir is refused", () => {
    expect(floorRootReason(HOME, HOME, env)).toContain("home directory");
    expect(floorRootReason("/home", HOME, env)).toContain("home directory");
    expect(floorRootReason("/", HOME, env)).toContain("home directory");
    expect(floorRootReason("/data/standup", HOME, env)).toContain("data directory");
    expect(floorRootReason("/data", HOME, env)).toContain("data directory");
    expect(floorRootReason("/opt/standup", HOME, env)).toContain("install directory");
    expect(floorRootReason("/opt", HOME, env)).toContain("install directory");
  });

  test("a root strictly inside them, or beside them, is fine", () => {
    expect(floorRootReason(`${HOME}/code/repo`, HOME, env)).toBeUndefined();
    expect(floorRootReason("/data/standup/worktrees/proj/slug", HOME, env)).toBeUndefined();
    expect(floorRootReason("/opt/standup/packages/web", HOME, env)).toBeUndefined();
    expect(floorRootReason("/home/owner2", HOME, env)).toBeUndefined();
    expect(floorRootReason("/data/standup-other", HOME, env)).toBeUndefined();
  });

  test("floorUnavailableReason refuses such a root, so the launch falls back to auto", () => {
    const base = { fs: fakeFs({ [HOOK]: "", [`${HOME}/.claude/settings.json`]: '{"skipDangerousModePermissionPrompt":true}' }), home: HOME, hookPath: HOOK, env };
    expect(floorUnavailableReason([HOME], base)).toContain("contains the user's home directory");
    expect(floorUnavailableReason([ROOT, "/data/standup"], base)).toContain("data directory");
    expect(floorUnavailableReason([ROOT, `${HOME}/code`], base)).toBeUndefined();
  });
});

describe("floorUnavailableReason", () => {
  const opts = (files: Record<string, string>) => ({ fs: fakeFs(files), home: HOME, hookPath: HOOK });

  test("installable when the hook exists and no settings file disables hooks", () => {
    expect(
      floorUnavailableReason([ROOT], opts({ [HOOK]: "", [`${HOME}/.claude/settings.json`]: '{"skipDangerousModePermissionPrompt":true}' }))
    ).toBeUndefined();
  });

  test("a missing hook script blocks the floor", () => {
    expect(floorUnavailableReason([ROOT], opts({}))).toContain("missing");
  });

  test("disableAllHooks in the user's settings blocks the floor", () => {
    const reason = floorUnavailableReason([ROOT], opts({ [HOOK]: "", [`${HOME}/.claude/settings.json`]: '{"disableAllHooks":true}' }));
    expect(reason).toContain("disableAllHooks");
  });

  test("allowManagedHooksOnly in managed settings blocks the floor", () => {
    const reason = floorUnavailableReason(
      [ROOT],
      opts({ [HOOK]: "", "/etc/claude-code/managed-settings.json": '{"allowManagedHooksOnly":true}' })
    );
    expect(reason).toContain("allowManagedHooksOnly");
  });

  test("the worktree's own .claude settings are checked, local settings included", () => {
    expect(
      floorUnavailableReason([ROOT], opts({ [HOOK]: "", [`${ROOT}/.claude/settings.local.json`]: '{"disableAllHooks":true}' }))
    ).toContain(`${ROOT}/.claude/settings.local.json`);
    expect(
      floorUnavailableReason([ROOT], opts({ [HOOK]: "", [`${ROOT}/.claude/settings.json`]: '{"disableAllHooks":true}' }))
    ).toContain(`${ROOT}/.claude/settings.json`);
  });

  test("a false value or an unparseable file does not block the floor", () => {
    expect(
      floorUnavailableReason(
        [ROOT],
        opts({
          [HOOK]: "",
          [`${HOME}/.claude/settings.json`]: '{"disableAllHooks":false,"skipDangerousModePermissionPrompt":true}',
          [`${ROOT}/.claude/settings.json`]: "{not json",
        })
      )
    ).toBeUndefined();
  });

  test("bypass needs its confirmation dialog skipped or already accepted", () => {
    expect(floorUnavailableReason([ROOT], opts({ [HOOK]: "" }))).toContain("confirmation dialog");
    expect(
      floorUnavailableReason([ROOT], opts({ [HOOK]: "", [`${HOME}/.claude/settings.json`]: '{"skipDangerousModePermissionPrompt":false}' }))
    ).toContain("confirmation dialog");
    expect(floorUnavailableReason([ROOT], opts({ [HOOK]: "", [`${HOME}/.claude.json`]: '{"bypassPermissionsModeAccepted":true}' }))).toBeUndefined();
    expect(
      floorUnavailableReason([ROOT], opts({ [HOOK]: "", [`${ROOT}/.claude/settings.local.json`]: '{"skipDangerousModePermissionPrompt":true}' }))
    ).toBeUndefined();
  });

  test("a launch that doesn't bypass needs no dialog check, but still needs a hook that can run", () => {
    expect(floorUnavailableReason([ROOT], { ...opts({ [HOOK]: "" }), bypass: false })).toBeUndefined();
    expect(floorUnavailableReason([ROOT], { ...opts({}), bypass: false })).toContain("hook is missing");
    expect(
      floorUnavailableReason([ROOT], { ...opts({ [HOOK]: "", [`${HOME}/.claude/settings.json`]: '{"disableAllHooks":true}' }), bypass: false })
    ).toContain("disableAllHooks");
  });

  test("a managed-settings.d drop-in that disables hooks blocks the floor", () => {
    const reason = floorUnavailableReason(
      [ROOT],
      opts({
        [HOOK]: "",
        [`${HOME}/.claude/settings.json`]: '{"skipDangerousModePermissionPrompt":true}',
        "/etc/claude-code/managed-settings.d/10-ok.json": "{}",
        "/etc/claude-code/managed-settings.d/50-policy.json": '{"allowManagedHooksOnly":true}',
        "/etc/claude-code/managed-settings.d/notes.txt": '{"disableAllHooks":true}',
      })
    );
    expect(reason).toContain("/etc/claude-code/managed-settings.d/50-policy.json");
  });

  test("$CLAUDE_CONFIG_DIR's settings are checked, and its .claude.json can accept bypass", () => {
    const env = { CLAUDE_CONFIG_DIR: "/cfg/claude" };
    const base = { [HOOK]: "", [`${HOME}/.claude/settings.json`]: '{"skipDangerousModePermissionPrompt":true}' };
    expect(
      floorUnavailableReason([ROOT], { ...opts({ ...base, "/cfg/claude/settings.json": '{"disableAllHooks":true}' }), env })
    ).toContain("/cfg/claude/settings.json");
    expect(floorUnavailableReason([ROOT], { ...opts({ [HOOK]: "", "/cfg/claude/.claude.json": '{"bypassPermissionsModeAccepted":true}' }), env })).toBeUndefined();
    expect(claudeSettingsFiles([ROOT], HOME, fakeFs({}), env)).toContain("/cfg/claude/settings.local.json");
  });

  test("the settings list covers managed, user, and each dir's project + local files", () => {
    const files = claudeSettingsFiles([ROOT, `${ROOT}/src/pkg`], HOME);
    expect(files).toContain("/etc/claude-code/managed-settings.json");
    expect(files).toContain(`${HOME}/.claude/settings.json`);
    expect(files).toContain(`${ROOT}/.claude/settings.local.json`);
    expect(files).toContain(`${ROOT}/src/pkg/.claude/settings.json`);
  });
});
