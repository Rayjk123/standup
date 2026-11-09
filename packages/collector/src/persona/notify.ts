import type { Database } from "bun:sqlite";
import type { NotifyFacts, NotifyKind, NotifyPrefs, PersonaMessageNotify } from "@standup/shared";
import { notifyChannelsFor, resolveNotifyPrefs } from "@standup/shared";
import { getLaunch, getNotifyPrefs, getPersonaJob } from "@standup/store";
import { privatePushAvailable, pushNotification } from "../push.js";

// Applies a user's notification prefs to one update: which channels beyond
// the console it goes to. Slack delivery reads the routing stored on the
// message (persona_messages.notify_json); push is sent from here.

/** `owner`'s prefs in force for updates about `projectId` (none: their global prefs). */
export function notifyPrefsFor(db: Database, owner: string, projectId?: string | null): NotifyPrefs {
  return resolveNotifyPrefs([getNotifyPrefs(db, owner, null), projectId ? getNotifyPrefs(db, owner, projectId) : null]);
}

/** The project of a job's newest launch, which is the project its updates are routed by. */
export function jobProjectId(db: Database, jobId: string | undefined): string | undefined {
  if (!jobId) return undefined;
  const job = getPersonaJob(db, jobId, { withView: false });
  for (const launchId of [...(job?.launchIds ?? [])].reverse()) {
    const projectId = getLaunch(db, launchId)?.projectId;
    if (projectId) return projectId;
  }
  return undefined;
}

/**
 * The routing of an update of `kind` to `recipient`, under their prefs for
 * the first of `jobIds` that has a project. Its channels are empty when the
 * kind's condition doesn't hold: the update stays in the console, and the
 * Slack bridge, seeing it routed, doesn't mirror it either.
 */
export function routeUpdate(
  db: Database,
  recipient: string,
  kind: NotifyKind,
  opts: { jobIds?: Array<string | undefined>; facts?: NotifyFacts } = {}
): PersonaMessageNotify {
  const projectId = kind === "brief" ? undefined : (opts.jobIds ?? []).map((id) => jobProjectId(db, id)).find((p) => !!p);
  const prefs = notifyPrefsFor(db, recipient, projectId);
  return { kind, channels: notifyChannelsFor(prefs, kind, opts.facts) };
}

/**
 * Sends `notify`'s push, when it routes to push. A brief, done or progress
 * update carries the recipient's own job content, so it is pushed only to a
 * topic that is theirs alone (privatePushAvailable); a decision keeps the
 * push routing every attention push has.
 */
export function pushIfRouted(
  notify: PersonaMessageNotify | undefined,
  title: string,
  text: string,
  recipient: string,
  host: string,
  push: typeof pushNotification = pushNotification
): void {
  if (!notify?.channels.includes("push")) return;
  if (notify.kind !== "decision" && !privatePushAvailable(recipient, host)) return;
  // A push renders plain text, so Markdown emphasis and code marks are dropped.
  const plain = text.replace(/\*\*|__|`/g, "");
  const body = plain.length > 300 ? `${plain.slice(0, 299)}…` : plain;
  void push(title, body, recipient);
}
