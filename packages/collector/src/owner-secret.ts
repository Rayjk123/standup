import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, type KeyObject } from "crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { ownerSecretsDir } from "@standup/shared/owner-token";
import { tokenMatches } from "@standup/shared/write-token";

/*
 * The per-install owner secret and the safety floor's reply key.
 *
 * A worker runs as the same Unix user as the collector and reaches it over
 * loopback, so neither the caller's address nor its OS user tells the owner
 * apart from a worker. What does is a secret only the owner's channels hold:
 * `<dataDir>/secrets/owner.token`, read by the web console's dev-server proxy
 * and the Slack adapter and presented as `x-standup-owner-token`. It is never
 * placed in an env var or argv the launcher passes a worker, and launched panes
 * get an environment scrubbed of anything secret (scrubSecretEnv); a worker
 * that reads the file trips the safety floor (FloorConfig.protectedPaths).
 *
 * Beside it, `floor-reply.key` is an Ed25519 private key (PKCS8 PEM) the
 * collector signs safety-floor replies with. Its public half goes into each
 * launch's FloorConfig, so the hook honors only replies this collector signed:
 * a process that binds the collector's port while it is down can't answer for
 * it.
 */

/** File name of the owner secret inside the secrets dir. */
export const OWNER_TOKEN_FILE = "owner.token";
/** File name of the floor reply signing key inside the secrets dir. */
export const FLOOR_REPLY_KEY_FILE = "floor-reply.key";

export interface OwnerSecrets {
  /** The owner secret (32 random bytes, hex). */
  ownerToken: string;
  /** The Ed25519 key floor replies are signed with. */
  replyPrivateKey: KeyObject;
  /** Its public half, SPKI DER base64 (FloorConfig.replyPublicKey). */
  replyPublicKey: string;
}

/** Filesystem operations ensureOwnerSecrets makes; injectable for tests. */
export interface OwnerSecretFs {
  mkdirPrivate(dir: string): void;
  /** The file's text, or undefined when it is missing or unreadable. */
  read(path: string): string | undefined;
  /** Creates `path` with mode 0600 only if it doesn't exist; false when it already did. */
  createPrivate(path: string, data: string): boolean;
  /** Overwrites `path` with mode 0600. */
  writePrivate(path: string, data: string): void;
  /** Re-tightens an existing file to 0600. */
  tighten(path: string): void;
}

const realFs: OwnerSecretFs = {
  mkdirPrivate(dir) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  },
  read(path) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
  },
  createPrivate(path, data) {
    try {
      writeFileSync(path, data, { mode: 0o600, flag: "wx" });
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw err;
    }
  },
  writePrivate(path, data) {
    writeFileSync(path, data, { mode: 0o600 });
    chmodSync(path, 0o600);
  },
  tighten(path) {
    if (existsSync(path)) chmodSync(path, 0o600);
  },
};

/** The public half of an Ed25519 private key, SPKI DER base64. */
export function publicKeyOf(privateKey: KeyObject): string {
  return createPublicKey(privateKey).export({ format: "der", type: "spki" }).toString("base64");
}

function newPrivateKeyPem(): string {
  const { privateKey } = generateKeyPairSync("ed25519");
  return privateKey.export({ format: "pem", type: "pkcs8" }).toString();
}

/** The Ed25519 private key a PEM holds, or undefined when it isn't one. */
function parsePrivateKey(pem: string | undefined): KeyObject | undefined {
  if (!pem?.trim()) return undefined;
  try {
    const key = createPrivateKey({ key: pem, format: "pem" });
    return key.asymmetricKeyType === "ed25519" ? key : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Returns `path`'s trimmed content, creating it with `make()` when missing or
 * unusable. A file another process created first wins the race; an existing
 * file is re-tightened to 0600.
 */
function ensureFile(fs: OwnerSecretFs, path: string, make: () => string, usable: (text: string | undefined) => boolean): string {
  const existing = fs.read(path);
  if (usable(existing)) {
    fs.tighten(path);
    return existing!.trim();
  }
  const fresh = make();
  if (existing === undefined && fs.createPrivate(path, `${fresh}\n`)) return fresh;
  const raced = fs.read(path);
  if (existing === undefined && usable(raced)) return raced!.trim();
  fs.writePrivate(path, `${fresh}\n`);
  return fresh;
}

/**
 * Ensures `<dataDir>/secrets/` (0700) holds the owner secret and the floor
 * reply key (both 0600), creating whichever is missing or unreadable, and
 * returns them. Existing secrets are reused, so a collector restart doesn't
 * invalidate the token the console and Slack already read or the public key
 * running launches carry.
 */
export function ensureOwnerSecrets(dataDir: string, fs: OwnerSecretFs = realFs): OwnerSecrets {
  const dir = ownerSecretsDir(dataDir);
  fs.mkdirPrivate(dir);
  const ownerToken = ensureFile(
    fs,
    join(dir, OWNER_TOKEN_FILE),
    () => randomBytes(32).toString("hex"),
    (text) => /^[0-9a-f]{64}$/.test(text?.trim() ?? "")
  );
  const pem = ensureFile(fs, join(dir, FLOOR_REPLY_KEY_FILE), newPrivateKeyPem, (text) => !!parsePrivateKey(text));
  const replyPrivateKey = parsePrivateKey(pem)!;
  return { ownerToken, replyPrivateKey, replyPublicKey: publicKeyOf(replyPrivateKey) };
}

/** Fresh in-memory secrets, persisted nowhere: a process that never loaded the install's secrets. */
export function generateOwnerSecrets(): OwnerSecrets {
  const replyPrivateKey = parsePrivateKey(newPrivateKeyPem())!;
  return { ownerToken: randomBytes(32).toString("hex"), replyPrivateKey, replyPublicKey: publicKeyOf(replyPrivateKey) };
}

let active: OwnerSecrets | undefined;

/** Makes `secrets` the ones this process signs floor replies with and checks owner tokens against. */
export function installOwnerSecrets(secrets: OwnerSecrets): void {
  active = secrets;
}

/**
 * The secrets this process uses: those the collector installed on start, else
 * an ephemeral in-memory set, so nothing that was never handed the install's
 * secrets (a test, a one-off script) can authorize owner decisions with them.
 */
export function activeOwnerSecrets(): OwnerSecrets {
  active ??= generateOwnerSecrets();
  return active;
}

/** Whether `presented` is the owner secret (constant-time). */
export function ownerTokenMatches(presented: string | null | undefined, secrets: OwnerSecrets): boolean {
  return tokenMatches(presented, secrets.ownerToken);
}

/**
 * Env vars that carry an owner-side, Persona or launch credential; launched
 * panes never inherit them. A launch's hook token (STANDUP_HOOK_TOKEN) reaches
 * only its own pane, through tmux `-e`.
 */
const SECRET_ENV = /^(?:STANDUP_OWNER_TOKEN.*|STANDUP_PERSONA_TOKEN|STANDUP_HOOK_TOKEN)$/;

/**
 * `env` without any variable that could carry an owner-side secret. The
 * launcher spawns tmux with this, so a tmux server the launch starts (whose
 * environment every pane inherits) never holds one.
 */
export function scrubSecretEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && !SECRET_ENV.test(key)) out[key] = value;
  }
  return out;
}

/** Env vars that carry or reach the owner's AWS, git-host, SSH or registry credentials. */
const CREDENTIAL_ENV =
  /^(?:AWS_.*|GH_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_TOKEN|GITLAB_TOKEN|GIT_ASKPASS|SSH_ASKPASS|SSH_AUTH_SOCK|NPM_TOKEN|NODE_AUTH_TOKEN|NPM_CONFIG__AUTH.*|npm_config__auth.*)$/;

/**
 * scrubSecretEnv without the owner's credentials either: the environment a
 * plan's acceptance criterion runs in. The criterion is worker-written code
 * run as the owner, so the AWS SDKs and CLI are pointed at empty config files,
 * git never prompts for a password, and no SSH agent or token is reachable.
 */
export function scrubCredentialEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(scrubSecretEnv(env))) {
    if (!CREDENTIAL_ENV.test(key)) out[key] = value;
  }
  out.AWS_CONFIG_FILE = "/dev/null";
  out.AWS_SHARED_CREDENTIALS_FILE = "/dev/null";
  out.AWS_EC2_METADATA_DISABLED = "true";
  out.GIT_TERMINAL_PROMPT = "0";
  return out;
}
