import type { ReviewComment, ReviewMediaInfo, ReviewPacketDetail, ReviewPacketSummary } from "@standup/shared";

/** The instant fixture ages are measured from. */
export const FIXTURE_NOW = new Date("2026-10-08T12:00:00.000Z");

export const DETAIL_ID = "rp-7f3a2c";

function mediaUrl(packetId: string, mediaId: string): string {
  return `/api/reviews/${packetId}/media/${mediaId}`;
}

export const fixtureMedia: ReviewMediaInfo[] = [
  {
    id: "m-list",
    kind: "image",
    mime: "image/png",
    bytes: 182_344,
    caption: "Review list on desktop: pending packets first, with media counts",
    position: 0,
    url: mediaUrl(DETAIL_ID, "m-list"),
  },
  {
    id: "m-detail",
    kind: "image",
    mime: "image/png",
    bytes: 240_118,
    caption: "Packet detail with the diff hunk expanded",
    position: 1,
    url: mediaUrl(DETAIL_ID, "m-detail"),
  },
  {
    id: "m-decision",
    kind: "image",
    mime: "image/png",
    bytes: 96_870,
    caption: "Decision bar: comment box with Request changes and Approve",
    position: 2,
    url: mediaUrl(DETAIL_ID, "m-decision"),
  },
  {
    id: "m-walkthrough",
    kind: "video",
    mime: "video/webm",
    bytes: 1_482_006,
    caption: "Walkthrough: approving a packet moves the pipeline to complete",
    position: 3,
    url: mediaUrl(DETAIL_ID, "m-walkthrough"),
  },
];

export const fixtureDetail: ReviewPacketDetail = {
  id: DETAIL_ID,
  owner: "owner",
  projectId: "standup",
  launchId: "launch-91be",
  jobId: "job-review-tab",
  sessionId: "sess-4c1d9e20",
  pipelineRunId: "run-55a1",
  branch: "standup/review-tab",
  commitSha: "9c41f2e7b8a03d5561e2f0c4a7d9b3e1f6a2c804",
  baseSha: "c4299bc1aa02e6f5d7b3c9e8f1a4d6b2c0e9f713",
  submittedBySession: "4c1d9e20-7a3b-4f1e-9c2d-5b8a6e0f1d37",
  submittedByRootSession: true,
  resubmittedFromOtherSession: false,
  status: "pending",
  revision: 2,
  createdAt: "2026-10-08T11:12:00.000Z",
  updatedAt: "2026-10-08T11:48:00.000Z",
  decidedAt: null,
  decidedBy: null,
  title: "Add the Review tab for human sign-off on delivery pipelines",
  intent:
    "Gives the human_review pipeline stage a place to be decided: a Review tab that lists packets awaiting sign-off and shows each one's intent, diff, validation and media. Approving or requesting changes resumes the waiting pipeline run.",
  changes: [
    {
      area: "Review tab UI",
      bullets: [
        "New /review route with the packet list beside the selected packet on wide screens",
        "Phone layout pages between the list and a single packet with a Back button",
        "Sticky decision bar: approve with an optional comment, request changes with a required one",
      ],
      files: [
        "packages/web/src/components/review/ReviewView.tsx",
        "packages/web/src/components/review/ReviewDetail.tsx",
        "packages/web/src/components/review/DecisionBar.tsx",
      ],
      hunks: [
        {
          file: "packages/web/src/components/Console.tsx",
          header: "@@ -61,7 +61,7 @@ const VIEWS",
          diff: [
            "@@ -61,7 +61,7 @@",
            " // the review queue is surfaced inside Work",
            '-const VIEWS = ["persona", "schedules", "work", "activity", "projects"] as const;',
            '+const VIEWS = ["persona", "schedules", "work", "review", "activity", "projects"] as const;',
            " ",
            " function SessionShortLink({ sessions }: { sessions: Session[] }) {",
          ].join("\n"),
        },
        {
          file: "packages/web/src/App.tsx",
          header: "@@ -268,6 +268,11 @@ handleWsMessage",
          diff: [
            "@@ -268,6 +268,11 @@",
            '       case "persona:schedule":',
            "         setScheduleSignal((n) => n + 1);",
            "         break;",
            " ",
            '+      case "review:updated":',
            "+        publishReviewUpdate(message.payload as ReviewUpdatedPayload);",
            "+        refreshReviewsPending();",
            "+        break;",
            "+",
          ].join("\n"),
        },
      ],
    },
    {
      area: "Live updates",
      bullets: [
        "App fetches the pending count on boot and on every review:updated frame for the tab badge",
        "A small pub/sub fans review:updated out to the mounted Review tab so the list and detail refetch",
      ],
      files: ["packages/web/src/lib/reviewUpdates.ts", "packages/web/src/App.tsx"],
      hunks: [
        {
          file: "packages/web/src/lib/reviewUpdates.ts",
          header: "@@ -0,0 +1,8 @@",
          diff: [
            "@@ -0,0 +1,8 @@",
            "+const listeners = new Set<Listener>();",
            "+",
            "+export function publishReviewUpdate(update: ReviewUpdatedPayload): void {",
            "+  for (const listener of [...listeners]) listener(update);",
            "+}",
          ].join("\n"),
        },
      ],
    },
    {
      area: "Shared hook",
      bullets: ["Extracted the phone breakpoint into useNarrow and reused it from PersonaView"],
      files: ["packages/web/src/hooks/useNarrow.ts", "packages/web/src/components/PersonaView.tsx"],
    },
  ],
  validation: {
    samples: [
      {
        label: "Approve a pending packet",
        input: 'POST /api/reviews/rp-7f3a2c/approve\n{ "comment": "Looks good" }',
        output: '200 OK\n{ "review": { "id": "rp-7f3a2c", "status": "approved", "decidedBy": "owner" } }',
      },
      {
        label: "Request changes without a comment",
        input: "POST /api/reviews/rp-7f3a2c/request-changes\n{}",
        output: '400 Bad Request\n{ "error": "comment is required to request changes" }',
      },
    ],
    tests: { summary: "bun test packages/web — review list, detail, decision bar and view", passed: 412, failed: 0 },
  },
  risks: {
    risks: [
      "Recordings up to 100 MB are kept in the data dir with no retention job yet; disk use grows with each revision",
      "A packet superseded while open keeps its decision bar until the review:updated frame arrives",
    ],
    questions: ["Should approving also post the comment to the linked pull request?"],
  },
  links: [
    { kind: "code_review", label: "#4106 — Review tab", url: "https://github.com/example/standup/pull/4106" },
    { kind: "deploy", label: "Dev stack deploy", url: "https://ci.example.com/pipelines/standup-dev" },
  ],
  media: fixtureMedia,
  comments: [
    {
      id: "c-1",
      author: "owner",
      body: "Revision 1 hid the decision bar behind the fold on phones. Keep it pinned to the bottom.",
      decision: "changes_requested",
      kind: "comment",
      replyTo: null,
      via: null,
      createdAt: "2026-10-08T11:30:00.000Z",
    },
  ],
};

/** A question the worker answered, and one sent to Persona that still waits on its answer. */
export const fixtureQuestions: ReviewComment[] = [
  {
    id: "q-1",
    author: "owner",
    body: "Why does the decision bar stay pinned on desktop too?",
    decision: null,
    kind: "question",
    replyTo: null,
    via: "worker",
    createdAt: "2026-10-09T09:00:00.000Z",
  },
  {
    id: "a-1",
    author: "4f2a91c0-0d3b-4a7e-9a51-6c2f0b8e1d22",
    body: "The packet can run long; pinning keeps the decision one click away wherever you have scrolled.",
    decision: null,
    kind: "answer",
    replyTo: "q-1",
    via: "worker",
    createdAt: "2026-10-09T09:02:00.000Z",
  },
  {
    id: "q-2",
    author: "owner",
    body: "Is there a test for the pinned bar?",
    decision: null,
    kind: "question",
    replyTo: null,
    via: "persona",
    createdAt: "2026-10-09T09:05:00.000Z",
  },
];

/** The packet's revision 2 as it reads when another session, a subagent of the launch's, submitted it. */
export const fixtureDetailOtherSession: ReviewPacketDetail = {
  ...fixtureDetail,
  submittedBySession: "e81f03aa-52c6-4d0b-b7e9-1a2c3d4e5f60",
  submittedByRootSession: false,
  resubmittedFromOtherSession: true,
};

/** A packet from a launch whose worker waived its pipeline stages as not applicable. */
export const fixtureDetailWaived: ReviewPacketDetail = {
  ...fixtureDetail,
  pipeline: {
    status: "complete",
    currentStage: "complete",
    waivers: [
      {
        stageId: "validation",
        title: "Validation",
        by: "worker",
        actor: "worker",
        reason: "Only submits a review packet; no code changed.",
        notApplicable: true,
        at: "2026-10-08T11:40:00.000Z",
      },
      {
        stageId: "review",
        title: "Adversarial review",
        by: "persona",
        actor: "owner's Persona",
        reason: "Nothing to review: the launch changed no files.",
        notApplicable: true,
        at: "2026-10-08T11:41:00.000Z",
      },
    ],
  },
};

/** A packet from a coded launch whose held review Persona waived, accepting its wontfix findings. */
export const fixtureDetailWontfixAccepted: ReviewPacketDetail = {
  ...fixtureDetail,
  pipeline: {
    status: "active",
    currentStage: "human_review",
    waivers: [
      {
        stageId: "review",
        title: "Adversarial review",
        by: "persona",
        actor: "owner's Persona",
        reason: "Schema drift is tracked in job 5e6f7a8b, which owns the migration; nothing else is left open.",
        notApplicable: false,
        wontfixFindings: [{ reviewer: "r1", severity: "high", title: "schema drift" }],
        at: "2026-10-08T11:41:00.000Z",
      },
    ],
  },
};

/** A packet from a launch that ran with its pipeline off. */
export const fixtureDetailPipelineOff: ReviewPacketDetail = {
  ...fixtureDetail,
  pipeline: { status: "disabled", disabledReason: "opt_out", currentStage: "start", waivers: [] },
};

/** The older fixture packets name no worker. */
const NO_WORKER = { launchId: null, jobId: null, sessionId: null };

export const fixtureSummaries: ReviewPacketSummary[] = [
  {
    id: DETAIL_ID,
    owner: fixtureDetail.owner,
    projectId: fixtureDetail.projectId,
    launchId: fixtureDetail.launchId,
    jobId: fixtureDetail.jobId,
    sessionId: fixtureDetail.sessionId,
    branch: fixtureDetail.branch,
    commitSha: fixtureDetail.commitSha,
    title: fixtureDetail.title,
    intent: fixtureDetail.intent,
    status: "pending",
    revision: 2,
    createdAt: fixtureDetail.createdAt,
    updatedAt: fixtureDetail.updatedAt,
    imageCount: 3,
    videoCount: 1,
    openQuestions: 0,
  },
  {
    id: "rp-19d0b4",
    owner: "owner",
    projectId: "standup",
    ...NO_WORKER,
    branch: "standup/kb-dedup-threshold",
    commitSha: "4be1907c22f3a8d61e0b5c7a9d3f2e8b1c6a4d05",
    title: "Raise the knowledge dedup threshold for short docs",
    intent: "Stops one-line gotchas from being merged into unrelated longer docs.",
    status: "pending",
    revision: 1,
    createdAt: "2026-10-08T09:02:00.000Z",
    updatedAt: "2026-10-08T09:05:00.000Z",
    imageCount: 1,
    videoCount: 0,
    openQuestions: 0,
  },
  {
    id: "rp-0c8e51",
    owner: "owner",
    projectId: "exports",
    ...NO_WORKER,
    branch: "exports/backoff",
    commitSha: "e07a3d915b2c4f8a6d1e9b0c3f5a7d2e4b6c8a91",
    title: "Back off the nightly export job after rate limiting",
    intent: "Retries rate-limited upload calls with jitter instead of failing the export.",
    status: "changes_requested",
    revision: 1,
    createdAt: "2026-10-07T16:40:00.000Z",
    updatedAt: "2026-10-07T18:10:00.000Z",
    imageCount: 0,
    videoCount: 0,
    openQuestions: 0,
  },
  {
    id: "rp-a41f77",
    owner: "owner",
    projectId: "standup",
    ...NO_WORKER,
    branch: "standup/persona-threads",
    commitSha: "2f9c0d8e1a7b3c5d4e6f8a0b2c4d6e8f0a1b3c5d",
    title: "Persona thread switcher keeps unread dots across reloads",
    intent: "Persists the last-viewed marker per thread.",
    status: "approved",
    revision: 1,
    createdAt: "2026-10-06T13:00:00.000Z",
    updatedAt: "2026-10-06T15:22:00.000Z",
    imageCount: 2,
    videoCount: 1,
    openQuestions: 0,
  },
  {
    id: "rp-5b2e90",
    owner: "owner",
    projectId: "standup",
    ...NO_WORKER,
    branch: "standup/persona-threads",
    commitSha: "71b3e5c9d0a2f4e6b8c1d3a5f7e9b0c2d4e6f8a1",
    title: "Persona thread switcher (first attempt)",
    intent: "Superseded by revision 2.",
    status: "superseded",
    revision: 1,
    createdAt: "2026-10-06T10:00:00.000Z",
    updatedAt: "2026-10-06T12:55:00.000Z",
    imageCount: 0,
    videoCount: 0,
    openQuestions: 0,
  },
];

export const pendingSummaries: ReviewPacketSummary[] = fixtureSummaries.filter((s) => s.status === "pending");
