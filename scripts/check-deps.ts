#!/usr/bin/env bun
/**
 * Ensures Homebrew and Standup's system-level binaries are available before
 * the app starts — see REQUIRED_FORMULAE below for what and why.
 *
 * These are system binaries, not things `bun install` pulls in; without them
 * the relevant feature fails at runtime with
 * "Executable not found in $PATH".
 *
 * Runs automatically at the top of `bun run dev`. Also runnable directly:
 *   bun run scripts/check-deps.ts
 *
 * macOS only. On other platforms this logs a note and does nothing — install
 * ripgrep for your platform manually (e.g. `apt install ripgrep`).
 */

import { existsSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";

const ZPROFILE = join(homedir(), ".zprofile");
// Apple Silicon, then Intel — brew installs to one of these depending on arch.
const BREW_CANDIDATES = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"];

function commandExists(cmd: string): boolean {
  return Bun.spawnSync(["which", cmd]).exitCode === 0;
}

function findBrewBinary(): string | null {
  return BREW_CANDIDATES.find(existsSync) ?? null;
}

async function ensureZprofileEntry(brewBinPath: string): Promise<void> {
  const line = `eval "$(${brewBinPath} shellenv zsh)"`;
  const existing = existsSync(ZPROFILE) ? await Bun.file(ZPROFILE).text() : "";

  if (existing.includes(line)) return;

  const needsNewline = existing.length > 0 && !existing.endsWith("\n");
  await Bun.write(ZPROFILE, existing + (needsNewline ? "\n" : "") + `\n${line}\n`);
  console.log(`[deps] Added Homebrew to ${ZPROFILE} (new shells will have it on PATH)`);
}

/**
 * Installs Homebrew and returns its bin path. Also prepends that bin dir to
 * this process's own PATH — writing to ~/.zprofile only takes effect for
 * shells started *after* this one, so without this, a brew-installed rg
 * still wouldn't be found by the collector we're about to spawn in this
 * same `bun run dev` invocation.
 */
async function ensureHomebrew(): Promise<string> {
  let brewPath = findBrewBinary();

  if (!brewPath) {
    console.log("[deps] Homebrew not found — installing (you may be prompted for your password)...");
    const install = Bun.spawnSync(
      [
        "/bin/bash",
        "-c",
        '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
      ],
      {
        stdout: "inherit",
        stderr: "inherit",
        stdin: "inherit",
        // Skips the install script's interactive "press enter to continue"
        // confirmation; it can still prompt for a sudo password if needed,
        // which stdin:"inherit" lets the user answer in their own terminal.
        env: { ...process.env, NONINTERACTIVE: "1" },
      }
    );

    if (install.exitCode !== 0) {
      throw new Error("Homebrew installation failed. Install it manually: https://brew.sh");
    }

    brewPath = findBrewBinary();
    if (!brewPath) {
      throw new Error("Homebrew install script succeeded but the binary wasn't found afterward.");
    }

    console.log(`[deps] Homebrew installed at ${brewPath}`);
  } else {
    console.log(`[deps] Homebrew already installed at ${brewPath}`);
  }

  await ensureZprofileEntry(brewPath);

  const brewBinDir = dirname(brewPath);
  if (!process.env.PATH?.includes(brewBinDir)) {
    process.env.PATH = `${brewBinDir}:${process.env.PATH ?? ""}`;
  }

  return brewPath;
}

/**
 * Formulae Standup needs that `bun install` can't provide.
 *   ripgrep — backs the `ripgrep` MCP tool
 *   tmux    — hosts console-launched sessions (Phase 4); Claude Code is a
 *             TUI, so a launched session needs a terminal to live in and
 *             something the user can attach to later
 */
const REQUIRED_FORMULAE: Array<{ binary: string; formula: string }> = [
  { binary: "rg", formula: "ripgrep" },
  { binary: "tmux", formula: "tmux" },
];

function ensureFormulae(brewPath: string): void {
  for (const { binary, formula } of REQUIRED_FORMULAE) {
    if (commandExists(binary)) {
      console.log(`[deps] ${formula} already installed`);
      continue;
    }

    console.log(`[deps] ${formula} not found — installing via Homebrew...`);
    const result = Bun.spawnSync([brewPath, "install", formula], {
      stdout: "inherit",
      stderr: "inherit",
    });

    if (result.exitCode !== 0) {
      throw new Error(
        `${formula} installation failed. Install it manually: brew install ${formula}`
      );
    }

    console.log(`[deps] ${formula} installed`);
  }
}

export async function ensureDeps(): Promise<void> {
  if (process.platform !== "darwin") {
    console.log(
      "[deps] Skipping Homebrew/ripgrep auto-install (macOS only) — install ripgrep manually for your platform."
    );
    return;
  }

  const brewPath = await ensureHomebrew();
  ensureFormulae(brewPath);
}

// Run directly when invoked as a script (bun run scripts/check-deps.ts),
// but not when imported by scripts/dev.ts.
if (import.meta.main) {
  ensureDeps().catch((err) => {
    console.error(`[deps] ${(err as Error).message}`);
    process.exit(1);
  });
}
