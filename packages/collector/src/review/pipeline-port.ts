import type { HumanReviewEvidence } from "@standup/shared";

/**
 * What the review routes need from the delivery pipeline: the run a launch is
 * in, and a way to hand the human_review stage its evidence (the packet and
 * the owner's decision). The pipeline engine implements it; without one,
 * nullPipelinePort answers that no launch has a run.
 */
export interface ReviewPipelinePort {
  /** The launch's pipeline run and its current stage, or null when it has none. */
  runForLaunch(launchId: string): { runId: string; currentStage: string } | null;
  /** Reports `evidence` for `stage` of run `runId`. */
  advance(runId: string, input: { stage: string; evidence: HumanReviewEvidence }): Promise<{ ok: boolean; error?: string }>;
  /**
   * Why approving packet `packetId` of `launchId` now wouldn't count for its
   * run (the checkout moved past it or has uncommitted edits), or null — read
   * before the approval is recorded, so a click that couldn't pass the stage
   * is refused rather than leaving the run stuck behind it.
   */
  approvalRefusal?(launchId: string, packetId: string): string | null;
  /** Whether the launch's checkout reads as changing no code; false when it changes code or git can't tell. */
  changesNoCode?(launchId: string): Promise<boolean>;
}

/** The port for a collector with no delivery pipeline: no launch has a run. */
export const nullPipelinePort: ReviewPipelinePort = {
  runForLaunch: () => null,
  advance: async () => ({ ok: false, error: "no delivery pipeline is configured" }),
};
