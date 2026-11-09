// Per-channel Slack feature toggles. A channel can turn whole features
// (feed / mirror / asks) or individual feed event-kinds (launched / finished /
// …) on or off without affecting any other channel. The default posture is
// QUIET: a channel with no settings mirrors no sessions (mirror OFF) and posts
// NO feed lines (feed OFF, every feed-kind OFF) until a human opts in with
// `mirror on` / `feed on`; Persona's replies in the threads the owner starts
// with it carry a job's milestones instead. Asks stay ON, so a channel that
// turns the mirror on also gets its in-thread ask cards. Persisted as one
// collector setting (`slackChannelFeatures`) holding a JSON blob keyed by channel
// id, so no schema migration is needed.
//
// This module is pure (parse + resolve + command grammar + mutation), so the
// grammar and the fail-open semantics are unit-tested in isolation; the live
// holder (ChannelFeatureStore) is a thin cache the adapter refreshes each poll.

import {
  parseChannelFeatureMap,
  type WsMessage,
  type FeedKinds,
  type ChannelFeatures,
  type ChannelFeatureMap,
  type ChannelFeaturesPatch,
} from "@standup/shared";

// The toggle model (FeedKinds / ChannelFeatures / ChannelFeatureMap) and the
// per-channel persist delta (ChannelFeaturesPatch) live in @standup/shared so the
// collector applies a delta the same way this adapter builds it. Re-exported here
// so existing importers keep resolving them from this module.
export type { FeedKinds, ChannelFeatures, ChannelFeatureMap, ChannelFeaturesPatch };

/** The coarse features a channel can toggle. */
export type CoarseFeature = "feed" | "mirror" | "asks";
export const COARSE_FEATURES: readonly CoarseFeature[] = ["feed", "mirror", "asks"];

/**
 * The QUIET default for each coarse feature when a channel has no explicit
 * override: no session mirror threads and no one-line feed (mirror/feed OFF)
 * until a human opts in with `mirror on` / `feed on`; asks surface in a mirror
 * thread whenever there is one (asks ON). Fail-open (malformed/absent JSON)
 * resolves to THIS default, not all-on.
 */
export const COARSE_DEFAULT: Record<CoarseFeature, boolean> = {
  feed: false,
  mirror: false,
  asks: true,
};

/** The feed event-kinds a channel can toggle. */
export type FeedKind = keyof FeedKinds;
export const FEED_KINDS: readonly FeedKind[] = [
  "launched",
  "finished",
  "checkpoint",
  "stall",
  "knowledge",
  "ask",
  "digest",
];

/**
 * Parse the stored JSON blob into a map. A missing, empty, or MALFORMED value
 * fails OPEN to an empty map — every channel then takes the quiet default (mirror
 * and feed off) — so a bad setting can never crash the adapter or accidentally
 * turn a channel loud.
 */
export function parseChannelFeatures(json: string | null | undefined): ChannelFeatureMap {
  return parseChannelFeatureMap(json);
}

/** Whether a coarse feature is on for a channel — absent settings ⇒ the quiet default. */
export function isFeatureEnabled(
  map: ChannelFeatureMap,
  channelId: string | undefined,
  feature: CoarseFeature,
): boolean {
  if (!channelId) return COARSE_DEFAULT[feature];
  const v = map[channelId]?.[feature];
  return v === undefined ? COARSE_DEFAULT[feature] : v;
}

/**
 * Whether a feed event-kind is on for a channel. A per-kind override always wins.
 * An UNSET kind follows the channel's feed master: feed off (the default) ⇒ off,
 * so a fresh channel is quiet; feed explicitly on ⇒ on, so `feed on` alone
 * delivers every kind — UNLESS the channel allowlisted specific kinds (any kind
 * set true), in which case only those show and the rest stay off. Every kind but
 * `digest` is consulted only once the coarse feed gate has passed (see feed.ts
 * Feed.handle); the digest answers to this toggle alone.
 */
export function isFeedKindEnabled(
  map: ChannelFeatureMap,
  channelId: string | undefined,
  kind: FeedKind,
): boolean {
  if (!channelId) return false;
  const c = map[channelId];
  const fk = c?.feedKinds;
  const v = fk?.[kind];
  // The daily digest is opt-in like every other line: `feed digest on` alone
  // delivers it (the explicit override below; feed.ts lets it past the feed
  // master), and `feed on` includes it.
  if (v !== undefined) return v;
  if (c?.feed !== true) return false; // feed not explicitly on ⇒ kinds stay quiet
  // `digest` can be turned on by itself, so it must not count toward the
  // allowlist — otherwise `feed digest on` would silently flip the loud kinds into
  // allowlist mode and mute every event type that wasn't explicitly enabled.
  const anyOn = fk ? FEED_KINDS.some((k) => k !== "digest" && fk[k] === true) : false;
  return !anyOn;
}

/**
 * The feed-kind toggle that governs a WS message's feed line, or undefined when
 * the line has no per-kind switch (e.g. a launch STOP is always shown). session:
 * status maps to `finished` — its only feed line is the "finished"/"stalled"
 * terminal state — and the mid-run stall detector maps to `stall`.
 */
export function feedKindForType(type: WsMessage["type"]): FeedKind | undefined {
  switch (type) {
    case "launch:started":
      return "launched";
    case "session:status":
      return "finished";
    case "checkpoint:new":
      return "checkpoint";
    case "stall:detected":
      return "stall";
    case "knowledge:change":
      return "knowledge";
    case "ask:new":
      return "ask";
    case "digest:posted":
      return "digest";
    default:
      return undefined;
  }
}

/** Set a coarse feature flag for a channel, returning a NEW map (pure). */
export function setFeature(
  map: ChannelFeatureMap,
  channelId: string,
  feature: CoarseFeature,
  on: boolean,
): ChannelFeatureMap {
  const next: ChannelFeatureMap = { ...map };
  next[channelId] = { ...(next[channelId] ?? {}), [feature]: on };
  return next;
}

/**
 * Drop a channel's overrides entirely, returning a NEW map (pure). The channel
 * then resolves to the QUIET default (asks on; mirror, feed + every kind off) —
 * this is how channel setup (`feed here`) and teardown (`standup off`) return a
 * channel to a clean slate so a prior `feed on` / `mirror off` can't survive and
 * silently contradict the setup command's promise.
 */
export function clearChannel(map: ChannelFeatureMap, channelId: string): ChannelFeatureMap {
  if (!(channelId in map)) return map;
  const next: ChannelFeatureMap = { ...map };
  delete next[channelId];
  return next;
}

/** Set a single feed-kind flag for a channel, returning a NEW map (pure). */
export function setFeedKind(
  map: ChannelFeatureMap,
  channelId: string,
  kind: FeedKind,
  on: boolean,
): ChannelFeatureMap {
  const next: ChannelFeatureMap = { ...map };
  const cur = { ...(next[channelId] ?? {}) };
  cur.feedKinds = { ...(cur.feedKinds ?? {}), [kind]: on };
  next[channelId] = cur;
  return next;
}

// ─── Persist deltas ──────────────────────────────────────────────────────────
// A command persists ONLY the channel it touched, as a delta the collector merges
// onto the current stored blob — never the adapter's whole local snapshot. This is
// what lets a concurrent external per-channel edit, or an overlapping command on
// another channel, survive: no writer ever replaces the whole value.

/** The persist delta for a coarse-feature toggle: field-merge one flag on one channel. */
export function featurePatch(channelId: string, feature: CoarseFeature, on: boolean): ChannelFeaturesPatch {
  return { set: { [channelId]: { [feature]: on } } };
}

/** The persist delta for a feed-kind toggle: merge one kind on one channel. */
export function feedKindPatch(channelId: string, kind: FeedKind, on: boolean): ChannelFeaturesPatch {
  return { set: { [channelId]: { feedKinds: { [kind]: on } } } };
}

/** The persist delta for a channel teardown: drop the channel's entry entirely. */
export function clearChannelPatch(channelId: string): ChannelFeaturesPatch {
  return { clear: [channelId] };
}

/** A one-line human summary of a channel's EFFECTIVE toggles (for `feed status`). */
export function describeChannel(map: ChannelFeatureMap, channelId: string): string {
  const yn = (b: boolean) => (b ? "on" : "off");
  const coarse = COARSE_FEATURES.map((f) => `${f}: ${yn(isFeatureEnabled(map, channelId, f))}`).join("  ·  ");
  const kinds = FEED_KINDS.map((k) => `${k} ${yn(isFeedKindEnabled(map, channelId, k))}`).join(", ");
  return `${coarse}\nfeed kinds: ${kinds}`;
}

// ─── Command grammar ────────────────────────────────────────────────────────

/**
 * A parsed `@bot …` channel command:
 *  - `feed-here` — make THIS channel the standup channel (quiet: sessions
 *    mirror here only after `mirror on`, feed lines only after `feed on`).
 *  - `standup-off` — fully remove Standup from this channel (clear feed + mirror).
 *  - `status` — report the channel's effective toggles.
 *  - `feature` — toggle a coarse feature (feed / mirror / asks) for this channel.
 *  - `feed-kind` — toggle one feed event-kind for this channel.
 */
export type ChannelCommand =
  | { kind: "feed-here" }
  | { kind: "standup-off" }
  | { kind: "status" }
  | { kind: "feature"; feature: CoarseFeature; on: boolean }
  | { kind: "feed-kind"; feedKind: FeedKind; on: boolean };

/**
 * Whether a parsed command only READS this channel's config (`feed status`)
 * rather than MUTATING it (`feed here`, `standup off`, or any feature / feed-kind
 * toggle). The caller gates the mutating commands behind the same authority as
 * steer/launch and leaves the read-only ones open.
 */
export function isReadOnlyChannelCommand(cmd: ChannelCommand): boolean {
  return cmd.kind === "status";
}

const LEADING_MENTION = /^<@[^>|]+(?:\|[^>]*)?>\s*/;

/**
 * Parse a bot-directed channel command, leniently. A leading `<@bot>` mention is
 * tolerated. Returns null for anything unrecognized so the caller can show help.
 * `feed here` sets the standup channel and `feed on`/`feed off` toggle this
 * channel's feed LINES (the channel stays set); `standup off` / `off` unset the
 * channel entirely. Precedence: the channel-level `standup off`/`off` verb first,
 * then the `feed …` verbs, then the coarse `<feature> on|off` for mirror / asks.
 */
export function parseChannelCommand(raw: string | undefined | null): ChannelCommand | null {
  if (!raw) return null;
  const text = raw.trim().replace(LEADING_MENTION, "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!text) return null;
  const tokens = text.split(" ");

  // Fully remove Standup from this channel: `standup off`, or a bare `off` that is
  // the WHOLE message — this is the destructive teardown the clear-the-channel verb
  // `feed off` used to carry (now `feed off` only mutes lines). A bare `off` must
  // stand alone: a multi-word mention that merely begins with "off" (e.g. "off you
  // go") falls through to help rather than silently tearing the channel down.
  if ((tokens.length === 1 && tokens[0] === "off") || (tokens[0] === "standup" && tokens[1] === "off")) {
    return { kind: "standup-off" };
  }

  if (tokens[0] === "feed") {
    const arg = tokens[1];
    if (arg === "status") return { kind: "status" };
    if (arg === "here") return { kind: "feed-here" };
    // `feed on|off|stop` toggles only this channel's feed LINES; the channel and
    // its mirror stay set (use `standup off` to unset the channel entirely).
    if (arg === "on") return { kind: "feature", feature: "feed", on: true };
    if (arg === "off" || arg === "stop") return { kind: "feature", feature: "feed", on: false };
    // `feed <kind> on|off` — a per-event-type toggle.
    const kind = FEED_KINDS.find((k) => k === arg);
    const state = onOff(tokens[2]);
    if (kind && state !== undefined) return { kind: "feed-kind", feedKind: kind, on: state };
    return null;
  }

  // `<feature> on|off` for mirror / asks (feed's on|off is handled above).
  const feature = COARSE_FEATURES.find((f) => f === tokens[0]);
  const state = onOff(tokens[1]);
  if (feature && state !== undefined) return { kind: "feature", feature, on: state };
  return null;
}

function onOff(token: string | undefined): boolean | undefined {
  if (token === "on") return true;
  if (token === "off") return false;
  return undefined;
}

// ─── Live holder ─────────────────────────────────────────────────────────────

/**
 * The settings version a locally-mutated channel must see a poll reach before it
 * adopts the fetched blob. UNSTAMPED marks an in-flight mutation whose persisted
 * version isn't known yet (the command's PUT hasn't returned), so reconcile
 * protects it unconditionally until recordPersistedVersion() stamps a real
 * version (see the class comment).
 */
type PendingVersion = number | null;
const UNSTAMPED = null;

/**
 * The adapter's live view of the per-channel toggles. Feed / Mirror / Asks share
 * ONE instance (injected at wiring), so a settings refresh — load() / reconcile()
 * — updates all three at once. A channel with no override resolves to the quiet
 * default (COARSE_DEFAULT; every feed kind off).
 */
export class ChannelFeatureStore {
  private map: ChannelFeatureMap = {};
  // Per-channel version guard for poll-safety. A background poll can read the
  // collector (getSettings) BEFORE a just-issued command's PUT commits, so its
  // blob predates the mutation; adopting it wholesale would transiently revert the
  // command (e.g. re-enable a just-muted channel). Each local mutation records the
  // collector settings version its PUT was assigned (recordPersistedVersion); a
  // polled blob whose version has reached that is KNOWN to already include the
  // mutation — or a strictly newer external edit that supersedes it — so it is
  // adopted and the channel's pending record dropped. A blob with a lower version
  // is stale for that channel, so the local value is kept. Tracking is PER-CHANNEL,
  // so an external edit to any OTHER channel is adopted immediately, and — because
  // adoption keys on the fetched version, not a value match — even a same-channel
  // external edit that flips the very leaf the command touched is adopted once its
  // (newer) version arrives, so nothing can get permanently stuck. An authoritative
  // load() (reconnect/open) clears every pending record.
  private pending = new Map<string, PendingVersion>();

  // The highest settings version this store has adopted (via load or reconcile).
  // A monotonic floor for reconcile: a poll whose blob is strictly older is a stale,
  // out-of-order read (issued before a newer edit, resolving after it) and is dropped
  // rather than allowed to transiently revert the newer edit — even for a channel
  // with no pending mutation, which the per-channel `pending` guard alone doesn't
  // cover. Starts at -1 so any first poll is adopted.
  private lastAppliedVersion = -1;

  /** Replace the map from the stored JSON blob (fail-open on malformed) — authoritative. */
  load(json: string | null | undefined, version?: number | null): void {
    this.map = parseChannelFeatures(json);
    this.pending.clear();
    // Establish the version floor from the authoritative blob so a stale poll that
    // predates this load (issued during an outage, resolving after) is dropped.
    this.lastAppliedVersion = typeof version === "number" && Number.isFinite(version) ? version : -1;
  }

  /**
   * Reconcile a POLLED blob (with its settings `version`) against the local map
   * without clobbering a local mutation that hasn't round-tripped yet. A channel
   * with no pending mutation adopts the fetched value directly, so an external edit
   * — via the web UI or a direct PUT — is picked up within the poll interval. A
   * pending channel adopts the fetched value (and drops its protection) once the
   * fetched version has reached the version its persist was assigned; until then
   * its local value is kept, so a stale poll can't transiently revert the command.
   * Per-channel, so an external edit to one channel is never frozen by a pending
   * mutation on another. A poll strictly older than the newest blob already applied
   * is a stale out-of-order read and is dropped outright (the version floor) so it
   * can't revert a newer edit to a channel that carries no pending mutation.
   */
  reconcile(json: string | null | undefined, version: number | null | undefined): void {
    const fetched = parseChannelFeatures(json);
    const next: ChannelFeatureMap = { ...fetched };
    const v = typeof version === "number" && Number.isFinite(version) ? version : -1;
    // Version floor: drop a poll whose blob predates the newest version applied.
    // Equal/newer versions are still adopted, so any genuine edit is always taken.
    if (v < this.lastAppliedVersion) return;
    for (const [id, pendingVersion] of [...this.pending]) {
      if (pendingVersion !== UNSTAMPED && v >= pendingVersion) {
        this.pending.delete(id); // round-tripped or superseded — adopt the fetched value
        continue;
      }
      const local = this.map[id];
      if (local === undefined) delete next[id]; // a pending local clear stays absent
      else next[id] = local; // stale / in-flight — keep the protected local value
    }
    this.map = next;
    this.lastAppliedVersion = Math.max(this.lastAppliedVersion, v);
  }

  /**
   * Replace the map directly (after applying a pure mutation in the command
   * handler) and mark every channel the mutation changed as pending with no version
   * yet (UNSTAMPED). reconcile() then protects those channels unconditionally until
   * recordPersistedVersion() stamps them with the version the collector assigned
   * the persist, so an in-flight command can never be reverted by a racing poll.
   */
  set(map: ChannelFeatureMap): void {
    const prev = this.map;
    for (const id of new Set<string>([...Object.keys(prev), ...Object.keys(map)])) {
      if (JSON.stringify(prev[id]) !== JSON.stringify(map[id])) this.pending.set(id, UNSTAMPED);
    }
    this.map = map;
  }

  /**
   * Stamp the channels THIS command persisted with the collector settings version
   * its persist was assigned, so reconcile can drop each channel's protection the
   * moment a poll reaches that version. Only the given channels are stamped — never
   * every pending channel — because a command now persists just its own channel's
   * delta: an overlapping command mutating a DIFFERENT channel keeps its own
   * (unstamped) protection until ITS persist returns, so a poll landing at this
   * command's version can't adopt a collector state that predates the other
   * command and revert its toggle. Raise (never lower) each so an out-of-order
   * response can't reopen a protection. A failed PUT (no version) means this
   * command's mutations never persisted, so drop just those in-flight channels and
   * let the collector's value win on the next poll.
   */
  recordPersistedVersion(version: number | null | undefined, channelIds: Iterable<string>): void {
    const ids = new Set(channelIds);
    if (typeof version === "number" && Number.isFinite(version)) {
      for (const id of ids) {
        if (!this.pending.has(id)) continue;
        const cur = this.pending.get(id) as PendingVersion;
        if (cur === UNSTAMPED || version > cur) this.pending.set(id, version);
      }
    } else {
      for (const id of ids) {
        if (this.pending.get(id) === UNSTAMPED) this.pending.delete(id);
      }
    }
  }

  /** The current map (used to derive the next map for a command mutation). */
  snapshot(): ChannelFeatureMap {
    return this.map;
  }

  /** The current map serialized for persistence. */
  toJson(): string {
    return JSON.stringify(this.map);
  }

  feedEnabled(channelId: string | undefined): boolean {
    return isFeatureEnabled(this.map, channelId, "feed");
  }
  feedKindEnabled(channelId: string | undefined, kind: FeedKind): boolean {
    return isFeedKindEnabled(this.map, channelId, kind);
  }
  mirrorEnabled(channelId: string | undefined): boolean {
    return isFeatureEnabled(this.map, channelId, "mirror");
  }
  asksEnabled(channelId: string | undefined): boolean {
    return isFeatureEnabled(this.map, channelId, "asks");
  }
}

/**
 * Poll-safe holder for the single feed-channel setting (`slackFeedChannel`),
 * applying the same version guard the ChannelFeatureStore applies to the
 * per-channel blob. A background poll can read the collector before a just-issued
 * `feed here` / `standup off` PUT commits; adopting that stale value would
 * transiently revert the command. setLocal records the version the collector
 * assigned the persist; reconcile adopts a polled value only once its version has
 * reached that (or when no local mutation is pending), so a stale poll keeps the
 * local value while any newer external edit is always eventually adopted. load()
 * (reconnect/open) is authoritative and clears the pending version.
 */
export class FeedChannelSync {
  private value = "";
  private pending: number | undefined;
  // Highest settings version adopted, the monotonic floor for reconcile: a poll
  // strictly older is a stale out-of-order read and is dropped so it can't revert a
  // newer edit. Starts at -1 so any first poll is adopted.
  private lastAppliedVersion = -1;

  /** Adopt the persisted channel authoritatively (reconnect/open); returns it ("" off). */
  load(value: string | null | undefined, version?: number | null): string {
    this.value = (value ?? "").trim();
    this.pending = undefined;
    // Establish the version floor from the authoritative value so a stale poll that
    // predates this load (issued during an outage, resolving after) is dropped.
    this.lastAppliedVersion = typeof version === "number" && Number.isFinite(version) ? version : -1;
    return this.value;
  }

  /**
   * Record a local feed-channel change ("" clears it), protected until a poll
   * reaches the version the collector assigned its persist. A failed PUT (no
   * version) leaves no protection, so the collector's value wins on the next poll.
   */
  setLocal(value: string | null | undefined, version: number | null | undefined): void {
    this.value = (value ?? "").trim();
    this.pending = typeof version === "number" && Number.isFinite(version) ? version : undefined;
  }

  /**
   * Reconcile a polled feed channel (with its settings `version`): adopt it — and
   * clear the pending protection — when no local mutation is pending or the fetched
   * version has reached the pending one; otherwise keep the local value so a stale
   * poll can't revert a just-issued command. A poll strictly older than the newest
   * value already applied is a stale out-of-order read and is dropped (the version
   * floor). Returns the effective channel ("" off).
   */
  reconcile(value: string | null | undefined, version: number | null | undefined): string {
    const v = typeof version === "number" && Number.isFinite(version) ? version : -1;
    // Version floor: drop a poll whose value predates the newest version applied.
    if (v < this.lastAppliedVersion) return this.value;
    if (this.pending === undefined || v >= this.pending) {
      this.value = (value ?? "").trim();
      this.pending = undefined;
    }
    this.lastAppliedVersion = Math.max(this.lastAppliedVersion, v);
    return this.value;
  }

  /** The current effective feed channel ("" when off). */
  current(): string {
    return this.value;
  }
}
