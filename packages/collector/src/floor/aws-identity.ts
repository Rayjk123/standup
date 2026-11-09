import { createHash, createHmac } from "crypto";
import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { AwsTarget } from "./classify.js";

/*
 * The collector's answer to "which account would this AWS CLI call run in?"
 * for a call whose command line doesn't name one: the account of the static
 * credentials the CLI would pick up, asked of STS (GetCallerIdentity).
 *
 * The hook never asks this (its awsAccount probe answers null): it runs in the
 * worker's environment. The collector asks it while re-classifying a hold, so
 * a mutating call in a personal account the command doesn't name can go to
 * Persona instead of the owner.
 *
 * The CLI itself is never run, and no profile setting that runs a command or
 * fetches credentials elsewhere is followed. The credentials are read the way
 * the CLI reads them in the plainest case only, and anything else answers null:
 * - keys in the environment (the call's own assignments, else the collector's
 *   environment, which workers inherit at launch);
 * - else the profile's `aws_access_key_id` / `aws_secret_access_key` /
 *   `aws_session_token` in the shared credentials file, when the profile's
 *   config section has no role, SSO, web-identity or credential_process setting.
 * The request is signed with those keys and sent to the global STS endpoint
 * with a short timeout, so a worker-written `endpoint_url` can't answer it.
 * Answers are cached per credential set; a failure is cached briefly.
 */

/** Environment variables that hand the CLI credentials other than a profile's static keys. */
const OTHER_SOURCES = [
  "AWS_ROLE_ARN",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
];

/** Profile config keys under which the CLI gets credentials some other way than static keys. */
const INDIRECT_PROFILE_KEY = /^(?:role_arn|source_profile|credential_source|web_identity_token_file|credential_process|sso_[a-z_]+)$/;

const STS_HOST = "sts.amazonaws.com";
const STS_BODY = "Action=GetCallerIdentity&Version=2011-06-15";

export interface AwsKeys {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface AwsIdentityOptions {
  /** The environment the worker's calls inherit. Defaults to the collector's own. */
  env?: Record<string, string | undefined>;
  home?: string;
  readFile?: (path: string) => string | null;
  /** Asks STS for the account of `keys`; null when it can't tell. */
  callerAccount?: (keys: AwsKeys, timeoutMs: number) => Promise<string | null>;
  now?: () => number;
  timeoutMs?: number;
  ttlMs?: number;
  failureTtlMs?: number;
}

export interface AwsIdentity {
  /**
   * The account `target`'s credentials belong to, as far as is known now: the
   * cached answer, null when the credentials can't be read (or STS couldn't
   * tell, recently), undefined when STS hasn't been asked yet.
   */
  cached(target: AwsTarget): string | null | undefined;
  /** Asks STS when `cached` is undefined; never throws. */
  resolve(target: AwsTarget): Promise<string | null>;
}

const readOrNull = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

/** The keys of one INI section (`[name]`), lower-cased; null when the section is absent. */
export function iniSection(text: string, name: string): Map<string, string> | null {
  let found: Map<string, string> | null = null;
  let current: Map<string, string> | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const header = /^\[\s*(.+?)\s*\]$/.exec(line);
    if (header) {
      current = header[1] === name ? (found ??= new Map()) : null;
      continue;
    }
    const kv = /^([^=\s]+)\s*=\s*(.*)$/.exec(line);
    if (current && kv) current.set(kv[1]!.toLowerCase(), kv[2]!.trim());
  }
  return found;
}

/** The static keys a call with `target` would run with, or null when that isn't plainly readable. */
export function awsKeysFor(target: AwsTarget, opts: Pick<AwsIdentityOptions, "env" | "home" | "readFile"> = {}): AwsKeys | null {
  const base = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const read = opts.readFile ?? readOrNull;
  if (target.env.HOME !== undefined && target.env.HOME !== home) return null;
  const get = (name: string): string | undefined => target.env[name] ?? base[name] ?? undefined;
  if (OTHER_SOURCES.some((n) => get(n))) return null;
  const envKey = get("AWS_ACCESS_KEY_ID");
  const envSecret = get("AWS_SECRET_ACCESS_KEY");
  if (envKey || envSecret) {
    if (!envKey || !envSecret) return null;
    const token = get("AWS_SESSION_TOKEN");
    return { accessKeyId: envKey, secretAccessKey: envSecret, ...(token ? { sessionToken: token } : {}) };
  }
  const named = [target.profile, get("AWS_PROFILE"), get("AWS_DEFAULT_PROFILE")].filter((p): p is string => !!p);
  const profile = named[0] ?? "default";
  // Without --profile, AWS_PROFILE and AWS_DEFAULT_PROFILE disagreeing leaves which one the CLI version honors open.
  if (!target.profile && named.length === 2 && named[0] !== named[1]) return null;
  const configText = read(get("AWS_CONFIG_FILE") || join(home, ".aws", "config"));
  if (configText !== null) {
    const section = iniSection(configText, profile === "default" ? "default" : `profile ${profile}`);
    if (section && [...section.keys()].some((k) => INDIRECT_PROFILE_KEY.test(k))) return null;
  }
  const credsText = read(get("AWS_SHARED_CREDENTIALS_FILE") || join(home, ".aws", "credentials"));
  if (credsText === null) return null;
  const creds = iniSection(credsText, profile);
  const accessKeyId = creds?.get("aws_access_key_id");
  const secretAccessKey = creds?.get("aws_secret_access_key");
  if (!accessKeyId || !secretAccessKey) return null;
  const sessionToken = creds?.get("aws_session_token");
  return { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) };
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const hmac = (key: Buffer | string, s: string) => createHmac("sha256", key).update(s, "utf8").digest();

/** STS GetCallerIdentity with SigV4-signed `keys`; the 12-digit account, or null. */
export async function stsCallerAccount(keys: AwsKeys, timeoutMs: number): Promise<string | null> {
  const amzDate = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const day = amzDate.slice(0, 8);
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded; charset=utf-8",
    host: STS_HOST,
    "x-amz-date": amzDate,
    ...(keys.sessionToken ? { "x-amz-security-token": keys.sessionToken } : {}),
  };
  const names = Object.keys(headers).sort();
  const signedHeaders = names.join(";");
  const canonical = ["POST", "/", "", ...names.map((n) => `${n}:${headers[n]}`), "", signedHeaders, sha256(STS_BODY)].join("\n");
  const scope = `${day}/us-east-1/sts/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
  let key: Buffer = hmac(`AWS4${keys.secretAccessKey}`, day);
  for (const part of ["us-east-1", "sts", "aws4_request"]) key = hmac(key, part);
  const signature = createHmac("sha256", key).update(toSign, "utf8").digest("hex");
  const { host: _host, ...sent } = headers;
  try {
    const res = await fetch(`https://${STS_HOST}/`, {
      method: "POST",
      headers: { ...sent, authorization: `AWS4-HMAC-SHA256 Credential=${keys.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` },
      body: STS_BODY,
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const account = /<Account>\s*(\d{12})\s*<\/Account>/.exec(await res.text());
    return account ? account[1]! : null;
  } catch {
    return null;
  }
}

export function createAwsIdentity(opts: AwsIdentityOptions = {}): AwsIdentity {
  const callerAccount = opts.callerAccount ?? stsCallerAccount;
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? 3000;
  const ttlMs = opts.ttlMs ?? 15 * 60_000;
  const failureTtlMs = opts.failureTtlMs ?? 30_000;
  const cache = new Map<string, { account: string | null; until: number }>();
  const keyOf = (keys: AwsKeys) => sha256(`${keys.accessKeyId}\0${keys.secretAccessKey}\0${keys.sessionToken ?? ""}`);
  const keysOf = (target: AwsTarget): AwsKeys | null => {
    try {
      return awsKeysFor(target, opts);
    } catch {
      return null;
    }
  };
  const lookup = (keys: AwsKeys): string | null | undefined => {
    const hit = cache.get(keyOf(keys));
    return hit && hit.until > now() ? hit.account : undefined;
  };
  return {
    cached(target) {
      const keys = keysOf(target);
      return keys ? lookup(keys) : null;
    },
    async resolve(target) {
      const keys = keysOf(target);
      if (!keys) return null;
      const hit = lookup(keys);
      if (hit !== undefined) return hit;
      let account: string | null;
      try {
        account = await callerAccount(keys, timeoutMs);
      } catch {
        account = null;
      }
      if (account !== null && !/^\d{12}$/.test(account)) account = null;
      if (cache.size >= 64) cache.clear();
      cache.set(keyOf(keys), { account, until: now() + (account ? ttlMs : failureTtlMs) });
      return account;
    },
  };
}

/** The collector's resolver, shared by every hold. */
export const collectorAwsIdentity: AwsIdentity = createAwsIdentity();
