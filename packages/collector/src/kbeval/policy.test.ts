import { describe, expect, test } from "bun:test";
import { policyRulesFor, policyViolations, type DocMeta } from "./policy.js";
import type { EvalCase, Hit } from "./types.js";

const audience = { projectId: "standup", user: "owner" };
const c = {
  id: "p",
  category: "docs",
  surface: ["search"],
  audience,
  query: "q",
  relevant: [],
} as EvalCase;

function meta(projectId: string, slug: string, over: Partial<DocMeta> = {}): DocMeta {
  return { projectId, slug, scope: "project", ownerUser: null, sourceKind: "decision", ...over };
}

describe("policy leakage rules", () => {
  test("owner CLAUDE.md / rules mirrors leak on shared surfaces, not on persona; auto-memory never", () => {
    const home = meta("global", "native-mem-home-claude-md", { scope: "global", sourceKind: "native-memory" });
    const rule = meta("global", "native-mem-home-rule-safety", { scope: "global", sourceKind: "native-memory" });
    const proj = meta("standup", "native-mem-project-claude-md", { sourceKind: "native-memory" });
    const auto = meta("standup", "native-mem-memory-diary", { sourceKind: "native-memory" });
    for (const s of ["search", "inject"] as const) {
      expect(policyRulesFor(home, s, c)).toEqual(["ownerMirror"]);
      expect(policyRulesFor(rule, s, c)).toEqual(["ownerMirror"]);
      expect(policyRulesFor(proj, s, c)).toEqual(["ownerMirror"]);
      expect(policyRulesFor(auto, s, c)).toEqual([]);
    }
    expect(policyRulesFor(home, "persona", c)).toEqual([]);
  });

  test("another user's doc and another project's project doc leak on any surface", () => {
    expect(policyRulesFor(meta("global", "x", { scope: "user", ownerUser: "bob" }), "persona", c)).toEqual(["otherUser"]);
    expect(policyRulesFor(meta("global", "x", { scope: "user", ownerUser: "owner" }), "search", c)).toEqual([]);
    expect(policyRulesFor(meta("catalog-core", "x"), "search", c)).toEqual(["otherProject"]);
    expect(policyRulesFor(meta("global", "x"), "search", c)).toEqual([]);
    expect(policyRulesFor(meta("catalog-core", "x", { scope: "global" }), "search", c)).toEqual([]);
  });

  test("inject may not carry another project's product/spec docs, even scope=global ones", () => {
    const spec = meta("acme-platform", "spec", { scope: "global", sourceKind: "spec" });
    expect(policyRulesFor(spec, "inject", c)).toEqual(["injectForeignProduct"]);
    expect(policyRulesFor(spec, "search", c)).toEqual([]);
    expect(policyRulesFor(meta("standup", "spec", { sourceKind: "product" }), "inject", c)).toEqual([]);
  });

  test("violations count hits and extra refs once each, tallying every rule broken", () => {
    const docs = new Map<string, DocMeta>([
      ["catalog-core/a", meta("catalog-core", "a", { sourceKind: "spec" })],
      ["global/u", meta("global", "u", { scope: "user", ownerUser: "bob" })],
      ["standup/ok", meta("standup", "ok")],
    ]);
    const hits: Hit[] = ["catalog-core/a", "standup/ok"].map((ref, rank) => ({ ref, rank, kind: "doc", flags: { marked: false } }));
    const v = policyViolations(c, "inject", hits, ["global/u"], docs);
    expect(v.hits).toBe(2);
    expect(v.byRule).toEqual({ ownerMirror: 0, otherUser: 1, otherProject: 1, injectForeignProduct: 1 });
    expect(v.refs).toEqual(["catalog-core/a", "global/u"]);
  });
});
