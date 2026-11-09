import { expect, test, describe, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runClaudeText } from "./claude-cli.js";

// The headless internal call must NOT load the user's ~/.claude/settings.json:
// on some Claude Code installs the SessionStart hook fires even under `-p`, registering a
// phantom Standup session. `--setting-sources project` drops the user source and
// `--strict-mcp-config` makes the resulting lack of MCP explicit — matching the
// isolation the other internal callers (review-cron, distill-cron, etc.) use.
describe("runClaudeText — isolates headless calls from user settings/hooks", () => {
  const origSpawn = Bun.spawn;
  afterEach(() => {
    Bun.spawn = origSpawn;
  });

  function captureArgv(result: { result?: string; is_error?: boolean } = { result: "ok" }) {
    let seen: string[] = [];
    Bun.spawn = ((cmd: string[]) => {
      seen = cmd;
      return {
        stdout: JSON.stringify(result),
        stderr: "",
        exited: Promise.resolve(0),
        exitCode: 0,
        kill: () => {},
      };
    }) as unknown as typeof Bun.spawn;
    return () => seen;
  }

  test("argv carries --setting-sources project and --strict-mcp-config with tools disabled", async () => {
    const dir = mkdtempSync(join(tmpdir(), "standup-claude-cli-"));
    const getArgv = captureArgv();
    try {
      const out = await runClaudeText("hello", { cwd: dir });
      expect(out).toBe("ok");

      const argv = getArgv();
      const settingSourcesIdx = argv.indexOf("--setting-sources");
      expect(settingSourcesIdx).toBeGreaterThan(-1);
      expect(argv[settingSourcesIdx + 1]).toBe("project");
      expect(argv).toContain("--strict-mcp-config");

      // The invocation stays a tool-less JSON headless call.
      const toolsIdx = argv.indexOf("--tools");
      expect(toolsIdx).toBeGreaterThan(-1);
      expect(argv[toolsIdx + 1]).toBe("");
      expect(argv).toContain("-p");
      expect(argv).toContain("--output-format");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the prompt goes on stdin, never on argv", async () => {
    const dir = mkdtempSync(join(tmpdir(), "standup-claude-cli-"));
    let seen: string[] = [];
    let stdin = "";
    Bun.spawn = ((cmd: string[], opts: { stdin: Blob }) => {
      seen = cmd;
      const read = opts.stdin.text().then((t) => (stdin = t));
      return {
        stdout: JSON.stringify({ result: "ok" }),
        stderr: "",
        exited: read.then(() => 0),
        exitCode: 0,
        kill: () => {},
      };
    }) as unknown as typeof Bun.spawn;
    try {
      const prompt = "summarize: secret brief text";
      expect(await runClaudeText(prompt, { cwd: dir })).toBe("ok");
      expect(stdin).toBe(prompt);
      expect(seen.join(" ")).not.toContain("secret brief text");
      expect(seen[seen.indexOf("-p") + 1]).toBe("--tools");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("still forwards --model alongside the isolation flags", async () => {
    const dir = mkdtempSync(join(tmpdir(), "standup-claude-cli-"));
    const getArgv = captureArgv();
    try {
      await runClaudeText("hi", { cwd: dir, model: "haiku" });

      const argv = getArgv();
      expect(argv).toContain("--setting-sources");
      expect(argv).toContain("--strict-mcp-config");
      const modelIdx = argv.indexOf("--model");
      expect(modelIdx).toBeGreaterThan(-1);
      expect(argv[modelIdx + 1]).toBe("haiku");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
