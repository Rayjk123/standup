import { expect, test, describe } from "bun:test";
import {
  OPEN_DOC_PARAM,
  findDocBySlug,
  withOpenDoc,
  withoutOpenDoc,
  isSelectableProject,
  scopeSelectValue,
  cardOpensOnEnter,
  docDetailUrl,
  stopCardOpenPropagation,
  knowledgeTabFor,
} from "./knowledgeInspect";

describe("knowledgeTabFor", () => {
  test("lands on the Graph by default", () => {
    expect(knowledgeTabFor(new URLSearchParams(""))).toBe("graph");
    expect(knowledgeTabFor(new URLSearchParams("project=p1"))).toBe("graph");
  });

  test("a doc deep link with no tab opens Browse, where the doc renders", () => {
    expect(knowledgeTabFor(new URLSearchParams(`project=p1&${OPEN_DOC_PARAM}=auth-flow`))).toBe("browse");
  });

  test("an explicit tab wins; an unknown one falls back", () => {
    expect(knowledgeTabFor(new URLSearchParams("tab=health"))).toBe("health");
    expect(knowledgeTabFor(new URLSearchParams(`tab=graph&${OPEN_DOC_PARAM}=x`))).toBe("graph");
    expect(knowledgeTabFor(new URLSearchParams("tab=bogus"))).toBe("graph");
  });
});

/**
 * The pure logic behind clicking a Browse search-result card to open its doc's
 * detail. The web package has no component-test harness, so these pin the
 * contract at the logic level: a clicked result resolves to the right doc (the
 * one the DocEditor detail then renders), and a cross-project result carries an
 * "open" intent for the right project + slug through the URL.
 */

interface Doc {
  id: string;
  slug: string;
  title: string;
}

const docs: Doc[] = [
  { id: "p1:auth-flow", slug: "auth-flow", title: "Auth flow" },
  { id: "p1:db-schema", slug: "db-schema", title: "DB schema" },
];

describe("findDocBySlug", () => {
  test("resolves a clicked result to the doc with the matching slug", () => {
    const doc = findDocBySlug(docs, "db-schema");
    // The resolved doc IS what the detail view renders — its id/title/fields.
    expect(doc?.id).toBe("p1:db-schema");
    expect(doc?.title).toBe("DB schema");
  });

  test("a slug not in the loaded list resolves to nothing (caller no-ops)", () => {
    expect(findDocBySlug(docs, "not-here")).toBeUndefined();
  });

  test("an absent slug resolves to nothing", () => {
    expect(findDocBySlug(docs, undefined)).toBeUndefined();
    expect(findDocBySlug(docs, null)).toBeUndefined();
    expect(findDocBySlug(docs, "")).toBeUndefined();
  });
});

describe("withOpenDoc", () => {
  test("targets the result's own project and slug", () => {
    const next = withOpenDoc(new URLSearchParams(), "p2", "slack-adapter");
    // The detail opens over the RIGHT doc: the result's own project, its slug.
    expect(next.get("project")).toBe("p2");
    expect(next.get(OPEN_DOC_PARAM)).toBe("slack-adapter");
  });

  test("re-scopes to the result's project rather than keeping the current one", () => {
    // Under an "All projects" browse the current scope has no project; a result
    // in p2 must scope to p2, not the doc's slug in whatever was scoped before.
    const next = withOpenDoc(new URLSearchParams("project=p1&tab=browse"), "p2", "auth-flow");
    expect(next.get("project")).toBe("p2");
    expect(next.get(OPEN_DOC_PARAM)).toBe("auth-flow");
    // Sibling params (the sub-tab) are preserved.
    expect(next.get("tab")).toBe("browse");
  });

  test("does not mutate the input params", () => {
    const params = new URLSearchParams("tab=browse");
    withOpenDoc(params, "p2", "x");
    expect(params.has(OPEN_DOC_PARAM)).toBe(false);
    expect(params.has("project")).toBe(false);
  });
});

describe("withoutOpenDoc", () => {
  test("clears the open intent but preserves scope and tab", () => {
    const next = withoutOpenDoc(new URLSearchParams("project=p2&tab=browse&doc=auth-flow"));
    expect(next.has(OPEN_DOC_PARAM)).toBe(false);
    expect(next.get("project")).toBe("p2");
    expect(next.get("tab")).toBe("browse");
  });

  test("does not mutate the input params", () => {
    const params = new URLSearchParams("doc=auth-flow");
    withoutOpenDoc(params);
    expect(params.get(OPEN_DOC_PARAM)).toBe("auth-flow");
  });
});

/**
 * A cross-project ("all" corpus) search returns results whose projectId is NOT
 * necessarily a listed project. Re-scoping Browse to such an id is the bug the
 * next two blocks guard: a since-deleted project's leftover docs, and the
 * reserved 'global'/'scratch' corpora, carry ids with no scope <option>. They
 * must not re-scope (they open in a standalone read-only detail instead), and
 * the scope selector must not blank when it somehow points at one.
 */
const projectList = [
  { id: "p1", name: "Alpha" },
  { id: "p2", name: "Beta" },
];

describe("isSelectableProject", () => {
  test("a listed project is selectable — its click re-scopes Browse", () => {
    expect(isSelectableProject(projectList, "p1")).toBe(true);
  });

  test("a since-deleted project's leftover doc is NOT selectable", () => {
    // deleteProject drops the projects row but leaves the doc in the corpus, so
    // it still surfaces carrying the deleted id — which is no longer listed.
    expect(isSelectableProject(projectList, "deleted-proj")).toBe(false);
  });

  test("the reserved global and scratch corpora are NOT selectable", () => {
    expect(isSelectableProject(projectList, "global")).toBe(false);
    expect(isSelectableProject(projectList, "scratch")).toBe(false);
  });

  test("an absent projectId is not selectable", () => {
    expect(isSelectableProject(projectList, "")).toBe(false);
    expect(isSelectableProject(projectList, null)).toBe(false);
    expect(isSelectableProject(projectList, undefined)).toBe(false);
  });
});

describe("scopeSelectValue", () => {
  test("a listed scope is shown as itself", () => {
    expect(scopeSelectValue(projectList, "p2")).toBe("p2");
  });

  test("the empty (all-projects) scope stays empty", () => {
    expect(scopeSelectValue(projectList, "")).toBe("");
  });

  test("a scope with no matching option falls back to all-projects, not blank", () => {
    // A stale ?project= from a deleted project (or a hand-edited URL) would
    // otherwise blank the controlled select; normalize it to "All projects",
    // which is the surface BrowseTab renders for an unresolvable scope anyway.
    expect(scopeSelectValue(projectList, "deleted-proj")).toBe("");
    expect(scopeSelectValue(projectList, "global")).toBe("");
  });
});

describe("cardOpensOnEnter", () => {
  test("Enter on the card itself opens it", () => {
    expect(cardOpensOnEnter("Enter", true)).toBe(true);
  });

  test("Enter forwarded from a nested control does NOT open the card", () => {
    // The 'related ↔' toggle / Regenerate button live inside the card; an Enter
    // keydown bubbles up even though the click's stopPropagation doesn't, so the
    // card must ignore it or activating the nested control also opens the editor.
    expect(cardOpensOnEnter("Enter", false)).toBe(false);
  });

  test("keys other than Enter never open the card", () => {
    expect(cardOpensOnEnter(" ", true)).toBe(false);
    expect(cardOpensOnEnter("Tab", true)).toBe(false);
    expect(cardOpensOnEnter("a", true)).toBe(false);
  });
});

/**
 * A cross-project result homed in a project the scope selector can't list (a
 * since-deleted project, or the reserved 'global'/'scratch' corpus) opens in a
 * standalone read-only detail fetched by (projectId, slug) — the SAME by-id
 * read the graph's node detail uses, independent of the projects list. This
 * pins the exact endpoint that detail requests.
 */
describe("docDetailUrl", () => {
  test("addresses a doc by its own project + slug", () => {
    expect(docDetailUrl("p1", "auth-flow")).toBe("/api/projects/p1/knowledge/auth-flow");
  });

  test("opens a doc homed in the reserved global corpus by id, not by scope", () => {
    // corpus:'all' returns 'global'-homed docs; clicking one must fetch its own
    // project id ('global'), not re-scope Browse to a non-existent option.
    expect(docDetailUrl("global", "team-conventions")).toBe(
      "/api/projects/global/knowledge/team-conventions"
    );
  });

  test("URL-encodes a project id or slug with reserved characters", () => {
    // A since-deleted project id or a slug can carry characters that would
    // otherwise break the path (a slash, a space); both are encoded.
    expect(docDetailUrl("scratch/tmp", "a b")).toBe(
      "/api/projects/scratch%2Ftmp/knowledge/a%20b"
    );
  });
});

/**
 * The expanded "related" neighbors panel sits inside a result card whose click
 * opens the card's doc. Exploring related docs must not also open the parent
 * card. Since the card opens on a click anywhere on itself, the panel stops the
 * event at its own boundary; this simulates DOM bubbling to prove the card's
 * open handler never runs for an interaction that originated inside the panel.
 */
describe("stopCardOpenPropagation (FIX 3 — neighbors panel containment)", () => {
  // Model bubbling: an event fired on a descendant runs each ancestor handler
  // inner→outer until one stops propagation. The neighbors panel guard is the
  // inner handler; the card's open handler is the outer one.
  function bubble(handlers: Array<(e: { stopPropagation: () => void }) => void>): {
    stopped: boolean;
  } {
    let stopped = false;
    const e = {
      stopPropagation: () => {
        stopped = true;
      },
    };
    for (const h of handlers) {
      if (stopped) break;
      h(e);
    }
    return { stopped };
  }

  test("a click/keydown inside the neighbors panel never reaches the card's open handler", () => {
    let cardOpened = false;
    const cardOpen = () => {
      cardOpened = true;
    };
    // Inner: the panel guard; outer: the card's open handler.
    const { stopped } = bubble([stopCardOpenPropagation, cardOpen]);
    expect(stopped).toBe(true);
    expect(cardOpened).toBe(false);
  });

  test("a click directly on the card (no inner guard) still opens it", () => {
    // Regression: containment must only affect the panel — a bare card click,
    // with no panel guard in the path, still opens the doc.
    let cardOpened = false;
    const cardOpen = () => {
      cardOpened = true;
    };
    const { stopped } = bubble([cardOpen]);
    expect(stopped).toBe(false);
    expect(cardOpened).toBe(true);
  });
});
