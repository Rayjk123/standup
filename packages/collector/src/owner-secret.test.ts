import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ownerTokenPath, readOwnerToken } from "@standup/shared/owner-token";
import { signFloorReply, verifyFloorReply } from "./floor/gate.js";
import {
  FLOOR_REPLY_KEY_FILE,
  OWNER_TOKEN_FILE,
  ensureOwnerSecrets,
  generateOwnerSecrets,
  ownerTokenMatches,
  scrubSecretEnv,
} from "./owner-secret.js";
import { SLOT_ENV_VARS } from "@standup/shared/topology";
import { withoutSlotEnv, workerEnv } from "./worker-env.js";

/**
 * The per-install owner secret and floor reply key: created once under
 * <dataDir>/secrets with private permissions, reused across restarts, readable
 * by the owner's channels through the shared path helpers, and never carried
 * into a launched pane's environment.
 */

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function dataDir(): string {
  const d = mkdtempSync(join(tmpdir(), "owner-secret-test-"));
  dirs.push(d);
  return d;
}

const mode = (p: string) => statSync(p).mode & 0o777;

describe("ensureOwnerSecrets", () => {
  test("creates a 0700 secrets dir holding a 0600 owner token and Ed25519 key, and reuses them", () => {
    const dir = dataDir();
    const first = ensureOwnerSecrets(dir);
    const secrets = join(dir, "secrets");
    expect(mode(secrets)).toBe(0o700);
    expect(mode(join(secrets, OWNER_TOKEN_FILE))).toBe(0o600);
    expect(mode(join(secrets, FLOOR_REPLY_KEY_FILE))).toBe(0o600);
    expect(first.ownerToken).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(join(secrets, FLOOR_REPLY_KEY_FILE), "utf8")).toContain("BEGIN PRIVATE KEY");

    const again = ensureOwnerSecrets(dir);
    expect(again.ownerToken).toBe(first.ownerToken);
    expect(again.replyPublicKey).toBe(first.replyPublicKey);

    const fields = { requestId: "r", askId: "a", decision: "allow" as const, answer: "Allow once", callHash: "h" };
    expect(verifyFloorReply(first.replyPublicKey, fields, signFloorReply(again.replyPrivateKey, fields))).toBe(true);
  });

  test("the owner's channels read the same token through the shared path helpers", () => {
    const dir = dataDir();
    const { ownerToken } = ensureOwnerSecrets(dir);
    expect(readOwnerToken(ownerTokenPath({ DB_PATH: join(dir, "standup.db") }))).toBe(ownerToken);
    expect(ownerTokenPath({ DB_PATH: join(dir, "standup.db"), STANDUP_OWNER_TOKEN_FILE: "/elsewhere/owner.token" })).toBe("/elsewhere/owner.token");
    expect(readOwnerToken(join(dir, "missing"))).toBeUndefined();
  });

  test("a corrupt token or key is replaced, and a loosened file is re-tightened", () => {
    const dir = dataDir();
    const first = ensureOwnerSecrets(dir);
    const tokenFile = join(dir, "secrets", OWNER_TOKEN_FILE);
    const keyFile = join(dir, "secrets", FLOOR_REPLY_KEY_FILE);
    writeFileSync(tokenFile, "not a token\n", { mode: 0o644 });
    writeFileSync(keyFile, "garbage\n");
    const fixed = ensureOwnerSecrets(dir);
    expect(fixed.ownerToken).toMatch(/^[0-9a-f]{64}$/);
    expect(fixed.ownerToken).not.toBe(first.ownerToken);
    expect(fixed.replyPublicKey).not.toBe(first.replyPublicKey);
    expect(mode(tokenFile)).toBe(0o600);
  });

  test("ownerTokenMatches is exact", () => {
    const s = generateOwnerSecrets();
    expect(ownerTokenMatches(s.ownerToken, s)).toBe(true);
    expect(ownerTokenMatches(` ${s.ownerToken} `, s)).toBe(true);
    expect(ownerTokenMatches(s.ownerToken.slice(1), s)).toBe(false);
    expect(ownerTokenMatches(undefined, s)).toBe(false);
    expect(ownerTokenMatches(generateOwnerSecrets().ownerToken, s)).toBe(false);
  });
});

describe("scrubSecretEnv", () => {
  test("drops owner-token and Persona-token variables and keeps the rest", () => {
    const env = scrubSecretEnv({
      PATH: "/bin",
      HOME: "/home/o",
      STANDUP_OWNER_TOKEN: "secret",
      STANDUP_OWNER_TOKEN_FILE: "/x",
      STANDUP_PERSONA_TOKEN: "p",
      STANDUP_WRITE_TOKEN_FILE: "/w",
    });
    expect(env).toEqual({ PATH: "/bin", HOME: "/home/o", STANDUP_WRITE_TOKEN_FILE: "/w" });
  });
});

describe("workerEnv", () => {
  const slotVars = Object.fromEntries(SLOT_ENV_VARS.map((name, i) => [name, String(i + 1)]));

  test("drops the collector's slot vars and owner secrets, keeps the rest", () => {
    const env = workerEnv({ PATH: "/bin", COLLECTOR_PORT: "9100", STANDUP_OWNER_TOKEN: "secret", ...slotVars });
    expect(env).toEqual({ PATH: "/bin", COLLECTOR_PORT: "9100" });
  });

  test("withoutSlotEnv drops only the slot vars", () => {
    expect(withoutSlotEnv({ PATH: "/bin", STANDUP_PERSONA_TOKEN: "p", ...slotVars })).toEqual({ PATH: "/bin", STANDUP_PERSONA_TOKEN: "p" });
  });
});
