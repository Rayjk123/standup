/**
 * Spotting an "owner token missing" refusal from the collector, so the console
 * can tell the viewer to sign in instead of leaving a decision that silently did
 * nothing. The collector answers 403 with an error naming the owner-token header
 * when a request reaches it without the owner secret, which the dev-server proxy
 * omits for a browser that hasn't signed in (see owner-proxy.ts).
 */
import { useSyncExternalStore } from "react";

/** The header name the collector's owner-token refusal mentions. */
const OWNER_TOKEN_HEADER_NAME = "x-standup-owner-token";

/** What the notice tells the viewer to do. */
export const OWNER_SIGN_IN_NOTICE = "Sign in to the console as the owner: run `bun run scripts/console-login.ts` and open the link.";

/**
 * True for a 403 that means this browser must sign in as the owner. Its error
 * names the owner-token header, except that:
 * - an `unauthenticated` refusal never is (there is no identity to sign in);
 * - a `sign-in` refusal is one exactly when the viewer is the host
 *   (`viewerIsHost`); a guest is told how to sign in as themselves by the
 *   Persona view instead. While who the viewer is isn't known, the error's
 *   wording decides: the host's names the owner-token header, a guest's
 *   doesn't.
 */
export function isOwnerTokenDenial(status: number, body: unknown, viewerIsHost?: boolean): boolean {
  if (status !== 403 || typeof body !== "object" || body === null) return false;
  const { error, reason } = body as { error?: unknown; reason?: unknown };
  if (reason === "unauthenticated") return false;
  if (reason === "sign-in" && viewerIsHost !== undefined) return viewerIsHost;
  return typeof error === "string" && error.includes(OWNER_TOKEN_HEADER_NAME);
}

let viewerHost: boolean | undefined;

/** Records whether the console's viewer is the host (undefined while unknown), for `watchOwnerDenials`. */
export function setOwnerSignInViewer(isHost: boolean | undefined): void {
  viewerHost = isHost;
}

let denied = false;
const listeners = new Set<() => void>();

function markDenied(): void {
  if (denied) return;
  denied = true;
  for (const listener of listeners) listener();
}

/** Wraps `fetch` so an owner-token denial on any /api call raises the notice. Returns the restore function. */
export function watchOwnerDenials(
  target: { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> } = globalThis,
  isHost: () => boolean | undefined = () => viewerHost
): () => void {
  const original = target.fetch;
  target.fetch = async (input, init) => {
    const res = await original.call(target, input, init);
    if (res.status === 403) {
      res
        .clone()
        .json()
        .then((body: unknown) => {
          if (isOwnerTokenDenial(res.status, body, isHost())) markDenied();
        })
        .catch(() => {});
    }
    return res;
  };
  return () => {
    target.fetch = original;
  };
}

/** Whether the notice is raised, outside React. */
export function ownerSignInNeeded(): boolean {
  return denied;
}

/** True once a request has been refused for lacking the owner token. */
export function useOwnerSignInNeeded(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => denied,
  );
}

/** Clears the notice (the viewer dismissed it). */
export function dismissOwnerSignIn(): void {
  denied = false;
  for (const listener of listeners) listener();
}
