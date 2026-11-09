import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "crypto";
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  attachSessionToLaunch,
  createLaunch,
  createSession,
  createStore,
  decideReviewPacket,
  listReviewMedia,
  listReviewPackets,
  setLaunchReviewTokenHash,
  updateLaunchStatus,
  upsertProject,
} from "@standup/store";
import type { LaunchKind, ReviewPacketDetail, ReviewPacketDraft } from "@standup/shared";
import { DEFAULT_IDENTITY_HEADER, REVIEW_MAX_SUBMISSIONS_PER_LAUNCH, WORKER_TOKEN_HEADER } from "@standup/shared";
import { USER_CHANNEL_HEADER, userChannelToken } from "@standup/shared/owner-token";
import { workerTokenHash } from "../floor/gate.js";
import { hostUserAlias } from "../host-user.js";
import { generateOwnerSecrets } from "../owner-secret.js";
import { createServer } from "../server.js";
import type { LaunchFn } from "../server.js";
import { reviewMediaDir, reviewMediaStream, reviewScratchDir, storedReviewMediaPath } from "./media.js";
import { REVIEW_SUBMIT_MAX_BYTES, readBodyCapped } from "./routes.js";
import type { GitRunner } from "./stage.js";
import { reviewTokenPath } from "./token-file.js";

/*
 * The Review routes against a forging or greedy worker: whose queue a packet
 * lands in, what a request must prove before its body is read, which files a
 * worker may hand over, how much it may store, and that serving media never
 * leaks file descriptors.
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

const draft = (title = "A change"): ReviewPacketDraft => ({
  title,
  intent: "approve me",
  changes: [{ area: "X", bullets: ["y"], files: CHANGED }],
  validation: { samples: [{ label: "l", input: "i", output: "o" }] },
  risks: { risks: [], questions: [] },
  links: [],
});

/** A PNG header followed by `n` bytes of `fill`. */
function png(n = 84, fill = 1): Uint8Array {
  const head = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52];
  return Uint8Array.from([...head, ...Array.from({ length: n }, () => fill)]);
}

const openFds = () => readdirSync("/proc/self/fd").length;

interface Launched {
  id: string;
  sid: string;
  token: string;
  requester?: string;
  launchedBy?: string;
}

function setUp(options: { mediaOwnerQuotaBytes?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "review-security-"));
  dirs.push(root);
  const dataDir = join(root, "data");
  const work = join(root, "work");
  for (const d of [dataDir, work]) mkdirSync(d, { recursive: true });
  const store = createStore(":memory:");
  const secrets = generateOwnerSecrets();
  const launches: Launched[] = [];
  const pushes: Array<{ title: string; actor: string }> = [];
  let n = 0;
  /** A launch the way launchSession records one: with the launch request's own launchedBy. */
  const record = (
    o: { task: string; requester?: string; launchedBy?: string },
    extra: { kind?: LaunchKind; worktreePath?: string; inPlace?: boolean; provisioned?: boolean } = {}
  ) => {
    n++;
    const id = `L${n}`;
    const initial = `tok-${n}-${"x".repeat(40)}`;
    const l: Launched = {
      id,
      sid: `S${n}`,
      // The launch's current token: its token file once a submit has rotated it, as the MCP server re-reads it.
      get token() {
        const path = reviewTokenPath(dataDir, id);
        return existsSync(path) ? readFileSync(path, "utf8").trim() : initial;
      },
      requester: o.requester,
      launchedBy: o.launchedBy,
    };
    const cwd = extra.worktreePath ?? work;
    createLaunch(store.db, {
      id: l.id,
      kind: extra.kind,
      inPlace: extra.inPlace,
      provisioned: extra.provisioned,
      projectId: "p",
      task: o.task,
      worktreePath: cwd,
      branch: "b",
      status: "running",
      requester: o.requester,
      launchedBy: o.launchedBy,
    });
    createSession(store.db, { id: l.sid, projectId: "p", title: "t", cwd, status: "idle" });
    attachSessionToLaunch(store.db, l.id, l.sid);
    setLaunchReviewTokenHash(store.db, l.id, workerTokenHash(l.token));
    launches.push(l);
    return l;
  };
  const launchFn = (async (_db: unknown, o: { task: string; requester?: string; launchedBy?: string }) => ({
    launch: { id: record(o).id },
  })) as unknown as LaunchFn;
  const app = createServer(
    store, () => {}, null, undefined, undefined, "", "", {}, undefined, undefined, launchFn, undefined,
    { ownerSecrets: secrets },
    {},
    {},
    {},
    {
      git: fakeGit,
      dataDir,
      mediaHome: root,
      mediaEnv: {},
      push: (title, _m, actor) => pushes.push({ title, actor }),
      mediaOwnerQuotaBytes: options.mediaOwnerQuotaBytes,
    }
  );
  upsertProject(store.db, { id: "p", name: "P", branch: "main", repos: [] });

  const launchVia = (headers: Record<string, string>, body: Record<string, unknown>) =>
    app.request("/api/projects/p/launch", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const submit = (l: Launched, body: Record<string, unknown> = {}) =>
    app.request("/api/reviews/submit", {
      method: "POST",
      headers: { "content-type": "application/json", [WORKER_TOKEN_HEADER]: l.token },
      body: JSON.stringify({ session_id: l.sid, packet: draft(), ...body }),
    });
  const file = (path: string, bytes: Uint8Array = png()) => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, bytes);
    return path;
  };
  const read = (alias: string, path: string, method = "GET", headers: Record<string, string> = {}) =>
    app.request(path, { method, headers: { [IDENTITY]: alias, [USER_CHANNEL_HEADER]: userChannelToken(secrets.ownerToken, alias), ...headers } });
  return { root, dataDir, work, store, secrets, app, launches, pushes, record, launchVia, submit, file, read };
}

describe("whose queue a packet lands in", () => {
  test("a body `actor` names the attribution only: bob's launch for 'alice' lands in bob's queue", async () => {
    const h = setUp();
    const bob = { [IDENTITY]: "bob", [USER_CHANNEL_HEADER]: userChannelToken(h.secrets.ownerToken, "bob") };
    expect((await h.launchVia(bob, { task: "do stuff", actor: "alice" })).status).toBe(200);
    const l = h.launches[0]!;
    expect(l.requester).toBe("alice");
    expect(l.launchedBy).toBe("bob");
    expect((await h.submit(l)).status).toBe(200);
    expect(listReviewPackets(h.store.db, { owner: "alice" })).toEqual([]);
    expect(listReviewPackets(h.store.db, { owner: "bob" }).map((p) => p.status)).toEqual(["pending"]);
    expect(h.pushes.map((p) => p.actor)).toEqual(["bob"]);
  });

  test("an unproven identity header records no launcher, and its packet is refused", async () => {
    const h = setUp();
    await h.launchVia({ [IDENTITY]: "bob" }, { task: "do stuff", actor: "alice" });
    const l = h.launches[0]!;
    expect(l.launchedBy).toBeUndefined();
    const res = await h.submit(l);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toContain("no trusted owner for this launch");
    for (const owner of ["alice", "bob", hostUserAlias()]) expect(listReviewPackets(h.store.db, { owner, status: ["draft", "pending"] })).toEqual([]);
  });

  test("an anonymous launch's packet goes to no one, not the host's queue", async () => {
    const h = setUp();
    await h.launchVia({ [IDENTITY]: "anonymous" }, { task: "t" });
    const l = h.launches[0]!;
    const res = await h.submit(l);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toContain("no trusted owner for this launch");
    const brief = await h.app.request(`/api/reviews/brief?session_id=${l.sid}`, { headers: { [WORKER_TOKEN_HEADER]: l.token } });
    expect(brief.status).toBe(403);
    expect(listReviewPackets(h.store.db, { owner: hostUserAlias(), status: ["draft", "pending"] })).toEqual([]);
  });

  test("one launch's token can't submit or fetch a brief for another launch's session", async () => {
    const h = setUp();
    const a = h.record({ task: "t", launchedBy: "alice" });
    const b = h.record({ task: "t", launchedBy: "bob" });
    const res = await h.app.request("/api/reviews/submit", {
      method: "POST",
      headers: { "content-type": "application/json", [WORKER_TOKEN_HEADER]: b.token },
      body: JSON.stringify({ session_id: a.sid, packet: draft() }),
    });
    expect(res.status).toBe(403);
    const brief = await h.app.request(`/api/reviews/brief?session_id=${a.sid}`, { headers: { [WORKER_TOKEN_HEADER]: b.token } });
    expect(brief.status).toBe(403);
    expect(listReviewPackets(h.store.db, { owner: "alice", status: ["draft", "pending"] })).toEqual([]);
  });

  test("a failed or cleaned-up launch's token is refused", async () => {
    for (const status of ["failed", "cleaned"] as const) {
      const h = setUp();
      const l = h.record({ task: "t", launchedBy: "alice" });
      updateLaunchStatus(h.store.db, l.id, status);
      const res = await h.submit(l);
      expect(res.status).toBe(403);
      expect(((await res.json()) as { reason: string }).reason).toBe("worker-token");
      const brief = await h.app.request(`/api/reviews/brief?session_id=${l.sid}`, { headers: { [WORKER_TOKEN_HEADER]: l.token } });
      expect(brief.status).toBe(403);
    }
  });

  test("a launch idempotency key resolves only to the same user's launch", async () => {
    const h = setUp();
    createLaunch(h.store.db, { id: "KEYED", projectId: "p", task: "t", worktreePath: h.work, branch: "b", launchedBy: "alice", idempotencyKey: "k-1" });
    const as = (alias: string) => ({ [IDENTITY]: alias, [USER_CHANNEL_HEADER]: userChannelToken(h.secrets.ownerToken, alias) });
    const theirs = await h.launchVia(as("bob"), { task: "t", idempotencyKey: "k-1" });
    expect(theirs.status).toBe(409);
    expect(JSON.stringify(await theirs.json())).not.toContain("KEYED");
    const mine = await h.launchVia(as("alice"), { task: "t", idempotencyKey: "k-1" });
    expect(mine.status).toBe(200);
    expect(await mine.json()).toMatchObject({ deduped: true, launch: { id: "KEYED" } });
  });
});

describe("the submit body", () => {
  /** A body stream of `chunks` chunks of `size` bytes, counting how many were pulled. */
  function countedBody(chunks: number, size: number) {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= chunks) return controller.close();
        pulled++;
        controller.enqueue(new Uint8Array(size).fill(0x20));
      },
    });
    return { stream, pulled: () => pulled };
  }

  test("a request without a valid token is refused before any of its body is read", async () => {
    const h = setUp();
    for (const headers of [{}, { [WORKER_TOKEN_HEADER]: "not-a-token" }]) {
      const body = countedBody(100, 64 * 1024);
      const res = await h.app.request(
        new Request("http://localhost/api/reviews/submit", {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: body.stream,
          duplex: "half",
        } as RequestInit)
      );
      expect(res.status).toBe(403);
      // Only what the stream buffers ahead on its own, never the body.
      expect(body.pulled()).toBeLessThanOrEqual(1);
    }
  });

  test("an authenticated chunked body over the cap is a 413, read no further than the cap", async () => {
    const h = setUp();
    const l = h.record({ task: "t", launchedBy: "alice" });
    const body = countedBody(100, 64 * 1024);
    const res = await h.app.request(
      new Request("http://localhost/api/reviews/submit", {
        method: "POST",
        headers: { "content-type": "application/json", [WORKER_TOKEN_HEADER]: l.token },
        body: body.stream,
        duplex: "half",
      } as RequestInit)
    );
    expect(res.status).toBe(413);
    expect(body.pulled()).toBeLessThan(100);
    expect(body.pulled() * 64 * 1024).toBeLessThanOrEqual(REVIEW_SUBMIT_MAX_BYTES + 3 * 64 * 1024);
  });

  test("readBodyCapped returns the body under the cap and null over it", async () => {
    const small = await readBodyCapped(new Request("http://x/", { method: "POST", body: "hello" }), 10);
    expect(new TextDecoder().decode(small!)).toBe("hello");
    expect(await readBodyCapped(new Request("http://x/", { method: "POST", body: "x".repeat(11) }), 10)).toBeNull();
    expect((await readBodyCapped(new Request("http://x/"), 10))!.length).toBe(0);
  });
});

describe("where media may come from", () => {
  test("an adopted session's cwd is not a media root; its scratch dir is", async () => {
    const h = setUp();
    const l = h.record({ task: "t", launchedBy: "alice" }, { kind: "adopted" });
    const inCwd = h.file(join(h.work, "shot.png"));
    expect((await h.submit(l, { media: [{ path: inCwd, caption: "c" }] })).status).toBe(400);
    const scratch = reviewScratchDir(h.dataDir, l.id);
    const inScratch = h.file(join(scratch, "shot.png"));
    expect((await h.submit(l, { media: [{ path: inScratch, caption: "c" }] })).status).toBe(200);
  });

  test("an in-place or tree-reusing launch's worktree is not a media root; the scratch dir is", async () => {
    const h = setUp();
    const l = h.record({ task: "t", launchedBy: "alice" }, { inPlace: true });
    const inTree = h.file(join(h.work, "shot.png"));
    expect((await h.submit(l, { media: [{ path: inTree, caption: "c" }] })).status).toBe(400);
    const inScratch = h.file(join(reviewScratchDir(h.dataDir, l.id), "shot.png"));
    expect((await h.submit(l, { media: [{ path: inScratch, caption: "c" }] })).status).toBe(200);
  });

  test("a provisioned launch's whole working dir is a media root, beside its scratch dir", async () => {
    const h = setUp();
    const l = h.record({ task: "t", launchedBy: "alice" }, { provisioned: true });
    const inTree = h.file(join(h.work, "shot.png"));
    expect((await h.submit(l, { media: [{ path: inTree, caption: "c" }] })).status).toBe(200);
    const inScratch = h.file(join(reviewScratchDir(h.dataDir, l.id), "shot.png"));
    expect((await h.submit(l, { media: [{ path: inScratch, caption: "c" }] })).status).toBe(200);
  });

  test("a worktree that contains the data dir reaches only the launch's own scratch dir inside it", async () => {
    const h = setUp();
    const l = h.record({ task: "t", launchedBy: "alice" }, { worktreePath: h.root });
    const elsewhere = h.file(join(h.dataDir, "review-scratch", "other-launch", "shot.png"));
    const loose = h.file(join(h.dataDir, "loose.png"));
    for (const path of [elsewhere, loose]) {
      expect((await h.submit(l, { media: [{ path, caption: "c" }] })).status).toBe(400);
    }
    const own = h.file(join(reviewScratchDir(h.dataDir, l.id), "shot.png"));
    expect((await h.submit(l, { media: [{ path: own, caption: "c" }] })).status).toBe(200);
    expect((await h.submit(l, { media: [{ path: h.file(join(h.work, "w.png")), caption: "c" }] })).status).toBe(200);
  });
});

describe("how much a worker may store", () => {
  test("a stored copy no row names any more is removed; one still named is kept", async () => {
    const h = setUp();
    const a = h.record({ task: "t", launchedBy: "alice" });
    const b = h.record({ task: "t", launchedBy: "alice" });
    const shared = h.file(join(h.work, "shared.png"), png(84, 7));
    const first = h.file(join(h.work, "first.png"), png(84, 8));
    expect((await h.submit(a, { media: [{ path: shared, caption: "s" }, { path: first, caption: "f" }] })).status).toBe(200);
    expect((await h.submit(b, { media: [{ path: shared, caption: "s" }] })).status).toBe(200);
    const aPacket = listReviewPackets(h.store.db, { owner: "alice", status: "pending" }).find((p) => p.imageCount === 2)!;
    const rows = listReviewMedia(h.store.db, aPacket.id, "alice");
    const sharedPath = storedReviewMediaPath(h.dataDir, rows[0]!.sha256, rows[0]!.mime);
    const firstPath = storedReviewMediaPath(h.dataDir, rows[1]!.sha256, rows[1]!.mime);
    expect(existsSync(firstPath)).toBe(true);

    // A resubmission supersedes that packet and drops its media rows: the copy
    // only they named is removed, the one b's packet names is kept.
    expect((await h.submit(a)).status).toBe(200);
    expect(listReviewMedia(h.store.db, aPacket.id, "alice")).toEqual([]);
    expect(existsSync(firstPath)).toBe(false);
    expect(existsSync(sharedPath)).toBe(true);

    // A draft holding rows is submitted with none: the rows are cleared and
    // the copy only they named is removed.
    const again = h.file(join(h.work, "again.png"), png(84, 9));
    expect((await h.submit(a, { media: [{ path: again, caption: "g" }] })).status).toBe(200);
    const pending = listReviewPackets(h.store.db, { owner: "alice", status: "pending" }).find((p) => p.imageCount === 1 && p.id !== aPacket.id)!;
    const againRow = listReviewMedia(h.store.db, pending.id, "alice").find((r) => r.caption === "g");
    const brief = (await (await h.app.request(`/api/reviews/brief?session_id=${a.sid}`, { headers: { [WORKER_TOKEN_HEADER]: a.token } })).json()) as { packetId: string };
    if (againRow) {
      const againPath = storedReviewMediaPath(h.dataDir, againRow.sha256, againRow.mime);
      h.store.db.run("UPDATE review_media SET packet_id = ? WHERE id = ?", [brief.packetId, againRow.id]);
      expect((await h.submit(a)).status).toBe(200);
      expect(listReviewMedia(h.store.db, brief.packetId, "alice")).toEqual([]);
      expect(existsSync(againPath)).toBe(false);
    }
    expect(againRow).toBeDefined();
  });

  test("a decided review's media is kept and stays viewable", async () => {
    const h = setUp();
    const a = h.record({ task: "t", launchedBy: "alice" });
    const res = await h.submit(a, { media: [{ path: h.file(join(h.work, "kept.png"), png(84, 4)), caption: "k" }] });
    const { packetId } = (await res.json()) as { packetId: string };
    expect(decideReviewPacket(h.store.db, { id: packetId, owner: "alice", decision: "approved", actor: "alice" }).ok).toBe(true);
    const row = listReviewMedia(h.store.db, packetId, "alice")[0]!;
    expect(existsSync(storedReviewMediaPath(h.dataDir, row.sha256, row.mime))).toBe(true);
    expect((await h.read("alice", `/api/reviews/${packetId}/media/${row.id}`)).status).toBe(200);
  });

  test(`a launch may submit at most ${REVIEW_MAX_SUBMISSIONS_PER_LAUNCH} packets or revisions`, async () => {
    const h = setUp();
    const l = h.record({ task: "t", launchedBy: "alice" });
    expect((await h.submit(l)).status).toBe(200);
    h.store.db.run("UPDATE review_packets SET revision = ? WHERE launch_id = ?", [REVIEW_MAX_SUBMISSIONS_PER_LAUNCH, l.id]);
    const res = await h.submit(l);
    expect(res.status).toBe(429);
    expect(listReviewPackets(h.store.db, { owner: "alice" })[0]!.revision).toBe(REVIEW_MAX_SUBMISSIONS_PER_LAUNCH);
  });

  test("the owner's quota counts the distinct media of open reviews only, and refuses before storing", async () => {
    const h = setUp({ mediaOwnerQuotaBytes: 250 });
    const a = h.record({ task: "t", launchedBy: "alice" });
    // One file attached twice (116 bytes) is stored once and counts once.
    const one = h.file(join(h.work, "one.png"), png(100, 1));
    expect((await h.submit(a, { media: [{ path: one, caption: "1" }, { path: one, caption: "1 again" }] })).status).toBe(200);
    // A resubmission supersedes that packet, so its media no longer counts: 136 bytes fit.
    await h.app.request(`/api/reviews/brief?session_id=${a.sid}`, { headers: { [WORKER_TOKEN_HEADER]: a.token } });
    const second = await h.submit(a, { media: [{ path: h.file(join(h.work, "two.png"), png(120, 2)), caption: "2" }] });
    expect(second.status).toBe(200);
    const { packetId } = (await second.json()) as { packetId: string };

    // Another launch's open review counts: 136 + 136 is over 250.
    const b = h.record({ task: "t", launchedBy: "alice" });
    const three = h.file(join(h.work, "three.png"), png(120, 3));
    const res = await h.submit(b, { media: [{ path: three, caption: "3" }] });
    expect(res.status).toBe(413);
    const body = (await res.json()) as { reason: string; error: string };
    expect(body.reason).toBe("quota");
    expect(body.error).toContain("open reviews");
    expect(readdirSync(reviewMediaDir(h.dataDir)).filter((f) => f.startsWith(".staging-"))).toEqual([]);

    // Deciding the pending review frees its share; its media is kept.
    expect(decideReviewPacket(h.store.db, { id: packetId, owner: "alice", decision: "changes_requested", comment: "x", actor: "alice" }).ok).toBe(true);
    expect((await h.submit(b, { media: [{ path: three, caption: "3" }] })).status).toBe(200);
    expect(listReviewMedia(h.store.db, packetId, "alice")).toHaveLength(1);

    // Another owner has a quota of their own.
    const c = h.record({ task: "t", launchedBy: "bob" });
    expect((await h.submit(c, { media: [{ path: h.file(join(h.work, "four.png"), png(140, 4)), caption: "4" }] })).status).toBe(200);
  });

  test("when the media can't be put in place the packet is left as it was", async () => {
    const h = setUp();
    const l = h.record({ task: "t", launchedBy: "alice" });
    const bytes = png(84, 5);
    const sha = createHash("sha256").update(bytes).digest("hex");
    // A non-empty directory where the copy goes: the rename into place fails.
    mkdirSync(join(storedReviewMediaPath(h.dataDir, sha, "image/png"), "x"), { recursive: true });
    const res = await h.submit(l, { media: [{ path: h.file(join(h.work, "s.png"), bytes), caption: "s" }] });
    expect(res.status).toBe(500);
    expect(listReviewPackets(h.store.db, { owner: "alice", status: ["draft", "pending"] })).toEqual([]);
    expect(readdirSync(reviewMediaDir(h.dataDir)).filter((f) => f.startsWith(".staging-"))).toEqual([]);
  });
});

describe("serving media leaks no file descriptors", () => {
  async function withMedia() {
    const h = setUp();
    const l = h.record({ task: "t", launchedBy: "alice" });
    const res = await h.submit(l, { media: [{ path: h.file(join(h.work, "big.png"), png(3 * 1024 * 1024)), caption: "big" }] });
    const { packetId } = (await res.json()) as { packetId: string };
    const media = listReviewMedia(h.store.db, packetId, "alice")[0]!;
    return { h, url: `/api/reviews/${packetId}/media/${media.id}`, size: media.bytes };
  }

  test("a HEAD answers with the headers and no body, and closes the file", async () => {
    const { h, url, size } = await withMedia();
    const head = await h.read("alice", url, "HEAD");
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(size));
    expect((await head.arrayBuffer()).byteLength).toBe(0);
    const ranged = await h.read("alice", url, "HEAD", { range: "bytes=0-9" });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("content-length")).toBe("10");
    expect(ranged.headers.get("content-range")).toBe(`bytes 0-9/${size}`);
    const before = openFds();
    for (let i = 0; i < 200; i++) await (await h.read("alice", url, "HEAD")).arrayBuffer();
    expect(openFds() - before).toBeLessThan(5);
  });

  test("GETs whose body is cancelled unread close their file", async () => {
    const { h, url } = await withMedia();
    const before = openFds();
    for (let i = 0; i < 100; i++) await (await h.read("alice", url)).body?.cancel();
    expect(openFds() - before).toBeLessThan(5);
  });

  test("a stream dropped without being read or cancelled closes its file when it sits idle", async () => {
    const { h } = await withMedia();
    const path = join(h.work, "big.png");
    const before = openFds();
    for (let i = 0; i < 50; i++) reviewMediaStream(openSync(path, "r"), 0, 99, 20);
    expect(openFds() - before).toBeGreaterThanOrEqual(45);
    await Bun.sleep(100);
    expect(openFds() - before).toBeLessThan(5);
  });

  test("a dropped stream's file is closed when the stream is collected, before any idle timeout", async () => {
    const { h } = await withMedia();
    const path = join(h.work, "big.png");
    const before = openFds();
    const drop = () => {
      for (let i = 0; i < 50; i++) reviewMediaStream(openSync(path, "r"), 0, 99);
    };
    drop();
    expect(openFds() - before).toBeGreaterThanOrEqual(45);
    for (let i = 0; i < 10 && openFds() - before >= 5; i++) {
      Bun.gc(true);
      await Bun.sleep(20);
    }
    expect(openFds() - before).toBeLessThan(5);
  });
});

describe("a submission made with a copied review token", () => {
  const detailOf = async (h: ReturnType<typeof setUp>, owner: string, packetId: string) =>
    ((await (await h.read(owner, `/api/reviews/${packetId}`)).json()) as { review: ReviewPacketDetail }).review;

  test("refs are the collector's own reading of the launch's checkout; body-supplied refs are ignored", async () => {
    const h = setUp();
    const l = h.record({ task: "t", launchedBy: "alice" });
    const forged = { branch: "evil", commitSha: "e".repeat(40), headSha: "e".repeat(40), baseSha: "0".repeat(40), changedFiles: ["src/forged.ts"] };
    const res = await h.submit(l, { ...forged, packet: { ...draft(), ...forged } });
    expect(res.status).toBe(200);
    const review = await detailOf(h, "alice", ((await res.json()) as { packetId: string }).packetId);
    expect(review.branch).toBe("feat");
    expect(review.commitSha).toBe("h".repeat(40));
    expect(review.baseSha).toBe("b".repeat(40));
  });

  test("the schema check's changed files are the server's: a body file list can't cover a packet that omits the real change", async () => {
    const h = setUp();
    const l = h.record({ task: "t", launchedBy: "alice" });
    const packet = { ...draft(), changes: [{ area: "X", bullets: ["y"], files: ["src/forged.ts"] }] };
    const res = await h.submit(l, { changedFiles: ["src/forged.ts"], packet });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { problems: string[] }).problems.join("\n")).toContain("src/a.ts");
  });

  test("a launch with no checkout of its own submits with null refs, even when its draft held some", async () => {
    const h = setUp();
    const l = h.record({ task: "t", launchedBy: "alice" }, { inPlace: true });
    // The brief's draft reads the tree's refs; the submission doesn't keep them.
    const brief = await h.app.request(`/api/reviews/brief?session_id=${l.sid}`, { headers: { [WORKER_TOKEN_HEADER]: l.token } });
    expect(brief.status).toBe(200);
    const packet = { ...draft(), changes: [{ area: "X", bullets: ["y"], files: ["anything.ts"] }] };
    const res = await h.submit(l, { branch: "evil", commitSha: "e".repeat(40), packet });
    expect(res.status).toBe(200);
    const review = await detailOf(h, "alice", ((await res.json()) as { packetId: string }).packetId);
    expect([review.branch, review.commitSha, review.baseSha]).toEqual([null, null, null]);
  });

  test("each revision records its submitting session, whether it is the launch's root, and a change of session", async () => {
    const h = setUp();
    const l = h.record({ task: "t", launchedBy: "alice" });
    const first = (await (await h.submit(l)).json()) as { packetId: string };
    const one = await detailOf(h, "alice", first.packetId);
    expect([one.submittedBySession, one.submittedByRootSession, one.resubmittedFromOtherSession]).toEqual([l.sid, true, false]);

    createSession(h.store.db, { id: "S-sub", projectId: "p", title: "t", cwd: h.work, status: "idle", parentSessionId: l.sid });
    const second = (await (await h.submit(l, { session_id: "S-sub" })).json()) as { packetId: string; revision: number };
    expect(second.revision).toBe(2);
    const two = await detailOf(h, "alice", second.packetId);
    expect([two.submittedBySession, two.submittedByRootSession, two.resubmittedFromOtherSession]).toEqual(["S-sub", false, true]);

    // The same session submitting again is not a change of session.
    const third = (await (await h.submit(l, { session_id: "S-sub" })).json()) as { packetId: string };
    expect((await detailOf(h, "alice", third.packetId)).resubmittedFromOtherSession).toBe(false);
    const back = (await (await h.submit(l)).json()) as { packetId: string };
    expect((await detailOf(h, "alice", back.packetId)).resubmittedFromOtherSession).toBe(true);
  });

  test("a submit spends its token: the old one is refused and the rewritten 0600 file's works; a brief does not rotate", async () => {
    const h = setUp();
    const l = h.record({ task: "t", launchedBy: "alice" });
    const stolen = l.token;
    const brief = () => h.app.request(`/api/reviews/brief?session_id=${l.sid}`, { headers: { [WORKER_TOKEN_HEADER]: stolen } });
    expect((await brief()).status).toBe(200);
    expect((await brief()).status).toBe(200);
    expect(existsSync(reviewTokenPath(h.dataDir, l.id))).toBe(false);

    expect((await h.submit(l)).status).toBe(200);
    const path = reviewTokenPath(h.dataDir, l.id);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const fresh = readFileSync(path, "utf8").trim();
    expect(fresh).not.toBe(stolen);
    expect(l.token).toBe(fresh);

    const replay = await h.app.request("/api/reviews/submit", {
      method: "POST",
      headers: { "content-type": "application/json", [WORKER_TOKEN_HEADER]: stolen },
      body: JSON.stringify({ session_id: l.sid, packet: draft("FORGED") }),
    });
    expect(replay.status).toBe(403);
    expect((await brief()).status).toBe(403);
    expect(listReviewPackets(h.store.db, { owner: "alice" }).map((p) => p.title)).toEqual(["A change"]);

    expect((await h.submit(l, { packet: draft("Second") })).status).toBe(200);
    expect(readFileSync(path, "utf8").trim()).not.toBe(fresh);
  });
});
