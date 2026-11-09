import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { GLOBAL_PROJECT_ID } from "@standup/shared";
import { KnowledgeStore } from "./store.js";
import {
  WITHHELD_TITLE,
  loadPersonalFingerprint,
  personalFingerprint,
  withholdPersonalContent,
  withholdPersonalDraft,
} from "./personal-withhold.js";
import type { KnowledgeDoc } from "./types.js";

function doc(overrides: Partial<KnowledgeDoc>): KnowledgeDoc {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    projectId: "alpha",
    slug: "doc",
    title: "Doc",
    body: "body",
    updatedAt: new Date("2026-08-16T00:00:00Z"),
    filePath: "/x/doc.md",
    originClass: "owner",
    ...overrides,
  };
}

const HOME_CLAUDE_MD = [
  "# Personal notes",
  "",
  "## Writing style",
  "",
  "- **Prefer early returns** — never nest more than two conditionals in one handler.",
  "- I keep a scratch sandbox on my laptop and wipe it clean every Monday morning.",
].join("\n");
const PERSONA_MEMORY = "Alice prefers to review pull requests before lunch. She is out every second Friday for a standing medical appointment.";
const TEAM_RUNBOOK = "Restart the ingest worker after rotating the queue credentials.";

/** A DB holding a home CLAUDE.md mirror, a Persona memory and a team runbook. */
function seeded(): Database {
  const db = new Database(":memory:");
  const store = new KnowledgeStore(db);
  store.upsertDoc(
    doc({ id: "home", projectId: GLOBAL_PROJECT_ID, slug: "native-mem-home-claude-md", sourceKind: "native-memory", scope: "global", body: HOME_CLAUDE_MD })
  );
  store.upsertDoc(
    doc({ id: "memory", projectId: GLOBAL_PROJECT_ID, slug: "persona-alice-schedule", scope: "user", ownerUser: "alice", body: PERSONA_MEMORY })
  );
  store.upsertDoc(doc({ id: "team", slug: "deploy", scope: "project", sourceKind: "runbook", body: TEAM_RUNBOOK }));
  return db;
}

describe("withholdPersonalContent — a distilled draft never carries the personal layer into a shared doc", () => {
  test("lines reproducing a home-mirror rule or a Persona memory are withheld; the session's own findings stay", () => {
    const db = seeded();
    const fingerprint = loadPersonalFingerprint(db);
    // A draft written from a transcript that quoted the injected brief and a search result for the owner's memories.
    const draft = [
      "## Fixing the flaky sync test",
      "",
      "The sync test raced the watcher; awaiting the first scan fixed it.",
      "* Prefer early returns — never nest more than two conditionals in one handler.",
      "> She is out every second Friday for a standing medical appointment.",
      "",
      "Re-run with `bun test packages/knowledge` to confirm.",
    ].join("\n");
    const out = withholdPersonalContent(draft, fingerprint);
    expect(out.withheld).toBe(2);
    expect(out.text).not.toContain("two conditionals");
    expect(out.text).not.toContain("medical appointment");
    expect(out.text).toContain("awaiting the first scan fixed it");
    expect(out.text).toContain("Re-run with");
    db.close();
  });

  test("team docs are not part of the fingerprint, and short or generic lines never withhold", () => {
    const db = seeded();
    const fingerprint = loadPersonalFingerprint(db);
    const draft = `## Writing style\n\n${TEAM_RUNBOOK}\n# Personal notes`;
    expect(withholdPersonalContent(draft, fingerprint)).toEqual({ text: draft, withheld: 0 });
    db.close();
  });

  test("text with nothing personal comes back byte-identical, as it does with an empty fingerprint", () => {
    const text = "line one\r\n\n\n\nline two with trailing space \n";
    expect(withholdPersonalContent(text, personalFingerprint([PERSONA_MEMORY]))).toEqual({ text, withheld: 0 });
    expect(withholdPersonalContent(PERSONA_MEMORY, personalFingerprint([]))).toEqual({ text: PERSONA_MEMORY, withheld: 0 });
  });

  test("a personal sentence a shared doc also states is team knowledge and stays", () => {
    const db = seeded();
    const shared = "Note: regenerate the fixture snapshots before committing any schema change.";
    const store = new KnowledgeStore(db);
    store.upsertDoc(
      doc({ id: "rules", projectId: GLOBAL_PROJECT_ID, slug: "native-mem-home-rules-build", sourceKind: "native-memory", body: shared })
    );
    store.upsertDoc(doc({ id: "team-build", slug: "build", scope: "project", sourceKind: "runbook", body: shared }));
    expect(withholdPersonalContent(shared, loadPersonalFingerprint(db))).toEqual({ text: shared, withheld: 0 });
    db.close();
  });

  test("a personal sentence re-wrapped across two lines is withheld, and a personal title becomes a neutral one", () => {
    const db = seeded();
    const fingerprint = loadPersonalFingerprint(db);
    const wrapped = "Finding.\nAlice prefers to review pull requests\nbefore lunch.\nNext step.";
    expect(withholdPersonalContent(wrapped, fingerprint)).toEqual({ text: "Finding.\nNext step.", withheld: 2 });
    const titled = { slug: "alice-prefers", title: "Alice prefers to review pull requests before lunch.", body: "ok" };
    expect(withholdPersonalDraft(titled, fingerprint).title).toBe(WITHHELD_TITLE);
    const own = { slug: "s", title: PERSONA_MEMORY, body: PERSONA_MEMORY, scope: "user" };
    expect(withholdPersonalDraft(own, fingerprint)).toBe(own);
    db.close();
  });

  test("another user's personal docs are withheld too: the fingerprint covers every owner", () => {
    const db = seeded();
    new KnowledgeStore(db).upsertDoc(
      doc({ id: "bob", slug: "bob-note", scope: "user", ownerUser: "bob", body: "Bob keeps his on-call handoff notes in a private spreadsheet." })
    );
    const out = withholdPersonalContent("Bob keeps his on-call handoff notes in a private spreadsheet.", loadPersonalFingerprint(db));
    expect(out).toEqual({ text: "", withheld: 1 });
    db.close();
  });
});
