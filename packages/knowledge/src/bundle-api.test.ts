import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { KnowledgeStore, apiBundleSource, exportKnowledgeBundle, importKnowledgeBundle, shareableExclusion } from "./index.js";
import type { ApiKnowledgeDoc } from "./index.js";
import { createStore } from "@standup/store";

function apiDoc(over: Partial<ApiKnowledgeDoc> & { slug: string }): ApiKnowledgeDoc {
  return {
    title: over.slug,
    body: `Body of ${over.slug}.`,
    tags: [],
    sourceKind: "unclassified",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...over,
  };
}

describe("shareableExclusion", () => {
  const cases: Array<[string, ApiKnowledgeDoc, string | null]> = [
    ["a project doc is kept", apiDoc({ slug: "arch", scope: "project" }), null],
    ["a spec doc is kept", apiDoc({ slug: "spec", sourceKind: "spec" }), null],
    ["a disputed doc is kept", apiDoc({ slug: "d", verdict: "disputed" }), null],
    ["a user-scoped doc is personal", apiDoc({ slug: "mine", scope: "user", ownerUser: "me" }), "personal layer"],
    ["a native memory is left out", apiDoc({ slug: "memory-x", sourceKind: "native-memory" }), "native memory"],
    ["a persona doc is left out", apiDoc({ slug: "persona-prefs" }), "persona doc"],
    ["a superseded verdict is left out", apiDoc({ slug: "old", verdict: "superseded" }), "superseded"],
    ["a superseded tag is left out", apiDoc({ slug: "old2", tags: ["superseded"] }), "superseded"],
  ];
  for (const [name, doc, want] of cases) {
    test(name, () => expect(shareableExclusion(doc)).toBe(want));
  }
});

describe("apiBundleSource", () => {
  test("a bundle read over the API imports with the kept docs and their verdicts", async () => {
    const root = await mkdtemp(join(tmpdir(), "bundle-api-"));
    const listings: Record<string, ApiKnowledgeDoc[]> = {
      alpha: [
        apiDoc({ slug: "arch", title: "Architecture", verdict: "clean", related: ["beta/notes"] }),
        apiDoc({ slug: "leaky", body: "token ghp_abcdefghijklmnopqrstuvwxyz0123456789 here" }),
        apiDoc({ slug: "old", verdict: "superseded" }),
        apiDoc({ slug: "Bad Slug" }),
      ],
      beta: [
        apiDoc({ slug: "notes", verdict: "disputed", disputes: [{ claim: "c", finding: "f", evidence: "e" }] }),
        apiDoc({ slug: "persona-prefs" }),
      ],
    };
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === "/api/projects") return Response.json(Object.keys(listings).map((id) => ({ id })));
        const m = path.match(/^\/api\/projects\/([^/]+)\/knowledge$/);
        if (m) return Response.json(listings[decodeURIComponent(m[1]!)] ?? []);
        return new Response("not found", { status: 404 });
      },
    });
    try {
      const { source, report } = apiBundleSource({ collectorUrl: `http://127.0.0.1:${server.port}` });
      const bundleDir = join(root, "bundle");
      const manifest = await exportKnowledgeBundle({ source, outDir: bundleDir, exportedAt: "2026-10-21T00:00:00.000Z" });

      expect(manifest.counts.docs).toBe(3);
      expect(manifest.counts.docVerdicts).toBe(2);
      expect(manifest.counts.chunks).toBe(0);
      expect(report.excluded.map((e) => `${e.projectId}/${e.slug}:${e.reason}`).sort()).toEqual([
        "alpha/Bad Slug:slug is not a writable file name",
        "alpha/old:superseded",
        "beta/persona-prefs:persona doc",
      ]);
      expect(report.redacted.map((r) => r.slug)).toEqual(["leaky"]);
      const leaky = await readFile(join(bundleDir, "knowledge", "alpha", "leaky.md"), "utf-8");
      expect(leaky).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
      expect(leaky).toContain("[REDACTED]");

      const dbPath = join(root, "target", "standup.db");
      const knowledgeDir = join(root, "target", "knowledge");
      const result = await importKnowledgeBundle({ bundleDir, knowledgeDir, dbPath });
      expect(result.docs).toBe(3);
      expect(result.docVerdicts).toBe(2);

      const store = createStore(dbPath);
      try {
        const ks = new KnowledgeStore(store.db);
        expect(ks.getDoc("alpha", "arch")?.title).toBe("Architecture");
        expect(ks.getDoc("alpha", "arch")?.verdict).toBe("clean");
        expect(ks.getDoc("beta", "notes")?.verdict).toBe("disputed");
        expect(ks.getDoc("alpha", "old")).toBeNull();
      } finally {
        store.close();
      }
    } finally {
      server.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  });
});
