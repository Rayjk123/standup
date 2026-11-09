import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureLocalWriteToken,
  localWriteTokenPath,
  readLocalWriteToken,
  tokenMatches,
} from "./write-token.js";

describe("per-user local write token", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "standup-wt-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("creates a 0600 token in a 0700 dir when missing", () => {
    const path = join(dir, "nested", "write-token");
    const token = ensureLocalWriteToken(path);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(path, "utf8").trim()).toBe(token);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "nested")).mode & 0o777).toBe(0o700);
  });

  test("reuses an existing token and re-tightens loosened permissions", () => {
    const path = join(dir, "write-token");
    const first = ensureLocalWriteToken(path);
    chmodSync(path, 0o644);
    expect(ensureLocalWriteToken(path)).toBe(first);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("replaces an empty token file", () => {
    const path = join(dir, "write-token");
    writeFileSync(path, "");
    const token = ensureLocalWriteToken(path);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(readLocalWriteToken(path)).toBe(token);
  });

  test("read returns undefined for a missing file", () => {
    expect(readLocalWriteToken(join(dir, "absent"))).toBeUndefined();
  });

  test("STANDUP_WRITE_TOKEN_FILE overrides the default path", () => {
    expect(localWriteTokenPath({ STANDUP_WRITE_TOKEN_FILE: "/x/y" })).toBe("/x/y");
    expect(localWriteTokenPath({})).toMatch(/\.standup\/write-token$/);
  });

  test("tokenMatches requires a non-empty exact match", () => {
    expect(tokenMatches("abc", "abc")).toBe(true);
    expect(tokenMatches(" abc ", "abc")).toBe(true);
    expect(tokenMatches("abd", "abc")).toBe(false);
    expect(tokenMatches("ab", "abc")).toBe(false);
    expect(tokenMatches(undefined, "abc")).toBe(false);
    expect(tokenMatches("", "")).toBe(false);
    expect(tokenMatches("abc", undefined)).toBe(false);
  });
});
