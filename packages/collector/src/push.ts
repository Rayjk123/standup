// Push to phone via ntfy. Only asks/plans push — see high-level-design.md
// Component 5. Set NTFY_TOPIC to enable; unset means push is a no-op.
//
// Owner routing (opt-in via NTFY_OWNER_TOPICS): a per-owner topic map routes a
// session's attention to the responsible human's own topic instead of the shared
// default topic. The routing key is the session's RESPONSIBLE human — owner, else
// creator, else earliest participant (server.ts responsibleAlias) — not the
// owner_actor alone, which is unset until someone explicitly claims a session; a
// truly unattributed event (no responsible human at all) is SUPPRESSED rather
// than blasted to the default topic, mirroring OpenClaw's owner-less event
// suppression. With no owner-topic map configured, owner routing is off and every
// push goes to the default topic exactly as before.

const NTFY_URL = process.env.NTFY_URL ?? "https://ntfy.sh";
const NTFY_TOPIC = process.env.NTFY_TOPIC;

/**
 * Parse `alias:topic` comma/space-separated pairs (NTFY_OWNER_TOPICS) into a
 * lookup from a session owner actor alias to that owner's personal ntfy topic. A
 * malformed entry (missing side) is dropped rather than failing. Pure + exported
 * so the routing decision is unit-testable without env or network.
 */
export function parseOwnerTopics(raw: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const pair of (raw ?? "").split(/[,\s]+/)) {
    const [alias, topic] = pair.split(":");
    const a = alias?.trim();
    const t = topic?.trim();
    if (a && t) map.set(a, t);
  }
  return map;
}

/**
 * The ntfy topic a push should publish to, or `null` to SUPPRESS it. When no
 * owner-topic map is configured, every push targets the default topic (today's
 * broadcast — owner routing is off). When it is configured, a session with a
 * resolved responsible human routes to that human's own topic, a responsible
 * human we can't map falls back to the default topic, and a truly unattributed
 * event (`responsibleActor` null/undefined) is suppressed rather than blasted to
 * everyone. `responsibleActor` is the session's owner→creator→participant alias
 * (server.ts responsibleAlias), NOT owner_actor alone — a self-launched session
 * carries a creator even before anyone claims ownership, so it still routes to
 * that human instead of being dropped. Pure so it is unit-testable.
 */
export function resolvePushTopic(
  responsibleActor: string | null | undefined,
  defaultTopic: string | undefined,
  ownerTopics: Map<string, string>
): string | null {
  if (ownerTopics.size === 0) return defaultTopic ?? null; // owner routing off — broadcast as before
  const alias = responsibleActor?.trim();
  if (alias) return ownerTopics.get(alias) ?? defaultTopic ?? null; // their topic, else fall back
  return null; // no responsible human while owner routing is active — suppress
}

/**
 * Whether a push carrying `alias`'s own content (their brief, their job
 * updates) has a topic only they read: their entry in the owner-topic map,
 * or — with no map — the default topic when `alias` is the host, whose topic
 * it is. Never the shared default for anyone else, which resolvePushTopic
 * falls back to. Pure so it is unit-testable.
 */
export function hasPrivatePushTopic(alias: string, host: string, ownerTopics: Map<string, string>): boolean {
  return ownerTopics.size === 0 ? alias === host : ownerTopics.has(alias);
}

/** hasPrivatePushTopic against this process's NTFY_OWNER_TOPICS. */
export function privatePushAvailable(alias: string, host: string): boolean {
  return hasPrivatePushTopic(alias, host, parseOwnerTopics(process.env.NTFY_OWNER_TOPICS));
}

/**
 * Push a notification for a session's attention. `responsibleActor` is the
 * session's resolved responsible human (owner→creator→participant, server.ts
 * responsibleAlias), or null/undefined only when the session is genuinely
 * unattributed; it drives owner-topic routing + suppression (see
 * resolvePushTopic). Callers must pass the responsible alias, not owner_actor
 * alone — owner_actor is unset until a human explicitly claims the session.
 */
export async function pushNotification(
  title: string,
  message: string,
  responsibleActor?: string | null
): Promise<void> {
  const topic = resolvePushTopic(
    responsibleActor,
    NTFY_TOPIC,
    parseOwnerTopics(process.env.NTFY_OWNER_TOPICS)
  );
  if (!topic) return;

  try {
    await fetch(`${NTFY_URL}/${topic}`, {
      method: "POST",
      headers: {
        Title: title,
        Priority: "default",
      },
      body: message,
    });
  } catch (err) {
    console.error("[push] Failed to send notification:", err);
  }
}
