import { expect, test, describe, afterAll } from "bun:test";
import { chmod, mkdtemp, rm, readFile, writeFile, mkdir } from "fs/promises";
import { existsSync, readFileSync, realpathSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  resolvePaths,
  setupHooks,
  setupMcp,
  setupSteering,
  removeSteering,
  setupCodexMcp,
  setupCodexSteering,
  removeCodex,
  codexMcpBlock,
  codexConfigWithStandup,
  codexConfigWithoutStandup,
  runSetup,
  upsertManagedBlock,
  stripManagedBlock,
  placeManagedBlockFirst,
  steeringBlock,
  SKILL_REFERENCE,
  STEERING_BEGIN,
  STEERING_END,
  CODEX_MCP_BEGIN,
  CODEX_MCP_END,
  BUNDLED_SKILLS,
  installSkill,
  removeSkill,
  type BundledSkill,
  REDEPLOY_HOOK_FILES,
  REDEPLOY_HOOK_MARKER,
  REDEPLOY_HOOK_TEMPLATE,
  installGitHooks,
  isLegacyRedeployHook,
  HOOK_CLIENT_TIMEOUT_SECONDS,
  standupHookDefinition,
} from "./setup-hooks.ts";
import { STANDUP_HOOK_EVENTS } from "@standup/shared";

/**
 * The installer, exercised against a TEMP HOME — it must NEVER touch the real
 * ~/.claude. Importing setup-hooks.ts does not run main() (guarded by
 * `import.meta.main`), so this file loads the exported functions and points
 * every path at a throwaway dir.
 */

const dirs: string[] = [];
async function tempHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "standup-setup-home-"));
  dirs.push(home);
  return home;
}
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("upsertManagedBlock / stripManagedBlock (pure)", () => {
  const BLOCK = steeringBlock();

  test("adds the block to empty content", () => {
    const out = upsertManagedBlock("", BLOCK);
    expect(out).toContain(STEERING_BEGIN);
    expect(out).toContain(STEERING_END);
  });

  test("the steering and the skill ask for default-branch facts, or a branch-only fact labeled as such", () => {
    const sentence =
      "Propose facts about the code as it is on the default branch; if a fact only holds on your unmerged branch, " +
      'say so in the body (e.g. "on branch X, not yet merged") or propose it after merge.';
    expect(BLOCK.replace(/\s+/g, " ")).toContain(sentence);
    const skill = readFileSync(join(import.meta.dir, "..", "config", "steering", "standup", "SKILL.md"), "utf-8");
    expect(skill.replace(/\s+/g, " ")).toContain(sentence);
  });

  test("the steering and the skill consult the knowledge base through search_knowledge and get_knowledge_doc", () => {
    const skill = readFileSync(join(import.meta.dir, "..", "config", "steering", "standup", "SKILL.md"), "utf-8");
    const block = BLOCK.replace(/\s+/g, " ");
    expect(block).toContain("call `search_knowledge` with natural-language questions");
    expect(block).toContain("open the best hits with `get_knowledge_doc`");
    expect(block).toContain("Outside a repo Standup knows, pass `project` explicitly.");
    expect(skill).toContain("get_knowledge_doc");
    expect(skill).toContain("`project`");
    for (const text of [BLOCK, skill]) expect(text).not.toContain("ask_expert");
  });

  test("the steering tells a delegating agent to pass knowledge hits to its subagents", () => {
    expect(BLOCK.replace(/\s+/g, " ")).toContain(
      "When you delegate to a subagent, put the relevant knowledge hits (slugs and key facts) " +
        "in its prompt and ask it to report durable findings back to you."
    );
  });

  test("preserves the user's own content and appends the block once", () => {
    const user = "# My CLAUDE.md\n\nMy own rules here.\n";
    const out = upsertManagedBlock(user, BLOCK);
    expect(out).toContain("My own rules here.");
    expect(countOccurrences(out, STEERING_BEGIN)).toBe(1);
    // User content stays ahead of the managed block.
    expect(out.indexOf("My own rules")).toBeLessThan(out.indexOf(STEERING_BEGIN));
  });

  test("updates in place without duplicating on re-run", () => {
    const user = "# Mine\n";
    const once = upsertManagedBlock(user, BLOCK);
    const twice = upsertManagedBlock(once, BLOCK);
    expect(twice).toBe(once);
    expect(countOccurrences(twice, STEERING_BEGIN)).toBe(1);

    // A changed block replaces the old one in place, still exactly once.
    const changed = `${STEERING_BEGIN}\nnew body\n${STEERING_END}`;
    const updated = upsertManagedBlock(once, changed);
    expect(countOccurrences(updated, STEERING_BEGIN)).toBe(1);
    expect(updated).toContain("new body");
    expect(updated).toContain("# Mine");
  });

  test("strip removes the block and preserves surrounding content", () => {
    const user = "# Mine\n\nkeep me\n";
    const withBlock = upsertManagedBlock(user, BLOCK);
    const stripped = stripManagedBlock(withBlock);
    expect(stripped).not.toContain(STEERING_BEGIN);
    expect(stripped).not.toContain(STEERING_END);
    expect(stripped).toContain("keep me");
    expect(stripped).toContain("# Mine");
  });

  test("placeManagedBlockFirst puts the block first, is idempotent, and leaves inline marker mentions alone", () => {
    expect(placeManagedBlockFirst("", BLOCK)).toBe(`${BLOCK}\n`);
    const user = `# Notes\n\nWe reference \`${STEERING_BEGIN}\` inline.\n`;
    const once = placeManagedBlockFirst(user, BLOCK);
    expect(once).toBe(`${BLOCK}\n\n${user}`);
    expect(placeManagedBlockFirst(once, BLOCK)).toBe(once);
    // An updated body replaces the old block at the top, still exactly once.
    const changed = `${STEERING_BEGIN}\nnew body\n${STEERING_END}`;
    const updated = placeManagedBlockFirst(once, changed);
    expect(updated).toBe(`${changed}\n\n${user}`);
  });

  test("strip is a no-op when there is no block", () => {
    const user = "# Mine\n";
    expect(stripManagedBlock(user)).toBe(user);
  });

  test("M1: markers quoted INLINE in the user's prose are not treated as block boundaries", () => {
    // The README quotes these exact strings, so a user could paste them into
    // their own CLAUDE.md prose. They must never be read as a block boundary.
    const user =
      `# Notes\n\nWe reference \`${STEERING_BEGIN}\` and \`${STEERING_END}\` as a convention.\nKeep this line.\n`;

    const added = upsertManagedBlock(user, BLOCK);
    expect(added).toContain("Keep this line.");
    expect(added).toContain(`\`${STEERING_BEGIN}\``); // the inline mention survives
    expect(added).toContain("propose_standup_improvement"); // a REAL own-line block was appended
    expect(countOccurrences(added, STEERING_BEGIN)).toBe(2); // inline + own-line

    const removed = stripManagedBlock(added);
    // Only the own-line block is stripped; the user's inline mentions + prose stay.
    expect(removed).toContain("Keep this line.");
    expect(removed).toContain(`\`${STEERING_BEGIN}\``);
    expect(removed).not.toContain("propose_standup_improvement");
    expect(countOccurrences(removed, STEERING_BEGIN)).toBe(1); // just the inline one
  });
});

describe("setupHooks + setupMcp against a temp HOME", () => {
  test("fresh install writes hooks + MCP; re-run is idempotent", async () => {
    const home = await tempHome();
    const paths = resolvePaths(home);

    setupHooks(paths);
    setupMcp(paths);

    const settings = JSON.parse(await readFile(paths.settingsPath, "utf-8"));
    expect(settings.hooks.SessionStart).toHaveLength(1);
    expect(settings.hooks.SessionStart[0].hooks[0].type).toBe("http");

    const claudeJson = JSON.parse(await readFile(paths.claudeJsonPath, "utf-8"));
    expect(claudeJson.mcpServers.standup.command).toBe("bun");
    expect(claudeJson.mcpServers.standup.args[0]).toBe("run");

    // Re-run: no duplicate hook entries.
    setupHooks(paths);
    setupMcp(paths);
    const settings2 = JSON.parse(await readFile(paths.settingsPath, "utf-8"));
    expect(settings2.hooks.SessionStart).toHaveLength(1);
    expect(settings2.hooks.Stop).toHaveLength(1);
  });

  test("preserves unrelated keys in settings.json and .claude.json", async () => {
    const home = await tempHome();
    const paths = resolvePaths(home);
    await mkdir(paths.claudeDir, { recursive: true });
    await writeFile(paths.settingsPath, JSON.stringify({ theme: "dark", hooks: {} }));
    await writeFile(paths.claudeJsonPath, JSON.stringify({ mcpServers: { other: { command: "x" } } }));

    setupHooks(paths);
    setupMcp(paths);

    const settings = JSON.parse(await readFile(paths.settingsPath, "utf-8"));
    expect(settings.theme).toBe("dark");
    const claudeJson = JSON.parse(await readFile(paths.claudeJsonPath, "utf-8"));
    expect(claudeJson.mcpServers.other.command).toBe("x");
    expect(claudeJson.mcpServers.standup).toBeTruthy();
  });

  test("every reported event is installed; the knowledge-push events carry a client timeout", async () => {
    const home = await tempHome();
    const paths = resolvePaths(home);
    setupHooks(paths);
    const settings = JSON.parse(await readFile(paths.settingsPath, "utf-8"));
    for (const event of STANDUP_HOOK_EVENTS) {
      const ours = settings.hooks[event][0].hooks[0];
      expect(ours).toEqual(standupHookDefinition(event));
      expect(ours.timeout).toBe(HOOK_CLIENT_TIMEOUT_SECONDS[event]);
    }
    for (const event of ["SessionStart", "UserPromptSubmit", "PreToolUse"]) {
      expect(settings.hooks[event][0].hooks[0].timeout).toBeGreaterThan(0);
    }
    expect(settings.hooks.Stop[0].hooks[0].timeout).toBeUndefined();
  });

  test("a hook installed before the timeout existed gains it in place; re-runs change nothing", async () => {
    const home = await tempHome();
    const paths = resolvePaths(home);
    await mkdir(paths.claudeDir, { recursive: true });
    const url = standupHookDefinition("Stop").url;
    const userHook = { type: "command", command: "echo mine" };
    await writeFile(
      paths.settingsPath,
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [{ hooks: [userHook] }, { hooks: [{ type: "http", url }] }],
          PreToolUse: [{ hooks: [{ type: "http", url, timeout: 99 }] }],
        },
      })
    );
    setupHooks(paths);
    const once = await readFile(paths.settingsPath, "utf-8");
    const settings = JSON.parse(once);
    expect(settings.hooks.UserPromptSubmit).toEqual([
      { hooks: [userHook] },
      { hooks: [{ type: "http", url, timeout: HOOK_CLIENT_TIMEOUT_SECONDS.UserPromptSubmit }] },
    ]);
    expect(settings.hooks.PreToolUse).toEqual([{ hooks: [{ type: "http", url, timeout: HOOK_CLIENT_TIMEOUT_SECONDS.PreToolUse }] }]);
    setupHooks(paths);
    expect(await readFile(paths.settingsPath, "utf-8")).toBe(once);
  });
});

describe("setupSteering / removeSteering against a temp HOME", () => {
  test("fresh install adds the block + installs the skill; re-run is a no-op in place; remove cleans up; user content preserved", async () => {
    const home = await tempHome();
    const paths = resolvePaths(home);

    // Seed a CLAUDE.md with the user's own content.
    await mkdir(paths.claudeDir, { recursive: true });
    const userContent = "# Global notes\n\n## My rules\n\nDo the thing my way.\n";
    await writeFile(paths.claudeMdPath, userContent);

    // --- Fresh install ---
    setupSteering(paths);

    // Skill installed.
    const skillFile = join(paths.skillDir, "SKILL.md");
    expect(existsSync(skillFile)).toBe(true);
    const skill = await readFile(skillFile, "utf-8");
    expect(skill).toContain("Standup agent steering");
    expect(skill).toContain("propose_standup_improvement");

    // Managed block added exactly once, user content preserved.
    let claudeMd = await readFile(paths.claudeMdPath, "utf-8");
    expect(claudeMd).toContain("Do the thing my way.");
    expect(claudeMd).toContain("## My rules");
    expect(countOccurrences(claudeMd, STEERING_BEGIN)).toBe(1);
    expect(claudeMd).toContain("propose_standup_improvement");
    // Both harnesses auto-discover the skill, so the steering uses the same
    // bare-name reference; Claude's CLAUDE.md block is unchanged.
    expect(claudeMd).toContain(SKILL_REFERENCE);
    // The block is the first thing in the file, ahead of the user's content.
    expect(claudeMd.startsWith(STEERING_BEGIN)).toBe(true);
    expect(claudeMd.indexOf(STEERING_END)).toBeLessThan(claudeMd.indexOf("# Global notes"));

    // --- Re-run: idempotent, no duplication, content byte-identical ---
    const afterFirst = claudeMd;
    setupSteering(paths);
    claudeMd = await readFile(paths.claudeMdPath, "utf-8");
    expect(claudeMd).toBe(afterFirst);
    expect(countOccurrences(claudeMd, STEERING_BEGIN)).toBe(1);

    // --- Remove: block gone, skill gone, user content preserved ---
    removeSteering(paths);
    claudeMd = await readFile(paths.claudeMdPath, "utf-8");
    expect(claudeMd).not.toContain(STEERING_BEGIN);
    expect(claudeMd).not.toContain(STEERING_END);
    expect(claudeMd).toContain("Do the thing my way.");
    expect(claudeMd).toContain("## My rules");
    expect(existsSync(paths.skillDir)).toBe(false);
  });

  test("install works when no CLAUDE.md exists yet", async () => {
    const home = await tempHome();
    const paths = resolvePaths(home);

    setupSteering(paths);
    expect(existsSync(paths.claudeMdPath)).toBe(true);
    const claudeMd = await readFile(paths.claudeMdPath, "utf-8");
    expect(countOccurrences(claudeMd, STEERING_BEGIN)).toBe(1);
    expect(claudeMd).toBe(`${steeringBlock()}\n`);
  });

  test("a block an earlier install left at the END of CLAUDE.md is moved to the top; a second run is a no-op", async () => {
    const home = await tempHome();
    const paths = resolvePaths(home);
    await mkdir(paths.claudeDir, { recursive: true });
    const userContent = "# Global notes\n\n## Code style\n\nUse imports.\n";
    // The shape the append-at-end installer wrote, with a stale body.
    const stale = `${STEERING_BEGIN}\nold steering body\n${STEERING_END}`;
    await writeFile(paths.claudeMdPath, `${userContent}\n${stale}\n`);

    setupSteering(paths);
    const moved = await readFile(paths.claudeMdPath, "utf-8");
    expect(moved).toBe(`${steeringBlock()}\n\n${userContent}`);
    expect(moved).not.toContain("old steering body");
    expect(countOccurrences(moved, STEERING_BEGIN)).toBe(1);

    setupSteering(paths);
    expect(await readFile(paths.claudeMdPath, "utf-8")).toBe(moved);

    // A block sitting in the middle of the file moves up the same way.
    await writeFile(paths.claudeMdPath, `# Top\n\n${steeringBlock()}\n\n## Bottom\n`);
    setupSteering(paths);
    expect(await readFile(paths.claudeMdPath, "utf-8")).toBe(`${steeringBlock()}\n\n# Top\n\n## Bottom\n`);
  });

  test("L2: a user's OWN skill sharing the name is neither overwritten on install nor deleted on remove", async () => {
    const home = await tempHome();
    const paths = resolvePaths(home);

    // A pre-existing FOREIGN skill named "standup" — no Standup ownership marker.
    await mkdir(paths.skillDir, { recursive: true });
    await writeFile(join(paths.skillDir, "SKILL.md"), "# My own standup skill\n\nUnrelated to the Standup app.\n");
    await writeFile(join(paths.skillDir, "notes.md"), "keep me");

    // Install must NOT clobber it.
    setupSteering(paths);
    expect(await readFile(join(paths.skillDir, "SKILL.md"), "utf-8")).toContain("My own standup skill");
    expect(existsSync(join(paths.skillDir, "notes.md"))).toBe(true);

    // Remove must NOT delete it.
    removeSteering(paths);
    expect(existsSync(join(paths.skillDir, "SKILL.md"))).toBe(true);
    expect(existsSync(join(paths.skillDir, "notes.md"))).toBe(true);
  });

  test("runSetup({ removeSteering }) only removes and leaves hooks/MCP untouched", async () => {
    const home = await tempHome();
    const paths = resolvePaths(home);

    // Full install first.
    runSetup({ home });
    expect(existsSync(paths.settingsPath)).toBe(true);
    expect(existsSync(paths.skillDir)).toBe(true);

    // Remove steering only.
    runSetup({ home, removeSteering: true });
    expect(existsSync(paths.skillDir)).toBe(false);
    // Hooks + MCP survive a steering removal.
    expect(existsSync(paths.settingsPath)).toBe(true);
    expect(existsSync(paths.claudeJsonPath)).toBe(true);
    const claudeMd = await readFile(paths.claudeMdPath, "utf-8");
    expect(claudeMd).not.toContain(STEERING_BEGIN);
  });
});

describe("bundled skill install", () => {
  /** A bundled skill whose source dir holds a SKILL.md with its marker and an executable script. */
  async function fixtureSkill(): Promise<BundledSkill> {
    const sourceDir = join(await tempHome(), "source", "evidence-helper");
    await mkdir(join(sourceDir, "scripts"), { recursive: true });
    await writeFile(join(sourceDir, "SKILL.md"), "---\nname: evidence-helper\n---\nUses AttachEvidence.\n");
    await writeFile(join(sourceDir, "scripts", "attach.sh"), "#!/bin/sh\necho ok\n");
    await chmod(join(sourceDir, "scripts", "attach.sh"), 0o755);
    return { name: "evidence-helper", sourceDir, marker: "AttachEvidence" };
  }

  test("every bundled skill's SKILL.md contains its ownership marker", async () => {
    expect(BUNDLED_SKILLS.length).toBeGreaterThan(0);
    for (const skill of BUNDLED_SKILLS) {
      const md = await readFile(join(skill.sourceDir, "SKILL.md"), "utf-8");
      expect(md).toContain(`name: ${skill.name}`);
      expect(md).toContain(skill.marker);
    }
  });

  test("installs a skill with an executable script, cleans stale files on a re-run, and removes it", async () => {
    const skill = await fixtureSkill();
    const paths = resolvePaths(await tempHome());
    const installed = join(paths.skillsDir, skill.name);

    installSkill(paths.skillsDir, skill);
    expect(await readFile(join(installed, "SKILL.md"), "utf-8")).toContain("name: evidence-helper");
    expect(statSync(join(installed, "scripts", "attach.sh")).mode & 0o111).not.toBe(0);

    // A stale file in our dir is cleaned up by a re-run.
    await writeFile(join(installed, "stale.txt"), "old");
    installSkill(paths.skillsDir, skill);
    expect(existsSync(join(installed, "stale.txt"))).toBe(false);

    removeSkill(paths.skillsDir, skill);
    expect(existsSync(installed)).toBe(false);
  });

  test("a user's own skill of the same name is neither overwritten nor removed", async () => {
    const skill = await fixtureSkill();
    const paths = resolvePaths(await tempHome());
    const installed = join(paths.skillsDir, skill.name);
    await mkdir(installed, { recursive: true });
    await writeFile(join(installed, "SKILL.md"), "# My own evidence-helper\n");

    installSkill(paths.skillsDir, skill);
    expect(await readFile(join(installed, "SKILL.md"), "utf-8")).toBe("# My own evidence-helper\n");

    // The bundled skills still install alongside the user's own skill.
    setupSteering(paths);
    expect(existsSync(join(paths.skillsDir, "standup", "SKILL.md"))).toBe(true);
    expect(await readFile(join(installed, "SKILL.md"), "utf-8")).toBe("# My own evidence-helper\n");

    removeSkill(paths.skillsDir, skill);
    expect(existsSync(join(installed, "SKILL.md"))).toBe(true);
  });

  test("Claude and Codex steering install and remove every bundled skill", async () => {
    const paths = resolvePaths(await tempHome());

    setupSteering(paths);
    setupCodexSteering(paths);
    for (const skill of BUNDLED_SKILLS) {
      expect(existsSync(join(paths.skillsDir, skill.name, "SKILL.md"))).toBe(true);
      expect(existsSync(join(paths.codexSkillsDir, skill.name, "SKILL.md"))).toBe(true);
    }

    removeSteering(paths);
    removeCodex(paths);
    for (const skill of BUNDLED_SKILLS) {
      expect(existsSync(join(paths.skillsDir, skill.name))).toBe(false);
      expect(existsSync(join(paths.codexSkillsDir, skill.name))).toBe(false);
    }
  });
});

/**
 * Parses a config.toml the installer wrote, using Bun's native TOML loader, so
 * the tests assert on the real parsed shape Codex would see (not just the raw
 * string). Each test uses a unique temp HOME, so the import path never collides.
 */
async function parseCodexConfig(path: string): Promise<any> {
  return (await import(path)).default;
}

describe("Codex wiring against a temp HOME", () => {
  test("codexMcpBlock is a valid, parseable [mcp_servers.standup] stdio table", async () => {
    const home = await tempHome();
    const paths = resolvePaths(home);
    await mkdir(paths.codexDir, { recursive: true });
    await writeFile(paths.codexConfigPath, `${codexMcpBlock()}\n`);

    const cfg = await parseCodexConfig(paths.codexConfigPath);
    expect(cfg.mcp_servers.standup.command).toBe("bun");
    expect(cfg.mcp_servers.standup.args[0]).toBe("run");
    expect(cfg.mcp_servers.standup.args).toHaveLength(2);
    expect(cfg.mcp_servers.standup.env.COLLECTOR_URL).toBeTruthy();
  });

  test("fresh install writes MCP entry + AGENTS.md block + skill; re-run byte-identical; remove cleans up", async () => {
    const home = await tempHome();
    const paths = resolvePaths(home);

    setupCodexMcp(paths);
    setupCodexSteering(paths);

    // MCP table written and parseable.
    let configRaw = await readFile(paths.codexConfigPath, "utf-8");
    expect(configRaw).toContain(CODEX_MCP_BEGIN);
    expect(configRaw).toContain(CODEX_MCP_END);
    const cfg = await parseCodexConfig(paths.codexConfigPath);
    expect(cfg.mcp_servers.standup.command).toBe("bun");

    // AGENTS.md steering block, exactly once.
    let agents = await readFile(paths.codexAgentsMdPath, "utf-8");
    expect(countOccurrences(agents, STEERING_BEGIN)).toBe(1);
    expect(agents).toContain("propose_standup_improvement");

    // Skill installed under the Codex skills dir.
    const skillFile = join(paths.codexSkillDir, "SKILL.md");
    expect(existsSync(skillFile)).toBe(true);
    expect(await readFile(skillFile, "utf-8")).toContain("Standup agent steering");

    // --- Re-run: idempotent, byte-identical for both files ---
    const configBefore = configRaw;
    const agentsBefore = agents;
    setupCodexMcp(paths);
    setupCodexSteering(paths);
    configRaw = await readFile(paths.codexConfigPath, "utf-8");
    agents = await readFile(paths.codexAgentsMdPath, "utf-8");
    expect(configRaw).toBe(configBefore);
    expect(agents).toBe(agentsBefore);

    // --- Remove: MCP table gone, steering block gone, skill gone ---
    removeCodex(paths);
    configRaw = await readFile(paths.codexConfigPath, "utf-8");
    expect(configRaw).not.toContain(CODEX_MCP_BEGIN);
    expect(configRaw).not.toContain("[mcp_servers.standup]");
    agents = await readFile(paths.codexAgentsMdPath, "utf-8");
    expect(agents).not.toContain(STEERING_BEGIN);
    expect(existsSync(paths.codexSkillDir)).toBe(false);
  });

  test("preserves a pre-existing foreign ~/.codex config and user AGENTS.md content", async () => {
    const home = await tempHome();
    const paths = resolvePaths(home);
    await mkdir(paths.codexDir, { recursive: true });

    // A foreign config: unrelated top-level keys + another MCP server.
    const foreignConfig =
      `# my codex config\nmodel = "gpt-5"\n\n[mcp_servers.other]\ncommand = "x"\nargs = ["a"]\n`;
    await writeFile(paths.codexConfigPath, foreignConfig);
    const userAgents = "# My AGENTS.md\n\n## House rules\n\nAlways write tests.\n";
    await writeFile(paths.codexAgentsMdPath, userAgents);

    setupCodexMcp(paths);
    setupCodexSteering(paths);

    // Foreign config content survives byte-for-byte, alongside our new table.
    const configRaw = await readFile(paths.codexConfigPath, "utf-8");
    expect(configRaw).toContain(foreignConfig.trimEnd());
    const cfg = await parseCodexConfig(paths.codexConfigPath);
    expect(cfg.model).toBe("gpt-5");
    expect(cfg.mcp_servers.other.command).toBe("x");
    expect(cfg.mcp_servers.standup.command).toBe("bun");

    // User's AGENTS.md content preserved; block placed exactly once, ahead of it.
    const agents = await readFile(paths.codexAgentsMdPath, "utf-8");
    expect(agents).toContain("Always write tests.");
    expect(agents).toContain("## House rules");
    expect(countOccurrences(agents, STEERING_BEGIN)).toBe(1);
    expect(agents.startsWith(STEERING_BEGIN)).toBe(true);
    expect(agents).toBe(`${steeringBlock()}\n\n${userAgents}`);

    // Remove leaves the foreign config + other server + user AGENTS.md intact.
    removeCodex(paths);
    const afterCfg = await parseCodexConfig(paths.codexConfigPath + "?after");
    expect(afterCfg.model).toBe("gpt-5");
    expect(afterCfg.mcp_servers.other.command).toBe("x");
    expect(afterCfg.mcp_servers.standup).toBeUndefined();
    const afterAgents = await readFile(paths.codexAgentsMdPath, "utf-8");
    expect(afterAgents).toContain("Always write tests.");
    expect(afterAgents).not.toContain(STEERING_BEGIN);
  });

  test("a user-owned Codex skill sharing the name is neither overwritten on install nor deleted on remove", async () => {
    const home = await tempHome();
    const paths = resolvePaths(home);

    // A foreign skill named "standup" — no Standup ownership marker.
    await mkdir(paths.codexSkillDir, { recursive: true });
    await writeFile(join(paths.codexSkillDir, "SKILL.md"), "# My own standup skill\n\nUnrelated.\n");
    await writeFile(join(paths.codexSkillDir, "notes.md"), "keep me");

    setupCodexSteering(paths);
    expect(await readFile(join(paths.codexSkillDir, "SKILL.md"), "utf-8")).toContain("My own standup skill");
    expect(existsSync(join(paths.codexSkillDir, "notes.md"))).toBe(true);

    removeCodex(paths);
    expect(existsSync(join(paths.codexSkillDir, "SKILL.md"))).toBe(true);
    expect(existsSync(join(paths.codexSkillDir, "notes.md"))).toBe(true);
  });

  test("a pre-existing UNMANAGED [mcp_servers.standup] table is replaced in place, never duplicated", async () => {
    const home = await tempHome();
    const paths = resolvePaths(home);
    await mkdir(paths.codexDir, { recursive: true });

    // What a user who ran `codex mcp add standup` earlier would have — a bare
    // standup table with NO managed markers, next to another server.
    const preexisting =
      `model = "gpt-5"\n\n[mcp_servers.standup]\ncommand = "node"\nargs = ["old.js"]\n\n[mcp_servers.other]\ncommand = "x"\n`;
    await writeFile(paths.codexConfigPath, preexisting);

    setupCodexMcp(paths);

    const configRaw = await readFile(paths.codexConfigPath, "utf-8");
    // Exactly ONE standup table — no config-breaking duplicate redefinition.
    expect(countOccurrences(configRaw, "[mcp_servers.standup]")).toBe(1);
    // The whole file still parses (a duplicate would fail "Cannot redefine key").
    const cfg = (Bun as any).TOML.parse(configRaw);
    expect(cfg.model).toBe("gpt-5");
    expect(cfg.mcp_servers.other.command).toBe("x");
    // Our registration took over the standup key, mirroring the Claude upsert.
    expect(cfg.mcp_servers.standup.command).toBe("bun");
    expect(cfg.mcp_servers.standup.args[0]).toBe("run");
    expect(cfg.mcp_servers.standup.env.COLLECTOR_URL).toBeTruthy();

    // Re-run over the now-managed table is idempotent + byte-identical.
    const before = configRaw;
    setupCodexMcp(paths);
    expect(await readFile(paths.codexConfigPath, "utf-8")).toBe(before);
  });

  test("a pre-existing standup table WITH an [mcp_servers.standup.env] subtable (codex mcp add --env) is reclaimed whole — no duplicate env, no throw", async () => {
    const home = await tempHome();
    const paths = resolvePaths(home);
    await mkdir(paths.codexDir, { recursive: true });

    // Exactly what `codex mcp add standup --env COLLECTOR_URL=http://old` writes:
    // a flat [mcp_servers.standup] table AND a separate [mcp_servers.standup.env]
    // SUBTABLE for the env, sitting next to another server.
    const preexisting = [
      'model = "gpt-5"',
      "",
      "[mcp_servers.standup]",
      'command = "node"',
      'args = ["old.js"]',
      "",
      "[mcp_servers.standup.env]",
      'COLLECTOR_URL = "http://old"',
      'EXTRA = "keep-none"',
      "",
      "[mcp_servers.other]",
      'command = "x"',
      "",
    ].join("\n");
    await writeFile(paths.codexConfigPath, preexisting);

    // Must NOT throw: reclaiming only the flat table would strand the env
    // subtable, whose key then collides with the managed inline `env`, making the
    // whole file unparseable and aborting the wiring via the write guard.
    expect(() => setupCodexMcp(paths)).not.toThrow();

    const configRaw = await readFile(paths.codexConfigPath, "utf-8");
    // Exactly one standup table, and no orphaned env subtable left behind.
    expect(countOccurrences(configRaw, "[mcp_servers.standup]")).toBe(1);
    expect(configRaw).not.toContain("[mcp_servers.standup.env]");

    // The whole file still parses — a leftover subtable would fail on the
    // duplicate `env` key ("Cannot redefine key").
    const cfg = (Bun as any).TOML.parse(configRaw);
    expect(cfg.model).toBe("gpt-5");
    expect(cfg.mcp_servers.other.command).toBe("x");
    // Our managed registration took over the standup key + env entirely.
    expect(cfg.mcp_servers.standup.command).toBe("bun");
    expect(cfg.mcp_servers.standup.args[0]).toBe("run");
    expect(cfg.mcp_servers.standup.env.COLLECTOR_URL).toBeTruthy();
    expect(cfg.mcp_servers.standup.env.EXTRA).toBeUndefined();

    // Re-run over the now-managed table is idempotent + byte-identical.
    const beforeRerun = configRaw;
    expect(() => setupCodexMcp(paths)).not.toThrow();
    expect(await readFile(paths.codexConfigPath, "utf-8")).toBe(beforeRerun);
  });

  test("codexConfigWithStandup (pure) reclaims a flat table + its env subtable into one valid table", () => {
    const input = [
      'model = "gpt-5"',
      "",
      "[mcp_servers.standup]",
      'command = "node"',
      'args = ["old.js"]',
      "",
      "[mcp_servers.standup.env]",
      'COLLECTOR_URL = "http://old"',
      "",
      "[mcp_servers.other]",
      'command = "x"',
      "",
    ].join("\n");

    const out = codexConfigWithStandup(input);
    expect(countOccurrences(out, "[mcp_servers.standup]")).toBe(1);
    expect(out).not.toContain("[mcp_servers.standup.env]");

    const cfg = (Bun as any).TOML.parse(out);
    expect(cfg.model).toBe("gpt-5");
    expect(cfg.mcp_servers.other.command).toBe("x");
    expect(cfg.mcp_servers.standup.command).toBe("bun");
    expect(cfg.mcp_servers.standup.env.COLLECTOR_URL).toBeTruthy();

    // Idempotent: a second pass over the managed output is byte-identical.
    expect(codexConfigWithStandup(out)).toBe(out);
  });

  test("a sibling [mcp_servers.standupother] table is NOT mistaken for standup's and survives", () => {
    const input = `model = "gpt-5"\n\n[mcp_servers.standupother]\ncommand = "keep"\n`;
    const out = codexConfigWithStandup(input);
    const cfg = (Bun as any).TOML.parse(out);
    expect(cfg.mcp_servers.standupother.command).toBe("keep");
    expect(cfg.mcp_servers.standup.command).toBe("bun");
  });

  test("sibling servers whose names START WITH standup but differ at a hyphen/underscore survive (word boundary is not a name boundary)", () => {
    // Hyphens are the norm in MCP server names (example-mcp, docs-search-mcp), so
    // a user's own `standup-mcp`/`standup-dev` next to Standup's table is common.
    // A `\b`-based reclaim wrongly treats the hyphen as a boundary and swallows
    // these siblings; each is a DISTINCT server that must survive untouched.
    const input = [
      'model = "gpt-5"',
      "",
      "[mcp_servers.standup-mcp]",
      'command = "keep-hyphen"',
      "",
      "[mcp_servers.standup_mcp]",
      'command = "keep-underscore"',
      "",
      "[mcp_servers.standup-dev]",
      'command = "keep-dev"',
      "",
    ].join("\n");

    const out = codexConfigWithStandup(input);
    const cfg = (Bun as any).TOML.parse(out);
    expect(cfg.mcp_servers["standup-mcp"].command).toBe("keep-hyphen");
    expect(cfg.mcp_servers["standup_mcp"].command).toBe("keep-underscore");
    expect(cfg.mcp_servers["standup-dev"].command).toBe("keep-dev");
    // Standup's own table is still added exactly once.
    expect(countOccurrences(out, "[mcp_servers.standup]")).toBe(1);
    expect(cfg.mcp_servers.standup.command).toBe("bun");
  });

  test("install then remove leave a user's own [mcp_servers.standup-mcp] server intact (no silent data loss)", async () => {
    const home = await tempHome();
    const paths = resolvePaths(home);
    await mkdir(paths.codexDir, { recursive: true });

    // The user has BOTH Standup's server and their own hyphenated `standup-mcp`.
    const preexisting = [
      'model = "gpt-5"',
      "",
      "[mcp_servers.standup]",
      'command = "node"',
      'args = ["old.js"]',
      "",
      "[mcp_servers.standup-mcp]",
      'command = "mine"',
      'args = ["mine.js"]',
      "",
    ].join("\n");
    await writeFile(paths.codexConfigPath, preexisting);

    setupCodexMcp(paths);
    let cfg = (Bun as any).TOML.parse(await readFile(paths.codexConfigPath, "utf-8"));
    // Standup's table is upserted; the user's separate server is NOT reclaimed.
    expect(cfg.mcp_servers.standup.command).toBe("bun");
    expect(cfg.mcp_servers["standup-mcp"]).toBeTruthy();
    expect(cfg.mcp_servers["standup-mcp"].command).toBe("mine");

    // --remove-codex must tear down ONLY standup, leaving the sibling live.
    removeCodex(paths);
    cfg = (Bun as any).TOML.parse(await readFile(paths.codexConfigPath, "utf-8"));
    expect(cfg.mcp_servers.standup).toBeUndefined();
    expect(cfg.mcp_servers["standup-mcp"].command).toBe("mine");
  });

  test("an inline `standup = {...}` key under a [mcp_servers] parent table is reclaimed, not duplicated", () => {
    // A common TOML style: group every server as an inline table under one
    // [mcp_servers] parent, rather than a [mcp_servers.<name>] header each.
    const input = [
      'model = "gpt-5"',
      "",
      "[mcp_servers]",
      'standup = { command = "node", args = ["old.js"] }',
      'other = { command = "x" }',
      "",
    ].join("\n");

    const out = codexConfigWithStandup(input);
    // The whole file must still parse — a leftover inline `standup` alongside the
    // appended [mcp_servers.standup] table would fail "Cannot redefine key".
    const cfg = (Bun as any).TOML.parse(out);
    expect(cfg.model).toBe("gpt-5");
    expect(cfg.mcp_servers.other.command).toBe("x");
    expect(cfg.mcp_servers.standup.command).toBe("bun");
    expect(cfg.mcp_servers.standup.args[0]).toBe("run");

    // Idempotent: a second pass over the managed output is byte-identical.
    expect(codexConfigWithStandup(out)).toBe(out);
  });

  test("install over an inline `standup = {...}` under [mcp_servers] never throws; remove strips it and keeps the siblings", async () => {
    const home = await tempHome();
    const paths = resolvePaths(home);
    await mkdir(paths.codexDir, { recursive: true });

    const preexisting = [
      'model = "gpt-5"',
      "",
      "[mcp_servers]",
      'standup = { command = "node", args = ["old.js"] }',
      'other = { command = "x" }',
      "",
    ].join("\n");
    await writeFile(paths.codexConfigPath, preexisting);

    // The inline form defines mcp_servers.standup; appending a second table would
    // otherwise throw "Cannot redefine key" and abort the whole Codex wiring.
    expect(() => setupCodexMcp(paths)).not.toThrow();
    let cfg = (Bun as any).TOML.parse(await readFile(paths.codexConfigPath, "utf-8"));
    expect(cfg.mcp_servers.standup.command).toBe("bun");
    expect(cfg.mcp_servers.other.command).toBe("x");

    // --remove-codex reclaims the inline registration too, leaving the sibling.
    removeCodex(paths);
    cfg = (Bun as any).TOML.parse(await readFile(paths.codexConfigPath, "utf-8"));
    expect(cfg.mcp_servers.standup).toBeUndefined();
    expect(cfg.mcp_servers.other.command).toBe("x");
  });

  test("an inline sibling `standup-mcp = {...}` under [mcp_servers] is not mistaken for standup", () => {
    const input = [
      'model = "gpt-5"',
      "",
      "[mcp_servers]",
      'standup-mcp = { command = "mine" }',
      "",
    ].join("\n");

    const out = codexConfigWithStandup(input);
    const cfg = (Bun as any).TOML.parse(out);
    expect(cfg.mcp_servers["standup-mcp"].command).toBe("mine");
    expect(cfg.mcp_servers.standup.command).toBe("bun");
  });

  test("marker loss (a formatter drops the # BEGIN/# END comments) is reclaimed, not duplicated", async () => {
    const home = await tempHome();
    const paths = resolvePaths(home);

    // Clean install first.
    setupCodexMcp(paths);
    let configRaw = await readFile(paths.codexConfigPath, "utf-8");
    expect(configRaw).toContain(CODEX_MCP_BEGIN);

    // Simulate a TOML formatter (e.g. taplo) or a user tidying the file and
    // dropping our comment markers — the standup table itself remains.
    const stripped = configRaw
      .split("\n")
      .filter((l) => l.trim() !== CODEX_MCP_BEGIN && l.trim() !== CODEX_MCP_END)
      .join("\n");
    expect(stripped).not.toContain(CODEX_MCP_BEGIN);
    expect(stripped).toContain("[mcp_servers.standup]");
    await writeFile(paths.codexConfigPath, stripped);

    // Re-run: it must reclaim the stranded table, not append a second one.
    setupCodexMcp(paths);
    configRaw = await readFile(paths.codexConfigPath, "utf-8");
    expect(countOccurrences(configRaw, "[mcp_servers.standup]")).toBe(1);
    const cfg = (Bun as any).TOML.parse(configRaw);
    expect(cfg.mcp_servers.standup.command).toBe("bun");
    // The managed markers are restored so the next run updates in place.
    expect(configRaw).toContain(CODEX_MCP_BEGIN);
  });

  test("codexConfigWithStandup (pure) reclaims a foreign table and yields valid single-table TOML", () => {
    // The reviewer's exact repro input.
    const input = 'model = "gpt-5"\n\n[mcp_servers.standup]\ncommand="node"\nargs=["old.js"]';
    const out = codexConfigWithStandup(input);

    expect(countOccurrences(out, "[mcp_servers.standup]")).toBe(1);
    const cfg = (Bun as any).TOML.parse(out);
    expect(cfg.model).toBe("gpt-5");
    expect(cfg.mcp_servers.standup.command).toBe("bun");

    // Idempotent: a second pass over the managed output is byte-identical.
    expect(codexConfigWithStandup(out)).toBe(out);
  });

  test("the Codex skill lands at ~/.codex/skills/standup where Codex auto-discovers it, and AGENTS.md references it by name — never asserting Codex lacks skills", async () => {
    const home = await tempHome();
    const paths = resolvePaths(home);

    setupCodexSteering(paths);

    // The SKILL.md lands under ~/.codex/skills/standup — the location Codex
    // discovers skills in, parallel to Claude — carrying the frontmatter
    // (name + description) that makes it a valid, auto-loadable skill.
    expect(paths.codexSkillDir).toBe(join(home, ".codex", "skills", "standup"));
    const skillPath = join(paths.codexSkillDir, "SKILL.md");
    expect(existsSync(skillPath)).toBe(true);
    const skill = await readFile(skillPath, "utf-8");
    expect(skill).toContain("name: standup");
    expect(skill).toContain("description:");

    // Codex auto-discovers the skill by name, so the AGENTS.md steering uses the
    // SAME bare-name cross-reference as Claude and must NOT inject the false
    // instruction that Codex has no skills / cannot auto-load them.
    const agents = await readFile(paths.codexAgentsMdPath, "utf-8");
    expect(agents).toContain(SKILL_REFERENCE);
    const lowered = agents.toLowerCase();
    expect(lowered).not.toContain("does not auto-load");
    expect(lowered).not.toContain("no skill auto-discovery");
    expect(lowered).not.toContain("does not auto-discover");
    expect(lowered).not.toContain("no skills concept");
    expect(lowered).not.toContain("has no skills");
  });

  test("remove reclaims a marker-lost [mcp_servers.standup] table (uninstall is symmetric with install)", async () => {
    const home = await tempHome();
    const paths = resolvePaths(home);
    await mkdir(paths.codexDir, { recursive: true });

    // Clean install alongside another server.
    await writeFile(paths.codexConfigPath, `model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "x"\n`);
    setupCodexMcp(paths);
    let configRaw = await readFile(paths.codexConfigPath, "utf-8");
    expect(configRaw).toContain(CODEX_MCP_BEGIN);

    // A formatter/user drops the # BEGIN/# END comment markers; the standup
    // table itself survives — the exact scenario the install path reclaims.
    const stripped = configRaw
      .split("\n")
      .filter((l) => l.trim() !== CODEX_MCP_BEGIN && l.trim() !== CODEX_MCP_END)
      .join("\n");
    expect(stripped).not.toContain(CODEX_MCP_BEGIN);
    expect(stripped).toContain("[mcp_servers.standup]");
    await writeFile(paths.codexConfigPath, stripped);

    // --remove-codex must still uninstall the stranded table, not leave it live.
    removeCodex(paths);
    configRaw = await readFile(paths.codexConfigPath, "utf-8");
    expect(configRaw).not.toContain("[mcp_servers.standup]");
    expect(configRaw).not.toContain(CODEX_MCP_BEGIN);
    // Other config + server are preserved and the file still parses.
    const cfg = (Bun as any).TOML.parse(configRaw);
    expect(cfg.model).toBe("gpt-5");
    expect(cfg.mcp_servers.other.command).toBe("x");
    expect(cfg.mcp_servers.standup).toBeUndefined();
  });

  test("codexConfigWithoutStandup (pure) reclaims managed, marker-lost, and foreign tables alike", () => {
    // Managed block -> table gone, other keys intact.
    const managed = codexConfigWithStandup(`model = "gpt-5"\n`);
    expect(managed).toContain(CODEX_MCP_BEGIN);
    const fromManaged = codexConfigWithoutStandup(managed);
    expect(fromManaged).not.toContain("[mcp_servers.standup]");
    expect(fromManaged).not.toContain(CODEX_MCP_BEGIN);
    expect((Bun as any).TOML.parse(fromManaged).model).toBe("gpt-5");

    // Marker-lost: a managed table whose # comment markers were dropped.
    const markerLost = managed
      .split("\n")
      .filter((l) => l.trim() !== CODEX_MCP_BEGIN && l.trim() !== CODEX_MCP_END)
      .join("\n");
    expect(markerLost).toContain("[mcp_servers.standup]");
    const fromMarkerLost = codexConfigWithoutStandup(markerLost);
    expect(fromMarkerLost).not.toContain("[mcp_servers.standup]");
    expect((Bun as any).TOML.parse(fromMarkerLost).model).toBe("gpt-5");

    // Foreign hand-added table next to another server -> only standup removed.
    const foreign = `model = "gpt-5"\n\n[mcp_servers.standup]\ncommand="node"\nargs=["old.js"]\n\n[mcp_servers.other]\ncommand="x"\n`;
    const fromForeign = codexConfigWithoutStandup(foreign);
    expect(fromForeign).not.toContain("[mcp_servers.standup]");
    const cfg = (Bun as any).TOML.parse(fromForeign);
    expect(cfg.model).toBe("gpt-5");
    expect(cfg.mcp_servers.other.command).toBe("x");
    expect(cfg.mcp_servers.standup).toBeUndefined();

    // No standup registration at all -> unchanged.
    const clean = `model = "gpt-5"\n\n[mcp_servers.other]\ncommand="x"\n`;
    expect(codexConfigWithoutStandup(clean)).toBe(clean);
  });
});

describe("runSetup Codex flags leave Claude the default and additive", () => {
  test("codexOnly wires Codex and leaves the Claude paths untouched", async () => {
    const home = await tempHome();
    const paths = resolvePaths(home);

    runSetup({ home, codexOnly: true });

    // Codex wired.
    expect(existsSync(paths.codexConfigPath)).toBe(true);
    expect(existsSync(paths.codexAgentsMdPath)).toBe(true);
    expect(existsSync(paths.codexSkillDir)).toBe(true);
    // Claude left completely alone.
    expect(existsSync(paths.settingsPath)).toBe(false);
    expect(existsSync(paths.claudeJsonPath)).toBe(false);
    expect(existsSync(paths.skillDir)).toBe(false);
  });

  test("codex wires BOTH harnesses; removeCodex tears down only Codex", async () => {
    const home = await tempHome();
    const paths = resolvePaths(home);

    runSetup({ home, codex: true });

    // Claude fully wired (default behavior unchanged) ...
    expect(existsSync(paths.settingsPath)).toBe(true);
    expect(existsSync(paths.claudeJsonPath)).toBe(true);
    expect(existsSync(paths.skillDir)).toBe(true);
    // ... and Codex wired alongside.
    expect(existsSync(paths.codexConfigPath)).toBe(true);
    expect(existsSync(paths.codexSkillDir)).toBe(true);

    // removeCodex only tears down Codex; Claude survives.
    runSetup({ home, removeCodex: true });
    expect(existsSync(paths.codexSkillDir)).toBe(false);
    const config = await readFile(paths.codexConfigPath, "utf-8");
    expect(config).not.toContain(CODEX_MCP_BEGIN);
    expect(existsSync(paths.settingsPath)).toBe(true);
    expect(existsSync(paths.skillDir)).toBe(true);
  });
});

/**
 * The opt-in redeploy git hook, installed into a TEMP git repository only —
 * never the real one. The hook itself is never run here (it would redeploy).
 */
describe("--git-hooks: the redeploy git hook", () => {
  async function tempRepo(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "standup-setup-repo-"));
    dirs.push(dir);
    const init = Bun.spawnSync(["git", "init", "-q", "-b", "main", dir], { stdout: "pipe", stderr: "pipe" });
    expect(init.exitCode).toBe(0);
    return dir;
  }

  test("copies the versioned template into the common git dir's hooks, executable, as itself and as post-merge", async () => {
    const repo = await tempRepo();
    const template = await readFile(REDEPLOY_HOOK_TEMPLATE, "utf-8");
    expect(template).toContain(REDEPLOY_HOOK_MARKER);
    const result = installGitHooks(repo);
    expect(result.hooksDir).toBe(join(realpathSync(repo), ".git", "hooks"));
    expect(result.installed).toEqual([...REDEPLOY_HOOK_FILES]);
    expect(result.skipped).toEqual([]);
    expect(result.replaced).toEqual([]);
    for (const name of REDEPLOY_HOOK_FILES) {
      const path = join(result.hooksDir, name);
      expect(await readFile(path, "utf-8")).toBe(template);
      expect(statSync(path).mode & 0o777).toBe(0o755);
    }
    // A re-run replaces our own copies in place.
    expect(installGitHooks(repo).installed).toEqual([...REDEPLOY_HOOK_FILES]);
  });

  test("a worktree installs into the shared common dir, not its own git dir", async () => {
    const repo = await tempRepo();
    const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
    expect(Bun.spawnSync(["git", "-C", repo, "commit", "-q", "--allow-empty", "-m", "init"], { env }).exitCode).toBe(0);
    const tree = join(repo, "..", `${repo.split("/").pop()}-wt`);
    dirs.push(tree);
    expect(Bun.spawnSync(["git", "-C", repo, "worktree", "add", "-q", tree, "-b", "feature"], { env }).exitCode).toBe(0);
    expect(installGitHooks(tree).hooksDir).toBe(join(realpathSync(repo), ".git", "hooks"));
  });

  test("a hook of the user's own is left alone and reported", async () => {
    const repo = await tempRepo();
    const own = join(repo, ".git", "hooks", "post-merge");
    await mkdir(join(repo, ".git", "hooks"), { recursive: true });
    await writeFile(own, "#!/bin/sh\necho mine\n");
    const result = installGitHooks(repo);
    expect(result.installed).toEqual(["standup-redeploy"]);
    expect(result.skipped).toEqual([{ name: "post-merge", reason: expect.stringContaining('"$(dirname "$0")/standup-redeploy" post-merge') }]);
    expect(await readFile(own, "utf-8")).toBe("#!/bin/sh\necho mine\n");
  });

  test("the template is valid bash, guarded to the primary checkout on main, with the fallback to a full restart", async () => {
    expect(Bun.spawnSync(["bash", "-n", REDEPLOY_HOOK_TEMPLATE]).exitCode).toBe(0);
    expect(statSync(REDEPLOY_HOOK_TEMPLATE).mode & 0o111).not.toBe(0);
    const text = await readFile(REDEPLOY_HOOK_TEMPLATE, "utf-8");
    expect(text).toContain('[ "$top" = "$PRIMARY" ] || exit 0');
    expect(text).toContain('[ "$branch" = "${STANDUP_REDEPLOY_BRANCH:-main}" ] || exit 0');
    expect(text).toContain('detach "$BUN" scripts/standup-redeploy.ts "$hook_name"');
    expect(text).toContain("install --frozen-lockfile; systemctl --user restart --no-block standup.service");
    // Detached into its own session when setsid exists, plain nohup otherwise.
    expect(text).toContain("if command -v setsid >/dev/null 2>&1; then");
    expect(text).toContain('nohup setsid "$@" >> "$LOG" 2>&1 < /dev/null &');
    expect(text).toContain('nohup "$@" >> "$LOG" 2>&1 < /dev/null &');
    // The template must never read as the legacy hook it replaces.
    expect(isLegacyRedeployHook("standup-redeploy", text)).toBe(false);
  });

  const LEGACY_REDEPLOY = [
    "#!/usr/bin/env bash",
    "# Restarts the standup.service user unit when main moves in the primary checkout,",
    "# so the running collector and web console always serve the latest main.",
    "# Hooks are shared by every worktree; anything else (agent worktrees, other",
    "# branches, a detached rollback checkout) is left alone.",
    "set -u",
    "PRIMARY=/srv/someone/standup",
    '[ "$(git rev-parse --show-toplevel 2>/dev/null)" = "$PRIMARY" ] || exit 0',
    '[ "$(git symbolic-ref --short -q HEAD)" = "main" ] || exit 0',
    "log=/tmp/standup-redeploy.log",
    "{",
    '  echo "[$(date -Is)] main at $(git rev-parse --short HEAD) ($1); installing and restarting standup.service"',
    '  (cd "$PRIMARY" && "$HOME/.bun/bin/bun" install --frozen-lockfile) || echo "bun install failed; restarting anyway"',
    "  systemctl --user restart --no-block standup.service",
    '} >> "$log" 2>&1',
    'echo "standup: restarting standup.service on $(git rev-parse --short HEAD) (log: $log)"',
    "",
  ].join("\n");
  const LEGACY_POST_MERGE = '#!/usr/bin/env bash\nexec "$(git rev-parse --git-common-dir)/hooks/standup-redeploy" post-merge\n';

  test("the legacy hand-written redeploy hooks are backed up and replaced", async () => {
    const repo = await tempRepo();
    const hooks = join(repo, ".git", "hooks");
    await mkdir(hooks, { recursive: true });
    await writeFile(join(hooks, "standup-redeploy"), LEGACY_REDEPLOY);
    await writeFile(join(hooks, "post-merge"), LEGACY_POST_MERGE);
    const now = new Date("2026-10-08T12:34:56.789Z");
    const result = installGitHooks(repo, { now });
    const template = await readFile(REDEPLOY_HOOK_TEMPLATE, "utf-8");
    expect(result.installed).toEqual([...REDEPLOY_HOOK_FILES]);
    expect(result.skipped).toEqual([]);
    expect(result.replaced).toEqual([
      { name: "standup-redeploy", backup: join(result.hooksDir, "standup-redeploy.pre-standup-20261008T123456Z") },
      { name: "post-merge", backup: join(result.hooksDir, "post-merge.pre-standup-20261008T123456Z") },
    ]);
    expect(await readFile(join(result.hooksDir, "standup-redeploy.pre-standup-20261008T123456Z"), "utf-8")).toBe(LEGACY_REDEPLOY);
    expect(await readFile(join(result.hooksDir, "post-merge.pre-standup-20261008T123456Z"), "utf-8")).toBe(LEGACY_POST_MERGE);
    for (const name of REDEPLOY_HOOK_FILES) expect(await readFile(join(result.hooksDir, name), "utf-8")).toBe(template);
    // Once replaced they carry the marker, so a re-run backs nothing up.
    expect(installGitHooks(repo, { now }).replaced).toEqual([]);
  });

  test("isLegacyRedeployHook recognizes only the legacy redeploy and a post-merge that just delegates to it", () => {
    expect(isLegacyRedeployHook("standup-redeploy", LEGACY_REDEPLOY)).toBe(true);
    // One signature line alone is not enough.
    expect(isLegacyRedeployHook("standup-redeploy", "#!/bin/sh\nsystemctl --user restart --no-block standup.service\n")).toBe(false);
    expect(isLegacyRedeployHook("post-merge", LEGACY_REDEPLOY)).toBe(false);
    expect(isLegacyRedeployHook("post-merge", LEGACY_POST_MERGE)).toBe(true);
    expect(isLegacyRedeployHook("post-merge", '#!/bin/sh\n# hand off\n"$(dirname "$0")/standup-redeploy" post-merge "$@"\n')).toBe(true);
    // Delegating plus anything else is the user's own.
    expect(isLegacyRedeployHook("post-merge", `${LEGACY_POST_MERGE}echo mine\n`)).toBe(false);
    expect(isLegacyRedeployHook("post-merge", "#!/bin/sh\necho mine\n")).toBe(false);
    expect(isLegacyRedeployHook("post-checkout", LEGACY_POST_MERGE)).toBe(false);
  });

  test("a post-merge of the user's own beside the legacy redeploy: the redeploy is replaced, post-merge left alone", async () => {
    const repo = await tempRepo();
    const hooks = join(repo, ".git", "hooks");
    await mkdir(hooks, { recursive: true });
    await writeFile(join(hooks, "standup-redeploy"), LEGACY_REDEPLOY);
    const own = `${LEGACY_POST_MERGE}./notify-team\n`;
    await writeFile(join(hooks, "post-merge"), own);
    const result = installGitHooks(repo);
    expect(result.installed).toEqual(["standup-redeploy"]);
    expect(result.replaced.map((r) => r.name)).toEqual(["standup-redeploy"]);
    expect(result.skipped.map((s) => s.name)).toEqual(["post-merge"]);
    expect(await readFile(join(hooks, "post-merge"), "utf-8")).toBe(own);
  });
});
