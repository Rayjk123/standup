// Launch-from-Slack: a bot-directed "launch <task> in <project>" message spins
// up a NEW task session through the collector's launch endpoint and replies
// in-thread with the created session's link. This is what turns Slack from an
// ask router into a task-LAUNCH surface.
//
// The command grammar is a pure function (launch-command.ts). This layer does
// the two impure steps: resolve the named project to an id (by id or name, else
// the default scratch project), and call CollectorClient.launch — then post the
// outcome back into the thread. It sits in the message router AHEAD of the
// ask/steer fork: a launch command is handled here; a non-launch message falls
// through to the current behavior (answer a pending ask, else steer).
//
// Launching is privileged (it spawns a repo-modifying agent), but this layer is
// intentionally NOT the gate — the router applies the same owner/allowlist gate
// it already applies to the ask/steer doors before calling here, so all three
// actionable doors share one gate.

import { sessionShareUrl, shortSessionId } from "@standup/shared";
import type { ClaudeEffort, ClaudeModel, CodexEffort, HarnessId } from "@standup/shared";
import type { CollectorClient } from "./collector-client.js";
import { parseLaunchCommand } from "./launch-command.js";

/** The project a launch targets when the command names none. */
export const DEFAULT_LAUNCH_PROJECT = "scratch";

/** The collector surface a launch needs — narrowed so a test fake needs no HTTP. */
export interface LaunchSink {
  launch: CollectorClient["launch"];
  listProjects: CollectorClient["listProjects"];
}

/** Where a launch command arrived and where its reply belongs. */
export interface LaunchContext {
  channel: string;
  /** Thread root to reply into. */
  threadTs: string;
  /** The raw message text to parse. */
  text: string;
  /** Namespaced actor (`slack:U…`) of the requester, for collector attribution. */
  actor?: string;
  /**
   * Stable inbound message id, passed to the collector as the launch's
   * idempotency key so a redelivered "launch …" (or one that outlived the
   * adapter's in-memory dedup across a restart) resolves to the SAME launch
   * instead of spawning a second worktree/session. Omit to launch un-keyed.
   */
  idempotencyKey?: string;
  /**
   * When set, the message must explicitly @-mention this bot user id to count as
   * a launch (see parseLaunchCommand). The mirror-thread reply surface passes the
   * bot id so a plain reply that happens to start with "launch" isn't hijacked
   * into a launch; the bot-directed DM / @-mention surfaces leave it unset.
   */
  requireMentionOf?: string;
}

export interface LaunchOptions {
  /** Console base URL, for the shareable session link on the reply. */
  webUrl: string;
  /** Project to launch into when the command names none (defaults to scratch). */
  defaultProjectId?: string;
  /**
   * Post a short notice back into the thread (launched / couldn't launch).
   * Injected so tests capture it without a live Slack call; omit to stay silent.
   */
  notify?: (channel: string, threadTs: string, text: string) => Promise<void>;
}

/**
 * Resolve a typed project ref to a registered project id. Pure + exported so
 * the resolution is unit-testable. An empty ref resolves to `defaultId`. A
 * present ref matches, in order: an exact id, a case-insensitive id, then a
 * case-insensitive name. A name matching more than one project is `ambiguous`
 * (the caller asks for `project=<id>` rather than guessing); no match at all
 * leaves `id` undefined.
 */
export function resolveProjectId(
  ref: string | undefined,
  projects: readonly { id: string; name: string }[],
  defaultId: string,
): { id?: string; ambiguous?: boolean } {
  const needle = ref?.trim();
  if (!needle) return { id: defaultId };
  const lc = needle.toLowerCase();

  const byExactId = projects.find((p) => p.id === needle);
  if (byExactId) return { id: byExactId.id };

  const byCiId = projects.find((p) => p.id.toLowerCase() === lc);
  if (byCiId) return { id: byCiId.id };

  const byName = projects.filter((p) => p.name.toLowerCase() === lc);
  if (byName.length === 1) return { id: byName[0]!.id };
  if (byName.length > 1) return { ambiguous: true };
  return {};
}

export class LaunchFromSlack {
  constructor(
    private readonly collector: LaunchSink,
    private readonly opts: LaunchOptions,
  ) {}

  private get defaultProjectId(): string {
    return this.opts.defaultProjectId ?? DEFAULT_LAUNCH_PROJECT;
  }

  private async say(ctx: LaunchContext, text: string): Promise<void> {
    if (!this.opts.notify) return;
    try {
      await this.opts.notify(ctx.channel, ctx.threadTs, text);
    } catch {
      /* best effort — a failed notice must not throw into the event loop */
    }
  }

  /**
   * Whether a launch command needs the direct launch rather than Persona: it
   * names a harness, model or effort, or its project runs a harness other than
   * Claude, which Persona doesn't launch into. A failed project fetch counts as
   * Claude (the collector's default harness).
   */
  async needsDirect(text: string): Promise<boolean> {
    const cmd = parseLaunchCommand(text);
    if (!cmd) return false;
    if (cmd.harness || cmd.model || cmd.effort) return true;
    const projects = (await this.collector.listProjects()) ?? [];
    const id = cmd.project ? resolveProjectId(cmd.project, projects, this.defaultProjectId).id : this.defaultProjectId;
    const project = projects.find((p) => p.id === (id ?? this.defaultProjectId));
    return !!project?.harness && project.harness !== "claude";
  }

  /**
   * Handle a message IF it's a launch command. Returns whether it was handled:
   * `true` means this was a launch command (launched, or a failure was surfaced
   * in-thread) and the caller must NOT fall through to ask/steer; `false` means
   * it wasn't a launch command and the caller keeps its current behavior.
   */
  async tryLaunch(ctx: LaunchContext): Promise<boolean> {
    const cmd = parseLaunchCommand(ctx.text, { requireMentionOf: ctx.requireMentionOf });
    if (!cmd) return false;

    let projectId = this.defaultProjectId;
    let task = cmd.task;
    if (cmd.project) {
      // A named project needs the registry to resolve by id or name. A failed
      // fetch yields no list, so an explicit ref falls back to being treated AS an
      // id and the collector rejects an unknown one with a clear error.
      const projects = (await this.collector.listProjects()) ?? [];
      const resolved = resolveProjectId(cmd.project, projects, this.defaultProjectId);
      if (resolved.ambiguous) {
        await this.say(
          ctx,
          `⚠️ "${cmd.project}" matches more than one project — launch with \`project=<id>\` to disambiguate.`,
        );
        return true;
      }
      if (resolved.id) {
        projectId = resolved.id;
      } else if (cmd.projectInferred) {
        // The trailing " in <x>" was ordinary task phrasing, not a project the
        // user meant to name — no such project exists. Launch the WHOLE phrase in
        // the default project rather than 404 on a phantom project ref.
        task = `${cmd.task} in ${cmd.project}`;
      } else {
        // An explicit project=<id> that doesn't resolve — let the collector reject
        // the unknown id with a clear error.
        projectId = cmd.project;
      }
    }

    // The command's model/effort map onto the harness the launch resolves to: a
    // Codex launch takes them as its free-form model + reasoning-effort level, any
    // other harness as the Claude alias + effort. Only the explicit `harness=`
    // flag decides here — with none, they fall to the Claude fields (the default
    // harness); a user wanting Codex knobs names `harness=codex`. All raw, so the
    // collector validates and rejects a bad value in-thread.
    const harness = cmd.harness as HarnessId | undefined;
    const isCodex = harness === "codex";
    const res = await this.collector.launch(projectId, task, {
      actor: ctx.actor,
      idempotencyKey: ctx.idempotencyKey,
      harness,
      model: isCodex ? undefined : (cmd.model as ClaudeModel | undefined),
      effort: isCodex ? undefined : (cmd.effort as ClaudeEffort | undefined),
      codexModel: isCodex ? cmd.model : undefined,
      codexEffort: isCodex ? (cmd.effort as CodexEffort | undefined) : undefined,
    });
    if (!res.ok) {
      await this.say(ctx, `⚠️ Couldn't launch in \`${projectId}\`${res.error ? `: ${res.error}` : "."}`);
      return true;
    }

    const launch = res.launch;
    // A direct launch isn't a Persona job, so no milestones follow it here;
    // the reply says where to follow it.
    const follow = "Follow it in the console, or ask Persona in a thread for work you want updates on there.";
    if (launch.sessionId) {
      const link = sessionShareUrl(this.opts.webUrl, launch.sessionId);
      await this.say(
        ctx,
        `🚀 Launched in \`${projectId}\`: <${link}|session ${shortSessionId(launch.sessionId)}>. ${follow}`,
      );
    } else {
      // The session attaches a moment after the row is created, so there's no
      // shareable id yet — name the launch and point at the console.
      await this.say(
        ctx,
        `🚀 Launched in \`${projectId}\` (launch \`${launch.id.slice(0, 8)}\`) — ${this.opts.webUrl}. ${follow}`,
      );
    }
    return true;
  }
}
