import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir, homedir } from "os";
import { dirname, join } from "path";
import { refusedReason, searchableTempDir } from "./code-search.js";
import { DEFAULT_ORG_PROFILE } from "./org-profile/default.js";
import { exampleCorpProfile } from "./org-profile/fixtures/example-corp.js";
import { setActiveOrgProfile } from "./org-profile/load.js";
import { runRipgrep } from "./ripgrep.js";

/**
 * Drafts must not be reachable by code search (the `ripgrep` tool).
 *
 * The structural argument is that drafts live under `~/.config/standup/` while
 * `runRipgrep` searches the session's cwd, so they are out of reach by
 * construction. That argument is correct and is exactly the kind of thing this
 * project has been wrong about before: an eval once reported
 * flattered numbers because the eval file sat in the searched corpus with every
 * test question in it verbatim, and excluding it moved 6/8 to 7/8. The lesson
 * recorded then was to assert corpus isolation rather than reason about it,
 * which is what these tests do.
 *
 * The stakes are higher here than for the eval file. A draft is unreviewed
 * machine output; the entire point of the review gate is that no agent reads it
 * until a human accepts it. A leak would not fail loudly — it would quietly
 * feed unverified text to agents as authoritative context.
 */
describe("knowledge drafts are outside the searched corpus", () => {
  test("ripgrep cannot escape the cwd it is given", async () => {
    const root = mkdtempSync(join(searchableTempDir(), "standup-isolation-"));
    try {
      // A repo, and a knowledge directory beside it — the real layout in
      // miniature, with the draft one level *up* from where a session runs.
      const repo = join(root, "repo");
      const knowledge = join(root, "knowledge", "proj", ".drafts");
      mkdirSync(repo, { recursive: true });
      mkdirSync(knowledge, { recursive: true });

      const token = "zqxjkbootstrapleakcanary";
      writeFileSync(join(knowledge, "gotchas.md"), `a draft containing ${token}\n`);
      // Present in the repo too, so a zero result can't be mistaken for
      // ripgrep simply failing to run or the pattern never matching anything.
      writeFileSync(join(repo, "real.ts"), `// source containing ${token}\n`);

      const result = await runRipgrep(token, repo);

      expect(result.matches.length).toBeGreaterThan(0);
      expect(result.matches.every((m) => m.file.includes("real.ts"))).toBe(true);
      expect(result.matches.some((m) => m.file.includes(".drafts"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  describe("a fake home directory", () => {
    // A FAKE home: HOME points at a temp dir laid out like a real one, so the
    // search runs against the same protected paths without touching the real home.
    const token = "zqxjkhomeleakcanary";
    let home: string;
    let saved: Record<string, string | undefined>;
    const noRg = join(tmpdir(), "definitely-not-ripgrep-zqxjk");
    const plant = (rel: string): void => {
      mkdirSync(dirname(join(home, rel)), { recursive: true });
      writeFileSync(join(home, rel), `${token}\n`);
    };
    const credentialStores = [
      ".aws/credentials",
      ".ssh/id_rsa",
      ".gnupg/secring.gpg",
      ".docker/config.json",
      ".netrc",
      ".kube/config",
      ".npmrc",
      ".config/gh/hosts.yml",
      ".config/hub",
      ".pypirc",
      ".m2/settings.xml",
      ".cargo/credentials.toml",
      ".terraform.d/credentials.tfrc.json",
      ".azure/accessTokens.json",
      ".oci/config",
      ".vault-token",
      ".git-credentials",
      ".pgpass",
      ".my.cnf",
      ".boto",
      ".s3cfg",
      ".env",
      ".claude/.credentials.json",
      ".codex/auth.json",
      ".config/rclone/rclone.conf",
      ".local/share/keyrings/login.keyring",
      ".password-store/site.gpg",
      ".bash_history",
      ".zsh_history",
      ".python_history",
      ".psql_history",
      ".mysql_history",
      ".node_repl_history",
      ".config/standup/knowledge/proj/.drafts/g.md",
      ".local/share/standup/standup.db",
    ];

    beforeEach(() => {
      home = mkdtempSync(join(searchableTempDir(), "standup-fake-home-"));
      saved = {
        HOME: process.env.HOME,
        KNOWLEDGE_DIR: process.env.KNOWLEDGE_DIR,
        STANDUP_RG_PATH: process.env.STANDUP_RG_PATH,
      };
      process.env.HOME = home;
      process.env.STANDUP_RG_PATH = noRg;
      for (const rel of credentialStores) plant(rel);
    });

    afterEach(() => {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(home, { recursive: true, force: true });
    });

    test("the home directory, its ancestors and the filesystem root are refused as search roots", async () => {
      plant("notes.txt");
      for (const backend of ["js", "git-grep"]) {
        if (backend === "git-grep") Bun.spawnSync(["git", "init", "-q"], { cwd: home });
        for (const cwd of [home, dirname(home), "/"]) {
          const result = await runRipgrep(token, cwd);
          expect(result.status).toBe("unavailable");
          expect(result.error).toContain("refusing to search");
          expect(result.matches).toEqual([]);
        }
      }
    });

    test("an explicit path into any credential store is refused, from the home or from inside it", async () => {
      for (const rel of credentialStores) {
        const fromHome = await runRipgrep(token, home, rel);
        expect(fromHome.matches).toEqual([]);
        expect(fromHome.status).toBe("unavailable");
        const top = rel.split("/")[0] === ".config" ? rel.split("/").slice(0, 2).join("/") : rel.split("/")[0];
        // Rooted at the store's top-level directory: refused when that directory
        // is the store, and the store's file skipped when it lives inside one.
        const inside = await runRipgrep(token, join(home, top));
        expect(inside.matches).toEqual([]);
      }
    });

    test("a repo under the home skips hidden files, credential files and a non-hidden knowledge dir", async () => {
      const repo = join(home, "work");
      // A knowledge dir that is not hidden, so only the explicit refusal keeps it out.
      process.env.KNOWLEDGE_DIR = join(repo, "kb");
      for (const rel of [
        "work/kb/proj/.drafts/draft.md",
        "work/kb/proj/doc.md",
        "work/credentials",
        "work/.env",
        "work/.config/gh/hosts.yml",
        "work/app.ts",
        "work/src/b.ts",
      ]) {
        plant(rel);
      }
      const visible = ["./app.ts", "./src/b.ts"];

      const walked = await runRipgrep(token, repo);
      expect(walked.backend).toBe("js");
      expect(walked.matches.map((m) => m.file).sort()).toEqual(visible);

      for (const args of [
        ["init", "-q"],
        ["add", "-A", "-f"],
      ]) {
        Bun.spawnSync(["git", ...args], { cwd: repo });
      }
      const grepped = await runRipgrep(token, repo);
      expect(grepped.backend).toBe("git-grep");
      expect(grepped.matches.map((m) => m.file).sort()).toEqual(visible);

      // ripgrep's output is re-checked even if it printed protected paths.
      const fakeRg = join(home, "bin", "rg");
      mkdirSync(dirname(fakeRg), { recursive: true });
      writeFileSync(
        fakeRg,
        `#!/bin/sh\nfor f in ./app.ts ./src/b.ts ./kb/proj/doc.md ./.env ./credentials; do echo "$f:1:${token}"; done\n`
      );
      chmodSync(fakeRg, 0o755);
      process.env.STANDUP_RG_PATH = fakeRg;
      const viaRg = await runRipgrep(token, repo);
      expect(viaRg.backend).toBe("rg");
      expect(viaRg.matches.map((m) => m.file).sort()).toEqual(visible);
    });

    test("any home dot-directory is refused as a root; a repo's .env and history files as a path", async () => {
      plant(".someapp/state.json");
      for (const dir of [".someapp", ".config", ".local", ".claude"]) {
        const result = await runRipgrep(token, join(home, dir));
        expect(result.status).toBe("unavailable");
        expect(result.matches).toEqual([]);
      }
      for (const rel of ["work/.env", "work/.env.local", "work/sub/.bash_history", "work/app.ts"]) plant(rel);
      for (const path of [".env", ".env.local", "sub/.bash_history"]) {
        const result = await runRipgrep(token, join(home, "work"), path);
        expect(result.status).toBe("unavailable");
        expect(result.matches).toEqual([]);
      }
      expect((await runRipgrep(token, join(home, "work"))).matches.map((m) => m.file)).toEqual(["./app.ts"]);
    });

    test("the org profile's SSO dirs and cookie files are refused like the built-in credential stores", async () => {
      const profile = exampleCorpProfile();
      const stores = [...profile.sso.dirs, ...profile.sso.cookieFiles];
      expect(stores.length).toBeGreaterThan(0);
      for (const rel of profile.sso.cookieFiles) plant(rel);
      const cookie = join(home, profile.sso.cookieFiles[0]!);
      try {
        setActiveOrgProfile(profile);
        for (const rel of stores) {
          expect(refusedReason(join(home, rel))).toContain("refusing to search");
          const fromHome = await runRipgrep(token, home, rel);
          expect(fromHome.status).toBe("unavailable");
          expect(fromHome.matches).toEqual([]);
        }
        const inside = await runRipgrep(token, join(home, profile.sso.dirs[0]!));
        expect(inside.status).toBe("unavailable");
        expect(inside.matches).toEqual([]);
        // Under the default profile the SSO dir is no credential store of its
        // own (the home dot-directory rule keeps a search from rooting there),
        // but a file named for cookies below a home dot entry is still refused.
        setActiveOrgProfile(DEFAULT_ORG_PROFILE);
        expect(refusedReason(join(home, profile.sso.dirs[0]!))).toBeNull();
        expect(refusedReason(cookie)).toContain("cookie store");
      } finally {
        setActiveOrgProfile();
      }
    });

    test("worktrees Standup provisions under its data dir are searchable checkouts", async () => {
      plant(".local/share/standup/worktrees/proj/x/src.ts");
      const worktree = await runRipgrep(token, join(home, ".local", "share", "standup", "worktrees", "proj", "x"));
      expect(worktree.matches.map((m) => m.file)).toEqual(["./src.ts"]);
      const dataDir = await runRipgrep(token, join(home, ".local", "share", "standup"));
      expect(dataDir.status).toBe("unavailable");
    });
  });

  test("a search of this repo returns nothing from the knowledge directory", async () => {
    // The live version of the same claim, against this repo's own files and the
    // real knowledge dir rather than a constructed layout. "standup" appears in
    // both trees, so it exercises the boundary rather than a term that was never
    // going to match. The files are searched in a clone of this checkout's HEAD
    // in a searchable temp dir: the checkout itself may sit where the search
    // refuses to run (a home dot-directory such as ~/.cache, or another home's
    // data dir when HOME is moved), which would leave nothing to check.
    const git = (cwd: string, ...args: string[]) => {
      const proc = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
      expect({ args, exitCode: proc.exitCode, stderr: proc.stderr.toString() }).toMatchObject({ exitCode: 0 });
      return proc.stdout.toString().trim();
    };
    const commonDir = git(import.meta.dir, "rev-parse", "--path-format=absolute", "--git-common-dir");
    const head = git(import.meta.dir, "rev-parse", "HEAD");
    const clone = mkdtempSync(join(searchableTempDir(), "standup-isolation-repo-"));
    try {
      git(clone, "clone", "-q", "--shared", "--no-checkout", commonDir, ".");
      git(clone, "checkout", "-q", "--detach", head);
      const knowledgeDir = join(homedir(), ".config", "standup", "knowledge");
      const result = await runRipgrep("standup", clone);

      expect(result.matches.length).toBeGreaterThan(0);
      for (const match of result.matches) {
        expect(match.file.startsWith(knowledgeDir)).toBe(false);
        expect(match.file).not.toContain("/.drafts/");
      }
    } finally {
      rmSync(clone, { recursive: true, force: true });
    }
  }, 30_000);
});
