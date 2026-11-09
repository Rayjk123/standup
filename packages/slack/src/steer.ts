// Steer-from-Slack: a plain reply in a session's mirror thread that ISN'T
// answering a pending ask is injected into that session's live agent via
// POST /api/sessions/:id/send, attributed to the replying teammate.
//
// The thread → session resolution rides the s3 reverse index
// (Mirror.sessionForRoot, rootTs → sessionId). Precedence lives in index.ts: a
// reply is routed here only when the session has NO pending ask (an open ask is
// the agent explicitly waiting, so a reply answers it instead).
//
// Two guards frame the write:
//   • Owner/allowlist gate — typing into someone's live agent is privileged, so
//     only the operator-configured owner (SLACK_ASK_USER) or an explicit
//     allowlist may steer. Arbitrary channel members — including whoever DMed the
//     bot — are refused; the DM-learned ask recipient carries no steer authority.
//   • Inbound LRU dedup — Slack redelivers an event if the socket ack is missed,
//     which would double-type the same message. The message router owns the
//     authoritative cross-path guard (it dedups before the ask-vs-steer fork);
//     this LRU is a self-contained second layer for a direct caller, and the id
//     is ALSO passed as the /send idempotencyKey so the collector no-ops a
//     redelivery that slips past both.
//
// Context-leak guard: only the RAW text the human typed is sent (bounded to
// STEER_MAX_CHARS) — never any persona/context prepend, which is a launch-time
// concern the steer path never touches.

import type { CollectorClient } from "./collector-client.js";
import type { SlackEnv } from "./env.js";
import { InboundDedup } from "./inbound-dedup.js";

/** Longest steering message we forward — a steer is a nudge, not a document. */
const STEER_MAX_CHARS = 4000;

/** The collector surface Steer needs — narrowed so a test fake needs no HTTP/WS. */
export interface SteerSink {
  sendToSession: CollectorClient["sendToSession"];
}

export interface SteerOptions {
  /**
   * The Slack user id authorized as the session owner, supplied by the wiring and
   * read live. It MUST be an EXPLICIT operator-configured owner (SLACK_ASK_USER) —
   * never the DM-learned ask recipient, or any workspace member could gain
   * steer/launch rights simply by DMing the bot. Undefined when no owner is
   * configured, in which case only the allowlist authorizes.
   */
  ownerUserId: () => string | undefined;
  /** Extra user ids permitted to steer beyond the owner (SLACK_STEER_ALLOWLIST). */
  allowlist?: Iterable<string>;
  /**
   * Cross-check that `sessionId`'s CURRENT binding still owns `rootTs` before we
   * write into it. The router resolved the session from the reverse index, but the
   * binding can rebind (channel change) between that resolution and this async
   * send — re-verifying here makes a stale/aliased route fail safe (refuse) rather
   * than typing into the WRONG session. Omit to skip the check (tests / no store).
   */
  ownsRoot?: (sessionId: string, rootTs: string) => boolean;
  /**
   * Post a short notice back into the thread (denied / send failed). Injected so
   * tests capture it without a live Slack call; omit to stay silent.
   */
  notify?: (channel: string, threadTs: string, text: string) => Promise<void>;
}

export interface SteerReply {
  sessionId: string;
  channel: string;
  /** Thread root ts — where a notice is posted. */
  rootTs: string;
  text: string;
  /** Slack user id of the replier, for the owner/allowlist gate. */
  userId?: string;
  /** Namespaced actor (slack:U…) for collector attribution. */
  actor?: string;
  /** Stable inbound message id (client_msg_id, else channel:ts) — the dedup key. */
  dedupKey: string;
}

export class Steer {
  private readonly allowlist: Set<string>;
  private readonly seen = new InboundDedup();

  constructor(
    private readonly collector: SteerSink,
    private readonly opts: SteerOptions,
  ) {
    this.allowlist = new Set(opts.allowlist ?? []);
  }

  /**
   * Whether `userId` may act on a session from Slack — owner or allowlisted.
   * Public so the message router can apply the SAME gate to every actionable
   * thread reply (both the ask-answer and steer doors) before it forks on
   * session state, rather than only guarding the steer branch.
   */
  allowed(userId: string | undefined): boolean {
    if (!userId) return false;
    if (this.allowlist.has(userId)) return true;
    const owner = this.opts.ownerUserId();
    return !!owner && userId === owner;
  }

  /** The notice shown when a replier isn't permitted to act on the session. */
  static readonly DENIED_NOTICE = "🔒 Only the session owner can act on this session from Slack.";

  /** Post the standard not-permitted notice into a thread (best effort). */
  denyNotice(channel: string, rootTs: string): Promise<void> {
    return this.say(channel, rootTs, Steer.DENIED_NOTICE);
  }

  private async say(channel: string, rootTs: string, text: string): Promise<void> {
    if (!this.opts.notify) return;
    try {
      await this.opts.notify(channel, rootTs, text);
    } catch {
      /* best effort — a failed notice must not throw into the event loop */
    }
  }

  /**
   * Route a thread reply into its session. Dedup FIRST (a redelivered event is
   * dropped whatever its fate), then gate, then send the raw (bounded) text.
   */
  async onThreadReply(r: SteerReply): Promise<void> {
    if (this.seen.seen(r.dedupKey)) return; // redelivery — already processed

    if (!this.allowed(r.userId)) {
      await this.denyNotice(r.channel, r.rootTs);
      return;
    }

    // Fail safe on a stale/aliased reverse route: only steer when the resolved
    // session's CURRENT binding still owns this thread root. A mismatch means the
    // binding moved (or was recycled) after the router resolved it — ignore rather
    // than type into the wrong session.
    if (this.opts.ownsRoot && !this.opts.ownsRoot(r.sessionId, r.rootTs)) return;

    const text = r.text.trim().slice(0, STEER_MAX_CHARS);
    if (!text) return;

    const res = await this.collector.sendToSession(r.sessionId, text, r.actor, r.dedupKey);
    if (res.ok) return; // the steer lands in the thread via the mirror's pending-reply row
    await this.say(
      r.channel,
      r.rootTs,
      res.status === 409
        ? "⚠️ Standup didn't launch this session, so it can't type into it — reply in its own terminal."
        : `⚠️ Couldn't steer that${res.error ? `: ${res.error}` : "."}`,
    );
  }
}

/**
 * The one authority for driving an agent from Slack, shared by all four
 * agent-driving surfaces — steering a live session, launching a new one,
 * answering an ask, and approving/rejecting a plan.
 */
export interface SlackAuthority {
  /** The gate the steer + launch surfaces consult (Steer.allowed). */
  readonly steer: Steer;
  /**
   * Whether a Slack user may answer an ask or approve/reject a plan — the SAME
   * predicate as the steer/launch gate. Handed to Asks and Plans so a member
   * learned only as the DM delivery recipient cannot resolve an ask or decide a
   * plan; only the authorized set can.
   */
  readonly authorized: (userId: string | undefined) => boolean;
  /**
   * Whether the operator configured ANY authority source at all (SLACK_ASK_USER,
   * SLACK_STEER_ALLOWLIST, or SLACK_OWNER_MAP). Governs the fail-open posture of
   * the channel-config gate: with nothing configured the team is running open by
   * choice, so config commands stay open (mayConfigure returns true for everyone).
   */
  readonly authorityConfigured: boolean;
  /**
   * Whether a Slack user may MUTATE a channel's Standup config (`feed here`,
   * `standup off`, `feed on|off|stop`, `feed <kind> on|off`, `mirror on|off`,
   * `asks on|off`). Those commands reconfigure where and how the adapter posts, so
   * when an authority set IS configured only the authorized set may run them —
   * otherwise a coworker could redirect or silence a shared feed. With NO authority
   * configured this fails OPEN (any user, matching today's open behavior). Read-only
   * commands (`feed status`, help) are never routed through this gate.
   */
  readonly mayConfigure: (userId: string | undefined) => boolean;
  /**
   * Whether a Slack user may pull the read-only activity snapshot over the PRIVATE
   * DM surface. When an authority set IS configured, only the authorized set may —
   * the SAME gate as steer/launch/answer. With NO authority configured this fails
   * OPEN so a single-operator install can still see its own view
   * over the safe DM path (the collector's per-caller actor scoping remains the
   * second gate that narrows what that caller may see). The asymmetry is
   * DELIBERATE: the channel / @-mention activity paths do NOT fail open (they stay
   * on `authorized`), because an open channel gate would let any member trigger a
   * caller-scoped cross-project snapshot into a shared channel where bystanders
   * would read it.
   */
  readonly mayViewActivityInDm: (userId: string | undefined) => boolean;
}

/**
 * Compose the single Slack agent-driving authority from OPERATOR CONFIG ONLY.
 * The authorized set is the union of three explicitly-configured sources:
 *   • the configured owner (SLACK_ASK_USER),
 *   • the steer allowlist (SLACK_STEER_ALLOWLIST), and
 *   • every mapped owner in SLACK_OWNER_MAP — a human the operator designated to
 *     RECEIVE their sessions' asks/plans, who must therefore also be able to ACT
 *     on them. Without folding these in, an owner routed a blocking ask (or a
 *     plan) could never answer/approve it, stranding their own agent.
 *
 * The DM-learned ask recipient (asks.ownerUserId) is DELIBERATELY excluded: any
 * workspace member can DM the bot, so trusting the learned recipient would let a
 * member — or a later last-writer-wins hijacker — gain agent-driving rights just
 * by DMing. The learned recipient still governs where asks/plans are DELIVERED;
 * it confers no authority.
 *
 * Keeping this composition in ONE factory (rather than inline in the event loop)
 * is what lets a test drive the REAL wiring: reverting the owner source back to
 * the learned recipient fails a test instead of silently reopening the hole.
 */
export function wireSlackAuthority(
  env: Pick<SlackEnv, "askUser" | "steerAllowlist" | "ownerMap">,
  sink: SteerSink,
  wiring: Pick<SteerOptions, "ownsRoot" | "notify"> = {},
): SlackAuthority {
  const steer = new Steer(sink, {
    ownerUserId: () => env.askUser,
    allowlist: [...env.steerAllowlist, ...env.ownerMap.values()],
    ...wiring,
  });
  const authorized = (userId: string | undefined) => steer.allowed(userId);
  // "Configured" means the operator declared at least one authority source; only
  // then is the channel-config gate enforced (otherwise it fails open so an
  // unconfigured, single-operator install keeps its open behavior).
  const authorityConfigured = !!env.askUser || env.steerAllowlist.length > 0 || env.ownerMap.size > 0;
  return {
    steer,
    authorized,
    authorityConfigured,
    mayConfigure: (userId) => (authorityConfigured ? authorized(userId) : true),
    // The private DM activity view fails open ONLY when no authority is configured
    // (single-operator install seeing its own view over the safe DM path); once any
    // authority source is set it is gated exactly like steer/launch/answer. Channel
    // surfaces never use this — they stay on `authorized` so an open install can't
    // broadcast a caller-scoped snapshot into a shared channel.
    mayViewActivityInDm: (userId) => (authorityConfigured ? authorized(userId) : true),
  };
}
