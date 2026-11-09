import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

/**
 * Whether Codex, launched with `env`, can reach the `standup` MCP server.
 *
 * Unlike Claude Code, a Codex launch does not inherit the ~/.claude.json
 * registration; it reads its own `$CODEX_HOME/config.toml` (default
 * `~/.codex/config.toml`), where `scripts/setup-hooks.ts --codex` writes an
 * `[mcp_servers.standup]` table. The knowledge-first steering names tools on
 * that server, so it rides a Codex launch only when this resolves true.
 */

/** The config.toml a Codex process started with `env` reads. */
export function codexConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const codexHome = env.CODEX_HOME?.trim();
  if (codexHome) return join(codexHome, "config.toml");
  return join(env.HOME?.trim() || homedir(), ".codex", "config.toml");
}

// An [mcp_servers.standup] table header or one of its subtables
// ([mcp_servers.standup.env]); a quoted key ("standup") is accepted too. A
// sibling such as [mcp_servers.standup-mcp] is a different server.
const STANDUP_TABLE_RE = /^\s*\[\s*mcp_servers\s*\.\s*"?standup"?\s*[.\]]/;
// The [mcp_servers] parent table, under which an inline `standup = {...}` key
// (or a dotted `standup.command = ...` key) registers the server.
const MCP_SERVERS_PARENT_RE = /^\s*\[\s*mcp_servers\s*\]/;
const STANDUP_KEY_RE = /^\s*"?standup"?\s*[.=]/;
// A root-level dotted key: `mcp_servers.standup.command = ...`.
const ROOT_DOTTED_KEY_RE = /^\s*mcp_servers\s*\.\s*"?standup"?\s*[.=]/;
const TABLE_HEADER_RE = /^\s*\[/;

/** Whether a config.toml body registers the `standup` MCP server. Pure. */
export function codexConfigRegistersStandup(toml: string): boolean {
  // Before any table header the dotted-key form lives at the root.
  let section: "root" | "mcp_servers" | "other" = "root";
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.replace(/^\s*#.*$/, "");
    if (!line.trim()) continue;
    if (STANDUP_TABLE_RE.test(line)) return true;
    if (TABLE_HEADER_RE.test(line)) {
      section = MCP_SERVERS_PARENT_RE.test(line) ? "mcp_servers" : "other";
      continue;
    }
    if (section === "mcp_servers" && STANDUP_KEY_RE.test(line)) return true;
    if (section === "root" && ROOT_DOTTED_KEY_RE.test(line)) return true;
  }
  return false;
}

/**
 * Whether the Codex config a launch with `env` reads registers the `standup`
 * MCP server. A missing or unreadable config means no registration.
 */
export function standupMcpRegisteredForCodex(env: NodeJS.ProcessEnv = process.env): boolean {
  let toml: string;
  try {
    toml = readFileSync(codexConfigPath(env), "utf-8");
  } catch {
    return false;
  }
  return codexConfigRegistersStandup(toml);
}
