import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import { createStore, createSession, reassignSessionProject, getSession } from "@standup/store";
import {
  inferMainProject,
  resolveInferredProject,
  buildInferencePrompt,
  type ProjectCandidate,
} from "./project-inference.js";

const CANDIDATES: ProjectCandidate[] = [
  { id: "alpha", name: "Alpha Service", repos: ["~/code/alpha"] },
  { id: "beta", name: "Beta Web", repos: ["~/code/beta-web"] },
];

describe("inferMainProject — matcher (mocked model)", () => {
  test("picks the project the model names, and feeds it the task + cwd + candidates", async () => {
    let seenPrompt = "";
    const runModel = async (prompt: string) => {
      seenPrompt = prompt;
      return "beta";
    };

    const result = await inferMainProject(
      {
        task: "Fix the login form on the Beta website",
        cwd: "/tmp/scratch/poke-around",
        candidates: CANDIDATES,
      },
      runModel
    );

    expect(result).toBe("beta");
    // The prompt must actually carry the signals the matcher reasons over.
    expect(seenPrompt).toContain("Fix the login form on the Beta website");
    expect(seenPrompt).toContain("/tmp/scratch/poke-around");
    expect(seenPrompt).toContain("alpha");
    expect(seenPrompt).toContain("beta");
    expect(seenPrompt).toContain("~/code/beta-web");
  });

  test("model reply tolerates surrounding quotes and casing", async () => {
    const result = await inferMainProject(
      { task: "work on alpha", cwd: "/tmp/x", candidates: CANDIDATES },
      async () => '"ALPHA"'
    );
    expect(result).toBe("alpha");
  });

  test("the model may name a project by its NAME (case-insensitive), mapped back to the id", async () => {
    const result = await inferMainProject(
      { task: "fix the beta site", cwd: "/tmp/x", candidates: CANDIDATES },
      async () => "beta web"
    );
    expect(result).toBe("beta");
  });

  test("NONE → null (stays scratch)", async () => {
    const result = await inferMainProject(
      { task: "something unrelated", cwd: "/tmp/x", candidates: CANDIDATES },
      async () => "NONE"
    );
    expect(result).toBeNull();
  });

  test("an id that isn't a registered project → null", async () => {
    const result = await inferMainProject(
      { task: "work", cwd: "/tmp/x", candidates: CANDIDATES },
      async () => "gamma"
    );
    expect(result).toBeNull();
  });

  test("empty / failed model call → null", async () => {
    expect(
      await inferMainProject(
        { task: "work", cwd: "/tmp/x", candidates: CANDIDATES },
        async () => null
      )
    ).toBeNull();
    expect(
      await inferMainProject(
        { task: "work", cwd: "/tmp/x", candidates: CANDIDATES },
        async () => {
          throw new Error("model exploded");
        }
      )
    ).toBeNull();
  });

  test("no candidates or empty task → null without calling the model", async () => {
    let called = false;
    const runModel = async () => {
      called = true;
      return "alpha";
    };
    expect(await inferMainProject({ task: "work", cwd: "/tmp", candidates: [] }, runModel)).toBeNull();
    expect(await inferMainProject({ task: "   ", cwd: "/tmp", candidates: CANDIDATES }, runModel)).toBeNull();
    expect(called).toBe(false);
  });
});

describe("resolveInferredProject — pure", () => {
  test("exact and case-insensitive id match", () => {
    expect(resolveInferredProject("beta", CANDIDATES)).toBe("beta");
    expect(resolveInferredProject("Alpha.", CANDIDATES)).toBe("alpha");
    expect(resolveInferredProject("`beta`\nsome reasoning", CANDIDATES)).toBe("beta");
  });

  test("exact NAME match (case-insensitive) maps back to the id", () => {
    expect(resolveInferredProject("Beta Web", CANDIDATES)).toBe("beta");
    expect(resolveInferredProject("alpha service", CANDIDATES)).toBe("alpha");
    // A stray quote/period around a name is tolerated the same way an id is.
    expect(resolveInferredProject('"Alpha Service".', CANDIDATES)).toBe("alpha");
  });

  test("an id match wins over a name match", () => {
    // A candidate whose NAME collides with another's id: answering the id must
    // still resolve to the id owner, not the name owner.
    const tricky: ProjectCandidate[] = [
      { id: "beta", name: "Beta Web", repos: [] },
      { id: "web", name: "beta", repos: [] },
    ];
    expect(resolveInferredProject("beta", tricky)).toBe("beta");
  });

  test("an ambiguous NAME (two projects share it) declines", () => {
    const dupes: ProjectCandidate[] = [
      { id: "one", name: "Shared", repos: [] },
      { id: "two", name: "Shared", repos: [] },
    ];
    expect(resolveInferredProject("shared", dupes)).toBeNull();
  });

  test("declines on NONE, empty, and unknown", () => {
    expect(resolveInferredProject("NONE", CANDIDATES)).toBeNull();
    expect(resolveInferredProject("", CANDIDATES)).toBeNull();
    expect(resolveInferredProject(null, CANDIDATES)).toBeNull();
    expect(resolveInferredProject("delta", CANDIDATES)).toBeNull();
  });
});

describe("inferMainProject — logs its decision at every outcome", () => {
  const originalLog = console.log;
  let logs: string[];
  beforeEach(() => {
    logs = [];
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
  });
  afterEach(() => {
    console.log = originalLog;
  });

  test("a confident match logs [infer] matched <id>", async () => {
    await inferMainProject(
      { task: "work on alpha", cwd: "/tmp/x", candidates: CANDIDATES },
      async () => "alpha"
    );
    expect(logs.some((l) => l === "[infer] matched alpha")).toBe(true);
  });

  test("a decline logs [infer] declined (NONE/ambiguous) with the raw first line", async () => {
    await inferMainProject(
      { task: "unrelated", cwd: "/tmp/x", candidates: CANDIDATES },
      async () => "NONE\nno good match here"
    );
    expect(logs.some((l) => l.startsWith('[infer] declined (NONE/ambiguous) raw="NONE"'))).toBe(true);
  });

  test("a failed model call logs [infer] error <msg>", async () => {
    await inferMainProject(
      { task: "work", cwd: "/tmp/x", candidates: CANDIDATES },
      async () => {
        throw new Error("model exploded");
      }
    );
    expect(logs.some((l) => l === "[infer] error model exploded")).toBe(true);
  });
});

describe("buildInferencePrompt", () => {
  test("lists every candidate with id/name/repos and instructs NONE", () => {
    const prompt = buildInferencePrompt({
      task: "t",
      cwd: "/c",
      candidates: CANDIDATES,
    });
    expect(prompt).toContain("id: alpha");
    expect(prompt).toContain("name: Beta Web");
    expect(prompt).toContain("NONE");
  });
});

describe("reassignSessionProject — the re-home the matcher drives", () => {
  test("moves a scratch session and no-ops for one already in a project", () => {
    const store = createStore(":memory:");
    store.db.run(
      "INSERT INTO projects (id, name, branch, repos_json) VALUES ('scratch','scratch','main','[]'), ('beta','Beta','main','[]')"
    );

    createSession(store.db, { id: "s1", projectId: "scratch", title: "", cwd: "/tmp/a", status: "running" });
    createSession(store.db, { id: "s2", projectId: "beta", title: "", cwd: "/tmp/b", status: "running" });

    // A confident match re-homes a scratch session.
    expect(reassignSessionProject(store.db, "s1", "beta")).toBe(true);
    expect(getSession(store.db, "s1")?.projectId).toBe("beta");

    // A session already attributed to a project is never silently moved
    // (mirrors the ambiguous → stays-put case: the caller only reassigns on a
    // confident match, and even then only out of scratch).
    expect(reassignSessionProject(store.db, "s2", "alpha")).toBe(false);
    expect(getSession(store.db, "s2")?.projectId).toBe("beta");

    store.close();
  });
});
