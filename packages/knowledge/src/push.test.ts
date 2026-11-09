import { describe, expect, test } from "bun:test";
import {
  formatPushBlock,
  pushAreaQuery,
  pushEditTarget,
  pushGate,
  pushPromptQuery,
  pushSearchOptions,
  pushSessionStartQuery,
  selectPushDocs,
  PUSH_EXCLUDED_LAYERS,
  PUSH_HEADERS,
  PUSH_MAX_CHARS,
  PUSH_RELEVANCE_BAR,
  type PushCandidate,
} from "./push.js";
import { FOREIGN_INTENT_INJECT_MIN_RELEVANCE } from "./query-rewrite.js";

function hit(slug: string, overrides: Partial<PushCandidate> = {}): PushCandidate {
  return {
    projectId: "alpha",
    slug,
    title: `Title of ${slug}`,
    excerpt: `What ${slug} says about the code.`,
    relevance: 0.9,
    originClass: "owner",
    scope: "project",
    sourceKind: "code",
    ...overrides,
  };
}

describe("pushGate", () => {
  const cases: Array<[string, Partial<PushCandidate>, ReturnType<typeof pushGate>]> = [
    ["clears the bar", {}, null],
    ["exactly at the bar", { relevance: PUSH_RELEVANCE_BAR }, null],
    ["below the bar", { relevance: PUSH_RELEVANCE_BAR - 0.01 }, "floor"],
    ["at the search floor only", { relevance: 0.2 }, "floor"],
    ["no relevance", { relevance: undefined }, "floor"],
    ["named in the query", { relevance: 0.1, relevanceSignals: { named: true } as PushCandidate["relevanceSignals"] }, null],
    ["untrusted origin", { originClass: "untrusted" }, "origin"],
    ["disputed", { verdict: "disputed" }, "verdict"],
    ["superseded", { verdict: "superseded" }, "verdict"],
    ["contradicted, losing", { verdict: "contradicted", contradiction: { side: "losing", counterparts: [] } as never }, "verdict"],
    ["contradicted, undecided", { verdict: "contradicted", contradiction: { side: "undecided", counterparts: [] } as never }, "verdict"],
    ["contradicted, winning", { verdict: "contradicted", contradiction: { side: "winning", counterparts: [] } as never }, null],
    ["clean verdict", { verdict: "clean" }, null],
    ["personal layer", { scope: "user" }, "personal"],
    ["activity layer", { sourceKind: "native-memory", slug: "native-mem-memory-diary" }, "activity"],
  ];
  for (const [name, overrides, expected] of cases) {
    test(name, () => {
      const h = hit(overrides.slug ?? "doc", overrides);
      expect(pushGate(h)).toBe(expected);
    });
  }

  test("a stale doc fails the caller's freshness gate", () => {
    expect(pushGate(hit("doc"), { fresh: () => false })).toBe("freshness");
  });

  test("a doc the session has already seen is held back", () => {
    expect(pushGate(hit("doc"), { seen: new Set(["alpha/doc"]) })).toBe("seen");
  });

  describe("foreign product/spec intent, for a push into project alpha", () => {
    const named = { named: true } as PushCandidate["relevanceSignals"];
    const cases: Array<[string, Partial<PushCandidate>, ReturnType<typeof pushGate>]> = [
      ["another project's spec, named but weak", { projectId: "beta", sourceKind: "spec", relevance: 0.1, relevanceSignals: named }, "floor"],
      [
        "another project's product doc, named and above the foreign bar",
        { projectId: "beta", sourceKind: "product", relevance: FOREIGN_INTENT_INJECT_MIN_RELEVANCE, relevanceSignals: named },
        null,
      ],
      ["alpha's own spec, named but weak", { sourceKind: "spec", relevance: 0.1, relevanceSignals: named }, null],
      ["another project's code doc, named but weak", { projectId: "beta", relevance: 0.1, relevanceSignals: named }, null],
    ];
    for (const [name, overrides, expected] of cases) {
      test(name, () => {
        expect(pushGate(hit("doc", overrides), { projectId: "alpha" })).toBe(expected);
      });
    }
  });
});

describe("pushSearchOptions", () => {
  test("excludes foreign intent and the never-pushed layers, as launch injection does", () => {
    const options = pushSearchOptions({ projectId: "alpha", relatedProjectIds: ["beta"] });
    expect(options.audience).toEqual({
      projectId: "alpha",
      relatedProjectIds: ["beta"],
      excludeLayers: PUSH_EXCLUDED_LAYERS,
      excludeForeignIntent: true,
    });
    expect(options.corpus).toBe("all");
    expect(options.confidentFor).toBe("inject");
  });
});

describe("selectPushDocs", () => {
  test("caps per event and keeps rank order", () => {
    const hits = ["a", "b", "c", "d"].map((s) => hit(s));
    expect(selectPushDocs(hits, "SessionStart").map((h) => h.slug)).toEqual(["a", "b", "c"]);
    expect(selectPushDocs(hits, "UserPromptSubmit").map((h) => h.slug)).toEqual(["a", "b"]);
    expect(selectPushDocs(hits, "PreToolUse").map((h) => h.slug)).toEqual(["a", "b"]);
  });

  test("skips gated, seen and repeated hits before applying the cap", () => {
    const hits = [
      hit("disputed", { verdict: "disputed" }),
      hit("weak", { relevance: 0.3 }),
      hit("seen"),
      hit("a"),
      hit("a"),
      hit("b"),
    ];
    const picked = selectPushDocs(hits, "UserPromptSubmit", { seen: new Set(["alpha/seen"]) });
    expect(picked.map((h) => h.slug)).toEqual(["a", "b"]);
  });

  test("nothing clears the bar → nothing selected", () => {
    expect(selectPushDocs([hit("a", { relevance: 0.4 }), hit("b", { relevance: 0.5 })], "SessionStart")).toEqual([]);
  });
});

describe("formatPushBlock", () => {
  test("header then one line per doc naming the slug", () => {
    const { text, included } = formatPushBlock("UserPromptSubmit", [hit("a"), hit("b")]);
    const lines = text.split("\n");
    expect(lines[0]).toBe(PUSH_HEADERS.UserPromptSubmit);
    expect(lines[1]).toBe('- Title of a — What a says about the code. (get_knowledge_doc slug "alpha/a")');
    expect(lines).toHaveLength(3);
    expect(included).toHaveLength(2);
  });

  test("long titles and excerpts are clipped to the event budget", () => {
    const long = (s: string) =>
      hit(s, { title: `A very long title ${"word ".repeat(40)}`, excerpt: `## Heading\n\n${"excerpt text ".repeat(100)}` });
    for (const event of ["SessionStart", "UserPromptSubmit", "PreToolUse"] as const) {
      const { text, included } = formatPushBlock(event, [long("one"), long("two"), long("three")].slice(0, event === "SessionStart" ? 3 : 2));
      expect(text.length).toBeLessThanOrEqual(PUSH_MAX_CHARS[event]);
      expect(included.length).toBeGreaterThan(0);
      for (const line of text.split("\n").slice(1)) {
        expect(line).toMatch(/^- .+ \(get_knowledge_doc slug "alpha\/(one|two|three)"\)$/);
        expect(line).not.toContain("#");
        expect(line).not.toContain("\n");
      }
    }
  });

  test("a doc whose line cannot fit is left out", () => {
    const { text, included } = formatPushBlock("PreToolUse", [hit("a"), hit("b")], PUSH_HEADERS.PreToolUse.length + 70);
    expect(included.map((d) => d.slug)).toEqual(["a"]);
    expect(text.split("\n")).toHaveLength(2);
  });

  test("no docs → empty text", () => {
    expect(formatPushBlock("SessionStart", [])).toEqual({ text: "", included: [] });
  });
});

describe("pushPromptQuery", () => {
  const cases: Array<[unknown, string | null]> = [
    ["How does the launcher inject knowledge into the opening prompt?", "How does the launcher inject knowledge into the opening prompt?"],
    ["/compact", null],
    ["/review the diff please now", null],
    ["continue", null],
    ["Continue please.", null],
    ["go ahead", null],
    ["yes", null],
    ["fix the bug", null],
    ["", null],
    [undefined, null],
    [42, null],
  ];
  for (const [prompt, expected] of cases) {
    test(JSON.stringify(prompt), () => {
      expect(pushPromptQuery(prompt)).toBe(expected);
    });
  }

  test("a long prompt is cut", () => {
    expect(pushPromptQuery("word ".repeat(1000))!.length).toBeLessThanOrEqual(1000);
  });
});

describe("pushSessionStartQuery", () => {
  test("a launch brief wins", () => {
    expect(pushSessionStartQuery({ brief: "Add the playground", projectName: "Alpha", recentPrompt: "x" })).toBe("Add the playground");
  });
  test("else the project name and recent prompt", () => {
    expect(pushSessionStartQuery({ projectName: "Alpha", recentPrompt: "fix routing" })).toBe("Alpha fix routing");
  });
  test("nothing → null", () => {
    expect(pushSessionStartQuery({})).toBeNull();
  });
});

describe("pushEditTarget", () => {
  const cases: Array<[string, unknown, string | null]> = [
    ["Edit", { file_path: "/repo/src/a.ts" }, "/repo/src/a.ts"],
    ["Write", { file_path: "/repo/b.md" }, "/repo/b.md"],
    ["MultiEdit", { file_path: "/repo/c.ts", edits: [] }, "/repo/c.ts"],
    ["NotebookEdit", { notebook_path: "/repo/n.ipynb" }, "/repo/n.ipynb"],
    ["apply_patch", { input: "*** Begin Patch\n*** Update File: src/x.ts\n@@\n-a\n+b\n*** End Patch" }, "src/x.ts"],
    ["apply_patch", { command: ["apply_patch", "*** Begin Patch\n*** Add File: docs/y.md\n+hi\n*** End Patch"] }, "docs/y.md"],
    ["Read", { file_path: "/repo/src/a.ts" }, null],
    ["Bash", { command: "ls" }, null],
    ["Edit", {}, null],
  ];
  for (const [tool, input, expected] of cases) {
    test(`${tool} ${JSON.stringify(input).slice(0, 40)}`, () => {
      expect(pushEditTarget(tool, input)).toBe(expected);
    });
  }
});

describe("pushAreaQuery", () => {
  test("relative to the cwd: path, directory words and stem", () => {
    expect(pushAreaQuery("/repo/packages/collector/src/launcher.ts", "/repo")).toEqual({
      area: "/repo/packages/collector/src",
      query: "packages/collector/src/launcher.ts packages collector src launcher",
    });
  });
  test("outside the cwd: the last segments", () => {
    expect(pushAreaQuery("/elsewhere/a/b/c/d/file.ts", "/repo").query).toBe("b/c/d/file.ts b c d file");
  });
  test("a file at the cwd root has no directory words", () => {
    expect(pushAreaQuery("/repo/README.md", "/repo")).toEqual({ area: "/repo", query: "README.md README" });
  });
});
