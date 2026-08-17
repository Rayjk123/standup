import { expect, test, describe } from "bun:test";
import { tokenizeArgs } from "./launcher.js";

/**
 * `tokenizeArgs` turns a project's `launchArgs` string into argv tokens for
 * the `claude` invocation. It runs straight into the process argv (no shell),
 * so grouping quoted values correctly is the whole point — a naive whitespace
 * split would break any flag whose value contains a space.
 */
describe("tokenizeArgs", () => {
  test("empty / whitespace-only input yields no tokens", () => {
    expect(tokenizeArgs(undefined)).toEqual([]);
    expect(tokenizeArgs("")).toEqual([]);
    expect(tokenizeArgs("   ")).toEqual([]);
  });

  test("splits a simple flag and value on whitespace", () => {
    expect(tokenizeArgs("--permission-mode acceptEdits")).toEqual([
      "--permission-mode",
      "acceptEdits",
    ]);
  });

  test("collapses runs of whitespace", () => {
    expect(tokenizeArgs("  --a   b  ")).toEqual(["--a", "b"]);
  });

  test("keeps a double-quoted value as one token, quotes stripped", () => {
    expect(tokenizeArgs('--append-system-prompt "be terse and precise"')).toEqual([
      "--append-system-prompt",
      "be terse and precise",
    ]);
  });

  test("keeps a single-quoted value as one token, quotes stripped", () => {
    expect(tokenizeArgs("--x 'a b c'")).toEqual(["--x", "a b c"]);
  });

  test("handles several flags together", () => {
    expect(
      tokenizeArgs('--permission-mode acceptEdits --add-dir "/tmp/my dir"')
    ).toEqual(["--permission-mode", "acceptEdits", "--add-dir", "/tmp/my dir"]);
  });
});
