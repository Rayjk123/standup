import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { managedBlockRe } from "@standup/shared";
import { STEERING_BEGIN, STEERING_END, steeringBlock, steeringInstallPaths } from "@standup/shared/steering";

/**
 * Whether this host's installed Standup steering is out of date: the managed
 * block in the global CLAUDE.md / AGENTS.md no longer matches the block this
 * collector ships, or it or an installed `standup` skill still names a tool
 * the MCP server no longer has. Only setup-hooks writes those files; the
 * collector reads them once at boot, warns the operator, and adds a one-line
 * correction to SessionStart's push context until the steering is re-run.
 */

/** Tool names the MCP server no longer serves; steering that names one sends agents to a missing tool. */
const RETIRED_TOOL_NAMES = ["ask_expert"] as const;

/** The SessionStart line an agent gets while the installed steering is stale. */
export const STALE_STEERING_NOTICE = "Standup's ask_expert tool was removed — use search_knowledge.";

/** The command that rewrites the managed block and the skill. */
export const STEERING_REPAIR_COMMAND = "bun run setup:steering";

export interface SteeringStaleness {
  stale: boolean;
  /** The installed files found out of date. */
  files: string[];
}

function readIfPresent(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, "utf-8") : null;
  } catch {
    return null;
  }
}

function namesRetiredTool(text: string): boolean {
  return RETIRED_TOOL_NAMES.some((name) => text.includes(name));
}

/**
 * The installed steering under `home` (default: the current HOME), checked
 * read-only. A file with no managed block is not stale: the steering was never
 * installed there, or the operator removed it.
 */
export function checkInstalledSteering(home: string = homedir()): SteeringStaleness {
  const paths = steeringInstallPaths(home);
  const current = steeringBlock();
  const files: string[] = [];
  for (const path of [paths.claudeMdPath, paths.codexAgentsMdPath]) {
    const text = readIfPresent(path);
    if (text === null) continue;
    const m = managedBlockRe(STEERING_BEGIN, STEERING_END).exec(text);
    if (!m) continue;
    const block = m[0].slice(m[1].length, m[0].length - m[2].length);
    if (block !== current || namesRetiredTool(block)) files.push(path);
  }
  for (const dir of [paths.skillDir, paths.codexSkillDir]) {
    const path = join(dir, "SKILL.md");
    const text = readIfPresent(path);
    if (text !== null && namesRetiredTool(text)) files.push(path);
  }
  return { stale: files.length > 0, files };
}

/**
 * Checks the installed steering once and logs a warning naming the stale files
 * and the repair command. Returns the SessionStart notice to add, or undefined
 * when the steering is current.
 */
export function staleSteeringNoticeAtBoot(
  home: string = homedir(),
  warn: (message: string) => void = console.warn
): string | undefined {
  const { stale, files } = checkInstalledSteering(home);
  if (!stale) return undefined;
  warn(
    `[steering] installed Standup steering is out of date (${files.join(", ")}); ` +
      `run \`${STEERING_REPAIR_COMMAND}\` to update it`
  );
  return STALE_STEERING_NOTICE;
}

let bootNotice: { value: string | undefined } | undefined;

/**
 * staleSteeringNoticeAtBoot for the current HOME, checked on the first call in
 * this process and cached: the installed files change only when setup-hooks
 * re-runs, which the warning asks for and a collector restart picks up.
 */
export function bootSteeringNotice(): string | undefined {
  bootNotice ??= { value: staleSteeringNoticeAtBoot() };
  return bootNotice.value;
}
