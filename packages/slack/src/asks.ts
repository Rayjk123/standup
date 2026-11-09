// The ask loop: an agent's ask → the human answers → POST /api/asks/:id/resolve
// unblocks it. Delivery has two modes:
//   • Mirror on (`mirror on` in the feed channel): post the ask INTO the session's mirror
//     thread, @mentioning the recipient — answer in-thread (or via buttons).
//   • Mirror off: DM the learned recipient — answer in the DM (or via buttons).
//
// Bindings are in-memory; resync() re-fetches /api/asks/pending on startup and
// every reconnect and re-delivers anything still pending — the collector is the
// source of truth.

import type { WebClient } from "@slack/web-api";
import type { Ask } from "@standup/shared";
import type { CollectorClient } from "./collector-client.js";
import { askMessage, answeredBlocks, closedBlocks, answeredElsewhereNote, type AskActionValue } from "./format.js";
import { AskBindingStore, type AskBinding } from "./ask-bindings.js";
import type { ChannelFeatureStore } from "./channel-features.js";
import { ownerSlackId } from "./env.js";

/**
 * A stable actor id for a Slack user, namespaced so it never collides with a
 * user alias in the collector's actor table. The collector records this as
 * the participant who answered an ask from Slack.
 */
export function slackActor(userId: string): string {
  return `slack:${userId}`;
}

/** `Ask.gate` values of a safety-floor hold (the collector's floor/gate.ts FLOOR_GATE / FLOOR_OWNER_GATE). */
export const FLOOR_GATES: ReadonlySet<string> = new Set(["safety_floor", "safety_floor_owner"]);
/** The floor's allow option (floor/gate.ts FLOOR_ALLOW_OPTION). */
export const FLOOR_ALLOW_OPTION = "Allow once";
/** The floor's deny option (floor/gate.ts FLOOR_DENY_OPTION). */
export const FLOOR_DENY_OPTION = "Deny";
/** `Ask.gate` of the collector's idle notice (persona/policy.ts IDLE_NOTICE_GATE). */
const IDLE_NOTICE_GATE = "idle_notice";
/** `Ask.gate` of a Standup self-fix confirmation (server.ts STANDUP_IMPROVEMENT_GATE). */
const STANDUP_IMPROVEMENT_GATE = "standup_improvement";

/** Whether `ask` is a safety-floor hold. */
/**
 * Asks whose answer the collector accepts only from the owner, besides
 * safety-floor holds: a tool-permission dialog (not the idle notice) and a
 * Standup self-fix confirmation.
 */
export function ownerAnswers(ask: Pick<Ask, "kind" | "gate">): boolean {
  if (ask.kind === "permission_prompt") return ask.gate !== IDLE_NOTICE_GATE;
  return ask.gate === STANDUP_IMPROVEMENT_GATE;
}

export function isFloorAsk(ask: Pick<Ask, "gate"> | undefined): boolean {
  return !!ask?.gate && FLOOR_GATES.has(ask.gate);
}

/**
 * The floor option `answer` names exactly (trimmed), or undefined. A floor
 * hold is answered from Slack only with one of its own option labels — no
 * free text that might read either way.
 */
export function exactFloorOption(ask: Pick<Ask, "options">, answer: string): string | undefined {
  const options = ask.options && ask.options.length > 0 ? ask.options : [FLOOR_ALLOW_OPTION, FLOOR_DENY_OPTION];
  const text = answer.trim();
  return options.find((o) => o === text);
}

/** Minimal view of the Mirror that Asks needs — lets it deliver into session threads. */
export interface ThreadProvider {
  isEnabled(): boolean;
  ensureThread(sessionId: string): Promise<{ channel: string; rootTs: string } | null>;
  sessionForRoot(rootTs: string): string | undefined;
}

/**
 * Where a session's attention should be delivered — resolved from its RESPONSIBLE
 * human (owner → creator → earliest participant) so an ask pings the ONE person
 * on the hook instead of the channel at large. One of:
 *  - `{ slackId }` — the responsible human maps to this Slack user; DM THEM (and
 *    additionally mirror the ask into the session thread when the mirror is on).
 *  - `{ ownerless: true }` — the session is definitively unattributed; SUPPRESS
 *    the delivery rather than blast the channel (mirrors OpenClaw's owner-less
 *    event suppression).
 *  - `{}` — the responsible human is unknown, unmapped to a Slack id, or the
 *    lookup was inconclusive (e.g. the collector was unreachable); fall back to
 *    today's learned-recipient delivery so a transient miss never drops an ask.
 */
export interface OwnerRoute {
  slackId?: string;
  ownerless?: boolean;
}

/**
 * Injected owner resolver. Composing the collector lookup (session → responsible
 * human) with the alias → Slack-id map lives at the wiring site; Asks only asks
 * "where does this session's attention go?". Absent entirely when no owner
 * routing is configured, in which case delivery is the pre-owner-routing
 * behavior (DM / @-mention the learned recipient).
 */
export interface OwnerRouting {
  routeFor(sessionId: string): Promise<OwnerRoute>;
}

/**
 * Map a session's resolved responsible human (the collector's owner → creator →
 * earliest-participant tri-state) to an OwnerRoute. This is the wiring's routing
 * decision, factored out pure so it is unit-testable without a live collector or
 * Slack. The tri-state maps as:
 *  - a Slack-mappable alias → `{ slackId }` (route the ask to THAT human);
 *  - `null` (the session is genuinely unattributed) → `{ ownerless: true }`;
 *  - `undefined` (the lookup FAILED) or an alias we can't map → `{}` (fall back to
 *    today's learned-recipient delivery). A failed lookup must never suppress — a
 *    collector blip is a transient miss, not an owner-less session.
 */
export function routeForResponsible(
  responsible: string | null | undefined,
  ownerMap: Map<string, string>,
): OwnerRoute {
  if (responsible === undefined) return {}; // lookup failed — fall back, never suppress on a blip
  if (responsible === null) return { ownerless: true }; // no responsible human at all
  const slackId = ownerSlackId(responsible, ownerMap);
  return slackId ? { slackId } : {}; // mapped → route to them; unmapped → fall back
}

export class Asks {
  private recipientUserId: string | undefined;
  private recipientChannel: string | undefined;
  // Durable askId → posted-message binding, so a restart re-adopts the already-
  // posted prompt instead of re-posting it (see ask-bindings.ts).
  private readonly byAsk = new AskBindingStore();
  private readonly pendingByDm = new Map<string, Set<string>>(); // DM channel → open askIds
  private readonly pendingBySession = new Map<string, Set<string>>(); // sessionId → open askIds (thread mode)
  // DM channels opened to deliver an owner-routed ask to a mapped owner. A reply
  // in one of these is a routed owner answering their ask, NOT the learned
  // recipient introducing themselves — so noteDmSender must never learn from it.
  private readonly ownerRoutedDmChannels = new Set<string>();
  private readonly handled = new Set<string>();
  private readonly inFlight = new Set<string>();
  private readonly resolving = new Set<string>();
  // Asks whose ask:resolved arrived BEFORE we finished posting them — so onAskNew
  // can retire the card it's about to create instead of leaving a live zombie.
  private readonly resolvedEarly = new Set<string>();
  private resyncing: Promise<void> | null = null;
  // Who may become the learned ask recipient by DMing the bot. Unset, anyone may.
  private recipientGate: ((userId: string) => boolean) | undefined;
  // Whether a Slack user is the owner, the only one who may allow a
  // safety-floor hold. Unset, nobody may allow one from Slack.
  private floorOwner: ((userId: string | undefined) => boolean) | undefined;
  // The Slack user an alias's approval cards reach, if any. Unset, no card
  // reaches Slack, so a carded ask is delivered here like any other.
  private cardRecipient: ((alias: string) => string | undefined) | undefined;
  // Floor holds seen as they arrived, so an answer knows its gate and options
  // without a round trip; an unknown ask is looked up in the pending list.
  private readonly floorAsks = new Map<string, Ask>();

  constructor(
    private readonly web: WebClient,
    private readonly collector: CollectorClient,
    initialAskUser: string | undefined,
    private readonly threads?: ThreadProvider,
    private readonly ownerRouting?: OwnerRouting,
    /**
     * Whether a Slack user may ANSWER an ask (resolve it) — the SAME authority
     * gate steer/launch use: the operator-configured owner (SLACK_ASK_USER) or
     * the allowlist, NEVER the DM-learned recipient. Answering unblocks/redirects
     * the operator's live agent, so it is privileged; the learned recipient is
     * only a DELIVERY target and confers no authority. Composed from Steer.allowed
     * at the wiring site. Absent leaves answering ungated (the pre-gate behavior,
     * used only by tests that don't exercise authorization).
     */
    private readonly authorized?: (userId: string | undefined) => boolean,
    /**
     * Per-channel toggles (shared with Feed/Mirror). Gates only the IN-CHANNEL
     * (mirror-thread) delivery leg for a channel whose `asks` feature is off; the
     * owner/recipient DM leg is not channel-scoped and is never suppressed, so a
     * blocking ask always still reaches a human. Absent ⇒ in-thread delivery on.
     */
    private readonly features?: ChannelFeatureStore,
  ) {
    this.recipientUserId = initialAskUser;
    this.rehydrate();
  }

  /** Whether ask cards may be posted into this channel (absent settings ⇒ yes). */
  private channelAsksEnabled(channel: string): boolean {
    return !this.features || this.features.asksEnabled(channel);
  }

  /** Shown when a non-owner tries to answer an ask from Slack. */
  static readonly ANSWER_DENIED_NOTICE = "🔒 Only the session owner can answer this from Slack.";
  /** Shown when someone other than the owner tries to allow a safety-floor hold. */
  static readonly FLOOR_ALLOW_DENIED_NOTICE = "🔒 Only the owner can allow a safety-floor hold. You can still answer it *Deny*.";
  /** Shown when a safety-floor hold is answered with anything but one of its options. */
  static readonly FLOOR_EXACT_NOTICE = `This is a safety-floor hold: answer exactly *${FLOOR_ALLOW_OPTION}* or *${FLOOR_DENY_OPTION}* (or tap a button).`;
  /** Most resolved-before-posted ask ids remembered. */
  private static readonly MAX_RESOLVED_EARLY = 500;

  /**
   * Re-arm the in-memory dedup + reply-routing maps from the persisted bindings
   * after a restart. Without this, `handled` is empty on boot and resync re-posts
   * every still-pending ask; with it, onAskNew's `handled` guard short-circuits an
   * already-delivered ask and a thread/DM reply still resolves to the open ask.
   */
  private rehydrate(): void {
    // Re-arm the owner-routed DM guard from the DURABLE channel set first — it
    // outlives individual bindings, so a routed owner's DM whose ask already
    // resolved (its binding deleted) is still protected from being mislearned as
    // the recipient after a restart.
    for (const channel of this.byAsk.ownerRoutedChannels()) this.ownerRoutedDmChannels.add(channel);
    for (const [askId, b] of this.byAsk.all()) {
      this.handled.add(askId);
      if (b.rootTs) this.addPending(this.pendingBySession, b.sessionId, askId);
      else this.addPending(this.pendingByDm, b.channel, askId);
      // An owner-routed DM with a thread copy also accepts an in-thread reply.
      if (b.mirror) this.addPending(this.pendingBySession, b.sessionId, askId);
      // Belt-and-suspenders for a state file predating the durable set: a still-
      // live owner-routed binding also re-marks its channel.
      if (b.ownerRouted) this.ownerRoutedDmChannels.add(b.channel);
    }
  }

  get isConfigured(): boolean {
    // Deliverable if we can DM someone OR we can post into a session thread.
    return !!(this.recipientUserId || this.recipientChannel || this.threads?.isEnabled());
  }

  /** The learned owner's user id (for @-mentioning them), or undefined. */
  get ownerUserId(): string | undefined {
    return this.recipientUserId;
  }

  /**
   * Whether this session has an open ask awaiting an answer. A thread reply is
   * routed to the ask path when true (the agent is explicitly waiting) and to
   * steer-from-Slack when false — so a reply never both answers and steers.
   */
  hasPendingForSession(sessionId: string): boolean {
    return (this.pendingBySession.get(sessionId)?.size ?? 0) > 0;
  }

  /**
   * Whether this DM channel has an open ask awaiting an answer. The DM router
   * checks this BEFORE treating a reply as a launch command, so a pending ask
   * claims the reply as its answer — even one that begins with "launch" — instead
   * of the launch surface hijacking it into a new session and stranding the agent.
   */
  hasPendingForDm(channel: string): boolean {
    return (this.pendingByDm.get(channel)?.size ?? 0) > 0;
  }

  /**
   * The open ask whose card in this DM is the root of `threadTs` — i.e. a DM
   * reply posted in the card's own thread. Used while Persona owns the DM: then
   * only such a reply answers an ask, and every top-level DM goes to Persona.
   */
  pendingAskForDmThread(channel: string, threadTs: string | undefined): string | undefined {
    if (!threadTs) return undefined;
    for (const id of this.pendingByDm.get(channel) ?? []) {
      if (this.byAsk.get(id)?.ts === threadTs) return id;
    }
    return undefined;
  }

  /** A reply in an ask card's DM thread answers that ask (same authority gate as any answer). */
  async onDmThreadReply(askId: string, channel: string, text: string, actor?: string, userId?: string): Promise<void> {
    if (!this.canAnswer(userId)) {
      await this.say(channel, Asks.ANSWER_DENIED_NOTICE);
      return;
    }
    await this.resolve(askId, text, actor, userId);
  }

  /**
   * The owner's DM channel, opening it if needed — the same recipient the ask
   * path delivers to, so plan-approval attention routes to the one owner.
   */
  ownerChannel(): Promise<string | undefined> {
    return this.dmChannel();
  }

  /**
   * Restrict which DM senders may become the learned ask recipient. Once the
   * owner's Slack id is known, a DM from anyone else must not re-route where
   * asks are delivered.
   */
  setRecipientGate(gate: (userId: string) => boolean): void {
    this.recipientGate = gate;
  }

  /**
   * Who counts as the owner for allowing a safety-floor hold: only their allow
   * is sent with the owner token. Everyone else the answer gate admits may
   * still deny one.
   */
  setFloorOwner(isOwner: (userId: string | undefined) => boolean): void {
    this.floorOwner = isOwner;
  }

  /**
   * Where an alias's approval cards reach in Slack (PersonaBridge
   * approvalCardRecipient). An ask on a card is left to the card whenever the
   * card reaches its decider in Slack.
   */
  setCardRecipient(recipient: (alias: string) => string | undefined): void {
    this.cardRecipient = recipient;
  }

  /** Record the DM sender as the ask recipient (learn-from-DM), persist, and flush pending. */
  async noteDmSender(userId: string, channel: string): Promise<void> {
    if (this.recipientGate && !this.recipientGate(userId)) return;
    // A mapped owner answering their OWN owner-routed DM is not a learn-from-DM:
    // that channel was opened to deliver an owner-routed ask, not by the recipient
    // introducing themselves. Learning it would overwrite the learned recipient
    // and setAskUser to whoever last answered a routed DM, silently redirecting
    // every owner-less/fallback ask (and the plan-approval + steer owner identity).
    if (this.ownerRoutedDmChannels.has(channel)) return;
    const firstChannel = !this.recipientChannel;
    const changedUser = this.recipientUserId !== userId;
    this.recipientChannel = channel;
    this.recipientUserId = userId;
    if (changedUser) void this.collector.setAskUser(userId);
    if (firstChannel || changedUser) await this.resync();
  }

  async onAskNew(ask: Ask): Promise<void> {
    if (isFloorAsk(ask)) this.floorAsks.set(ask.id, ask);
    // A running Persona relays what needs the owner itself; delivering the card
    // too would reach the human twice. An ask on an approval card is the
    // card's only where the card reaches that human (checked below).
    if (ask.personaHandled && !ask.cardDecider) return;
    if (this.handled.has(ask.id) || this.inFlight.has(ask.id)) return;
    this.inFlight.add(ask.id);
    try {
      // Route to the session's RESPONSIBLE human when owner routing is wired: DM
      // them directly (see deliverToOwner — a DM is the GUARANTEED ping, since a
      // thread @-mention only notifies channel members). A human we can't map to
      // Slack falls through to today's learned-recipient delivery. With no owner
      // routing wired (route === {}), delivery is unchanged.
      const route = this.ownerRouting ? await this.ownerRouting.routeFor(ask.sessionId) : {};
      const ownerId = route.slackId;

      // The card's decider is the one human who can settle the hold: once the
      // card reaches them here, the raw ask would only prompt them twice or
      // prompt someone who can't allow it.
      if (ask.cardDecider && this.cardRecipient?.(ask.cardDecider)) return;

      const title = await this.collector.sessionTitle(ask.sessionId);

      if (ownerId) {
        await this.deliverToOwner(ask, title, ownerId);
        return;
      }

      if (route.ownerless) {
        // Genuinely unattributed: never blast the ask into the mirror thread
        // (OpenClaw's owner-less event suppression — no channel-wide @-mention).
        // But an ask BLOCKS the agent, so it must still reach a human: DM the
        // single learned recipient (a private DM, not a channel post) rather than
        // drop it on every channel and strand the agent. Fully suppressed only
        // when no recipient has been learned yet (nothing to fall back to).
        await this.deliverToRecipientDm(ask, title);
        return;
      }

      // Fall back to today's learned-recipient delivery: prefer the session's
      // mirror thread (@-mention the recipient, a known channel participant) when
      // the mirror is on AND this channel's asks feature isn't turned off, else DM
      // the learned recipient (a channel with asks off still gets its blocking ask
      // via DM — never dropped).
      if (this.threads?.isEnabled()) {
        const thread = await this.threads.ensureThread(ask.sessionId);
        if (thread && this.channelAsksEnabled(thread.channel)) {
          const { text, blocks } = askMessage(ask, title, this.recipientUserId);
          const res = await this.web.chat.postMessage({ channel: thread.channel, thread_ts: thread.rootTs, text, blocks });
          if (typeof res.ts === "string") {
            await this.record(ask, title, { channel: thread.channel, ts: res.ts, rootTs: thread.rootTs });
          }
          return;
        }
        // ensureThread failed → fall through to the DM path.
      }
      await this.deliverToRecipientDm(ask, title);
    } catch (err) {
      console.error(`[asks] deliver failed for ${ask.id}:`, err instanceof Error ? err.message : err);
    } finally {
      this.inFlight.delete(ask.id);
    }
  }

  /**
   * DM the ask to the single learned recipient — the pre-owner-routing delivery
   * and the safety net for an owner-less blocking ask. A no-op (the ask stays
   * pending at the collector, re-tried on the next resync) when no recipient has
   * been learned yet.
   */
  private async deliverToRecipientDm(ask: Ask, title: string): Promise<void> {
    const channel = await this.dmChannel();
    if (!channel) return; // no recipient yet; warned at startup
    const { text, blocks } = askMessage(ask, title);
    const res = await this.web.chat.postMessage({ channel, text, blocks });
    if (typeof res.ts === "string") await this.record(ask, title, { channel, ts: res.ts });
  }

  /**
   * Deliver an owner-routed ask so the owner is ACTUALLY paged. A thread
   * @-mention alone only notifies channel members, so an owner who isn't in the
   * feed channel would silently miss it; the DM is therefore the guaranteed
   * delivery. When the mirror is on the ask is ALSO posted into the session
   * thread (team visibility, @-mentioning the owner) and tracked as a secondary
   * message retired in lockstep. If the DM can't be opened, a posted thread copy
   * becomes the tracked prompt so the ask is never silently dropped.
   */
  private async deliverToOwner(ask: Ask, title: string, ownerId: string): Promise<void> {
    let mirror: AskBinding["mirror"];
    if (this.threads?.isEnabled()) {
      const thread = await this.threads.ensureThread(ask.sessionId);
      // The owner is DM'd below regardless; only the in-channel team-visibility
      // copy is gated by this channel's asks feature.
      if (thread && this.channelAsksEnabled(thread.channel)) {
        const { text, blocks } = askMessage(ask, title, ownerId);
        const res = await this.web.chat.postMessage({ channel: thread.channel, thread_ts: thread.rootTs, text, blocks });
        if (typeof res.ts === "string") mirror = { channel: thread.channel, rootTs: thread.rootTs, ts: res.ts };
      }
    }

    const channel = await this.dmChannelFor(ownerId);
    if (channel) {
      try {
        const { text, blocks } = askMessage(ask, title); // a DM needs no @-mention
        const res = await this.web.chat.postMessage({ channel, text, blocks });
        if (typeof res.ts === "string") {
          await this.record(ask, title, { channel, ts: res.ts }, mirror, true);
          return;
        }
      } catch (err) {
        // The DM post threw AFTER the thread copy (if any) already landed. Fall
        // through to adopt that copy as the tracked prompt instead of letting
        // onAskNew's catch abandon it — an abandoned copy is an orphaned live card
        // the next resync re-posts as a duplicate.
        console.error(`[asks] owner DM post failed for ${ask.id}:`, err instanceof Error ? err.message : err);
      }
    }

    // Couldn't DM the owner (open failed, no ts, or the post threw) — adopt the
    // thread copy (if any) as the tracked prompt so the ask is neither dropped nor
    // re-posted on the next resync.
    if (mirror) await this.record(ask, title, { channel: mirror.channel, ts: mirror.ts, rootTs: mirror.rootTs });
  }

  /**
   * Persist an ask's posted-message binding and arm the in-memory dedup +
   * reply-routing maps. A thread-rooted primary routes replies via the session;
   * a DM primary routes via the DM channel; a `mirror` secondary (owner-routed DM
   * plus a thread copy) additionally routes an in-thread reply to the same ask.
   */
  private async record(
    ask: Ask,
    title: string,
    primary: { channel: string; ts: string; rootTs?: string },
    mirror?: AskBinding["mirror"],
    ownerRouted?: boolean,
  ): Promise<void> {
    this.byAsk.set(ask.id, {
      channel: primary.channel,
      ts: primary.ts,
      question: ask.question,
      sessionTitle: title,
      sessionId: ask.sessionId,
      rootTs: primary.rootTs,
      mirror,
      ownerRouted,
    });
    if (primary.rootTs) this.addPending(this.pendingBySession, ask.sessionId, ask.id);
    else this.addPending(this.pendingByDm, primary.channel, ask.id);
    if (mirror) this.addPending(this.pendingBySession, ask.sessionId, ask.id);
    // Mark the owner's routed DM channel so its reply isn't mislearned as the ask
    // recipient (noteDmSender). Persisted in a durable channel set that outlives
    // this binding, so the guard survives a resolve-then-restart: even after the
    // ask clears and its binding is deleted, a follow-up DM from that owner is
    // still not learned.
    if (ownerRouted) {
      this.ownerRoutedDmChannels.add(primary.channel);
      this.byAsk.markOwnerRouted(primary.channel);
    }
    this.handled.add(ask.id);
    await this.retireIfResolvedEarly(ask.id);
  }

  /** Terminal via another path (web UI, timeout, cancel) — retire the prompt. */
  async onAskResolved(askId: string, answer: string): Promise<void> {
    if (this.resolving.has(askId)) return;
    const b = this.byAsk.get(askId);
    if (!b) {
      // Resolved before/while we're posting it — mark so onAskNew retires the
      // card it's about to create (only track asks we haven't delivered yet).
      if (!this.handled.has(askId)) {
        this.resolvedEarly.add(askId);
        // Most of these are asks this adapter never posts (e.g. Persona relayed
        // them), so keep only the newest.
        if (this.resolvedEarly.size > Asks.MAX_RESOLVED_EARLY) {
          const oldest = this.resolvedEarly.values().next().value;
          if (oldest !== undefined) this.resolvedEarly.delete(oldest);
        }
      }
      return;
    }
    const note = answeredElsewhereNote(answer);
    this.clear(askId);
    await this.updateMessage(b, closedBlocks(b.question, note, b.sessionTitle));
  }

  async onButton(value: AskActionValue, actor?: string, userId?: string): Promise<void> {
    // A button tap resolves the ask, driving the operator's agent — gate it to
    // the owner/allowlist. An ask card lives in a DM or a shared mirror thread,
    // so without this any workspace member who can see the card could answer it.
    if (!this.canAnswer(userId)) return;
    await this.resolve(value.askId, value.answer, actor, userId);
  }

  /** A free-text DM reply (message.im). */
  async onDmText(channel: string, text: string, actor?: string, userId?: string): Promise<void> {
    const ids = [...(this.pendingByDm.get(channel) ?? [])];
    if (ids.length === 0) {
      await this.say(
        channel,
        this.threads?.isEnabled()
          ? "Asks appear in each session's thread in the feed channel now — reply there to answer one."
          : "No pending question right now — I'll DM you when an agent needs a decision.",
      );
      return;
    }
    // Answering unblocks/redirects the operator's live agent, so it demands the
    // same authority as steer/launch. A non-owner learned only as the DM delivery
    // recipient (noteDmSender) can be sent an ask here, but must not resolve it.
    if (!this.canAnswer(userId)) {
      await this.say(channel, Asks.ANSWER_DENIED_NOTICE);
      return;
    }
    if (ids.length === 1) {
      await this.resolve(ids[0]!, text, actor, userId);
      return;
    }
    await this.listOpen(channel, undefined, ids);
  }

  /** A free-text reply inside a session's mirror thread (message.channels). */
  async onThreadReply(rootTs: string, text: string, actor?: string, userId?: string): Promise<void> {
    const sessionId = this.threads?.sessionForRoot(rootTs);
    if (!sessionId) return; // not a mirrored session thread — ignore chatter
    const ids = [...(this.pendingBySession.get(sessionId) ?? [])];
    if (ids.length === 0) return; // no open ask for this session — it's just a comment
    if (ids.length === 1) {
      await this.resolve(ids[0]!, text, actor, userId);
      return;
    }
    // Post the "which one?" picker back INTO the thread the reply came from. For
    // an owner-routed ask the binding's primary `channel` is the owner's DM, so
    // its mirror-thread channel is where the picker belongs; a thread-rooted
    // primary already carries that channel. Using `channel` alone would misfire
    // the picker into the owner's DM (with a feed-channel thread_ts that doesn't
    // exist there), leaving the in-thread replier with nothing to tap.
    const b = this.byAsk.get(ids[0]!);
    await this.listOpen(b?.mirror?.channel ?? b?.channel, rootTs, ids);
  }

  async resync(): Promise<void> {
    if (this.resyncing) return this.resyncing;
    this.resyncing = this.runResync().finally(() => {
      this.resyncing = null;
    });
    return this.resyncing;
  }

  private async runResync(): Promise<void> {
    const pending = await this.collector.getPendingAsks();
    if (pending === null) return; // fetch failed — don't retire anything
    const pendingIds = new Set(pending.map((a) => a.id));
    for (const [askId, b] of this.byAsk.all()) {
      if (!pendingIds.has(askId)) {
        this.clear(askId);
        await this.updateMessage(b, closedBlocks(b.question, "☑️ Resolved while the Slack app was offline.", b.sessionTitle));
      }
    }
    for (const ask of pending) {
      await this.onAskNew(ask); // dedups via handled/inFlight
    }
  }

  // ---- internals ----------------------------------------------------------

  /**
   * Whether `userId` may answer an ask. Delegates to the injected owner/allowlist
   * gate; ungated (true) only when no authorizer is wired (tests that don't
   * exercise authorization). The learned recipient is never consulted here.
   */
  private canAnswer(userId: string | undefined): boolean {
    return this.authorized ? this.authorized(userId) : true;
  }

  /** The ask being answered, for its gate and options: the one seen arriving, else the pending list's. */
  private async lookupAsk(askId: string): Promise<Ask | undefined> {
    const known = this.floorAsks.get(askId);
    if (known) return known;
    const pending = await this.collector.getPendingAsks();
    const ask = pending?.find((a) => a.id === askId);
    if (ask && isFloorAsk(ask)) this.floorAsks.set(ask.id, ask);
    return ask;
  }

  /** Posts `text` where the ask's card lives (its thread), else the owner's DM. */
  private async notice(askId: string, text: string): Promise<void> {
    const b = this.byAsk.get(askId);
    const where = b?.channel ?? (await this.dmChannel());
    if (!where) return;
    await this.web.chat
      .postMessage({ channel: where, ...(b?.rootTs ? { thread_ts: b.rootTs } : {}), text })
      .catch(() => {});
  }

  /**
   * Submits an answer. A safety-floor hold takes only one of its exact option
   * labels, and only the owner (setFloorOwner) may allow it — that allow
   * carries the owner token, which the collector requires. The owner's answers
   * to the other asks only the owner may answer (ownerAnswers) carry it too.
   * When the ask can't be looked up, the answer goes without the token, so the
   * collector refuses an owner-only answer rather than this adapter guessing.
   */
  private async resolve(askId: string, answer: string, actor?: string, userId?: string): Promise<void> {
    const b = this.byAsk.get(askId);
    this.resolving.add(askId);
    try {
      let asOwner = false;
      const ask = await this.lookupAsk(askId);
      if (ask && isFloorAsk(ask)) {
        const option = exactFloorOption(ask, answer);
        if (!option) {
          await this.notice(askId, Asks.FLOOR_EXACT_NOTICE);
          return;
        }
        answer = option;
        if (option === FLOOR_ALLOW_OPTION) {
          if (!this.floorOwner?.(userId)) {
            await this.notice(askId, Asks.FLOOR_ALLOW_DENIED_NOTICE);
            return;
          }
          asOwner = true;
        }
      } else if (ask && ownerAnswers(ask) && this.floorOwner?.(userId)) {
        asOwner = true;
      }
      const res = await this.collector.resolveAsk(askId, answer, actor, asOwner);
      if (res.ok) {
        this.clear(askId);
        if (b) await this.updateMessage(b, answeredBlocks(b.question, answer, b.sessionTitle));
        return;
      }
      await this.notice(
        askId,
        res.status === 404
          ? "That question is no longer active."
          : `Couldn't submit that answer${res.error ? `: ${res.error}` : "."}`,
      );
    } finally {
      this.resolving.delete(askId);
    }
  }

  private async listOpen(channel: string | undefined, threadTs: string | undefined, ids: string[]): Promise<void> {
    if (!channel) return;
    const lines = ids
      .map((id, i) => {
        const b = this.byAsk.get(id);
        return b ? `${i + 1}. _${b.sessionTitle}_ — ${b.question}` : null;
      })
      .filter((l): l is string => l !== null);
    await this.web.chat
      .postMessage({
        channel,
        ...(threadTs ? { thread_ts: threadTs } : {}),
        text: `You have ${ids.length} open questions — a plain reply can't tell which one you mean. Tap a button on the one you want:\n${lines.join("\n")}`,
      })
      .catch(() => {});
  }

  /** If an ask resolved before we finished posting it, retire the just-posted card. */
  private async retireIfResolvedEarly(askId: string): Promise<void> {
    if (!this.resolvedEarly.delete(askId)) return;
    const b = this.byAsk.get(askId);
    this.clear(askId);
    if (b) await this.updateMessage(b, closedBlocks(b.question, "☑️ Resolved before you answered.", b.sessionTitle));
  }

  private addPending(map: Map<string, Set<string>>, key: string, askId: string): void {
    let set = map.get(key);
    if (!set) {
      set = new Set();
      map.set(key, set);
    }
    set.add(askId);
  }

  private clear(askId: string): void {
    this.floorAsks.delete(askId);
    const b = this.byAsk.get(askId);
    this.byAsk.delete(askId);
    if (!b) return;
    for (const [map, key] of [
      [this.pendingByDm, b.channel] as const,
      [this.pendingBySession, b.sessionId] as const,
    ]) {
      const set = map.get(key);
      if (set) {
        set.delete(askId);
        if (set.size === 0) map.delete(key);
      }
    }
  }

  private async dmChannel(): Promise<string | undefined> {
    if (this.recipientChannel) return this.recipientChannel;
    if (!this.recipientUserId) return undefined;
    this.recipientChannel = await this.dmChannelFor(this.recipientUserId);
    return this.recipientChannel;
  }

  /** Opens (or reuses) a DM channel to a user id — the owner-routing DM target. */
  private async dmChannelFor(userId: string): Promise<string | undefined> {
    try {
      const res = await this.web.conversations.open({ users: userId });
      const id = res.channel?.id;
      return typeof id === "string" ? id : undefined;
    } catch (err) {
      console.error(`[asks] conversations.open failed for ${userId}:`, err instanceof Error ? err.message : err);
      return undefined;
    }
  }

  private async updateMessage(b: AskBinding, blocks: ReturnType<typeof answeredBlocks>): Promise<void> {
    try {
      await this.web.chat.update({ channel: b.channel, ts: b.ts, blocks, text: b.question });
    } catch (err) {
      console.error("[asks] chat.update failed:", err instanceof Error ? err.message : err);
    }
    // Retire the mirror-thread copy in lockstep so no live card is left behind.
    if (b.mirror) {
      try {
        await this.web.chat.update({ channel: b.mirror.channel, ts: b.mirror.ts, blocks, text: b.question });
      } catch (err) {
        console.error("[asks] chat.update (mirror) failed:", err instanceof Error ? err.message : err);
      }
    }
  }

  private async say(channel: string, text: string): Promise<void> {
    try {
      await this.web.chat.postMessage({ channel, text });
    } catch (err) {
      console.error("[asks] chat.postMessage failed:", err instanceof Error ? err.message : err);
    }
  }
}
