import { expect, test, describe } from "bun:test";
import {
  DOC_SCOPES,
  DOC_SCOPE_LABELS,
  PROJECT_SCOPES,
  PROJECT_SCOPE_LABELS,
  docScopeValue,
  projectScopeValue,
  buildDocSavePayload,
} from "./knowledgeScope";

/**
 * The scope control's pure logic — the option sets the DocEditor / project
 * control render, the initial value they show for a doc/project, and the payload
 * they submit. The web package has no component-test harness, so these pin the
 * control's contract at the logic level: it offers the three doc scopes (two for
 * a project default), reflects the current scope, and submits the chosen one.
 */

describe("scope option sets", () => {
  test("the per-doc control offers exactly global/project/user, each labeled", () => {
    expect([...DOC_SCOPES].sort()).toEqual(["global", "project", "user"]);
    for (const s of DOC_SCOPES) expect(DOC_SCOPE_LABELS[s]).toBeTruthy();
  });

  test("the project default offers only global/project — 'user' is per-doc, never a default", () => {
    expect([...PROJECT_SCOPES].sort()).toEqual(["global", "project"]);
    for (const s of PROJECT_SCOPES) expect(PROJECT_SCOPE_LABELS[s]).toBeTruthy();
    // The 'user' scope must not be a project-level default.
    expect((PROJECT_SCOPES as string[]).includes("user")).toBe(false);
  });
});

describe("displayed value reflects the current scope", () => {
  test("a doc with a scope shows it; an unscoped doc shows 'project'", () => {
    expect(docScopeValue("global")).toBe("global");
    expect(docScopeValue("user")).toBe("user");
    expect(docScopeValue(undefined)).toBe("project");
  });

  test("a project override shows; no override shows 'project'", () => {
    expect(projectScopeValue("global")).toBe("global");
    expect(projectScopeValue(undefined)).toBe("project");
  });
});

describe("buildDocSavePayload submits the chosen scope", () => {
  test("carries the chosen scope and splits tags; never sends an owner", () => {
    const payload = buildDocSavePayload({
      title: "Conventions",
      body: "the body",
      tags: "conventions, gotchas ,  ",
      sourceKind: "code",
      scope: "global",
    });
    expect(payload.scope).toBe("global");
    expect(payload.title).toBe("Conventions");
    expect(payload.source_kind).toBe("code");
    // Blank/whitespace tag entries are dropped.
    expect(payload.tags).toEqual(["conventions", "gotchas"]);
    // Owner is resolved server-side — the client never sends one.
    expect("owner" in payload).toBe(false);
    expect("owner_user" in payload).toBe(false);
  });

  test("a 'user' scope is submitted as chosen (owner still left to the server)", () => {
    const payload = buildDocSavePayload({
      title: "My note",
      body: "b",
      tags: "",
      sourceKind: "decision",
      scope: "user",
    });
    expect(payload.scope).toBe("user");
    expect(payload.tags).toEqual([]);
  });

  test("omits scope entirely when none is passed (an unchanged control on a body edit)", () => {
    const payload = buildDocSavePayload({
      title: "Conventions",
      body: "just a typo fix",
      tags: "conventions",
      sourceKind: "code",
    });
    // The key is absent — not present-and-undefined — so the server takes its
    // preserve branch rather than re-deriving the doc's scope/owner. This is the
    // real body-edit path: the editor sends scope only when the user moved the
    // control.
    expect("scope" in payload).toBe(false);
    expect(payload.title).toBe("Conventions");
    expect(payload.tags).toEqual(["conventions"]);
  });
});
