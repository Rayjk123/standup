/**
 * The gateway's code version: a sha256 over its source files (tests excluded),
 * the shared topology contract it implements and the shared process-identity
 * checks it relies on. dev.ts compares it with the
 * `version` in gateway.json to decide whether the running gateway is stale.
 * Reading this module has no side effects.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

const SRC_DIR = import.meta.dir;

/** The source files the version covers, as absolute paths in a stable order. */
export function gatewaySourceFiles(srcDir: string = SRC_DIR): string[] {
  const own = readdirSync(srcDir)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .sort()
    .map((name) => join(srcDir, name));
  return [...own, Bun.resolveSync("@standup/shared/topology", SRC_DIR), Bun.resolveSync("@standup/shared/process-identity", SRC_DIR)];
}

export function gatewayVersion(srcDir: string = SRC_DIR): string {
  const hash = createHash("sha256");
  for (const file of gatewaySourceFiles(srcDir)) {
    // Hashing the name too means a rename alone is a new version.
    hash.update(basename(file));
    hash.update("\0");
    hash.update(readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}
