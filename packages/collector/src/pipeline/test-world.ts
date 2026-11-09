import { afterAll, beforeAll } from "bun:test";
import { randomUUID } from "crypto";
import { deflateSync } from "zlib";
import { realpathSync, writeFileSync } from "fs";
import { join } from "path";
import {
  createLaunch,
  createPersonaJob,
  createReviewPacket,
  createSession,
  createStore,
  createTicket,
  findDraftReviewPacketForLaunch,
  getOrCreatePersonaConsoleThread,
  latestSubmittedReviewPacketForLaunch,
  linkPersonaJobLaunch,
  personaJobForLaunch,
  setLaunchReviewTokenHash,
  setPipelineConfig,
  submitReviewPacket,
  updateTicketStatus,
  upsertProject,
} from "@standup/store";
import type { Store } from "@standup/store";
import type {
  Launch,
  PipelineOverride,
  PipelineRun,
  Project,
  CodeReviewAdapterId,
  ReviewDecision,
  ReviewPacketDraft,
  WsMessage,
} from "@standup/shared";
import { DEFAULT_IDENTITY_HEADER, WORKER_TOKEN_HEADER } from "@standup/shared";
import { OWNER_TOKEN_HEADER } from "@standup/shared/owner-token";
import { workerTokenHash } from "../floor/gate.js";
import { reviewScratchDirFor } from "../review/media.js";
import { createServer } from "../server.js";
import { setTitleSummaryEnabled } from "../auto-checkpoint.js";
import { generateOwnerSecrets } from "../owner-secret.js";
import { startPipelineForLaunch, type HeadState, type PipelineDeps } from "./engine.js";
import type { ReviewTunnels } from "../review-tunnel/manager.js";
import { screenshotStore, validateScreenshotPath } from "./screenshots.js";
import { testTempDir } from "../test-support/temp-dirs.js";
import { DEFAULT_ORG_PROFILE } from "../org-profile/default.js";
import { mergeOrgProfile, setActiveOrgProfile } from "../org-profile/load.js";
import type { OrgProfile } from "../org-profile/types.js";

/**
 * An org profile whose review tool attaches the owner's issue id (its
 * codeReview.cutCommand names `{issueId}`): a `generic` project's code_review
 * stage then refuses a worker's report without one, and the run waits for
 * the owner to give it.
 */
export const ISSUE_ID_REVIEW_PROFILE: OrgProfile = mergeOrgProfile(DEFAULT_ORG_PROFILE, {
  name: "issue-id-reviews",
  codeReview: { cutCommand: "review-tool --issue {issueId} --description {descriptionFile}" },
}).profile;

/** Runs the enclosing describe block's tests (or the file's, at top level) under ISSUE_ID_REVIEW_PROFILE. */
export function withIssueIdReviews(): void {
  beforeAll(() => setActiveOrgProfile(ISSUE_ID_REVIEW_PROFILE));
  afterAll(() => setActiveOrgProfile());
}

/**
 * An in-memory world for pipeline tests: a project, one launched worker
 * session with its pipeline run, fake side effects (changed files, criterion)
 * and a collector app over the same store. Every temp dir a world makes is a
 * testTempDir, removed when the test run ends.
 */

export const OWNER = "alice";
export const WORKTREE = "/tmp/standup-pipeline-test/wt";

export interface World {
  store: Store;
  app: ReturnType<typeof createServer>;
  launch: Launch;
  sessionId: string;
  run: PipelineRun;
  broadcasts: WsMessage[];
  checkpoints: string[];
  /** What the fake git reports as changed; null makes it fail. */
  changed: { files: string[] | null };
  /** The fake checkout's HEAD and reflog (a fresh worktree by default). */
  head: HeadState;
  deps: PipelineDeps;
  secrets: ReturnType<typeof generateOwnerSecrets>;
  /** The launch's worktree path. */
  worktree: string;
}

let sharedReviewDataDir: string | null = null;

/** One scratch data dir for every world's review routes: tokens are per launch, so worlds don't collide. */
function reviewDataDir(): string {
  sharedReviewDataDir ??= testTempDir("standup-review-data-");
  return sharedReviewDataDir;
}

export function makeWorld(
  opts: {
    persona?: boolean;
    disabled?: boolean;
    issueId?: string;
    override?: PipelineOverride;
    /** The owner's layer for the world's project, over `override`. */
    projectOverride?: PipelineOverride;
    /** The launch's worktree (default WORKTREE). */
    worktree?: string;
    /** The app runs the real criterion and checks (a shell in the worktree) instead of the fakes. */
    realCommands?: boolean;
    /**
     * The project's code-review adapter; `null` leaves it unset, for a plain
     * git repo with no code review to cut (the code_review stage doesn't
     * apply there). Defaults to `generic`: a project opted in to a linked
     * code review, whose code_review stage does.
     */
    reviewArtifact?: CodeReviewAdapterId | null;
    project?: Partial<Project>;
    provisioned?: boolean;
    /** Builds the review-tunnel manager the server uses, over the world's store. */
    reviewTunnels?: (store: Store, broadcast: (m: WsMessage) => void) => ReviewTunnels;
  } = {}
): World {
  const worktree = opts.worktree ?? WORKTREE;
  const store = createStore(":memory:");
  // A long first prompt would have the title summarizer run the real `claude`
  // CLI, which writes into the run's temp dir and the host's Standup dirs.
  setTitleSummaryEnabled(store.db, false);
  upsertProject(store.db, {
    id: "proj",
    name: "P",
    branch: "main",
    // A plain git project's repo, whose origin is on GitHub, is what shows it has no code review to cut.
    repos: opts.reviewArtifact === null ? [plainGitRepo()] : [],
    ...(opts.reviewArtifact === null ? {} : { codeReviewAdapter: opts.reviewArtifact ?? "generic" }),
    ...opts.project,
  });
  const sessionId = `sess-${randomUUID().slice(0, 8)}`;
  createSession(store.db, { id: sessionId, projectId: "proj", title: "Worker", cwd: worktree, status: "running" });
  const launch = createLaunch(store.db, {
    id: randomUUID(),
    projectId: "proj",
    task: "ship the thing",
    worktreePath: worktree,
    branch: "standup/thing",
    baseBranch: "main",
    status: "running",
    sessionId,
    requester: OWNER,
    launchedBy: OWNER,
    provisioned: opts.provisioned,
  });
  if (opts.issueId !== undefined) {
    const ticket = createTicket(store.db, { projectId: "proj", lens: "bugs", title: "Fix", body: "…", issueId: opts.issueId || undefined });
    store.db.run("UPDATE tickets SET launch_id = ? WHERE id = ?", [launch.id, ticket.id]);
    updateTicketStatus(store.db, ticket.id, "approved");
    updateTicketStatus(store.db, ticket.id, "developing");
  }
  if (opts.persona) {
    const thread = getOrCreatePersonaConsoleThread(store.db, OWNER);
    const job = createPersonaJob(store.db, { owner: OWNER, threadId: thread.id, title: "Job", goal: "ship it" });
    linkPersonaJobLaunch(store.db, job.id, launch.id);
  }
  if (opts.override) setPipelineConfig(store.db, OWNER, null, opts.override);
  if (opts.projectOverride) setPipelineConfig(store.db, OWNER, "proj", opts.projectOverride);
  const run = startPipelineForLaunch(store.db, { launchId: launch.id, owner: OWNER, projectId: "proj", disabled: opts.disabled });

  const broadcasts: WsMessage[] = [];
  const checkpoints: string[] = [];
  const changed: { files: string[] | null } = { files: ["packages/collector/src/x.ts"] };
  const head: HeadState = { head: "a".repeat(40), reflog: [`${"a".repeat(40)} `] };
  const secrets = generateOwnerSecrets();
  const fakes: Pick<PipelineDeps, "runCriterion" | "runCheck"> = {
    runCriterion: async () => null,
    runCheck: async () => ({ met: true, output: "ok" }),
  };
  const overrides = {
    changedFiles: async () => {
      if (changed.files === null) throw new Error("not a git checkout");
      return changed.files;
    },
    headState: async () => ({ head: head.head, reflog: [...head.reflog] }),
    ...(opts.realCommands ? {} : fakes),
    validateScreenshot: (p: string) => validateScreenshotPath(p),
    screenshots: screenshotStore(join(testTempDir("standup-shot-store-"), "pipeline-screenshots")),
  };
  const record = (m: WsMessage) => {
    broadcasts.push(m);
    if (m.type === "checkpoint:new") checkpoints.push((m.payload as { summary: string }).summary);
  };
  const app = createServer(
    store,
    record,
    null,
    undefined,
    undefined,
    "",
    "",
    {},
    undefined,
    undefined,
    undefined,
    undefined,
    { ownerSecrets: secrets },
    {},
    {},
    overrides,
    // Review tokens and media copies go to a scratch data dir, never the real one.
    { dataDir: reviewDataDir() },
    {},
    opts.reviewTunnels?.(store, record)
  );
  const deps: PipelineDeps = {
    ...fakes,
    ...overrides,
    broadcast: (m) => broadcasts.push(m),
    checkpoint: (_s, text) => checkpoints.push(text),
    // The same scratch data dir the world's review routes use, never the real one.
    reviewScratchDir: (launchId) => reviewScratchDirFor(reviewDataDir(), launchId),
  };
  return { store, app, launch, sessionId, run, broadcasts, checkpoints, changed, head, deps, secrets, worktree };
}

/**
 * A fresh git repo under os.tmpdir() whose `origin` remote is on GitHub, as a
 * plain git project's is — or, with `origin` null, a local-only repo with no
 * remote at all.
 */
export function plainGitRepo(origin: string | null = "https://github.com/example/plain.git"): string {
  const dir = testTempDir("standup-plain-repo-");
  const steps = [["init", "--quiet", "--initial-branch=main"], ...(origin ? [["config", "remote.origin.url", origin]] : [])];
  for (const args of steps) {
    const proc = Bun.spawnSync(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`);
  }
  return dir;
}

/** POSTs JSON to the world's app. */
export async function post(w: World, path: string, body: unknown, headers: Record<string, string> = {}) {
  return w.app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

/** The worker's pipeline_advance call. */
export async function advance(w: World, stage: string, evidence?: unknown, skip?: { reason: string }) {
  const res = await post(w, "/api/pipeline/advance", { session_id: w.sessionId, cwd: w.worktree, stage, evidence, skip });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

/** What the review-writer puts in the packet the owner decides. */
export const REVIEW_DRAFT: ReviewPacketDraft = {
  title: "Ship the thing",
  intent: "Implements the task the launch was given.",
  changes: [{ area: "Collector", bullets: ["Changes x.ts"], files: ["packages/collector/src/x.ts"] }],
  validation: { samples: [{ label: "tests", input: "bun test", output: "all green" }] },
  risks: { risks: [], questions: [] },
  links: [],
};

/**
 * Puts a review packet for the launch in the owner's Review tab — what the
 * run needs before it may reach its code_review stage or be handed to the owner (see
 * reviewPacketNeeded). Returns its id.
 */
export function submitPacket(w: World): string {
  const packet =
    findDraftReviewPacketForLaunch(w.store.db, OWNER, w.launch.id) ??
    createReviewPacket(w.store.db, {
      owner: OWNER,
      launchId: w.launch.id,
      sessionId: w.sessionId,
      jobId: personaJobForLaunch(w.store.db, w.launch.id)?.job.id,
      projectId: "proj",
    });
  if (!submitReviewPacket(w.store.db, { id: packet.id, owner: OWNER, draft: REVIEW_DRAFT })) {
    throw new Error(`review packet ${packet.id} could not be submitted`);
  }
  return packet.id;
}

/**
 * The worker's submit_review_packet call: the packet goes through the review
 * route, with every check a real submission meets (the code-review link of a
 * project whose adapter requires one among them), under a fresh review token
 * for the launch.
 */
export async function submitPacketAsWorker(w: World, draft: Partial<ReviewPacketDraft> = {}) {
  const token = `review-token-${randomUUID()}`;
  setLaunchReviewTokenHash(w.store.db, w.launch.id, workerTokenHash(token));
  const res = await post(w, "/api/reviews/submit", { session_id: w.sessionId, packet: { ...REVIEW_DRAFT, ...draft } }, { [WORKER_TOKEN_HEADER]: token });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

/**
 * The owner's side of the human_review stage: submits the draft packet the
 * stage opened for the launch and decides it in the console, which reports the
 * decision to the waiting run. Requesting changes carries the comment the
 * route requires.
 */
export async function decideHumanReview(w: World, decision: ReviewDecision, comment = "rework the retry path") {
  // The packet the run reached review with, else one submitted now.
  const pending = latestSubmittedReviewPacketForLaunch(w.store.db, w.launch.id);
  const packetId = pending?.status === "pending" ? pending.id : submitPacket(w);
  const path = decision === "approved" ? "approve" : "request-changes";
  const res = await post(w, `/api/reviews/${packetId}/${path}`, decision === "approved" ? {} : { comment }, human(w));
  return { packetId, status: res.status, body: (await res.json()) as Record<string, any> };
}

/** The owner approving the launch's review packet, which passes human_review. */
export async function approveHumanReview(w: World) {
  return decideHumanReview(w, "approved");
}

/** Headers of a signed-in human `alias` in the console. */
export function human(w: World, alias = OWNER): Record<string, string> {
  return { [OWNER_TOKEN_HEADER]: w.secrets.ownerToken, [DEFAULT_IDENTITY_HEADER]: alias };
}

export const EVIDENCE = {
  coding: { summary: "implemented the change" },
  validationPass: { commands: [{ command: "bun test", exitCode: 0, summary: "all green" }] },
  validationFail: { commands: [{ command: "bun test", exitCode: 1, summary: "2 failing" }] },
  reviewClean: {
    reviewers: [
      { name: "r1", findings: [{ severity: "low", title: "nit", status: "open" }] },
      { name: "r2", findings: [] },
    ],
  },
  reviewHigh: {
    reviewers: [
      { name: "r1", findings: [{ severity: "high", title: "data loss on retry", status: "open" }] },
      { name: "r2", findings: [] },
    ],
  },
  deploy: {
    account: "123456789012",
    region: "us-west-2",
    stacks: ["MyStack-beta"],
    liveSamples: [{ request: "GET /health", response: "200 ok", ok: true }],
  },
};

/** Writes a real `width`×`height` RGB PNG under a fresh os.tmpdir() directory and returns its path. */
export function writeTinyPng(width = 2, height = 1, name = "shot.png"): string {
  // Real path, as the screenshot roots are spelled.
  const dir = realpathSync(testTempDir("standup-shot-"));
  const path = join(dir, name);
  writeFileSync(path, pngBytes(width, height));
  return path;
}

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

export function pngBytes(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor
  const raw = Buffer.alloc((width * 3 + 1) * height);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
