#!/usr/bin/env bun
/**
 * Create a Standup project from the command line.
 *
 * Projects live as rows in the collector's SQLite, but writing that row by
 * hand (`sqlite3 ... INSERT`) skips everything the real creation path does:
 * id validation, re-homing sessions already stranded in `scratch` whose cwd
 * matches the new repos, and the `projects:updated` broadcast that refreshes
 * every open UI. So this posts to the running collector's POST /api/projects
 * instead of touching the database — same code path the "New project" form
 * uses.
 *
 *   bun run scripts/add-project.ts \
 *     --id governor --name "Sun Bear Governor" --emoji 🐻 \
 *     --branch mainline --setup "brazil-build" \
 *     --launch-args "--permission-mode acceptEdits" \
 *     --repo ~/ax-workplace/TCXSunBearGovernor/src/TCXSunBearGovernor \
 *     --repo ~/ax-workplace/TCXSunBearGovernor/src/TCXSunBearGovernorCDK
 *
 * --repo is repeatable. The collector must be running (it's the source of
 * truth for projects); set COLLECTOR_PORT if it isn't on the default.
 */

import { DEFAULT_COLLECTOR_PORT } from "@standup/shared";

interface Args {
  id?: string;
  name?: string;
  emoji?: string;
  branch?: string;
  setup?: string;
  launchArgs?: string;
  worktreeRoot?: string;
  expert?: string;
  repos: string[];
  help?: boolean;
}

const USAGE = `Create a Standup project via the running collector.

Usage:
  bun run scripts/add-project.ts --id <id> [options]

Options:
  --id <id>              Required. Lowercase letters, numbers, hyphens; used in
                         paths and branch names, so it can't be changed later.
  --name <name>          Display name (default: the id).
  --emoji <emoji>        Icon shown in the console.
  --branch <branch>      Base branch launches check out from (default: main).
  --setup <cmd>          Setup command run in a fresh worktree before the agent.
  --launch-args <flags>  Extra flags passed to \`claude\` on launch,
                         e.g. "--permission-mode acceptEdits".
  --worktree-root <path> Where this project's launched worktrees are created.
                         Overrides the global default; ~ is expanded.
  --expert <index>       Expert retrieval index name (reserved).
  --repo <path>          A repo path; repeat for multiple. ~ is expanded.
  --help                 Show this message.

The collector must be running. Set COLLECTOR_PORT to override the default (${DEFAULT_COLLECTOR_PORT}).`;

function parseArgs(argv: string[]): Args {
  const args: Args = { repos: [] };

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    // A --flag with no following value (end of argv or another flag next) is
    // an error for value-taking flags — catch it rather than silently
    // swallowing the next flag as the value.
    const takeValue = (): string => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) {
        throw new Error(`${flag} needs a value`);
      }
      i++;
      return v;
    };

    switch (flag) {
      case "--id": args.id = takeValue(); break;
      case "--name": args.name = takeValue(); break;
      case "--emoji": args.emoji = takeValue(); break;
      case "--branch": args.branch = takeValue(); break;
      case "--setup": args.setup = takeValue(); break;
      case "--launch-args": args.launchArgs = takeValue(); break;
      case "--worktree-root": args.worktreeRoot = takeValue(); break;
      case "--expert": args.expert = takeValue(); break;
      case "--repo": args.repos.push(takeValue()); break;
      case "--help":
      case "-h": args.help = true; break;
      default:
        throw new Error(`Unknown argument: ${flag}`);
    }
  }

  return args;
}

async function main() {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`✗ ${(err as Error).message}\n`);
    console.error(USAGE);
    process.exit(2);
  }

  if (args.help) {
    console.log(USAGE);
    return;
  }

  if (!args.id) {
    console.error("✗ --id is required\n");
    console.error(USAGE);
    process.exit(2);
  }

  const port = process.env.COLLECTOR_PORT ?? String(DEFAULT_COLLECTOR_PORT);
  const url = `http://localhost:${port}/api/projects`;

  const body = {
    id: args.id,
    name: args.name ?? args.id,
    emoji: args.emoji,
    branch: args.branch ?? "main",
    setup: args.setup,
    launchArgs: args.launchArgs,
    worktreeRoot: args.worktreeRoot,
    expert: args.expert,
    repos: args.repos,
  };

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    console.error(
      `✗ Couldn't reach the collector at ${url}.\n` +
        "  Is it running? Start it with `bun run dev` (or set COLLECTOR_PORT)."
    );
    process.exit(1);
  }

  const data = (await res.json().catch(() => ({}))) as {
    id?: string;
    name?: string;
    movedSessions?: number;
    error?: string;
  };

  if (!res.ok) {
    console.error(`✗ ${data.error ?? `Request failed (${res.status})`}`);
    process.exit(1);
  }

  console.log(`✓ Created project "${data.id}" (${data.name})`);
  if (data.movedSessions) {
    console.log(
      `  Re-homed ${data.movedSessions} session(s) that were stranded in scratch.`
    );
  }
}

main();
