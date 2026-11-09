import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SHARE_TOKEN } from "@standup/shared";
import { allMigrations, ensureDocsAndShareGrants, runMigrations } from "../migrations.js";
import { createStore } from "../store.js";
import { createReviewPacket, getReviewShare, getSharedReviewPacket, submitReviewPacket } from "./review-packets.js";
import { findLiveGrantByToken, getLiveGrant, revokeGrantsFor, setShare, shareTokenDigest } from "./share-grants.js";

const draft = {
  title: "t",
  intent: "i",
  changes: [],
  validation: { samples: [] },
  risks: { risks: [], questions: [] },
  links: [],
};

describe("share grants", () => {
  test("on mints a live grant; on again rotates it; off revokes it", () => {
    const { db } = createStore(":memory:");
    const first = setShare(db, "doc", "d1", "alice", true)!;
    expect(first.token).toMatch(SHARE_TOKEN);
    expect(findLiveGrantByToken(db, "doc", first.token)?.resourceId).toBe("d1");
    const second = setShare(db, "doc", "d1", "alice", true)!;
    expect(second.token).not.toBe(first.token);
    expect(findLiveGrantByToken(db, "doc", first.token)).toBeNull();
    expect(getLiveGrant(db, "doc", "d1", "alice")?.token).toBe(second.token);
    expect(setShare(db, "doc", "d1", "alice", false)).toBeNull();
    expect(getLiveGrant(db, "doc", "d1", "alice")).toBeNull();
    expect(findLiveGrantByToken(db, "doc", second.token)).toBeNull();
  });

  test("a token is looked up within its own type, and a grant is read only by its owner", () => {
    const { db } = createStore(":memory:");
    const g = setShare(db, "doc", "d1", "alice", true)!;
    expect(findLiveGrantByToken(db, "review", g.token)).toBeNull();
    expect(getLiveGrant(db, "doc", "d1", "bob")).toBeNull();
  });

  test("at most one live grant per resource", () => {
    const { db } = createStore(":memory:");
    setShare(db, "doc", "d1", "alice", true);
    expect(() =>
      db.run(
        `INSERT INTO share_grants (id, resource_type, resource_id, owner, token, token_sha256, created_at)
         VALUES ('x', 'doc', 'd1', 'alice', 't', 'h', 'now')`
      )
    ).toThrow();
    expect(() =>
      db.run(
        `INSERT INTO share_grants (id, resource_type, resource_id, owner, token, token_sha256, created_at)
         VALUES ('y', 'project', 'd2', 'alice', 't2', 'h2', 'now')`
      )
    ).toThrow();
  });

  test("revokeGrantsFor revokes only the named resources' grants", () => {
    const { db } = createStore(":memory:");
    const a = setShare(db, "doc", "a", "alice", true)!;
    const b = setShare(db, "doc", "b", "alice", true)!;
    const r = setShare(db, "review", "a", "alice", true)!;
    expect(revokeGrantsFor(db, "doc", ["a", "zzz"])).toBe(1);
    expect(findLiveGrantByToken(db, "doc", a.token)).toBeNull();
    expect(findLiveGrantByToken(db, "doc", b.token)).not.toBeNull();
    expect(findLiveGrantByToken(db, "review", r.token)).not.toBeNull();
    expect(revokeGrantsFor(db, "doc", [])).toBe(0);
  });
});

describe("migration 080", () => {
  test("a review shared before the grants keeps its link: same token, same digest; the columns are cleared", () => {
    const db = new Database(":memory:");
    runMigrations(db, allMigrations().filter((m) => m.version <= 79));
    const p = createReviewPacket(db, { owner: "alice", launchId: "L" });
    submitReviewPacket(db, { id: p.id, owner: "alice", draft });
    const off = createReviewPacket(db, { owner: "alice", launchId: "M" });
    submitReviewPacket(db, { id: off.id, owner: "alice", draft });
    const token = "A".repeat(20) + "b".repeat(23);
    db.run("UPDATE review_packets SET share_enabled = 1, share_token = ?, share_token_sha256 = ? WHERE id = ?", [token, shareTokenDigest(token), p.id]);
    // A stale token left with sharing off is not carried over.
    db.run("UPDATE review_packets SET share_enabled = 0, share_token = ? WHERE id = ?", ["C".repeat(43), off.id]);

    runMigrations(db);
    expect(db.query("SELECT version FROM schema_version WHERE version = 80").get()).toEqual({ version: 80 });
    expect(getSharedReviewPacket(db, token)?.id).toBe(p.id);
    expect(getReviewShare(db, p.id, "alice")).toEqual({ enabled: true, token });
    expect(getReviewShare(db, off.id, "alice")).toEqual({ enabled: false, token: null });
    expect(getSharedReviewPacket(db, "C".repeat(43))).toBeNull();
    const row = db.query("SELECT token_sha256 FROM share_grants WHERE resource_id = ?").get(p.id);
    expect(row).toEqual({ token_sha256: shareTokenDigest(token) });
    expect(db.query("SELECT COUNT(*) AS n FROM review_packets WHERE share_enabled != 0 OR share_token IS NOT NULL").get()).toEqual({ n: 0 });

    // Running it again changes nothing and duplicates nothing.
    ensureDocsAndShareGrants(db);
    runMigrations(db);
    expect(db.query("SELECT COUNT(*) AS n FROM share_grants").get()).toEqual({ n: 1 });
    expect(getSharedReviewPacket(db, token)?.id).toBe(p.id);
  });

  test("creates the doc tables, idempotently", () => {
    const { db } = createStore(":memory:");
    ensureDocsAndShareGrants(db);
    for (const table of ["share_grants", "doc_folders", "docs", "doc_assets"]) {
      expect((db.query(`PRAGMA table_info(${table})`).all() as unknown[]).length).toBeGreaterThan(0);
    }
  });
});
