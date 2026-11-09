import { buildLaunchArgv } from "../tmux-launch.js";
import { shquote } from "../shell.js";
import { CodexEventParser } from "./codex-events.js";
import type { HarnessAdapter, HarnessLaunchSpec, StreamParser } from "./types.js";

export type CodexSandbox = "read-only" | "workspace-write" | "danger-full-access";

/**
 * The knobs that shape a `codex exec` invocation. Defaults describe a
 * full-access, non-interactive profile suitable for an unattended run inside
 * Standup's own per-launch worktree / provisioned workspace.
 */
export interface CodexProfile {
  /**
   * `-s/--sandbox` policy. Default `danger-full-access` — see
   * DEFAULT_CODEX_PROFILE for why Standup runs Codex unsandboxed. Override to
   * `workspace-write` / `read-only` for a locked-down run.
   */
  sandbox?: CodexSandbox;
  /** Approval policy, applied as a config override (see buildCodexArgv). Default `never`. */
  approvalPolicy?: string;
  /**
   * `--skip-git-repo-check`. Default TRUE — see DEFAULT_CODEX_PROFILE: a Standup
   * launch's `-C` dir is often not itself a git repo (a multi-checkout workspace root),
   * and codex refuses to run outside a trusted git repo without this. Override to
   * false for a run that must stay pinned to a git repo.
   */
  skipGitRepoCheck?: boolean;
}

export const DEFAULT_CODEX_PROFILE: Required<CodexProfile> = {
  // `danger-full-access`, NOT Codex's own `workspace-write` sandbox. The
  // isolation boundary is already Standup's per-launch worktree / provisioned
  // workspace, and the run happens in the user's own dev account — so the
  // internal sandbox buys no safety here, it only cripples the run: it blocks
  // outbound network (AWS APIs and the localhost:7777 standup MCP both become
  // unreachable, so the agent can't deploy or dogfood the KB) and scopes writes
  // to the `-C` directory (leaving sibling packages in a multi-package workspace
  // read-only). Full access lets a Standup-launched Codex session build, deploy,
  // and use the standup MCP the way a launched Claude session can. Overridable
  // via the profile for a caller that wants Codex re-sandboxed.
  sandbox: "danger-full-access",
  approvalPolicy: "never",
  // A Standup launch controls the run directory (a worktree, or a multi-checkout
  // workspace ROOT which is not itself a git repo), and codex refuses to run
  // outside a trusted git repo without this ("Not inside a trusted directory and
  // --skip-git-repo-check was not specified"). Default on for both the exec and
  // resume turns; harmless when the dir happens to be a git repo.
  skipGitRepoCheck: true,
};

/**
 * Hard cap on how many turns the multi-turn wrapper drives before giving up.
 * `codex exec` runs a SINGLE turn then exits, so an autonomous build → deploy →
 * validate needs the run resumed turn after turn; this bounds that loop so a run
 * that never signals completion can't spin forever.
 */
export const CODEX_MAX_TURNS = 20;

/**
 * The sentinel line the agent is told to print once the task is fully complete
 * AND validated. The multi-turn wrapper stops resuming the moment it appears on
 * an assistant message. Deliberately unusual so it can't collide with ordinary
 * output.
 */
export const CODEX_DONE_SENTINEL = "===STANDUP_CODEX_DONE===";

/**
 * The prompt each resume turn sends. It both keeps the agent working and tells
 * it the completion protocol: print CODEX_DONE_SENTINEL only when everything is
 * done and validated. buildCodexRunLoop watches for that sentinel to stop.
 */
export const CODEX_CONTINUE_INSTRUCTION =
  `Continue the task. Keep working until it is FULLY complete and you have ` +
  `VALIDATED it — the build, the tests, and any required deploy actually pass, ` +
  `not merely written. When, and ONLY when, everything is done and verified, ` +
  `send one final message whose ENTIRE content is exactly ${CODEX_DONE_SENTINEL} ` +
  `— that token alone, nothing before or after it, no other prose, punctuation, ` +
  `or code fence — then stop. Do NOT write that token at any other time (not even ` +
  `to describe this rule); while any work remains, just keep going.`;

/** The subset of a launch spec that shapes the CLI argv (no tmux/prompt fields). */
export interface CodexArgvSpec {
  cwd: string;
  model?: string;
  /**
   * Reasoning effort, applied as a `-c model_reasoning_effort=<level>` config
   * override (see buildCodexArgv). A per-launch value like `model`; omitted
   * leaves it to the Codex CLI's own default (no override emitted).
   */
  reasoningEffort?: string;
  extraArgs?: string[];
}

/**
 * Builds the `codex exec --json …` argv (without the prompt — the launcher
 * appends that as the final positional argument). `--json` streams the JSONL
 * event contract this package parses; `-C` sets the worktree root.
 *
 * Approval is passed as a `-c approval_policy=<policy>` config override, not
 * `-a/--ask-for-approval`: `exec` is non-interactive and rejects the top-level
 * `-a` flag ("unexpected argument '-a'"), whereas it accepts `-c key=value`
 * overrides. The default `never` keeps a headless run from pausing for an
 * approval it has no one to answer.
 *
 * Reasoning effort rides the same `-c key=value` override channel as approval
 * (`-c model_reasoning_effort=<level>`) rather than a top-level flag, and is
 * emitted only when the spec carries one — mirroring `-m`, so an unset effort
 * leaves the CLI's own default in place.
 */
export function buildCodexArgv(spec: CodexArgvSpec, profile: CodexProfile = {}): string[] {
  const p = { ...DEFAULT_CODEX_PROFILE, ...profile };
  const argv = ["codex", "exec", "--json", "-C", spec.cwd];
  if (spec.model) argv.push("-m", spec.model);
  argv.push("-s", p.sandbox);
  argv.push("-c", `approval_policy=${p.approvalPolicy}`);
  if (spec.reasoningEffort) argv.push("-c", `model_reasoning_effort=${spec.reasoningEffort}`);
  if (p.skipGitRepoCheck) argv.push("--skip-git-repo-check");
  if (spec.extraArgs?.length) argv.push(...spec.extraArgs);
  return argv;
}

/** Shell-quotes and space-joins an argv into one command-word sequence. */
function shjoin(argv: string[]): string {
  return argv.map(shquote).join(" ");
}

/**
 * The flags a `codex exec resume` turn takes AFTER the thread id. `resume` is
 * NOT `exec`: it REJECTS the exec-only `-s/--sandbox` and `-C` ("unexpected
 * argument '-s' found") and inherits its cwd from the pane — already the
 * workspace root — so neither is emitted. The sandbox policy instead rides a
 * `-c sandbox_mode=…` config override, alongside `-c approval_policy=…`; `--json`
 * and (when set) `--skip-git-repo-check` carry over from the profile. Exported so
 * the resume shape is unit-testable.
 */
export function buildCodexResumeFlags(profile: CodexProfile = {}): string[] {
  const p = { ...DEFAULT_CODEX_PROFILE, ...profile };
  const flags = ["--json"];
  if (p.skipGitRepoCheck) flags.push("--skip-git-repo-check");
  flags.push("-c", `approval_policy=${p.approvalPolicy}`);
  flags.push("-c", `sandbox_mode=${p.sandbox}`);
  return flags;
}

/**
 * Builds the multi-turn shell loop that drives a Codex run to completion.
 *
 * `codex exec` runs ONE turn then exits, so a single invocation can't
 * autonomously build → deploy → validate. This wraps the launch in a bounded
 * loop: run `codex exec --json … "<prompt>"` for the first turn (which accepts
 * the exec-only `-s`/`-C`), capture the thread id from its `thread.started`
 * event, then resume that thread (`codex exec resume <id> <resumeFlags> …`) turn
 * after turn until the agent's final message IS the completion sentinel, the turn
 * count reaches CODEX_MAX_TURNS, or the first turn fails before completing any
 * item (the provider refused the run, so a resume would fail the same way).
 * `resumeFlags` are the resume-turn flags — no `-s`/`-C`, sandbox via
 * `-c sandbox_mode=…` (see buildCodexResumeFlags).
 * Every turn's `--json` stdout is tee'd (append) to the same event log, so
 * codex-events.ts / the CodexObserver parse the whole run across turns exactly as
 * they would a single stream. The turn count is printed to the pane when the loop
 * ends.
 *
 * `promptRef` is the shell reference the launcher's temp-file machinery reads the
 * opening prompt into (`"$P"`). `execArgv` is the first-turn `codex exec …` argv.
 * `logFile` is the JSONL sidecar (omitted → the per-turn scratch file only).
 * Returned as the command run AFTER that machinery, so the whole loop still rides
 * buildLaunchArgv's prompt-file + detached-tmux wrapper.
 *
 * Completion is matched by an assistant message whose TEXT IS EXACTLY the
 * sentinel — the JSON fragment `"text":"<sentinel>"` on an `agent_message` line.
 * Matching the sentinel appearing ANYWHERE would false-positive twice: on the
 * `user_message` echo of the continue prompt (which contains the sentinel
 * verbatim) AND on the agent merely NARRATING the protocol mid-run ("I'll print
 * <sentinel> when done") — both of which would stop the loop early and leave
 * infra half-deployed. Requiring the `text` field to equal the sentinel pins it
 * to the agent actually signalling done. Each codex invocation reads its prompt
 * as an argument, so stdin is redirected from /dev/null lest `codex exec` treat a
 * live stdin as more prompt input.
 */
export function buildCodexRunLoop(
  promptRef: string,
  execArgv: string[],
  resumeFlags: string[],
  logFile: string | undefined
): string {
  const exec = shjoin(execArgv);
  // resume carries NO exec-only -s/-C; the thread id is a shell variable, so it
  // can't ride shquote (single quotes would stop it expanding) — splice it in raw
  // between the quoted `codex exec resume` head and the resume flags.
  const resume = `${shjoin([...execArgv.slice(0, 2), "resume"])} "$TID" ${shjoin(resumeFlags)}`;
  const cont = shquote(CODEX_CONTINUE_INSTRUCTION);
  const tee = logFile ? `tee -a ${shquote(logFile)} "$TURN"` : `tee -a "$TURN"`;
  // Exact-text completion: the agent_message's `text` field must EQUAL the
  // sentinel, not merely contain it (see the doc above).
  const doneFragment = shquote(`"text":"${CODEX_DONE_SENTINEL}"`);
  const done = `grep -F ${doneFragment} "$TURN" | grep -q agent_message`;
  const tid =
    `grep -oE '"thread_id"[[:space:]]*:[[:space:]]*"[^"]*"' "$TURN" ` +
    `| head -n1 | sed -E 's/.*"([^"]*)"$/\\1/'`;
  // A first turn that failed without completing a single item is the provider
  // refusing the run (an unreachable model, a denied account). Codex already
  // retried it, so resuming would only repeat the refusal turn after turn. A
  // later turn that fails is resumed as before: the run already worked, so its
  // failure is more likely transient.
  const eventType = (type: string) => `'"type"[[:space:]]*:[[:space:]]*"${type}"'`;
  const refused =
    `[ "$n" -eq 1 ] && grep -qE ${eventType("turn\\.failed")} "$TURN" && ! grep -qE ${eventType("item\\.completed")} "$TURN"`;
  return [
    `TURN="$(mktemp)"`,
    `n=1`,
    `${exec} ${promptRef} </dev/null | ${tee}`,
    `TID="$(${tid})"`,
    `while [ -n "$TID" ] && [ "$n" -lt ${CODEX_MAX_TURNS} ] && ! { ${done}; } && ! { ${refused}; }; do`,
    `  : > "$TURN"`,
    `  n=$((n + 1))`,
    `  ${resume} ${cont} </dev/null | ${tee}`,
    `done`,
    `if { ${refused}; }; then printf '[standup] codex refused the first turn before any work; not resuming\\n'; fi`,
    `rm -f "$TURN"`,
    `printf '[standup] codex ran %s turn(s)\\n' "$n"`,
  ].join("\n");
}

/**
 * The Codex harness: launches a headless `codex exec` session in a detached tmux
 * pane (reusing launcher.ts's temp-file prompt machinery) and parses its JSONL
 * event stream. Additive — Claude Code remains the default harness, unchanged.
 */
export class CodexHarnessAdapter implements HarnessAdapter {
  readonly id = "codex";

  constructor(private readonly profile: CodexProfile = {}) {}

  buildLaunchCommand(spec: HarnessLaunchSpec): string[] {
    // `-C spec.cwd` is the WORKSPACE ROOT (the launcher passes the worktree root,
    // not the launchSubdir): a multi-package workspace agent must start at and
    // write across the root, and the opening prompt already points it at the
    // package its launchSubdir names.
    const execArgv = buildCodexArgv(
      {
        cwd: spec.cwd,
        model: spec.model,
        reasoningEffort: spec.reasoningEffort,
        extraArgs: spec.extraArgs,
      },
      this.profile
    );
    // Resume turns take a DIFFERENT flag set: `codex exec resume` rejects the
    // exec-only -s/-C and gets its sandbox via `-c sandbox_mode=…` instead (see
    // buildCodexResumeFlags).
    const resumeFlags = buildCodexResumeFlags(this.profile);
    // Drive the run to completion across turns rather than one-shot: `codex exec`
    // exits after a single turn, so buildCodexRunLoop resumes the thread until the
    // agent signals done or the turn cap is hit, teeing every turn's `--json` to
    // the same sidecar (spec.eventLogPath) so the observer parses the whole run.
    // The loop owns stdin/tee, so it rides buildLaunchArgv purely for the
    // temp-file prompt + detached-tmux wrapper (harnessArgv unused → []); the tmux
    // pane cwd is the workspace root too.
    return buildLaunchArgv(spec.tmuxSession, spec.cwd, [], spec.prompt, spec.launchId, {
      buildRun: (promptRef) => buildCodexRunLoop(promptRef, execArgv, resumeFlags, spec.eventLogPath),
    });
  }

  createParser(): StreamParser {
    return new CodexEventParser();
  }
}
