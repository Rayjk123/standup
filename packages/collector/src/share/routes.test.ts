import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  attachSessionToLaunch,
  createLaunch,
  createReviewPacket,
  createSession,
  createStore,
  runMigrations,
  setLaunchReviewTokenHash,
  upsertProject,
} from "@standup/store";
import type { ReviewPacketDetail, ReviewPacketDraft, ReviewShareState, SharedReviewPacket } from "@standup/shared";
import { DEFAULT_IDENTITY_HEADER, REVIEW_SHARE_TOKEN, WORKER_TOKEN_HEADER } from "@standup/shared";
import { OWNER_TOKEN_HEADER, USER_CHANNEL_HEADER, userChannelToken } from "@standup/shared/owner-token";
import { workerTokenHash } from "../floor/gate.js";
import { generateOwnerSecrets } from "../owner-secret.js";
import { PERSONA_TOKEN_HEADER } from "../persona/routes.js";
import { reviewScratchDir } from "../review/media.js";
import type { GitRunner } from "../review/stage.js";
import { createServer } from "../server.js";

/*
 * A review packet shared by link: only its owner turns sharing on or off, the
 * link reads only the packet's display content and its own media, a bad or
 * revoked token is a bare 404, and the public path reaches no other route.
 */

const IDENTITY = DEFAULT_IDENTITY_HEADER;
const CHANGED = ["src/a.ts"];

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const fakeGit: GitRunner = (args) => {
  const cmd = args.join(" ");
  if (cmd === "rev-parse --abbrev-ref HEAD") return "feat";
  if (cmd === "rev-parse HEAD") return "h".repeat(40);
  if (cmd === "merge-base HEAD origin/main") return "b".repeat(40);
  if (cmd.startsWith("diff --name-only")) return CHANGED.join("\n");
  return null;
};

const draft = (title = "A shared change"): ReviewPacketDraft => ({
  title,
  intent: "show the reviewer",
  changes: [{ area: "X", bullets: ["y"], files: CHANGED, hunks: [{ file: "src/a.ts", header: "@@ -1 +1 @@", diff: "-a\n+b" }] }],
  validation: { samples: [{ label: "l", input: "i", output: "o" }], tests: { summary: "all green", passed: 3, failed: 0 } },
  risks: { risks: ["SECRET-RISK"], questions: ["SECRET-QUESTION"] },
  links: [{ kind: "other", label: "SECRET-LINK", url: "https://example.com/secret" }],
});

/** A PNG header followed by `n` bytes of `fill`. */
function png(n = 84, fill = 1): Uint8Array {
  const head = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52];
  return Uint8Array.from([...head, ...Array.from({ length: n }, () => fill)]);
}

function setUp() {
  const root = mkdtempSync(join(tmpdir(), "review-share-"));
  dirs.push(root);
  const dataDir = join(root, "data");
  const work = join(root, "work");
  for (const d of [dataDir, work]) mkdirSync(d, { recursive: true });
  const store = createStore(":memory:");
  const secrets = generateOwnerSecrets();
  const app = createServer(
    store, () => {}, null, undefined, undefined, "", "", {}, undefined, undefined, undefined, undefined,
    { ownerSecrets: secrets },
    {},
    {},
    {},
    { git: fakeGit, dataDir, mediaHome: root, mediaEnv: {} }
  );
  upsertProject(store.db, { id: "p", name: "P", branch: "main", repos: [] });

  let n = 0;
  /** A running launch of `owner`'s with a session and a review token. */
  const launch = (owner: string) => {
    n++;
    const id = `L${n}`;
    const sid = `S${n}`;
    const token = `tok-${n}-${"x".repeat(40)}`;
    createLaunch(store.db, { id, projectId: "p", task: "t", worktreePath: work, branch: "b", status: "running", launchedBy: owner });
    createSession(store.db, { id: sid, projectId: "p", title: "t", cwd: work, status: "idle" });
    attachSessionToLaunch(store.db, id, sid);
    setLaunchReviewTokenHash(store.db, id, workerTokenHash(token));
    return { id, sid, token };
  };

  /** Submits a pending packet for a fresh launch of `owner`'s, with `shots` images; returns its id. */
  const submit = (owner: string, shots: number[] = [], title?: string) => submitAs(launch(owner), shots, title);

  /** Submits (or resubmits) a packet for launch `l`, re-arming its review token first; returns the packet id. */
  const submitAs = async (l: { id: string; sid: string; token: string }, shots: number[] = [], title?: string) => {
    setLaunchReviewTokenHash(store.db, l.id, workerTokenHash(l.token));
    const scratch = reviewScratchDir(dataDir, l.id);
    mkdirSync(scratch, { recursive: true });
    const media = shots.map((fill, i) => {
      const path = join(scratch, `shot-${i}.png`);
      writeFileSync(path, png(84, fill));
      return { path, caption: `shot ${i}` };
    });
    const res = await app.request("/api/reviews/submit", {
      method: "POST",
      headers: { "content-type": "application/json", [WORKER_TOKEN_HEADER]: l.token },
      body: JSON.stringify({ session_id: l.sid, packet: draft(title), media }),
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { packetId: string }).packetId;
  };

  const as = (alias: string): Record<string, string> => ({
    [IDENTITY]: alias,
    [USER_CHANNEL_HEADER]: userChannelToken(secrets.ownerToken, alias),
  });
  const owner = (alias: string): Record<string, string> => ({ [IDENTITY]: alias, [OWNER_TOKEN_HEADER]: secrets.ownerToken });

  const toggle = (id: string, enabled: unknown, headers: Record<string, string>) =>
    app.request(`/api/reviews/${id}/share`, {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "same-origin", ...headers },
      body: JSON.stringify({ enabled }),
    });
  /** Turns sharing on as `alias` and returns the share token. */
  const shareOn = async (id: string, alias = "alice") => {
    const res = await toggle(id, true, as(alias));
    expect(res.status).toBe(200);
    const { share } = (await res.json()) as { share: ReviewShareState };
    expect(share.enabled).toBe(true);
    const token = share.path!.replace("/share/review/", "");
    expect(token).toMatch(REVIEW_SHARE_TOKEN);
    return token;
  };
  /** An unauthenticated request: no identity, no channel token. */
  const anon = (path: string, init: RequestInit = {}) => app.request(path, init);
  return { store, app, dataDir, secrets, launch, submit, submitAs, as, owner, toggle, shareOn, anon };
}

describe("the generic share routes for a review", () => {
  test("GET and PUT /api/shares/review/:id read and toggle the same share as the Review tab's route", async () => {
    const h = setUp();
    const id = await h.submit("alice");
    const read = (headers: Record<string, string>) => h.app.request(`/api/shares/review/${id}`, { headers });
    expect(await (await read(h.as("alice"))).json()).toEqual({ share: { enabled: false, path: null } });
    const put = await h.app.request(`/api/shares/review/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...h.as("alice") },
      body: JSON.stringify({ enabled: true }),
    });
    expect(put.status).toBe(200);
    const { share } = (await put.json()) as { share: ReviewShareState };
    expect(await (await read(h.as("alice"))).json()).toEqual({ share });
    const token = share.path!.replace("/share/review/", "");
    expect((await h.anon(`/api/share/reviews/${token}`)).status).toBe(200);
    expect((await h.anon(`/api/share/reviews/${token}`, { method: "HEAD" })).status).toBe(200);
    // A review token is not a doc token.
    expect((await h.anon(`/api/share/docs/${token}`)).status).toBe(404);
    expect((await read(h.as("bob"))).status).toBe(404);
    expect((await read({ ...h.as("alice"), [PERSONA_TOKEN_HEADER]: "x" })).status).toBe(403);
    expect((await read({})).status).toBe(403);
    expect((await h.app.request(`/api/shares/folder/${id}`, { headers: h.as("alice") })).status).toBe(404);
  });

  test("an unknown segment is the same bare 404", async () => {
    const h = setUp();
    const id = await h.submit("alice");
    const token = await h.shareOn(id);
    for (const segment of ["review", "packets", "doc", "REVIEWS"]) {
      const res = await h.anon(`/api/share/${segment}/${token}`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Not found" });
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });

  test("the launch's next submission through the worker route supersedes the packet and revokes its link", async () => {
    const h = setUp();
    const l = h.launch("alice");
    const id = await h.submitAs(l, [1]);
    const token = await h.shareOn(id);
    expect((await h.anon(`/api/share/reviews/${token}`)).status).toBe(200);
    const next = await h.submitAs(l, [2], "revised");
    expect(next).not.toBe(id);
    expect((await h.anon(`/api/share/reviews/${token}`)).status).toBe(404);
    const detail = (await (await h.app.request(`/api/reviews/${id}`, { headers: h.as("alice") })).json()) as { review: ReviewPacketDetail };
    expect(detail.review.status).toBe("superseded");
    expect(detail.review.share).toEqual({ enabled: false, path: null });
    expect((await h.toggle(id, true, h.as("alice"))).status).toBe(409);
  });

  test("a link shared before share grants existed keeps working after the migration", async () => {
    const h = setUp();
    const id = await h.submit("alice", [3]);
    const token = "Q".repeat(43);
    h.store.db.run("UPDATE review_packets SET share_enabled = 1, share_token = ?, share_token_sha256 = 'legacy' WHERE id = ?", [token, id]);
    runMigrations(h.store.db);
    const res = await h.anon(`/api/share/reviews/${token}`);
    expect(res.status).toBe(200);
    const review = ((await res.json()) as { review: SharedReviewPacket }).review;
    expect((await h.anon(review.media[0]!.url)).status).toBe(200);
    const detail = (await (await h.app.request(`/api/reviews/${id}`, { headers: h.as("alice") })).json()) as { review: ReviewPacketDetail };
    expect(detail.review.share).toEqual({ enabled: true, path: `/share/review/${token}` });
  });
});

describe("turning sharing on and off", () => {
  test("on shares the packet without auth; off revokes the link at once", async () => {
    const h = setUp();
    const id = await h.submit("alice");
    const token = await h.shareOn(id);
    const shared = await h.anon(`/api/share/reviews/${token}`);
    expect(shared.status).toBe(200);
    expect(((await shared.json()) as { review: SharedReviewPacket }).review.title).toBe("A shared change");

    const off = await h.toggle(id, false, h.as("alice"));
    expect(off.status).toBe(200);
    expect(await off.json()).toEqual({ share: { enabled: false, path: null } });
    expect((await h.anon(`/api/share/reviews/${token}`)).status).toBe(404);
  });

  test("each time sharing is turned back on it gets a new token, and the old link stays dead", async () => {
    const h = setUp();
    const id = await h.submit("alice");
    const first = await h.shareOn(id);
    await h.toggle(id, false, h.as("alice"));
    const second = await h.shareOn(id);
    expect(second).not.toBe(first);
    expect((await h.anon(`/api/share/reviews/${first}`)).status).toBe(404);
    expect((await h.anon(`/api/share/reviews/${second}`)).status).toBe(200);
    // Turning it on while already on rotates it too.
    const third = await h.shareOn(id);
    expect(third).not.toBe(second);
    expect((await h.anon(`/api/share/reviews/${second}`)).status).toBe(404);
    expect((await h.anon(`/api/share/reviews/${third}`)).status).toBe(200);
  });

  test("the owner's detail read shows the share state and link", async () => {
    const h = setUp();
    const id = await h.submit("alice");
    const before = (await (await h.app.request(`/api/reviews/${id}`, { headers: h.as("alice") })).json()) as { review: ReviewPacketDetail };
    expect(before.review.share).toEqual({ enabled: false, path: null });
    const token = await h.shareOn(id);
    const after = (await (await h.app.request(`/api/reviews/${id}`, { headers: h.as("alice") })).json()) as { review: ReviewPacketDetail };
    expect(after.review.share).toEqual({ enabled: true, path: `/share/review/${token}` });
  });

  test("a decided packet stays shareable, and its share survives the decision", async () => {
    const h = setUp();
    const id = await h.submit("alice");
    const token = await h.shareOn(id);
    const approve = await h.app.request(`/api/reviews/${id}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "same-origin", ...h.as("alice") },
      body: "{}",
    });
    expect(approve.status).toBe(200);
    expect((await h.anon(`/api/share/reviews/${token}`)).status).toBe(200);
  });

  test("a draft can't be shared", async () => {
    const h = setUp();
    const d = createReviewPacket(h.store.db, { owner: "alice" });
    expect((await h.toggle(d.id, true, h.as("alice"))).status).toBe(409);
  });

  test("enabled must be a boolean", async () => {
    const h = setUp();
    const id = await h.submit("alice");
    for (const v of ["true", 1, null, undefined]) expect((await h.toggle(id, v, h.as("alice"))).status).toBe(400);
  });
});

describe("only the owner can toggle sharing", () => {
  test("no identity, a bare identity header, or a forged channel token is refused", async () => {
    const h = setUp();
    const id = await h.submit("alice");
    expect((await h.toggle(id, true, {})).status).toBe(403);
    expect((await h.toggle(id, true, { [IDENTITY]: "alice" })).status).toBe(403);
    expect((await h.toggle(id, true, { [IDENTITY]: "alice", [USER_CHANNEL_HEADER]: "forged" })).status).toBe(403);
    expect((await h.toggle(id, true, { [IDENTITY]: "alice", [OWNER_TOKEN_HEADER]: "forged" })).status).toBe(403);
  });

  test("another user's toggle reads the packet as unknown", async () => {
    const h = setUp();
    const id = await h.submit("alice");
    expect((await h.toggle(id, true, h.as("bob"))).status).toBe(404);
    expect((await h.toggle(id, true, h.owner("bob"))).status).toBe(404);
    const detail = (await (await h.app.request(`/api/reviews/${id}`, { headers: h.as("alice") })).json()) as { review: ReviewPacketDetail };
    expect(detail.review.share?.enabled).toBe(false);
  });

  test("Persona's token can't toggle sharing", async () => {
    const h = setUp();
    const id = await h.submit("alice");
    expect((await h.toggle(id, true, { ...h.as("alice"), [PERSONA_TOKEN_HEADER]: "anything" })).status).toBe(403);
  });

  test("a form-shaped (cross-site capable) write is refused even with the owner's channel", async () => {
    const h = setUp();
    const id = await h.submit("alice");
    const res = await h.app.request(`/api/reviews/${id}/share`, {
      method: "POST",
      headers: { "content-type": "text/plain", ...h.as("alice") },
      body: JSON.stringify({ enabled: true }),
    });
    expect(res.status).toBe(403);
  });
});

describe("a bad or revoked token", () => {
  const NOT_FOUND = { error: "Not found" };

  test("every bad token gets the same bare 404, naming nothing", async () => {
    const h = setUp();
    const id = await h.submit("alice");
    const token = await h.shareOn(id);
    const wellFormedUnknown = "A".repeat(43);
    const bad = [
      wellFormedUnknown,
      token.slice(0, 42),
      `${token}A`,
      token.toLowerCase() === token ? token.toUpperCase() : token.toLowerCase(),
      id,
      encodeURIComponent(`${token}/`),
      "%00",
      "..",
    ];
    for (const t of bad) {
      const res = await h.anon(`/api/share/reviews/${t}`);
      expect(res.status).toBe(404);
      const body = await res.text();
      // A path the share route matches answers its own 404; one it doesn't (a dot
      // segment folded away) gets the router's, which names nothing either.
      if (res.headers.get("content-type")?.includes("json")) expect(JSON.parse(body)).toEqual(NOT_FOUND);
      expect(body).not.toContain(id);
      expect(body).not.toContain(token);
    }
  });

  test("a revoked token's packet read and its media are the same 404 as an unknown one", async () => {
    const h = setUp();
    const id = await h.submit("alice", [7]);
    const token = await h.shareOn(id);
    const shared = (await (await h.anon(`/api/share/reviews/${token}`)).json()) as { review: SharedReviewPacket };
    const mediaUrl = shared.review.media[0]!.url;
    expect((await h.anon(mediaUrl)).status).toBe(200);
    await h.toggle(id, false, h.as("alice"));
    for (const path of [`/api/share/reviews/${token}`, mediaUrl]) {
      const res = await h.anon(path);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual(NOT_FOUND);
    }
  });
});

describe("what a share link returns", () => {
  test("only the packet's display fields: title, intent, what changed, validation, media", async () => {
    const h = setUp();
    const id = await h.submit("alice", [3]);
    const token = await h.shareOn(id);
    const res = await h.anon(`/api/share/reviews/${token}`);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    const raw = await res.text();
    const body = JSON.parse(raw) as { review: Record<string, unknown> };
    expect(Object.keys(body)).toEqual(["review"]);
    expect(Object.keys(body.review).sort()).toEqual(["changes", "intent", "media", "title", "validation"]);
    const review = body.review as unknown as SharedReviewPacket;
    expect(review.changes).toEqual(draft().changes);
    expect(review.validation).toEqual(draft().validation);
    expect(review.media).toHaveLength(1);
    expect(Object.keys(review.media[0]!).sort()).toEqual(["caption", "id", "kind", "mime", "position", "url"]);
    expect(review.media[0]!.url).toBe(`/api/share/reviews/${token}/media/${review.media[0]!.id}`);
    // Nothing outside the packet's display content: no ids, owner, refs, decisions, risks or links.
    // The token and media ids are random text a short marker could occur in by chance, so they are blanked first.
    const content = raw.replaceAll(token, "<token>").replaceAll(review.media[0]!.id, "<media>");
    for (const leak of [id, "alice", "L1", "S1", "SECRET-RISK", "SECRET-QUESTION", "SECRET-LINK", "example.com", "h".repeat(40), "/api/reviews/"]) {
      expect(content).not.toContain(leak);
    }
  });

  test("extra fields stored in a packet's JSON are not passed through", async () => {
    const h = setUp();
    const id = await h.submit("alice");
    h.store.db.run("UPDATE review_packets SET changes_json = ?, validation_json = ? WHERE id = ?", [
      JSON.stringify([{ area: "X", bullets: ["y"], owner: "alice", extra: { secret: 1 } }]),
      JSON.stringify({ samples: [{ label: "l", input: "i", output: "o", secret: "s" }], tests: { summary: "t", secret: "s" }, secret: "s" }),
      id,
    ]);
    const token = await h.shareOn(id);
    const raw = await (await h.anon(`/api/share/reviews/${token}`)).text();
    expect(raw).not.toContain("secret");
    expect(raw).not.toContain("alice");
    const review = (JSON.parse(raw) as { review: SharedReviewPacket }).review;
    expect(review.changes).toEqual([{ area: "X", bullets: ["y"] }]);
    expect(review.validation).toEqual({ samples: [{ label: "l", input: "i", output: "o" }], tests: { summary: "t" } });
  });
});

describe("a shared packet's media", () => {
  test("is served through the token, uncached", async () => {
    const h = setUp();
    const id = await h.submit("alice", [5]);
    const token = await h.shareOn(id);
    const review = ((await (await h.anon(`/api/share/reviews/${token}`)).json()) as { review: SharedReviewPacket }).review;
    const res = await h.anon(review.media[0]!.url);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([...png(84, 5)]);
    const ranged = await h.anon(review.media[0]!.url, { headers: { range: "bytes=0-3" } });
    expect(ranged.status).toBe(206);
    expect([...new Uint8Array(await ranged.arrayBuffer())]).toEqual([...png(84, 5).slice(0, 4)]);
  });

  test("is scoped to the token's own packet: another packet's media id is a 404, even the same owner's", async () => {
    const h = setUp();
    const shared = await h.submit("alice", [1], "shared");
    const other = await h.submit("alice", [2], "private");
    const token = await h.shareOn(shared);
    const otherDetail = (await (await h.app.request(`/api/reviews/${other}`, { headers: h.as("alice") })).json()) as { review: ReviewPacketDetail };
    const otherMediaId = otherDetail.review.media[0]!.id;
    expect((await h.anon(`/api/share/reviews/${token}/media/${otherMediaId}`)).status).toBe(404);
    // Bob's packet's media is out of reach the same way.
    const bobs = await h.submit("bob", [9]);
    const bobDetail = (await (await h.app.request(`/api/reviews/${bobs}`, { headers: h.as("bob") })).json()) as { review: ReviewPacketDetail };
    expect((await h.anon(`/api/share/reviews/${token}/media/${bobDetail.review.media[0]!.id}`)).status).toBe(404);
  });

  test("path traversal and malformed media ids never reach a file", async () => {
    const h = setUp();
    const id = await h.submit("alice", [4]);
    const token = await h.shareOn(id);
    writeFileSync(join(h.dataDir, "secret.txt"), "TOP-SECRET");
    const attempts = [
      "../secret.txt",
      "..%2Fsecret.txt",
      "..%2F..%2Fsecret.txt",
      "%2e%2e%2fsecret.txt",
      "%2E%2E",
      "..",
      ".",
      "secret.txt",
      "%00",
      encodeURIComponent(join(h.dataDir, "secret.txt")),
      "a".repeat(36),
      "00000000-0000-0000-0000-000000000000",
      "00000000-0000-0000-0000-000000000000%2F..",
    ];
    for (const a of attempts) {
      const res = await h.anon(`/api/share/reviews/${token}/media/${a}`);
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain("TOP-SECRET");
    }
  });
});

describe("the public path reaches no other route", () => {
  test("every owner-only review route still refuses an unauthenticated request", async () => {
    const h = setUp();
    const id = await h.submit("alice", [6]);
    const token = await h.shareOn(id);
    const mediaId = ((await (await h.app.request(`/api/reviews/${id}`, { headers: h.as("alice") })).json()) as { review: ReviewPacketDetail })
      .review.media[0]!.id;
    // Even carrying a live share token every other way a request could.
    const withToken = { authorization: `Bearer ${token}`, "x-standup-share-token": token, cookie: `share=${token}` };
    const reads = [
      "/api/reviews",
      `/api/reviews?share=${token}`,
      "/api/reviews/pending-count",
      `/api/reviews/${id}`,
      `/api/reviews/${id}?share=${token}`,
      `/api/reviews/${id}/media/${mediaId}`,
      `/api/reviews/${id}/media/${mediaId}?share=${token}`,
    ];
    for (const path of reads) {
      for (const headers of [{}, withToken]) {
        const res = await h.anon(path, { headers });
        expect([401, 403]).toContain(res.status);
      }
    }
    for (const action of ["approve", "request-changes", "share"]) {
      const res = await h.anon(`/api/reviews/${id}/${action}?share=${token}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...withToken },
        body: JSON.stringify({ enabled: false, comment: "x" }),
      });
      expect(res.status).toBe(403);
    }
    expect((await h.anon(`/api/share/reviews/${token}`)).status).toBe(200);
  });

  test("prefix, dot-segment and encoded paths under the share prefix don't reach other routes", async () => {
    const h = setUp();
    const id = await h.submit("alice", [6]);
    const token = await h.shareOn(id);
    const attempts = [
      `/api/share/reviews/${token}/../../reviews/${id}`,
      `/api/share/reviews/${token}/..%2F..%2Freviews%2F${id}`,
      `/api/share/reviews/${token}%2F..%2F..%2Freviews%2F${id}`,
      `/api/share/reviews/${token}/%2e%2e/%2e%2e/reviews/${id}`,
      `/api/share/reviews/%2e%2e/%2e%2e/reviews/${id}`,
      `/api/share/reviews/..%2F..%2Freviews`,
      `/api/share/reviews/${token}/approve`,
      `/api/share/reviews/${token}/share`,
      `/api/share/reviews/${token}/comments`,
      `/api/share/reviews/${token}/media`,
      `/api/share/reviews/${token}/media/x/y`,
      `/api/share/reviews/${token}/`,
      `/api/share/reviews/`,
      `/api/share/reviews`,
      `/api/share/`,
      `/api/share/reviews/${token}/../../persona/state`,
      `/api/share/reviews/${token}/../../../api/reviews`,
      `/api/share/reviews/${token}//..//..//reviews`,
    ];
    for (const path of attempts) {
      const res = await h.anon(path);
      const body = await res.text();
      // Whatever answers, it is never another route's data: no packet id, owner, or review list.
      expect(body).not.toContain(id);
      expect(body).not.toContain('"reviews"');
      expect(body).not.toContain("alice");
      if (res.status === 200) expect(JSON.parse(body)).toHaveProperty("review.title");
      else expect([401, 403, 404]).toContain(res.status);
    }
    // POSTs under the share prefix are not routes at all.
    for (const path of [`/api/share/reviews/${token}`, `/api/share/reviews/${token}/approve`]) {
      const res = await h.anon(path, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      expect(res.status).toBe(404);
    }
  });
});
