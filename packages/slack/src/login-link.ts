// Console sign-in links the Slack bridge sends a mapped user who DMs `login`.
// A link carries a short-lived code bound to one alias and signed with the
// owner secret, which the console's dev-server proxy verifies before setting
// that user's signed `standup_user` cookie.

import { createHmac } from "node:crypto";

/** The console path that redeems a login code. */
export const LOGIN_PATH = "/__standup/login";

/** How long a login link stays valid. */
export const LOGIN_CODE_TTL_MS = 10 * 60 * 1000;

/**
 * The login code for `alias`, valid until `expirySeconds` (epoch seconds):
 * `<expiry>.<alias>.<hex hmac-sha256(ownerToken, "user-login:" + alias + ":" + expiry)>`.
 */
export function userLoginCode(ownerToken: string, alias: string, expirySeconds: number): string {
  const mac = createHmac("sha256", ownerToken).update(`user-login:${alias}:${expirySeconds}`).digest("hex");
  return `${expirySeconds}.${alias}.${mac}`;
}

/** A console login link for `alias` at `origin`, valid for LOGIN_CODE_TTL_MS from `nowMs`. */
export function userLoginLink(ownerToken: string, alias: string, origin: string, nowMs: number): string {
  const expiry = Math.floor((nowMs + LOGIN_CODE_TTL_MS) / 1000);
  const base = origin.replace(/\/+$/, "");
  return `${base}${LOGIN_PATH}?code=${encodeURIComponent(userLoginCode(ownerToken, alias, expiry))}`;
}
