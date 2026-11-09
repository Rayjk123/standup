import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { consoleLogin } from "./console-login";

/**
 * console-login.ts's work, called in-process against a scratch owner-token
 * file and a scratch HOME: the sign-in URL it prints is built on the
 * configured console URL the same way the collector's links are.
 */

const root = mkdtempSync(join(tmpdir(), "standup-console-login-"));
const tokenFile = join(root, "owner.token");
writeFileSync(tokenFile, `${"k".repeat(43)}\n`);
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** Every location the script could read a secret from, under the scratch root. */
const ISOLATED_ENV: Record<string, string> = {
  HOME: root,
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_DATA_HOME: join(root, "data"),
  XDG_STATE_HOME: join(root, "state"),
  XDG_CACHE_HOME: join(root, "cache"),
  DB_PATH: join(root, "data", "standup.db"),
  TMPDIR: root,
  TMP: root,
  TEMP: root,
  STANDUP_OWNER_TOKEN_FILE: tokenFile,
};

test("the script runs fully isolated: the owner secret it reads is the throwaway one", () => {
  for (const value of Object.values(ISOLATED_ENV)) expect(value.startsWith(root)).toBe(true);
});

/** The URL line the script prints, run with only `env` (plus the isolated env) set. */
function printedUrl(env: Record<string, string>, args: string[] = []): string {
  const run = consoleLogin(args, { ...ISOLATED_ENV, ...env });
  if (run.code !== 0) throw new Error(`console-login exited ${run.code}: ${run.err.join("\n")}`);
  const line = run.out.find((l) => l.trim().startsWith("http"));
  if (!line) throw new Error(`no URL printed:\n${run.out.join("\n")}`);
  return line.trim();
}

describe("console-login origin", () => {
  test("STANDUP_WEB_URL, else STANDUP_CONSOLE_ORIGIN, else localhost:5173", () => {
    const cases: Array<[Record<string, string>, string]> = [
      [{}, "http://localhost:5173/__standup/login?code="],
      [{ STANDUP_WEB_URL: "https://alice-standup.tunnels.example.com/" }, "https://alice-standup.tunnels.example.com/__standup/login?code="],
      [{ STANDUP_CONSOLE_ORIGIN: "https://origin.example" }, "https://origin.example/__standup/login?code="],
      [
        { STANDUP_WEB_URL: "https://web.example", STANDUP_CONSOLE_ORIGIN: "https://origin.example" },
        "https://web.example/__standup/login?code=",
      ],
      // An unusable STANDUP_WEB_URL doesn't mask a good STANDUP_CONSOLE_ORIGIN.
      [{ STANDUP_WEB_URL: "web.example", STANDUP_CONSOLE_ORIGIN: "https://origin.example" }, "https://origin.example/__standup/login?code="],
    ];
    for (const [env, prefix] of cases) {
      const url = printedUrl(env);
      expect([env, url.startsWith(prefix)]).toEqual([env, true]);
    }
  });

  test("a --user link is built on the same origin", () => {
    const url = printedUrl({ STANDUP_WEB_URL: "https://web.example" }, ["--user", "bob"]);
    expect(url.startsWith("https://web.example/__standup/login?")).toBe(true);
  });
});
