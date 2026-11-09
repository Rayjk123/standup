import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createStore, upsertProject } from "@standup/store";
import { KnowledgeStore } from "@standup/knowledge";
import { CodeSymbolIndexer, extractSymbols } from "./code-symbols.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "code-symbols-"));
  dirs.push(dir);
  return dir;
}

function git(repo: string, args: string[]): void {
  const proc = Bun.spawnSync(["git", ...args], { cwd: repo });
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`);
}

function commit(repo: string, message: string): void {
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", message]);
}

function initRepo(repo: string): void {
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
}

function harness(repo: string) {
  const store = createStore(":memory:");
  upsertProject(store.db, { id: "proj", name: "Proj", repos: [repo], branch: "main" });
  const knowledge = new KnowledgeStore(store.db);
  const indexer = new CodeSymbolIndexer({
    db: store.db,
    store: knowledge,
    projects: () => [{ id: "proj", repos: [repo] }],
  });
  return { store, knowledge, indexer };
}

describe("symbol extraction", () => {
  test("TypeScript exported and top-level declarations", () => {
    const symbols = extractSymbols(
      "src/a.ts",
      [
        "export function alpha() {}",
        "export async function beta() {}",
        "export abstract class Gamma {}",
        "export interface Delta {}",
        "export type Epsilon = string;",
        "export enum Zeta {}",
        "export const eta = 1;",
        "export default class Theta {}",
        "function iota() {}",
        "class Kappa {}",
        "  function nested() {}",
      ].join("\n")
    );
    expect(symbols.map((s) => [s.name, s.kind])).toEqual([
      ["alpha", "function"],
      ["beta", "function"],
      ["Gamma", "class"],
      ["Delta", "interface"],
      ["Epsilon", "type"],
      ["Zeta", "enum"],
      ["eta", "const"],
      ["Theta", "default"],
      ["iota", "function"],
      ["Kappa", "class"],
    ]);
    expect(symbols[0]).toMatchObject({ line: 1, signature: "export function alpha() {}" });
  });

  test("Python definitions at column 0 only", () => {
    const symbols = extractSymbols(
      "x.py",
      ["class Store:", "    def method(self):", "        pass", "def helper():", "    pass"].join("\n")
    );
    expect(symbols.map((s) => [s.name, s.kind, s.line])).toEqual([
      ["Store", "class", 1],
      ["helper", "function", 4],
    ]);
  });

  test("Java, Kotlin and Go declarations", () => {
    expect(extractSymbols("X.java", "public final class Widget {\n  interface Inner {}\n").map((s) => s.name)).toEqual([
      "Widget",
      "Inner",
    ]);
    expect(extractSymbols("x.kt", "fun compute(a: Int) = a\nobject Holder {}\n").map((s) => [s.name, s.kind])).toEqual([
      ["compute", "function"],
      ["Holder", "object"],
    ]);
    expect(
      extractSymbols("x.go", "func (s *Store) Get() {}\nfunc New() {}\ntype Store struct{}\nvar Default = 1\n").map(
        (s) => [s.name, s.kind]
      )
    ).toEqual([
      ["Get", "function"],
      ["New", "function"],
      ["Store", "type"],
      ["Default", "const"],
    ]);
  });

  test("a file in an unindexed language yields nothing", () => {
    expect(extractSymbols("notes.md", "# export function nope()\n")).toEqual([]);
  });
});

describe("indexing a repo at HEAD", () => {
  test("a full pass indexes symbols and paths, and both are then lookupable", async () => {
    const repo = tempRepo();
    initRepo(repo);
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, "src", "search.ts"), "export async function searchCode() {}\n");
    writeFileSync(join(repo, "src", "config.ts"), "// no exports here\n");
    commit(repo, "seed");

    const { knowledge, indexer } = harness(repo);
    const outcome = await indexer.indexRepo("proj", repo);
    expect(outcome.mode).toBe("full");
    expect(outcome.files).toBe(2);

    const hits = knowledge.lookupSymbols("proj", "searchCode");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      file: "src/search.ts",
      line: 1,
      kind: "function",
      signature: "export async function searchCode() {}",
    });

    // A prefix resolves a half-remembered name, and a file that exports nothing
    // is still reachable by path.
    expect(knowledge.lookupSymbols("proj", "searchCo").map((s) => s.name)).toEqual(["searchCode"]);
    expect(knowledge.lookupPaths("proj", "config")).toEqual(["src/config.ts"]);
  });

  test("an unmoved HEAD costs no re-index; a moved one updates incrementally", async () => {
    const repo = tempRepo();
    initRepo(repo);
    writeFileSync(join(repo, "one.ts"), "export const one = 1;\n");
    writeFileSync(join(repo, "two.ts"), "export const two = 2;\n");
    commit(repo, "seed");

    const { knowledge, indexer } = harness(repo);
    expect((await indexer.indexRepo("proj", repo)).mode).toBe("full");
    expect((await indexer.indexRepo("proj", repo)).mode).toBe("unchanged");

    writeFileSync(join(repo, "two.ts"), "export const two = 2;\nexport function added() {}\n");
    unlinkSync(join(repo, "one.ts"));
    commit(repo, "change two, drop one");

    const outcome = await indexer.indexRepo("proj", repo);
    expect(outcome.mode).toBe("incremental");
    // Only the changed files were read, and the deleted file's rows are gone.
    expect(outcome.files).toBe(1);
    expect(knowledge.lookupSymbols("proj", "added").map((s) => s.file)).toEqual(["two.ts"]);
    expect(knowledge.lookupSymbols("proj", "one")).toEqual([]);
    expect(knowledge.lookupPaths("proj", "one.ts")).toEqual([]);
    // The untouched file kept its rows rather than being dropped and re-read.
    expect(knowledge.lookupSymbols("proj", "two").map((s) => s.file)).toEqual(["two.ts"]);
  });

  test("a directory that is not a repo is skipped with a reason", async () => {
    const dir = tempRepo();
    const { indexer } = harness(dir);
    const outcome = await indexer.indexRepo("proj", dir);
    expect(outcome.mode).toBe("skipped");
    expect(outcome.reason).toContain("HEAD");
  });

  test("symbols come from HEAD's blobs, not uncommitted working-tree edits", async () => {
    const repo = tempRepo();
    initRepo(repo);
    writeFileSync(join(repo, "a.ts"), "export function committed() {}\n");
    commit(repo, "seed");
    // Dirty edit and an untracked file, neither in HEAD.
    writeFileSync(join(repo, "a.ts"), "export function uncommitted() {}\n");
    writeFileSync(join(repo, "b.ts"), "export function untracked() {}\n");

    const { knowledge, indexer } = harness(repo);
    await indexer.indexRepo("proj", repo);
    expect(knowledge.lookupSymbols("proj", "committed").map((s) => s.file)).toEqual(["a.ts"]);
    expect(knowledge.lookupSymbols("proj", "uncommitted")).toEqual([]);
    expect(knowledge.lookupSymbols("proj", "untracked")).toEqual([]);
  });

  test("a tracked symlink is not followed out of the repo", async () => {
    const repo = tempRepo();
    const outside = tempRepo();
    writeFileSync(join(outside, "secret.ts"), "export function outsideSecret() {}\n");
    initRepo(repo);
    writeFileSync(join(repo, "real.ts"), "export const real = 1;\n");
    symlinkSync(join(outside, "secret.ts"), join(repo, "link.ts"));
    commit(repo, "seed with a link");

    const { knowledge, indexer } = harness(repo);
    const outcome = await indexer.indexRepo("proj", repo);
    expect(outcome.files).toBe(1);
    expect(knowledge.lookupSymbols("proj", "outsideSecret")).toEqual([]);
    expect(knowledge.lookupPaths("proj", "link")).toEqual([]);
  });

  test("a rename clears the old path's rows on an incremental pass", async () => {
    const repo = tempRepo();
    initRepo(repo);
    writeFileSync(join(repo, "old.ts"), "export function renamedFn() {}\n");
    writeFileSync(join(repo, "keep.ts"), "export const keep = 1;\n");
    commit(repo, "seed");

    const { knowledge, indexer } = harness(repo);
    await indexer.indexRepo("proj", repo);
    git(repo, ["mv", "old.ts", "new.ts"]);
    commit(repo, "rename");

    const outcome = await indexer.indexRepo("proj", repo);
    expect(outcome.mode).toBe("incremental");
    expect(knowledge.lookupSymbols("proj", "renamedFn").map((s) => s.file)).toEqual(["new.ts"]);
    expect(knowledge.lookupPaths("proj", "old.ts")).toEqual([]);
  });

  test("the unchanged check is per repo, and a repo no longer configured loses its rows", async () => {
    const first = tempRepo();
    const second = tempRepo();
    for (const [repo, name] of [
      [first, "fromFirst"],
      [second, "fromSecond"],
    ] as const) {
      initRepo(repo);
      writeFileSync(join(repo, "a.ts"), `export function ${name}() {}\n`);
      commit(repo, "seed");
    }

    const store = createStore(":memory:");
    const knowledge = new KnowledgeStore(store.db);
    let repos = [first];
    const indexer = new CodeSymbolIndexer({
      db: store.db,
      store: knowledge,
      projects: () => [{ id: "proj", repos }],
    });
    await indexer.indexAll();
    expect(knowledge.lookupSymbols("proj", "fromFirst")).toHaveLength(1);

    // Switching the project's primary repo indexes the new one (rows of the
    // project existing elsewhere don't count as "unchanged") and drops the old.
    repos = [second];
    const outcomes = await indexer.indexAll();
    expect(outcomes.map((o) => o.mode)).toEqual(["full"]);
    expect(knowledge.lookupSymbols("proj", "fromSecond")).toHaveLength(1);
    expect(knowledge.lookupSymbols("proj", "fromFirst")).toEqual([]);

    // A project that disappears takes its rows with it.
    repos = [];
    await indexer.indexAll();
    expect(knowledge.codeSymbolStats("proj").files).toBe(0);
    indexer.stop();
  });

  test("a range touching more files than maxFiles re-indexes in full rather than partly", async () => {
    const repo = tempRepo();
    initRepo(repo);
    writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
    commit(repo, "seed");
    const store = createStore(":memory:");
    const knowledge = new KnowledgeStore(store.db);
    const indexer = new CodeSymbolIndexer({
      db: store.db,
      store: knowledge,
      projects: () => [{ id: "proj", repos: [repo] }],
      maxFiles: 2,
    });
    await indexer.indexRepo("proj", repo);
    for (const name of ["b", "c", "d"]) writeFileSync(join(repo, `${name}.ts`), `export const ${name} = 1;\n`);
    commit(repo, "three files");
    const outcome = await indexer.indexRepo("proj", repo);
    expect(outcome.mode).toBe("full");
    expect(outcome.files).toBe(2);
  });

  test("a pass covers every project that has a repo", async () => {
    const repo = tempRepo();
    initRepo(repo);
    writeFileSync(join(repo, "a.ts"), "export class Thing {}\n");
    commit(repo, "seed");

    const { knowledge, indexer } = harness(repo);
    const outcomes = await indexer.indexAll();
    indexer.stop();
    expect(outcomes.map((o) => o.projectId)).toEqual(["proj"]);
    expect(knowledge.lookupSymbols("proj", "Thing")).toHaveLength(1);
  });
});
