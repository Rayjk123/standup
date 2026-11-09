import { afterAll, expect, test, describe } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { createStore, setSetting } from "@standup/store";
import {
  buildOpeningPrompt,
  harnessReachesStandupMcp,
  launchArgsDropStandupMcp,
  launchCarriesKnowledgeSteering,
  KNOWLEDGE_FIRST_TOOLS,
} from "./launcher.js";
import { codexConfigPath, codexConfigRegistersStandup } from "./codex-standup-mcp.js";

const homes: string[] = [];
afterAll(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

/**
 * A launch env whose throwaway HOME holds `~/.codex/config.toml` with `toml`
 * (no config file at all when null). CODEX_HOME is cleared so HOME decides.
 */
function codexHome(toml: string | null): NodeJS.ProcessEnv {
  const home = mkdtempSync(join(tmpdir(), "standup-codex-home-"));
  homes.push(home);
  if (toml !== null) {
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "config.toml"), toml);
  }
  return { HOME: home };
}

/** Source of the standup MCP tool registry — the tools a launched session sees. */
const MCP_TOOLS_SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../mcp/src/tools.ts"),
  "utf8"
);

/**
 * Knowledge-first steering: every launched agent is told to consult the shared
 * knowledge base (search_knowledge / get_knowledge_doc) BEFORE implementing and to
 * contribute back (propose_knowledge) AFTER — injected into the composed
 * opening prompt of every launch whose harness reaches the standup MCP server.
 */

describe("knowledge-first steering in the opening prompt", () => {
  test("the composed prompt carries the steering", () => {
    const store = createStore(":memory:");
    const prompt = buildOpeningPrompt(store.db, "Do the task");
    expect(prompt).toContain("Do the task");
    // The task and the always-present checkpoint instruction are still there.
    expect(prompt).toContain("checkpoint");
    // ...and so is the knowledge-first steering — the two read tools and the
    // one write tool it names.
    expect(prompt).toContain("shared knowledge base");
    expect(prompt).toContain("search_knowledge");
    expect(prompt).toContain("natural-language questions");
    expect(prompt).toContain("get_knowledge_doc");
    expect(prompt).toContain("propose_knowledge");
    store.close();
  });

  test("a stored knowledge_first_enabled=0 is ignored", () => {
    const store = createStore(":memory:");
    setSetting(store.db, "knowledge_first_enabled", "0");

    const prompt = buildOpeningPrompt(store.db, "Do the task");
    expect(prompt).toContain("shared knowledge base");
    expect(prompt).toContain("search_knowledge");
    expect(prompt).toContain("propose_knowledge");
    expect(launchCarriesKnowledgeSteering({ harness: "claude" }, null)).toBe(true);
    store.close();
  });

  test("steers agents to capture product/spec context so an organic corpus grows product docs", () => {
    // Nothing drives product-doc creation unless agents are told to classify
    // the product/spec context they encounter — otherwise retrieveProductKnowledge
    // is inert on a corpus that only ever accreted code docs. Guard the driver.
    const store = createStore(":memory:");
    const prompt = buildOpeningPrompt(store.db, "Do the task");
    expect(prompt).toContain("source_kind");
    expect(prompt).toContain("product");
    expect(prompt).toContain("spec");
    store.close();
  });

  test("steers agents to hand knowledge hits to the subagents they delegate to", () => {
    // A subagent never sees the opening prompt, so the parent must pass the hits
    // on and collect durable findings back for propose_knowledge.
    const store = createStore(":memory:");
    const prompt = buildOpeningPrompt(store.db, "Do the task").replace(/\s+/g, " ");
    expect(prompt).toContain(
      "When you delegate to a subagent, put the relevant knowledge hits (slugs and key facts) " +
        "in its prompt and ask it to report durable findings back to you."
    );
    store.close();
  });
});

/**
 * Steering an agent to call three tools by name is a silent no-op if those
 * names don't resolve to tools the agent can actually reach — which was the
 * whole live-evidence gap the review flagged. These guard reachability
 * deterministically, without a live launch: the composed prompt only names
 * tools the standup MCP server really registers, and the one write tool stays
 * callable from an ORDINARY launch (not just a bootstrap run). If a tool is
 * renamed in `packages/mcp/src/tools.ts`, or `propose_knowledge` regresses back
 * to being bootstrap-only, these fail instead of the steering quietly pointing
 * at a tool nobody can call.
 */
describe("knowledge-first steering names only reachable tools", () => {
  test("every steered tool is a real registered standup MCP tool", () => {
    for (const tool of KNOWLEDGE_FIRST_TOOLS) {
      // The registry declares each tool as `name: "<tool>"`.
      expect(MCP_TOOLS_SRC).toContain(`name: "${tool}"`);
    }
  });

  test("the composed prompt names exactly the steered tools, all registered", () => {
    const store = createStore(":memory:");
    const prompt = buildOpeningPrompt(store.db, "Do the task");
    for (const tool of KNOWLEDGE_FIRST_TOOLS) {
      expect(prompt).toContain(tool);
    }
    store.close();
  });

  test("a launch whose flags strip the standup server drops the steering, not names dead tools", () => {
    const store = createStore(":memory:");
    // --strict-mcp-config tells claude to use ONLY --mcp-config servers,
    // dropping the ambient `standup` server the steering's tools live on — so
    // the steering must be omitted rather than point at unreachable tools.
    const stripped = buildOpeningPrompt(
      store.db,
      "Do the task",
      undefined,
      undefined,
      "--strict-mcp-config --mcp-config other.json"
    );
    expect(stripped).toContain("Do the task");
    expect(stripped).toContain("checkpoint"); // the rest of the prompt survives
    for (const tool of KNOWLEDGE_FIRST_TOOLS) {
      expect(stripped).not.toContain(tool);
    }
    expect(stripped).not.toContain("shared knowledge base");

    // A plain --mcp-config MERGES onto the ambient servers, so `standup`
    // survives and the steering stays.
    const merged = buildOpeningPrompt(
      store.db,
      "Do the task",
      undefined,
      undefined,
      "--mcp-config extra.json"
    );
    for (const tool of KNOWLEDGE_FIRST_TOOLS) {
      expect(merged).toContain(tool);
    }
    store.close();
  });

  test("launchArgsDropStandupMcp flags only --strict-mcp-config as a stripper", () => {
    expect(launchArgsDropStandupMcp("--strict-mcp-config")).toBe(true);
    expect(launchArgsDropStandupMcp("--permission-mode acceptEdits --strict-mcp-config")).toBe(
      true
    );
    // Plain --mcp-config merges; unrelated flags and empty args keep the server.
    expect(launchArgsDropStandupMcp("--mcp-config extra.json")).toBe(false);
    expect(launchArgsDropStandupMcp("--permission-mode acceptEdits")).toBe(false);
    expect(launchArgsDropStandupMcp(undefined)).toBe(false);
    expect(launchArgsDropStandupMcp("")).toBe(false);
  });

  test("a codex-harness launch without a standup registration drops the steering", () => {
    const store = createStore(":memory:");
    // The codex config under this HOME doesn't register the standup server, so
    // the steering (and the plan-first steering) must be omitted rather than
    // name tools the codex agent can't call.
    const codex = buildOpeningPrompt(
      store.db,
      "Do the task",
      undefined,
      undefined,
      undefined,
      "",
      "",
      true, // plan-gated: the plan-first steering must also drop for codex
      "codex",
      undefined,
      "",
      undefined,
      undefined,
      undefined,
      codexHome("[mcp_servers.other]\ncommand = \"x\"\n")
    );
    expect(codex).toContain("Do the task");
    expect(codex).toContain("checkpoint"); // the base prompt survives
    for (const tool of KNOWLEDGE_FIRST_TOOLS) {
      expect(codex).not.toContain(tool);
    }
    expect(codex).not.toContain("shared knowledge base");
    expect(codex).not.toContain("submit_plan");

    // The default (claude) harness keeps the steering — a regression guard that
    // the codex suppression didn't leak onto the default path.
    const claude = buildOpeningPrompt(store.db, "Do the task");
    expect(claude).toContain("search_knowledge");

    // No config.toml at all reads as unregistered too.
    const noConfig = buildOpeningPrompt(
      store.db,
      "Do the task",
      undefined,
      undefined,
      undefined,
      "",
      "",
      false,
      "codex",
      undefined,
      "",
      undefined,
      undefined,
      undefined,
      codexHome(null)
    );
    expect(noConfig).not.toContain("shared knowledge base");
    store.close();
  });

  test("a codex-harness launch whose config registers the standup server carries the steering", () => {
    const store = createStore(":memory:");
    const env = codexHome(
      "# BEGIN STANDUP MCP\n[mcp_servers.standup]\ncommand = \"bun\"\nargs = [\"run\", \"index.ts\"]\n# END STANDUP MCP\n"
    );
    const codex = buildOpeningPrompt(
      store.db,
      "Do the task",
      undefined,
      undefined,
      undefined,
      "",
      "",
      false,
      "codex",
      undefined,
      "",
      undefined,
      undefined,
      undefined,
      env
    );
    expect(codex).toContain("shared knowledge base");
    for (const tool of KNOWLEDGE_FIRST_TOOLS) expect(codex).toContain(tool);
    // Codex has no Edit/Write tools, so that steering stays Claude-only.
    expect(codex).not.toContain("Edit/Write tools");
    expect(harnessReachesStandupMcp("codex", undefined, env)).toBe(true);
    // --strict-mcp-config still strips the server whatever the harness.
    expect(harnessReachesStandupMcp("codex", "--strict-mcp-config", env)).toBe(false);
    store.close();
  });

  test("codexConfigRegistersStandup reads table, subtable, inline and dotted-key registrations", () => {
    const cases: Array<[string, boolean]> = [
      ["[mcp_servers.standup]\ncommand = \"bun\"\n", true],
      ["[mcp_servers.standup.env]\nCOLLECTOR_URL = \"x\"\n", true],
      ["[mcp_servers.\"standup\"]\ncommand = \"bun\"\n", true],
      ["[mcp_servers]\nstandup = { command = \"bun\" }\n", true],
      ["[mcp_servers]\nstandup.command = \"bun\"\n", true],
      ["mcp_servers.standup.command = \"bun\"\n", true],
      ["[mcp_servers.standup-mcp]\ncommand = \"bun\"\n", false],
      ["[mcp_servers.standupother]\ncommand = \"bun\"\n", false],
      ["[mcp_servers]\nstandup-mcp = { command = \"bun\" }\n", false],
      ["[profile]\nstandup = { command = \"bun\" }\n", false],
      ["# [mcp_servers.standup]\n", false],
      ["", false],
    ];
    for (const [toml, expected] of cases) {
      expect([toml, codexConfigRegistersStandup(toml)]).toEqual([toml, expected]);
    }
  });

  test("codexConfigPath honours CODEX_HOME, else HOME/.codex", () => {
    expect(codexConfigPath({ HOME: "/tmp/kb-g1/h" })).toBe("/tmp/kb-g1/h/.codex/config.toml");
    expect(codexConfigPath({ HOME: "/tmp/kb-g1/h", CODEX_HOME: "/tmp/kb-g1/c" })).toBe(
      "/tmp/kb-g1/c/config.toml"
    );
  });

  test("a codex launch's opening prompt points at the launchSubdir as given; claude and no-subdir do not", () => {
    const store = createStore(":memory:");
    // Codex runs at the workspace ROOT, so it must be told which package the
    // task targets — the orientation Claude gets for free by starting in the subdir.
    const codexPrompt = (subdir: string) =>
      buildOpeningPrompt(store.db, "Do the task", undefined, undefined, undefined, "", "", false, "codex", subdir);
    const codex = codexPrompt("src/MyPackage");
    expect(codex).toContain("WORKSPACE ROOT");
    expect(codex).toContain("The target package is at src/MyPackage —");
    // Whatever dir the layout keeps its packages in, and however deep, the
    // pointer names the launchSubdir itself, not a src/<basename> guess.
    for (const [subdir, shown] of [
      ["packages/web", "packages/web"],
      ["./services/api/", "services/api"],
      ["apps/admin/console", "apps/admin/console"],
    ] as const) {
      const prompt = codexPrompt(subdir);
      expect(prompt).toContain(`The target package is at ${shown} —`);
      expect(prompt).not.toContain("src/");
    }
    // A subdir that names the root itself, or a dir outside it, points at nothing.
    for (const outside of ["./", "..", "../sibling", "pkgs/../../sibling", "/abs/pkg"]) {
      expect(codexPrompt(outside)).not.toContain("target package");
    }

    // Claude keeps its launchSubdir cwd, so it gets no root pointer even with a
    // subdir — a regression guard that the codex pointer didn't leak onto claude.
    const claude = buildOpeningPrompt(
      store.db,
      "Do the task",
      undefined,
      undefined,
      undefined,
      "",
      "",
      false,
      "claude",
      "src/MyPackage"
    );
    expect(claude).not.toContain("target package");

    // A codex launch with no subdir (single-package repo / scratch) gets none.
    const codexNoSub = buildOpeningPrompt(
      store.db,
      "Do the task",
      undefined,
      undefined,
      undefined,
      "",
      "",
      false,
      "codex"
    );
    expect(codexNoSub).not.toContain("target package");
    store.close();
  });

  test("propose_knowledge is reachable from an ordinary launch, not bootstrap-only", () => {
    // The prior review fix opened the propose gate to any running launch; guard
    // it from regressing to a bootstrap-only gate that would make the steering's
    // "contribute back" half a no-op for the entire steered (ordinary-launch)
    // population.
    expect(KNOWLEDGE_FIRST_TOOLS).toContain("propose_knowledge");
    expect(MCP_TOOLS_SRC).toContain("works from any Standup-launched session");
    expect(MCP_TOOLS_SRC).not.toContain("Only usable inside a knowledge-bootstrap run");
  });
});

/**
 * The safety floor holds inline-script and in-place edits (heredocs into an
 * interpreter, `sed -i`, `perl -pi`) as unclassified, so a Claude worker is told
 * up front to edit through the Edit/Write tools instead.
 */
describe("edit-tools steering in the opening prompt", () => {
  test("a Claude launch is told to edit only with Edit/Write", () => {
    const store = createStore(":memory:");
    const prompt = buildOpeningPrompt(store.db, "Do the task");
    expect(prompt).toContain("Edit files only with the Edit/Write tools.");
    expect(prompt).toContain("`sed -i`, `perl -pi`");
    expect(prompt).toContain("the safety\nfloor holds those and they will be denied.");
    store.close();
  });

  test("a Claude launch is told to keep scratch under $TMPDIR, isolated test envs under /tmp, and register long-lived processes", () => {
    const store = createStore(":memory:");
    const prompt = buildOpeningPrompt(store.db, "Do the task");
    expect(prompt).toContain("Put scratch files under `$TMPDIR` (your launch's scratch dir, deleted when the job closes), never a\nhard-coded /tmp.");
    expect(prompt).toContain("plus\nTMPDIR/TMP/TEMP, under a `mktemp -d -p /tmp` root — the floor only credits isolation under /tmp.");
    expect(prompt).toContain("`register_process`");
    store.close();
  });

  test("a codex launch omits it — the Edit/Write tool names don't exist there", () => {
    const store = createStore(":memory:");
    const prompt = buildOpeningPrompt(
      store.db,
      "Do the task",
      undefined,
      undefined,
      undefined,
      "",
      "",
      false,
      "codex"
    );
    expect(prompt).toContain("Do the task");
    expect(prompt).not.toContain("Edit/Write tools");
    store.close();
  });
});
