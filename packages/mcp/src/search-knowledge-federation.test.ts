import { describe, expect, test } from "bun:test";
import { formatSearchResults, type FederatedSearchEntry, type SearchToolHit } from "./tools.js";

/** How search_knowledge renders external retrievers' hits fused into a search reply. */

const hit = (id: string, slug: string): SearchToolHit => ({
  id,
  projectId: "alpha",
  slug,
  title: slug,
  excerpt: `${slug} excerpt`,
  score: 0.8,
  source: "text",
});

const external = (title: string): Extract<FederatedSearchEntry, { kind: "external" }> => ({
  kind: "external",
  retriever: "mc",
  label: "Mindcraft",
  title,
  ref: `mc://${title}`,
  excerpt: `${title} excerpt`,
});

describe("search_knowledge output — external hits", () => {
  test("external hits ride in their fused rank, each labeled with its source", () => {
    const text = formatSearchResults("q", {
      project: "alpha",
      results: [hit("a", "first-doc"), hit("b", "second-doc")],
      federated: [{ kind: "local", id: "a" }, external("svc-overview"), { kind: "local", id: "b" }],
    });
    const first = text.indexOf("[first-doc]");
    const ext = text.indexOf("[external: Mindcraft] svc-overview (mc://svc-overview)");
    const second = text.indexOf("[second-doc]");
    expect(first).toBeGreaterThanOrEqual(0);
    expect(ext).toBeGreaterThan(first);
    expect(second).toBeGreaterThan(ext);
    expect(text).toContain("not Standup knowledge");
  });

  test("a local result missing from the fused ranking is still listed", () => {
    const text = formatSearchResults("q", {
      project: "alpha",
      results: [hit("a", "first-doc"), hit("b", "second-doc")],
      federated: [{ kind: "local", id: "a" }, external("svc-overview")],
    });
    expect(text).toContain("[second-doc]");
  });

  test("with no confident local match, external hits follow the no-match answer", () => {
    const text = formatSearchResults("q", {
      project: "alpha",
      results: [],
      corpus: "all",
      federated: [external("svc-overview")],
    });
    expect(text.split("\n")[0]).toStartWith(`No confident match for "q"`);
    expect(text).toContain("──── external sources (not Standup knowledge) ────");
    expect(text).toContain("[external: Mindcraft] svc-overview");
  });

  test("a reply without federation renders as before", () => {
    const plain = { project: "alpha", results: [hit("a", "first-doc")] };
    expect(formatSearchResults("q", { ...plain, federated: [{ kind: "local", id: "a" }] })).toBe(
      formatSearchResults("q", plain)
    );
    expect(formatSearchResults("q", plain)).not.toContain("external");
  });
});
