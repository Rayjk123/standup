import { homedir, tmpdir } from "os";
import { isAbsolute, join, normalize } from "path";
import { existsSync, readFileSync, writeFileSync, renameSync, realpathSync, unlinkSync } from "fs";
import { mkdir } from "fs/promises";
import { randomUUID } from "crypto";
import type { Database } from "bun:sqlite";
import type {
  ClaudeEffort,
  ClaudeModel,
  CodexEffort,
  CodexModel,
  HarnessId,
  Launch,
  LaunchKind,
  LaunchPhase,
  LaunchPipelineMode,
  OrchestrationProfile,
  PipelineDefinition,
  PipelineDisabledReason,
  PipelineOverride,
  PipelineRun,
  Project,
  SessionEndReason,
  UserPrefs,
} from "@standup/shared";
import { capTitle, parseLaunchPipelineMode } from "@standup/shared";
import { captureProvisionSnapshot, formatPipelineInstruction, projectReviewGate, startPipelineForLaunch } from "./pipeline/engine.js";
import { codeReviewNotApplicable } from "./pipeline/runners.js";
import { defaultGitRunner } from "./review/stage.js";
import { isGitWorkTree, recordedBaseBranch, resolveBaseBranch } from "./base-branch.js";
import { codexConfigPath, standupMcpRegisteredForCodex } from "./codex-standup-mcp.js";
import { standupDataDir } from "@standup/shared/owner-token";
import {
  clearLaunchReaped,
  clearLaunchReviewTokenHash,
  getProjects,
  getProject,
  createLaunch,
  getLaunch,
  getLaunchBySession,
  updateLaunchStatus,
  setLaunchPhase,
  appendLaunchLog,
  getSetting,
  createTaskRun,
  updateTaskRunStatus,
  getTaskRun,
  getActiveTaskRunByWorktree,
  countActiveTaskRuns,
  getEffectiveUserPrefs,
  createPlanApproval,
  getActiveWork,
  resolveActiveProfile,
  BUDGET_DROP_REASON,
  setLaunchHookTokenHash,
  setLaunchWorkerTokenHash,
  personaJobForLaunch,
  findLaunchByCwd,
  type ActiveWorkItem,
  type RetrievalRecord,
} from "@standup/store";
import {
  KnowledgeStore,
  searchKnowledge,
  isConfident,
  describeInjectionPlan,
  forbiddenActions,
  foreignIntentAdmissible,
  fuseInjectionResults,
  injectionPlanGate,
  layerOf,
  mergeActivityHits,
  planInjection,
  type InjectionPlan,
  type DraftDispute,
  type SearchResult,
  type SourceKind,
  type ScopeAudience,
  type Layer,
  type EmbeddingProvider,
  type EmbeddingConfig,
} from "@standup/knowledge";
import { isMultiplayerMode } from "./multiplayer.js";
import { hostUserAlias } from "./host-user.js";
import { launchQueue, queuedLaunchNote, type LaunchQueue } from "./host-headroom.js";
import {
  gatedRecords,
  hitRecordFields,
  placementsFor,
  recordKnowledgeRetrievals,
  type DocPlacement,
  type GatedCandidate,
  type RetrievalDropReason,
} from "./retrieval-telemetry.js";
import { buildInteractiveLaunchArgv, sessionAlive, sessionTmux, workerTmux } from "./tmux-launch.js";
import { issueReviewToken, removeReviewToken, reviewTokenEnv } from "./review/token-file.js";
import { ensurePrivateDir, paneDeliveryDir, writePrivateFileSync } from "./internal-cwd.js";
import { CodexHarnessAdapter } from "./harness/codex.js";
import { inferMainProject, type InferMainProjectInput } from "./project-inference.js";
import { demoteStale, freshnessGate } from "./knowledge-freshness.js";
import { injectionGateReason, injectionStaleSince } from "./knowledge-injection-gate.js";
import { landedClaimFor, landedClaimMarker } from "./knowledge-repo-claims.js";
import { findNamedDocs, MAX_NAMED_PINS, type InjectedDoc } from "./knowledge-named-pins.js";
import { rewriteInjectionQueries } from "./knowledge-query-rewrite.js";
import { launchKnowledgePush } from "./knowledge-push.js";
import { MIRROR_PROJECTS, relatedProjects } from "./projects-registry.js";
import { HOOK_TOKEN_ENV, buildFloorHookSettings, newHookToken, workerTokenHash, type FloorConfig } from "./floor/gate.js";
import { WORKTREE_ROOT_SETTING, buildLaunchFloorConfig, floorUnavailableReason, foreignLaunchPaths, jobLaunchPaths, launchScratchId } from "./floor/launch.js";
import { ensureEmptyHooksDir, isolateWorktreeHooks, workerHooksDir } from "./floor/worktree-hooks.js";
import { workerEnv } from "./worker-env.js";
import { onLaunchCleaned } from "./job-hygiene.js";
import { holdForCleanup, resumeSettled } from "./launch-holds.js";
import { describeWorkerTunnels, reapWorkerTunnels } from "./worker-tunnels.js";
import { createProcessSystem, describeTerminated, type ProcessSystem } from "./process-registry.js";
import { resolveInstallDir } from "./restart/state.js";

/** Built-in fallback when nothing else specifies where worktrees go. */
const DEFAULT_WORKTREE_ROOT = join(
  homedir(),
  ".local",
  "share",
  "standup",
  "worktrees"
);

/** Global-setting key mirrored by GET/PUT /api/settings. */
export { WORKTREE_ROOT_SETTING };

/** Expands a leading `~` — unlike a shell, `join`/`mkdir` don't. */
function expandTilde(p: string): string {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}

/**
 * Where a launch's worktree is created, most specific wins:
 *   1. the project's own `worktreeRoot`
 *   2. the global `worktree_root` setting (set from the UI)
 *   3. the STANDUP_WORKTREE_ROOT env var (the original, pre-setting knob)
 *   4. the built-in default under ~/.local/share
 *
 * Exported so the resolution is testable without spawning a real launch.
 */
export function resolveWorktreeRoot(db: Database, project: Project): string {
  const chosen =
    project.worktreeRoot?.trim() ||
    getSetting(db, WORKTREE_ROOT_SETTING)?.trim() ||
    process.env.STANDUP_WORKTREE_ROOT ||
    DEFAULT_WORKTREE_ROOT;
  return expandTilde(chosen);
}

/**
 * Per-step cap so a wedged setup command can't hang the launch forever.
 * Overridable with STANDUP_STEP_TIMEOUT_MS (milliseconds). A value that isn't a
 * plain positive integer a timer can hold ("5m", "1e6", past 2^31-1) keeps the
 * default rather than timing every step out at once.
 */
export function stepTimeoutMs(env: Record<string, string | undefined>): number {
  const raw = env.STANDUP_STEP_TIMEOUT_MS?.trim() ?? "";
  const configured = /^\d+$/.test(raw) ? Number(raw) : 0;
  return configured > 0 && configured <= 2 ** 31 - 1 ? configured : 5 * 60 * 1000;
}

const STEP_TIMEOUT_MS = stepTimeoutMs(process.env);

/**
 * Global concurrency cap on in-flight task runs (queued/running). A safety
 * valve so a runaway dispatcher (or a stuck board) can't spawn unbounded
 * `claude` processes. Overridable for beefier machines.
 */
export const MAX_ACTIVE_TASK_RUNS = process.env.STANDUP_MAX_ACTIVE_TASK_RUNS
  ? parseInt(process.env.STANDUP_MAX_ACTIVE_TASK_RUNS)
  : 16;

/**
 * Provisioning gets its own, much longer cap: creating a multi-repo workspace
 * and pulling its dependencies (or any real workspace materialization)
 * routinely runs many minutes, well past a setup command. Overridable for slower machines.
 */
const PROVISION_TIMEOUT_MS = process.env.STANDUP_PROVISION_TIMEOUT_MS
  ? parseInt(process.env.STANDUP_PROVISION_TIMEOUT_MS)
  : 30 * 60 * 1000;

/**
 * Appended to a launched agent's opening prompt.
 *
 * Self-reported checkpoints are what make the merged feed readable, but they
 * need a line of instruction: an agent with the tool available and no
 * instruction never calls it, and sessions run for hours producing zero
 * checkpoints.
 *
 * A launched session's prompt is ours to compose, so the instruction goes
 * here rather than depending on the user having set up a CLAUDE.md. For
 * monitored sessions there is no equivalent hook — see
 * docs/agent-instructions.md for the snippet to add manually.
 *
 * Deliberately brief and permissive: a heavy directive would distort the
 * work, and an agent that ignores it still functions, just less visibly.
 */
const CHECKPOINT_INSTRUCTION = `

---
You're running under Standup, a console that shows your progress alongside other agents.
Call the \`checkpoint\` tool when you finish a discrete piece of work (not per tool call) —
a short status line in your own words. Use \`ask_human\` if you need a decision rather than
guessing. Both are optional; they only affect visibility, not correctness.`;

/**
 * Appended to a Claude launch's opening prompt. The safety floor can't read code
 * fed to an interpreter through stdin or an in-place rewrite, so it holds those
 * calls as unclassified and Persona denies them — each attempt costs a wasted
 * round-trip. Naming the tools that do pass keeps workers off that path. Claude
 * only: the Edit/Write tool names don't exist under other harnesses.
 */
const EDIT_TOOLS_INSTRUCTION = `
Edit files only with the Edit/Write tools. Never edit via python/node heredocs or inline
scripts, \`sed -i\`, \`perl -pi\`, or shell redirection over an existing file — the safety
floor holds those and they will be denied.`;

/**
 * Appended to a Claude launch's opening prompt after EDIT_TOOLS_INSTRUCTION.
 * The pane's TMPDIR is the launch's disk-backed scratch dir (paneEnv), which
 * is removed with the job; a hard-coded /tmp is often tmpfs and outlives it.
 * The scratch dir lies under the home dir, so the safety floor credits an
 * isolated test env only under /tmp.
 */
const SCRATCH_INSTRUCTION = `
Put scratch files under \`$TMPDIR\` (your launch's scratch dir, deleted when the job closes), never a
hard-coded /tmp. Isolated test envs are the exception: put HOME, XDG_*, DB_PATH and the rest, plus
TMPDIR/TMP/TEMP, under a \`mktemp -d -p /tmp\` root — the floor only credits isolation under /tmp.
Register long-lived servers/tunnels you start with \`register_process\`. Name a tunnel you open by
hand with your launch's prefix — \`sw-<id8>-<name>\` as the tunnel's name (\`list_processes\` shows
the prefix; <name> in lowercase letters, digits and hyphens) — so it is stopped when your job closes even if
it was never registered.`;

/**
 * Appended to a gated launch's opening prompt when the plan-approval gate is on
 * (Project.planGate, or a per-launch override — see resolvePlanGate). It steers
 * the agent to submit a plan and wait BEFORE doing any work, mirroring Devin
 * Interactive Planning / Jules plan approval.
 *
 * The gate's teeth are collector-side (submit_plan blocks until a human
 * approves; mark_ready_for_review is refused until the approved acceptance
 * criterion passes), so this instruction only tells the agent the sequence it
 * must follow — an agent that ignores it still hits those refusals. Names the
 * exact tool so the directive resolves to a real, reachable tool.
 */
const PLAN_FIRST_INSTRUCTION = `

---
This launch is PLAN-GATED. Before you write any code or make any change:
1. Survey the task and call \`submit_plan\` with the relevant files, a short PLAN
   of what you intend to do, and a machine-checkable ACCEPTANCE CRITERION — a
   shell command (run in this worktree) that exits 0 only when the work is done
   (e.g. \`bun test\`, \`npm run build\`). That call BLOCKS until a human approves
   or edits your plan; do not start implementing until it returns approved.
2. Implement against the approved plan. The human may have edited the plan or the
   acceptance criterion — follow the version \`submit_plan\` returns.
3. You may NOT call \`mark_ready_for_review\` until the approved acceptance
   criterion passes; the console verifies it before letting the ticket advance.`;

/**
 * Preamble prepended to the orchestration steering when a launch resolves to an
 * orchestration profile (see resolveActiveProfile). Peer of
 * PLAN_FIRST_INSTRUCTION; the profile's ordered steps are rendered after it by
 * formatOrchestrationInstruction.
 *
 * It names the loop the agent must run and states the contract plainly: the
 * steps are a develop -> deploy -> adversarial-review loop that keeps the work
 * honest and on-track, and the agent may not mark the work ready for review or
 * treat it as complete until the gates pass. Like the plan-first steering, the
 * teeth are collector-side — the completion choke refuses the transition until
 * the gates pass — so this only tells the agent the sequence it must follow; an
 * agent that ignores it still hits that refusal.
 */
const ORCHESTRATION_STEERING = `

---
This launch runs under an ORCHESTRATION PROFILE. Treat its steps as a loop you
must complete — develop, then deploy, then adversarially review your own change,
and loop back on any failure — to keep your work honest and on-track. You may NOT
mark the work ready for review, or consider it complete, until every step below
passes; the console enforces this at the completion choke and refuses to advance
the ticket otherwise.`;

/**
 * The MCP tools the knowledge-first steering tells the agent to call: the two
 * read tools first, then the one write tool. The single source of truth for
 * those names — KNOWLEDGE_FIRST_INSTRUCTION is built from it — so the steering's
 * wording can never drift into naming a tool the agent can't actually call.
 *
 * The steering is only useful if these names resolve to real, reachable tools in
 * a launched session. They are guarded on two fronts by
 * knowledge-first-steering.test.ts: each name must be a tool the standup MCP
 * server actually registers (`@standup/mcp` `tools.ts`), and `propose_knowledge`
 * must stay callable from an ORDINARY launch, not just a bootstrap run (its
 * `/api/knowledge/propose` gate accepts any running launch). Reachability of the
 * server itself is the install contract: `scripts/setup-hooks.ts` registers the
 * `standup` server in `~/.claude.json`, which every launched session inherits
 * (the launcher deliberately passes none of the MCP-isolation flags, so
 * ordinary launches keep the user's full tool set + hooks).
 * The one way that contract breaks — a project whose own `launchArgs` pass
 * `--strict-mcp-config` and so drop the ambient server — is guarded at runtime:
 * buildOpeningPrompt calls launchArgsDropStandupMcp and omits the steering for
 * such a launch instead of naming three tools it can't reach.
 */
export const KNOWLEDGE_FIRST_TOOLS = [
  "search_knowledge",
  "get_knowledge_doc",
  "propose_knowledge",
] as const;

/**
 * The read-only standup MCP tools ALWAYS pre-allowed for a launched Claude
 * session, as their fully-qualified `mcp__standup__<tool>` names (how Claude Code
 * exposes an MCP server's tools). These are simple reads — a knowledge-base
 * search, a doc fetch, a graph pivot, the docs about one file — that should never stop an
 * unattended run on a permission prompt, so buildClaudeLaunchArgv folds them into
 * `--allowedTools` on every launch regardless of permission mode.
 *
 * Reads ONLY: the write/action tools (`propose_knowledge`,
 * `propose_standup_improvement`) are deliberately absent, so they stay gated — an
 * agent still needs approval to mutate the knowledge base or launch a Standup fix
 * session.
 */
export const ALWAYS_ALLOWED_STANDUP_TOOLS = [
  "mcp__standup__search_knowledge",
  "mcp__standup__get_knowledge_doc",
  "mcp__standup__graph_neighbors",
  "mcp__standup__knowledge_for_file",
] as const;

/**
 * Appended to the opening prompt of every launch whose harness reaches the
 * standup MCP server (harnessReachesStandupMcp).
 *
 * Standup's knowledge graph only pays off if agents actually read it before
 * building and feed it after — but an agent with the tools available and no
 * instruction simply never reaches for them, the same gap CHECKPOINT_INSTRUCTION
 * fills for the feed. So the standing directive to consult the shared knowledge
 * base first (and contribute back) lives here, in the prompt Standup composes,
 * rather than depending on a per-project CLAUDE.md.
 *
 * Deliberately brief: name the two read tools, the one write tool, and when to
 * skip, without prescribing how to do the work.
 */
const [KF_SEARCH, KF_GET, KF_PROPOSE] = KNOWLEDGE_FIRST_TOOLS;
const KNOWLEDGE_FIRST_INSTRUCTION = `

---
This project keeps a shared knowledge base of prior decisions, design context, and file
pointers. BEFORE you start implementing, consult it: call \`${KF_SEARCH}\` with
natural-language questions about what you're about to build, open the best hits with
\`${KF_GET}\`, and ground your work in what you find. AFTER
you learn something durable about how the system works, contribute it back with
\`${KF_PROPOSE}\`. If your task carries product or spec context — a linked ticket, a design
doc, or requirements you were handed — capture that too with \`${KF_PROPOSE}\`, setting its
\`source_kind\` to \`product\` or \`spec\` so the next implementer gets it injected as product
context. When you delegate to a subagent, put the relevant knowledge hits (slugs and key
facts) in its prompt and ask it to report durable findings back to you. Skip only for a
trivial task.`;

/** The most parent-launch docs a subagent's SubagentStart context lists. */
const SUBAGENT_CONTEXT_DOC_LIMIT = 6;
/** Per-title cap that keeps six listed docs inside the subagent context budget. */
const SUBAGENT_CONTEXT_TITLE_MAX = 64;
/** Per-doc-line cap, so six lines and the steering stay within the subagent context budget whatever the slugs. */
const SUBAGENT_CONTEXT_LINE_MAX = 128;

/** `text` cut to at most `max` characters, ending in an ellipsis when cut. */
function clipChars(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** A doc injected into the parent launch's opening prompt, as listed to a subagent. */
export interface SubagentContextDoc {
  docProject: string;
  docSlug: string;
  title?: string;
}

/**
 * The SubagentStart `additionalContext` for a subagent of a launched session.
 * A subagent sees neither its parent's opening prompt nor the knowledge-first
 * steering in it, so this restates the steering in subagent terms (search
 * first, open the most relevant doc in full with get_knowledge_doc; hand
 * durable findings back to the parent, which holds the propose_knowledge
 * decision) and lists the docs the parent was injected with, as
 * `project/slug — title`, the two values get_knowledge_doc fetches by. The steering line is always present — a launch
 * with no injected docs still gets it. Stays within 1200 chars: at most six
 * docs, each line capped (a long project/slug is clipped, and its title
 * shortened or dropped).
 */
export function buildSubagentKnowledgeContext(docs: SubagentContextDoc[]): string {
  const lines = [
    `This project has a shared Standup knowledge base of prior decisions, design context, and ` +
      `file pointers: call ${KF_SEARCH} (mcp__standup__${KF_SEARCH}) before implementing, open the ` +
      `most relevant with ${KF_GET} (pass its slug and project), and include any durable ` +
      `non-obvious finding in your final report to the parent so it can ${KF_PROPOSE}.`,
  ];
  const listed = docs.slice(0, SUBAGENT_CONTEXT_DOC_LIMIT);
  if (listed.length > 0) {
    lines.push("Knowledge docs injected into your parent session's launch:");
    for (const doc of listed) {
      const ref = clipChars(`${doc.docProject}/${doc.docSlug}`, SUBAGENT_CONTEXT_LINE_MAX - 2);
      const title = doc.title?.trim().replace(/\s+/g, " ");
      // The title gets what the line has left after "- ", the ref and " — ".
      const titleRoom = Math.min(SUBAGENT_CONTEXT_TITLE_MAX, SUBAGENT_CONTEXT_LINE_MAX - 5 - ref.length);
      const shown = title && titleRoom >= 8 ? clipChars(title, titleRoom) : "";
      lines.push(`- ${ref}${shown ? ` — ${shown}` : ""}`);
    }
  }
  return lines.join("\n");
}

/**
 * The launching user's profile rendered as instruction text — "a CLAUDE.md for
 * each user", injected so the agent behaves per that user's prefs even on a
 * shared collector. Their freeform `personalInstructions` is the catch-all;
 * `reviewRigor` and `deployTarget` are the structured commons, rendered as
 * plain directives. The deploy target is CONTEXT only — account/role/command —
 * never credentials; the agent authenticates with its own ambient creds.
 *
 * Returns "" when the user has no profile or every field is blank, so the
 * opening prompt is left exactly as it was for a user who never set one up.
 * Pure so it is unit-testable without a live launch.
 */
export function formatUserPrefsInstruction(prefs: UserPrefs | null | undefined): string {
  if (!prefs) return "";
  const parts: string[] = [];

  const instructions = prefs.personalInstructions?.trim();
  if (instructions) parts.push(instructions);

  const rigor = prefs.reviewRigor?.trim();
  if (rigor) parts.push(`Review rigor: ${rigor}`);

  const target = prefs.deployTarget;
  if (target) {
    const bits: string[] = [];
    if (target.account?.trim()) bits.push(`account ${target.account.trim()}`);
    if (target.role?.trim()) bits.push(`role ${target.role.trim()}`);
    if (target.command?.trim()) bits.push(`command \`${target.command.trim()}\``);
    if (bits.length) {
      parts.push(
        `Deploy target (reference only — do NOT deploy unless explicitly asked, ` +
          `and confirm the target before you do): ${bits.join(", ")}. Authenticate ` +
          `with your own ambient credentials — none are stored here.`
      );
    }
  }

  if (parts.length === 0) return "";
  return (
    `\n\n---\nPersonalization for ${prefs.alias} (the user who launched this session):\n\n` +
    parts.join("\n\n")
  );
}

/**
 * A resolved orchestration profile rendered as steering text — the
 * ORCHESTRATION_STEERING preamble (the loop + completion-choke contract) followed
 * by the profile's ordered steps in plain imperative language. Peer of
 * formatUserPrefsInstruction; the `deploy` step reuses that renderer's
 * account/role/command style (see DeployTarget rendering above).
 *
 * Each step kind renders to its own directive: `gate` names the shell command
 * that must exit 0; `deploy` names the account/role and/or command; `review`
 * describes the bounded adversarial-review loop (rounds + severity, defaulting to
 * the profile's own maxReviewRounds/blockOnSeverity); `human_pause` tells the
 * agent to stop and wait. Pure so it is unit-testable without a live launch.
 */
export function formatOrchestrationInstruction(profile: OrchestrationProfile): string {
  const steps = profile.steps.map((step, i) => {
    const n = i + 1;
    switch (step.kind) {
      case "gate":
        return `${n}. ${step.name}: run \`${step.command}\`; it must exit 0.`;
      case "deploy": {
        const target = step.target;
        const dest: string[] = [];
        if (target?.account?.trim()) dest.push(`account ${target.account.trim()}`);
        if (target?.role?.trim()) dest.push(`role ${target.role.trim()}`);
        const command = step.command?.trim() || target?.command?.trim();
        if (dest.length && command)
          return `${n}. Deploy to ${dest.join("/")} — run \`${command}\`; it must exit 0.`;
        if (command) return `${n}. Deploy: run \`${command}\`; it must exit 0.`;
        if (dest.length) return `${n}. Deploy to ${dest.join("/")}; it must exit 0.`;
        return `${n}. Deploy your change; it must exit 0.`;
      }
      case "review": {
        const rounds = step.rounds ?? profile.maxReviewRounds ?? 3;
        const severity = step.blockOnSeverity ?? profile.blockOnSeverity ?? "medium";
        const fix =
          severity === "high"
            ? "fix every high finding"
            : "fix every high and medium finding";
        const lens = step.lens?.trim() ? ` (lens: ${step.lens.trim()})` : "";
        return (
          `${n}. Run an adversarial review of your diff${lens} (up to ${rounds} ` +
          `round${rounds === 1 ? "" : "s"}); ${fix}, then re-review until clean.`
        );
      }
      case "human_pause":
        return `${n}. Stop and wait for human approval: ${step.prompt}`;
    }
  });
  const body = steps.length
    ? `\n\nActive profile "${profile.name}" — complete these steps in order:\n${steps.join("\n")}`
    : `\n\nActive profile "${profile.name}".`;
  return ORCHESTRATION_STEERING + body;
}

/**
 * The `source_kind`s that count as PRODUCT/spec knowledge for launch-time
 * injection (roadmap r8) — as opposed to code-derived (`code`) or the
 * operational kinds (`decision`/`runbook`). These are the docs that carry
 * product intent a coding agent should have in front of it while implementing,
 * so only these are pulled into the product-context block; code knowledge stays
 * the agent's own job to fetch via the knowledge-first tools.
 */
export const PRODUCT_KNOWLEDGE_KINDS: readonly SourceKind[] = ["product", "spec"];

/**
 * The `source_kind`s that count as CODE knowledge for launch-time injection
 * (roadmap r8): the code-derived / operational docs a coding agent wants in
 * front of it for the touched area — `code` (how the code works), plus
 * `decision` and `runbook` (the operational rationale around it). Injecting
 * them realizes the "code-first" half of the item — a push of the touched-area
 * code knowledge, not just the pull the knowledge-first steering already
 * prompts. Two kinds are deliberately in neither injected family and reach an
 * agent only through search_knowledge: `unclassified` (a doc that
 * asserts no kind is not evidence of how the code works) and `native-memory`
 * (CLAUDE.md / rules mirrors the agent already loads natively, and auto-memory
 * session notes).
 */
export const CODE_KNOWLEDGE_KINDS: readonly SourceKind[] = ["code", "decision", "runbook"];

/**
 * Layers launch injection never draws from: the personal layer (the owner's
 * profile reaches workers through Claude Code's native CLAUDE.md load, never
 * through a shared block) and the activity layer (session notes describe a
 * moment, not the code).
 */
export const INJECTION_EXCLUDED_LAYERS: readonly Layer[] = ["personal", "activity"];

/**
 * The code block's activity pass: each injection query also searches the
 * native-memory activity notes (the personal layer still excluded), at most
 * ACTIVITY_PASS_LIMIT per query; only a recent, relevant note is admitted
 * (activityAdmissible).
 */
export const ACTIVITY_SOURCE_KINDS: readonly SourceKind[] = ["native-memory"];
export const ACTIVITY_PASS_EXCLUDED_LAYERS: readonly Layer[] = ["personal"];
export const ACTIVITY_PASS_LIMIT = 4;

/**
 * How many docs of each family (product/spec, code) to inject, and the total
 * character budget for each rendered block. Bounded on BOTH axes (top-K and
 * size) so a large corpus can't blow up the opening prompt: the K most relevant
 * docs, truncated to fit the budget. Env-tunable — the right amount of context
 * trades grounding against prompt cost, a number to measure rather than assert.
 */
export const MAX_PRODUCT_DOCS = (() => {
  const parsed = Number(process.env.STANDUP_PRODUCT_INJECT_MAX_DOCS);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 3;
})();
export const PRODUCT_INJECT_CHAR_BUDGET = (() => {
  const parsed = Number(process.env.STANDUP_PRODUCT_INJECT_CHAR_BUDGET);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 4000;
})();
export const MAX_CODE_DOCS = (() => {
  const parsed = Number(process.env.STANDUP_CODE_INJECT_MAX_DOCS);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 3;
})();
export const CODE_INJECT_CHAR_BUDGET = (() => {
  const parsed = Number(process.env.STANDUP_CODE_INJECT_CHAR_BUDGET);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 4000;
})();

/** The longest dispute claim quoted in an injected disputed doc's marker. */
export const MAX_QUOTED_DISPUTE_CLAIM = 120;

/** The marker every injected disputed doc carries in its heading. */
export const DISPUTED_INJECTION_MARKER = "(disputed — verify against the code before relying on it)";

/**
 * The claim a re-verification refuted, for quoting in a disputed doc's marker:
 * the first fact-check dispute (not a no-checkout note) whose claim fits
 * MAX_QUOTED_DISPUTE_CLAIM, else undefined.
 */
export function quotableDisputeClaim(disputes: readonly DraftDispute[] | undefined): string | undefined {
  for (const d of disputes ?? []) {
    if (d.origin === "repo") continue;
    const claim = typeof d.claim === "string" ? d.claim.replace(/\s+/g, " ").trim() : "";
    if (claim && claim.length <= MAX_QUOTED_DISPUTE_CLAIM) return claim;
  }
  return undefined;
}

/** A disputed hit's quotable claim from its stored disputes; undefined when the lookup fails. */
function disputeClaimOf(store: KnowledgeStore, hit: SearchResult): string | undefined {
  try {
    return quotableDisputeClaim(store.getDoc(hit.projectId, hit.slug)?.disputes);
  } catch {
    return undefined;
  }
}

/**
 * The text product/spec retrieval runs against for a launch (roadmap r8). When
 * a ticket fires the launch its title+body is passed as `contextQuery` — the
 * LINKED ticket's own context — so retrieval targets that rather than the task
 * string, which carries dispatch boilerplate ("Implement this fix."). Absent (a
 * plain launch), the task IS the query. Trimmed-empty context falls back to the
 * task so a blank/whitespace override never yields an empty query.
 */
export function resolveRetrievalQuery(task: string, contextQuery?: string): string {
  return contextQuery?.trim() || task;
}

/**
 * The docs a launch's task names by slug, split by the block each is pinned
 * into: product/spec docs into the product block, every other kind
 * (unclassified included) into the code block. `ids` holds every pinned doc
 * so neither ranked pass injects one a second time.
 */
export interface NamedPins {
  code: InjectedDoc[];
  product: InjectedDoc[];
  ids: ReadonlySet<string>;
}

/**
 * Resolves the docs `text` names (findNamedDocs) within the injection audience
 * — the launch's scope gate narrowed by INJECTION_EXCLUDED_LAYERS — and splits
 * them into their blocks. At most MAX_NAMED_PINS across both blocks.
 *
 * The gate also excludes foreign intent (ScopeAudience.excludeForeignIntent):
 * a product/spec pin is homed in the launching project, a related project or
 * the global corpus, never another project's scope=global product doc, the
 * same reach the ranked product pass has. Code pins are not intent docs, so
 * this leaves them alone.
 */
export function resolveNamedPins(db: Database, text: string, audience: ScopeAudience): NamedPins {
  const docs = findNamedDocs(
    db,
    text,
    { ...audience, excludeLayers: INJECTION_EXCLUDED_LAYERS, excludeForeignIntent: true },
    MAX_NAMED_PINS
  );
  return {
    code: docs.filter((d) => !PRODUCT_KNOWLEDGE_KINDS.includes(d.sourceKind)),
    product: docs.filter((d) => PRODUCT_KNOWLEDGE_KINDS.includes(d.sourceKind)),
    ids: new Set(docs.map((d) => d.id)),
  };
}

/**
 * Shared retrieval for launch-time injection: the top `maxDocs` docs of the
 * given `kinds` for the task, gated by the auto-injection boundary
 * (trust, verdict, freshness, relevance floor). The kind restriction is pushed into the SQL (see
 * SearchOptions.sourceKinds), so each family draws its candidates from its OWN
 * pool — a minority family (product/spec in a code-first corpus) is retrieved
 * from its own rows rather than post-filtered out of a mixed top-N a majority
 * family fills. A JS re-filter on kind stays as a defensive backstop.
 *
 * Every block searches corpus "all": the audience gate admits the launching
 * project's docs, its related projects' and the scope=global ones, and a local
 * hit takes the search's small own-project preference. `excludeForeignIntent`
 * (the product block) narrows that to intent homed in the launching project, a
 * related project or the global corpus — product intent from an unrelated
 * project never steers this one. The personal and activity layers are excluded
 * (INJECTION_EXCLUDED_LAYERS), and a launch with no resolved audience is gated
 * against the launching project with no user. With `activity`, each query also
 * searches the activity layer's notes (mergeActivityHits), admitted only when
 * relevant and recent (activityAdmissible).
 *
 * The plan's queries (InjectionPlan, from the brief) are searched one by one
 * and their results fused by reciprocal rank (fuseInjectionResults); the gates
 * then run over the fused list, each doc read at the relevance of the query it
 * answers best. A runbook about an action the brief forbids is dropped
 * (injectionPlanGate).
 *
 * `pinned` are the docs of this family the task names (resolveNamedPins). They
 * lead the list ahead of the ranked hits and count toward `maxDocs`; they have
 * already passed the scope gate and skip the kind, relevance and coherence
 * gates here, though a stale one is still titled with its date. A ranked hit
 * that is any pinned doc (`pinnedIds`, both families) is dropped, so no doc is
 * injected or reported twice.
 *
 * Never throws — retrieval is a best-effort enrichment of the prompt, so a
 * failure (or a slow/hung embedding endpoint, now bounded by the embedding
 * request timeout) resolves to the pinned docs alone and the launch proceeds
 * rather than failing or stalling.
 */
async function retrieveKnowledgeOfKinds(
  db: Database,
  projectId: string,
  plan: InjectionPlan,
  kinds: readonly SourceKind[],
  maxDocs: number,
  embeddingProvider: EmbeddingProvider | null,
  embeddingConfig: EmbeddingConfig,
  reach: { excludeForeignIntent: boolean; activity: boolean },
  audience?: ScopeAudience,
  gated?: GatedCandidate<SearchResult>[],
  pinned: readonly InjectedDoc[] = [],
  pinnedIds: ReadonlySet<string> = new Set()
): Promise<InjectedDoc[]> {
  const head = pinned.slice(0, maxDocs);
  try {
    // Over-fetch a wider candidate window than we inject, then take the top-K
    // after the injection gate; the kind filter is already applied in SQL, and
    // so is the scope gate (the launching user + project, narrowed by the
    // excluded layers) — the same gate the agent-view endpoint reuses.
    const base: ScopeAudience = {
      ...(audience ?? { projectId }),
      ...(reach.excludeForeignIntent ? { excludeForeignIntent: true } : {}),
    };
    const search = (query: string, sourceKinds: readonly SourceKind[], excludeLayers: readonly Layer[], limit: number) =>
      searchKnowledge(
        db,
        projectId,
        query,
        embeddingProvider,
        {
          corpus: "all",
          limit,
          sourceKinds,
          audience: { ...base, excludeLayers },
          confidentFor: "inject",
          mirrorProjects: MIRROR_PROJECTS,
        },
        embeddingConfig
      );
    const perQuery: SearchResult[][] = [];
    for (const query of plan.queries) {
      const hits = await search(query, kinds, INJECTION_EXCLUDED_LAYERS, Math.max(maxDocs * 4, 12));
      const activity = reach.activity
        ? await search(query, ACTIVITY_SOURCE_KINDS, ACTIVITY_PASS_EXCLUDED_LAYERS, ACTIVITY_PASS_LIMIT)
        : [];
      perQuery.push(mergeActivityHits(hits, activity));
    }
    const results = fuseInjectionResults(perQuery);
    // Freshness gate (shared with search_knowledge), resolved
    // once for this launch.
    // A doc that went stale with nothing to re-verify it stays in the
    // candidates, ranked after fresher docs of its own project (demoteStale)
    // and titled with the date it went stale.
    const freshness = freshnessGate(db);
    // A disputed doc is exempt from the freshness gate and stale dating
    // (injectionGateReason, injectionStaleSince).
    const staleSince = (r: SearchResult) => injectionStaleSince(r, freshness);
    const store = new KnowledgeStore(db);
    const now = new Date();
    const tagsOf = (r: SearchResult) => store.getDoc(r.projectId, r.slug)?.tags;
    // Each gate's rejection is reported to `gated` (when the caller collects
    // them) with the gate that made it; the admitted set is unchanged.
    const gateReason = (r: SearchResult): RetrievalDropReason | null => {
      // Relevance floor (applied in the search too, before its limit): a doc
      // that is merely the best of a weak batch is not injected. Shared with
      // search_knowledge. A product/spec doc homed outside this project
      // clears a higher bar (foreignIntentAdmissible).
      if (!isConfident(r, "inject") || !foreignIntentAdmissible(r, projectId)) return "floor";
      // What the task itself rules out: a runbook for an action the brief
      // forbids, an activity note that is weak or old.
      const planned = injectionPlanGate(r, plan, now, tagsOf);
      if (planned) return planned;
      // Origin, coherence (roadmap r5/r7) and freshness gates, shared with
      // search_knowledge's injectionEligible flag.
      return injectionGateReason(r, freshness);
    };
    const inFamily = (hit: SearchResult) =>
      kinds.includes(hit.sourceKind) || (reach.activity && layerOf(hit) === "activity");
    const admitted: SearchResult[] = [];
    for (const r of results.filter((hit) => inFamily(hit) && !pinnedIds.has(hit.id))) {
      const reason = gateReason(r);
      if (reason) gated?.push({ hit: r, reason });
      else admitted.push(r);
    }
    const ranked = demoteStale(admitted, staleSince);
    const room = maxDocs - head.length;
    for (const r of ranked.slice(room)) gated?.push({ hit: r, reason: "cutoff" });
    return [...head, ...ranked.slice(0, room)].map((r): InjectedDoc => {
      // A doc whose not-merged claims have landed carries the landed marker in
      // place of its stale date: its merge-status wording is what is out of date.
      const stored = store.getDoc(r.projectId, r.slug);
      const landedRec = stored ? landedClaimFor(db, stored) : undefined;
      const since = landedRec ? undefined : staleSince(r)?.slice(0, 10);
      const dated: InjectedDoc = landedRec
        ? { ...r, landed: landedClaimMarker(landedRec) }
        : since
          ? { ...r, title: `${r.title} (stale since ${since})` }
          : r;
      if (r.verdict !== "disputed") return dated;
      const claim = disputeClaimOf(store, r);
      return claim ? { ...dated, disputeClaim: claim } : dated;
    });
  } catch {
    return head;
  }
}

/**
 * Retrieves the highest-relevance PRODUCT/spec docs for a launch's task, to be
 * injected alongside (not instead of) the code-first knowledge tools so the
 * agent has product intent while implementing (roadmap r8). Drawn from the
 * launching project's own docs, its related projects' (the audience's
 * relatedProjectIds) and the global corpus's — never another project's, even a
 * scope=global one. `task` is the brief (planned with the heuristic) or the
 * launch's InjectionPlan. See retrieveKnowledgeOfKinds for the pooling and
 * gating.
 */
export async function retrieveProductKnowledge(
  db: Database,
  projectId: string,
  task: string | InjectionPlan,
  embeddingProvider: EmbeddingProvider | null = null,
  embeddingConfig: EmbeddingConfig = {},
  audience?: ScopeAudience,
  gated?: GatedCandidate<SearchResult>[],
  pins?: NamedPins
): Promise<InjectedDoc[]> {
  return retrieveKnowledgeOfKinds(
    db,
    projectId,
    typeof task === "string" ? planInjection(task) : task,
    PRODUCT_KNOWLEDGE_KINDS,
    MAX_PRODUCT_DOCS,
    embeddingProvider,
    embeddingConfig,
    { excludeForeignIntent: true, activity: false },
    audience,
    gated,
    pins?.product,
    pins?.ids
  );
}

/**
 * Retrieves the highest-relevance CODE knowledge for a launch's task — the
 * "code-first" half of the item (roadmap r8). Pushes the touched-area code
 * knowledge into the opening prompt rather than leaving it entirely to the
 * knowledge-first steering's pull, so the agent starts grounded in the code
 * docs most relevant to what it's about to build, with recent, relevant activity
 * notes admitted beside them. `task` is the brief (planned with the heuristic)
 * or the launch's InjectionPlan. See retrieveKnowledgeOfKinds.
 */
export async function retrieveCodeKnowledge(
  db: Database,
  projectId: string,
  task: string | InjectionPlan,
  embeddingProvider: EmbeddingProvider | null = null,
  embeddingConfig: EmbeddingConfig = {},
  audience?: ScopeAudience,
  gated?: GatedCandidate<SearchResult>[],
  pins?: NamedPins
): Promise<InjectedDoc[]> {
  return retrieveKnowledgeOfKinds(
    db,
    projectId,
    typeof task === "string" ? planInjection(task) : task,
    CODE_KNOWLEDGE_KINDS,
    MAX_CODE_DOCS,
    embeddingProvider,
    embeddingConfig,
    { excludeForeignIntent: false, activity: true },
    audience,
    gated,
    pins?.code,
    pins?.ids
  );
}

/**
 * Renders retrieved product/spec docs as a labeled prompt block (roadmap r8),
 * or "" when there are none. Each doc is headed with its `[source_kind]` so the
 * agent can tell product intent from a spec, and CLEARLY distinguished from the
 * code-first knowledge tools — this is context to ground the work, not a
 * substitute for consulting the knowledge base. Size-capped to
 * PRODUCT_INJECT_CHAR_BUDGET: docs are added whole in relevance order until the
 * next one would overflow the budget, so the block never runs unbounded.
 *
 * Pure, so the injection is unit-testable without a live search. Returns both
 * the rendered `text` and the `includedDocs` actually admitted — the char
 * budget can drop a trailing doc, and the caller needs to know WHICH docs made
 * it in to record injected-vs-dropped telemetry. The `text` is exactly
 * what it always was; `includedDocs` only exposes the existing decision.
 */
function renderInjectionBlock(
  results: InjectedDoc[],
  charBudget: number,
  header: string
): { text: string; includedDocs: InjectedDoc[] } {
  if (results.length === 0) return { text: "", includedDocs: [] };

  const blocks: string[] = [];
  const includedDocs: InjectedDoc[] = [];
  let used = 0;
  for (const r of results) {
    // A contradicted doc (only an undecided or winning side reaches here) says
    // which docs it conflicts with, so the agent weighs both claims. A disputed
    // doc (named in the task, or ranked into a slot after its trust demotion)
    // is marked in its heading, so the marker survives any excerpt length, and
    // its banner quotes the refuted claim when it is short.
    const banner =
      r.verdict === "contradicted"
        ? `⚠ conflicts with ${(r.contradiction?.counterparts ?? []).join(", ") || "another doc"}${
            r.contradiction?.side === "winning" ? " (this side is newer or better verified)" : " — unresolved; weigh both"
          }\n`
        : r.verdict === "disputed"
          ? `⚠ DISPUTED by re-verification${r.disputeClaim ? ` — disputed claim: "${r.disputeClaim}"` : ""}\n`
          : "";
    const named = r.namedInTask ? " (named in task)" : "";
    const disputed = r.verdict === "disputed" ? ` ${DISPUTED_INJECTION_MARKER}` : "";
    const landed = r.landed ? ` (${r.landed})` : "";
    const block = `## [${r.sourceKind}] ${r.title} (${r.projectId}/${r.slug})${named}${disputed}${landed}\n${banner}${r.excerpt.trim()}`;
    // Always admit the first doc even if it alone exceeds the budget (a single
    // very long spec is better truncated-by-K=1 than dropped entirely), then
    // stop once the accumulated size would overflow.
    if (blocks.length > 0 && used + block.length > charBudget) break;
    blocks.push(block);
    includedDocs.push(r);
    used += block.length;
  }

  return { text: `\n\n---\n${header}\n\n` + blocks.join("\n\n"), includedDocs };
}

export function formatProductKnowledgeInjection(
  results: InjectedDoc[],
  charBudget: number = PRODUCT_INJECT_CHAR_BUDGET
): { text: string; includedDocs: InjectedDoc[] } {
  return renderInjectionBlock(
    results,
    charBudget,
    `Product & spec context for this task (from the shared knowledge base). ` +
      `This is product/spec intent to GROUND your implementation — it does not replace the ` +
      `code-first knowledge tools above; keep consulting those for how the code works.`
  );
}

/**
 * Renders retrieved CODE knowledge as a labeled prompt block (roadmap r8), or
 * "" when there are none — the "code-first" injection half. This is a starting
 * set of the touched-area code docs, NOT an exhaustive one: it frames itself as
 * a head start that does not replace the knowledge-first tools, so the agent
 * still searches for anything it needs beyond what's here. Size-capped to
 * CODE_INJECT_CHAR_BUDGET the same way the product block is. Pure, so the
 * injection is unit-testable without a live search.
 */
export function formatCodeKnowledgeInjection(
  results: InjectedDoc[],
  charBudget: number = CODE_INJECT_CHAR_BUDGET
): { text: string; includedDocs: InjectedDoc[] } {
  return renderInjectionBlock(
    results,
    charBudget,
    `Relevant code knowledge for this task (from the shared knowledge base). ` +
      `This is a head start on the touched area, not an exhaustive set — keep using the ` +
      `code-first knowledge tools above for anything it doesn't cover.`
  );
}

/**
 * Builds the retrieval-telemetry rows for a launch's knowledge injection.
 * Each top-K candidate retrieval surfaced for a kind becomes one `inject`-surface
 * RetrievalRecord, flagged `injected: true` when it survived the char budget
 * (`included` holds it) and `injected: false` when the budget dropped it — so
 * injected-vs-dropped is observable per launch. `rank` is the doc's index within
 * its kind's top-K list. `sessionId` is deliberately unset: the session does not
 * exist yet at prompt-build time, so these rows correlate to the launch via
 * `launchId` instead. A doc the task named (InjectedDoc.namedInTask) carries
 * `namedInTask: 1` in its components, since it reached the block by name
 * rather than by score. Pure, so the mapping is unit-testable without a launch.
 */
export function buildInjectRetrievalRecords(input: {
  codeDocs: InjectedDoc[];
  codeIncluded: InjectedDoc[];
  productDocs: InjectedDoc[];
  productIncluded: InjectedDoc[];
  launchId: string;
  query: string;
  queryProject: string;
  /** Candidates each kind's injection gates held back (retrieveCodeKnowledge's `gated`). */
  codeGated?: GatedCandidate<SearchResult>[];
  productGated?: GatedCandidate<SearchResult>[];
  /** Stored placement (scope, owner) for a doc, since a search hit does not carry it. */
  placementOf?: (projectId: string, slug: string) => DocPlacement | null;
  /** The host user, who owns a home CLAUDE.md / rules mirror with no owner stamp. */
  hostUser?: string;
}): RetrievalRecord[] {
  const placement = (doc: SearchResult) => input.placementOf?.(doc.projectId, doc.slug) ?? null;
  const base = {
    query: input.query,
    surface: "inject" as const,
    launchId: input.launchId,
    queryProject: input.queryProject,
  };
  const forKind = (docs: InjectedDoc[], included: InjectedDoc[]): RetrievalRecord[] =>
    docs.map((doc, rank) => {
      const injected = included.includes(doc);
      const fields = hitRecordFields(doc, placement(doc), input.hostUser);
      return {
        ...base,
        docProject: doc.projectId,
        docSlug: doc.slug,
        rank,
        ...fields,
        ...(doc.namedInTask ? { components: { ...fields.components, namedInTask: 1 } } : {}),
        injected,
        ...(injected ? {} : { dropReason: BUDGET_DROP_REASON }),
      };
    });
  // One launch is one query: its gated candidates share one bound across kinds.
  return [
    ...forKind(input.codeDocs, input.codeIncluded),
    ...forKind(input.productDocs, input.productIncluded),
    ...gatedRecords([...(input.codeGated ?? []), ...(input.productGated ?? [])], base, placement, input.hostUser),
  ];
}

/**
 * The opening prompt handed to a launched agent: the task, the checkpoint
 * instruction every launch carries, the knowledge-first steering, the code and
 * product/spec context blocks when they were retrieved for the task (roadmap r8, see
 * formatCodeKnowledgeInjection / formatProductKnowledgeInjection), and — when a
 * launching user is known — that user's personalization (see
 * formatUserPrefsInstruction). The launching user is the `requester` captured on
 * the launch; an automatic launch with no requester gets no personalization.
 *
 * The injected prefs are the EFFECTIVE profile for `projectId`: the user's
 * global profile (§A) merged with their overlay for this project (§H) — global
 * personal instructions plus the project's, with the project value winning for
 * the structured fields (see getEffectiveUserPrefs/mergeUserPrefs). Omit
 * `projectId` (or launch outside any project) to inject the global profile
 * alone. Exported so the injection is unit-testable without spawning a real
 * tmux session.
 *
 * `launchArgs` are the project's extra `claude` flags: they gate the
 * knowledge-first steering, because a launch whose flags strip the `standup` MCP
 * server (launchArgsDropStandupMcp) can't reach the tools the steering names, so
 * the steering is dropped for it rather than pointing the agent at tools that
 * don't resolve.
 *
 * `productContext` and `codeContext` are the already-rendered product/spec and
 * code blocks (see formatProductKnowledgeInjection / formatCodeKnowledgeInjection).
 * Both are retrieved and gated by the caller (launchSession, on the knowledge-
 * first toggle) rather than here, because retrieval is async and this stays a
 * pure, synchronous prompt composer; pass "" for either when none was retrieved.
 * The code block precedes the product block in the prompt: code knowledge for
 * the touched area first (the code-first half), then the product/spec intent
 * that grounds it.
 *
 * `activityContext` is the already-rendered ephemeral "active work in this
 * project" block (see formatActivityContext) — what OTHER agents are working on
 * right now. Retrieved and formatted by the caller (launchSession) so this stays
 * a pure, synchronous composer; pass "" when there is none. It rides after the
 * durable knowledge blocks and is deliberately kept OUT of the knowledge path —
 * a recency view, not institutional context.
 *
 * `orchestrationProfile` is the already-resolved profile this launch runs under
 * (resolveActiveProfile, threaded by launchSession the same way the resolved
 * plan-gate is — see resolvePlanGate). When present, its ordered steps are
 * injected as steering right after the plan-first block
 * (formatOrchestrationInstruction); undefined leaves the prompt unchanged.
 *
 * `pipelineDefinition` is the definition of the launch's ACTIVE delivery
 * pipeline run (startLaunchPipeline). Its stages and the pipeline tools are
 * briefed after the orchestration block (formatPipelineInstruction) — dropped,
 * like the knowledge-first steering, when the launch can't reach the standup
 * MCP server that carries pipeline_status / pipeline_advance.
 *
 * `launchEnv` is the environment the agent is spawned with; a Codex launch
 * reads its MCP registration from the config.toml under that env's
 * CODEX_HOME / HOME (harnessReachesStandupMcp).
 */
export function buildOpeningPrompt(
  db: Database,
  task: string,
  requester?: string,
  projectId?: string,
  launchArgs?: string,
  productContext = "",
  codeContext = "",
  planGate = false,
  harness: HarnessId = "claude",
  launchSubdir?: string,
  activityContext = "",
  orchestrationProfile?: OrchestrationProfile,
  pipelineDefinition?: PipelineDefinition,
  codeReviewNotApplicable?: string | null,
  launchEnv: NodeJS.ProcessEnv = process.env
): string {
  const prefs = requester ? getEffectiveUserPrefs(db, requester, projectId) : null;
  // The knowledge-first and plan-first steering name tools on the `standup` MCP
  // server. A launch is without it when its flags strip it (--strict-mcp-config)
  // or when its harness has no registration of its own (harnessReachesStandupMcp)
  // — in either case the steering would name tools the agent can't call, so it
  // is dropped rather than pointing the agent at tools that don't resolve.
  const noStandupMcp = !harnessReachesStandupMcp(harness, launchArgs, launchEnv);
  const knowledgeFirst = noStandupMcp ? "" : KNOWLEDGE_FIRST_INSTRUCTION;
  const planFirst = planGate && !noStandupMcp ? PLAN_FIRST_INSTRUCTION : "";
  // The orchestration steering names the profile's own steps (shell gates,
  // deploys, an adversarial-review loop) and the completion contract — none of
  // which route through the standup MCP server — so it rides on the resolved
  // profile alone, injected whenever one was resolved for this launch.
  const orchestration = orchestrationProfile
    ? formatOrchestrationInstruction(orchestrationProfile)
    : "";
  const deliveryPipeline =
    pipelineDefinition && !noStandupMcp
      ? formatPipelineInstruction(pipelineDefinition, { reviewGate: projectReviewGate(db, projectId), codeReviewNotApplicable })
      : "";
  // A Codex launch runs at the WORKSPACE ROOT (not the launchSubdir), so it needs
  // to be told which package the task targets — the orientation Claude gets for
  // free by starting inside that subdir. Claude keeps its subdir cwd, so this is
  // codex-only; omitted when there's no subdir (a single-package repo / scratch).
  // The pointer is the launchSubdir itself, the path under the root Claude's cwd
  // is joined from, whatever the project's layout names its packages dir. A
  // subdir outside the root (absolute, or climbing out with `..`) names no
  // package under it, so it gets no pointer.
  const normalizedSubdir = launchSubdir ? normalizeLaunchSubdir(launchSubdir) : "";
  const packagePath = launchSubdirUnderRoot(normalizedSubdir) ? normalizedSubdir : "";
  const codexPackagePointer =
    harness === "codex" && packagePath
      ? `\n\n---\nYou start at the WORKSPACE ROOT. The target package is at ` +
        `${packagePath} — begin there, but you may read and ` +
        `write across the whole workspace (sibling packages included).`
      : "";
  return (
    task +
    CHECKPOINT_INSTRUCTION +
    (harness === "claude" ? EDIT_TOOLS_INSTRUCTION + SCRATCH_INSTRUCTION : "") +
    codexPackagePointer +
    planFirst +
    orchestration +
    deliveryPipeline +
    knowledgeFirst +
    codeContext +
    productContext +
    activityContext +
    formatUserPrefsInstruction(prefs)
  );
}

/**
 * A project's launchSubdir as a path under the worktree / workspace root:
 * trimmed and normalized, with no leading `./` and no trailing separator. ""
 * when it names the root itself.
 */
function normalizeLaunchSubdir(subdir: string): string {
  const trimmed = subdir.trim();
  if (!trimmed) return "";
  const path = normalize(trimmed).replace(/[\\/]+$/, "");
  return path === "." ? "" : path;
}

/** Whether a normalized launchSubdir names a dir below the root: non-empty, relative, and not climbing out of it. */
function launchSubdirUnderRoot(path: string): boolean {
  return path !== "" && !isAbsolute(path) && path !== ".." && !path.startsWith("../") && !path.startsWith("..\\");
}

/**
 * The compact "active work in this project" block for the opening prompt — a few
 * bullet lines (title — status — actor) telling a launching agent what OTHER
 * agents are doing right now, so it can compose with them rather than collide.
 * Empty string when there is nothing to show, so buildOpeningPrompt emits no
 * dangling header. The caller bounds the list; this only renders it.
 */
/** Render cap for an active-work line's title in the opening prompt — a touch looser than the stored cap. */
const ACTIVE_WORK_TITLE_CAP = 80;

export function formatActivityContext(work: ActiveWorkItem[]): string {
  if (work.length === 0) return "";
  const lines = work.map((w) => {
    // Capped again at render — stored titles are already bounded, but this block
    // is composed into a launch prompt, so a stray long one can't pad it out.
    const title = capTitle(w.title || "Untitled", ACTIVE_WORK_TITLE_CAP);
    const actor = w.actor ? ` — ${w.actor}` : "";
    const job = w.job ? ` — job: ${capTitle(w.job.title, ACTIVE_WORK_TITLE_CAP)}` : "";
    return `- ${title} — ${w.status}${actor}${job}`;
  });
  return `\n\n---\nActive work in this project (active, paused, or seen in the last 24h):\n${lines.join("\n")}`;
}

/**
 * The opening prompt's activity block for a launch into `projectId` by
 * `launchingActor`. Nothing is excluded: the new session doesn't exist yet,
 * and the launching actor's other sessions are its sibling workers (Persona
 * launches every worker as the owner). Job titles show only for the launching
 * actor's own jobs. Bounded so the prompt doesn't bloat.
 */
export function launchActivityContext(db: Database, projectId: string, launchingActor: string | undefined): string {
  return formatActivityContext(getActiveWork(db, projectId, { jobViewer: launchingActor, limit: 8 }));
}

/**
 * Starts `launch`'s delivery-pipeline run, owned by the launching `requester`
 * (else the host user). Only an ordinary launch that will produce a change of
 * its own gets one — not a bootstrap run, a launch into a reused worktree (the
 * fixer works on another launch's change) or a scratch run with no repo to
 * ship from; those return null. Which of the rest run it is the launch's
 * `pipeline` mode (LaunchPipelineMode): `auto` (the default) runs it for a
 * git checkout of the project's repo — a fresh worktree or in-place — and
 * records a provisioned launch's run disabled as `not_coding`; `default` runs
 * it for a provisioned launch too; `off` records the run disabled — as a
 * Best-of-N attempt (one of `attemptGroup`, turned on if it is picked) or as
 * the launch's opt-out. A launch that can't reach the standup MCP server
 * (`standupMcp: false` — a non-Claude harness or launchArgs that strip it) is
 * recorded disabled for good: its worker could never report a stage. A
 * failure to start is logged and never fails the launch.
 */
export function startLaunchPipeline(
  db: Database,
  launch: Launch,
  opts: {
    kind?: LaunchKind;
    reusedWorktree: boolean;
    scratch: boolean;
    provisioned?: boolean;
    requester?: string;
    pipeline?: LaunchPipelineMode | boolean;
    standupMcp?: boolean;
    attemptGroup?: string;
    /** The launch's own pipeline layer, frozen into the run with the others. */
    pipelineOverride?: PipelineOverride;
    /** The Persona job the launch is for, whose layer the run resolves (else the job the launch is linked to). */
    jobId?: string;
  }
): PipelineRun | null {
  if ((opts.kind ?? "worktree") !== "worktree" || opts.reusedWorktree || opts.scratch) return null;
  const mode = parseLaunchPipelineMode(opts.pipeline) ?? "auto";
  const disabledReason: PipelineDisabledReason | undefined =
    opts.standupMcp === false
      ? "no_mcp"
      : mode === "off"
        ? opts.attemptGroup
          ? "attempt"
          : "opt_out"
        : mode === "auto" && opts.provisioned
          ? "not_coding"
          : undefined;
  try {
    return startPipelineForLaunch(db, {
      launchId: launch.id,
      owner: opts.requester?.trim() || hostUserAlias(),
      projectId: launch.projectId,
      disabled: disabledReason !== undefined,
      disabledReason,
      jobId: opts.jobId,
      pipelineOverride: opts.pipelineOverride,
    });
  } catch (err) {
    console.error(`[pipeline] could not start the run for launch ${launch.id}:`, err);
    return null;
  }
}

/**
 * The effective plan-gate for a launch: the per-launch override wins, else the
 * project's `planGate` default, else off. Opt-in and off by default so an
 * un-configured project's launches are unaffected.
 */
export function resolvePlanGate(project: Project, requestPlanGate?: boolean): boolean {
  return requestPlanGate ?? project.planGate ?? false;
}

export interface LaunchRequest {
  project: Project;
  task: string;
  /**
   * Short human-readable name for the launch, when `task` is unsuitable as
   * one. `task` doubles as the agent's opening prompt and as the row's
   * display text, which is fine while a prompt is a sentence someone typed
   * — but a bootstrap run's prompt is a page of instructions, and using it
   * unlabelled produced a branch named after its first forty characters and
   * a feed entry that was a wall of text. Launches are meant to be watched
   * and stopped; that is hard to do when you cannot tell them apart.
   *
   * Affects the worktree slug, branch name, and stored task only. The agent
   * still receives the full `task`.
   */
  label?: string;
  /** Passed as `claude --model`; omitted means the CLI's own default. */
  model?: ClaudeModel;
  /** Passed as `claude --effort`; omitted means the CLI's own default. */
  effort?: ClaudeEffort;
  /**
   * For a `codex` launch, the model passed through as `codex exec -m`. Free-form
   * (Codex model ids are open-ended) and kept SEPARATE from the Claude-typed
   * `model` so the two harnesses' model spaces never conflate. Omitted leaves the
   * Codex CLI's own default; only consulted when the resolved harness is `codex`.
   */
  codexModel?: CodexModel;
  /**
   * For a `codex` launch, the reasoning-effort level applied as
   * `-c model_reasoning_effort=<level>` (see buildCodexArgv). Its own field,
   * distinct from the Claude-typed `effort`. Omitted leaves the Codex CLI's own
   * default; only consulted when the resolved harness is `codex`.
   */
  codexEffort?: CodexEffort;
  /**
   * worktree = ordinary launch (the default); bootstrap = a knowledge-
   * bootstrap run (phase-7 Step 3). Both take the exact same path below —
   * a real worktree, the setup command, a tmux session — the only
   * difference is what's recorded on the launch row, which is what lets
   * propose_knowledge's gate (server.ts) tell them apart.
   */
  kind?: LaunchKind;
  /**
   * Reuse the project's existing repo checkout instead of creating a new
   * worktree — the composer's "reuse existing workspace" toggle. Skips
   * `git worktree add` and `setup`, and cleanup leaves the working dir
   * alone (it is the real repo, same guarantee as an adopted launch).
   * Ignored — silently treated as false — when the project uses a
   * `provision` command, has no repo, or the launch is a bootstrap run.
   * Falls back to `project.inPlace` when undefined.
   */
  inPlace?: boolean;
  /**
   * Persona launched this run. An in-place Persona worker's floor reads the
   * checkout's own git hooks strictly (FloorConfig.strictHooks). It only ever
   * tightens the floor.
   */
  persona?: boolean;
  /**
   * False keeps a `scratch` launch in scratch instead of inferring a project
   * from its task (a guest Persona's launch, held to its allowlist).
   */
  allowProjectInference?: boolean;
  /**
   * Called with the project the launch goes to once it is known — after a
   * `scratch` launch's project inference, before anything is created — and
   * may throw (a LaunchRefusedError) to refuse the launch there.
   */
  checkProject?: (project: Project) => void;
  /**
   * Who dispatched this run — the launching user's alias (the tunnel's
   * identity header, else the host user), unset for an automatic one.
   * Recorded on the task-run ledger row, and used to inject that user's profile
   * into the opening prompt (see buildOpeningPrompt) so the agent behaves per
   * their prefs even on a shared collector.
   */
  requester?: string;
  /**
   * The server-resolved identity used ONLY to scope the knowledge injected into
   * the opening prompt (the global ∪ project ∪ user gate). Kept DISTINCT from
   * `requester`: `requester` is the caller-attributable actor (a body `actor`
   * override on an HTTP launch, or a Slack teammate) that drives ledger
   * attribution and profile injection, whereas this is the collector's own
   * trusted answer to "who is asking" (scopingUser(c) — ignores the forgeable
   * body override, maps anonymous → undefined). Decoupling them stops a caller
   * from steering which user's user-scoped docs get injected by naming a victim
   * in `actor`. Undefined falls back safely to global ∪ project (no user docs).
   */
  retrievalUser?: string;
  /**
   * Who launched this, as the collector resolved it (Launch.launchedBy): the
   * request's authenticated identity, never a body `actor` override, or the
   * owner of the Persona that launched it. Undefined for an automatic or
   * anonymous launch, whose review packets then have no trusted owner.
   */
  launchedBy?: string;
  /**
   * Per-launch override of the project's plan-approval gate (Project.planGate).
   * `true` forces the gate on for this launch, `false` off; undefined falls back
   * to the project default. See resolvePlanGate.
   */
  planGate?: boolean;
  /**
   * Per-launch override of the project's permission posture
   * (Project.bypassPermissions). `true` runs this launch bypassed behind the
   * safety floor, `false` runs it `--permission-mode auto`; undefined falls back
   * to the project default, then to bypass. See resolveBypassPermissions.
   * Claude-only.
   */
  bypassPermissions?: boolean;
  /**
   * Per-launch override of the orchestration profile this launch runs under — a
   * profile NAME. Undefined falls back to the project -> personal -> global
   * default, resolved inside launchSession (resolveActiveProfile), mirroring how
   * `planGate` falls back to the project default via resolvePlanGate. The
   * resolved profile's ordered steps are injected into the opening prompt as
   * steering (see buildOpeningPrompt / formatOrchestrationInstruction).
   */
  orchestrationProfile?: string;
  /**
   * Run this launch IN an existing worktree at this exact path, instead of
   * provisioning a fresh one off the base branch. The fixer path uses it so the
   * agent opens the very files the reviewed change touched — the change lives in
   * the ticket's implementation worktree, and a fresh base-branch checkout would
   * not contain it. Behaves like `inPlace` (skips `git worktree add` and
   * `setup`, and cleanup leaves the directory alone), but targets an arbitrary
   * worktree rather than the project's repo checkout. Ignored when the path is
   * empty or does not exist, in which case the launch provisions normally.
   */
  reuseWorktreePath?: string;
  /**
   * Caller-supplied dedup key, stamped on the launch row (createLaunch). Lets a
   * redelivered launch request — a Slack "launch …" command redelivered after a
   * missed ack or an adapter restart — resolve to the SAME launch instead of
   * spawning a second worktree/session. The endpoint checks
   * getLaunchByIdempotencyKey before calling here; the UNIQUE index is the hard
   * backstop. Undefined for internal/automatic launches.
   */
  idempotencyKey?: string;
  /**
   * Groups this launch's dispatcher-ledger run with the other best-of-N attempts
   * on the same ticket — each attempt is its own worktree + task_run, and they
   * share this id (stamped on the run created below). Undefined for an ordinary
   * single dispatch, which is never grouped.
   */
  attemptGroup?: string;
  /**
   * Whether this launch runs the delivery pipeline (coding → validation →
   * review → deploy → screenshots → code review) its owner's configuration resolves —
   * see LaunchPipelineMode and startLaunchPipeline. Omitted (or `auto`) lets
   * the launch's kind decide; `off` (or false) for research, lookups,
   * read-only or docs work that won't deploy or cut a code review — its run is
   * recorded disabled, so nothing steers, blocks or gates it; `default` runs
   * it on a provisioned workspace too.
   */
  pipeline?: LaunchPipelineMode | boolean;
  /** The launch's own pipeline layer, over its owner's, project's and job's (see resolvePipelineFor). */
  pipelineOverride?: PipelineOverride;
  /** The Persona job the launch is for, whose pipeline layer its run resolves (only when it is the requester's). */
  pipelineJobId?: string;
  /**
   * Which agent CLI to drive for THIS launch, chosen per-launch in the composer
   * (see HarnessId). Overrides the project's own `harness` default when set;
   * undefined falls back to that default, which in turn falls back to `claude`.
   * So omitting it launches Claude exactly as before — the default harness, its
   * behavior unchanged. Setting it to `codex` routes this one launch through the
   * Codex harness adapter without touching the project's default.
   */
  harness?: HarnessId;
}

/** Builds the trailing `--model`/`--effort` flags for a `claude` invocation. */
function modelEffortFlags(model?: ClaudeModel, effort?: ClaudeEffort): string[] {
  const flags: string[] = [];
  if (model) flags.push("--model", model);
  if (effort) flags.push("--effort", effort);
  return flags;
}

/** The subset of a launch that shapes the spawn argv, harness-agnostic. */
export interface SpawnArgvSpec {
  tmuxSession: string;
  /**
   * Where Claude starts — the launchSubdir cwd (a single package in a
   * multi-package workspace, else the worktree root). The Claude path uses this
   * for both the tmux pane cwd and the process cwd, unchanged.
   */
  launchCwd: string;
  /**
   * The worktree / workspace ROOT (before launchSubdir is appended). Codex runs
   * here — `-C <root>` and the tmux pane cwd both — so a multi-package
   * workspace agent starts at, and can write across, the whole workspace rather
   * than being boxed into one package. Ignored by the Claude path.
   */
  workspaceRoot: string;
  prompt: string;
  launchId: string;
  /** Claude `--model` alias; ignored by Codex (its model aliases differ). */
  model?: ClaudeModel;
  /** Claude `--effort` level; ignored by Codex. */
  effort?: ClaudeEffort;
  /** Codex `-m` model; ignored by Claude (its model aliases differ). */
  codexModel?: CodexModel;
  /** Codex reasoning effort (`-c model_reasoning_effort=`); ignored by Claude. */
  codexEffort?: CodexEffort;
  /** The project's extra CLI flags, tokenized before the prompt for both harnesses. */
  launchArgs?: string;
  /** A scratch run (no git repo) — Codex needs `--skip-git-repo-check` for it. */
  isScratch: boolean;
  /** Where a Codex run tees its `--json` event stream for telemetry; unused by Claude. */
  codexEventLog?: string;
  /**
   * The Claude launch's permission posture inputs (see buildClaudeLaunchArgv).
   * Claude-only: Codex runs under its adapter's own approval/sandbox profile, so
   * the bypass setting and the safety floor don't apply to it.
   */
  permissions?: ClaudeLaunchPermissions;
  /**
   * The launch's review token file (issueReviewToken). Its PATH is set on the
   * Claude session (WORKER_TOKEN_FILE_ENV), so the standup MCP server reads
   * the token from it; the token itself never enters an argv or environment.
   */
  workerTokenFile?: string;
  /**
   * The launch's hook token (issueLaunchHookToken), set on the Claude session
   * as HOOK_TOKEN_ENV for the floor settings' reporting hooks to present.
   */
  hookToken?: string;
}

/**
 * Issues a launch's hook token, recording its hash on the launch row so the
 * `/hook` route can tell the launch's own hooks from everything else.
 */
export function issueLaunchHookToken(db: Database, launchId: string): string {
  const token = newHookToken();
  setLaunchHookTokenHash(db, launchId, workerTokenHash(token));
  return token;
}

/** The session env carrying a hook token, or none. */
export function hookTokenEnv(token: string | undefined): Record<string, string> {
  return token ? { [HOOK_TOKEN_ENV]: token } : {};
}

/**
 * Builds the detached-tmux spawn command for the selected harness. Claude (the
 * default) takes the existing argv verbatim — `claude` with the per-launch
 * `--model`/`--effort` flags and the project's extra launch args, then the
 * prompt; Codex builds a `codex exec --json` launch through its adapter, teeing
 * the event stream to the sidecar for telemetry. Both deliver the prompt the
 * same way (buildLaunchArgv's temp file).
 *
 * Pure, and the seam launchSession routes every launch through — so harness
 * selection is unit-testable without spawning anything, and the Claude branch is
 * byte-for-byte the pre-harness path.
 */
export function buildSpawnArgv(harness: HarnessId, spec: SpawnArgvSpec): string[] {
  if (harness === "codex") {
    // A project's `launchArgs` are Claude flags (see SpawnArgvSpec.launchArgs and
    // the composer's `--permission-mode acceptEdits` example). `codex exec` is
    // clap-based and aborts on an unknown flag ("unexpected argument
    // '--permission-mode'"), so forwarding them verbatim would break every Codex
    // launch on a normally-configured project. They are Claude-only, so the Codex
    // path drops them rather than passing them through — the sandbox/approval
    // knobs Codex needs come from the adapter's profile, not the project flags.
    //
    // cwd is the WORKSPACE ROOT (workspaceRoot), NOT launchCwd/launchSubdir: a
    // multi-package workspace agent must start at and write across the root.
    // The adapter uses it for both `codex -C` and the tmux pane cwd; the
    // opening prompt already points the agent at its package (launchSubdir).
    //
    // `--skip-git-repo-check` stays ON for EVERY Standup codex launch (the
    // adapter's default). The cwd is a git repo only for a worktree / in-place
    // launch; a multi-repo workspace ROOT and a scratch dir are NOT git repos, and
    // codex refuses to run outside a trusted git repo without this flag ("Not
    // inside a trusted directory and --skip-git-repo-check was not specified").
    // It is harmless when the dir happens to be a repo, so it is unconditional —
    // do NOT gate it on isScratch (that dropped the flag for the common
    // worktree/workspace-root case and killed the launch before codex emitted
    // any JSON).
    return new CodexHarnessAdapter({ skipGitRepoCheck: true }).buildLaunchCommand({
      cwd: spec.workspaceRoot,
      prompt: spec.prompt,
      tmuxSession: spec.tmuxSession,
      launchId: spec.launchId,
      // Codex's own model + reasoning-effort knobs (the composer's Claude aliases
      // are dropped above); each is emitted only when set — an unset one leaves
      // the Codex CLI's own default.
      model: spec.codexModel,
      reasoningEffort: spec.codexEffort,
      eventLogPath: spec.codexEventLog,
    });
  }
  // Claude launches INTERACTIVELY with no positional prompt: a wrapper script
  // installed as `claude` can drop a trailing positional prompt, so the session
  // would open at an empty prompt and never run the task. The opening prompt is
  // instead typed in via `tmux send-keys` once the input box is ready
  // (deliverOpeningPromptToClaude, driven from launchSession) — reliable on both
  // a wrapped and a plain claude. `spec.prompt` is delivered there, not here.
  return buildInteractiveLaunchArgv(
    spec.tmuxSession,
    spec.launchCwd,
    buildClaudeLaunchArgv(spec.model, spec.effort, spec.launchArgs, spec.permissions),
    spec.launchId,
    { ...reviewTokenEnv(spec.workerTokenFile), ...hookTokenEnv(spec.hookToken) }
  );
}

/**
 * Issues the launch's review token (issueReviewToken) and returns its file's
 * path, or undefined (logged) when the file can't be written: the launch then
 * runs without one and its review requests are refused.
 */
export function launchReviewTokenFile(db: Database, launchId: string, log: string[], dataDir: string = standupDataDir()): string | undefined {
  try {
    return issueReviewToken(db, dataDir, launchId);
  } catch (err) {
    log.push(`[warn] no review token for this launch: ${(err as Error).message}`);
    return undefined;
  }
}

/**
 * The `claude` argv (without the tmux wrapper or the trailing positional prompt)
 * for a console launch, with Standup's launch-posture defaults applied so a
 * launched session runs UNATTENDED rather than stalling in manual mode on the
 * first permission prompt:
 *
 *   - the permission posture from resolveClaudePermissionPosture: by default
 *     `--permission-mode bypassPermissions` plus `--settings` carrying the
 *     safety-floor PreToolUse hook (buildFloorHookSettings), which routes
 *     outward-facing and destructive steps to Persona or the owner; a project
 *     or launch that opts out, or a launch the floor can't guard, gets
 *     `--permission-mode auto` with no hook. A project that pinned its own
 *     `--permission-mode` in launchArgs (e.g. `plan` or `acceptEdits`) WINS —
 *     no mode is injected (launchArgsSetPermissionMode) — except that a
 *     bypass-capable launchArgs posture still gets the floor.
 *   - the read-only standup KB tools (ALWAYS_ALLOWED_STANDUP_TOOLS) folded into
 *     `--allowedTools` on EVERY launch (withStandupReadTools), so a simple
 *     knowledge read never prompts regardless of permission mode. The write tools
 *     are deliberately absent, so they stay gated.
 *
 * Omitting `permissions` means no floor is available, so the launch never
 * bypasses. Throws LaunchPermissionError when the project's launchArgs pin a
 * bypass the floor can't guard. The project's own launchArgs follow the
 * injected flags, matching the pre-existing ordering (extra flags before the
 * positional prompt). Pure, so the argv is unit-testable without spawning
 * anything.
 */
export function buildClaudeLaunchArgv(
  model: ClaudeModel | undefined,
  effort: ClaudeEffort | undefined,
  launchArgs: string | undefined,
  permissions: ClaudeLaunchPermissions = { bypassPermissions: false }
): string[] {
  const posture = resolveClaudePermissionPosture(launchArgs, permissions);
  const modeFlags = posture.injectedMode ? ["--permission-mode", posture.injectedMode] : [];
  // resolveClaudePermissionPosture only turns the floor on when a config exists.
  const floorFlags =
    posture.floor && permissions.floor
      ? ["--settings", buildFloorHookSettings(permissions.floor, permissions.bunPath, permissions.hookPath)]
      : [];
  return [
    "claude",
    ...modelEffortFlags(model, effort),
    ...modeFlags,
    ...floorFlags,
    ...withStandupReadTools(tokenizeArgs(launchArgs)),
  ];
}

/**
 * The safety-floor config for a launch, with its fresh scoped worker token
 * recorded (as a sha256) on the launch row, so the floor's hold route accepts
 * holds from this launch's hook and no one else's. The worktrees of the other
 * launches of its Persona job (`jobId`, else the job the launch is linked to)
 * are its own ground too (FloorConfig.jobRoots); the live worktrees of every
 * other launch are not (FloorConfig.foreignRoots).
 */
export function launchFloorConfig(
  db: Database,
  input: { launchId: string; root: string; projectBranch?: string; strictHooks?: boolean; projectWorktreeRoot?: string; scratchId?: string; jobId?: string }
): FloorConfig {
  const { projectWorktreeRoot, jobId, ...rest } = input;
  const config = buildLaunchFloorConfig({
    ...rest,
    worktreeRoots: [getSetting(db, WORKTREE_ROOT_SETTING), projectWorktreeRoot],
    jobRoots: jobLaunchPaths(db, input.launchId, jobId),
    foreignRoots: foreignLaunchPaths(db, input.launchId, jobId),
  });
  setLaunchWorkerTokenHash(db, input.launchId, workerTokenHash(config.workerToken));
  return config;
}

/**
 * The effective permission-bypass request for a launch: the per-launch override
 * wins, else the project's `bypassPermissions` default, else on. Whether the
 * launch actually bypasses also depends on its launchArgs and on the floor being
 * installable (resolveClaudePermissionPosture).
 */
export function resolveBypassPermissions(project: Project, requestBypass?: boolean): boolean {
  return requestBypass ?? project.bypassPermissions ?? true;
}

/** What buildClaudeLaunchArgv needs to decide a Claude launch's permission posture. */
export interface ClaudeLaunchPermissions {
  /** The effective bypass request (resolveBypassPermissions). */
  bypassPermissions: boolean;
  /** Where the request came from, for the launch-log line. */
  source?: "default" | "project" | "launch";
  /** This launch's safety-floor config. Without one the launch never bypasses. */
  floor?: FloorConfig;
  /** Why the floor can't guard a bypassed launch (floorUnavailableReason), when it can't. */
  floorUnavailable?: string;
  /**
   * Why the floor hook can't run at all, whatever the mode (floorUnavailableReason
   * with `bypass: false`), when it can't. A launch that doesn't bypass still
   * carries the floor unless this is set. When the key is absent,
   * floorUnavailable stands in for it.
   */
  floorHookUnavailable?: string;
  /** The bun binary running the hook; defaults to the collector's own (process.execPath). */
  bunPath?: string;
  /** The hook entry point; defaults to FLOOR_HOOK_PATH. */
  hookPath?: string;
}

/** The permission posture a Claude launch runs under. */
export interface ClaudePermissionPosture {
  /** The `--permission-mode` injected, or undefined when the project's launchArgs carry the mode. */
  injectedMode?: "auto" | "bypassPermissions";
  /** Whether the safety-floor hook is installed through `--settings`. */
  floor: boolean;
  /** One launch-log line naming the posture and why. */
  note: string;
}

/**
 * A launch refused by the caller's checkProject (see LaunchRequest) once the
 * project it goes to is known: `status` and `body` are the HTTP refusal.
 */
export class LaunchRefusedError extends Error {
  readonly status: 400 | 409;
  readonly body: Record<string, unknown>;
  constructor(message: string, body: Record<string, unknown> = {}, status: 400 | 409 = 409) {
    super(message);
    this.name = "LaunchRefusedError";
    this.status = status;
    this.body = { error: message, ...body };
  }
}

/**
 * Why a Persona launch may not go to `target`, or null when it may: Persona
 * launches only workers that run under the safety floor, so a launch whose
 * resolved harness (the request's, else the project's, else claude) isn't
 * claude is refused. Checked once the project is known, which for an inferred
 * scratch launch is only after inference.
 */
export function personaHarnessRefusal(target: Project, harness?: HarnessId): LaunchRefusedError | null {
  const resolved = harness ?? target.harness ?? "claude";
  if (resolved === "claude") return null;
  return new LaunchRefusedError(
    `${target.id}'s ${resolved} harness has no safety floor, so Persona doesn't launch into it`,
    { harness: resolved }
  );
}

/** A launch refused because its launchArgs pin a bypass the safety floor can't guard. */
export class LaunchPermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LaunchPermissionError";
  }
}

/**
 * Decides a Claude launch's permission posture from the project's launchArgs and
 * the effective bypass request. Every bypass-capable launch carries the floor:
 *
 *   1. launchArgs that bypass on their own (`--permission-mode
 *      bypassPermissions`, `--dangerously-skip-permissions`,
 *      `--allow-dangerously-skip-permissions`) keep their flags and get the
 *      floor; when the floor can't be installed (launchArgs already pass
 *      `--settings`, no config, or floorUnavailable) the launch is refused —
 *      bypass without the floor is not allowed.
 *   2. Any other pinned `--permission-mode` holds as-is.
 *   3. A launch with bypass off runs `--permission-mode auto`.
 *   4. A bypass request the floor can't guard falls back to auto (fail closed):
 *      launchArgs that pass their own `--settings` (the floor's settings can't be
 *      merged into them), a missing config, or floorUnavailable.
 *   5. Otherwise `--permission-mode bypassPermissions` with the floor.
 *
 * Cases 2–4 still carry the floor whenever its hook can run (a config, no
 * `--settings` in launchArgs, no floorHookUnavailable). Claude Code's own
 * modes don't hold outward steps: `auto` lets a `gh pr create` or `git push` through
 * on its classifier's judgment. The hook only adds holds; a call it doesn't
 * hold gets no decision and goes through the mode's own permission flow.
 *
 * Pure, so the decision is unit-testable; launchSession logs `note`.
 */
export function resolveClaudePermissionPosture(
  launchArgs: string | undefined,
  permissions: ClaudeLaunchPermissions
): ClaudePermissionPosture {
  const mode = launchArgsPermissionMode(launchArgs);
  const conflict = launchArgsPermissionConflict(launchArgs);
  if (conflict) throw new LaunchPermissionError(conflict);
  if (launchArgsBypass(launchArgs)) {
    if (!permissions.floor) {
      throw new LaunchPermissionError(
        "Refusing to launch: this project's launchArgs bypass permissions, but no safety-floor config was supplied for the launch."
      );
    }
    if (permissions.floorUnavailable) {
      throw new LaunchPermissionError(
        `Refusing to launch: this project's launchArgs bypass permissions, but the safety floor can't be installed (${permissions.floorUnavailable}). Bypass without the floor is not allowed.`
      );
    }
    // `--dangerously-skip-permissions` is itself the bypass mode; the
    // allow-only flag merely permits switching into it, so the requested
    // posture is still injected beside it.
    const injectedMode =
      mode !== undefined || tokenizeArgs(launchArgs).includes("--dangerously-skip-permissions")
        ? undefined
        : permissions.bypassPermissions
          ? "bypassPermissions"
          : "auto";
    return {
      injectedMode,
      floor: true,
      note: "[info] permissions: bypass-capable via project launchArgs (safety floor on)",
    };
  }
  // Why the floor hook can't run in a launch that doesn't bypass, if it can't.
  const hookBlocked = launchArgsSetSettings(launchArgs)
    ? "this project's launchArgs pass their own --settings"
    : !permissions.floor
      ? "no safety-floor config for this launch"
      : "floorHookUnavailable" in permissions
        ? permissions.floorHookUnavailable
        : permissions.floorUnavailable;
  const unbypassed = (injectedMode: "auto" | undefined, level: "info" | "warn", what: string): ClaudePermissionPosture => ({
    ...(injectedMode ? { injectedMode } : {}),
    floor: !hookBlocked,
    note: `[${hookBlocked ? "warn" : level}] permissions: ${what}; ${hookBlocked ? `no safety floor (${hookBlocked})` : "safety floor on"}`,
  });
  if (mode !== undefined) return unbypassed(undefined, "info", `${mode || "(empty)"} (pinned by project launchArgs)`);
  if (!permissions.bypassPermissions) {
    const who = permissions.source === "launch" ? "this launch opted out" : "project opted out";
    return unbypassed("auto", "info", `auto (${who})`);
  }
  if (launchArgsSetSettings(launchArgs)) {
    return unbypassed("auto", "warn", "auto — this project's launchArgs pass their own --settings, so the safety-floor hook can't be merged in; not bypassing");
  }
  if (!permissions.floor) return unbypassed("auto", "warn", "auto — no safety-floor config for this launch; not bypassing");
  if (permissions.floorUnavailable) {
    return unbypassed("auto", "warn", `auto — the safety floor can't guard bypass (${permissions.floorUnavailable}); not bypassing`);
  }
  return {
    injectedMode: "bypassPermissions",
    floor: true,
    note: "[info] permissions: bypassed (safety floor on)",
  };
}

/**
 * Splits a project's `launchArgs` string into argv tokens for the `claude`
 * invocation.
 *
 * These go straight into the process argv (tmux runs `claude` directly, with
 * no shell), so a plain whitespace split is wrong: `--append-system-prompt
 * "be terse"` must stay two tokens, not four. Single and double quotes group
 * a value; everything else splits on whitespace. Deliberately not a full
 * shell parser — no variable expansion, globbing, or escapes — because these
 * are literal CLI flags, not a shell command (that is what `setup` is for).
 */
export function tokenizeArgs(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    tokens.push(m[1] ?? m[2] ?? m[3]);
  }
  return tokens;
}

/**
 * Whether a project's `launchArgs` would leave the launched session WITHOUT the
 * `standup` MCP server — which the knowledge-first steering names three tools on
 * (KNOWLEDGE_FIRST_TOOLS). The steering relies on ambient reachability: the
 * launcher passes none of the MCP-isolation flags, so a launch inherits the
 * `standup` server that scripts/setup-hooks.ts registers in `~/.claude.json`.
 *
 * `--strict-mcp-config` breaks that contract: it tells `claude` to use ONLY the
 * servers from `--mcp-config`, ignoring `~/.claude.json` entirely, so `standup`
 * (and its search_knowledge/get_knowledge_doc/propose_knowledge tools) is gone
 * (the same flag the internal subprocesses use precisely to drop the MCP
 * registration). A plain `--mcp-config` WITHOUT `--strict-mcp-config`
 * is not a stripper: `claude` MERGES those servers on top of the ambient ones, so
 * `standup` survives — hence only the strict flag counts here.
 *
 * Steering an agent to call tools that its own launch flags have removed is a
 * guaranteed dead directive, so buildOpeningPrompt uses this to SKIP the steering
 * for such a launch rather than name three unreachable tools.
 */
export function launchArgsDropStandupMcp(launchArgs: string | undefined): boolean {
  return tokenizeArgs(launchArgs).includes("--strict-mcp-config");
}

/**
 * Whether a launch on `harness` with `launchArgs`, started with `env`, can call
 * tools on the `standup` MCP server. Claude inherits the ambient ~/.claude.json
 * registration unless the flags strip it (launchArgsDropStandupMcp); Codex reads
 * its own config.toml, so it reaches the server only when that config registers
 * it (standupMcpRegisteredForCodex — `scripts/setup-hooks.ts --codex`).
 */
export function harnessReachesStandupMcp(
  harness: HarnessId,
  launchArgs: string | undefined,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (launchArgsDropStandupMcp(launchArgs)) return false;
  if (harness === "claude") return true;
  if (harness === "codex") return standupMcpRegisteredForCodex(env);
  return false;
}

/**
 * Whether a launch's session carries the knowledge-first steering: the launch's
 * harness reaches the standup MCP server (harnessReachesStandupMcp; a launch
 * with no recorded harness is a Claude launch). The gate buildOpeningPrompt
 * applies, shared by everything that follows the steering up (the
 * SubagentStart context, the Stop contribute nudge), so neither speaks to a
 * session whose launch never told it about the knowledge tools.
 */
export function launchCarriesKnowledgeSteering(
  launch: Pick<Launch, "harness">,
  project: Pick<Project, "launchArgs"> | null | undefined,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return harnessReachesStandupMcp(launch.harness ?? "claude", project?.launchArgs, env);
}

/**
 * Whether a project's `launchArgs` already pin a `--permission-mode`. When they
 * do, buildClaudeLaunchArgv does NOT inject a `--permission-mode` of its own
 * — the project's explicit mode (e.g. `plan`, `acceptEdits`) wins. Mirrors
 * launchArgsDropStandupMcp: a cheap token check over the same tokenizer.
 */
export function launchArgsSetPermissionMode(launchArgs: string | undefined): boolean {
  return launchArgsPermissionMode(launchArgs) !== undefined;
}

/** A `--permission-mode` flag in any spelling a CLI parser might accept (`--permission-mode`, `--permissionMode`, `--permission_mode`). */
const PERMISSION_MODE_FLAG = /^--permission[-_]?mode$/i;
const PERMISSION_MODE_FLAG_EQ = /^--permission[-_]?mode=/i;

/**
 * Every `--permission-mode` a project's launchArgs pin, in order (either
 * `--permission-mode <mode>` or `--permission-mode=<mode>`, in any spelling;
 * "" for a flag with no value).
 */
export function launchArgsPermissionModes(launchArgs: string | undefined): string[] {
  const tokens = tokenizeArgs(launchArgs);
  const modes: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (PERMISSION_MODE_FLAG.test(tokens[i])) {
      modes.push(tokens[i + 1] ?? "");
      i++;
    } else if (PERMISSION_MODE_FLAG_EQ.test(tokens[i])) {
      modes.push(tokens[i].slice(tokens[i].indexOf("=") + 1));
    }
  }
  return modes;
}

/**
 * The `--permission-mode` a project's launchArgs pin (either `--permission-mode
 * <mode>` or `--permission-mode=<mode>`), "" when the flag has no value, or
 * undefined when they pin none. launchArgs that pin more than one are refused
 * (launchArgsPermissionConflict), so the first is the only one.
 */
export function launchArgsPermissionMode(launchArgs: string | undefined): string | undefined {
  return launchArgsPermissionModes(launchArgs)[0];
}

/** Claude flags that put (or let) a session run without permission prompts. */
const BYPASS_FLAGS: readonly string[] = [
  "--dangerously-skip-permissions",
  "--allow-dangerously-skip-permissions",
];

/**
 * Whether a project's launchArgs bypass permissions on their own: a pinned
 * `--permission-mode bypassPermissions`, `--dangerously-skip-permissions`, or
 * `--allow-dangerously-skip-permissions`. Such a launch must carry the safety
 * floor whatever its bypass setting.
 */
export function launchArgsBypass(launchArgs: string | undefined): boolean {
  if (launchArgsPermissionModes(launchArgs).includes("bypassPermissions")) return true;
  return tokenizeArgs(launchArgs).some((t) => BYPASS_FLAGS.includes(t));
}

/**
 * Whether a launch's Claude session may be running with permissions bypassed.
 * A launch's own bypass choice (a per-launch override) isn't recorded, so every
 * Claude launch counts: text typed into its pane is held to the bypassed rules
 * (no `!` shell escape, which runs outside Claude Code's tool pipeline — and so
 * outside the safety floor and any permission prompt — in every mode). Codex
 * launches never bypass Claude's permissions.
 */
export function launchMayBeBypassed(_db: Database, launch: Launch): boolean {
  return launch.harness !== "codex";
}

/** Whether a project's launchArgs pass their own `--settings` (file or JSON). */
export function launchArgsSetSettings(launchArgs: string | undefined): boolean {
  return tokenizeArgs(launchArgs).some((t) => t === "--settings" || t.startsWith("--settings="));
}

/**
 * Why a project's launchArgs can never launch, independent of the box or the
 * worktree: they bypass permissions AND pass their own `--settings`, so the
 * floor's settings can't be merged in and the bypass would run unguarded.
 * Undefined when they can. launchSession checks this before any launch row
 * exists so the caller gets a clean 4xx.
 */
export function launchArgsPermissionConflict(launchArgs: string | undefined): string | undefined {
  const modes = launchArgsPermissionModes(launchArgs);
  if (modes.length > 1) {
    return `Refusing to launch: this project's launchArgs pin --permission-mode ${modes.length} times (${modes.map((m) => m || "(empty)").join(", ")}). Which one Claude Code honors is not something the safety floor can rely on — keep exactly one.`;
  }
  if (launchArgsBypass(launchArgs) && modes.length === 1 && modes[0] !== "bypassPermissions") {
    return `Refusing to launch: this project's launchArgs combine a bypass flag with --permission-mode ${modes[0] || "(empty)"}. Pick one posture — drop the bypass flag or the --permission-mode.`;
  }
  if (!launchArgsBypass(launchArgs) || !launchArgsSetSettings(launchArgs)) return undefined;
  return "Refusing to launch: this project's launchArgs bypass permissions and pass their own --settings, so the safety-floor hook can't be merged in. Bypass without the floor is not allowed — drop the bypass flag or the --settings flag.";
}

/** The `--allowedTools` flag spellings a project might use; both are Claude aliases. */
const ALLOWED_TOOLS_FLAGS: readonly string[] = ["--allowedTools", "--allowed-tools"];

/**
 * Folds the always-allowed read-only standup KB tools
 * (ALWAYS_ALLOWED_STANDUP_TOOLS) into a launch's `--allowedTools`, so those reads
 * never trigger a permission prompt regardless of permission mode. When the
 * project already set an `--allowedTools`, its entries are preserved and the read
 * tools appended (deduped) into that SAME flag — emitting a second `--allowedTools`
 * would be ambiguous to the CLI — keeping the flag spelling the project used.
 * Otherwise an `--allowedTools` carrying just the read tools is appended.
 *
 * Operates on already-tokenized argv (tokenizeArgs) and returns a fresh token
 * list, so it is pure and unit-testable.
 */
export function withStandupReadTools(tokens: string[]): string[] {
  const flagIdx = tokens.findIndex((t) => ALLOWED_TOOLS_FLAGS.includes(t));
  if (flagIdx === -1) {
    return [...tokens, "--allowedTools", ALWAYS_ALLOWED_STANDUP_TOOLS.join(",")];
  }
  // Claude accepts comma- or space-separated tool lists; split on either so the
  // project's existing entries survive the merge, then re-emit comma-joined.
  const valueIdx = flagIdx + 1;
  const existing = tokens[valueIdx]?.split(/[\s,]+/).filter(Boolean) ?? [];
  const merged = [...existing];
  for (const tool of ALWAYS_ALLOWED_STANDUP_TOOLS) {
    if (!merged.includes(tool)) merged.push(tool);
  }
  const out = [...tokens];
  if (valueIdx < out.length) out[valueIdx] = merged.join(",");
  else out.push(merged.join(","));
  return out;
}

export interface LaunchResult {
  launch: Launch;
  /** Human-readable log of what actually ran, surfaced in the UI on failure. */
  log: string[];
  /**
   * Resolves when the background provisioning/worktree/setup/tmux work
   * finishes (the launch row is `running` or `failed` by then). The launch
   * flow is fire-and-forget — `launchSession` returns as soon as the row
   * exists so the HTTP request doesn't hang for a minutes-long provision — so
   * this is only for callers (tests) that need to await completion. Production
   * endpoints ignore it and rely on the `onUpdate` broadcasts instead.
   */
  done?: Promise<void>;
  /**
   * Set when the host had no room and the launch is waiting in the headroom
   * queue (its row is `starting` with phase `queued`): why, and how many
   * launches are ahead of it.
   */
  queued?: { reason: string; ahead: number; note: string };
}

/** Turns a task description into a filesystem/branch-safe slug. */
function slugify(task: string): string {
  const base = task
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");

  // Always suffix: two launches with the same task text must not collide on
  // the same worktree path or branch name.
  return `${base || "task"}-${randomUUID().slice(0, 6)}`;
}

/** What the launch log shows in place of the safety floor's `--settings` JSON. */
export const REDACTED_FLOOR_SETTINGS = "<safety-floor settings>";

/**
 * The command line as the launch log prints it, with the `--settings` value
 * replaced. That JSON carries the launch's scoped worker token and floor
 * config, and the log is readable from the console. Covers the value as its
 * own argv element, as `--settings=…`, and single-quoted inside a `sh -c`
 * string. The hook token's `-e` assignment (HOOK_TOKEN_ENV) is replaced too.
 */
export function redactedCommandLine(cmd: string[]): string {
  const out: string[] = [];
  const hookTokenAssignment = new RegExp(`${HOOK_TOKEN_ENV}=[^\\s'"]+`, "g");
  for (let i = 0; i < cmd.length; i++) {
    const token = cmd[i];
    if (token === "--settings" && i + 1 < cmd.length) {
      out.push(token, REDACTED_FLOOR_SETTINGS);
      i++;
    } else if (token.startsWith("--settings=")) {
      out.push(`--settings=${REDACTED_FLOOR_SETTINGS}`);
    } else {
      out.push(
        token
          .replace(/--settings(\s+|=)('(?:[^']|'\\'')*'|"(?:[^"\\]|\\.)*"|\S+)/g, `--settings$1${REDACTED_FLOOR_SETTINGS}`)
          .replace(hookTokenAssignment, `${HOOK_TOKEN_ENV}=<redacted>`)
      );
    }
  }
  return out.join(" ");
}

async function run(
  cmd: string[],
  cwd: string,
  log: string[],
  timeoutMs: number = STEP_TIMEOUT_MS
): Promise<{ ok: boolean; output: string }> {
  log.push(`$ ${redactedCommandLine(cmd)}`);

  // The env is scrubbed of owner-side secrets and the collector's slot vars: a
  // tmux server this starts hands its environment to every pane it hosts.
  // A tmux bootstrap (`new-session -d`) runs here too and is safe to group-kill:
  // the server it starts daemonizes into a session of its own, so a timeout's
  // group kill reaches only the tmux client.
  const { ok, output } = await runStep(cmd, { cwd, env: workerEnv(), timeoutMs });
  if (output) log.push(output.slice(0, 2000));

  return { ok, output };
}

/** How long a timed-out step's process group gets between SIGTERM and SIGKILL. */
const STEP_KILL_GRACE_MS = 2000;

/**
 * How long a step's output pipes may stay open after the step itself exits. A
 * background grandchild (a credential helper, a daemon that didn't close its
 * stdio) can hold them open indefinitely; past this the output read so far is
 * kept and the step is reported as finished.
 */
const STEP_PIPE_GRACE_MS = 2000;

interface StreamPump {
  /** Everything decoded so far. */
  text(): string;
  /** Settles once the stream closes or is cancelled; rejects if `onChunk` throws. */
  done: Promise<void>;
  /** Stops reading and forwarding; `text()` keeps what was read. */
  cancel(): void;
}

/**
 * Drains a spawned stream, forwarding each decoded chunk to `onChunk` as it
 * arrives. Reading incrementally (rather than buffering to completion with
 * `new Response().text()`) is what lets a minutes-long build's output stream to
 * the console live instead of appearing all at once at the end.
 */
function pumpStream(
  stream: ReadableStream<Uint8Array>,
  onChunk?: (chunk: string) => void
): StreamPump {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let acc = "";
  let stopped = false;
  const emit = (text: string) => {
    if (!text || stopped) return;
    acc += text;
    onChunk?.(text);
  };
  const done = (async () => {
    for (;;) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch {
        break;
      }
      if (chunk.done) break;
      emit(decoder.decode(chunk.value, { stream: true }));
    }
    emit(decoder.decode());
  })();
  return {
    text: () => acc,
    done,
    cancel: () => {
      stopped = true;
      reader.cancel().catch(() => undefined);
    },
  };
}

function signalStepGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    // The whole group has already exited.
  }
}

/**
 * Process groups of steps still in flight. Steps lead their own sessions, so a
 * terminal Ctrl-C on the collector never reaches them; they are signalled when
 * the collector exits instead, rather than running on unsupervised.
 */
const liveStepGroups = new Set<number>();
let stepExitHookInstalled = false;

function trackStepGroup(pgid: number): void {
  liveStepGroups.add(pgid);
  if (stepExitHookInstalled) return;
  stepExitHookInstalled = true;
  process.once("exit", () => {
    for (const group of liveStepGroups) signalStepGroup(group, "SIGTERM");
  });
}

export interface StepOptions {
  cwd: string;
  env: Record<string, string | undefined>;
  /** Wall-clock cap; past it the step's whole process group is killed. Defaults to STEP_TIMEOUT_MS. */
  timeoutMs?: number;
  onChunk?: (chunk: string) => void;
}

export interface StepResult {
  ok: boolean;
  output: string;
  timedOut: boolean;
}

/**
 * Runs one launch step to completion, bounded by its timeout.
 *
 * The step runs in a process group of its own (`detached` makes the child a
 * session and group leader), so a timeout can signal everything the step
 * started — the `sh -c` and whatever it ran, such as a build tool, `bun install`,
 * `docker compose`, git's credential helper or ssh — rather than only the
 * direct child: SIGTERM first, then SIGKILL after STEP_KILL_GRACE_MS. Output is
 * read until the pipes close, but no longer than STEP_PIPE_GRACE_MS past the
 * step's own exit, so a descendant that escaped the group and still holds a
 * pipe can't keep the step pending.
 */
export async function runStep(cmd: string[], opts: StepOptions): Promise<StepResult> {
  const timeoutMs = opts.timeoutMs ?? STEP_TIMEOUT_MS;
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: opts.env,
    detached: true,
  });
  const signalGroup = (signal: NodeJS.Signals) => signalStepGroup(proc.pid, signal);
  const killGroup = () => {
    signalGroup("SIGTERM");
    setTimeout(() => signalGroup("SIGKILL"), STEP_KILL_GRACE_MS);
  };
  trackStepGroup(proc.pid);

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killGroup();
  }, timeoutMs);
  // The cap is on the step itself: once it has exited, only the bounded pipe
  // grace remains, and a step that exited in time is never reported as timed out.
  void proc.exited.then(() => clearTimeout(timer));

  const stdout = pumpStream(proc.stdout, opts.onChunk);
  const stderr = pumpStream(proc.stderr, opts.onChunk);
  const reads = Promise.all([stdout.done, stderr.done]);
  // Once the grace below wins the race, a later rejection has no one awaiting it.
  reads.catch(() => undefined);
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const exitedThenGrace = proc.exited.then(
    () => new Promise<void>((resolve) => (graceTimer = setTimeout(resolve, STEP_PIPE_GRACE_MS)))
  );
  try {
    await Promise.race([reads, exitedThenGrace]);
    await proc.exited;
  } catch (err) {
    // A throwing `onChunk` abandons the step; it must not run on uncapped.
    if (proc.exitCode === null && proc.signalCode === null) killGroup();
    throw err;
  } finally {
    clearTimeout(timer);
    clearTimeout(graceTimer);
    stdout.cancel();
    stderr.cancel();
    liveStepGroups.delete(proc.pid);
  }

  const read = (stdout.text() + stderr.text()).trim();
  if (!timedOut) return { ok: proc.exitCode === 0, output: read, timedOut };
  const limit = timeoutMs % 1000 === 0 ? `${timeoutMs / 1000}s` : `${timeoutMs}ms`;
  const notice = `[error] timed out after ${limit}; its process group was killed`;
  opts.onChunk?.(`${notice}\n`);
  const output = read ? `${notice}\n${read}` : notice;
  return { ok: false, output, timedOut };
}

async function runShell(
  script: string,
  cwd: string,
  log: string[],
  extraEnv?: Record<string, string>,
  timeoutMs: number = STEP_TIMEOUT_MS,
  onChunk?: (chunk: string) => void
): Promise<{ ok: boolean; output: string }> {
  // Setup and provision commands come from projects.toml and are shell strings
  // by design ("uv sync && docker compose up -d"), so they need a shell to
  // interpret them. This is the user's own config running on the user's own
  // machine — the same trust level as a Makefile — but it is arbitrary code
  // execution, so it only ever runs on an explicit launch, never on collector
  // startup.
  log.push(`$ ${script}`);
  onChunk?.(`$ ${script}\n`);

  const { ok, output } = await runStep(["/bin/sh", "-c", script], {
    cwd,
    env: { ...workerEnv(), ...extraEnv },
    timeoutMs,
    onChunk,
  });
  if (output) log.push(output.slice(0, 2000));

  return { ok, output };
}

export function tmuxAvailable(): boolean {
  return Bun.spawnSync(["which", "tmux"]).exitCode === 0;
}

/**
 * tmux rejects a command line over ~16 KB with "command too long". Short
 * single-line text at or under this rides `send-keys -l` directly; anything
 * larger is routed through a tmux buffer + bracketed paste instead. Kept well
 * under the limit for safety margin.
 */
const SEND_KEYS_LIMIT = 8000;

/**
 * Whether typing `text` into a pane must go through a tmux buffer + bracketed
 * paste rather than a direct `send-keys -l`. True when the text exceeds the
 * command-length budget (SEND_KEYS_LIMIT), OR when it spans multiple lines: a
 * literal `send-keys` of an embedded newline lands as an Enter keypress, which a
 * TUI composer treats as SUBMIT — so a multi-line opening prompt would submit at
 * its first blank line, before the rest arrived. Bracketed paste delivers the
 * whole block as one input, leaving a single explicit Enter to submit it. Pure,
 * so the delivery decision is unit-testable.
 */
export function shouldBufferPaste(text: string): boolean {
  return text.length > SEND_KEYS_LIMIT || text.includes("\n");
}

/**
 * The ordered tmux commands that type `text` into `session` and submit it with a
 * final Enter. A short single-line string rides `send-keys -l`; anything that
 * needs it (shouldBufferPaste) is loaded into a tmux buffer and bracketed-pasted
 * from `bufFile` (which the caller must have written) so its newlines don't
 * submit it early. Pure — the runtime (typeIntoPane) writes the buffer file and
 * runs these — so the delivery mechanism is unit-testable without a live pane.
 * `tmux` is the command for the session's server (sessionTmux).
 */
export function buildSubmitTextCmds(
  session: string,
  text: string,
  bufFile: string,
  bufName: string,
  tmux: readonly string[] = workerTmux()
): string[][] {
  const cmds: string[][] = [];
  if (shouldBufferPaste(text)) {
    // Load the text into a named buffer from the temp file, then bracketed-paste
    // it (`-p`) so a multi-line block lands as one input; `-d` drops the buffer
    // after. A pipeline-free pair of commands, unlike carrying the text on the
    // send-keys command line where it would blow the length limit.
    cmds.push([...tmux, "load-buffer", "-b", bufName, bufFile]);
    cmds.push([...tmux, "paste-buffer", "-d", "-p", "-b", bufName, "-t", session]);
  } else {
    // Literal (-l) so the text isn't interpreted as key names.
    cmds.push([...tmux, "send-keys", "-t", session, "-l", text]);
  }
  // A separate Enter submits — sending it with the text would make a message
  // containing "Enter" ambiguous, and keeps the paste and the submit distinct.
  cmds.push([...tmux, "send-keys", "-t", session, "Enter"]);
  return cmds;
}

/**
 * The ordered tmux key-name groups that answer an `AskUserQuestion` modal —
 * one group per question, plus a trailing Submit. Free text can't answer this
 * dialog: it's a menu that consumes navigation keys, so typed characters are
 * ignored and the agent stays blocked (the bug this exists to fix). Instead we
 * drive the menu with the keys it does understand.
 *
 * The modal opens with the first option highlighted, and Enter selects the
 * current option and advances to the next question. So a single-select answer
 * is `Down`×index then `Enter`; a multi-select walks down toggling each chosen
 * option with `Space`, then `Enter` to advance. After the last question the
 * modal shows a "Submit answers" review with Submit already highlighted, so a
 * trailing `Enter` submits — harmless as an empty line if a one-question modal
 * submitted on its own.
 *
 * `selections[i]` holds the chosen 0-based option indices for question i (a
 * single element for single-select). Pure, so the navigation is unit-testable
 * without a live pane; the caller (sendModalAnswerToLaunch) spaces the groups.
 */
export function buildModalAnswerKeys(
  selections: number[][],
  multiSelect: boolean[]
): string[][] {
  const groups: string[][] = [];
  selections.forEach((chosen, qi) => {
    const keys: string[] = [];
    if (multiSelect[qi]) {
      // Walk down once, toggling each chosen option as the highlight reaches it.
      let pos = 0;
      for (const idx of [...chosen].sort((a, b) => a - b)) {
        for (; pos < idx; pos++) keys.push("Down");
        keys.push("Space");
      }
      keys.push("Enter");
    } else {
      const idx = chosen[0] ?? 0;
      for (let i = 0; i < idx; i++) keys.push("Down");
      keys.push("Enter");
    }
    groups.push(keys);
  });
  groups.push(["Enter"]); // the Submit-answers review screen
  return groups;
}

interface ClaudeConfig {
  projects?: Record<string, Record<string, unknown>>;
  [k: string]: unknown;
}

/**
 * Returns a copy of a ~/.claude.json object with `hasTrustDialogAccepted` set
 * for each given directory — the same state clicking "Yes, I trust this
 * folder" persists. Pure, so the merge is unit-testable without touching the
 * real file. Other per-project keys are preserved.
 */
export function withTrustedDirs(config: ClaudeConfig, dirs: string[]): ClaudeConfig {
  const projects = { ...(config.projects ?? {}) };
  for (const dir of dirs) {
    projects[dir] = { ...(projects[dir] ?? {}), hasTrustDialogAccepted: true };
  }
  return { ...config, projects };
}

/** Claude Code's global config: `$CLAUDE_CONFIG_DIR/.claude.json`, else `~/.claude.json`. */
export function claudeConfigPath(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR?.trim();
  return configDir ? join(configDir, ".claude.json") : join(homedir(), ".claude.json");
}

/**
 * Pre-accepts Claude Code's workspace-trust dialog for a launch's working
 * directory.
 *
 * A launched agent has no human at its pane, and every worktree/provisioned
 * dir is a new path Claude Code hasn't seen — so without this it hangs on the
 * "Is this a project you trust?" dialog forever and never starts (no
 * SessionStart, no session, nothing in the feed). This writes the trust flag
 * the way clicking "Yes" would.
 *
 * Both the path as passed and its realpath are trusted, since Claude Code keys
 * trust by the resolved cwd. Defensive: a missing config is created, but an
 * unparseable one is left untouched — never clobber the user's real config;
 * the launch just falls back to showing the dialog. Atomic temp-file rename so
 * a crash mid-write can't truncate the shared file.
 */
function trustLaunchDir(launchCwd: string, log: string[]): void {
  const configPath = claudeConfigPath();

  const dirs = new Set<string>([launchCwd]);
  try {
    dirs.add(realpathSync(launchCwd));
  } catch {
    // launchCwd should exist by now; the plain-path key is still written.
  }

  let config: ClaudeConfig = {};
  if (existsSync(configPath)) {
    try {
      config = JSON.parse(readFileSync(configPath, "utf8")) as ClaudeConfig;
    } catch {
      log.push(
        `[warn] ${configPath} is unparseable — skipping trust pre-accept; the agent may sit on the folder-trust dialog`
      );
      return;
    }
  }

  try {
    const updated = withTrustedDirs(config, [...dirs]);
    const tmp = `${configPath}.standup-${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(updated, null, 2));
    renameSync(tmp, configPath);
  } catch (err) {
    log.push(`[warn] couldn't pre-accept folder trust: ${(err as Error).message}`);
  }
}

/**
 * Creates an isolated worktree for a task, runs the project's setup command
 * in it, and starts a detached tmux session running `claude` there.
 *
 * tmux rather than a bare spawn because Claude Code is a TUI: it needs a
 * terminal, and the user needs to be able to attach later
 * (`tmux -S ~/.local/share/standup/tmux/workers attach -t <name>`, workerTmuxSocket). Detached means the session outlives this
 * request and the collector process.
 *
 * The launch row is written before any slow work so the UI can show
 * "starting" immediately; failures update it in place rather than
 * disappearing.
 */
export async function launchSession(
  db: Database,
  {
    project,
    task,
    label,
    model,
    effort,
    codexModel,
    codexEffort,
    kind,
    inPlace,
    persona,
    allowProjectInference = true,
    checkProject,
    requester,
    retrievalUser,
    launchedBy,
    planGate,
    bypassPermissions,
    orchestrationProfile,
    reuseWorktreePath,
    idempotencyKey,
    attemptGroup,
    pipeline,
    pipelineOverride,
    pipelineJobId,
    harness: requestHarness,
  }: LaunchRequest,
  onUpdate?: (launch: Launch) => void,
  /**
   * The active embedding provider/config, threaded so the launcher can retrieve
   * product/spec knowledge for the task and inject it into the opening prompt
   * (roadmap r8). Optional: with none passed, product retrieval falls back to
   * FTS-only recall, and an automatic/internal launch that omits it entirely
   * still gets the code-first steering — just no product block.
   *
   * `contextQuery` overrides the text used to RETRIEVE product/spec docs (not
   * the prompt shown to the agent). When a ticket fires the launch, the caller
   * passes the linked ticket's title+body here so product retrieval is driven
   * by that ticket's own context rather than the launch task string (which
   * carries boilerplate like "Implement this fix."). Absent, retrieval uses the
   * task, so an ordinary launch is unchanged. Realizes roadmap r8's "when a
   * linked ticket/spec exists, inject the relevant product docs".
   */
  retrieval?: {
    embeddingProvider?: EmbeddingProvider | null;
    embeddingConfig?: EmbeddingConfig;
    contextQuery?: string;
  },
  /**
   * Injectable seams, defaulting to the real implementations. `buildSpawnArgv`
   * routes a launch through the selected harness's adapter; `deliverPrompt` types
   * a Claude launch's opening prompt into the pane via send-keys once it's ready
   * (a `claude` wrapper script can drop a positional prompt). A test injects stubs to assert
   * the resolved harness and the delivery without spawning any agent or driving a
   * real tmux pane. Production callers omit both.
   */
  deps: {
    buildSpawnArgv?: (harness: HarnessId, spec: SpawnArgvSpec) => string[];
    deliverPrompt?: (
      session: string,
      prompt: string,
      launchId: string,
      log: string[]
    ) => Promise<void>;
    /**
     * Launch-time project inferrer for a project-less run, injectable so a test
     * can decide the match without spawning a model. Defaults to the real cheap
     * Haiku matcher (inferMainProject). Consulted ONLY when the incoming project
     * is `scratch`; an explicit-project launch never calls it.
     */
    inferProject?: (input: InferMainProjectInput) => Promise<string | null>;
    /**
     * Why the safety floor can't be installed for a launch working in `dirs`,
     * or undefined when it can. Defaults to floorUnavailableReason (the hook
     * script on disk plus the Claude settings files that could disable hooks);
     * a test injects a fixed answer instead of reading the real box.
     */
    floorUnavailable?: (dirs: string[]) => string | undefined;
    /**
     * The host-headroom queue this launch waits in when the host has no room
     * for another worker. Defaults to the collector's launchQueue; a test
     * injects one over a fake host reading.
     */
    queue?: LaunchQueue;
    /** The data dir the launch's review token file is written under; defaults to standupDataDir(). */
    dataDir?: string;
  } = {}
): Promise<LaunchResult> {
  const queue = deps.queue ?? launchQueue;
  const buildArgv = deps.buildSpawnArgv ?? buildSpawnArgv;
  const deliverPrompt = deps.deliverPrompt ?? deliverOpeningPromptToClaude;
  // Generated up front so the project-routing decision's audit row names the launch it routed.
  const launchId = randomUUID();
  const inferProject =
    deps.inferProject ?? ((input) => inferMainProject(input, undefined, { db, alias: launchedBy ?? null, launchId }));
  const checkFloor = deps.floorUnavailable ?? ((dirs: string[]) => floorUnavailableReason(dirs));
  const checkFloorHook = deps.floorUnavailable ?? ((dirs: string[]) => floorUnavailableReason(dirs, { bypass: false }));
  const displayName = label ?? task;
  const slug = slugify(displayName);

  // A project-less launch (the incoming project is `scratch`) would otherwise
  // run in the empty scratch directory with none of a project's code. BEFORE any
  // provisioning, ask the cheap matcher which registered project this task
  // belongs to; on a confident single match, launch AS that project — swapping
  // in its repos/provision/setup/launchSubdir/branch/worktreeRoot below so its
  // workspace is provisioned and the agent starts inside its code. An ambiguous
  // / NONE / errored inference leaves the launch in `scratch`, exactly as
  // before. Never for a bootstrap run (its point is a real repo's stable HEAD),
  // and only when there's a task to match on. Best-effort: any failure falls
  // back to scratch and never throws. The inference is a Haiku call of up to
  // ~20s, but a project launch already provisions for minutes, so paying it up front to land
  // the agent in the right workspace is the right trade.
  if (allowProjectInference && project.id === "scratch" && kind !== "bootstrap" && task.trim()) {
    const candidates = getProjects(db)
      .filter((p) => p.id !== "scratch" && !p.reserved)
      .map((p) => ({ id: p.id, name: p.name, repos: p.repos }));
    if (candidates.length > 0) {
      try {
        const inferredId = await inferProject({
          task,
          cwd: join(resolveWorktreeRoot(db, project), project.id, slug),
          candidates,
        });
        if (inferredId) {
          const inferredProject = getProject(db, inferredId);
          if (inferredProject && !inferredProject.reserved) {
            console.log(
              `[infer] launching project-less run as ${inferredId} — provisioning its workspace`
            );
            project = inferredProject;
          }
        }
      } catch (err) {
        // inferMainProject already swallows its own failures, but an injected
        // inferrer might throw — stay in scratch rather than fail the launch.
        console.log(`[infer] error ${(err as Error).message}`);
      }
    }
  }
  checkProject?.(project);

  const worktreeRoot = resolveWorktreeRoot(db, project);

  // A `provision` command replaces `git worktree add` — the working dir is
  // whatever that command produces (e.g. a whole multi-repo workspace), not a git
  // worktree, so there's no branch and cleanup can't be a git op.
  const provisionCmd = project.provision?.trim();
  const usesProvision = !!provisionCmd;

  // Which agent CLI this launch spawns, resolved most-specific-wins: the
  // per-launch choice from the composer, else the project's own `harness`
  // default, else `claude`. So an unspecified harness launches Claude (the
  // default harness) exactly as before; `codex` builds its launch command
  // through the Codex harness adapter instead. A pre-generated launch id lets the
  // codex event-log sidecar path be computed before the launch row is written.
  const harness: HarnessId = requestHarness ?? project.harness ?? "claude";
  const codexEventLog =
    harness === "codex" ? join(tmpdir(), `standup-codex-${launchId}.jsonl`) : undefined;

  // Codex's model + reasoning effort ride their own launch columns and are
  // consulted ONLY for a codex launch — a Claude launch stores neither (they are
  // meaningless on its row and would just muddy telemetry). Passed through
  // verbatim, applied only when set: an unset value stays NULL, which buildCodexArgv
  // treats as the Codex CLI's own default (the composer pre-fills the defaults, so
  // a console launch carries them; an API caller may omit them for the CLI default).
  const launchCodexModel = harness === "codex" ? codexModel : undefined;
  const launchCodexEffort = harness === "codex" ? codexEffort : undefined;

  // Symmetrically, the Claude `--model`/`--effort` aliases are consulted ONLY for
  // a claude launch. A non-claude launch stores neither: they are meaningless on
  // its row and — because a codex session has no Claude transcript to read a live
  // model from — the UI would otherwise surface a stale Claude model (e.g. an
  // "opus" pick left set when the composer's harness dropdown flipped to Codex)
  // as the codex session's model. buildSpawnArgv's codex branch already ignores
  // them, so this only nulls the persisted row + threaded spec. Mirrors
  // launchCodexModel/launchCodexEffort so the leak is closed in both directions.
  const launchModel = harness === "claude" ? model : undefined;
  const launchEffort = harness === "claude" ? effort : undefined;

  const repo = project.repos[0];
  const repoPath = repo ? repo.replace(/^~/, homedir()) : "";

  // Reuse the project's existing repo checkout instead of a fresh worktree.
  // The caller's flag always wins — an explicit opt-in survives everything
  // below. When it's unset, the default depends on how many people share this
  // collector: in multiplayer (≥2 aliases connected, or the manual override)
  // the safe default is a fresh worktree per launch so users don't collide on
  // one working tree, so the project's own in-place default is ignored; a
  // single-user local collector keeps that project default (today's behavior).
  // Never in-place for a provisioned build (no single repo to reuse), a
  // repo-less project (nothing to reuse), or a bootstrap run (its point is a
  // stable git HEAD in an isolated worktree — see kind === "bootstrap" below).
  const multiplayer = isMultiplayerMode(db);
  const requestedInPlace = inPlace ?? (multiplayer ? false : project.inPlace ?? false);
  const useInPlace =
    requestedInPlace && !usesProvision && !!repo && kind !== "bootstrap";

  // Run in a caller-supplied existing worktree (the fixer path), so the agent
  // opens the very files the change under review touched — that change lives in
  // the ticket's implementation worktree, not on the base branch. Only a real,
  // existing directory qualifies; a provisioned build and a bootstrap run own
  // their own working dir, so neither honors it.
  const reuseTree =
    reuseWorktreePath?.trim() && !usesProvision && kind !== "bootstrap" && existsSync(reuseWorktreePath.trim())
      ? reuseWorktreePath.trim()
      : "";
  // The launch works in an already-prepared tree — the project repo (in-place)
  // or a caller-supplied worktree (reuse). Both skip provisioning + setup and
  // leave the directory untouched on cleanup.
  const useExistingTree = useInPlace || !!reuseTree;

  // True when this project would have launched in-place on a single-user
  // collector but multiplayer flipped it to a fresh worktree. Surfaced in the
  // launch log so the reason the working dir isn't the repo is visible, not a
  // mystery. Only when the caller didn't ask either way (an explicit choice is
  // honored silently) and in-place was actually reachable for this project.
  const multiplayerFlippedToWorktree =
    multiplayer &&
    inPlace === undefined &&
    !!project.inPlace &&
    !usesProvision &&
    !!repo &&
    kind !== "bootstrap";

  // A scratch run: no repo to check out and no provision command, so there's
  // no worktree at all — just a fresh empty directory to run `claude` in. Lets
  // the console fire off an ad-hoc session without configuring a project.
  //
  // Only ordinary launches fall back to scratch. A bootstrap run must have a
  // real repo (or provision) — its whole point is a stable git HEAD for the
  // knowledge it stamps with generated_from_sha — so a repo-less bootstrap is
  // still a misconfiguration, not a scratch session.
  const isScratch = !usesProvision && !repo && kind !== "bootstrap";

  // Whether this launch goes through the plan-approval gate. Never for a
  // bootstrap run — it produces knowledge, not a reviewable change, so there's
  // nothing to plan-gate. Otherwise the per-launch override wins over the
  // project default (resolvePlanGate). When on, a plan_approval row is opened
  // below and the opening prompt carries the plan-first steering.
  //
  // A gate is only satisfiable when the agent can actually reach submit_plan.
  // If this project's launchArgs strip the standup MCP server
  // (--strict-mcp-config), submit_plan is unreachable, so opening a gate would
  // strand the launch in 'awaiting_plan' forever — the agent can never submit,
  // and the row never surfaces for approval (getPendingPlanApprovals lists only
  // 'awaiting_approval'), which in turn wedges the ticket in 'developing' with
  // no in-app recovery. So don't open an unsatisfiable gate: the run proceeds
  // ungated and planGateSkippedNoMcp surfaces why in the launch log below.
  const planGateRequested = kind !== "bootstrap" && resolvePlanGate(project, planGate);
  const planGateSkippedNoMcp =
    planGateRequested && launchArgsDropStandupMcp(project.launchArgs);
  // A Codex launch can't reach submit_plan either — the standup MCP server rides
  // the Claude config Codex doesn't inherit — so an opened gate would strand it
  // the same way. Skip the gate for a non-Claude harness rather than wedge it.
  const planGateSkippedCodex = planGateRequested && harness !== "claude";
  const usePlanGate = planGateRequested && !planGateSkippedNoMcp && !planGateSkippedCodex;

  // The orchestration profile this launch runs under, resolved the same way as
  // the plan gate: the per-launch override NAME wins, else the project ->
  // personal -> global default (resolveActiveProfile). Never for a bootstrap run
  // — it produces knowledge, not a reviewable change, so there is no develop ->
  // deploy -> review loop to steer, mirroring the plan gate's bootstrap
  // exclusion. When one resolves, buildOpeningPrompt injects its ordered steps as
  // steering (formatOrchestrationInstruction); the completion choke enforces the
  // gates. The alias is the launching `requester` — the same identity whose
  // personalization the opening prompt already carries.
  const resolvedOrchestrationProfile =
    kind !== "bootstrap"
      ? (resolveActiveProfile(db, {
          launchOverride: orchestrationProfile,
          projectId: project.id,
          alias: requester,
        }) ?? undefined)
      : undefined;

  // For in-place, the launch's "worktree_path" is the real repo — the same
  // shape used by adoptSession — so cleanup can guard on it identically. A reuse
  // launch points at the caller-supplied worktree. All other modes land under
  // the project's own worktree root.
  const worktreePath = reuseTree
    ? reuseTree
    : useInPlace
      ? repoPath
      : join(worktreeRoot, project.id, slug);
  const tmuxSession = `standup-${project.id}-${slug}`.slice(0, 100);

  const branch = usesProvision
    ? "(provisioned — no worktree)"
    : reuseTree
      ? "(reused worktree)"
      : useInPlace
        ? "(in-place — existing workspace)"
        : isScratch
          ? "(scratch — no repo)"
          : `standup/${slug}`;

  // Where the agent actually starts and setup runs. For a provisioned
  // workspace the package sits in its packages dir, so launchSubdir points there.
  const subdir = project.launchSubdir?.trim();
  const launchCwd = subdir ? join(worktreePath, subdir) : worktreePath;

  // Cheap preconditions run synchronously and throw, so the caller can turn a
  // misconfiguration into a 400 before any launch row exists. A worktree
  // launch needs a repo; a bootstrap run does too (see isScratch above). A
  // provision command or a scratch run makes its own working dir, so neither
  // needs repos[0].
  if (!usesProvision && !repo && !isScratch) {
    throw new Error(
      `Project "${project.id}" has no repos configured — nothing to check out. Add a repos entry in projects.toml.`
    );
  }
  if (!usesProvision && !isScratch && !existsSync(repoPath)) {
    throw new Error(`Repo path does not exist: ${repoPath}`);
  }
  if (!tmuxAvailable()) {
    throw new Error(
      "tmux is not installed — launches need it to host the session. " +
        "Run `bun run scripts/check-deps.ts` (installs it via Homebrew), then retry."
    );
  }
  // launchArgs that bypass permissions while passing their own --settings can
  // never carry the safety floor, so refuse them before any row exists.
  const permissionConflict = harness === "claude" ? launchArgsPermissionConflict(project.launchArgs) : undefined;
  if (permissionConflict) throw new LaunchPermissionError(permissionConflict);

  // The branch a fresh worktree is cut from, resolved against the repo now so
  // a repo without the configured branch (a `mainline` repo under the
  // default `main`) still launches, and one with no usable branch is refused
  // before any row exists. The launch records it as its base, so every diff,
  // review and landing check reads the same branch. A repo path that isn't a
  // git checkout fails in the detached provisioning step, as it always has.
  const worktreeBase =
    !useExistingTree && !usesProvision && !isScratch && isGitWorkTree(repoPath, defaultGitRunner)
      ? resolveBaseBranch(repoPath, project.branch, defaultGitRunner, project.id)
      : undefined;
  // A launch that cuts no worktree still records a base its checks can read:
  // a reused worktree keeps the base of the launch that made it, and an
  // in-place or provisioned launch reads the repo's (never throwing).
  const recordedBase =
    worktreeBase?.branch ??
    (reuseTree ? findLaunchByCwd(db, reuseTree)?.baseBranch?.trim() || recordedBaseBranch(reuseTree, project.branch, defaultGitRunner) : undefined) ??
    (!isScratch && repoPath ? recordedBaseBranch(repoPath, project.branch, defaultGitRunner) : project.branch);

  // Dispatcher guards, checked before any row exists so the caller turns a
  // refusal into a clean 4xx. Per-worktree serialization: one active run per
  // worktree (worktree-kind launches always get a unique slug path, so this
  // only bites an in-place launch reusing a repo that's already in flight).
  // Plus a global concurrency cap so a runaway dispatcher can't spawn unbounded
  // agents.
  if (getActiveTaskRunByWorktree(db, worktreePath)) {
    throw new Error(
      `A task is already running in this worktree (${worktreePath}). ` +
        "Wait for it to finish or stop it before launching another."
    );
  }
  if (countActiveTaskRuns(db) >= MAX_ACTIVE_TASK_RUNS) {
    throw new Error(
      `Too many active task runs (cap ${MAX_ACTIVE_TASK_RUNS}). ` +
        "Wait for one to finish, or raise STANDUP_MAX_ACTIVE_TASK_RUNS."
    );
  }

  const launch = createLaunch(db, {
    id: launchId,
    kind,
    projectId: project.id,
    // The label when there is one — this is what the console renders.
    task: displayName,
    worktreePath,
    branch,
    baseBranch: recordedBase,
    tmuxSession,
    status: "starting",
    model: launchModel,
    effort: launchEffort,
    provisioned: usesProvision,
    inPlace: useExistingTree,
    // Records which harness this launch actually spawns (unset = claude, so a
    // Claude launch row is byte-for-byte the pre-harness one) and, for codex,
    // the JSONL sidecar its event stream is tee'd to for fleet telemetry.
    harness: harness === "claude" ? undefined : harness,
    codexEventLog,
    // The Codex model + reasoning effort this launch was started with (unset for a
    // Claude launch), recorded so telemetry can show what a codex run actually used.
    codexModel: launchCodexModel,
    codexEffort: launchCodexEffort,
    // The launch's client-visible actor — what the "Mine" lens judges a
    // still-provisioning, sessionless launch by (see the task-run ledger row
    // below, which carries the same requester for the dispatcher lifecycle).
    requester,
    launchedBy,
    // Dedup key for a redelivered launch request; the UNIQUE index makes a
    // second launch with the same key fail rather than double-spawn.
    idempotencyKey,
    // The request's own bypass choice (unset = the project's default), kept so
    // a respawn of this launch's pane runs under the same posture.
    bypassPermissions,
  });

  // The dispatcher ledger row for this launch — the durable lifecycle a
  // coworker tracks (queued now; running once the pane spawns; then a terminal
  // state reported by the agent or inferred by the reconciliation sweep). It
  // shares the launch's worktree path, which is how the sweep finds the pane
  // and how a reporting session's row is located.
  const taskRun = createTaskRun(db, {
    id: randomUUID(),
    kind: kind ?? "worktree",
    projectId: project.id,
    worktreePath,
    requester,
    // When this launch is one of N best-of-N attempts, its ledger run carries
    // the shared group id (and starts attempt_status 'pending') so the compare +
    // pick flow can find all N runs and mark a winner.
    attemptGroup,
  });

  // Open the plan-approval gate the instant the launch row exists, so it's in
  // 'awaiting_plan' before the agent can call submit_plan and before a human
  // could look for it. Scoped to the launch (getPlanApprovalByLaunch); the
  // calling session's cwd resolves to the launch first, then to that launch's
  // own gate — never to a stale or sibling gate that happens to share the tree.
  if (usePlanGate) {
    createPlanApproval(db, {
      launchId: launch.id,
      projectId: project.id,
      worktreePath,
    });
  }

  // The launch's delivery pipeline, started with the row so a worker's first
  // pipeline call finds it. Its definition is briefed in the opening prompt.
  const pipelineRun = startLaunchPipeline(db, launch, {
    kind,
    reusedWorktree: !!reuseTree,
    scratch: isScratch,
    provisioned: usesProvision,
    requester,
    pipeline,
    standupMcp: harness === "claude" && !launchArgsDropStandupMcp(project.launchArgs),
    attemptGroup,
    pipelineOverride,
    jobId: pipelineJobId,
  });

  // A host without room for another worker queues the launch instead of
  // failing it: the row stays `starting` with phase `queued`, and the slow work
  // below waits for the queue to release it (the maintenance tick drains the
  // queue as headroom returns) or to drop it (stopped while waiting).
  const ticket = queue.admit(launch.id);
  let queued: { reason: string; ahead: number; note: string } | undefined;
  let shown: Launch;
  // A throw before the detached work below takes over would otherwise leave
  // the entry queued, to be started later by a drain with nothing to run it.
  try {
    queued = ticket
      ? { reason: ticket.reason, ahead: ticket.ahead, note: queuedLaunchNote(ticket) }
      : undefined;
    if (queued) {
      setLaunchPhase(db, launch.id, "queued");
      appendLaunchLog(db, launch.id, `[info] ${queued.note}\n`);
    }
    shown = queued ? { ...launch, phase: "queued" } : launch;

    // Surface the launch the moment its row exists, BEFORE the slow work.
    // Provisioning a multi-repo workspace runs for minutes; the launch (and its
    // task) has to be visible in the feed immediately, not appear only once the
    // work finishes — and the HTTP request must not hang that whole time.
    onUpdate?.(shown);
  } catch (err) {
    queue.cancel(launch.id);
    throw err;
  }

  // Everything expensive — provision or worktree, setup, tmux — runs detached.
  // `launchSession` returns as soon as this is kicked off; status transitions
  // (starting → running/failed) reach the UI through onUpdate, not the return.
  const done = (async () => {
    const log: string[] = [];

    // Persist streamed output to the launch row as it arrives, so the
    // workspace-create + build output — otherwise buried in a local array that
    // used to be discarded — is watchable (the console polls the row) while
    // provisioning, instead of appearing all at once when the work finishes.
    const emitLog = (chunk: string) => {
      appendLaunchLog(db, launch.id, chunk);
    };
    // Record which slow step we're in and broadcast it so the sidebar can show
    // real movement instead of one static "provisioning…" for the whole wait.
    const setPhase = (phase: LaunchPhase) => {
      setLaunchPhase(db, launch.id, phase);
      onUpdate?.({ ...launch, status: "starting", phase });
    };

    // Abandon this launch if its ledger run has left `queued` while the slow
    // provisioning above was still running. The case that matters: a best-of-N
    // loser whose setup/provision runs for minutes gets picked-against —
    // pickAttempt cancels its still-`queued` run and the pick endpoint's
    // stopLaunch finds no pane to kill (this one never spawned). Were we to spawn
    // `claude` now, a losing agent would run unsupervised in a superseded worktree
    // that nobody can stop, and the `queued -> running` promotion below would
    // itself throw an illegal `cancelled -> running` transition. So: kill a pane
    // if one was already spawned (the tight post-spawn race), then fail the launch
    // cleanly instead. A harmless no-op for an ordinary launch, whose run stays
    // `queued` right up to the spawn. Returns true when it aborted the launch.
    const abandonIfRunNoLongerQueued = async (): Promise<boolean> => {
      const current = getTaskRun(db, taskRun.id);
      if (current?.status === "queued") return false;
      if (tmuxSession && tmuxAvailable() && tmuxSessionExists(tmuxSession)) {
        await run(sessionTmux(tmuxSession, "kill-session", "-t", `=${tmuxSession}`), "/", log);
      }
      const reason = `Superseded before start — the run is ${current?.status ?? "gone"}; abandoning this launch so no losing agent keeps running`;
      log.push(`[info] ${reason}`);
      emitLog(`[info] ${reason}\n`);
      updateLaunchStatus(db, launch.id, "failed", reason);
      onUpdate?.({ ...launch, status: "failed", error: reason, phase: undefined });
      return true;
    };

    try {
      if (ticket) {
        // Dropped while waiting: whoever dropped it (a stop) already settled the row.
        if (!(await ticket.ready)) return;
        emitLog("[info] The host has room now; starting.\n");
      }

      if (multiplayerFlippedToWorktree) {
        const note =
          "Multiplayer: launching in a fresh worktree instead of in-place so shared users don't collide. Opt into in-place explicitly to override.";
        log.push(`[info] ${note}`);
        emitLog(`[info] ${note}\n`);
      }
      // An already-prepared tree (in-place or a reused worktree) skips the whole
      // provisioning branch: the working dir already exists, and nothing under
      // the worktree root needs to be created. Everything below is guarded on
      // `useExistingTree` so this path skips straight to trust-and-spawn.
      if (!useExistingTree) {
        await mkdir(join(worktreeRoot, project.id), { recursive: true });
      }

      if (!useExistingTree) setPhase("provisioning");
      if (useExistingTree) {
        // Nothing to provision — the existing checkout/worktree is reused as-is.
        // Cleanup will refuse to touch it (see cleanupLaunch's inPlace guard).
      } else if (usesProvision) {
        // Runs from the parent; must leave a ready directory at $STANDUP_WORKDIR
        // (a workspace tool is pointed there, e.g. with --root "$STANDUP_WORKDIR").
        const provisioned = await runShell(
          provisionCmd!,
          join(worktreeRoot, project.id),
          log,
          {
            STANDUP_WORKDIR: worktreePath,
            STANDUP_WORKDIR_NAME: slug,
            STANDUP_REPO: repoPath,
            STANDUP_BRANCH: branch,
            STANDUP_PROJECT: project.id,
          },
          PROVISION_TIMEOUT_MS,
          emitLog
        );
        if (!provisioned.ok) {
          throw new Error(`provision command failed: ${provisioned.output.slice(0, 400)}`);
        }
        if (!existsSync(worktreePath)) {
          throw new Error(
            `provision command exited 0 but did not create ${worktreePath}. ` +
              `It must produce that exact directory — pass --root "$STANDUP_WORKDIR" (or --name "$STANDUP_WORKDIR_NAME").`
          );
        }
      } else if (isScratch) {
        // No repo, no provision — just a fresh empty directory to run in.
        // Nothing to check out; the agent starts on a clean slate.
        await mkdir(worktreePath, { recursive: true });
      } else {
        const isRepo = await run(
          ["git", "rev-parse", "--is-inside-work-tree"],
          repoPath,
          log
        );
        if (!isRepo.ok) {
          throw new Error(`Not a git repository: ${repoPath}`);
        }

        const base = worktreeBase?.ref || "HEAD";
        if (worktreeBase?.note) {
          const note = `Base branch: ${worktreeBase.note}; using "${worktreeBase.ref}" (the repo's ${worktreeBase.source === "current" ? "checked-out branch" : "default branch"}).`;
          log.push(`[info] ${note}`);
          emitLog(`[info] ${note}\n`);
        }
        // The repository's own hooks are for its owner's checkout; the worker
        // gets an empty hooks dir so its commits and checkouts run none, and
        // the checkout that creates the worktree runs none either.
        const hooksDir = workerHooksDir(standupDataDir());
        const noHooks = ensureEmptyHooksDir(hooksDir).ok ? ["-c", `core.hooksPath=${hooksDir}`] : [];
        const worktree = await run(
          // --no-track: a base read as `origin/<branch>` must not become the
          // work branch's upstream, or a bare pull/push would target it.
          ["git", ...noHooks, "worktree", "add", "--no-track", "-b", branch, worktreePath, base],
          repoPath,
          log
        );
        if (!worktree.ok) {
          throw new Error(`git worktree add failed: ${worktree.output.slice(0, 300)}`);
        }
        const isolated = isolateWorktreeHooks(worktreePath, hooksDir);
        if (!isolated.ok) {
          const warning = `[warn] worktree hooks not isolated, the repository's hooks will run here: ${isolated.error}`;
          log.push(warning);
          emitLog(`${warning}\n`);
        }
      }

      if (subdir && !existsSync(launchCwd)) {
        throw new Error(
          `launchSubdir "${subdir}" does not exist under the working dir (${launchCwd}). ` +
            `Check the provision command produced it.`
        );
      }

      // Reusing an already-set-up workspace (in-place or a reused worktree)
      // skips `setup` on purpose; re-running it (a `bun install`, a
      // `docker compose up`) on every launch was exactly the friction the mode
      // exists to remove. Bootstrap and normal worktree launches still run setup
      // in their fresh checkouts.
      if (project.setup && !useExistingTree) {
        setPhase("building");
        const setup = await runShell(
          project.setup,
          launchCwd,
          log,
          undefined,
          STEP_TIMEOUT_MS,
          emitLog
        );
        // Non-fatal: a failed `docker compose up` shouldn't discard a
        // correctly-created worktree. Surface it and let the agent start.
        if (!setup.ok) {
          log.push("[warn] setup command failed — starting the session anyway");
          emitLog("[warn] setup command failed — starting the session anyway\n");
        }
      }
      // What provisioning and setup left behind is the baseline a
      // not-applicable waiver reads the workspace against, not the agent's work.
      if (usesProvision) {
        try {
          await captureProvisionSnapshot(db, launch.id);
        } catch (err) {
          const note = `[warn] couldn't record the provisioned workspace's checkouts: ${(err as Error).message}`;
          log.push(note);
          emitLog(note + "\n");
        }
      }

      setPhase("starting");
      // Steering an agent to call the standup knowledge tools is a dead
      // directive if this project's own launch flags strip the standup MCP
      // server; buildOpeningPrompt drops the steering in that case, so surface
      // why here rather than leaving it a silent no-op.
      if (launchArgsDropStandupMcp(project.launchArgs)) {
        const note =
          `[warn] knowledge-first steering skipped: this project's launchArgs (--strict-mcp-config) remove the standup MCP server, so ${KNOWLEDGE_FIRST_TOOLS.join("/")} would be unreachable`;
        log.push(note);
        emitLog(note + "\n");
      } else if (harness === "codex" && !standupMcpRegisteredForCodex()) {
        const note =
          `[warn] knowledge-first steering skipped: ${codexConfigPath()} doesn't register the standup MCP server (run scripts/setup-hooks.ts --codex), so ${KNOWLEDGE_FIRST_TOOLS.join("/")} would be unreachable`;
        log.push(note);
        emitLog(note + "\n");
      }
      // A plan gate the agent could never satisfy is worse than none: the same
      // stripped MCP server that hides submit_plan would leave the gate open
      // forever and wedge the ticket. It was dropped above (usePlanGate);
      // surface why rather than leaving the missing pause a mystery.
      if (planGateSkippedNoMcp) {
        const note =
          "[warn] plan-approval gate skipped: this project's launchArgs (--strict-mcp-config) remove the standup MCP server, so submit_plan is unreachable and the gate could never be satisfied — running ungated instead";
        log.push(note);
        emitLog(note + "\n");
      }
      // A Codex launch can't reach submit_plan (the standup MCP server rides the
      // Claude config Codex doesn't inherit), so an opened gate would strand it
      // the same way — surface why it ran ungated rather than leave it a mystery.
      if (planGateSkippedCodex) {
        const note =
          "[warn] plan-approval gate skipped: the codex harness doesn't inherit the standup MCP server, so submit_plan is unreachable and the gate could never be satisfied — running ungated instead";
        log.push(note);
        emitLog(note + "\n");
      }
      // Claude Code shows a folder-trust dialog for an unseen cwd, and a launched
      // agent has nobody to click through it — so pre-accept trust or it hangs
      // and never starts. Codex has no such dialog, so this is claude-only.
      if (harness === "claude") trustLaunchDir(launchCwd, log);

      // Retrieve the most relevant knowledge for this task and inject it into
      // the opening prompt alongside the code-first steering (roadmap r8):
      // CODE knowledge for the touched area (the "code-first" push) AND the
      // product/spec intent that grounds it. Best-effort: the retrievals never
      // throw (and the embedding request is timeout-bounded), so a retrieval
      // hiccup or a slow embedding endpoint just leaves the block(s) empty
      // rather than failing or stalling the launch. The query is the
      // linked-ticket context when one fired this launch (higher-signal than
      // the task string with its "Implement this fix." boilerplate); otherwise
      // the task itself.
      const retrievalQuery = resolveRetrievalQuery(task, retrieval?.contextQuery);
      // The brief becomes 1–4 focused queries, a task type and the actions
      // it forbids (the heuristic, or the model rewrite when enabled). A
      // prohibition in the task string still counts when the linked ticket
      // is what gets searched.
      const rewritten = await rewriteInjectionQueries(retrievalQuery);
      const plan: InjectionPlan =
        retrievalQuery === task
          ? rewritten
          : {
              ...rewritten,
              forbidden: [...new Set([...rewritten.forbidden, ...forbiddenActions(task, rewritten.taskType)])],
            };
      const planNote = `[info] injection queries: ${describeInjectionPlan(plan)}`;
      log.push(planNote);
      emitLog(planNote + "\n");
      const provider = retrieval?.embeddingProvider ?? null;
      const config = retrieval?.embeddingConfig ?? {};
      // Scope the injected set to the launching user via the SERVER-RESOLVED
      // identity (retrievalUser), NOT the caller-attributable `requester`: an
      // agent sees only that user's global ∪ project ∪ user docs. Because
      // retrievalUser is scopingUser(c) at the route (ignoring the forgeable
      // body `actor` and mapping anonymous → undefined), a caller cannot steer
      // which user's user-scoped docs get injected by naming a victim. An
      // untrusted/anonymous or automatic launch carries no retrievalUser, so
      // the gate falls back safely to global ∪ project (no user docs leak).
      // The launching project's related projects (relatedProjects) count as
      // its own for project-scoped docs, so a split product's sibling repos
      // share their product/spec and code knowledge.
      const audience: ScopeAudience = {
        projectId: project.id,
        user: retrievalUser,
        relatedProjectIds: relatedProjects(project.id, getProjects(db)),
      };
      // Docs the task (or its linked ticket) names by slug are pinned ahead
      // of the ranked hits in their block, within the same scope gate.
      const pins = resolveNamedPins(db, [task, retrieval?.contextQuery ?? ""].join("\n"), audience);
      const codeGated: GatedCandidate<SearchResult>[] = [];
      const productGated: GatedCandidate<SearchResult>[] = [];
      const [codeDocs, productDocs] = await Promise.all([
        retrieveCodeKnowledge(db, project.id, plan, provider, config, audience, codeGated, pins),
        retrieveProductKnowledge(db, project.id, plan, provider, config, audience, productGated, pins),
      ]);
      const codeBlock = formatCodeKnowledgeInjection(codeDocs);
      const productBlock = formatProductKnowledgeInjection(productDocs);
      let codeContext = codeBlock.text;
      const productContext = productBlock.text;
      if (codeContext || productContext) {
        // Counts what the char budget let into the prompt, not the retrieved top-K.
        const namedCount = [...codeBlock.includedDocs, ...productBlock.includedDocs].filter((d) => d.namedInTask).length;
        const note = `[info] injected ${codeBlock.includedDocs.length} code + ${productBlock.includedDocs.length} product/spec doc(s) into the opening prompt${
          namedCount > 0 ? ` (${namedCount} named in task)` : ""
        }`;
        log.push(note);
        emitLog(note + "\n");
      }
      // Retrieval telemetry: record each top-K candidate as injected or
      // dropped by the char budget, and the candidates the injection gates
      // held back, keyed to this launch. Best-effort — a logging failure must
      // never break or slow the launch — and correlated by launch_id, not
      // session_id, since the session doesn't exist yet; the usage read
      // reaches the session through launches.session_id once it attaches.
      try {
        recordKnowledgeRetrievals(
          db,
          buildInjectRetrievalRecords({
            codeDocs,
            codeIncluded: codeBlock.includedDocs,
            productDocs,
            productIncluded: productBlock.includedDocs,
            launchId: launch.id,
            query: retrievalQuery,
            queryProject: project.id,
            codeGated,
            productGated,
            placementOf: placementsFor(db, [
              ...codeDocs,
              ...productDocs,
              ...[...codeGated, ...productGated].map((g) => g.hit),
            ]),
            hostUser: hostUserAlias(),
          }),
          retrievalUser
        );
      } catch (err) {
        log.push(`[warn] failed to record injection telemetry: ${String(err)}`);
      }
      // A Codex worker posts no hooks, so the SessionStart knowledge push a
      // Claude worker gets from its hook rides the brief instead: the docs
      // over the push bar the injection above did not already carry.
      if (harness === "codex") {
        const pushBlock = await launchKnowledgePush(db, {
          projectId: project.id,
          brief: retrievalQuery,
          launchId: launch.id,
          injected: [...codeBlock.includedDocs, ...productBlock.includedDocs],
          search: (projectId, query, options) => searchKnowledge(db, projectId, query, provider, options, config),
        });
        if (pushBlock) codeContext += `\n\n---\n${pushBlock}`;
      }

      // The ephemeral cross-agent activity view, injected so a launching agent
      // can compose with in-flight work instead of colliding. Deliberately
      // OUTSIDE the durable knowledge retrieval/injection path — a recency
      // filter, not institutional context. FAIL-OPEN: a query hiccup injects
      // nothing and never breaks the launch.
      let activityContext = "";
      try {
        activityContext = launchActivityContext(db, project.id, retrievalUser);
      } catch {
        activityContext = "";
      }

      // Last checkpoint before spawning: bail if the run was cancelled (a pick
      // superseding this attempt) while we provisioned, so we never start an
      // agent whose worktree is already abandoned.
      if (await abandonIfRunNoLongerQueued()) return;

      // Pass the task as the initial prompt so the agent starts on it, and so
      // the session title derives from real work rather than being untitled.
      // Delivered via a temp file (see buildLaunchArgv) so a large prompt
      // doesn't blow past tmux's command-length limit.
      const openingPrompt = buildOpeningPrompt(
        db,
        task,
        requester,
        project.id,
        project.launchArgs,
        productContext,
        codeContext,
        usePlanGate,
        harness,
        // Codex runs at the worktree root, so the opening prompt points it at the
        // launchSubdir under it; Claude ignores it (it starts in the subdir).
        subdir,
        activityContext,
        // The resolved orchestration profile (if any) — its ordered steps are
        // injected as steering, threaded like usePlanGate above.
        resolvedOrchestrationProfile,
        // An active delivery pipeline's stages are briefed too.
        pipelineRun?.status === "active" ? pipelineRun.definition : undefined,
        // A code_review stage that can't apply (no review to cut) is briefed as
        // such, so the worker never asks the owner for an issue id it won't need.
        pipelineRun?.status === "active" ? codeReviewNotApplicable(db, pipelineRun, getLaunch(db, pipelineRun.launchId)) : null
      );
      // The Claude launch's permission posture: bypassed behind the safety
      // floor unless the launch or project opts out, the project's launchArgs
      // pin their own mode, or the floor can't be installed for this worktree
      // (resolveClaudePermissionPosture). Checked here, after setup, so the
      // worktree's own .claude settings are on disk. A launchArgs bypass the
      // floor can't guard throws and fails the launch. Codex runs under its
      // adapter's profile and takes none of this.
      let permissions: ClaudeLaunchPermissions | undefined;
      let workerTokenFile: string | undefined;
      let hookToken: string | undefined;
      if (harness === "claude") {
        workerTokenFile = launchReviewTokenFile(db, launch.id, log, deps.dataDir);
        permissions = {
          bypassPermissions: resolveBypassPermissions(project, bypassPermissions),
          source:
            bypassPermissions !== undefined
              ? "launch"
              : project.bypassPermissions !== undefined
                ? "project"
                : "default",
          floor: launchFloorConfig(db, {
            launchId: launch.id,
            root: worktreePath,
            projectBranch: launch.baseBranch ?? project.branch,
            strictHooks: !!persona && useExistingTree,
            projectWorktreeRoot: project.worktreeRoot,
            jobId: pipelineJobId,
          }),
          floorUnavailable: checkFloor([...new Set([worktreePath, launchCwd])]),
          floorHookUnavailable: checkFloorHook([...new Set([worktreePath, launchCwd])]),
        };
        const posture = resolveClaudePermissionPosture(project.launchArgs, permissions);
        log.push(posture.note);
        emitLog(posture.note + "\n");
        // The floor's settings carry the hooks that present this token.
        if (posture.floor) hookToken = issueLaunchHookToken(db, launch.id);
      }

      // Build the detached-tmux spawn command for the selected harness through
      // the routing seam (buildSpawnArgv). Claude takes the existing argv
      // verbatim (its `--model`/`--effort`); Codex builds a `codex exec --json`
      // launch through its adapter with its OWN model + reasoning effort, teeing
      // the event stream to the sidecar for telemetry. Each harness reads only its
      // own knobs — the Claude aliases and the Codex values never cross over.
      const spawnArgv = buildArgv(harness, {
        tmuxSession,
        launchCwd,
        // The worktree/workspace ROOT (launchCwd is the launchSubdir cwd). Codex
        // runs at the root so a multi-package workspace agent can write across
        // siblings; Claude keeps launchCwd.
        workspaceRoot: worktreePath,
        prompt: openingPrompt,
        launchId: launch.id,
        model: launchModel,
        effort: launchEffort,
        codexModel: launchCodexModel,
        codexEffort: launchCodexEffort,
        launchArgs: project.launchArgs,
        isScratch,
        codexEventLog,
        permissions,
        workerTokenFile,
        hookToken,
      });
      const spawned = await run(spawnArgv, launchCwd, log);
      if (!spawned.ok) {
        throw new Error(`tmux new-session failed: ${spawned.output.slice(0, 300)}`);
      }

      // A pick could have cancelled this run in the tight window between spawning
      // the pane and promoting it. If so, kill the pane we just started rather
      // than leaving a losing agent live, and skip the (now-illegal) transition.
      if (await abandonIfRunNoLongerQueued()) return;

      // Deliver the opening prompt to Claude by typing it into the pane once the
      // input box is ready — a `claude` wrapper script can drop a positional prompt,
      // so the session was spawned interactively (buildInteractiveLaunchArgv) and
      // the task is submitted here instead. Claude-only: Codex takes its prompt as
      // a `codex exec` argument, which works, so it's delivered by its own launch
      // command. A delivery hiccup is logged, not fatal; a prompt that can never
      // be delivered fails the launch, and its idle pane is closed.
      if (harness === "claude") {
        const before = log.length;
        try {
          await deliverPrompt(tmuxSession, openingPrompt, launch.id, log);
        } catch (err) {
          for (const line of log.slice(before)) emitLog(`${line}\n`);
          await run(sessionTmux(tmuxSession, "kill-session", "-t", `=${tmuxSession}`), "/", log).catch(() => undefined);
          throw err;
        }
        for (const line of log.slice(before)) emitLog(`${line}\n`);
      }

      updateLaunchStatus(db, launch.id, "running");
      // The pane is up: the run is now live. It stays `running` until the agent
      // self-reports (report_task) or the reconciliation sweep finds its pane
      // gone (lost).
      updateTaskRunStatus(db, taskRun.id, "running");
      onUpdate?.({ ...launch, status: "running", phase: undefined });
    } catch (err) {
      const message = (err as Error).message;
      try {
        updateLaunchStatus(db, launch.id, "failed", message);
        // The launch never reached a live pane, so the run failed before it ran.
        updateTaskRunStatus(db, taskRun.id, "failed", { error: message });
        log.push(`[error] ${message}`);
        emitLog(`[error] ${message}\n`);
        onUpdate?.({ ...launch, status: "failed", error: message, phase: undefined });
      } catch {
        // The store was closed while this detached provisioning was still
        // settling (a test tears down once the launch row reaches a terminal
        // state, before `done` finishes). The launch is abandoned; swallow the
        // closed-DB write rather than surface it as an unhandled rejection —
        // which, in Bun's single shared test process, would otherwise be
        // re-attributed to whatever unrelated test is running at that moment.
      }
    }
  })();

  // `done` keeps writing to `db` (log, phase, final status) AFTER this returns.
  // A caller that never awaits `done` must NOT close the store while it settles:
  // a write against a closed bun:sqlite Database throws "Database has closed",
  // and the throw inside `done`'s own catch is an unhandled rejection. Tests use
  // a :memory: store and simply leave it open (it's reclaimed at process exit)
  // rather than racing that teardown.
  return { launch: shown, log: [], done, ...(queued ? { queued } : {}) };
}

/**
 * Adopts an existing session: resumes it under a tmux session Standup owns,
 * converting a monitored session into one it can read, type into, and stop.
 *
 * `claude --resume <id>` reuses the original session id (there is a
 * `--fork-session` flag to opt out), so the resumed process reports the same
 * `session_id` in its hooks. Standup's existing history, checkpoints and
 * events stay attached — which is the whole point, and why forking would be
 * the wrong default here.
 *
 * Runs in the session's original cwd, deliberately **not** a fresh worktree:
 * the conversation being resumed refers to files at those paths, and moving
 * it into a checkout would invalidate its own context.
 *
 * That makes the launch row's `worktreePath` the user's real repository,
 * which is why the row is marked `kind: "adopted"` — `cleanupLaunch` refuses
 * to run `git worktree remove` against those.
 *
 * Only ended sessions can be adopted. Resuming a live one would put two
 * processes on the same transcript, and Standup cannot stop the original
 * because it does not own it.
 */
export interface AdoptDeps {
  /** Why the safety floor can't be installed in `dirs`; defaults to floorUnavailableReason. */
  floorUnavailable?: (dirs: string[]) => string | undefined;
  /** Spawns a command; defaults to the launcher's own runner. */
  run?: (cmd: string[], cwd: string, log: string[]) => Promise<{ ok: boolean; output: string }>;
  /** Whether tmux is installed; defaults to tmuxAvailable. */
  tmuxAvailable?: () => boolean;
  /** Whether a tmux session exists; defaults to tmuxSessionExists. */
  tmuxSessionExists?: (name: string) => boolean;
  /** The data dir the launch's review token file is written under; defaults to standupDataDir(). */
  dataDir?: string;
}

/**
 * The `claude --resume` argv an adoption runs: the session's own id, then the
 * same model/effort, permission posture and project launchArgs a launch of its
 * project gets (buildClaudeLaunchArgv) — bypassed behind the safety floor or
 * `--permission-mode auto`, never a bare resume that would fall back to
 * whatever mode the box defaults to.
 */
export function buildAdoptArgv(
  sessionId: string,
  model: ClaudeModel | undefined,
  effort: ClaudeEffort | undefined,
  launchArgs: string | undefined,
  permissions: ClaudeLaunchPermissions
): string[] {
  const [claude, ...rest] = buildClaudeLaunchArgv(model, effort, launchArgs, permissions);
  return [claude, "--resume", sessionId, ...rest];
}

export async function adoptSession(
  db: Database,
  session: { id: string; cwd: string; title: string; projectId: string; endedAt?: Date; endReason?: SessionEndReason },
  deps: AdoptDeps = {}
): Promise<LaunchResult> {
  const log: string[] = [];
  const spawn = deps.run ?? run;
  const hasTmux = deps.tmuxAvailable ?? tmuxAvailable;
  const paneExists = deps.tmuxSessionExists ?? tmuxSessionExists;
  const checkFloor = deps.floorUnavailable ?? ((dirs: string[]) => floorUnavailableReason(dirs));
  const checkFloorHook = deps.floorUnavailable ?? ((dirs: string[]) => floorUnavailableReason(dirs, { bypass: false }));

  if (!session.endedAt) {
    throw new Error(
      "Only an ended session can be adopted — resuming a live one would run two processes against the same conversation. Stop it in its terminal first."
    );
  }
  // A stale end is the reaper's guess from silence; hooks carry no PID, so
  // nothing here can prove the original process exited. Refuse rather than
  // risk a second live copy.
  if (session.endReason === "stale") {
    throw new LaunchRefusedError(
      "This session was ended for going silent, not by its own SessionEnd, so it may still be running in its terminal. Resume it there; its next hook brings it back.",
      { code: "stale_end" }
    );
  }
  if (!existsSync(session.cwd)) {
    throw new Error(`Session's working directory no longer exists: ${session.cwd}`);
  }
  if (!hasTmux()) {
    throw new Error(
      "tmux is not installed — adoption needs it to host the session. Run `bun run scripts/check-deps.ts`, then retry."
    );
  }

  const tmuxSession = `standup-adopt-${session.id.slice(0, 8)}`;

  if (paneExists(tmuxSession)) {
    throw new Error(`This session already has a tmux session: ${tmuxSession}`);
  }

  // The resume runs under the same posture rules as a launch of its project; a
  // project whose launchArgs can never carry the floor is refused before any row.
  const project = getProject(db, session.projectId);
  const permissionConflict = launchArgsPermissionConflict(project?.launchArgs);
  if (permissionConflict) throw new LaunchPermissionError(permissionConflict);

  // The session's previous launch carries the model/effort it last ran with
  // (the launch-time pick, or a later mid-session switch), so the resume keeps
  // them instead of falling back to Claude's defaults.
  const prior = getLaunchBySession(db, session.id);

  const launch = createLaunch(db, {
    id: randomUUID(),
    kind: "adopted",
    projectId: session.projectId,
    task: session.title || `Resumed session ${session.id.slice(0, 8)}`,
    // The real repo, not a checkout — see the cleanup guard above.
    worktreePath: session.cwd,
    branch: "(adopted — no worktree)",
    baseBranch: prior?.baseBranch,
    tmuxSession,
    sessionId: session.id,
    status: "starting",
    model: prior?.model,
    effort: prior?.effort,
  });

  try {
    // The resumed conversation keeps the scratch dir its first launch had; the floor guards that dir as the pane's TMPDIR.
    const scratchId = launchScratchId(db, launch);
    const permissions: ClaudeLaunchPermissions = {
      bypassPermissions: project ? resolveBypassPermissions(project) : true,
      source: project?.bypassPermissions !== undefined ? "project" : "default",
      floor: launchFloorConfig(db, {
        launchId: launch.id,
        root: session.cwd,
        projectBranch: prior?.baseBranch ?? project?.branch,
        strictHooks: !!prior?.inPlace && !!personaJobForLaunch(db, prior.id),
        projectWorktreeRoot: project?.worktreeRoot,
        scratchId,
        jobId: prior ? personaJobForLaunch(db, prior.id)?.job.id : undefined,
      }),
      floorUnavailable: checkFloor([session.cwd]),
      floorHookUnavailable: checkFloorHook([session.cwd]),
    };
    const posture = resolveClaudePermissionPosture(project?.launchArgs, permissions);
    log.push(posture.note);
    const hookToken = posture.floor ? issueLaunchHookToken(db, launch.id) : undefined;
    const workerTokenFile = launchReviewTokenFile(db, launch.id, log, deps.dataDir);
    const spawned = await spawn(
      buildInteractiveLaunchArgv(
        tmuxSession,
        session.cwd,
        buildAdoptArgv(session.id, launch.model, launch.effort, project?.launchArgs, permissions),
        launch.id,
        { ...reviewTokenEnv(workerTokenFile), ...hookTokenEnv(hookToken) },
        scratchId
      ),
      session.cwd,
      log
    );
    if (!spawned.ok) {
      throw new Error(`tmux new-session failed: ${spawned.output.slice(0, 300)}`);
    }

    updateLaunchStatus(db, launch.id, "running");
    return { launch: { ...launch, status: "running" }, log };
  } catch (err) {
    const message = (err as Error).message;
    updateLaunchStatus(db, launch.id, "failed", message);
    log.push(`[error] ${message}`);
    return { launch: { ...launch, status: "failed", error: message }, log };
  }
}

/**
 * Respawns a launch's own worker pane with `claude --resume` of its session:
 * the same tmux session name, `cwd`, model/effort, permission posture and
 * scratch dir its first spawn had, with a fresh floor worker token, hook token
 * and review token, each recorded on the same launch row. Returns the spawn
 * log; throws when the pane can't be started. Used to resume a worker paused
 * for idleness (launch-resume.ts), which owns the launch and session rows.
 */
export async function respawnLaunchPane(
  db: Database,
  launch: Launch,
  cwd: string,
  deps: AdoptDeps = {}
): Promise<string[]> {
  const log: string[] = [];
  const spawn = deps.run ?? run;
  const checkFloor = deps.floorUnavailable ?? ((dirs: string[]) => floorUnavailableReason(dirs));
  const checkFloorHook = deps.floorUnavailable ?? ((dirs: string[]) => floorUnavailableReason(dirs, { bypass: false }));
  if (!launch.tmuxSession || !launch.sessionId) {
    throw new Error("This launch has no tmux session or Claude session to resume.");
  }
  const project = getProject(db, launch.projectId);
  const permissionConflict = launchArgsPermissionConflict(project?.launchArgs);
  if (permissionConflict) throw new LaunchPermissionError(permissionConflict);

  const dirs = [...new Set([launch.worktreePath, cwd])];
  const scratchId = launchScratchId(db, launch);
  // The launch request's own bypass choice, when it made one, outranks the
  // project's current default, as it did at the first spawn.
  const permissions: ClaudeLaunchPermissions = {
    bypassPermissions: launch.bypassPermissions ?? (project ? resolveBypassPermissions(project) : true),
    source:
      launch.bypassPermissions !== undefined
        ? "launch"
        : project?.bypassPermissions !== undefined
          ? "project"
          : "default",
    floor: launchFloorConfig(db, {
      launchId: launch.id,
      root: launch.worktreePath,
      projectBranch: launch.baseBranch ?? project?.branch,
      strictHooks: !!launch.inPlace && !!personaJobForLaunch(db, launch.id),
      projectWorktreeRoot: project?.worktreeRoot,
      scratchId,
    }),
    floorUnavailable: checkFloor(dirs),
    floorHookUnavailable: checkFloorHook(dirs),
  };
  const posture = resolveClaudePermissionPosture(project?.launchArgs, permissions);
  log.push(posture.note);
  const hookToken = posture.floor ? issueLaunchHookToken(db, launch.id) : undefined;
  const workerTokenFile = launchReviewTokenFile(db, launch.id, log, deps.dataDir);
  const spawned = await spawn(
    buildInteractiveLaunchArgv(
      launch.tmuxSession,
      cwd,
      buildAdoptArgv(launch.sessionId, launch.model, launch.effort, project?.launchArgs, permissions),
      launch.id,
      { ...reviewTokenEnv(workerTokenFile), ...hookTokenEnv(hookToken) },
      scratchId
    ),
    cwd,
    log
  );
  if (!spawned.ok) {
    throw new Error(`tmux new-session failed: ${spawned.output.slice(0, 300)}`);
  }
  return log;
}

/**
 * Capabilities that exist only for launched sessions.
 *
 * Standup observes monitored sessions but *owns* launched ones — it created
 * their tmux session, so it can read their screen, type into them, and stop
 * them. The access asymmetry runs the other way: you have a terminal for a
 * monitored session and none for a launched one, which is exactly why the
 * launched side needs these.
 *
 * `tmux send-keys` into a pane Standup did not launch would type into
 * someone's own terminal, so these functions all refuse to touch a session
 * Standup didn't start.
 */

/**
 * Marks the active task-run occupying a launch's worktree `cancelled` when a
 * human stops or cleans it up — a deliberate stop is `cancelled`, not the
 * `lost` the reconciliation sweep would otherwise infer from the vanished pane.
 *
 * Skipped for adopted launches: they never opened a task-run of their own, and
 * their `worktreePath` is the shared real repo, so a match there could belong
 * to an unrelated in-place run. A worktree/in-place launch's path holds at most
 * one active run (the per-worktree guard), so cancelling by path is exact.
 */
function cancelWorktreeTaskRun(db: Database, launch: Launch): void {
  if (launch.kind === "adopted") return;
  const run = getActiveTaskRunByWorktree(db, launch.worktreePath);
  if (run) updateTaskRunStatus(db, run.id, "cancelled");
}

function assertOwned(launch: Launch): string {
  if (!launch.tmuxSession) {
    throw new Error(
      "This launch has no tmux session — it either failed before starting or was already cleaned up."
    );
  }
  return launch.tmuxSession;
}

/** Whether a session by this name exists on the workers' server, or, for a listed legacy session, on the legacy server (sessionAlive). */
export function tmuxSessionExists(name: string): boolean {
  return sessionAlive(name);
}

/** Current visible screen of a launched session. */
export async function captureLaunchOutput(
  launch: Launch,
  lines = 200
): Promise<{ output: string; alive: boolean }> {
  const session = assertOwned(launch);

  if (!tmuxAvailable() || !tmuxSessionExists(session)) {
    return { output: "", alive: false };
  }

  const proc = Bun.spawn(
    // -p prints to stdout; -S -N starts N lines back into scrollback so the
    // reply is still visible after it scrolls past the viewport.
    sessionTmux(session, "capture-pane", "-p", "-t", session, "-S", `-${lines}`),
    { stdout: "pipe", stderr: "pipe" }
  );

  const output = await new Response(proc.stdout).text();
  await proc.exited;

  return { output: output.trimEnd(), alive: true };
}

/**
 * Types `text` into a tmux pane and submits it with Enter, choosing the delivery
 * mechanism by shape (buildSubmitTextCmds / shouldBufferPaste): a short
 * single-line string rides `send-keys -l`; a large or multi-line one goes through
 * a tmux buffer loaded from a temp file, then a bracketed paste so it lands as
 * ONE input instead of submitting on the first newline. `key` names the transient
 * buffer + temp file uniquely (a launch id). Shared by the human-facing
 * sendToLaunch and the opening-prompt delivery so the send-keys discipline lives
 * in one place.
 */
function typeIntoPane(
  session: string,
  text: string,
  key: string
): { ok: boolean; error?: string; unstaged?: boolean } {
  const useBuffer = shouldBufferPaste(text);
  // Staged text is a brief or a reply meant for one pane, so it sits 0600 in a
  // private directory rather than in the shared temp dir.
  const sendDir = paneDeliveryDir();
  const bufFile = join(sendDir, `standup-send-${key}.txt`);
  const bufName = `standup-send-${key}`;
  if (useBuffer) {
    const unsafe = ensurePrivateDir(sendDir);
    if (unsafe) return { ok: false, unstaged: true, error: `cannot stage the text for the session: ${unsafe}` };
  }
  try {
    if (useBuffer) writePrivateFileSync(bufFile, text);
    const cmds = buildSubmitTextCmds(session, text, bufFile, bufName, sessionTmux(session));
    for (const cmd of cmds) {
      const res = Bun.spawnSync(cmd);
      if (res.exitCode !== 0) {
        // cmd[1] is the tmux subcommand (load-buffer / paste-buffer / send-keys).
        return { ok: false, error: `failed to ${cmd[1]} into the session` };
      }
    }
    return { ok: true };
  } finally {
    if (useBuffer) {
      try {
        unlinkSync(bufFile);
      } catch {
        // Best-effort cleanup; a leftover temp file is harmless.
      }
    }
  }
}

/**
 * Markers that Claude Code's interactive input box is up and ready to receive the
 * opening prompt — as opposed to still on a startup interstitial (e.g. an
 * "auto permission mode" notice), which would otherwise eat the
 * keystrokes. The composer's shortcut-hint footer is the stable cross-version
 * signal; matching it means the input box is drawn and interactive.
 */
const CLAUDE_PROMPT_READY_MARKERS = ["for shortcuts"];

/** Reads a launched pane's current visible screen synchronously (empty on error). */
export function capturePaneSync(session: string): string {
  const res = Bun.spawnSync(sessionTmux(session, "capture-pane", "-p", "-t", session));
  if (res.exitCode !== 0) return "";
  return res.stdout?.toString() ?? "";
}

/**
 * Polls a launched Claude pane until its input box is ready for the opening
 * prompt, so delivery doesn't race the startup interstitial (e.g. an
 * "auto permission mode" notice) and lose the keystrokes.
 *
 * Ready is signalled two ways, checked every `pollMs`: the composer's
 * shortcut-hint footer appears (CLAUDE_PROMPT_READY_MARKERS — the direct signal),
 * or the screen SETTLES (two consecutive identical non-empty captures), meaning
 * the TUI has finished rendering past any transient interstitial. Bounded by
 * `timeoutMs`; returns false on timeout (the caller still delivers best-effort)
 * and false the instant the pane is gone (nothing to deliver to), so it never
 * hangs. A short poll loop, deliberately not a blind fixed sleep.
 */
export async function waitForClaudePromptReady(
  session: string,
  { timeoutMs = 30_000, pollMs = 400 }: { timeoutMs?: number; pollMs?: number } = {}
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let prev: string | null = null;
  for (;;) {
    if (!tmuxSessionExists(session)) return false;
    const out = capturePaneSync(session);
    const trimmed = out.trim();
    if (trimmed) {
      if (CLAUDE_PROMPT_READY_MARKERS.some((m) => out.includes(m))) return true;
      // Screen unchanged since the last poll → the TUI has settled and the input
      // box is drawn; safe to type even if the footer wording drifted.
      if (prev !== null && trimmed === prev) return true;
      prev = trimmed;
    }
    if (Date.now() >= deadline) return false;
    await Bun.sleep(pollMs);
  }
}

/** The opening prompt can never reach the pane, so the launch cannot start its task. */
export class OpeningPromptUndeliverableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpeningPromptUndeliverableError";
  }
}

/**
 * Delivers a launched Claude session's opening prompt by typing it into the pane
 * via `tmux send-keys` once the input box is ready, then submitting it — the fix
 * for a `claude` wrapper script dropping a positional prompt (the session is
 * spawned interactively; see buildInteractiveLaunchArgv). Waits for readiness
 * first (waitForClaudePromptReady) so the startup interstitial can't swallow the
 * keystrokes, then delivers ONCE (typeIntoPane) — no positional fallback, so
 * there is no double-submit.
 *
 * Best-effort for transient trouble: a missing pane or a send-keys hiccup is
 * logged and the launch still proceeds (the human can type into the pane),
 * rather than tearing down a live session. A multi-line prompt that can't be
 * staged at all (the private pane-delivery directory is unusable) throws
 * OpeningPromptUndeliverableError instead: every multi-line launch would sit at
 * an empty prompt, so the launch fails with the reason. Claude-only — Codex
 * takes its prompt as a `codex exec` argument, which works, so its delivery is
 * left alone.
 */
export async function deliverOpeningPromptToClaude(
  session: string,
  prompt: string,
  launchId: string,
  log: string[]
): Promise<void> {
  if (!tmuxAvailable() || !tmuxSessionExists(session)) {
    log.push("[warn] opening-prompt delivery skipped: the tmux session is not running");
    return;
  }
  const ready = await waitForClaudePromptReady(session);
  if (!ready) {
    log.push(
      "[warn] Claude's input prompt wasn't detected before the timeout — delivering the opening prompt anyway"
    );
  }
  const res = typeIntoPane(session, prompt, `open-${launchId}`);
  if (res.unstaged) {
    throw new OpeningPromptUndeliverableError(`the opening prompt could not be delivered: ${res.error}`);
  }
  if (res.ok) {
    log.push("[info] delivered the opening prompt via tmux send-keys");
  } else {
    log.push(
      `[warn] failed to deliver the opening prompt via send-keys (${res.error ?? "unknown"}) — attach the pane and type it in (${sessionTmux(session, "attach", "-t", session).join(" ")})`
    );
  }
}

/**
 * Types a line into a launched session, as if the human had typed it in that
 * terminal. Unlike a steer, this lands immediately — which is safe here only
 * because Standup owns the pane and the human explicitly targeted it.
 */
export async function sendToLaunch(
  launch: Launch,
  text: string
): Promise<{ ok: boolean; error?: string }> {
  const session = assertOwned(launch);

  if (!tmuxAvailable() || !tmuxSessionExists(session)) {
    return { ok: false, error: "tmux session is no longer running" };
  }

  return typeIntoPane(session, text, launch.id);
}

/**
 * Selects option `digit` of the tool-permission dialog open in a launched
 * session, once the pane shows the expected dialog. `refusal` reads the
 * captured pane and says why it is not that dialog (null when it is); on a
 * refusal nothing is typed. Claude Code's dialog takes a digit key as the
 * choice itself, so only the digit is sent: no Enter follows that could land
 * on a dialog queued behind this one, where Enter picks the default "Yes".
 * `typed` says whether the digit was sent; when the same dialog is still up
 * after it, the result is not ok.
 */
export async function answerPermissionDialog(
  launch: Launch,
  digit: string,
  refusal: (screen: string) => string | null,
  { settleMs = 2_000, pollMs = 200 }: { settleMs?: number; pollMs?: number } = {}
): Promise<{ ok: boolean; typed: boolean; error?: string }> {
  const session = assertOwned(launch);
  if (!/^[1-9]$/.test(digit)) return { ok: false, typed: false, error: `option ${digit} is not one digit` };
  if (!tmuxAvailable() || !tmuxSessionExists(session)) {
    return { ok: false, typed: false, error: "tmux session is no longer running" };
  }
  const why = refusal(capturePaneSync(session));
  if (why) return { ok: false, typed: false, error: why };
  const res = Bun.spawnSync(sessionTmux(session, "send-keys", "-t", session, "-l", digit));
  if (res.exitCode !== 0) return { ok: false, typed: false, error: "failed to send the key into the session" };
  const deadline = Date.now() + settleMs;
  for (;;) {
    await Bun.sleep(pollMs);
    if (!tmuxSessionExists(session) || refusal(capturePaneSync(session)) !== null) return { ok: true, typed: true };
    if (Date.now() >= deadline) {
      return { ok: false, typed: true, error: "the dialog is still open after its option key; answer it in the terminal" };
    }
  }
}

/**
 * Markers that Claude Code's `AskUserQuestion` review screen — the
 * "Ready to submit your answers?" step with Submit highlighted — is up. The
 * submit Enter is only accepted once this screen is present.
 */
const MODAL_SUBMIT_READY_MARKERS = ["Submit answers", "Ready to submit"];

/**
 * Whether a captured pane is showing the review screen and is safe to submit:
 * either a review-screen marker is present (the direct signal), or the screen
 * has SETTLED — two consecutive identical non-empty captures, meaning the TUI
 * has finished transitioning onto the review after the last question's Enter,
 * even if the wording drifted across versions. Pure, so the readiness decision
 * is unit-testable without a live pane.
 */
export function isModalSubmitReady(current: string, prev: string | null): boolean {
  const trimmed = current.trim();
  if (!trimmed) return false;
  if (MODAL_SUBMIT_READY_MARKERS.some((m) => current.includes(m))) return true;
  return prev !== null && trimmed === prev;
}

/**
 * Polls a launched pane until its `AskUserQuestion` review screen is up, so the
 * final submit Enter isn't fired while Claude Code is still rendering the review
 * after the last question's Enter — the TUI drops keys that land before that
 * screen settles, leaving the agent parked on the review forever. Ready is
 * signalled two ways, checked every `pollMs` (see isModalSubmitReady): a
 * review-screen marker appears, or the screen settles. Bounded by `timeoutMs`;
 * returns false on timeout (the caller submits best-effort) and false the
 * instant the pane is gone. Modeled on waitForClaudePromptReady.
 */
export async function waitForModalSubmitReady(
  session: string,
  { timeoutMs = 8_000, pollMs = 250 }: { timeoutMs?: number; pollMs?: number } = {}
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let prev: string | null = null;
  for (;;) {
    if (!tmuxSessionExists(session)) return false;
    const out = capturePaneSync(session);
    if (isModalSubmitReady(out, prev)) return true;
    if (out.trim()) prev = out.trim();
    if (Date.now() >= deadline) return false;
    await Bun.sleep(pollMs);
  }
}

/**
 * Answers an `AskUserQuestion` modal in a launched session by driving its menu
 * with navigation keys (see buildModalAnswerKeys). A beat between question
 * groups lets the modal finish animating onto the next question before its keys
 * arrive — the same reason the free-text answer path spaces its sends, and
 * without it the second group is dropped mid-transition.
 *
 * The final group is the Submit-answers Enter. Claude Code only renders the
 * review screen after the last question's Enter lands, and drops keys that
 * arrive before it settles — so the submit is gated on the review screen being
 * present (waitForModalSubmitReady) rather than the flat inter-group spacing,
 * then verified with a bounded retry. A stray Enter after a successful submit is
 * a no-op on the empty prompt, so retrying is safe.
 */
export async function sendModalAnswerToLaunch(
  launch: Launch,
  groups: string[][]
): Promise<{ ok: boolean; error?: string }> {
  const session = assertOwned(launch);

  if (!tmuxAvailable() || !tmuxSessionExists(session)) {
    return { ok: false, error: "tmux session is no longer running" };
  }

  for (const [i, keys] of groups.entries()) {
    const isSubmit = i === groups.length - 1;
    if (isSubmit) await waitForModalSubmitReady(session);

    const res = Bun.spawnSync(sessionTmux(session, "send-keys", "-t", session, ...keys));
    if (res.exitCode !== 0) {
      return { ok: false, error: "failed to send keys into the session" };
    }

    // Space out the per-question groups; the submit was already gated above.
    if (!isSubmit) await new Promise((r) => setTimeout(r, 400));
  }

  // If the review screen is still up after the submit, the Enter landed
  // mid-transition and was dropped — resend it, bounded, with a short settle
  // between so a slow render isn't mistaken for a dropped key.
  for (let attempt = 0; attempt < 2; attempt++) {
    await Bun.sleep(300);
    if (!tmuxSessionExists(session)) break;
    const out = capturePaneSync(session);
    if (!MODAL_SUBMIT_READY_MARKERS.some((m) => out.includes(m))) break;
    Bun.spawnSync(sessionTmux(session, "send-keys", "-t", session, "Enter"));
  }

  return { ok: true };
}

/**
 * Interrupts the current turn of a launched session by sending the TUI's
 * interrupt key (Escape), the same keystroke a human would press in Claude
 * Code to stop the agent mid-turn. Unlike stopLaunch this leaves the session
 * alive and at its prompt — the agent stops what it's doing and waits for the
 * next instruction, rather than the pane being torn down.
 */
export async function interruptLaunch(
  launch: Launch
): Promise<{ ok: boolean; error?: string }> {
  const session = assertOwned(launch);

  if (!tmuxAvailable() || !tmuxSessionExists(session)) {
    return { ok: false, error: "tmux session is no longer running" };
  }

  const res = Bun.spawnSync(sessionTmux(session, "send-keys", "-t", session, "Escape"));
  if (res.exitCode !== 0) {
    return { ok: false, error: "failed to send the interrupt key into the session" };
  }
  return { ok: true };
}

/** Seams for pausing a pane: the command runner and the workers'-server lookup. */
export interface PauseDeps {
  run?: (cmd: string[], cwd: string, log: string[]) => Promise<{ ok: boolean; output: string }>;
  onWorkerServer?: (session: string) => boolean;
}

/** The kill a pause runs: the workers' socket (-S) and the exact session name (`=name`, not tmux's prefix match). */
export function pauseKillArgv(session: string): string[] {
  return workerTmux("kill-session", "-t", `=${session}`);
}

/** Kills a session on the workers' tmux server with the pause kill (pauseKillArgv), through `runCmd` when given. */
export function killWorkerSession(
  session: string,
  log: string[],
  runCmd?: PauseDeps["run"]
): Promise<{ ok: boolean; output: string }> {
  return (runCmd ?? run)(pauseKillArgv(session), "/", log);
}

function sessionOnWorkerServer(session: string): boolean {
  return Bun.spawnSync(workerTmux("has-session", "-t", `=${session}`), { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
}

async function pauseLaunchPane(launch: Launch, log: string[], deps: PauseDeps): Promise<{ ok: boolean; log: string[] }> {
  const session = launch.tmuxSession;
  const onWorkers = deps.onWorkerServer ?? sessionOnWorkerServer;
  if (!session || !onWorkers(session)) {
    log.push("Not paused: the session isn't on the workers' tmux server");
    return { ok: false, log };
  }
  const killed = await (deps.run ?? run)(pauseKillArgv(session), "/", log);
  if (!killed.ok) {
    log.push(`Not paused: ${killed.output.slice(0, 200)}`);
    return { ok: false, log };
  }
  log.push(`Paused ${session}; worktree kept at ${launch.worktreePath}`);
  return { ok: true, log };
}

/**
 * Stops a launched session, leaving its worktree and branch intact so the
 * work can be inspected or resumed. Distinct from cleanupLaunch, which also
 * removes the worktree.
 *
 * `pause` only closes the pane: the launch stays `running` and its task run
 * open, because an idle worker paused to free the host resumes into the same
 * launch on its next message (launch-resume.ts). A pause kills only on the
 * workers' server (pauseKillArgv), never the legacy or default one, and fails
 * when the session isn't there.
 */
export async function stopLaunch(
  db: Database,
  launch: Launch,
  queue: LaunchQueue = launchQueue,
  { pause = false, ...pauseDeps }: { pause?: boolean } & PauseDeps = {}
): Promise<{ ok: boolean; log: string[] }> {
  const log: string[] = [];
  const session = launch.tmuxSession;

  if (pause) return pauseLaunchPane(launch, log, pauseDeps);

  if (queue.cancel(launch.id)) {
    log.push("Removed from the host-headroom queue before it started");
  } else if (session && tmuxAvailable() && tmuxSessionExists(session)) {
    await run(sessionTmux(session, "kill-session", "-t", `=${session}`), "/", log);
    log.push(`Stopped ${session}`);
  } else {
    log.push("Session was not running");
  }

  // Back to "starting" would be wrong and "cleaned" implies the worktree is
  // gone, so a stopped-but-intact launch is recorded as failed with a reason.
  updateLaunchStatus(db, launch.id, "failed", "Stopped by you");
  // A deliberate stop is a cancellation on the ledger, not a lost pane.
  cancelWorktreeTaskRun(db, launch);
  log.push(`Worktree kept at ${launch.worktreePath}`);

  return { ok: true, log };
}

/**
 * Starts launches waiting in the host-headroom queue, oldest first, while the
 * host has room. Called from the collector's maintenance tick. A queued launch
 * whose row has left `starting` meanwhile is dropped without starting.
 */
export function drainLaunchQueue(db: Database, queue: LaunchQueue = launchQueue): string[] {
  return queue.drain((launchId) => getLaunch(db, launchId)?.status === "starting");
}

/** The reason recorded on a launch that was still queued when the collector stopped. */
export const STRANDED_QUEUED_LAUNCH_REASON =
  "The collector restarted while this launch was queued for host headroom, before it started. Launch it again.";

/**
 * Fails the launches a previous collector process left queued for host
 * headroom: the queue lived in that process, so nothing would ever start them.
 * Their ledger runs are cancelled (they never ran). Called once at startup.
 */
export function failStrandedQueuedLaunches(db: Database): Launch[] {
  const rows = db
    .query(`SELECT id FROM launches WHERE status = 'starting' AND phase = 'queued'`)
    .all() as Array<{ id: string }>;
  const failed: Launch[] = [];
  for (const { id } of rows) {
    const launch = getLaunch(db, id);
    if (!launch) continue;
    updateLaunchStatus(db, id, "failed", STRANDED_QUEUED_LAUNCH_REASON);
    cancelWorktreeTaskRun(db, launch);
    failed.push({ ...launch, status: "failed", error: STRANDED_QUEUED_LAUNCH_REASON, phase: undefined });
  }
  return failed;
}

/**
 * Tears down a launch: kills its tmux session and removes the worktree.
 * Deliberately does NOT delete the branch — uncommitted-but-wanted work
 * should survive a cleanup mistake. Its review token is revoked: the hash is
 * forgotten and the file removed from `deps.dataDir`, the data dir
 * launchSession/adoptSession wrote it under (default standupDataDir()). The
 * processes its worker registered are stopped and its scratch dir removed
 * before the worktree goes (onLaunchCleaned, on `deps.processSystem`).
 *
 * Before anything awaits, the launch is held for cleanup (holdForCleanup) and
 * its reaped mark cleared, so a resume of it does nothing from then on and
 * one already respawning kills its new pane; the pane is killed only once any
 * resume in progress has settled, so a pane it left up is caught too.
 */
export async function cleanupLaunch(
  db: Database,
  launch: Launch,
  project: Project,
  deps: CleanupDeps = {}
): Promise<{ ok: boolean; log: string[] }> {
  const release = holdForCleanup(launch.id);
  clearLaunchReaped(db, launch.id);
  let result: { ok: boolean; log: string[] };
  try {
    await resumeSettled(launch.id);
    result = await tearDownLaunch(db, launch, project, deps);
  } finally {
    release();
  }
  // Only now, marked cleaned and no longer held, can the launch read as finished to the tunnel reap.
  try {
    const tunnels = describeWorkerTunnels(
      await reapWorkerTunnels(db, deps.processSystem ?? createProcessSystem(), { installDir: resolveInstallDir(), launchIds: [launch.id] })
    );
    if (tunnels) result.log.push(`Stopped ${tunnels}`);
  } catch (err) {
    result.log.push(`[warn] could not stop the launch's hand-opened tunnels: ${err instanceof Error ? err.message : String(err)}`);
  }
  return result;
}

export interface CleanupDeps {
  dataDir?: string;
  processSystem?: ProcessSystem;
  scratchRoot?: string;
  /** Runs the teardown's commands (the tmux kill, the worktree removal); defaults to spawning them, and when given the tmux kill runs without checking tmux is installed. */
  run?: (cmd: string[], cwd: string, log: string[]) => Promise<{ ok: boolean; output: string }>;
}

async function tearDownLaunch(db: Database, launch: Launch, project: Project, deps: CleanupDeps): Promise<{ ok: boolean; log: string[] }> {
  const log: string[] = [];
  const exec = deps.run ?? run;

  // Tearing down a launch cancels its ledger run (if still active) — the work
  // was deliberately abandoned, not lost to a dead pane.
  cancelWorktreeTaskRun(db, launch);

  if (launch.tmuxSession && (deps.run || tmuxAvailable())) {
    await exec(sessionTmux(launch.tmuxSession, "kill-session", "-t", `=${launch.tmuxSession}`), "/", log);
  }
  try {
    const hygiene = await onLaunchCleaned(db, deps.processSystem ?? createProcessSystem(), launch.id, {
      installDir: resolveInstallDir(),
      ...(deps.scratchRoot ? { scratchRoot: deps.scratchRoot } : {}),
    });
    const stopped = describeTerminated(hygiene.processes);
    if (stopped) log.push(`Stopped registered processes: ${stopped}`);
    if (hygiene.scratchRemoved.length > 0) log.push("Removed the launch's scratch dir");
  } catch (err) {
    log.push(`[warn] could not stop the launch's registered processes: ${err instanceof Error ? err.message : String(err)}`);
  }
  // With its session gone, the launch's review token has no one to serve.
  clearLaunchReviewTokenHash(db, launch.id);
  removeReviewToken(deps.dataDir ?? standupDataDir(), launch.id);

  // An adopted or in-place launch's "worktree" is the user's actual repository
  // — the session was run in place rather than in a checkout. Running
  // `git worktree remove --force` there would attempt to destroy real work.
  // This guard is the reason launches carry `kind` and `inPlace` at all.
  if (launch.kind === "adopted" || launch.inPlace) {
    updateLaunchStatus(db, launch.id, "cleaned");
    log.push(
      `${launch.inPlace ? "In-place" : "Adopted"} session — left ${launch.worktreePath} untouched (it is the real repository, not a worktree).`
    );
    return { ok: true, log };
  }

  // A provisioned working dir (a whole multi-repo workspace, a clone, …) isn't a
  // git worktree — `git worktree remove` can't touch it. Remove the directory
  // itself, but ONLY if it sits under this project's own worktree root: that
  // is the guarantee it's a dir Standup created, never a real repo a
  // misconfigured provision command left pointing elsewhere.
  if (launch.provisioned) {
    const ownedPrefixRoot = join(resolveWorktreeRoot(db, project), project.id);
    const target = launch.worktreePath;
    if (target && (target === ownedPrefixRoot || target.startsWith(`${ownedPrefixRoot}/`))) {
      const removed = await exec(["rm", "-rf", target], "/", log);
      if (!removed.ok) {
        log.push("[warn] failed to remove provisioned dir; remove it manually");
      }
    } else {
      log.push(
        `[warn] refusing to remove ${target} — it is not under this project's worktree root ` +
          `(${ownedPrefixRoot}). Remove it by hand if it really is a Standup working dir.`
      );
    }
    updateLaunchStatus(db, launch.id, "cleaned");
    return { ok: true, log };
  }

  const repo = project.repos[0];
  if (repo) {
    const repoPath = repo.replace(/^~/, homedir());
    const removed = await exec(
      ["git", "worktree", "remove", "--force", launch.worktreePath],
      repoPath,
      log
    );
    if (!removed.ok) {
      log.push("[warn] worktree remove failed; it may already be gone");
    }
    updateLaunchStatus(db, launch.id, "cleaned");
    log.push(`Branch ${launch.branch} left in place — delete it manually if unwanted.`);
    return { ok: true, log };
  }

  // A scratch run (no repo, no provision) is just a plain directory Standup
  // made — not a git worktree, so remove the dir itself, path-guarded to this
  // project's own worktree root exactly like the provisioned case.
  const ownedPrefixRoot = join(resolveWorktreeRoot(db, project), project.id);
  const target = launch.worktreePath;
  if (target && (target === ownedPrefixRoot || target.startsWith(`${ownedPrefixRoot}/`))) {
    const removed = await exec(["rm", "-rf", target], "/", log);
    if (!removed.ok) {
      log.push("[warn] failed to remove scratch dir; remove it manually");
    }
  }

  updateLaunchStatus(db, launch.id, "cleaned");
  return { ok: true, log };
}
