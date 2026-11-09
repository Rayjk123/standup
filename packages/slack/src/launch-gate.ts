// Pure launch-routing predicates for the bot-directed Slack surfaces (a DM and an
// @-mention). Kept free of Slack/collector I/O (the dispatch below drives them
// only through injected callbacks) so the router's security-relevant forks — WHO
// may launch a repo-modifying agent, and whether a DM reply is a launch command
// or the answer to a pending ask — are unit-tested in isolation.

export interface LaunchGateInputs {
  /** Slack user id of the requester, if the event carried one. */
  userId: string | undefined;
  /** The requester is the operator-configured owner or on the steer allowlist. */
  ownerOrAllowlisted: boolean;
}

/**
 * Whether a bot-directed launch request is authorized to spawn a session.
 * Launching runs a repo-modifying agent on the operator's host, so it demands
 * EXPLICIT authorization: the requester must be the operator-configured owner
 * (SLACK_ASK_USER) or on the allowlist. There is no first-requester bootstrap —
 * being the first (or any) DM sender never grants launch rights, so a workspace
 * member cannot spawn an agent by DMing a fresh install (the DM-learned ask
 * recipient is not consulted for authority). Because the decision reads only the
 * operator-configured owner/allowlist state and never mutates it, concurrent
 * first-DM launches can't race a claim into existence: neither passes.
 */
export function launchIsAllowed(i: LaunchGateInputs): boolean {
  if (!i.userId) return false;
  return i.ownerOrAllowlisted;
}

/**
 * On the DM surface, whether an inbound message should be attempted as a launch
 * command. A pending ask in the DM claims the reply as its ANSWER — even a reply
 * that begins with "launch" — so a launch is attempted only when NO ask is open.
 * This is what stops an ask answer like "launch the deploy in prod mode" from
 * being hijacked into a new session while the agent stays blocked on its ask.
 */
export function dmShouldTryLaunch(i: { hasPendingAsk: boolean; isLaunchCommand: boolean }): boolean {
  return !i.hasPendingAsk && i.isLaunchCommand;
}

/** The impure steps a bot-directed launch drives once its fate is decided. */
export interface BotLaunchDispatch {
  /**
   * Check-and-record the inbound message id; true means it's a redelivery to
   * drop. Same in-process guard the ask/steer fork uses; the collector's
   * idempotency key is the durable second layer.
   */
  seen: (key: string) => boolean;
  /** Whether the requester is the operator-configured owner or on the steer allowlist. */
  allowed: (userId: string | undefined) => boolean;
  /** Post the not-permitted notice back into the thread (best effort). */
  denied: () => Promise<void>;
  /** Spawn the session; resolves true once the launch was handled. */
  launch: () => Promise<boolean>;
}

export interface BotLaunchRequest {
  /** Whether the inbound text parses as a launch command. */
  isLaunchCommand: boolean;
  /** Slack user id of the requester, if the event carried one. */
  userId: string | undefined;
  /** Stable inbound message id — in-process dedup + collector idempotency key. */
  key: string;
}

/**
 * Decide the fate of a bot-directed message on a launch surface (a DM or an
 * @-mention) and dispatch it. Returns whether the message WAS a launch command
 * (handled — launched or denied), so the caller stops; false when it wasn't, so
 * the caller keeps its behavior (answer a pending ask, else steer).
 *
 * The authorization check (launchIsAllowed) reads only the already-persisted
 * owner/allowlist state — it neither trusts the first requester nor claims
 * ownership — so an unauthorized requester is refused with a notice and NO
 * session is spawned, and two concurrent first-DM launches cannot both pass.
 */
export async function handleBotLaunch(req: BotLaunchRequest, d: BotLaunchDispatch): Promise<boolean> {
  if (!req.isLaunchCommand) return false; // not a launch — caller keeps its behavior
  if (d.seen(req.key)) return true; // redelivery — already handled
  if (!launchIsAllowed({ userId: req.userId, ownerOrAllowlisted: d.allowed(req.userId) })) {
    await d.denied();
    return true;
  }
  return d.launch();
}
