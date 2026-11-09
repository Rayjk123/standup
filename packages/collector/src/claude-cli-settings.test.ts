import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  utimesSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  headlessSettingsArgs,
  pickHeadlessSettings,
  runClaudeText,
  userSettingsPath,
} from "./claude-cli.js";

describe("pickHeadlessSettings", () => {
  test("keeps only the auth/model keys", () => {
    const picked = pickHeadlessSettings({
      awsCredentialExport: "/bin/export-creds",
      awsAuthRefresh: "cloud-creds refresh",
      apiKeyHelper: "/bin/key",
      env: { CLAUDE_CODE_USE_BEDROCK: "1" },
      modelOverrides: { sonnet: "us.anthropic.sonnet" },
      hooks: { Stop: [] },
      permissions: { allow: ["Bash"] },
      enabledPlugins: { x: true },
      statusLine: { type: "command" },
      mcpServers: {},
    });
    expect(picked).toEqual({
      awsCredentialExport: "/bin/export-creds",
      awsAuthRefresh: "cloud-creds refresh",
      apiKeyHelper: "/bin/key",
      env: { CLAUDE_CODE_USE_BEDROCK: "1" },
      modelOverrides: { sonnet: "us.anthropic.sonnet" },
    });
  });

  test("returns only the keys present", () => {
    expect(pickHeadlessSettings({ env: { A: "1" }, hooks: {} })).toEqual({ env: { A: "1" } });
  });

  test("null when none of the keys are present or the value is not an object", () => {
    expect(pickHeadlessSettings({ hooks: {}, permissions: {} })).toBeNull();
    expect(pickHeadlessSettings({})).toBeNull();
    expect(pickHeadlessSettings(null)).toBeNull();
    expect(pickHeadlessSettings([{ env: {} }])).toBeNull();
    expect(pickHeadlessSettings("env")).toBeNull();
  });
});

describe("headlessSettingsArgs", () => {
  let dir: string;
  let path: string;
  let out: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "standup-claude-settings-"));
    path = join(dir, "settings.json");
    out = join(dir, "private");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function forwarded(args: string[]): unknown {
    expect(args[0]).toBe("--settings");
    return JSON.parse(readFileSync(args[1]!, "utf8"));
  }

  test("forwards the picked subset through a 0600 file and drops everything else", () => {
    writeFileSync(
      path,
      JSON.stringify({ awsCredentialExport: "/bin/x", env: { SECRET: "s3cr3t" }, hooks: { Stop: [] }, permissions: {} })
    );
    const args = headlessSettingsArgs(path, out);
    expect(args).toHaveLength(2);
    expect(forwarded(args)).toEqual({ awsCredentialExport: "/bin/x", env: { SECRET: "s3cr3t" } });
    // The secret never appears on argv — only the file path does.
    expect(args.join(" ")).not.toContain("s3cr3t");
    expect(args[1]!.startsWith(out + "/")).toBe(true);
    expect(statSync(args[1]!).mode & 0o777).toBe(0o600);
    expect(statSync(out).mode & 0o777).toBe(0o700);
  });

  test("missing file → []", () => {
    expect(headlessSettingsArgs(join(dir, "absent.json"), out)).toEqual([]);
  });

  test("malformed JSON → []", () => {
    writeFileSync(path, "{ not json");
    expect(headlessSettingsArgs(path, out)).toEqual([]);
  });

  test("none of the keys → []", () => {
    writeFileSync(path, JSON.stringify({ hooks: {}, statusLine: {} }));
    expect(headlessSettingsArgs(path, out)).toEqual([]);
  });

  test("non-object JSON → []", () => {
    writeFileSync(path, JSON.stringify(["env"]));
    expect(headlessSettingsArgs(path, out)).toEqual([]);
  });

  test("serves the cached value until the file's mtime changes", () => {
    writeFileSync(path, JSON.stringify({ apiKeyHelper: "/bin/one" }));
    utimesSync(path, 1_000, 1_000);
    expect(forwarded(headlessSettingsArgs(path, out))).toEqual({ apiKeyHelper: "/bin/one" });

    // Same mtime: the content change is not observed.
    writeFileSync(path, JSON.stringify({ apiKeyHelper: "/bin/two" }));
    utimesSync(path, 1_000, 1_000);
    expect(forwarded(headlessSettingsArgs(path, out))).toEqual({ apiKeyHelper: "/bin/one" });

    utimesSync(path, 2_000, 2_000);
    expect(forwarded(headlessSettingsArgs(path, out))).toEqual({ apiKeyHelper: "/bin/two" });
  });

  test("an unchanged subset leaves the written file untouched", () => {
    writeFileSync(path, JSON.stringify({ apiKeyHelper: "/bin/one" }));
    utimesSync(path, 1_000, 1_000);
    const file = headlessSettingsArgs(path, out)[1]!;
    utimesSync(file, 5_000, 5_000);
    writeFileSync(path, JSON.stringify({ apiKeyHelper: "/bin/one", hooks: {} }));
    utimesSync(path, 2_000, 2_000);
    expect(headlessSettingsArgs(path, out)[1]).toBe(file);
    expect(statSync(file).mtimeMs).toBe(5_000_000);
  });

  test("a different path is read fresh", () => {
    const other = join(dir, "other.json");
    writeFileSync(path, JSON.stringify({ env: { A: "1" } }));
    writeFileSync(other, JSON.stringify({ env: { B: "2" } }));
    utimesSync(path, 1_000, 1_000);
    utimesSync(other, 1_000, 1_000);
    expect(forwarded(headlessSettingsArgs(path, out))).toEqual({ env: { A: "1" } });
    expect(forwarded(headlessSettingsArgs(other, out))).toEqual({ env: { B: "2" } });
  });

  test("a directory we own that others can write to (umask 002) is tightened, not dropped", () => {
    mkdirSync(out, { mode: 0o700 });
    chmodSync(out, 0o775);
    chmodSync(dir, 0o775);
    writeFileSync(path, JSON.stringify({ apiKeyHelper: "/bin/one" }));
    expect(forwarded(headlessSettingsArgs(path, out))).toEqual({ apiKeyHelper: "/bin/one" });
    expect(statSync(out).mode & 0o777).toBe(0o700);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  test("an unusable directory drops the settings with one warning, not silently and not per spawn", () => {
    writeFileSync(out, "not a directory");
    writeFileSync(path, JSON.stringify({ apiKeyHelper: "/bin/one" }));
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (msg: string) => warnings.push(msg);
    try {
      expect(headlessSettingsArgs(path, out)).toEqual([]);
      utimesSync(path, new Date(), new Date(Date.now() + 5_000));
      expect(headlessSettingsArgs(path, out)).toEqual([]);
    } finally {
      console.warn = origWarn;
    }
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("not forwarding user auth/model settings");
    expect(warnings[0]).toContain(`${out} is unusable`);
  });

  test("a symlink planted where the settings file goes is replaced, not followed", () => {
    mkdirSync(out, { mode: 0o700 });
    writeFileSync(path, JSON.stringify({ apiKeyHelper: "/bin/one" }));
    const first = headlessSettingsArgs(path, out)[1]!;
    const victim = join(dir, "victim");
    writeFileSync(victim, "original");
    rmSync(first);
    symlinkSync(victim, first);
    writeFileSync(path, JSON.stringify({ apiKeyHelper: "/bin/two" }));
    utimesSync(path, new Date(), new Date(Date.now() + 10_000));
    expect(forwarded(headlessSettingsArgs(path, out))).toEqual({ apiKeyHelper: "/bin/two" });
    expect(readFileSync(victim, "utf8")).toBe("original");
    expect(lstatSync(first).isSymbolicLink()).toBe(false);
  });

  test("a directory that is only readable by others is tightened to 0700", () => {
    mkdirSync(out, { mode: 0o700 });
    chmodSync(out, 0o755);
    writeFileSync(path, JSON.stringify({ apiKeyHelper: "/bin/one" }));
    expect(forwarded(headlessSettingsArgs(path, out))).toEqual({ apiKeyHelper: "/bin/one" });
    expect(statSync(out).mode & 0o777).toBe(0o700);
  });
});

describe("headless settings in runClaudeText argv", () => {
  const origSpawn = Bun.spawn;
  const origConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const origInternalRoot = process.env.STANDUP_INTERNAL_ROOT;
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "standup-claude-settings-"));
    process.env.CLAUDE_CONFIG_DIR = dir;
    process.env.STANDUP_INTERNAL_ROOT = join(dir, "internal");
  });
  afterEach(() => {
    Bun.spawn = origSpawn;
    if (origConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = origConfigDir;
    if (origInternalRoot === undefined) delete process.env.STANDUP_INTERNAL_ROOT;
    else process.env.STANDUP_INTERNAL_ROOT = origInternalRoot;
    rmSync(dir, { recursive: true, force: true });
  });

  function captureArgv() {
    let seen: string[] = [];
    Bun.spawn = ((cmd: string[]) => {
      seen = cmd;
      return {
        stdout: JSON.stringify({ result: "ok" }),
        stderr: "",
        exited: Promise.resolve(0),
        exitCode: 0,
        kill: () => {},
      };
    }) as unknown as typeof Bun.spawn;
    return () => seen;
  }

  test("CLAUDE_CONFIG_DIR locates the settings file", () => {
    expect(userSettingsPath()).toBe(join(dir, "settings.json"));
  });

  test("--settings follows the --setting-sources project pair", async () => {
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({ awsCredentialExport: "/bin/x", hooks: { SessionStart: [] } })
    );
    const getArgv = captureArgv();
    await runClaudeText("hi", { cwd: join(dir, "cwd") });

    const argv = getArgv();
    const idx = argv.indexOf("--setting-sources");
    expect(argv[idx + 1]).toBe("project");
    expect(argv[idx + 2]).toBe("--settings");
    expect(argv[idx + 3]).toStartWith(join(dir, "internal", "settings") + "/");
    expect(JSON.parse(readFileSync(argv[idx + 3]!, "utf8"))).toEqual({ awsCredentialExport: "/bin/x" });
  });

  test("no settings file adds no --settings flag", async () => {
    const getArgv = captureArgv();
    await runClaudeText("hi", { cwd: join(dir, "cwd") });
    expect(getArgv()).not.toContain("--settings");
  });
});
