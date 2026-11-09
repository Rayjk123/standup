import { expect, test, describe, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { defaultBranch, extractRepoStateClaims, gitRepoProbe, repoStateDisputes } from "./knowledge-repo-claims.js";
import { verifyPublishedDoc, type PublishVerifyDeps } from "./knowledge-publish-verify.js";
import type { KnowledgeDocFile } from "@standup/knowledge";

/**
 * Repository-state claims against real git repositories: a merge only counts
 * as refuted when the commit's changes demonstrably are not in HEAD (squash
 * merges included), a symbol only counts when code — not docs or comments —
 * names it, and a claim placed in another package is not checked.
 */

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/**
 * HEAD's abbreviated id, lengthened until it holds both a digit and a letter:
 * repo claims read only that shape as a commit id, and a 10-character id is
 * all digits about one time in a hundred.
 */
function shortSha(r: { git: (...args: string[]) => string }): string {
  for (let n = 10; n < 40; n++) {
    const sha = r.git("rev-parse", `--short=${n}`, "HEAD");
    if (/\d/.test(sha) && /[a-f]/.test(sha)) return sha;
  }
  return r.git("rev-parse", "HEAD");
}

function repo(): { dir: string; git: (...args: string[]) => string; write: (path: string, text: string) => void } {
  const dir = mkdtempSync(join(tmpdir(), "standup-repo-claims-test-"));
  dirs.push(dir);
  const git = (...args: string[]) => {
    const res = Bun.spawnSync(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    if (res.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr.toString()}`);
    return res.stdout.toString().trim();
  };
  const write = (path: string, text: string) => {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  write("src/a.ts", "export const a = 1;\n");
  write("src/b.ts", "export const b = 1;\n");
  git("add", ".");
  git("commit", "-q", "-m", "base");
  return { dir, git, write };
}

describe("merge claims", () => {
  test("a commit squash-merged into main is not refuted", async () => {
    const r = repo();
    r.git("checkout", "-q", "-b", "fix");
    r.write("src/a.ts", "export const a = 2;\n");
    r.git("commit", "-qam", "fix a");
    const fixSha = shortSha(r);
    r.write("src/b.ts", "export const b = 2;\n");
    r.git("commit", "-qam", "fix b");
    r.git("checkout", "-q", "main");
    r.git("merge", "-q", "--squash", "fix");
    r.git("commit", "-qm", "squashed fix");
    expect(await gitRepoProbe.commitInDefaultBranch(r.dir, fixSha)).toBe(true);
    expect(await repoStateDisputes(`The fix landed in ${fixSha}.`, [r.dir])).toEqual([]);
  });

  test("a merge claim for a commit whose changes are not in HEAD is refuted with the evidence", async () => {
    const r = repo();
    r.git("checkout", "-q", "-b", "wip");
    r.write("src/a.ts", "export const a = 3;\n");
    r.git("commit", "-qam", "wip");
    const sha = shortSha(r);
    r.git("checkout", "-q", "main");
    const disputes = await repoStateDisputes(`The change was merged in ${sha}.`, [r.dir]);
    expect(disputes).toHaveLength(1);
    expect(disputes[0]!.finding).toContain("not on the default branch");
    expect(await repoStateDisputes(`It was merged into main in commit ${sha}.`, [r.dir])).toHaveLength(1);
    expect(disputes[0]!.evidence).toContain(sha);
    // The same commit claimed unmerged is right.
    expect(await repoStateDisputes(`Commit ${sha} is not merged yet.`, [r.dir])).toEqual([]);
  });

  test("an unmerged claim for a commit HEAD contains is refuted", async () => {
    const r = repo();
    const sha = shortSha(r);
    const disputes = await repoStateDisputes(`Commit ${sha} is not merged yet.`, [r.dir]);
    expect(disputes).toHaveLength(1);
  });

  test("an unknown commit can't be settled", async () => {
    const r = repo();
    expect(await repoStateDisputes("It was merged in 1234abcd99.", [r.dir])).toEqual([]);
  });
});

describe("merge claims are about the default branch", () => {
  test("in a feature-branch worktree, its own unmerged commit is not refuted as merged", async () => {
    const r = repo();
    r.git("checkout", "-q", "-b", "retry-change");
    r.write("src/a.ts", "export const a = 9;\n");
    r.git("commit", "-qam", "retry change");
    const sha = shortSha(r);
    expect(await repoStateDisputes(`My retry change ${sha} is not merged yet; the pull request is pending.`, [r.dir])).toEqual([]);
    // "`wipFn` is not yet merged" is about merge state, not whether the code exists.
    r.write("src/wip.ts", "export function wipFn() {}\n");
    r.git("add", ".");
    r.git("commit", "-qm", "wip");
    expect(extractRepoStateClaims("`wipFn` is not yet merged.")).toEqual([]);
    expect(await repoStateDisputes("`wipFn` is not yet merged.", [r.dir])).toEqual([]);
  });

  test("a squash-merged commit whose file was later removed is not refuted", async () => {
    const r = repo();
    r.git("checkout", "-q", "-b", "feat");
    r.write("src/f.ts", "export const f = 1;\n");
    r.git("add", ".");
    r.git("commit", "-qm", "add f");
    const sha = shortSha(r);
    r.write("src/f.ts", "export const f = 2;\n");
    r.git("commit", "-qam", "tweak f");
    r.git("checkout", "-q", "main");
    r.git("merge", "-q", "--squash", "feat");
    r.git("commit", "-qm", "squash feat");
    r.git("rm", "-q", "src/f.ts");
    r.git("commit", "-qm", "drop f");
    expect(await repoStateDisputes(`The fix landed in ${sha}.`, [r.dir])).toEqual([]);
  });

  test("a sentence about a revert is not checked", async () => {
    const r = repo();
    const sha = shortSha(r);
    expect(await repoStateDisputes(`Commit ${sha} is not merged anymore after the revert.`, [r.dir])).toEqual([]);
  });

  test("with no default branch a merge claim can't be settled", async () => {
    const r = repo();
    r.git("branch", "-m", "main", "trunk");
    const sha = shortSha(r);
    expect(await repoStateDisputes(`Commit ${sha} is not merged yet.`, [r.dir])).toEqual([]);
  });

  test("a local main ahead of a stale origin/HEAD is the default branch; a diverged one is not", async () => {
    const r = repo();
    r.git("update-ref", "refs/remotes/origin/main", "HEAD");
    r.git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    // Merged locally, never pushed: the owner's install.
    r.write("src/a.ts", "export const a = 5;\n");
    r.git("commit", "-qam", "merged locally");
    const sha = shortSha(r);
    expect(await defaultBranch(r.dir)).toBe("refs/heads/main");
    expect(await repoStateDisputes(`The change was merged in ${sha}.`, [r.dir])).toEqual([]);
    // origin moves on separately: local main is no longer a superset of it.
    r.git("checkout", "-q", "-b", "elsewhere", "origin/main");
    r.write("src/b.ts", "export const b = 7;\n");
    r.git("commit", "-qam", "pushed elsewhere");
    r.git("update-ref", "refs/remotes/origin/main", "HEAD");
    r.git("checkout", "-q", "main");
    expect(await defaultBranch(r.dir)).toBe("refs/remotes/origin/main");
    expect(await repoStateDisputes(`The change was merged in ${sha}.`, [r.dir])).toHaveLength(1);
  });

  test("a refutation is tagged as a git finding", async () => {
    const r = repo();
    const sha = shortSha(r);
    const [d] = await repoStateDisputes(`Commit ${sha} is not merged yet.`, [r.dir]);
    expect(d).toMatchObject({ origin: "git" });
    expect(d!.finding).toContain("default branch");
  });
});

describe("symbol claims", () => {
  test("a mention inside a block comment does not count as code", async () => {
    const r = repo();
    r.write("src/c.ts", "/*\n  retryPost will live here\n*/\nexport const c = 1;\n");
    r.git("add", ".");
    r.git("commit", "-qm", "block");
    expect(await gitRepoProbe.symbolInCode(r.dir, "retryPost")).toBe(false);
    expect(await repoStateDisputes("`retryPost` is not implemented.", [r.dir])).toEqual([]);
  });

  test("a place named right after the verb is another package's claim", async () => {
    const r = repo();
    expect(await repoStateDisputes("`renderShell` is now wired in web.", [r.dir])).toEqual([]);
  });

  test("a mention in a comment or a doc file does not count as code", async () => {
    const r = repo();
    r.write("src/c.ts", "// retryPost: wire this up later\nexport const c = 1;\n");
    r.write("README.md", "Call `retryPost` to retry.\n");
    r.git("add", ".");
    r.git("commit", "-qm", "notes");
    expect(await gitRepoProbe.symbolInCode(r.dir, "retryPost")).toBe(false);
    expect(await repoStateDisputes("`retryPost` is not implemented.", [r.dir])).toEqual([]);
  });

  test("a symbol defined in code refutes a not-implemented claim", async () => {
    const r = repo();
    r.write("src/c.ts", "export function retryPost() {}\n");
    r.git("add", ".");
    r.git("commit", "-qm", "retry");
    const disputes = await repoStateDisputes("`retryPost` is not implemented.", [r.dir]);
    expect(disputes).toHaveLength(1);
    expect(disputes[0]!.claim).toContain("retryPost");
  });

  test("a claim about another package is not checked against this repo", async () => {
    const r = repo();
    expect(await repoStateDisputes("`renderShell` is now wired in the web package.", [r.dir])).toEqual([]);
    // Without that placement, a symbol no repo has refutes "implemented".
    expect(await repoStateDisputes("`renderShell` is now implemented.", [r.dir])).toHaveLength(1);
  });

  test("a symbol present in any of the project's repos is not refuted", async () => {
    const a = repo();
    const b = repo();
    b.write("src/shell.ts", "export function renderShell() {}\n");
    b.git("add", ".");
    b.git("commit", "-qm", "shell");
    expect(await repoStateDisputes("`renderShell` is now implemented.", [a.dir, b.dir])).toEqual([]);
  });

  test("negated phrasing is read as the negative claim only", () => {
    expect(extractRepoStateClaims("Commit abc1234 is not merged yet.").map((c) => c.kind)).toEqual(["unmerged"]);
  });
});

describe("publish fact-check", () => {
  function deps(doc: KnowledgeDocFile, verdict: "clean" | "error") {
    const writes: Array<{ verdict: string; disputes: unknown[] }> = [];
    let stamped = false;
    const d: PublishVerifyDeps = {
      verify: async () => ({ verdict, disputes: [] }),
      readAcceptedDoc: async () => doc,
      currentDisputes: () => [],
      stampVerified: async () => {
        stamped = true;
      },
      recordVerdict: (_p, _s, v, disputes) => writes.push({ verdict: v, disputes }),
      otherRepos: () => [],
    };
    return { d, writes, stamped: () => stamped };
  }
  const file = (body: string): KnowledgeDocFile => ({
    slug: "s",
    title: "T",
    body,
    tags: [],
    updatedAt: new Date(),
    sourceKind: "code",
    originClass: "agent",
    confidence: 0.6,
  });

  test("a claim git refutes is shown on the doc for a human, without disputing or verifying it", async () => {
    const r = repo();
    const sha = shortSha(r);
    const body = `Commit ${sha} is not merged yet.`;
    const h = deps(file(body), "clean");
    const out = await verifyPublishedDoc(h.d, "p", "s", body, r.dir);
    expect(out.outcome).toBe("unchecked");
    expect(h.writes[0]!.verdict).toBe("unverified");
    expect((h.writes[0]!.disputes[0] as { origin?: string }).origin).toBe("git");
    expect(h.stamped()).toBe(false);
  });

  test("with nothing refuted a passing model check verifies the doc; an error leaves it pending", async () => {
    const r = repo();
    const ok = deps(file("Plain prose."), "clean");
    expect((await verifyPublishedDoc(ok.d, "p", "s", "Plain prose.", r.dir)).outcome).toBe("clean");
    expect(ok.stamped()).toBe(true);
    const err = deps(file("Plain prose."), "error");
    expect((await verifyPublishedDoc(err.d, "p", "s", "Plain prose.", r.dir)).outcome).toBe("unchecked");
    expect(err.writes).toEqual([]);
  });
});
