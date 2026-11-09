import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { CodeReviewLinkFormat, ReviewLink, ReviewPacketDetail } from "@standup/shared";
import { createReviewPacket, personaJobForLaunch, submitReviewPacket } from "@standup/store";
import { DEFAULT_ORG_PROFILE } from "../org-profile/default.js";
import { setActiveOrgProfile } from "../org-profile/load.js";
import type { OrgProfile } from "../org-profile/types.js";
import { human, makeWorld, OWNER, REVIEW_DRAFT } from "../pipeline/test-world.js";

/** An org's review tool whose reviews are `R-<n>` at the top of review.example.corp. */
const CORP_FORMAT: CodeReviewLinkFormat = {
  urlPattern: String.raw`^https://review\.example\.corp/(R-\d+)(?:[/?#]|$)`,
  idPattern: String.raw`\bR-\d+\b`,
  urlTemplate: "https://review.example.corp/{id}",
};

const CORP_PROFILE: OrgProfile = {
  ...DEFAULT_ORG_PROFILE,
  codeReview: { ...DEFAULT_ORG_PROFILE.codeReview, linkFormat: CORP_FORMAT },
};

/**
 * The review page's read of a packet with `links`, its project reviewing on
 * the generic adapter (`generic`) or on whatever detects it (`detected`: the
 * default link format). `packetProject: null` files the packet under no
 * project, so only its launch names one.
 */
async function detailOf(adapter: "generic" | "detected", links: ReviewLink[], packetProject: string | null = "proj"): Promise<ReviewPacketDetail> {
  const w = makeWorld({ persona: true, reviewArtifact: adapter === "generic" ? "generic" : null });
  const jobId = personaJobForLaunch(w.store.db, w.launch.id)!.job.id;
  const packet = createReviewPacket(w.store.db, {
    owner: OWNER,
    launchId: w.launch.id,
    sessionId: w.sessionId,
    jobId,
    ...(packetProject ? { projectId: packetProject } : {}),
  });
  expect(submitReviewPacket(w.store.db, { id: packet.id, owner: OWNER, draft: { ...REVIEW_DRAFT, links } })).not.toBeNull();
  const res = await w.app.request(`/api/reviews/${packet.id}`, { headers: human(w) });
  expect(res.status).toBe(200);
  return ((await res.json()) as { review: ReviewPacketDetail }).review;
}

describe("GET /api/reviews/:id: the packet's code review is read under its project's adapter", () => {
  beforeEach(() => setActiveOrgProfile(CORP_PROFILE));
  afterEach(() => setActiveOrgProfile());

  const corpUrl = "https://review.example.corp/R-77";
  const prUrl = "https://github.com/o/r/pull/12";
  const cases: Array<[string, "generic" | "detected", ReviewLink[], { id: string; url: string } | null]> = [
    ["the adapter's pattern reads the id, not the URL's last segment", "generic", [{ kind: "code_review", label: "R-77", url: `${corpUrl}/diff` }], { id: "R-77", url: `${corpUrl}/diff` }],
    ["the default format reads the URL's last segment", "detected", [{ kind: "code_review", label: "R-77", url: `${corpUrl}/diff` }], { id: "diff", url: `${corpUrl}/diff` }],
    ["a bare id becomes the adapter's page for it", "generic", [{ kind: "code_review", label: "R-88", url: "R-88" }], { id: "R-88", url: "https://review.example.corp/R-88" }],
    ["the default format reads no review from a bare id", "detected", [{ kind: "code_review", label: "R-88", url: "R-88" }], null],
    ["the adapter's pattern finds the review among other links", "generic", [{ kind: "other", label: "review", url: corpUrl }], { id: "R-77", url: corpUrl }],
    ["the default format reads no review from a link of another kind", "detected", [{ kind: "other", label: "review", url: corpUrl }], null],
    ["a code_review link off the adapter's pattern names none", "generic", [{ kind: "code_review", label: "#12", url: prUrl }], null],
    ["the default format reads any http(s) code_review link", "detected", [{ kind: "code_review", label: "#12", url: prUrl }], { id: "12", url: prUrl }],
  ];
  for (const [name, adapter, links, expected] of cases) {
    test(name, async () => {
      expect((await detailOf(adapter, links)).codeReview).toEqual(expected);
    });
  }

  test("a packet filed under no project is read under its launch's project's adapter", async () => {
    const detail = await detailOf("generic", [{ kind: "code_review", label: "R-88", url: "R-88" }], null);
    expect(detail.projectId).toBeNull();
    expect(detail.codeReview).toEqual({ id: "R-88", url: "https://review.example.corp/R-88" });
  });
});
