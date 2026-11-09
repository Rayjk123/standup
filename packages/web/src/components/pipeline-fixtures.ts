import { DEFAULT_PIPELINE } from "@standup/shared";
import type {
  CodingEvidence,
  CodeReviewEvidence,
  DeployEvidence,
  PipelineAttemptStatus,
  PipelineRun,
  PipelineStageAttempt,
  ReviewEvidence,
  ScreenshotEvidence,
  ValidationEvidence,
} from "@standup/shared";

// ============================================================================
// Realistic pipeline runs for tests and for the mocked API the console is
// screenshotted against. Both follow DEFAULT_PIPELINE.
// ============================================================================

/** Builds attempts in order, numbering each stage's attempts and spacing timestamps a few minutes apart. */
function attempts(
  runId: string,
  startedAt: string,
  rows: Array<{
    stageId: string;
    status: PipelineAttemptStatus;
    nextStage?: string;
    evidence?: unknown;
    reason?: string;
  }>
): PipelineStageAttempt[] {
  const counts = new Map<string, number>();
  const base = new Date(startedAt).getTime();
  return rows.map((row, i) => {
    const attempt = (counts.get(row.stageId) ?? 0) + 1;
    counts.set(row.stageId, attempt);
    return {
      id: `${runId}-a${i + 1}`,
      runId,
      stageId: row.stageId,
      attempt,
      status: row.status,
      ...(row.evidence !== undefined ? { evidence: row.evidence } : {}),
      ...(row.reason !== undefined ? { reason: row.reason } : {}),
      sessionId: "sess-7f3a91c2",
      ...(row.nextStage !== undefined ? { nextStage: row.nextStage } : {}),
      createdAt: new Date(base + (i + 1) * 4 * 60_000).toISOString(),
    };
  });
}

const firstCoding: CodingEvidence = {
  summary: "Added the retention-window setting to the project editor and wired it to PUT /api/projects/:id.",
  commits: ["4e1c9a2"],
  changedFiles: [
    "packages/web/src/components/ProjectEditor.tsx",
    "packages/collector/src/routes/projects.ts",
    "packages/store/src/queries/projects.ts",
  ],
};

const failedValidation: ValidationEvidence = {
  commands: [
    { command: "bun run typecheck", exitCode: 0, summary: "no type errors" },
    {
      command: "bun test packages/store",
      exitCode: 1,
      summary: "1 fail: projects > updateProject keeps retentionDays when the patch omits it",
    },
  ],
};

const fixCoding: CodingEvidence = {
  summary: "updateProject now merges the patch instead of replacing the row, so omitted fields keep their values.",
  commits: ["9b07d3e"],
  changedFiles: ["packages/store/src/queries/projects.ts", "packages/store/src/queries/projects.test.ts"],
};

const greenValidation: ValidationEvidence = {
  commands: [
    { command: "bun run typecheck", exitCode: 0, summary: "no type errors" },
    { command: "bun test packages/store", exitCode: 0, summary: "412 pass, 0 fail" },
    { command: "bun test packages/web", exitCode: 0, summary: "188 pass, 0 fail" },
  ],
  criterion: { command: "bun test packages/store/src/queries/projects.test.ts", met: true, output: "18 pass" },
};

const blockingReview: ReviewEvidence = {
  reviewers: [
    {
      name: "correctness-reviewer",
      findings: [
        { severity: "high", title: "retentionDays accepts 0, which deletes every transcript on the next sweep", status: "open" },
        { severity: "low", title: "Help text says 'days' but the input allows decimals", status: "open" },
      ],
    },
    {
      name: "security-reviewer",
      findings: [{ severity: "medium", title: "PUT does not check the caller owns the project", status: "fixed" }],
    },
  ],
};

const reviewFixCoding: CodingEvidence = {
  summary: "Clamped retentionDays to 1..365 on both the input and the route; integer-only input.",
  commits: ["c51e8f0"],
  changedFiles: ["packages/web/src/components/ProjectEditor.tsx", "packages/collector/src/routes/projects.ts"],
};

const cleanReview: ReviewEvidence = {
  reviewers: [
    {
      name: "correctness-reviewer",
      findings: [
        { severity: "high", title: "retentionDays accepts 0, which deletes every transcript on the next sweep", status: "fixed" },
        { severity: "low", title: "Help text says 'days' but the input allows decimals", status: "fixed" },
      ],
    },
    { name: "security-reviewer", findings: [] },
  ],
};

const deploy: DeployEvidence = {
  account: "111122223333",
  region: "us-west-2",
  stacks: ["standup-dev-api", "standup-dev-web"],
  liveSamples: [
    {
      request: 'PUT /api/projects/standup {"retentionDays": 30}',
      response: '200 {"id":"standup","retentionDays":30}',
      ok: true,
    },
    {
      request: 'PUT /api/projects/standup {"retentionDays": 0}',
      response: '400 {"error":"retentionDays must be between 1 and 365"}',
      ok: true,
    },
  ],
  floorAsks: [
    {
      askId: "ask-5d21",
      gate: "safety_floor",
      question: "Allow `npx cdk deploy standup-dev-api --exclusively`?",
      answer: "allow",
      status: "answered",
    },
  ],
};

const screenshots: ScreenshotEvidence = {
  screenshots: [
    {
      path: "/tmp/standup-screenshots-1000/project-editor-retention.png",
      caption: "Project editor with the retention window set to 30 days",
      width: 1440,
      height: 900,
    },
    {
      path: "/tmp/standup-screenshots-1000/project-editor-retention-error.png",
      caption: "Inline error when the window is set to 0",
      width: 1440,
      height: 900,
    },
  ],
};

const UI_RUN_ID = "prun-ui-3c8e";

/**
 * A UI change mid-flight: a failed validation and a blocking review each
 * looped back to coding once, deploy and screenshots passed, and the run now
 * waits at the code review stage for the owner's issue id.
 */
export const sampleRunUiChange: PipelineRun = {
  id: UI_RUN_ID,
  launchId: "launch-ui-3c8e",
  owner: "owner",
  projectId: "standup",
  definition: DEFAULT_PIPELINE,
  definitionHash: "a41f0c9e7b2d5e13",
  currentStage: "code_review",
  status: "waiting_user",
  waitingReason: "code review stage needs an issue id from you",
  waitingKind: "owner_input",
  facts: { ui_changed: true, docs_only: false },
  stopBlocks: 0,
  stageEnteredAt: "2026-10-08T15:48:00.000Z",
  createdAt: "2026-10-08T15:00:00.000Z",
  updatedAt: "2026-10-08T15:48:00.000Z",
  attempts: attempts(UI_RUN_ID, "2026-10-08T15:00:00.000Z", [
    { stageId: "start", status: "passed", nextStage: "coding", reason: "start reached" },
    { stageId: "coding", status: "passed", nextStage: "validation", evidence: firstCoding, reason: "coding reported done" },
    {
      stageId: "validation",
      status: "failed",
      nextStage: "coding",
      evidence: failedValidation,
      reason: "`bun test packages/store` exited 1",
    },
    { stageId: "coding", status: "passed", nextStage: "validation", evidence: fixCoding, reason: "coding reported done" },
    {
      stageId: "validation",
      status: "passed",
      nextStage: "review",
      evidence: greenValidation,
      reason: "3 command(s) exited 0; acceptance criterion met",
    },
    {
      stageId: "review",
      status: "failed",
      nextStage: "coding",
      evidence: blockingReview,
      reason: "1 open High/Medium finding(s): [high] retentionDays accepts 0, which deletes every transcript on the next sweep",
    },
    { stageId: "coding", status: "passed", nextStage: "validation", evidence: reviewFixCoding, reason: "coding reported done" },
    {
      stageId: "validation",
      status: "passed",
      nextStage: "review",
      evidence: greenValidation,
      reason: "3 command(s) exited 0; acceptance criterion met",
    },
    {
      stageId: "review",
      status: "passed",
      nextStage: "deploy",
      evidence: cleanReview,
      reason: "no open High/Medium findings from 2 reviewer(s)",
    },
    { stageId: "deploy", status: "passed", nextStage: "screenshot", evidence: deploy, reason: "2 live sample(s) ok" },
    { stageId: "screenshot", status: "passed", nextStage: "code_review", evidence: screenshots, reason: "2 screenshot(s) recorded" },
  ]),
};

const NO_UI_RUN_ID = "prun-api-91d4";

const apiCoding: CodingEvidence = {
  summary: "GET /api/launches accepts ?status= and filters in SQL instead of in memory.",
  commits: ["e2a6b71"],
  changedFiles: ["packages/collector/src/routes/launches.ts", "packages/store/src/queries/launches.ts"],
};

const apiValidation: ValidationEvidence = {
  commands: [
    { command: "bun run typecheck", exitCode: 0, summary: "no type errors" },
    { command: "bun test packages/collector packages/store", exitCode: 0, summary: "907 pass, 0 fail" },
  ],
};

const apiReview: ReviewEvidence = {
  reviewers: [
    {
      name: "correctness-reviewer",
      findings: [{ severity: "low", title: "Unknown status values return an empty list rather than a 400", status: "wontfix" }],
    },
    { name: "performance-reviewer", findings: [] },
  ],
};

const apiDeploy: DeployEvidence = {
  account: "111122223333",
  region: "us-west-2",
  stacks: ["standup-dev-api"],
  liveSamples: [
    { request: "GET /api/launches?status=running", response: '200 [{"id":"launch-0a1","status":"running"}]', ok: true },
  ],
};

const apiReviewLink: CodeReviewEvidence = {
  reviewId: "3610",
  url: "https://github.com/example/standup/pull/3610",
  issueId: "STANDUP-1432",
  floorAsks: [
    {
      askId: "ask-8e40",
      gate: "safety_floor",
      question: "Allow `gh pr create --draft --title 'Filter launches by status'`?",
      answer: "allow",
      status: "answered",
    },
  ],
};

/** A backend-only change that ran straight through: the screenshot stage auto-skipped and the run is complete. */
export const sampleRunNoUi: PipelineRun = {
  id: NO_UI_RUN_ID,
  launchId: "launch-api-91d4",
  owner: "owner",
  projectId: "standup",
  definition: DEFAULT_PIPELINE,
  definitionHash: "a41f0c9e7b2d5e13",
  currentStage: "complete",
  status: "complete",
  facts: { ui_changed: false, docs_only: false },
  stopBlocks: 0,
  stageEnteredAt: "2026-10-08T12:28:00.000Z",
  createdAt: "2026-10-08T12:00:00.000Z",
  updatedAt: "2026-10-08T12:28:00.000Z",
  attempts: attempts(NO_UI_RUN_ID, "2026-10-08T12:00:00.000Z", [
    { stageId: "start", status: "passed", nextStage: "coding", reason: "start reached" },
    { stageId: "coding", status: "passed", nextStage: "validation", evidence: apiCoding, reason: "coding reported done" },
    {
      stageId: "validation",
      status: "passed",
      nextStage: "review",
      evidence: apiValidation,
      reason: "2 command(s) exited 0",
    },
    {
      stageId: "review",
      status: "passed",
      nextStage: "deploy",
      evidence: apiReview,
      reason: "no open High/Medium findings from 2 reviewer(s)",
    },
    { stageId: "deploy", status: "passed", nextStage: "code_review", evidence: apiDeploy, reason: "1 live sample(s) ok" },
    { stageId: "screenshot", status: "skipped", nextStage: "code_review", reason: "auto-skipped: ui_changed is false" },
    { stageId: "code_review", status: "passed", nextStage: "complete", evidence: apiReviewLink, reason: "code review 3610 recorded" },
  ]),
};

const WONTFIX_RUN_ID = "prun-wontfix-4990";

const heldReview: ReviewEvidence = {
  reviewers: [
    { name: "correctness-reviewer", findings: [{ severity: "high", title: "Session token rotation races the refresh path", status: "wontfix" }] },
    { name: "security-reviewer", findings: [{ severity: "low", title: "Log line names the session id", status: "open" }] },
  ],
};

/**
 * A coded launch whose review held on a wontfix High, which Persona then
 * waived, accepting the finding as tracked elsewhere; the run is at deploy.
 */
export const sampleRunWontfixAccepted: PipelineRun = {
  id: WONTFIX_RUN_ID,
  launchId: "launch-wontfix-4990",
  owner: "owner",
  projectId: "standup",
  definition: DEFAULT_PIPELINE,
  definitionHash: "a41f0c9e7b2d5e13",
  currentStage: "deploy",
  status: "active",
  facts: { ui_changed: false, docs_only: false },
  stopBlocks: 0,
  stageEnteredAt: "2026-10-08T13:20:00.000Z",
  createdAt: "2026-10-08T13:00:00.000Z",
  updatedAt: "2026-10-08T13:20:00.000Z",
  attempts: attempts(WONTFIX_RUN_ID, "2026-10-08T13:00:00.000Z", [
    { stageId: "start", status: "passed", nextStage: "coding", reason: "start reached" },
    { stageId: "coding", status: "passed", nextStage: "validation", evidence: apiCoding, reason: "coding reported done" },
    { stageId: "validation", status: "passed", nextStage: "review", evidence: apiValidation, reason: "2 command(s) exited 0" },
    {
      stageId: "review",
      status: "failed",
      evidence: heldReview,
      reason: "1 unresolved High/Medium finding(s): [high, wontfix] Session token rotation races the refresh path",
    },
    {
      stageId: "review",
      status: "waived",
      nextStage: "deploy",
      evidence: {
        waiver: {
          by: "persona",
          actor: "owner's Persona",
          reason: "Session token rotation races the refresh path: tracked in job 1a2b3c4d, which owns the refresh path; out of scope here.",
          notApplicable: false,
          wontfixAccepted: {
            findings: [{ reviewer: "correctness-reviewer", severity: "high", title: "Session token rotation races the refresh path" }],
          },
        },
      },
      reason:
        "waived by Persona (wontfix accepted) — owner's Persona: Session token rotation races the refresh path: tracked in job 1a2b3c4d, which owns the refresh path; out of scope here. (covers [high] Session token rotation races the refresh path)",
    },
  ]),
};

/** The default sample: the in-flight UI change. */
export const samplePipelineRun: PipelineRun = sampleRunUiChange;

/** Both sample runs, as the `runs` of GET /api/pipeline/runs. */
export const samplePipelineRuns: PipelineRun[] = [sampleRunUiChange, sampleRunNoUi];
