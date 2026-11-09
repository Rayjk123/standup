// The per-channel Slack feature-toggle model, shared by the Slack adapter (which
// builds the toggles and their persist deltas) and the collector (which stores the
// blob and applies each delta on top of the current value). Keeping the shape and
// the merge here means the writer and the store agree on exactly one contract, so
// a per-channel delta the adapter sends is merged the same way the adapter would
// merge it locally.

/** Per-event-type feed switches — each gates one class of feed line. */
export interface FeedKinds {
  launched?: boolean;
  finished?: boolean;
  checkpoint?: boolean;
  stall?: boolean;
  knowledge?: boolean;
  ask?: boolean;
  digest?: boolean;
}

/** The coarse feature switches plus the fine-grained feed-kind switches for one channel. */
export interface ChannelFeatures {
  feed?: boolean;
  mirror?: boolean;
  asks?: boolean;
  feedKinds?: FeedKinds;
}

/** channel id → its overrides. A channel absent from the map takes the quiet default. */
export type ChannelFeatureMap = Record<string, ChannelFeatures>;

/**
 * A per-channel delta the collector applies on top of the CURRENT stored blob, so a
 * command's write can never clobber a concurrent per-channel edit:
 *  - `set`   — for each channel, field-merge these overrides onto its existing
 *              entry (coarse feed/mirror/asks replace; feedKinds merge key-by-key),
 *              so toggling one field leaves every other field — and every OTHER
 *              channel — untouched.
 *  - `clear` — remove these channels' entries entirely (the teardown verb).
 * The adapter sends only the channel a command actually touched; because the
 * collector applies the delta to the freshest blob under its own serialized write,
 * two concurrent commands — or a concurrent external edit to another channel —
 * commute instead of overwriting one another.
 */
export interface ChannelFeaturesPatch {
  set?: ChannelFeatureMap;
  clear?: string[];
}

/**
 * Parse the stored JSON blob into a map, failing OPEN to an empty map on a
 * missing, empty, non-object, or malformed value — a bad setting can never crash a
 * reader or resurrect stale channels. The Slack adapter and the collector both go
 * through this, so they agree on the shape.
 */
export function parseChannelFeatureMap(json: string | null | undefined): ChannelFeatureMap {
  if (!json || !json.trim()) return {};
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as ChannelFeatureMap;
  } catch {
    return {};
  }
}

/**
 * Apply a per-channel patch to a feature map, returning a NEW map (pure). `clear`
 * removes a channel's entry entirely; `set` field-merges each channel's overrides
 * onto its existing entry — coarse flags (feed/mirror/asks) replace, feedKinds
 * merge key-by-key — so a delta touching one field/channel preserves every other
 * field and channel. Applied server-side against the current blob, this makes
 * concurrent per-channel writes commute: neither the whole-blob overwrite that
 * dropped an external channel edit nor two racing commands losing each other's
 * toggle can happen, because no writer ever replaces the whole value.
 */
export function mergeChannelFeaturesPatch(
  map: ChannelFeatureMap,
  patch: ChannelFeaturesPatch | null | undefined,
): ChannelFeatureMap {
  const next: ChannelFeatureMap = { ...map };
  if (!patch || typeof patch !== "object") return next;
  for (const id of Array.isArray(patch.clear) ? patch.clear : []) {
    if (typeof id === "string") delete next[id];
  }
  const set = patch.set && typeof patch.set === "object" && !Array.isArray(patch.set) ? patch.set : {};
  for (const [id, feats] of Object.entries(set)) {
    if (!feats || typeof feats !== "object") continue;
    const cur: ChannelFeatures = { ...(next[id] ?? {}) };
    for (const [k, v] of Object.entries(feats)) {
      if (k === "feedKinds") {
        if (v && typeof v === "object") {
          cur.feedKinds = { ...(cur.feedKinds ?? {}), ...(v as FeedKinds) };
        }
      } else {
        (cur as Record<string, unknown>)[k] = v;
      }
    }
    next[id] = cur;
  }
  return next;
}
