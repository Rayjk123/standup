// Parse a bot-directed "launch a task" command out of a Slack message. Pure and
// unit-tested (no I/O), so the grammar is verified in isolation and the message
// router only has to fork on whether it matched.
//
// Accepted forms:
//   launch <task text> in <project>   — project is the trailing segment after the
//                                        LAST " in "; flagged `projectInferred`
//                                        because the split may just be ordinary
//                                        task phrasing, so the caller downgrades a
//                                        resolve-miss to the default project
//   launch: <task> project=<id>       — an explicit project id via project=<id>,
//                                        wherever it appears in the body
//   launch <task text>                — no project clause → the caller's default
//
// Optional `key=value` launch flags may appear anywhere in the body and are
// pulled out before the project/task split: `harness=<id>` picks the agent CLI,
// and `model=<value>` / `effort=<value>` set the model + effort/reasoning level
// for whichever harness resolves (a Claude alias for Claude, a Codex model id +
// reasoning level for Codex). All are raw as typed — the collector validates
// them — and all are optional, so an un-flagged command is unchanged.
//
// A leading bot @-mention (`<@U…>`) is tolerated so "@bot launch …" parses the
// same as a bare "launch …". Matching is case-insensitive on the `launch` verb.

export interface LaunchCommand {
  /** The task text handed to the launched agent as its opening prompt. */
  task: string;
  /**
   * Project id or name exactly AS TYPED, or undefined when the command named
   * none — the caller resolves it (by id or name) and falls back to its default.
   */
  project?: string;
  /**
   * True when `project` was INFERRED from a trailing " in <project>" clause
   * rather than typed explicitly as `project=<id>`. An inferred project is a
   * guess: " in " is extremely common in ordinary task phrasing ("fix the bug in
   * the parser"), so the caller treats a resolve-miss on an inferred project as
   * "no project named" and launches the whole phrase in its default project,
   * rather than 404-ing on a project the user never meant to name. An explicit
   * `project=<id>` that misses is a real error and is surfaced as such. Omitted
   * (undefined) for the explicit and no-project forms.
   */
  projectInferred?: boolean;
  /**
   * Which agent CLI to drive, from an explicit `harness=<id>` clause (e.g.
   * `harness=codex`). Raw as typed — the collector validates it against the
   * known harnesses and rejects an unknown one with a clear error. Undefined
   * leaves the launch to the project's own harness default.
   */
  harness?: string;
  /**
   * The model, from an explicit `model=<value>` clause. Interpreted by the
   * caller against the resolved harness — a Claude model alias for a Claude
   * launch, a free-form Codex model id for a Codex launch — so one clause covers
   * both harnesses. Raw as typed; the collector validates a Claude alias.
   */
  model?: string;
  /**
   * The effort/reasoning level, from an explicit `effort=<value>` clause.
   * Interpreted against the resolved harness like `model`: a Claude effort level
   * for Claude, a Codex reasoning-effort level for Codex. Raw as typed; the
   * collector validates it against the harness's level set.
   */
  effort?: string;
}

/**
 * A leading Slack mention token, as `app_mention` and channel-message text carry
 * it (`<@U123>` or `<@U123|label>`). The capture group is the user id, so the
 * caller can require the mention be of a SPECIFIC bot (see requireMentionOf).
 */
const LEADING_MENTION = /^<@([^>|]+)(?:\|[^>]*)?>\s*/;
/** The `launch` verb that opens the command, with an optional `:` and required gap. */
const LAUNCH_HEAD = /^launch\s*:?\s+/i;
/** An explicit `project=<id>` clause; the value may be quoted or a bare token. */
const PROJECT_EQ = /\bproject\s*=\s*("[^"]*"|'[^']*'|\S+)/i;
/** `<task> in <project>`; the greedy first group splits on the LAST " in ". */
const TASK_IN_PROJECT = /^(.*\S)\s+in\s+(\S.*)$/i;

export interface ParseLaunchOptions {
  /**
   * When set, ONLY a message explicitly directed at this bot user id parses — the
   * text has to open with a mention of it (`<@botId> launch …`). The mirror-thread
   * reply surface passes it, because there a bare "launch …" is an ordinary steer
   * or ask answer ("launch it with vitest"), not a Standup command — requiring the
   * @-mention is what stops such a reply being hijacked into spawning a session.
   * The DM and @-mention surfaces leave it unset: they are bot-directed by nature,
   * so a bare "launch …" is a command there.
   */
  requireMentionOf?: string;
}

export function parseLaunchCommand(
  raw: string | undefined | null,
  opts: ParseLaunchOptions = {},
): LaunchCommand | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const mention = LEADING_MENTION.exec(trimmed);
  // On a surface that demands explicit bot-direction, a message that doesn't open
  // with a mention of THIS bot is not a launch command — it's an ordinary reply.
  if (opts.requireMentionOf && mention?.[1] !== opts.requireMentionOf) return null;
  const text = mention ? trimmed.slice(mention[0].length) : trimmed;
  const head = LAUNCH_HEAD.exec(text);
  if (!head) return null;

  const withFlags = text.slice(head[0].length).trim();
  if (!withFlags) return null;

  // Pull the optional launch flags (harness/model/effort) out first, wherever
  // they appear, so the remaining text is just the task (+ an optional project
  // clause). Carried onto every return shape below.
  let rest = withFlags;
  let harness: string | undefined;
  let model: string | undefined;
  let effort: string | undefined;
  ({ value: harness, rest } = extractFlag(rest, "harness"));
  ({ value: model, rest } = extractFlag(rest, "model"));
  ({ value: effort, rest } = extractFlag(rest, "effort"));
  // Only carry the flags that were actually present, so an un-flagged command's
  // returned shape is exactly `{ task, ... }` (no present-but-undefined keys).
  const flags: Pick<LaunchCommand, "harness" | "model" | "effort"> = {};
  if (harness) flags.harness = harness;
  if (model) flags.model = model;
  if (effort) flags.effort = effort;

  const body = collapseWs(rest);
  if (!body) return null;

  // Form 2 — an explicit `project=<id>` wins wherever it appears. Strip that
  // clause out and the collapsed remainder is the task.
  const eq = PROJECT_EQ.exec(body);
  if (eq) {
    const project = unquote(eq[1]);
    const task = collapseWs(body.slice(0, eq.index) + body.slice(eq.index + eq[0].length));
    if (!task) return null;
    return { task, project: project || undefined, ...flags };
  }

  // Form 1 — "<task> in <project>". Greedy first group means the split lands on
  // the last " in ", so the project is the trailing segment. The project here is
  // only INFERRED — the caller downgrades it to "no project" if it fails to
  // resolve, since the split may just be ordinary task phrasing.
  const inSplit = TASK_IN_PROJECT.exec(body);
  if (inSplit) {
    const task = inSplit[1].trim();
    const project = inSplit[2].trim();
    if (task && project) return { task, project, projectInferred: true, ...flags };
  }

  // No project clause — the task is the whole body; the caller's default applies.
  return { task: body, ...flags };
}

/**
 * Pull a single `key=value` launch flag out of the text, returning its value
 * (quoted or bare, unquoted) and the text with that clause removed. Case-
 * insensitive on the key; a missing key leaves the text untouched. Mirrors the
 * `project=<id>` clause's shape so the launch flags parse the same way.
 */
function extractFlag(body: string, key: string): { value?: string; rest: string } {
  const re = new RegExp(`\\b${key}\\s*=\\s*("[^"]*"|'[^']*'|\\S+)`, "i");
  const m = re.exec(body);
  if (!m) return { rest: body };
  const value = unquote(m[1]);
  const rest = body.slice(0, m.index) + body.slice(m.index + m[0].length);
  return { value: value || undefined, rest };
}

/** Unwrap a single- or double-quoted token; a bare token is returned as-is. */
function unquote(s: string): string {
  const m = /^"([^]*)"$|^'([^]*)'$/.exec(s);
  return (m ? (m[1] ?? m[2] ?? "") : s).trim();
}

/** Collapse internal whitespace runs to single spaces and trim the ends. */
function collapseWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}
