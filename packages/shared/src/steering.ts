import { homedir } from "os";
import { join } from "path";

/**
 * The managed Standup steering: the block setup-hooks writes into the global
 * CLAUDE.md (and Codex's AGENTS.md), and where it and the `standup` skill are
 * installed. Shared so the collector can tell, read-only, when an install's
 * block is out of date without pulling the installer in.
 */

export const STEERING_BEGIN = "<!-- BEGIN STANDUP STEERING -->";
export const STEERING_END = "<!-- END STANDUP STEERING -->";

/**
 * The always-on behavioral steering, written between the delimiters into the
 * global CLAUDE.md. Deliberately tight: what to do, when, and the guard rails —
 * the fuller procedure lives in the `standup` skill. Kept as a pure constant so
 * the block builder is unit-testable.
 */
export const STEERING_BODY = `## Standup — knowledge base & self-improvement (auto-installed)

You are running with **Standup** wired in globally (the \`standup\` MCP server).
Use its tools on your own, without being asked — that is the point of Standup:

- **Before implementing** any non-trivial task, call \`search_knowledge\` with
  natural-language questions about what you are about to build or change, and
  open the best hits with \`get_knowledge_doc\` — prior decisions, conventions,
  gotchas and cross-project context live there. Outside a repo Standup knows,
  pass \`project\` explicitly. Skip only for trivial edits. When you delegate to a subagent, put the relevant knowledge hits (slugs and key
  facts) in its prompt and ask it to report durable findings back to you.
- **When you learn something durable and non-obvious** (a gotcha, a decision
  and its reason, a convention the code doesn't make obvious), contribute it
  back with \`propose_knowledge\` — preferring to update the existing doc that
  covers it. Never propose status reports, review/session tags, "validated on
  <date>" stamps, personal resource or account ids, session narration, or
  copies of an existing doc. Fix stale or wrong docs the same way.
  Propose facts about the code as it is on the default branch; if a fact only holds on
  your unmerged branch, say so in the body (e.g. "on branch X, not yet merged")
  or propose it after merge.
- **When Standup itself is broken, missing knowledge, or behaving oddly** — or a
  user flags it — say so and ask: "I think this is a gap in Standup itself —
  want me to fire the fix?" On the user's yes, call
  \`propose_standup_improvement\` (\`{title, description, kind: bug|kb-gap|feature}\`).
  It is confirmation-gated and launches a fix session against the Standup repo
  only on approval. Never fire it without the user's yes.
- **In a worktree of the Standup repo, never spawn a subagent with
  \`isolation: "worktree"\`** — its worktree would land inside the live Standup
  install, on the install's HEAD, and the safety floor denies it. Run the
  subagent without isolation in your own worktree (parallelize only across
  disjoint files), or ask the human.
- **In a Standup launch, scratch files go under \`$TMPDIR\`** (your launch's
  disk-backed scratch dir), never a hard-coded \`/tmp\`. Isolated test envs are
  the exception: put \`HOME\`, \`XDG_*\`, \`DB_PATH\` and the rest, plus
  \`TMPDIR\`/\`TMP\`/\`TEMP\`, under a \`mktemp -d -p /tmp\` root — the safety
  floor credits isolation only under \`/tmp\`. Register long-lived
  servers/tunnels you start with \`register_process\`.`;

// The trailing cross-reference to the fuller `standup` skill. Both harnesses
// auto-discover the installed skill by name — Claude Code from
// ~/.claude/skills/standup, Codex from ~/.codex/skills/standup — so a bare-name
// reference resolves in each, and the managed steering block is identical across
// the two.
export const SKILL_REFERENCE = "See the `standup` skill for the full workflow.";

/** The name the steering skill installs under in each harness's skills dir. */
export const STEERING_SKILL_NAME = "standup";

/**
 * The full managed steering block, delimiters included, closing with the skill
 * cross-reference. Identical for Claude's CLAUDE.md and Codex's AGENTS.md —
 * both runtimes auto-discover the installed `standup` skill by name. Kept as a
 * pure builder so it is unit-testable.
 */
export function steeringBlock(): string {
  return `${STEERING_BEGIN}\n${STEERING_BODY}\n\n${SKILL_REFERENCE}\n${STEERING_END}`;
}

/** Where the steering lands under one home dir: the CLAUDE.md / AGENTS.md blocks and the skills. */
export interface SteeringInstallPaths {
  claudeDir: string;
  claudeMdPath: string;
  skillDir: string;
  codexDir: string;
  codexAgentsMdPath: string;
  codexSkillDir: string;
}

/** The steering targets under `home` (default: the current HOME). */
export function steeringInstallPaths(home: string = homedir()): SteeringInstallPaths {
  const claudeDir = join(home, ".claude");
  const codexDir = join(home, ".codex");
  return {
    claudeDir,
    claudeMdPath: join(claudeDir, "CLAUDE.md"),
    skillDir: join(claudeDir, "skills", STEERING_SKILL_NAME),
    codexDir,
    codexAgentsMdPath: join(codexDir, "AGENTS.md"),
    codexSkillDir: join(codexDir, "skills", STEERING_SKILL_NAME),
  };
}
