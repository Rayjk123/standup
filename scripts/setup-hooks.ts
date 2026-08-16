#!/usr/bin/env bun
/**
 * Setup script for Standup: wires up both halves of the read/write split.
 *
 *   - Read path:  HTTP hooks in ~/.claude/settings.json, so every session
 *                 reports lifecycle events to the collector.
 *   - Write path: the standup MCP server in ~/.claude.json, so every session
 *                 gets the checkpoint / ask_human / ask_expert /
 *                 search_knowledge / ripgrep tools.
 *
 * Both are global — every Claude Code session on this machine gets wired up,
 * not just sessions started in this repo. Safe to re-run: idempotent, and
 * repairs shapes this script may have previously written incorrectly.
 *
 * Usage: bun run scripts/setup-hooks.ts
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const CLAUDE_DIR = join(homedir(), ".claude");
const SETTINGS_PATH = join(CLAUDE_DIR, "settings.json");
const CLAUDE_JSON_PATH = join(homedir(), ".claude.json");

// Single source of truth for where the collector lives — the hook URL and
// the MCP server's COLLECTOR_URL env var are both derived from this, so
// overriding COLLECTOR_URL once keeps both halves consistent.
const COLLECTOR_BASE_URL = process.env.COLLECTOR_URL ?? "http://localhost:7777";
const HOOK_URL = `${COLLECTOR_BASE_URL}/hook`;

// Absolute path to the MCP server entry point, resolved from this script's
// own location so it works regardless of the caller's cwd.
const MCP_ENTRY_PATH = join(import.meta.dir, "..", "packages", "mcp", "src", "index.ts");

const HOOK_EVENTS = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "SubagentStart",
  "SubagentStop",
  "Stop",
  "Notification",
] as const;

// ============================================================================
// Hooks (~/.claude/settings.json)
// ============================================================================

interface HookDefinition {
  type: string;
  command?: string;
  url?: string;
  [key: string]: unknown;
}

interface HookMatcherEntry {
  matcher?: string;
  hooks?: HookDefinition[];
  [key: string]: unknown;
}

interface Settings {
  hooks?: {
    [event: string]: HookMatcherEntry[];
  };
  [key: string]: unknown;
}

function isOurLegacyEntry(entry: HookMatcherEntry): boolean {
  // An earlier version of this script wrote the hook definition flat, at the
  // matcher-entry level, instead of nested under `hooks`. That shape fails
  // Claude Code's settings validation ("Expected array, but received
  // undefined" for the missing `hooks` field). Detect and drop those so
  // re-running this script repairs what it previously broke.
  return (
    !Array.isArray(entry.hooks) &&
    (entry as unknown as HookDefinition).type === "http" &&
    (entry as unknown as HookDefinition).url === HOOK_URL
  );
}

function hasOurHook(entry: HookMatcherEntry): boolean {
  return (
    Array.isArray(entry.hooks) &&
    entry.hooks.some((h) => h.type === "http" && h.url === HOOK_URL)
  );
}

function setupHooks(): void {
  console.log(`\n--- Hooks (${SETTINGS_PATH}) ---`);

  if (!existsSync(CLAUDE_DIR)) {
    mkdirSync(CLAUDE_DIR, { recursive: true });
    console.log(`Created ${CLAUDE_DIR}`);
  }

  let settings: Settings = {};
  if (existsSync(SETTINGS_PATH)) {
    try {
      settings = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
    } catch (err) {
      console.error(`Failed to parse ${SETTINGS_PATH}, creating backup...`);
      writeFileSync(`${SETTINGS_PATH}.backup`, readFileSync(SETTINGS_PATH));
      settings = {};
    }
  }

  if (!settings.hooks) settings.hooks = {};

  let added = 0;
  let repaired = 0;

  for (const event of HOOK_EVENTS) {
    let entries = settings.hooks[event] ?? [];

    const beforeCount = entries.length;
    entries = entries.filter((e) => !isOurLegacyEntry(e));
    if (entries.length < beforeCount) {
      repaired++;
      console.log(`Repaired malformed entry for ${event}`);
    }

    if (!entries.some(hasOurHook)) {
      entries.push({ hooks: [{ type: "http", url: HOOK_URL }] });
      added++;
      console.log(`Added hook for ${event}`);
    } else {
      console.log(`Hook for ${event} already configured`);
    }

    settings.hooks[event] = entries;
  }

  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));

  if (repaired > 0) console.log(`Repaired ${repaired} malformed entr${repaired === 1 ? "y" : "ies"}`);
  if (added > 0) console.log(`Added ${added} hook${added === 1 ? "" : "s"}`);
  if (repaired === 0 && added === 0) console.log(`All hooks already configured`);
}

// ============================================================================
// MCP server (~/.claude.json)
// ============================================================================

interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  [key: string]: unknown;
}

interface ClaudeJson {
  mcpServers?: Record<string, McpServerConfig>;
  [key: string]: unknown;
}

function setupMcp(): void {
  console.log(`\n--- MCP server (${CLAUDE_JSON_PATH}) ---`);

  let claudeJson: ClaudeJson = {};
  if (existsSync(CLAUDE_JSON_PATH)) {
    try {
      claudeJson = JSON.parse(readFileSync(CLAUDE_JSON_PATH, "utf-8"));
    } catch (err) {
      console.error(`Failed to parse ${CLAUDE_JSON_PATH}, creating backup...`);
      writeFileSync(`${CLAUDE_JSON_PATH}.backup`, readFileSync(CLAUDE_JSON_PATH));
      claudeJson = {};
    }
  }

  if (!claudeJson.mcpServers) claudeJson.mcpServers = {};

  const desired: McpServerConfig = {
    command: "bun",
    args: ["run", MCP_ENTRY_PATH],
    env: { COLLECTOR_URL: COLLECTOR_BASE_URL },
  };

  const current = claudeJson.mcpServers.standup;
  const alreadyCorrect =
    !!current &&
    current.command === desired.command &&
    JSON.stringify(current.args) === JSON.stringify(desired.args) &&
    JSON.stringify(current.env) === JSON.stringify(desired.env);

  if (alreadyCorrect) {
    console.log(`MCP server "standup" already configured`);
    return;
  }

  claudeJson.mcpServers.standup = desired;
  writeFileSync(CLAUDE_JSON_PATH, JSON.stringify(claudeJson, null, 2));
  console.log(`${current ? "Updated" : "Added"} MCP server "standup" -> ${MCP_ENTRY_PATH}`);
}

// ============================================================================

function main() {
  setupHooks();
  setupMcp();

  console.log(`\nStandup is wired up globally — every Claude Code session on this machine will:`);
  console.log(`  - report to the collector at ${COLLECTOR_BASE_URL}`);
  console.log(`  - get the checkpoint / ask_human / ask_expert / search_knowledge / ripgrep tools`);
  console.log(`\nMake sure the collector is running (bun run dev), then start a new`);
  console.log(`Claude Code session — both hooks and MCP servers are read at session start,`);
  console.log(`so sessions already running won't pick this up.`);
}

main();
