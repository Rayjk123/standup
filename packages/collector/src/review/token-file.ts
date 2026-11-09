import { randomBytes } from "crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeSync,
} from "fs";
import { dirname, join, resolve } from "path";
import type { Database } from "bun:sqlite";
import { WORKER_TOKEN_FILE_ENV } from "@standup/shared";
import { workerTokensDir } from "@standup/shared/owner-token";
import { setLaunchReviewTokenHash } from "@standup/store";
import { workerTokenHash } from "../floor/gate.js";

/**
 * A launch's review token: the credential its worker's standup MCP server
 * presents on the review routes (WORKER_TOKEN_HEADER). It is kept apart from
 * the safety floor's worker token, which rides the floor hook's command line:
 * this one is written only to `<dataDir>/worker-tokens/<launchId>` (0600, in a
 * 0700 dir), the worker's environment carries only that path
 * (WORKER_TOKEN_FILE_ENV), and the collector keeps only its sha256 on the
 * launch row. The floor holds any worker's tool call reaching into the dir.
 */

/** A launch id safe to name a file with: letters, digits, `.`, `_`, `-`, not starting with a dot. */
const SAFE_LAUNCH_ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;

/** The review token file of `launchId`; throws for an id that can't name one. */
export function reviewTokenPath(dataDir: string, launchId: string): string {
  if (!SAFE_LAUNCH_ID.test(launchId)) throw new Error("the launch id can't name a review token file");
  const dir = workerTokensDir(dataDir);
  const path = join(dir, launchId);
  if (dirname(resolve(path)) !== resolve(dir)) throw new Error("the launch id can't name a review token file");
  return path;
}

/** Creates the token dir owner-only, or tightens it when it is already a real directory of this user's. */
function ensureTokenDir(dataDir: string): string {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const dir = workerTokensDir(dataDir);
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory() || (typeof process.getuid === "function" && st.uid !== process.getuid())) {
    throw new Error(`${dir} is not a directory of the collector's own`);
  }
  chmodSync(dir, 0o700);
  return dir;
}

/**
 * Mints a fresh review token for `launchId`, writes it to its owner-only file
 * (through a temp file renamed into place, never following a link), and
 * records its hash on the launch. Returns the file's path.
 */
export function issueReviewToken(db: Database, dataDir: string, launchId: string): string {
  const path = reviewTokenPath(dataDir, launchId);
  const dir = ensureTokenDir(dataDir);
  const token = randomBytes(32).toString("hex");
  const tmp = join(dir, `.${launchId}.${randomBytes(6).toString("hex")}.tmp`);
  const fd = openSync(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
  try {
    const bytes = Buffer.from(token, "utf8");
    let written = 0;
    while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written);
  } catch (err) {
    closeSync(fd);
    rmSync(tmp, { force: true });
    throw err;
  }
  closeSync(fd);
  try {
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  setLaunchReviewTokenHash(db, launchId, workerTokenHash(token));
  return path;
}

/** Removes a launch's review token file, if it has one. */
export function removeReviewToken(dataDir: string, launchId: string): void {
  try {
    rmSync(reviewTokenPath(dataDir, launchId), { force: true });
  } catch {
    // An id that can't name a file has none.
  }
}

/** The env a Claude launch's session starts with: the path of its review token file, never the token. */
export function reviewTokenEnv(tokenFile: string | undefined): Record<string, string> {
  return tokenFile ? { [WORKER_TOKEN_FILE_ENV]: tokenFile } : {};
}
