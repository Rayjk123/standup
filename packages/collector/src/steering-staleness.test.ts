import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { createStore, upsertProject } from "@standup/store";
import { STEERING_BEGIN, STEERING_END, steeringBlock, steeringInstallPaths } from "@standup/shared/steering";
import { createKnowledgePusher } from "./knowledge-push.js";
import {
  checkInstalledSteering,
  STALE_STEERING_NOTICE,
  staleSteeringNoticeAtBoot,
  STEERING_REPAIR_COMMAND,
} from "./steering-staleness.js";

/**
 * The collector's read-only check of the installed steering under a scratch
 * HOME: a managed block that differs from the shipped one, or that (or an
 * installed skill) names a retired tool, is stale; the operator is warned and
 * SessionStart's push context carries the one-line correction.
 */

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function scratchHome(): string {
  const home = mkdtempSync(join(tmpdir(), "steering-staleness-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

function put(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

const block = (body: string) => `${STEERING_BEGIN}\n${body}\n${STEERING_END}`;

describe("checkInstalledSteering", () => {
  test.each([
    ["nothing installed", () => {}, false],
    ["the current block", (h: string) => put(steeringInstallPaths(h).claudeMdPath, `# Mine\n\n${steeringBlock()}\n`), false],
    [
      "a CLAUDE.md with no managed block, whatever it names",
      (h: string) => put(steeringInstallPaths(h).claudeMdPath, "# Mine\n\nI used to call ask_expert.\n"),
      false,
    ],
    [
      "a block naming the retired tool",
      (h: string) => put(steeringInstallPaths(h).claudeMdPath, `${block("call `ask_expert` for a cited answer")}\n`),
      true,
    ],
    ["a block that differs from the shipped one", (h: string) => put(steeringInstallPaths(h).claudeMdPath, `${block("old text")}\n`), true],
    ["a stale AGENTS.md block", (h: string) => put(steeringInstallPaths(h).codexAgentsMdPath, `${block("old text")}\n`), true],
    [
      "an installed skill naming the retired tool",
      (h: string) => put(join(steeringInstallPaths(h).skillDir, "SKILL.md"), "Use ask_expert for a synthesized answer."),
      true,
    ],
  ] as const)("%s → stale %p", (_label, install, stale) => {
    const home = scratchHome();
    install(home);
    expect(checkInstalledSteering(home).stale).toBe(stale);
  });
});

describe("staleSteeringNoticeAtBoot", () => {
  test("warns with the stale file and the repair command, and returns the notice", () => {
    const home = scratchHome();
    const path = steeringInstallPaths(home).claudeMdPath;
    put(path, `${block("call `ask_expert`")}\n`);
    const warnings: string[] = [];
    expect(staleSteeringNoticeAtBoot(home, (m) => warnings.push(m))).toBe(STALE_STEERING_NOTICE);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(path);
    expect(warnings[0]).toContain(STEERING_REPAIR_COMMAND);
  });

  test("current steering: no warning, no notice", () => {
    const home = scratchHome();
    put(steeringInstallPaths(home).claudeMdPath, `${steeringBlock()}\n`);
    const warnings: string[] = [];
    expect(staleSteeringNoticeAtBoot(home, (m) => warnings.push(m))).toBeUndefined();
    expect(warnings).toEqual([]);
  });
});

describe("the SessionStart notice", () => {
  function pusher(results: Array<{ slug: string }>, env: NodeJS.ProcessEnv = {}) {
    const store = createStore(":memory:");
    cleanups.push(() => store.close());
    upsertProject(store.db, { id: "alpha", name: "Alpha", branch: "main", repos: ["/repo"] });
    store.db.run("INSERT INTO sessions (id, project_id, cwd) VALUES ('s1', 'alpha', '/repo')");
    return createKnowledgePusher({
      db: store.db,
      search: async () =>
        results.map(({ slug }) => ({
          id: slug,
          projectId: "alpha",
          slug,
          title: `Title ${slug}`,
          excerpt: `About ${slug}.`,
          score: 0.9,
          relevance: 0.9,
          source: "text" as const,
          originClass: "owner" as const,
          sourceKind: "code" as const,
          generated: false,
          scope: "project" as const,
        })),
      sessionStartNotice: STALE_STEERING_NOTICE,
      env,
    });
  }
  const sessionStart = { session_id: "s1", hook_event_name: "SessionStart", cwd: "/repo" };

  test("rides after the pushed docs", async () => {
    const push = await pusher([{ slug: "a" }]).forHook(sessionStart);
    expect(push?.docs.map((d) => d.slug)).toEqual(["a"]);
    expect(push?.text.endsWith(`\n\n${STALE_STEERING_NOTICE}`)).toBe(true);
  });

  test("stands alone when nothing clears the bar", async () => {
    const push = await pusher([]).forHook(sessionStart);
    expect(push).toEqual({ event: "SessionStart", text: STALE_STEERING_NOTICE, docs: [] });
  });

  test("only on SessionStart, and not while the push is off", async () => {
    const prompt = { session_id: "s1", hook_event_name: "UserPromptSubmit", cwd: "/repo", prompt: "how is the quota override configured today" };
    expect((await pusher([]).forHook(prompt))?.text ?? "").not.toContain(STALE_STEERING_NOTICE);
    expect(await pusher([], { STANDUP_KNOWLEDGE_PUSH: "0" }).forHook(sessionStart)).toBeNull();
  });
});
