#!/usr/bin/env bun
/**
 * Standup Slack adapter — bidirectional bridge between the Standup collector and a
 * Slack app over Socket Mode.
 *
 * Outbound (Standup → Slack):
 *   • Mirror — opt-in per channel ("mirror on"): each session streams into its
 *              own channel thread (Assistant API chat.*Stream, with a chat.update
 *              fallback). Off by default; Persona's thread replies carry a job's
 *              milestones instead.
 *   • Feed   — an optional one-line-per-event feed into the standup channel.
 *              Set it from Slack: "@standup-dev feed here" (mirror and feed lines
 *              off), "feed on" to add the feed lines, "standup off" to remove it.
 *              The channel id persists as the collector setting `slackFeedChannel`.
 *   • Asks   — an agent's ask_human is delivered (in-thread, or DM'd to the owner)
 *              with option buttons; a tap or reply resolves it and the agent unblocks.
 *   • Plans  — a gated launch's plan is delivered with Approve/Reject buttons.
 *   • Persona — the host's (and each opted-in user's) always-on orchestrator: DM it, @-mention it
 *              in a thread, approve its held actions (see persona-bridge.ts).
 *
 * Inbound (Slack → Standup): DM, @-mention, and in-thread reply drive launch / steer /
 * answer-an-ask / plan decisions, plus per-channel config toggles — all authority-gated.
 *
 * Run:  bun run --filter @standup/slack start   (or: bun run slack:start from root)
 * Env:  packages/slack/.env  (SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_ASK_USER, …)
 */

import { App, LogLevel } from "@slack/bolt";
import { consoleOriginWarning, loadEnv, maskToken, looksLikeToken } from "./env.js";
import { CollectorClient } from "./collector-client.js";
import { Feed } from "./feed.js";
import { Asks, slackActor, routeForResponsible, type OwnerRoute } from "./asks.js";
import { Plans } from "./plans.js";
import { Mirror } from "./mirror.js";
import { Steer, wireSlackAuthority } from "./steer.js";
import { LaunchFromSlack } from "./launch.js";
import { parseLaunchCommand } from "./launch-command.js";
import { handleBotLaunch } from "./launch-gate.js";
import { InboundDedup } from "./inbound-dedup.js";
import {
  ChannelFeatureStore,
  FeedChannelSync,
  parseChannelCommand,
  isReadOnlyChannelCommand,
  setFeature,
  setFeedKind,
  clearChannel,
  featurePatch,
  feedKindPatch,
  clearChannelPatch,
  describeChannel,
} from "./channel-features.js";
import { ActorReconciler, NO_EMAIL_DOMAIN_NOTE } from "./actors.js";
import { webApi } from "./stream-client.js";
import { guardedWeb } from "./send-guard.js";
import { SessionThreads } from "./session-threads.js";
import {
  parseActivityCommand,
  collectActiveWork,
  handleActivityCommand,
  activityDelivery,
  ACTIVITY_UNRESOLVED_NOTICE,
  ACTIVITY_DENIED_NOTICE,
} from "./activity.js";
import { ASK_ACTION_PREFIX, PLAN_ACTION_PREFIX, activityMessage, type AskActionValue, type PlanActionValue } from "./format.js";
import { PersonaBridge } from "./persona-bridge.js";
import { PersonaThreadStore } from "./persona-store.js";
import { dmAskClaims, dmMessageRoute, isDmFileShare, launchRoute, unreadableFilesNotice, unsentFilesNotice } from "./persona-routing.js";
import { inboundSlackFiles } from "./persona-files.js";
import { PERSONA_APPROVAL_PREFIX, PERSONA_OPTION_PREFIX, PERSONA_SHORTCUT_ID } from "./persona-format.js";
import type { WsMessage, Ask, PlanApproval } from "@standup/shared";

/** Shown when an unauthorized user tries to change a channel's Standup config. */
const CONFIG_DENIED_NOTICE =
  "🔒 Only an authorized user can change Standup's channel settings. Ask the operator to add you to SLACK_STEER_ALLOWLIST (or SLACK_ASK_USER / SLACK_OWNER_MAP).";

async function main(): Promise<void> {
  const env = loadEnv();

  console.log("Standup Slack adapter");
  console.log(`  SLACK_BOT_TOKEN = ${maskToken(env.botToken)}`);
  console.log(`  SLACK_APP_TOKEN = ${maskToken(env.appToken)}`);
  console.log(`  collector       = ${env.collectorUrl}   ws = ${env.wsUrl}`);
  console.log(`  ask recipient   = ${env.askUser ?? "(learned from your first DM; SLACK_ASK_USER override unset)"}`);

  if (!env.botToken || !env.appToken) {
    console.error("\n❌ SLACK_BOT_TOKEN and SLACK_APP_TOKEN are both required. See packages/slack/README.md.");
    process.exit(1);
  }
  if (!looksLikeToken(env.botToken, "xoxb-")) console.warn("⚠️  SLACK_BOT_TOKEN doesn't start with xoxb-.");
  if (!looksLikeToken(env.appToken, "xapp-")) console.warn("⚠️  SLACK_APP_TOKEN doesn't start with xapp-.");
  const originWarning = consoleOriginWarning(env);
  if (originWarning) console.warn(originWarning);

  const app = new App({
    token: env.botToken,
    appToken: env.appToken,
    socketMode: true,
    logLevel: LogLevel.WARN,
  });
  const web = app.client;

  // Identify ourselves so we can drop our own messages (the streaming/edit
  // self-loop the playbook flagged).
  const auth = await web.auth.test();
  const botUserId = auth.user_id as string;
  const teamId = auth.team_id as string | undefined;

  // Every outbound message goes through this guarded client, so no subsystem
  // (feed, asks, plans, mirror) can transmit a blank bubble — see send-guard.
  const tx = guardedWeb(web);

  // Post a short notice, threaded under `threadTs` when one is given (a DM /
  // top-level reply has none, so it posts to the channel). Best-effort — a failed
  // notice must never throw into the event loop.
  const postInThread = async (
    channel: string,
    threadTs: string | undefined,
    text: string,
  ): Promise<void> => {
    await tx.chat
      .postMessage({ channel, ...(threadTs ? { thread_ts: threadTs } : {}), text })
      .catch(() => {});
  };

  const collector = new CollectorClient(env.collectorUrl, env.wsUrl, {
    onMessage: (msg) => routeEvent(msg),
    onReconnect: () => {}, // resync happens in onOpen (fires on first + every reconnect)
    onOpen: () => void refreshAndResync(),
  });

  // Per-channel feature toggles (coarse feed/mirror/asks + per-feed-kind). One
  // shared holder feeds all three subsystems, so a settings refresh updates them
  // together. A channel with no overrides takes the quiet default (COARSE_DEFAULT).
  const channelFeatures = new ChannelFeatureStore();

  const feed = new Feed(tx, collector, channelFeatures);
  const store = new SessionThreads();
  // The mirror talks to Slack only through the apiCall seam (webApi) so it can
  // drive the native streaming methods the typed SDK doesn't expose; botUserId /
  // teamId satisfy chat.startStream's recipient params on a channel thread.
  const mirror = new Mirror(webApi(tx), collector, store, env.webUrl, { botUserId, teamId, features: channelFeatures });
  // The feed routes session-scoped lines into each session's mirror thread.
  feed.setThreadResolver((sessionId) => mirror.liveRootFor(sessionId));

  // Load persisted settings first so we can seed the feed channel (which also
  // drives the mirror) and the ask recipient. SLACK_FEED_CHANNEL is a
  // STARTUP-ONLY seed for a fresh install (reconnects honor the setting as-is,
  // so a cleared channel (`standup off`) sticks — see refreshSettings).
  const initial = await collector.getSettings();
  // Poll-safe holder for the feed channel: like the per-channel blob, a background
  // poll must not revert a just-issued `feed here` / `standup off` with a stale read.
  const feedChannelSync = new FeedChannelSync();
  const initialChannel = feedChannelSync.load(initial?.slackFeedChannel || env.feedChannel, initial?.settingsVersion);
  feed.setChannel(initialChannel);
  mirror.setChannel(initialChannel);
  channelFeatures.load(initial?.slackChannelFeatures, initial?.settingsVersion);

  // Owner-routed attention (opt-in via SLACK_OWNER_MAP): resolve a session's ONE
  // responsible human — owner, else creator, else earliest participant — and route
  // the ask to THEM (DM / @-mention their Slack id) instead of the channel at
  // large. Resolving through creator/participant, not owner_actor alone, is what
  // keeps the common self-launched session (created by a human, never explicitly
  // claimed) routed to that human instead of suppressed. A session with no
  // responsible human at all is suppressed rather than blasted (OpenClaw's
  // owner-less event suppression); a responsible human we can't map, or a lookup
  // that failed, falls through to the learned-recipient delivery. Enabled only
  // when the map is configured; with no map, owner routing stays OFF.
  const ownerRouting = env.ownerMap.size > 0
    ? {
        async routeFor(sessionId: string): Promise<OwnerRoute> {
          return routeForResponsible(await collector.sessionResponsible(sessionId), env.ownerMap);
        },
      }
    : undefined;

  // The one authority for driving an agent from Slack — steering a live session,
  // launching a new one, answering an ask, or approving/rejecting a plan. All four
  // write to (or spawn) a repo-modifying agent on the operator's host, so all four
  // demand EXPLICIT authorization: an operator-configured owner (SLACK_ASK_USER),
  // a SLACK_STEER_ALLOWLIST entry, or a mapped owner in SLACK_OWNER_MAP (a human
  // the operator designated to receive — and therefore act on — their sessions'
  // asks/plans). The DM-learned ask recipient (asks.ownerUserId) is deliberately
  // NOT the authority — any workspace member can DM the bot, so trusting the
  // learned recipient would let a member, or a later last-writer-wins hijacker,
  // gain agent-driving rights just by DMing. The learned recipient still governs
  // where asks/plans are DELIVERED; it carries no authority. The composition lives
  // in wireSlackAuthority so the exact owner source is exercised by a test; steer
  // holds the gate (Steer.allowed) and asks/plans reuse the same predicate.
  const { steer, authorized, mayConfigure, mayViewActivityInDm } = wireSlackAuthority(env, collector, {
    // Router cross-check: refuse a steer whose session's current binding no longer
    // owns the thread root (stale/aliased reverse route) rather than misrouting.
    ownsRoot: (sessionId, rootTs) => store.ownsRoot(sessionId, rootTs),
    notify: postInThread,
  });
  // Ask recipient: the persisted slackAskUser wins; SLACK_ASK_USER is an optional
  // override. Otherwise it's learned from the first DM (noteDmSender). When the
  // mirror is on, asks post into the session thread instead of a DM. Answering an
  // ask is gated to the SAME authority as steer — a member learned only as the
  // delivery recipient cannot resolve it, while a mapped owner routed the ask can.
  const asks = new Asks(tx, collector, initial?.slackAskUser || env.askUser, mirror, ownerRouting, authorized, channelFeatures);
  // Plan-approval gate: a gated launch's submitted plan is routed to the same
  // owner the asks path DMs, with Approve/Reject buttons (composes with wave-2
  // owner-routed attention). Editing before approval stays in the web UI.
  // Approving/rejecting is gated to the same authority as steer.
  const plans = new Plans(tx, collector, asks, env.webUrl, authorized);
  // Persona in Slack: a Slack Persona user's DMs, @-mentions and bound-thread
  // follow-ups go to their own Persona; its replies and approval cards come
  // back here. The host is SLACK_ASK_USER (or their SLACK_OWNER_MAP entry);
  // another user gets their alias's Persona only when SLACK_PERSONA_USERS
  // lists it and SLACK_OWNER_MAP maps it. Off (fail closed) until the host's
  // Slack id resolves.
  const personaStore = new PersonaThreadStore();
  const persona = new PersonaBridge({
    slack: webApi(tx),
    collector,
    store: personaStore,
    botUserId,
    ownerConfig: { askUser: env.askUser, ownerMap: env.ownerMap, personaUsers: env.personaUsers },
    webUrl: env.webUrl,
    consoleOrigin: env.consoleOrigin,
    // Downloads the files a Persona user shares in their DM (sent to Slack only).
    botToken: env.botToken,
    // Asks Persona was relaying are no longer handled once it can't act; the
    // collector re-announces them, and a resync picks up any that frame missed.
    onPersonaUnavailable: () => void asks.resync(),
  });
  // An ask on its owner's approval card is left to the card only where the
  // bridge delivers that card; elsewhere it is delivered as an ask.
  asks.setCardRecipient((alias) => persona.approvalCardRecipient(alias));
  // Once the owner is known, only the owner's DM may become the ask recipient.
  asks.setRecipientGate((userId) => {
    const owner = persona.ownerSlackId ?? env.askUser;
    return !owner || userId === owner;
  });
  // Only the owner may allow a safety-floor hold from Slack (their allow alone
  // carries the owner token); while the owner is unknown, nobody may.
  asks.setFloorOwner((userId) => {
    const owner = persona.ownerSlackId ?? env.askUser;
    return !!userId && !!owner && userId === owner;
  });
  // Launch-from-Slack: a bot-directed "launch <task> in <project>" message spins
  // up a NEW session through the collector instead of steering an existing one.
  // Reachable on every bot-directed surface — a DM, a top-level @-mention, or an
  // @-mention reply inside a session's mirror thread (see the routers below).
  const launcher = new LaunchFromSlack(collector, {
    webUrl: env.webUrl,
    notify: postInThread,
  });
  // Whether a launch command from a surface that already talks to the sender's
  // Persona goes to that Persona (as a job) rather than straight to the collector.
  // The first delivery's choice is kept per message, so a Slack redelivery after
  // Persona's state changed can't take the other path and launch twice.
  const launchRoutes = new Map<string, boolean>();
  const launchGoesToPersona = async (key: string, userId: string | undefined, text: string): Promise<boolean> => {
    const known = launchRoutes.get(key);
    if (known !== undefined) return known;
    const canAct = persona.canAct(userId);
    const toPersona =
      launchRoute({ surfaceIsPersona: true, personaCanAct: canAct, needsDirect: canAct && (await launcher.needsDirect(text)) }) === "persona";
    launchRoutes.set(key, toPersona);
    if (launchRoutes.size > 1000) launchRoutes.delete(launchRoutes.keys().next().value!);
    return toPersona;
  };

  // Cross-path guard for actionable thread replies: Slack redelivers an event
  // whose socket ack it missed, and the ask-vs-steer route is chosen fresh each
  // time. Recording the inbound message id ONCE here — before that fork — stops
  // a redelivery from crossing paths: without it, delivery 1 answers-and-clears
  // an ask, then the redelivery finds no pending ask and falls to steer,
  // injecting the answer as a spurious live turn.
  const threadReplyDedup = new InboundDedup();

  // Cross-path guard for the bot-directed launch surfaces (a DM, an @-mention).
  // Same purpose as threadReplyDedup but keyed off those events, so a redelivered
  // "launch …" is dropped in-process; the collector's idempotency key is the
  // durable second layer that also survives an adapter restart.
  const botLaunchDedup = new InboundDedup();

  // Launch from a bot-directed message — a DM or an @-mention, both aimed at the
  // bot, so a bare "launch …" is a command here (unlike a plain mirror-thread
  // reply, which stays a steer/ask answer). Returns true when the message WAS a
  // launch command (handled: launched, denied, or a failure surfaced in-thread),
  // so the caller stops; false when it wasn't, so the caller keeps its behavior.
  // `key` dedups in-process AND becomes the collector idempotency key.
  //
  // A launch spawns a repo-modifying agent, so it carries the SAME owner/allowlist
  // gate as steering (handleBotLaunch → launchIsAllowed): only the operator-
  // configured owner (SLACK_ASK_USER) or an allowlisted user may launch, on every
  // surface. A workspace member DMing a fresh install is learned only as the ask
  // recipient — never trusted as an owner — so their "launch …" is still refused.
  const launchFromBotMessage = (a: {
    channel: string;
    replyTs?: string;
    text: string;
    userId?: string;
    actor?: string;
    key: string;
  }): Promise<boolean> =>
    handleBotLaunch(
      { isLaunchCommand: parseLaunchCommand(a.text) !== null, userId: a.userId, key: a.key },
      {
        seen: (k) => botLaunchDedup.seen(k),
        allowed: (u) => steer.allowed(u),
        denied: () => postInThread(a.channel, a.replyTs, Steer.DENIED_NOTICE),
        launch: () =>
          launcher.tryLaunch({
            channel: a.channel,
            threadTs: a.replyTs ?? "",
            text: a.text,
            actor: a.actor,
            idempotencyKey: a.key,
          }),
      },
    );

  // The collector identity for a Slack user, so the activity snapshot scopes to
  // the INVOKING caller's own standing (not the collector-host operator's). A
  // configured owner-map entry (alias:U…) is authoritative and needs no lookup;
  // otherwise the `slack:U…` actor is used — the collector folds it through the
  // actor-merge tombstones, so once reconciled it resolves to the teammate's
  // alias and their real project standing (un-reconciled it has none, so
  // the caller safely sees nothing rather than the operator's cross-project view).
  const slackIdToAlias = new Map<string, string>();
  for (const [alias, slackId] of env.ownerMap) slackIdToAlias.set(slackId, alias);
  const callerActor = (userId: string): string => slackIdToAlias.get(userId) ?? slackActor(userId);

  // The read-only "what's active right now" snapshot: pull the collector's
  // ephemeral activity view and post a compact Block-Kit summary. Reached only
  // AFTER the caller cleared the command-layer authority gate (handleActivityCommand
  // at each call site), so this renders for a trusted Slack user; the collector then
  // scopes it a second time to just what THIS caller (callerActor) may see —
  // bound to the thread's session project in a mirror thread, else a cross-project
  // view the collector's per-caller standing gate narrows. It never resolves to the
  // collector-host operator. Reconcile the caller's slack:U…→alias link FIRST so a
  // first-time caller scopes to their real standing rather than seeing nothing.
  //
  // Visibility: the snapshot is a caller-scoped, cross-project view of OTHER
  // sessions' metadata, so on a SHARED surface (`ephemeral: true` — a channel,
  // @-mention, or mirror thread) it is posted with chat.postEphemeral, visible ONLY
  // to the invoking user, so channel bystanders without standing never read it. The
  // DM surface (`ephemeral: false`) is already private to the invoker, so it posts
  // normally. An ephemeral post with no addressable user is DROPPED rather than
  // downgraded to a channel-visible one (which would re-leak it) — activityDelivery
  // returns null and we bail.
  //
  // Nothing is written to the graph/transcripts, and the reply is a one-off (never a
  // durable feed event). Best-effort: a failed post must not throw into the event
  // loop, and every branch sends a real sentence so the send-guard never drops a
  // blank bubble.
  const handleActivity = async (surface: {
    channel: string;
    threadTs?: string;
    sessionId?: string;
    userId?: string;
    ephemeral: boolean;
  }): Promise<void> => {
    const { channel, threadTs, sessionId, userId, ephemeral } = surface;
    if (userId) await reconcileSlackActor(userId);
    const actor = userId ? callerActor(userId) : undefined;
    const snapshot = await collectActiveWork(collector, { sessionId, actor });
    const { text, blocks } = snapshot.unresolved
      ? { text: ACTIVITY_UNRESOLVED_NOTICE, blocks: undefined }
      : activityMessage(snapshot.items, {
          webUrl: env.webUrl,
          label: snapshot.label,
          omittedProjectCount: snapshot.omittedProjectCount,
        });
    const delivery = activityDelivery({ channel, threadTs, userId, ephemeral });
    if (!delivery) return; // ephemeral surface with no addressee — drop, never post publicly
    if (delivery.method === "chat.postEphemeral") {
      await tx.chat
        .postEphemeral({ ...delivery.base, text, ...(blocks ? { blocks } : {}) })
        .catch(() => {});
      return;
    }
    await tx.chat
      .postMessage({ ...delivery.base, text, ...(blocks ? { blocks } : {}) })
      .catch(() => {});
  };

  console.log(
    mirror.isEnabled()
      ? "[mirror] mirror on in the feed channel — sessions mirror into per-session threads; asks post in-thread."
      : asks.isConfigured
        ? "[asks] recipient set — asks will be DM'd."
        : "ℹ️  No ask recipient yet — DM the bot once, or set SLACK_ASK_USER.",
  );

  // Fold a Slack user's `slack:U…` actor into the alias actor the console
  // mints for the same person, so one teammate isn't counted as two collaborators
  // (identity reconciliation). Only an email at the identity email domain
  // (SLACK_IDENTITY_EMAIL_DOMAIN, else the org profile's identity.emailDomain;
  // see identityEmailDomainFrom) is read as an alias; with no domain nothing merges. Best-effort and once per
  // user per run; a workspace installed before the `users:read`/`users:read.email`
  // scopes were granted logs ONE reinstall hint rather than a per-user error
  // (see actors.ts).
  const actorReconciler = new ActorReconciler(web, collector, env.identityEmailDomain);
  if (!actorReconciler.enabled) console.log(NO_EMAIL_DOMAIN_NOTE);
  const reconcileSlackActor = (userId: string): Promise<void> => actorReconciler.reconcile(userId);

  function routeEvent(msg: WsMessage): void {
    if (msg.type.startsWith("persona:")) {
      persona.onWsMessage(msg);
      return;
    }
    feed.handle(msg); // feed decides whether the event is forwardable
    const sid = (msg.payload as { sessionId?: string } | null)?.sessionId;
    switch (msg.type) {
      case "event:new":
      case "session:event":
        // Both are content-free nudges — event:new on a hook boundary, session:event
        // when the durable transcript head advances (e.g. a long thinking/prose
        // stretch that fires no hook). Either way the mirror pulls the transcript
        // delta and re-renders, so a mid-turn stretch surfaces near-live.
        if (sid) mirror.onEvent(sid);
        break;
      case "ask:new":
        void asks.onAskNew(msg.payload as Ask);
        break;
      case "plan:updated":
        void plans.onPlanUpdated(msg.payload as PlanApproval);
        break;
      case "ask:resolved": {
        const p = msg.payload as { askId?: string; answer?: string };
        if (p.askId) void asks.onAskResolved(p.askId, p.answer ?? "");
        break;
      }
      case "session:status": {
        const p = msg.payload as { sessionId?: string; status?: string; revived?: boolean };
        if (p.sessionId && p.revived) mirror.onRevived(p.sessionId);
        if (p.sessionId && p.status) mirror.onStatus(p.sessionId, p.status);
        break;
      }
      case "stall:detected":
        if (sid) mirror.onStatus(sid, "stalled");
        break;
      case "session:end":
        // A stale end is the collector's guess from silence: close the thread
        // quietly rather than announce an end the session may not have had.
        if (sid) void mirror.onSessionEnd(sid, { marker: (msg.payload as { endReason?: string }).endReason !== "stale" });
        break;
      case "session:deleted":
        // Session removed at the collector — unlink its thread binding so the
        // reverse index doesn't strand a stale rootTs→session route.
        if (sid) mirror.onSessionDeleted(sid);
        break;
    }
  }

  async function refreshSettings(opts: { authoritative?: boolean } = {}): Promise<void> {
    const s = await collector.getSettings();
    // Honor the persisted setting EXACTLY: "" means the user ran `standup off`
    // and it must stay off. Do NOT fall back to env.feedChannel here (that's a
    // startup-only seed), or a reconnect/poll would re-enable a disabled feed.
    // Leave the channel unchanged only when the settings fetch failed (s === null).
    if (s) {
      // A reconnect/open loads authoritatively; a background poll reconciles against
      // the settings version so a blob fetched before a just-issued command's persist
      // landed can't transiently revert the local mutation, while any newer external
      // edit (web UI / direct PUT) is always eventually adopted. The feed channel and
      // the per-channel toggles both refresh in lockstep so a `@bot feed here` /
      // `standup off` / `mirror off` takes effect within the poll interval.
      const channel = opts.authoritative
        ? feedChannelSync.load(s.slackFeedChannel, s.settingsVersion)
        : feedChannelSync.reconcile(s.slackFeedChannel, s.settingsVersion);
      feed.setChannel(channel);
      mirror.setChannel(channel);
      if (opts.authoritative) channelFeatures.load(s.slackChannelFeatures, s.settingsVersion);
      else channelFeatures.reconcile(s.slackChannelFeatures, s.settingsVersion);
    }
  }

  async function refreshAndResync(): Promise<void> {
    await refreshSettings({ authoritative: true });
    await asks.resync();
    await plans.resync();
    await mirror.reconcileTitles(); // heal placeholder root titles once the real title lands
    // Re-render active mirror threads: a session that advanced then went idle
    // during the outage emitted no nudge to self-heal, so refresh it to current.
    await mirror.resyncActive();
    await persona.resync();
  }

  // --- Inbound: DM replies (message.im) ------------------------------------
  app.message(async ({ message }) => {
    const m = message as {
      subtype?: string;
      bot_id?: string;
      user?: string;
      text?: string;
      channel?: string;
      channel_type?: string;
      thread_ts?: string;
      ts?: string;
      client_msg_id?: string;
      files?: unknown[];
    };
    // Self-loop + noise guard: drop our own posts/edits and message subtypes —
    // except a file share in a DM, which is routed like any other DM (see
    // dmMessageRoute): its files go to Persona as attachments.
    const files = inboundSlackFiles(m.files);
    const rawFileCount = Array.isArray(m.files) ? m.files.length : 0;
    const fileShare = isDmFileShare({ subtype: m.subtype, channelType: m.channel_type, text: m.text, fileCount: rawFileCount });
    if ((m.subtype && !fileShare) || m.bot_id || m.user === botUserId) return;
    if (!m.channel) return;
    const text = (m.text ?? "").trim();
    if (!text && !fileShare) return;

    const actor = m.user ? slackActor(m.user) : undefined;
    if (m.user) void reconcileSlackActor(m.user);
    if (m.channel_type === "im") {
      // A Persona user's "launch …" DM is a request to their Persona, which runs
      // it as a job, when launchRoute says so (dmMessageRoute). Otherwise a DM is
      // bot-directed, so a "launch …" here spins up a NEW session. But a
      // pending ask in this DM claims the reply as its ANSWER first — even a reply
      // that begins with "launch" (e.g. answering "how should I proceed?" with
      // "launch the deploy in prod mode") — so answering an ask is never hijacked
      // into a launch that strands the agent (dmMessageRoute / dmShouldTryLaunch). Only when no ask
      // is open is a "launch …" DM treated as a launch command. A direct launch demands
      // EXPLICIT authorization (an operator-configured owner or the allowlist), so
      // a DM never grants launch rights on its own: a member DMing a fresh install
      // is learned only as the ask DELIVERY recipient (noteDmSender) — never as an
      // authorized owner — so a follow-up "launch …" from them is still refused.
      const dmKey = m.client_msg_id ?? `${m.channel}:${m.ts ?? ""}`;
      // With Persona on for the sender, only a reply in an ask card's own thread
      // answers that ask; every other DM of theirs is a message to their
      // Persona, however many older ask cards are still open.
      const personaDm = persona.takesDm(m.user, false);
      const threadAsk = personaDm ? asks.pendingAskForDmThread(m.channel, m.thread_ts) : undefined;
      const askClaims = dmAskClaims({ personaOwnsDm: personaDm, threadAsk, hasPendingForDm: asks.hasPendingForDm(m.channel) });
      // Files ride only on a message to Persona; a DM another route takes (an
      // ask answer, a launch, an activity command) is told they weren't sent,
      // in the thread it was sent in.
      const dmChannel = m.channel;
      const noteUnsentFiles = async (threadTs?: string): Promise<void> => {
        const notice = unsentFilesNotice({ personaDm, fileCount: files.length });
        if (notice) await postInThread(dmChannel, threadTs, notice);
      };
      // Files Slack listed but none of which could be read: say so, then route
      // whatever text came with them as usual.
      const unreadable = unreadableFilesNotice({ personaDm, rawFileCount, fileCount: files.length });
      if (unreadable) await postInThread(dmChannel, m.thread_ts, unreadable);
      const isLaunchCommand = parseLaunchCommand(text) !== null;
      const routeFacts = {
        personaDm,
        fileShare,
        text,
        fileCount: files.length,
        threadAsk: threadAsk !== undefined,
        askClaims,
        isLaunchCommand,
        isActivityCommand: !!parseActivityCommand(text),
        launchToPersona: personaDm && isLaunchCommand && !askClaims && (await launchGoesToPersona(dmKey, m.user, text)),
      };
      let route = dmMessageRoute(routeFacts);
      if (route === "drop") return;
      if (route === "launch") {
        if (await launchFromBotMessage({ channel: m.channel, replyTs: m.ts, text, userId: m.user, actor, key: dmKey })) {
          await noteUnsentFiles();
          return;
        }
        route = dmMessageRoute({ ...routeFacts, isLaunchCommand: false });
      }
      // A DM `active` / `what's happening` is the read-only activity snapshot,
      // delivered over the PRIVATE DM surface (its audience is the invoker alone),
      // so it uses the fail-open-in-open-mode gate (mayViewActivityInDm): when an
      // authority set is configured only the authorized set may view it, but with
      // NO authority configured a single-operator install can still
      // see its own view here (the collector's per-caller actor scoping stays the
      // second gate). This is the ONLY activity surface that fails open — the
      // channel/@-mention paths stay on the strict `authorized` gate because their
      // audience is a shared channel. Only when NO ask is pending in this DM, so a
      // reply that happens to read like the command can't hijack an ask answer and
      // strand the agent (mirrors the launch precedence above). Writes nothing
      // durable.
      if (route === "activity") {
        await handleActivityCommand({
          authorized: mayViewActivityInDm(m.user),
          deny: () => postInThread(dmChannel, undefined, ACTIVITY_DENIED_NOTICE),
          show: () => handleActivity({ channel: dmChannel, userId: m.user, ephemeral: false }),
        });
        await noteUnsentFiles();
        return;
      }
      if (route === "ask" && threadAsk) {
        await asks.onDmThreadReply(threadAsk, m.channel, text, actor, m.user);
        await noteUnsentFiles(m.thread_ts);
        return;
      }
      // A Slack Persona user's DM that isn't an ask answer or a command is a message
      // to their Persona (one running conversation per DM).
      if (route === "persona") {
        await persona.onDm({ channel: m.channel, user: m.user, text, ts: m.ts, clientMsgId: m.client_msg_id, files });
        if (m.user) await asks.noteDmSender(m.user, m.channel);
        return;
      }
      // Not a launch (or an ask claimed it): today's behavior — answer any
      // already-delivered ask (gated to the owner/allowlist inside onDmText — the
      // sender's user id decides, not the learned recipient), then learn/persist
      // the sender as the DELIVERY recipient (which grants no answer authority).
      // An unconfigured sender whose DM no ask claims is instead told once who
      // can add them (only while other users can have a Persona), so the DM
      // gets one reply either way.
      if (askClaims || !(await persona.noticeNoPersonaDm(m.channel, m.user))) {
        await asks.onDmText(m.channel, text, actor, m.user);
      }
      if (m.user) await asks.noteDmSender(m.user, m.channel);
      return;
    }
    // Channel/group: only a reply IN a session's mirror thread is actionable.
    // A reply RESOLVES that session's pending ask if one is open; otherwise it
    // STEERS the live agent. All other channel chatter is ignored (we never
    // forward channel messages anywhere).
    if (m.thread_ts) {
      // sessionForRoot cross-checks the reverse route against the forward binding,
      // so a stale/aliased rootTs resolves to undefined (ignored) instead of naming
      // a session whose current rootTs differs — an inbound reply fails safe.
      const sessionId = mirror.sessionForRoot(m.thread_ts);
      if (!sessionId) {
        // A Persona-bound thread: the owner's follow-ups reach Persona without a
        // mention; anything else is chatter (read later as context).
        await persona.onThreadMessage({
          channel: m.channel,
          user: m.user,
          text,
          ts: m.ts,
          threadTs: m.thread_ts,
          clientMsgId: m.client_msg_id,
        });
        return;
      }
      // client_msg_id is stable across a Slack redelivery; fall back to the ts.
      const dedupKey = m.client_msg_id ?? `${m.channel}:${m.ts ?? ""}`;
      // Dedup BEFORE the precedence fork so a redelivery can't switch paths
      // (ask → steer) between deliveries and act twice on one message.
      if (threadReplyDedup.seen(dedupKey)) return;
      // Authorize BEFORE the fork: whether it answers the agent's open ask, steers
      // a live agent, or pulls the activity snapshot, an actionable thread reply
      // touches someone's running session or its cross-agent metadata, so the SAME
      // owner/allowlist gate must guard every door. Gating only steer would let a
      // stranger unblock/redirect an agent through the ungated ask door purely
      // because the session happened to have a pending ask — or read the activity
      // snapshot uninvited. Dedup already recorded this id, so a redelivery of a
      // denied reply is dropped rather than re-notified.
      if (!steer.allowed(m.user)) {
        await steer.denyNotice(m.channel, m.thread_ts);
        return;
      }
      // A bot-directed activity request in a mirror thread (`@bot active`) is a
      // read-only snapshot bound to THIS thread's session project and further
      // scoped by the collector to what the (now authorized) asking user may see.
      // It takes precedence over the ask/steer fork so it is never injected as a
      // live turn. Requiring the explicit @bot mention keeps a bare "active" reply
      // a normal steer — never hijacked. An unauthorized reply was already refused
      // by the gate above, so this branch is reached only by a trusted caller.
      // The thread lives in a shared channel, so the snapshot is posted ephemerally
      // (ephemeral: true) — visible only to the asking user, never to channel
      // bystanders who may lack standing in the snapshot's projects.
      if (text.includes(`<@${botUserId}>`) && parseActivityCommand(text)) {
        await handleActivity({ channel: m.channel, threadTs: m.thread_ts, sessionId, userId: m.user, ephemeral: true });
        return;
      }
      // A launch command spins up a NEW session and takes precedence over the
      // ask/steer routing for this thread; a non-launch reply falls through to
      // the current behavior (answer a pending ask, else steer). Same gate as
      // both those doors (applied just above), since a launch is privileged too.
      //
      // requireMentionOf: in a mirror thread a bare "launch …" is an ordinary
      // steer or ask answer ("launch it with vitest"), so a launch here must
      // explicitly @-mention the bot ("@bot launch … in <project>"). Without this
      // guard any reply starting with "launch" would hijack the ask/steer route
      // and spawn a session while the intended action silently failed. dedupKey
      // is reused as the collector idempotency key, hardening launch against a
      // redelivery the same way steer already is.
      if (
        await launcher.tryLaunch({
          channel: m.channel,
          threadTs: m.thread_ts,
          text,
          actor,
          idempotencyKey: dedupKey,
          requireMentionOf: botUserId,
        })
      ) {
        return;
      }
      if (asks.hasPendingForSession(sessionId)) {
        await asks.onThreadReply(m.thread_ts, text, actor, m.user);
        return;
      }
      await steer.onThreadReply({
        sessionId,
        channel: m.channel,
        rootTs: m.thread_ts,
        text,
        userId: m.user,
        actor,
        dedupKey,
      });
    }
  });

  // --- Inbound: @-mention — launch a session, or manage the feed -----------
  app.event("app_mention", async ({ event, say }) => {
    const e = event as {
      channel?: string;
      text?: string;
      user?: string;
      ts?: string;
      thread_ts?: string;
      client_msg_id?: string;
    };
    const channel = e.channel;
    if (!channel) return;
    if (e.user) void reconcileSlackActor(e.user);
    const raw = (e.text ?? "").trim();

    // A mention that is a reply INSIDE a known mirror thread belongs to the
    // message router above — it resolves the target session and handles
    // launch/steer/ask there. Bail so the same message isn't processed twice (and
    // so a task that merely contains "feed" isn't caught by the toggle below).
    if (e.thread_ts && mirror.sessionForRoot(e.thread_ts)) return;

    // A launch @-mention goes to Persona or spins up a NEW session. Checked BEFORE
    // the loose "feed" keyword match so a launch task that mentions "feed" isn't
    // swallowed by the toggle. The reply threads under the mention. A direct launch requires EXPLICIT
    // authorization — an operator-configured owner (SLACK_ASK_USER) or a
    // SLACK_STEER_ALLOWLIST entry — otherwise a coworker's @-mention on a fresh
    // install could spawn an agent on the operator's host. DMing the bot only
    // learns an ask recipient; it never grants launch rights.
    const key = e.client_msg_id ?? `${channel}:${e.ts ?? ""}`;
    // A Persona user's launch goes to their Persona, which runs it as a job of
    // this thread, so the thread gets the job's milestones — when the thread is
    // theirs to talk to Persona in and launchRoute says so; otherwise (another
    // user's Persona thread, Persona paused, an explicit harness/model/effort, a
    // non-Claude project) it is a direct launch, behind the steer gate.
    const mention = {
      channel,
      user: e.user,
      text: raw,
      ts: e.ts,
      threadTs: e.thread_ts,
      clientMsgId: e.client_msg_id,
    };
    if (
      parseLaunchCommand(raw) !== null &&
      persona.takesMention(mention) &&
      (await launchGoesToPersona(key, e.user, raw)) &&
      (await persona.onMention(mention))
    ) {
      return;
    }
    if (
      await launchFromBotMessage({
        channel,
        replyTs: e.thread_ts ?? e.ts,
        text: raw,
        userId: e.user,
        actor: e.user ? slackActor(e.user) : undefined,
        key,
      })
    ) {
      return;
    }

    // A top-level `@bot active` / `@bot what's happening` is the read-only activity
    // snapshot. It is AUTHORITY-GATED like steer/launch — an unauthorized member is
    // refused, never handed session data — and the collector further scopes what
    // remains to what the asking user (e.user) may see. This is a shared-channel
    // surface, so it stays on the strict `authorized` gate (never fails open) AND
    // the snapshot is posted ephemerally (ephemeral: true) — visible only to the
    // asking user, so channel bystanders without standing never read a caller-scoped
    // cross-project snapshot. Checked before the channel-config grammar (which shares
    // no verb with it) so it isn't mistaken for help; a mention that is a mirror-thread
    // reply already bailed above to the message router. Unbound here (no thread
    // session), so it renders a cross-project view.
    if (parseActivityCommand(raw)) {
      await handleActivityCommand({
        authorized: authorized(e.user),
        deny: async () => {
          await say({ text: ACTIVITY_DENIED_NOTICE });
        },
        show: () => handleActivity({ channel, threadTs: e.thread_ts ?? e.ts, userId: e.user, ephemeral: true }),
      });
      return;
    }

    // Feed/toggle subcommands. `feed here` makes this the standup channel (quiet:
    // mirror and feed lines off); `feed on`/`feed off` toggle this channel's
    // feed LINES; `standup off` / `off` unset the channel entirely; `<feature>
    // on|off`, `feed <kind> on|off`, and `feed status` tune per-channel toggles.
    // Anything unrecognized falls through to the help text.
    const cmd = parseChannelCommand(raw);
    if (cmd) {
      // Reconfiguring where/how the adapter posts is privileged: `feed here`,
      // `standup off`, and the feature / feed-kind toggles all mutate a shared
      // channel's Standup config, so they carry the SAME authority as steer/launch
      // (mayConfigure). When an authority set IS configured, only the authorized
      // set may mutate — otherwise a coworker could redirect or silence the feed.
      // With no authority configured the gate fails OPEN (single-operator install),
      // preserving today's behavior. Read-only `feed status` stays open regardless.
      if (!isReadOnlyChannelCommand(cmd) && !mayConfigure(e.user)) {
        await say({ text: CONFIG_DENIED_NOTICE });
        return;
      }
      // Bolt dispatches these handlers concurrently and they run with no
      // cross-handler serialization: each persists ONLY its own channel's delta —
      // which the collector merges onto the stored blob per-channel atomically (a
      // synchronous read-merge-write) — and stamps ONLY its own channel's version.
      // So two commands, even on the same channel, apply in request order at the
      // collector and neither can clobber the other's channel or mis-stamp a
      // version it didn't persist.
      switch (cmd.kind) {
        case "feed-here": {
          const setChannelRes = await collector.setFeedChannel(channel);
          feedChannelSync.setLocal(channel, setChannelRes?.settingsVersion);
          feed.setChannel(channel);
          mirror.setChannel(channel);
          // Reset the channel to the quiet default so setup honors its own promise
          // (mirror and feed lines off) regardless of history: a stale `feed on` /
          // `mirror on` override left from a prior life would otherwise survive and
          // make the channel loud despite this reply. Persist just
          // THIS channel's teardown as a delta so a concurrent edit to another channel
          // isn't clobbered by a whole-blob write.
          channelFeatures.set(clearChannel(channelFeatures.snapshot(), channel));
          const featuresRes = await collector.patchChannelFeatures(clearChannelPatch(channel));
          channelFeatures.recordPersistedVersion(featuresRes?.settingsVersion, [channel]);
          await say({ text: "📣 Standup channel set. Sessions don't stream here by default: mention me in a thread to work with Persona, and that thread gets its jobs' milestones (started, blocked on you, a worker's findings, review ready, done). Approval cards come to your DM. `mirror on` streams every session into its own thread here; `feed on` adds a one-line event feed; `feed digest on` adds just the daily digest." });
          return;
        }
        case "standup-off": {
          const setChannelRes = await collector.setFeedChannel("");
          feedChannelSync.setLocal("", setChannelRes?.settingsVersion);
          feed.setChannel(undefined);
          mirror.setChannel(undefined);
          // Fully unset the channel: drop its feature overrides too, so a later
          // `feed here` starts from the quiet default instead of resurrecting a
          // stale feed:true / mirror:true override left in the persisted blob.
          // Persist just this channel's teardown as a delta (leaves other channels).
          channelFeatures.set(clearChannel(channelFeatures.snapshot(), channel));
          const featuresRes = await collector.patchChannelFeatures(clearChannelPatch(channel));
          channelFeatures.recordPersistedVersion(featuresRes?.settingsVersion, [channel]);
          await say({ text: "🔕 Standup removed from this channel (feed + mirror cleared). Mention me with `feed here` to set it up again." });
          return;
        }
        case "feature": {
          // `feed on` / `mirror on` double as "make this the standup channel":
          // ensure the channel is set so one command both targets it and starts
          // delivery (the mirror and feed post only in the standup channel).
          if ((cmd.feature === "feed" || cmd.feature === "mirror") && cmd.on) {
            const setChannelRes = await collector.setFeedChannel(channel);
            feedChannelSync.setLocal(channel, setChannelRes?.settingsVersion);
            feed.setChannel(channel);
            mirror.setChannel(channel);
          }
          channelFeatures.set(setFeature(channelFeatures.snapshot(), channel, cmd.feature, cmd.on));
          const featuresRes = await collector.patchChannelFeatures(featurePatch(channel, cmd.feature, cmd.on));
          channelFeatures.recordPersistedVersion(featuresRes?.settingsVersion, [channel]);
          await say({ text: `${cmd.on ? "✅" : "🚫"} \`${cmd.feature}\` ${cmd.on ? "on" : "off"} for this channel.` });
          return;
        }
        case "feed-kind": {
          // `feed digest on` works by itself (the digest skips the feed master),
          // so like `feed on` it makes this the standup channel.
          if (cmd.feedKind === "digest" && cmd.on) {
            const setChannelRes = await collector.setFeedChannel(channel);
            feedChannelSync.setLocal(channel, setChannelRes?.settingsVersion);
            feed.setChannel(channel);
            mirror.setChannel(channel);
          }
          channelFeatures.set(setFeedKind(channelFeatures.snapshot(), channel, cmd.feedKind, cmd.on));
          const featuresRes = await collector.patchChannelFeatures(feedKindPatch(channel, cmd.feedKind, cmd.on));
          channelFeatures.recordPersistedVersion(featuresRes?.settingsVersion, [channel]);
          await say({ text: `${cmd.on ? "✅" : "🚫"} feed \`${cmd.feedKind}\` lines ${cmd.on ? "on" : "off"} for this channel.` });
          return;
        }
        case "status":
          await say({ text: `⚙️ This channel's Standup toggles:\n${describeChannel(channelFeatures.snapshot(), channel)}` });
          return;
      }
    }
    // Not a command: a Slack Persona user's mention starts or joins this thread's
    // conversation with their Persona (replies in-thread), unless the thread is
    // already someone else's; anyone else gets a one-time notice.
    if (await persona.onMention(mention)) return;
    await say({
      text:
        "Say `feed here` to make this the Standup channel, `mirror on` to stream every session into its own thread here, `feed on` to add the feed lines (`feed off` to mute them), " +
        "`feed digest on` for just the daily digest, " +
        "`feed status` to see toggles, `mirror off` / `asks off` / `feed <kind> off` to tune this channel, " +
        "`active` (or `what's happening`) to see what's running right now, " +
        "`standup off` to remove Standup from here, " +
        "or `launch <task> in <project>` to start a session.",
    });
  });

  // --- Inbound: ask-option button clicks -----------------------------------
  app.action(new RegExp(`^${ASK_ACTION_PREFIX}`), async ({ ack, action, body }) => {
    await ack();
    const value = (action as { value?: string }).value;
    if (!value) return;
    const userId = (body as { user?: { id?: string } }).user?.id;
    if (userId) void reconcileSlackActor(userId);
    try {
      // Pass the tapper's user id so onButton can gate the answer to the
      // owner/allowlist — a card in a shared mirror thread is tappable by anyone.
      await asks.onButton(
        JSON.parse(value) as AskActionValue,
        userId ? slackActor(userId) : undefined,
        userId,
      );
    } catch (err) {
      console.error("[action] bad button value:", err instanceof Error ? err.message : err);
    }
  });

  // --- Inbound: plan Approve/Reject button clicks --------------------------
  app.action(new RegExp(`^${PLAN_ACTION_PREFIX}`), async ({ ack, action, body }) => {
    await ack();
    const value = (action as { value?: string }).value;
    if (!value) return;
    const userId = (body as { user?: { id?: string } }).user?.id;
    if (userId) void reconcileSlackActor(userId);
    try {
      // Pass the tapper's user id so onButton can gate the decision to the
      // owner/allowlist — the plan card sits in the delivery recipient's DM.
      await plans.onButton(
        JSON.parse(value) as PlanActionValue,
        userId ? slackActor(userId) : undefined,
        userId,
      );
    } catch (err) {
      console.error("[action] bad plan button value:", err instanceof Error ? err.message : err);
    }
  });

  // --- Inbound: Persona quick replies and approval cards -------------------
  const buttonTap = (action: unknown, body: unknown) => {
    const a = action as { action_id?: string; value?: string };
    const b = body as {
      user?: { id?: string };
      channel?: { id?: string };
      container?: { channel_id?: string; message_ts?: string };
      message?: { ts?: string; blocks?: Record<string, unknown>[] };
    };
    return {
      actionId: a.action_id ?? "",
      value: a.value,
      userId: b.user?.id,
      channel: b.channel?.id ?? b.container?.channel_id,
      messageTs: b.message?.ts ?? b.container?.message_ts,
      messageBlocks: b.message?.blocks,
    };
  };
  app.action(new RegExp(`^${PERSONA_OPTION_PREFIX}`), async ({ ack, action, body }) => {
    await ack();
    await persona.onOptionButton(buttonTap(action, body));
  });
  app.action(new RegExp(`^${PERSONA_APPROVAL_PREFIX}`), async ({ ack, action, body }) => {
    await ack();
    await persona.onApprovalButton(buttonTap(action, body));
  });

  // --- Inbound: "Send to Persona" message shortcut ---------------------------
  app.shortcut(PERSONA_SHORTCUT_ID, async ({ ack, shortcut }) => {
    await ack();
    const sc = shortcut as {
      action_ts?: string;
      user?: { id?: string };
      channel?: { id?: string; name?: string };
      message?: { ts?: string; text?: string; user?: string; username?: string; thread_ts?: string };
    };
    if (!sc.channel?.id || !sc.message?.ts) return;
    await persona.onShortcut({
      userId: sc.user?.id,
      channelId: sc.channel.id,
      channelName: sc.channel.name,
      actionTs: sc.action_ts,
      message: {
        ts: sc.message.ts,
        text: sc.message.text,
        user: sc.message.user,
        username: sc.message.username,
        threadTs: sc.message.thread_ts,
      },
    });
  });

  app.error(async (err) => {
    console.error("[bolt] error:", err.message);
  });

  await persona.refresh();
  await app.start();
  console.log(`⚡️ Slack adapter running (bot ${botUserId}). Connecting to collector…`);
  collector.connect();

  // Poll settings so a feed-channel change (via @mention, the web UI, or a
  // direct PUT) is reflected within seconds, not only on a WS reconnect.
  const settingsTimer = setInterval(() => void refreshSettings(), 15000);

  // Slow backstop for the reconnect re-render: a session that advanced then went
  // idle during a WS blip (so no live nudge follows) is refreshed to current
  // state even if the reconnect resync missed it. Much slower than the nudge
  // path — a no-op when nothing changed.
  const resyncTimer = setInterval(() => void mirror.resyncActive(), 120000);

  const shutdown = () => {
    console.log("\n[slack] shutting down…");
    clearInterval(settingsTimer);
    clearInterval(resyncTimer);
    store.flush();
    personaStore.flush();
    collector.close();
    void app.stop().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Slack adapter crashed:", err);
  process.exit(1);
});
