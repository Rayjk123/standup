import { expect, test, describe, afterAll } from "bun:test";
import { DEFAULT_IDENTITY_HEADER } from "@standup/shared";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { createStore, createSession, upsertProject } from "@standup/store";
import type { Store } from "@standup/store";
import {
  KnowledgeStore,
  formatContradictsClaim,
  isRejudgeQueued,
  recordJudgment,
  writeKnowledgeFile,
} from "@standup/knowledge";
import { createServer, type KnowledgeQualityDeps } from "./server.js";
import { KnowledgeSync } from "./knowledge-sync.js";
import type { DraftVerification } from "./draft-verify.js";
import type { ContradictionJudgment } from "./knowledge-coherence.js";
import { PERSONA_WRITER_HEADER } from "./persona/memory-trust.js";
import type { PersonaRuntime } from "./persona/runtime.js";
import { USER_CHANNEL_HEADER, userChannelToken } from "@standup/shared/owner-token";
import { activeOwnerSecrets } from "./owner-secret.js";
import { AUTO_PUBLISH_DAILY_CAP_PER_SESSION } from "./knowledge-publish-cap.js";

/**
 * The knowledge write path's quality gates, end to end through the routes:
 * unverified publish + background fact-check, near-duplicate refusal across
 * the caller's audience, owner-doc protection and verdict-keeping updates,
 * tag/slug validation, Persona memory dedup, private drafts, and the judge
 * outcome counts in stats.
 */

const PROJECT = `wq-${randomUUID().slice(0, 8)}`;
const OTHER = `wq-other-${randomUUID().slice(0, 8)}`;
const cleanup: string[] = [];
afterAll(async () => {
  for (const dir of cleanup) await rm(dir, { recursive: true, force: true });
});

async function gitWorktree(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "standup-wq-worktree-"));
  cleanup.push(dir);
  const git = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: dir });
  git(["init", "-q"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  await Bun.write(join(dir, "README.md"), "test\n");
  git(["add", "."]);
  git(["commit", "-q", "-m", "initial"]);
  return dir;
}

interface Harness {
  store: Store;
  app: ReturnType<typeof createServer>;
  knowledgeDir: string;
  knowledgeSync: KnowledgeSync;
  sessionId: string;
  worktree: string;
  verifyCalls: string[];
  propose(body: Record<string, unknown>, headers?: Record<string, string>): Promise<Response>;
  /** Waits for detached background work (fact-check, re-judging) to settle. */
  settle(): Promise<void>;
}

async function harness(
  options: {
    verdict?: DraftVerification;
    judge?: (a: { slug: string }, b: { slug: string }) => Promise<ContradictionJudgment>;
    persona?: { runtime?: PersonaRuntime };
  } = {}
): Promise<Harness> {
  const store = createStore(":memory:");
  for (const id of [PROJECT, OTHER]) {
    upsertProject(store.db, { id, name: id, branch: "main", repos: [] });
  }
  const knowledgeDir = await mkdtemp(join(tmpdir(), "standup-wq-knowledge-"));
  cleanup.push(knowledgeDir);
  const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);
  const worktree = await gitWorktree();
  const sessionId = randomUUID();
  createSession(store.db, { id: sessionId, projectId: PROJECT, title: "", cwd: worktree, status: "running" });
  const verifyCalls: string[] = [];
  const quality: KnowledgeQualityDeps = {
    verify: async (slug) => {
      verifyCalls.push(slug);
      return options.verdict ?? { verdict: "error", disputes: [] };
    },
    judge: options.judge ?? (async () => ({ contradicts: false, reason: "" })),
  };
  const app = createServer(
    store,
    () => {},
    null,
    knowledgeSync,
    undefined,
    knowledgeDir,
    "",
    {},
    undefined,
    undefined,
    undefined,
    undefined,
    options.persona ?? {},
    quality
  );
  return {
    store,
    app,
    knowledgeDir,
    knowledgeSync,
    sessionId,
    worktree,
    verifyCalls,
    propose: async (body, headers = {}) =>
      app.request("/api/knowledge/propose", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ session_id: sessionId, cwd: worktree, ...body }),
      }),
    settle: () => new Promise((r) => setTimeout(r, 150)),
  };
}

const docRow = (h: Harness, projectId: string, slug: string) => new KnowledgeStore(h.store.db).getDoc(projectId, slug);

const BODY =
  "The Slack mirror retries a failed post with exponential backoff starting at 500ms and capped at 30s; " +
  "after five attempts the message is parked in the dead-letter table and shown on the Health panel.";
/** BODY with a section added: a near-duplicate of it, below the refusal bar. */
const EXTENDED_BODY = `${BODY}\nOperators replay a parked message from that panel, which resets its attempt counter.`;

describe("publish at unverified confidence, then fact-check", () => {
  test("a proposal publishes at 0.6 with no verification stamp; an error leaves it so", async () => {
    const h = await harness();
    const res = await h.propose({ slug: "retry-policy", title: "Retry policy", body: BODY });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { published: boolean; verification: string };
    expect(json).toMatchObject({ published: true, verification: "pending" });
    await h.settle();
    expect(h.verifyCalls).toEqual(["retry-policy"]);
    const raw = await readFile(join(h.knowledgeDir, PROJECT, "retry-policy.md"), "utf-8");
    expect(raw).toMatch(/confidence: ?0\.6/);
    expect(raw).not.toMatch(/last_verified_at/);
    expect(docRow(h, PROJECT, "retry-policy")?.verdict).toBeUndefined();
    h.store.close();
  });

  test("a passing fact-check raises it to full confidence and stamps the verification", async () => {
    const h = await harness({ verdict: { verdict: "clean", disputes: [] } });
    await h.propose({ slug: "retry-policy", title: "Retry policy", body: BODY });
    await h.settle();
    const row = docRow(h, PROJECT, "retry-policy")!;
    expect(row.confidence).toBe(1);
    expect(row.lastVerifiedAt).toBeDefined();
    expect(row.verdict).toBe("clean");
    h.store.close();
  });

  test("a failing fact-check marks it disputed with the finding and keeps the low confidence", async () => {
    const dispute = { claim: "capped at 30s", finding: "the cap is 60s", evidence: "rg MAX_BACKOFF" };
    const h = await harness({ verdict: { verdict: "disputed", disputes: [dispute] } });
    await h.propose({ slug: "retry-policy", title: "Retry policy", body: BODY });
    await h.settle();
    const row = docRow(h, PROJECT, "retry-policy")!;
    expect(row.verdict).toBe("disputed");
    expect(row.disputes).toEqual([dispute]);
    expect(row.confidence).toBe(0.6);
    expect(row.lastVerifiedAt).toBeUndefined();
    h.store.close();
  });
});

describe("near-duplicate proposals", () => {
  test("a copy of a scope=global doc in another project is refused and names the doc to update", async () => {
    const h = await harness();
    await writeKnowledgeFile(h.knowledgeDir, OTHER, {
      slug: "slack-retries",
      title: "Slack retries",
      body: BODY,
      scope: "global",
      originClass: "agent",
    });
    await h.knowledgeSync.syncAll();
    const res = await h.propose({ slug: "retry-policy", title: "Retry policy", body: BODY });
    const json = (await res.json()) as {
      published: boolean;
      refused: string;
      duplicateOf: { project: string; slug: string; id: string; title: string };
      message: string;
      nearest: unknown[];
    };
    expect(json).toMatchObject({ published: false, refused: "duplicate" });
    expect(json.duplicateOf).toMatchObject({ project: OTHER, slug: "slack-retries", title: "Slack retries" });
    expect(json.duplicateOf.id).toBeTruthy();
    expect(json.message).toBe(
      `This duplicates ${OTHER}/slack-retries. Update that doc instead: call propose_knowledge with slug ` +
        `"slack-retries", project "${OTHER}".`
    );
    expect(existsSync(join(h.knowledgeDir, PROJECT, "retry-policy.md"))).toBe(false);
    expect(existsSync(join(h.knowledgeDir, PROJECT, ".drafts", "retry-policy.md"))).toBe(false);
    h.store.close();
  });

  test("restating the proposer's own doc is reported, never written over it", async () => {
    const h = await harness();
    await h.propose({ slug: "retry-policy", title: "Retry policy", body: BODY });
    const res = await h.propose({ slug: "retry-policy-2", title: "Retry policy", body: `${BODY}\n` });
    const json = (await res.json()) as { published: boolean; duplicateOf: { slug: string } };
    expect(json).toMatchObject({ published: false, duplicateOf: { slug: "retry-policy" } });
    expect(existsSync(join(h.knowledgeDir, PROJECT, "retry-policy-2.md"))).toBe(false);
    expect(await readFile(join(h.knowledgeDir, PROJECT, "retry-policy.md"), "utf-8")).toContain(BODY);
    h.store.close();
  });

  test("two runbooks from one template both publish, and neither overwrites the other", async () => {
    const runbook = (service: string) =>
      [
        `1. Page the ${service} on-call and post in #${service}-ops.`,
        `2. Drain the ${service} queue: \`svc drain ${service} --wait\`.`,
        `3. Restart the ${service} workers with \`svc restart ${service}\`.`,
        `4. Watch the ${service} error rate for ten minutes on the dashboard.`,
        `5. If errors persist, roll back the last ${service} deploy.`,
      ].join("\n");
    const h = await harness();
    const first = await h.propose({ slug: "runbook-ingest-restart", title: "Restart the ingest service", body: runbook("ingest") });
    const second = await h.propose({ slug: "runbook-billing-restart", title: "Restart the billing service", body: runbook("billing") });
    expect(((await first.json()) as { published: boolean }).published).toBe(true);
    expect(((await second.json()) as { published: boolean; slug: string })).toMatchObject({
      published: true,
      slug: "runbook-billing-restart",
    });
    expect(await readFile(join(h.knowledgeDir, PROJECT, "runbook-ingest-restart.md"), "utf-8")).toContain("ingest queue");
    expect(await readFile(join(h.knowledgeDir, PROJECT, "runbook-billing-restart.md"), "utf-8")).toContain("billing queue");
    h.store.close();
  });

  test("a near-duplicate that corrects a value names the doc and what differs", async () => {
    const h = await harness();
    await h.propose({ slug: "deploy-region", title: "Deploy region", body: `${BODY} The stack runs in us-east-1.` });
    const res = await h.propose({ slug: "deploy-region-2", title: "Deploy region", body: `${BODY} The stack runs in us-west-2.` });
    const json = (await res.json()) as { published: boolean; differences: string[]; hint: string };
    expect(json.published).toBe(false);
    expect(json.differences).toEqual(["us-west-2 here", "us-east-1 in the existing doc"]);
    expect(json.hint).toContain("us-west-2");
    h.store.close();
  });

  test("the duplicate check compares the stored form: a secret-only difference is still a copy", async () => {
    const h = await harness();
    const secret = (s: string) => `${BODY} Token: ghp_${s}`;
    await h.propose({ slug: "retry-policy", title: "Retry policy", body: secret("a".repeat(36)) });
    const res = await h.propose({ slug: "retry-policy-2", title: "Retry policy", body: secret("b".repeat(36)) });
    const json = (await res.json()) as { published: boolean; duplicateOf?: { slug: string } };
    expect(json).toMatchObject({ published: false, duplicateOf: { slug: "retry-policy" } });
    h.store.close();
  });

  test("a distinct proposal publishes and lists its nearest docs", async () => {
    const h = await harness();
    await h.propose({ slug: "retry-policy", title: "Retry policy", body: BODY });
    const res = await h.propose({
      slug: "tunnel-identity",
      title: "Tunnel identity trust",
      body: "The tunnel header is trusted only from loopback proxies; any other remote address is anonymous.",
    });
    const json = (await res.json()) as { published: boolean; nearest: Array<{ slug: string; duplicate: boolean }> };
    expect(json.published).toBe(true);
    expect(json.nearest.every((n) => !n.duplicate)).toBe(true);
    h.store.close();
  });

  test("a review request for a near-duplicate below the refusal bar still lands as a draft, with its neighbors", async () => {
    const h = await harness();
    await h.propose({ slug: "retry-policy", title: "Retry policy", body: BODY });
    const res = await h.propose({
      slug: "retry-extended",
      title: "Retry policy",
      body: EXTENDED_BODY,
      request_human_review: true,
    });
    const json = (await res.json()) as { refused?: string; nearest: Array<{ slug: string; duplicate: boolean }> };
    expect(json.refused).toBeUndefined();
    expect(json.nearest[0]).toMatchObject({ slug: "retry-policy", duplicate: true });
    expect(existsSync(join(h.knowledgeDir, PROJECT, ".drafts", "retry-extended.md"))).toBe(true);
    h.store.close();
  });

  test("a review request for a copy is refused like any other: no draft is written", async () => {
    const h = await harness();
    await h.propose({ slug: "retry-policy", title: "Retry policy", body: BODY });
    const res = await h.propose({ slug: "retry-copy", title: "Retry Policy", body: `${BODY}\n`, request_human_review: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      published: false,
      refused: "duplicate",
      duplicateOf: { project: PROJECT, slug: "retry-policy" },
    });
    expect(existsSync(join(h.knowledgeDir, PROJECT, ".drafts", "retry-copy.md"))).toBe(false);
    expect(h.knowledgeSync.getDraft(PROJECT, "retry-copy")).toBeFalsy();
    h.store.close();
  });
});

describe("write-time duplicate refusal", () => {
  test("a copy of a published doc writes no file and no draft row, and names the doc to update", async () => {
    const h = await harness();
    await h.propose({ slug: "retry-policy", title: "Retry policy", body: BODY });
    const markdown = `## Retry policy\n\n- ${BODY.replace("dead-letter table", "`dead-letter` table")}`;
    const res = await h.propose({ slug: "retry-notes", title: "RETRY POLICY", body: markdown });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: false,
      published: false,
      refused: "duplicate",
      duplicateOf: { project: PROJECT, slug: "retry-policy", title: "Retry policy" },
      message: 'This duplicates ' + PROJECT + '/retry-policy. Update that doc instead: call propose_knowledge with slug "retry-policy".',
    });
    expect(existsSync(join(h.knowledgeDir, PROJECT, "retry-notes.md"))).toBe(false);
    expect(existsSync(join(h.knowledgeDir, PROJECT, ".drafts", "retry-notes.md"))).toBe(false);
    await h.knowledgeSync.syncDrafts(PROJECT);
    expect(h.knowledgeSync.getDraft(PROJECT, "retry-notes")).toBeFalsy();
    expect(docRow(h, PROJECT, "retry-notes")).toBeFalsy();
    h.store.close();
  });

  test("the same slug is an update, never refused", async () => {
    const h = await harness();
    await h.propose({ slug: "retry-policy", title: "Retry policy", body: BODY });
    const res = await h.propose({ slug: "retry-policy", title: "Retry policy", body: BODY });
    expect(await res.json()).toMatchObject({ published: true, mode: "replace" });
    h.store.close();
  });

  test("a near-duplicate below the bar keeps today's path: the proposer's own doc is reported, not refused", async () => {
    const h = await harness();
    await h.propose({ slug: "retry-policy", title: "Retry policy", body: BODY });
    const json = (await (await h.propose({ slug: "retry-more", title: "Retry policy", body: EXTENDED_BODY })).json()) as Record<
      string,
      unknown
    >;
    expect(json.refused).toBeUndefined();
    expect(json).toMatchObject({ published: false, duplicateOf: { slug: "retry-policy" } });
    expect(String(json.hint)).toContain("your own doc");
    h.store.close();
  });

  test("a merely related doc publishes, with a hint to update the close doc instead", async () => {
    const h = await harness();
    await h.propose({ slug: "retry-policy", title: "Retry policy", body: BODY });
    const res = await h.propose({
      slug: "mirror-parking",
      title: "Mirror parking",
      body:
        "The Slack mirror retries a failed post with exponential backoff starting at 500ms; the message is parked " +
        "after five attempts and never retried.",
    });
    const json = (await res.json()) as { published: boolean; hint?: string };
    expect(json.published).toBe(true);
    expect(json.hint).toBe(
      `Close to ${PROJECT}/retry-policy — consider updating it instead: propose_knowledge with slug "retry-policy".`
    );
    h.store.close();
  });
});

describe("daily auto-publish cap", () => {
  /** A body sharing no vocabulary with any other. */
  const distinct = () => {
    const words = Array.from({ length: 10 }, () => `w${randomUUID().slice(0, 8)}`);
    return { title: `Note ${words[0]}`, body: `${words.join(" ")}.` };
  };

  test(`past ${AUTO_PUBLISH_DAILY_CAP_PER_SESSION} publishes a session's proposals become review drafts; another session is unaffected`, async () => {
    const h = await harness();
    for (let i = 0; i < AUTO_PUBLISH_DAILY_CAP_PER_SESSION; i++) {
      const json = (await (await h.propose({ slug: `note-${i}`, ...distinct() })).json()) as { published: boolean };
      expect(json.published).toBe(true);
    }
    const over = (await (await h.propose({ slug: "note-over", ...distinct() })).json()) as {
      published: boolean;
      capped: boolean;
      hint: string;
    };
    expect(over).toMatchObject({ published: false, capped: true });
    expect(over.hint).toContain("daily cap");
    expect(over.hint).toContain("review draft");
    expect(existsSync(join(h.knowledgeDir, PROJECT, ".drafts", "note-over.md"))).toBe(true);
    expect(existsSync(join(h.knowledgeDir, PROJECT, "note-over.md"))).toBe(false);

    const otherSession = randomUUID();
    createSession(h.store.db, { id: otherSession, projectId: PROJECT, title: "", cwd: h.worktree, status: "running" });
    const other = (await (await h.propose({ session_id: otherSession, slug: "note-other", ...distinct() })).json()) as {
      published: boolean;
    };
    expect(other.published).toBe(true);
    h.store.close();
  });
});

describe("same-slug proposals", () => {
  test("over an owner-written doc it becomes a review draft replacing the doc, which stays as it is", async () => {
    const h = await harness();
    await writeKnowledgeFile(h.knowledgeDir, PROJECT, { slug: "runbook", title: "Runbook", body: "the owner's runbook" });
    await h.knowledgeSync.syncProject(PROJECT);
    const res = await h.propose({ slug: "runbook", title: "Runbook", body: "an agent's rewrite" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { published: boolean; review: { replaces: string; reason: string }; hint: string };
    expect(json).toMatchObject({ published: false, review: { replaces: "runbook", reason: "it is owner-written" } });
    expect(json.hint).toContain("review draft");
    expect(await readFile(join(h.knowledgeDir, PROJECT, "runbook.md"), "utf-8")).toContain("the owner's runbook");
    expect(await readFile(join(h.knowledgeDir, PROJECT, ".drafts", "runbook.md"), "utf-8")).toMatch(
      /replaces_slug: ?["']?runbook/
    );
    h.store.close();
  });

  test("over an agent doc it updates in place, keeping the contradiction until it is re-judged", async () => {
    const judged: string[] = [];
    let contradicts = true;
    const h = await harness({
      judge: async (a, b) => {
        judged.push(`${a.slug}:${b.slug}`);
        return { contradicts, reason: "they disagree" };
      },
    });
    for (const slug of ["claim", "counter"]) {
      await writeKnowledgeFile(h.knowledgeDir, PROJECT, {
        slug,
        title: slug,
        body: `${slug} body`,
        originClass: "agent",
        sourceSessionId: h.sessionId,
      });
    }
    await h.knowledgeSync.syncProject(PROJECT);
    const disputes = [{ claim: formatContradictsClaim("counter"), finding: "f", evidence: "e" }];
    h.knowledgeSync.recordDocVerdict(PROJECT, "claim", "contradicted", disputes);

    // Still contradicting after the update: the verdict stays.
    await h.propose({ slug: "claim", title: "claim", body: "a reworded claim body" });
    await h.settle();
    expect(judged).toContain("claim:counter");
    expect(docRow(h, PROJECT, "claim")?.verdict).toBe("contradicted");

    // Consistent after the next update: the edge is cleared.
    contradicts = false;
    await h.propose({ slug: "claim", title: "claim", body: "a corrected claim body" });
    await h.settle();
    expect(docRow(h, PROJECT, "claim")?.verdict).toBeUndefined();
    h.store.close();
  });
});

describe("same-slug proposals from someone else", () => {
  test("another session's agent doc is not replaced: the proposal becomes a review draft for it", async () => {
    const h = await harness();
    await writeKnowledgeFile(h.knowledgeDir, PROJECT, {
      slug: "notes",
      title: "Notes",
      body: "another session's notes",
      originClass: "agent",
      sourceSessionId: "some-other-session",
    });
    await h.knowledgeSync.syncProject(PROJECT);
    const res = await h.propose({ slug: "notes", title: "Notes", body: "my rewrite" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { review: { reason: string } }).review.reason).toBe("another session wrote it");
    const raw = await readFile(join(h.knowledgeDir, PROJECT, "notes.md"), "utf-8");
    expect(raw).toContain("another session's notes");
    expect(raw).toContain("some-other-session");
    // Another session's proposal does not overwrite the pending review draft.
    const otherSession = randomUUID();
    createSession(h.store.db, { id: otherSession, projectId: PROJECT, title: "", cwd: h.worktree, status: "running" });
    const again = await h.propose({ session_id: otherSession, slug: "notes", title: "Notes", body: "another rewrite" });
    expect(again.status).toBe(409);
    expect(await readFile(join(h.knowledgeDir, PROJECT, ".drafts", "notes.md"), "utf-8")).toContain("my rewrite");
    h.store.close();
  });

  test("a retried proposal meets its own review draft and updates it rather than being refused", async () => {
    const h = await harness();
    await writeKnowledgeFile(h.knowledgeDir, PROJECT, {
      slug: "notes",
      title: "Notes",
      body: "another session's notes",
      originClass: "agent",
      sourceSessionId: "some-other-session",
    });
    await h.knowledgeSync.syncProject(PROJECT);
    expect((await h.propose({ slug: "notes", title: "Notes", body: "my rewrite" })).status).toBe(200);
    await h.knowledgeSync.syncProject(PROJECT);

    const retry = await h.propose({ slug: "notes", title: "Notes", body: "my rewrite, resent" });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ published: false, review: { replaces: "notes" } });
    expect(await readFile(join(h.knowledgeDir, PROJECT, ".drafts", "notes.md"), "utf-8")).toContain("my rewrite, resent");
    expect(await readFile(join(h.knowledgeDir, PROJECT, "notes.md"), "utf-8")).toContain("another session's notes");
    h.store.close();
  });

  test("a retried correction meets its own review draft over the near-duplicate and returns the same review", async () => {
    const h = await harness();
    const BODY_REGION = (region: string) => `${BODY} The stack runs in ${region}.`;
    await writeKnowledgeFile(h.knowledgeDir, PROJECT, {
      slug: "deploy-region",
      title: "Deploy region",
      body: BODY_REGION("us-east-1"),
      originClass: "agent",
      sourceSessionId: "session-a",
    });
    await h.knowledgeSync.syncProject(PROJECT);
    const proposal = { slug: "deploy-region-fix", title: "Deploy region", body: BODY_REGION("us-west-2") };
    const first = (await (await h.propose(proposal)).json()) as Record<string, unknown>;
    expect(first).toMatchObject({ published: false, slug: "deploy-region", review: { replaces: "deploy-region" } });
    await h.knowledgeSync.syncProject(PROJECT);

    const retry = await h.propose(proposal);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ published: false, slug: "deploy-region", review: { replaces: "deploy-region" } });
    h.store.close();
  });

  test("a correction to another session's doc reaches it: a review draft replacing it, with the diff", async () => {
    const h = await harness();
    const BODY_REGION = (region: string) => `${BODY} The stack runs in ${region}.`;
    // Session A's doc.
    await writeKnowledgeFile(h.knowledgeDir, PROJECT, {
      slug: "deploy-region",
      title: "Deploy region",
      body: BODY_REGION("us-east-1"),
      originClass: "agent",
      sourceSessionId: "session-a",
    });
    await h.knowledgeSync.syncProject(PROJECT);
    // Session B (this harness's session) proposes the correction under a new slug.
    const res = await h.propose({ slug: "deploy-region-fix", title: "Deploy region", body: BODY_REGION("us-west-2") });
    const json = (await res.json()) as {
      published: boolean;
      slug: string;
      review: { replaces: string };
      differences: string[];
    };
    expect(json).toMatchObject({ published: false, slug: "deploy-region", review: { replaces: "deploy-region" } });
    expect(json.differences).toEqual(["us-west-2 here", "us-east-1 in the existing doc"]);
    expect(existsSync(join(h.knowledgeDir, PROJECT, "deploy-region-fix.md"))).toBe(false);
    // A human accepts it: the doc now says us-west-2.
    const accept = await h.app.request(`/api/projects/${PROJECT}/knowledge/drafts/deploy-region/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "replace" }),
    });
    expect(accept.status).toBe(200);
    expect(await readFile(join(h.knowledgeDir, PROJECT, "deploy-region.md"), "utf-8")).toContain("us-west-2");
    h.store.close();
  });

  test("Bob proposing over Alice's personal doc learns nothing about it and changes nothing", async () => {
    const h = await harness();
    await writeKnowledgeFile(h.knowledgeDir, PROJECT, {
      slug: "alice-notes",
      title: "Alice: private concerns",
      body: "alice's private note",
      originClass: "agent",
      scope: "user",
      ownerUser: "alice",
    });
    await h.knowledgeSync.syncProject(PROJECT);
    const res = await h.propose(
      { slug: "alice-notes", title: "Notes", body: "bob's text" },
      { [DEFAULT_IDENTITY_HEADER]: "bob" }
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    const text = await res.text();
    expect(text).not.toContain("alice");
    expect(text).not.toContain("private concerns");
    expect(text).not.toContain("alice's private note");
    expect(await readFile(join(h.knowledgeDir, PROJECT, "alice-notes.md"), "utf-8")).toContain("alice's private note");
    h.store.close();
  });
});

describe("accepting a near-duplicate draft", () => {
  test("the draft is kept and the choice handed back; force publishes it", async () => {
    const h = await harness();
    await h.propose({ slug: "retry-policy", title: "Retry policy", body: BODY });
    await h.propose({ slug: "retry-copy", title: "Retry policy", body: EXTENDED_BODY, request_human_review: true });
    const accept = (body: unknown) =>
      h.app.request(`/api/projects/${PROJECT}/knowledge/drafts/retry-copy/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const first = await accept({});
    expect(first.status).toBe(409);
    expect(((await first.json()) as { duplicateOf: { slug: string } }).duplicateOf.slug).toBe("retry-policy");
    expect(existsSync(join(h.knowledgeDir, PROJECT, ".drafts", "retry-copy.md"))).toBe(true);
    const forced = await accept({ force: true });
    expect(forced.status).toBe(200);
    expect(existsSync(join(h.knowledgeDir, PROJECT, "retry-copy.md"))).toBe(true);
    h.store.close();
  });
});

describe("search marks unverified docs", () => {
  test("an agent doc no fact-check has passed is flagged pending, and counted in stats", async () => {
    const h = await harness();
    await h.propose({ slug: "retry-policy", title: "Retry policy", body: BODY });
    await h.settle();
    const res = await h.app.request("/api/knowledge/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: h.worktree, query: "slack mirror retries backoff", project: PROJECT }),
    });
    const json = (await res.json()) as { results: Array<{ slug: string; verification?: string }> };
    expect(json.results.find((r) => r.slug === "retry-policy")?.verification).toBe("pending");
    const stats = (await (await h.app.request(`/api/knowledge/stats?projectId=${PROJECT}`)).json()) as {
      verification: { pending: number };
    };
    expect(stats.verification.pending).toBe(1);
    h.store.close();
  });
});

describe("write-path validation", () => {
  test("a missing slug is rejected", async () => {
    const h = await harness();
    const res = await h.propose({ title: "No slug", body: BODY });
    expect(res.status).toBe(400);
    h.store.close();
  });

  test("tags given as a comma-separated string are normalized; a malformed tag is rejected", async () => {
    const h = await harness();
    const ok = await h.propose({ slug: "tagged", title: "Tagged", body: "unique body text alpha", tags: "Slack, retry" });
    expect(ok.status).toBe(200);
    expect(docRow(h, PROJECT, "tagged")?.tags).toEqual(["slack", "retry"]);
    const bad = await h.propose({ slug: "tagged-2", title: "Tagged", body: "unique body text beta", tags: ["two words"] });
    expect(bad.status).toBe(400);
    // A CSV string cannot smuggle Persona's reserved tag past the proposal guard.
    const persona = await h.propose({ slug: "tagged-3", title: "T", body: "unique body text gamma", tags: "x,persona" });
    expect(persona.status).toBe(400);
    h.store.close();
  });
});

describe("Persona memories", () => {
  test("a new memory restating one the owner's audience holds is refused with the doc to update", async () => {
    const runtime = {
      isOwnWrite: (v: string | undefined) => v === "secret",
      canAct: () => false,
      bindApp: () => {},
      eventListener: () => () => {},
      serveOwnersWithoutRuntime: () => {},
      owner: "alice",
      token: "alice-persona-token",
    } as unknown as PersonaRuntime;
    const h = await harness({ persona: { runtime } });
    const put = (slug: string, body: string) =>
      h.app.request(`/api/projects/global/knowledge/${slug}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", [PERSONA_WRITER_HEADER]: "secret" },
        body: JSON.stringify({ title: "Reply length", body, tags: ["persona"], scope: "user", origin_class: "agent" }),
      });
    upsertProject(h.store.db, { id: "global", name: "Global", branch: "main", repos: [] });
    const body = "The owner wants replies under 150 words unless they ask for detail.";
    expect((await put("persona-memory-reply-length", body)).status).toBe(200);
    const dup = await put("persona-memory-brevity", body);
    expect(dup.status).toBe(422);
    const json = (await dup.json()) as { duplicateOf: { slug: string }; error: string };
    expect(json.duplicateOf.slug).toBe("persona-memory-reply-length");
    expect(json.error).toContain("update that doc");
    h.store.close();
  });
});

describe("drafts stay private to their owner", () => {
  test("another user's personal draft is hidden from the listing and from every mutation", async () => {
    const h = await harness();
    const drafts = join(h.knowledgeDir, PROJECT, ".drafts");
    await mkdir(drafts, { recursive: true });
    await writeFile(
      join(drafts, "bob-draft.md"),
      "---\ntitle: Bob's note\nscope: user\nowner_user: bob\norigin_class: agent\n---\nbob's private draft\n"
    );
    await writeFile(join(drafts, "team-draft.md"), "---\ntitle: Team note\norigin_class: agent\n---\na team draft\n");
    await h.knowledgeSync.syncDrafts(PROJECT);
    const as = (user: string) => ({
      "Content-Type": "application/json",
      [DEFAULT_IDENTITY_HEADER]: user,
      [USER_CHANNEL_HEADER]: userChannelToken(activeOwnerSecrets().ownerToken, user),
    });
    const base = `/api/projects/${PROJECT}/knowledge/drafts`;

    const aliceList = (await (await h.app.request(base, { headers: as("alice") })).json()) as Array<{ slug: string }>;
    expect(aliceList.map((d) => d.slug)).toEqual(["team-draft"]);
    const bobList = (await (await h.app.request(base, { headers: as("bob") })).json()) as Array<{ slug: string }>;
    expect(bobList.map((d) => d.slug).sort()).toEqual(["bob-draft", "team-draft"]);

    const post = (path: string, body: unknown = {}) =>
      h.app.request(`${base}/${path}`, { method: "POST", headers: as("alice"), body: JSON.stringify(body) });
    expect((await post("bob-draft/accept")).status).toBe(404);
    expect((await post("bob-draft/discard")).status).toBe(404);
    expect((await post("bob-draft/revise", { feedback: "shorter" })).status).toBe(404);
    const edit = await h.app.request(`${base}/bob-draft`, {
      method: "PUT",
      headers: as("alice"),
      body: JSON.stringify({ body: "alice was here" }),
    });
    expect(edit.status).toBe(404);
    const all = (await (await post("accept-all")).json()) as { accepted: string[] };
    expect(all.accepted).toEqual(["team-draft"]);
    expect(existsSync(join(drafts, "bob-draft.md"))).toBe(true);
    expect(await readFile(join(drafts, "bob-draft.md"), "utf-8")).toContain("bob's private draft");
    h.store.close();
  });
});

describe("stats", () => {
  test("judge outcomes are counted, judge errors separately from judged answers", async () => {
    const h = await harness();
    recordJudgment(h.store.db, { projectId: PROJECT, subjectSlug: "a", candidateSlug: "b", outcome: "consistent" });
    recordJudgment(h.store.db, {
      projectId: PROJECT,
      subjectSlug: "a",
      candidateSlug: "c",
      outcome: "judge_error",
      reason: "exit 1: 403",
    });
    const stats = (await (await h.app.request(`/api/knowledge/stats?projectId=${PROJECT}`)).json()) as {
      contradictionJudge: Record<string, number>;
    };
    expect(stats.contradictionJudge).toEqual({ contradicts: 0, consistent: 1, judgeError: 1, rejudgeQueued: 0 });
    expect(isRejudgeQueued(h.store.db, PROJECT, "a")).toBe(false);
    h.store.close();
  });
});
