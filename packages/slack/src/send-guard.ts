// The single transmit chokepoint against blank Slack messages. Every subsystem
// (feed, asks, plans, the mirror's apiCall seam) posts through one shared
// WebClient; wrapping it here means no producer path — present or future — can
// land an empty bubble in a channel or thread. A message is "blank" when it
// carries no visible payload: no non-whitespace text, no blocks, no
// attachments; an append is blank when no chunk renders anything. Blank sends
// are dropped and answered with a synthetic ok so callers treat them as a
// harmless no-op rather than a failure.

import type { WebClient } from "@slack/web-api";

/** The visible-payload fields of a chat.* Web API call. */
interface MessageArgs {
  text?: unknown;
  blocks?: unknown;
  attachments?: unknown;
  chunks?: unknown;
}

const hasText = (v: unknown): boolean => typeof v === "string" && v.trim().length > 0;
const nonEmptyArray = (v: unknown): boolean => Array.isArray(v) && v.length > 0;

/** A chat.postMessage / chat.update that would render an empty message. */
export function isBlankMessage(args: MessageArgs): boolean {
  return !hasText(args.text) && !nonEmptyArray(args.blocks) && !nonEmptyArray(args.attachments);
}

/**
 * A chat.appendStream carrying nothing visible: no chunks, or only
 * whitespace-only markdown_text chunks (task/plan cards always render).
 */
export function isBlankAppend(args: MessageArgs): boolean {
  const chunks = args.chunks;
  if (!Array.isArray(chunks)) return true;
  return !chunks.some(
    (c) => (c as { type?: string }).type !== "markdown_text" || hasText((c as { text?: unknown }).text),
  );
}

/** Whether the (method, args) pair would transmit a blank message. */
function isBlankCall(method: string, args: MessageArgs): boolean {
  if (method === "chat.postMessage" || method === "chat.update" || method === "chat.postEphemeral")
    return isBlankMessage(args);
  if (method === "chat.appendStream") return isBlankAppend(args);
  return false;
}

/** Bind own function properties to the real target; pass namespaces/values through. */
function passthrough(target: object, prop: string | symbol): unknown {
  const v = (target as Record<string | symbol, unknown>)[prop];
  return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
}

/**
 * Return a WebClient that behaves identically except it silently drops blank
 * chat.postMessage / chat.update / chat.postEphemeral / chat.appendStream sends —
 * via both the typed `web.chat.*` methods and the raw `web.apiCall` seam the mirror
 * streams through. Non-message calls (auth, users, reactions, startStream, …) are
 * untouched.
 */
export function guardedWeb(web: WebClient): WebClient {
  const chat = web.chat;
  const chatProxy = new Proxy(chat, {
    get(target, prop) {
      if (prop === "postMessage" || prop === "update" || prop === "postEphemeral") {
        const real = (target as Record<string, unknown>)[prop] as (a: MessageArgs) => Promise<unknown>;
        return (args: MessageArgs) => (isBlankMessage(args) ? Promise.resolve({ ok: true }) : real.call(target, args));
      }
      return passthrough(target, prop);
    },
  });
  return new Proxy(web, {
    get(target, prop) {
      if (prop === "chat") return chatProxy;
      if (prop === "apiCall") {
        return (method: string, args?: Record<string, unknown>) =>
          isBlankCall(method, args ?? {}) ? Promise.resolve({ ok: true }) : target.apiCall(method, args);
      }
      return passthrough(target, prop);
    },
  }) as WebClient;
}
