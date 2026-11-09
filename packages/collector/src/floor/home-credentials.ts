import type { OrgProfile } from "../org-profile/types.js";

/**
 * The home directory's credential stores, relative to it: cloud, cluster,
 * package-registry, VCS-host and database credentials. Code search reads none
 * of them (code-search.ts protectedPaths); the safety floor holds reads of
 * their secret parts (HOME_SECRET_PATHS). An org's own SSO stores come from
 * its profile (homeCredentialPaths).
 */
export const HOME_CREDENTIAL_PATHS: readonly string[] = [
  ".aws",
  ".ssh",
  ".gnupg",
  ".docker/config.json",
  ".netrc",
  ".git-credentials",
  ".pgpass",
  ".my.cnf",
  ".config/gcloud",
  ".config/gh",
  ".config/hub",
  ".kube",
  ".azure",
  ".oci",
  ".npmrc",
  ".pypirc",
  ".m2/settings.xml",
  ".cargo/credentials",
  ".cargo/credentials.toml",
  ".terraform.d/credentials.tfrc.json",
  ".vault-token",
  ".boto",
  ".s3cfg",
  ".env",
  ".claude/.credentials.json",
  ".codex/auth.json",
  ".config/rclone",
  ".local/share/keyrings",
  ".password-store",
];

/**
 * The stores that hold plain configuration beside their secrets, narrowed
 * to the secrets: the AWS CLI's credentials file and token caches (not its
 * config), gpg's private keys (not its public keyring), gh's hosts file and
 * gcloud's credential stores (not their settings), kubectl's config (which
 * carries tokens). `.ssh` is left to sshPrivateKey.
 */
const SECRET_PARTS: Readonly<Record<string, readonly string[]>> = {
  ".aws": [".aws/credentials", ".aws/sso/cache", ".aws/cli/cache"],
  ".ssh": [],
  ".gnupg": [".gnupg/private-keys-v1.d", ".gnupg/secring.gpg"],
  ".config/gh": [".config/gh/hosts.yml"],
  ".config/gcloud": [".config/gcloud/credentials.db", ".config/gcloud/access_tokens.db", ".config/gcloud/legacy_credentials", ".config/gcloud/application_default_credentials.json"],
  ".kube": [".kube/config"],
};

/** The files and dirs under the home dir (relative to it) whose content is a credential, key or token: HOME_CREDENTIAL_PATHS narrowed by SECRET_PARTS. */
export const HOME_SECRET_PATHS: readonly string[] = HOME_CREDENTIAL_PATHS.flatMap((rel) => SECRET_PARTS[rel] ?? [rel]);

/** HOME_CREDENTIAL_PATHS with the org profile's SSO dirs and cookie files beside them, each relative to the home dir. */
export function homeCredentialPaths(profile: OrgProfile): string[] {
  return [...new Set([...HOME_CREDENTIAL_PATHS, ...profile.sso.dirs, ...profile.sso.cookieFiles])];
}

/** A file name a cookie store goes by: `cookie`, `Cookies`, `cookies.txt`, `cookies.sqlite`, `.erlang.cookie`, `session-cookie.json`. */
const COOKIE_NAME = /^(?:[^/]*[._-])?cookies?(?:\.(?:txt|jar|json|sqlite3?|db))?$/i;

/**
 * Whether `rel`, a path below the home dir (relative to it), is a cookie
 * store: a file named for cookies (COOKIE_NAME) in or below one of the home
 * dir's dot entries. An SSO tool's session cookie, a browser's cookie
 * database and a saved cookie jar each sign a request in as the owner, so
 * they are home secrets whether or not an org profile names the tool's dir.
 */
export function homeCookieFile(rel: string): boolean {
  if (!rel.startsWith(".") || rel.startsWith("../") || rel === "..") return false;
  return COOKIE_NAME.test(rel.slice(rel.lastIndexOf("/") + 1));
}

/**
 * A file name a credential or token cache goes by: `credentials`, `.credentials.json`, `token`, `access_token.json`,
 * `id-token`. A plural `tokens` is left out: a model's `added_tokens.json` is a vocabulary, not a secret.
 */
const CREDENTIAL_FILE_NAME =
  /^\.?(?:(?:[^/]*[._-])?credentials?|(?:(?:access|auth|api|id|refresh|session|oauth)[._-]?)?token)(?:\.(?:json|toml|ya?ml|ini|txt|db|sqlite3?))?$/i;

/**
 * Whether `rel`, a path below the home dir (relative to it), is a cookie
 * store (homeCookieFile) or a credential or token cache: a file named for
 * credentials or tokens (CREDENTIAL_FILE_NAME) in or below one of the home
 * dir's dot entries. A CLI's login cache (`~/.<tool>/credentials`,
 * `~/.cache/<tool>/token`) signs a request in as the owner, whether or not
 * HOME_CREDENTIAL_PATHS or an org profile names the tool's dir.
 */
export function homeSecretFile(rel: string): boolean {
  if (homeCookieFile(rel)) return true;
  if (!rel.startsWith(".") || rel.startsWith("../") || rel === "..") return false;
  return CREDENTIAL_FILE_NAME.test(rel.slice(rel.lastIndexOf("/") + 1));
}

/** The ssh dir under the home dir, whose private keys sshPrivateKey tells by name. */
export const SSH_DIR = ".ssh";

/** Files in the ssh dir that hold no private key: public keys, client config, host and authorized-key lists. */
const SSH_PUBLIC = /^(?:config|config\.d|known_hosts(?:\.old)?|known_hosts2|authorized_keys2?|environment|rc)$|\.pub$/;

/**
 * Whether `rel`, a path below the ssh dir (relative to it), may be a private
 * key: anything there but the public files SSH_PUBLIC names (and what is
 * under `config.d`).
 */
export function sshPrivateKey(rel: string): boolean {
  const first = rel.split("/")[0]!;
  return rel !== "" && !SSH_PUBLIC.test(first);
}
