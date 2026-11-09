/**
 * Where the owner secret lives, for the owner's own channels (the web console's
 * dev-server proxy, the Slack adapter) to read and present as
 * `x-standup-owner-token`.
 *
 * The collector creates the secret on start under `<dataDir>/secrets/` (dir
 * 0700, file 0600; see the collector's owner-secret.ts). It authorizes the
 * decisions only the owner may make: allowing a safety-floor hold, deciding a
 * Persona approval, and changing what a project launch runs. It is never put in
 * an env var or argv the launcher hands a worker, so a worker reaches it only by
 * reading the file, which the safety floor treats as tampering.
 *
 * Node-only (fs/os/path) — imported through the `@standup/shared/owner-token`
 * subpath so the browser bundle never pulls it in.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** The header an owner channel presents the owner secret in. */
export const OWNER_TOKEN_HEADER = "x-standup-owner-token";

/**
 * The header an owner channel names the user it speaks for in (the Slack bridge
 * relaying an authenticated Slack user). The collector honors it only alongside
 * the owner secret.
 */
export const PERSONA_USER_HEADER = "x-standup-persona-user";

/**
 * The header a user's signed-in console browser presents its user channel token
 * in (see userChannelToken). It proves a Persona write comes from that user's own
 * channel rather than from a worker on the same loopback forging the tunnel header.
 */
export const USER_CHANNEL_HEADER = "x-standup-user-token";

/**
 * The user channel token for `alias`: hmac-sha256(ownerToken, "user:" + alias),
 * hex. Only a holder of the owner secret (the console's dev-server proxy, the
 * Slack bridge, the collector) can mint it, and it is bound to one alias.
 */
export function userChannelToken(ownerToken: string, alias: string): string {
  return createHmac("sha256", ownerToken).update(`user:${alias}`).digest("hex");
}

/** Whether `presented` is `alias`'s user channel token under `ownerToken` (constant-time). */
export function userChannelTokenMatches(
  ownerToken: string,
  alias: string,
  presented: string | null | undefined
): boolean {
  if (!presented || !alias) return false;
  const expected = Buffer.from(userChannelToken(ownerToken, alias));
  const given = Buffer.from(presented.trim());
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** Standup's data dir: the directory holding the collector's DB (`DB_PATH`, else `~/.local/share/standup/standup.db`). */
export function standupDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return dirname(env.DB_PATH ?? join(homedir(), ".local", "share", "standup", "standup.db"));
}

/**
 * The socket of the tmux server every launched worker's pane runs on,
 * `<dataDir>/tmux/workers` (constants' WORKER_TMUX_SOCKET_SUBPATH; spelled
 * out here because Node, which loads this file for the dev server's config,
 * can't import a sibling `.ts` by its `.js` name).
 */
export function workerTmuxSocket(dataDir: string = standupDataDir()): string {
  return join(resolve(dataDir), "tmux", "workers");
}

/**
 * The directory (owner-only) the collector keeps each launch's review token
 * file in, `<dataDir>/worker-tokens/<launchId>`; the safety floor holds any
 * worker reaching into it.
 */
export function workerTokensDir(dataDir: string = standupDataDir()): string {
  return join(dataDir, "worker-tokens");
}

/**
 * Where the collector keeps its stored copies of review media,
 * `<dataDir>/review-media/`; the safety floor holds any worker reaching into it.
 */
export function reviewMediaDir(dataDir: string = standupDataDir()): string {
  return join(dataDir, "review-media");
}

/**
 * The parent of every launch's review scratch dir, `<dataDir>/review-scratch/`;
 * the safety floor holds any worker reaching into it outside its own launch's.
 */
export function reviewScratchRoot(dataDir: string = standupDataDir()): string {
  return join(dataDir, "review-scratch");
}

/** The directory the collector keeps its owner-side secrets in. */
export function ownerSecretsDir(dataDir: string = standupDataDir()): string {
  return join(dataDir, "secrets");
}

/**
 * The owner-secret file an owner channel reads: `STANDUP_OWNER_TOKEN_FILE` when
 * set (a channel running on another host, or as another user, points it at its
 * own copy), else `<dataDir>/secrets/owner.token`.
 */
export function ownerTokenPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.STANDUP_OWNER_TOKEN_FILE?.trim();
  return override || join(ownerSecretsDir(standupDataDir(env)), "owner.token");
}

/** The owner secret stored at `path`, or undefined when the file is missing, empty or unreadable. */
export function readOwnerToken(path: string = ownerTokenPath()): string | undefined {
  try {
    const token = readFileSync(path, "utf8").trim();
    return token || undefined;
  } catch {
    return undefined;
  }
}
