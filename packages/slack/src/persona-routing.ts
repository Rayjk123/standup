// Pure routing for Persona-in-Slack: which Slack user directs which Persona,
// how a Slack surface is addressed, and which inbound events go to Persona
// versus the adapter's existing handlers. Kept free of I/O (like
// launch-gate.ts) so every branch is pinned by a plain unit test.

import { dmShouldTryLaunch } from "./launch-gate.js";

/** The host's Slack id: SLACK_ASK_USER, else the SLACK_OWNER_MAP entry for the host's alias. */
export function resolvePersonaOwnerSlackId(
  config: { askUser?: string; ownerMap: Map<string, string> },
  personaOwnerAlias: string | undefined,
): string | undefined {
  if (config.askUser) return config.askUser;
  if (!personaOwnerAlias) return undefined;
  return config.ownerMap.get(personaOwnerAlias);
}

/**
 * When SLACK_ASK_USER and the SLACK_OWNER_MAP entry for Persona's owner both
 * name someone and disagree, the two ids; null when they agree or only one is
 * set. A disagreement means the operator's config is ambiguous about who
 * directs Persona, so the caller fails closed rather than picking one.
 */
export function personaOwnerConflict(
  config: { askUser?: string; ownerMap: Map<string, string> },
  personaOwnerAlias: string | undefined,
): { askUser: string; mapped: string } | null {
  const mapped = personaOwnerAlias ? config.ownerMap.get(personaOwnerAlias) : undefined;
  if (!config.askUser || !mapped || mapped === config.askUser) return null;
  return { askUser: config.askUser, mapped };
}

/** Who may direct a Persona from Slack: each Slack id and the alias whose Persona it directs. */
export interface PersonaDirectory {
  hostAlias: string;
  hostSlackId: string | undefined;
  aliasBySlackId: Map<string, string>;
  slackIdByAlias: Map<string, string>;
}

/**
 * The Slack user ↔ alias directory. The host is SLACK_ASK_USER (else their
 * SLACK_OWNER_MAP entry) and always has a Persona here. Another user has one
 * only when their alias is listed in SLACK_PERSONA_USERS (`personaUsers`) and
 * SLACK_OWNER_MAP pairs it with their Slack id; a mapped alias that isn't
 * listed keeps only owner-routed asks. A pair naming the host's Slack id, or a
 * Slack id claimed by more than one alias, is left out: nobody gets a Persona
 * from an ambiguous mapping. Slack users not in the directory have no Persona.
 */
export function personaDirectory(
  config: { askUser?: string; ownerMap: Map<string, string>; personaUsers?: readonly string[] },
  hostAlias: string,
): PersonaDirectory {
  const hostSlackId = resolvePersonaOwnerSlackId(config, hostAlias);
  const listed = new Set(config.personaUsers ?? []);
  const claims = new Map<string, number>();
  for (const id of config.ownerMap.values()) claims.set(id, (claims.get(id) ?? 0) + 1);
  const aliasBySlackId = new Map<string, string>();
  const slackIdByAlias = new Map<string, string>();
  if (hostSlackId) {
    aliasBySlackId.set(hostSlackId, hostAlias);
    slackIdByAlias.set(hostAlias, hostSlackId);
  }
  for (const [alias, id] of config.ownerMap) {
    if (!alias || !id || !listed.has(alias) || alias === hostAlias || id === hostSlackId || claims.get(id) !== 1) continue;
    aliasBySlackId.set(id, alias);
    slackIdByAlias.set(alias, id);
  }
  return { hostAlias, hostSlackId, aliasBySlackId, slackIdByAlias };
}

/**
 * Whether a DM from `userId` gets the "you don't have a Persona here" notice:
 * only when other users can have a Persona (SLACK_PERSONA_USERS lists someone),
 * and only for a sender the operator hasn't configured at all — the host and
 * every SLACK_OWNER_MAP user (listed or not) keep their usual DM replies.
 */
export function offersNoPersonaNotice(a: {
  active: boolean;
  multiUser: boolean;
  userId: string | undefined;
  hostSlackId: string | undefined;
  ownerMap: Map<string, string>;
}): boolean {
  if (!a.active || !a.multiUser || !a.userId || a.userId === a.hostSlackId) return false;
  for (const id of a.ownerMap.values()) if (id === a.userId) return false;
  return true;
}

/** `login` (alone on the message, any case): a mapped user asking for a console sign-in link. */
export function isLoginCommand(text: string): boolean {
  return text.trim().toLowerCase() === "login";
}

/** Binding key (and Persona `externalRef`) for a DM channel. */
export function dmKey(channel: string): string {
  return `dm:${channel}`;
}

/** Binding key (and Persona `externalRef`) for a channel thread. */
export function channelThreadKey(channel: string, threadTs: string): string {
  return `${channel}:${threadTs}`;
}

/** Slack DM conversation ids start with `D` — the same rule the collector applies to `dm:` refs. */
const DM_ID = /^D[^\s:]+$/;
/** Slack channel ids start with `C` (public / shared) or `G` (private). */
const CHANNEL_ID = /^[CG][^\s:]+$/;

/**
 * The binding kind and Slack address an `externalRef` names, or null when it
 * isn't a Slack address: `dm:` must name a DM id (`D…`) and a channel thread a
 * channel id (`C…` / `G…`), so a ref can never steer DM replies into a channel.
 */
export function parseExternalRef(ref: string): { kind: "dm"; channel: string } | { kind: "channel"; channel: string; threadTs: string } | null {
  if (ref.startsWith("dm:")) {
    const channel = ref.slice(3);
    return DM_ID.test(channel) ? { kind: "dm", channel } : null;
  }
  const sep = ref.indexOf(":");
  if (sep <= 0) return null;
  const channel = ref.slice(0, sep);
  const threadTs = ref.slice(sep + 1);
  return CHANNEL_ID.test(channel) && /^\d+\.\d+$/.test(threadTs) ? { kind: "channel", channel, threadTs } : null;
}

/**
 * Whether a Persona thread's audience fits the Slack surface it's bound to:
 * a DM is private, a channel thread is never private.
 */
export function audienceFitsBinding(kind: "dm" | "channel", audience: string | undefined): boolean {
  return kind === "dm" ? audience === "private" : audience === "shared" || audience === "external";
}

/** The in-process dedup key for an inbound Slack message (shared by `message` and `app_mention`). */
export function inboundKey(channel: string, ts: string | undefined): string {
  return `${channel}:${ts ?? ""}`;
}

/** The collector idempotency key for an inbound message: Slack's `client_msg_id`, else channel + ts. */
export function personaIdempotencyKey(channel: string, ts: string | undefined, clientMsgId: string | undefined): string {
  return clientMsgId ?? `slack:${channel}:${ts ?? ""}`;
}

/** `!mute` / `!unmute` (alone on the message, any case). */
export function parseMuteCommand(text: string): "mute" | "unmute" | null {
  const t = text.trim().toLowerCase();
  if (t === "!mute") return "mute";
  if (t === "!unmute") return "unmute";
  return null;
}

/** Whether a numeric Slack ts is strictly newer than another (absent counts as oldest). */
export function tsAfter(ts: string, than: string | undefined): boolean {
  if (!than) return true;
  return Number(ts) > Number(than);
}

/**
 * A DM goes to Persona when Persona is active, the sender has a Persona (is in
 * the directory), and no open ask claims the reply (the launch / `active`
 * commands are checked before this by the caller). Everything else keeps the
 * adapter's existing DM handling.
 */
export function dmRoute(a: { active: boolean; hasPersona: boolean; hasPendingAsk: boolean }): "persona" | "legacy" {
  return a.active && a.hasPersona && !a.hasPendingAsk ? "persona" : "legacy";
}

/**
 * An @-mention outside a mirror thread that isn't an existing command. A
 * sender with a Persona starts the thread in theirs, or continues it when the
 * thread is already theirs; a thread bound to someone else's Persona takes the
 * newcomer's words only as context (`foreign`), and a sender with no Persona
 * gets `no-persona` — each notice once per thread (`ignore` after). With
 * Persona off the adapter's help text answers as before.
 */
export function mentionRoute(a: {
  active: boolean;
  /** The sender's alias, when they have a Persona. */
  alias: string | undefined;
  /** The owner of the Persona thread already bound here, if any. */
  boundOwner: string | undefined;
  noticeShown: boolean;
}): "persona" | "no-persona" | "foreign" | "ignore" | "legacy" {
  if (!a.active) return "legacy";
  if (a.alias && (!a.boundOwner || a.boundOwner === a.alias)) return "persona";
  if (a.noticeShown) return "ignore";
  return a.alias ? "foreign" : "no-persona";
}

/**
 * Where a bot-directed `launch …` (a DM, or an @-mention outside a mirror
 * thread) goes. It is a request to the sender's Persona, which runs it as a
 * job of that thread, when the surface already routes to their Persona
 * (`surfaceIsPersona`: the DM is theirs, or the mention's route is
 * `persona`), their Persona can act now (not paused or in error), and the
 * launch doesn't `needsDirect`: a `harness=` / `model=` / `effort=` clause,
 * which only the direct launch honors, or a project on a harness Persona
 * doesn't launch into. Otherwise it is a direct launch, behind the steer gate.
 */
export function launchRoute(a: { surfaceIsPersona: boolean; personaCanAct: boolean; needsDirect: boolean }): "persona" | "direct" {
  return a.surfaceIsPersona && a.personaCanAct && !a.needsDirect ? "persona" : "direct";
}

/**
 * A plain (non-mention) message in a channel thread. Only a Persona-bound
 * thread is ours; there the binding owner's `!mute` / `!unmute` toggles
 * follow-ups and any other message of theirs reaches Persona unless muted. A message that
 * @-mentions the bot is left to the `app_mention` handler so it never sends
 * twice; other people's messages are left for Persona to read later as context.
 */
export function threadMessageRoute(a: {
  active: boolean;
  bound: boolean;
  isOwner: boolean;
  muted: boolean;
  mentionsBot: boolean;
  text: string;
}): "persona" | "mute" | "unmute" | "ignore" {
  if (!a.active || !a.bound || !a.isOwner || a.mentionsBot) return "ignore";
  const cmd = parseMuteCommand(a.text);
  if (cmd) return cmd;
  return a.muted ? "ignore" : "persona";
}

/**
 * Whether an open ask claims a DM as its answer. While Persona owns the
 * owner's DM only a reply in an ask card's own thread does (`threadAsk`), so
 * an older open card never swallows a message meant for Persona; otherwise
 * any open ask in the DM does, as before Persona.
 */
export function dmAskClaims(a: { personaOwnsDm: boolean; threadAsk: string | undefined; hasPendingForDm: boolean }): boolean {
  return a.personaOwnsDm ? a.threadAsk !== undefined : a.hasPendingForDm;
}

/**
 * The text Persona gets for a DM that shared files: the message, plus a note
 * of how many files couldn't be attached (the attached ones speak for
 * themselves; "more" only when some were).
 */
export function fileShareDmText(text: string | undefined, failedCount: number, attachedCount = 0): string {
  const more = attachedCount > 0 ? " more" : "";
  const note = failedCount > 0 ? `(${failedCount}${more} attachment${failedCount === 1 ? "" : "s"} couldn't be sent)` : "";
  return [(text ?? "").trim(), note].filter(Boolean).join(" ");
}

/** What a Persona user is told when Slack sent files with a message but none could be read. */
export const UNREADABLE_FILES_NOTICE = "⚠️ Couldn't read the files in that message — try sending them again.";

/**
 * The notice for a Persona user's DM whose `files` held entries but none that
 * could be read (no file id): the files can't be fetched, so the owner is
 * told rather than left with silence; any text still goes on.
 */
export function unreadableFilesNotice(a: { personaDm: boolean; rawFileCount: number; fileCount: number }): string | undefined {
  return a.personaDm && a.rawFileCount > 0 && a.fileCount === 0 ? UNREADABLE_FILES_NOTICE : undefined;
}

/** Where an IM goes: a launch, the activity snapshot, an ask answer, Persona, the pre-Persona DM path, or nowhere. */
export type DmMessageRoute = "drop" | "launch" | "activity" | "ask" | "persona" | "other";

/**
 * Where an IM (plain or `file_share`) goes. With text, the activity command
 * comes first unless an ask claims the DM, then a reply in an ask card's
 * thread answers it — files or not — and only then is it a message to
 * Persona. A launch command that `launchToPersona` (see launchRoute) is a
 * message to Persona too, so the work becomes a Persona job whose milestones
 * come back to the DM; any other is a direct launch, and one that doesn't go
 * through is routed again with `isLaunchCommand: false`. Without text, only a
 * Persona user's files have anywhere to go (Persona); a file share from anyone
 * else is dropped.
 */
export function dmMessageRoute(a: {
  personaDm: boolean;
  fileShare: boolean;
  text: string;
  fileCount: number;
  threadAsk: boolean;
  askClaims: boolean;
  isLaunchCommand: boolean;
  isActivityCommand: boolean;
  launchToPersona: boolean;
}): DmMessageRoute {
  if (a.fileShare && !a.personaDm) return "drop";
  if (!a.text) return a.personaDm && a.fileCount > 0 ? "persona" : "drop";
  if (!a.launchToPersona && dmShouldTryLaunch({ hasPendingAsk: a.askClaims, isLaunchCommand: a.isLaunchCommand })) return "launch";
  if (!a.askClaims && a.isActivityCommand) return "activity";
  if (a.threadAsk) return "ask";
  return a.personaDm ? "persona" : "other";
}

/** What a Persona user is told when their DM's files went nowhere because another route took the DM. */
export const UNSENT_FILES_NOTICE = "📎 Files aren't sent with ask answers or launch commands — send them as a separate DM.";

/**
 * The notice for a DM an ask answer, launch or command took: only a Persona
 * user's DM that carried files gets one (anyone else's files never go to
 * Persona at all).
 */
export function unsentFilesNotice(a: { personaDm: boolean; fileCount: number }): string | undefined {
  return a.personaDm && a.fileCount > 0 ? UNSENT_FILES_NOTICE : undefined;
}

/**
 * Whether an IM `message` event is a file share for the Persona route: a
 * `file_share`, or a plain message that carries files and no text (one with
 * text takes the usual DM route, files included).
 */
export function isDmFileShare(m: { subtype?: string; channelType?: string; text?: string; fileCount: number }): boolean {
  if (m.channelType !== "im") return false;
  if (m.subtype === "file_share") return true;
  return !m.subtype && m.fileCount > 0 && !(m.text ?? "").trim();
}
