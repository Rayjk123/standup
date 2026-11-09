import type { Database } from "bun:sqlite";
import { HUMAN_REVIEW_STAGE_KIND } from "@standup/shared";
import {
  getLaunch,
  getPipelineRunByLaunch,
  getReviewPacket,
  hasPendingReviewPacketForLaunch,
  latestSubmittedReviewPacketForLaunch,
  personaJobForLaunch,
} from "@standup/store";
import { advancePipeline, launchChangesNoCode } from "../pipeline/engine.js";
import {
  approvalIsCurrent,
  decidedThisEpoch,
  launchWorkLanded,
  registerPipelineStageRunner,
  type PipelineDeps,
} from "../pipeline/runners.js";
import type { ReviewPipelinePort } from "./pipeline-port.js";
import { onEnterHumanReview, reviewOwnerForLaunch } from "./stage.js";

/** Why a run at human_review waits on its owner. */
export const HUMAN_REVIEW_STOP_REASON = "the review packet is waiting on your decision in the Review tab";

/** Why a run at human_review whose work already landed waits on its owner: there is nothing left to review. */
export const HUMAN_REVIEW_LANDED_REASON =
  "the change already landed in its target branch, so there is nothing left to review — close the job done (it closes as landed) or waive the stage";

/** Why the owner's approval of a packet is refused: the checkout no longer stands where the packet showed it. */
export const STALE_APPROVAL_REASON =
  "this packet no longer shows the change as it stands — the worker's checkout has moved past it or has uncommitted " +
  "edits — so an approval wouldn't count. The worker has been asked to submit a new revision.";

/** What a worker at human_review is told when it stops before submitting its packet. */
export const HUMAN_REVIEW_SUBMIT_HINT =
  "Submit your review packet with submit_review_packet (the brief you were steered with says what it needs) — the owner decides it in the Review tab, which finishes this stage.";

/**
 * The review routes' view of the delivery pipeline: a launch's run, and the
 * owner's decision on its review packet reported as the human_review stage's
 * evidence.
 */
export function pipelineReviewPort(db: Database, deps: PipelineDeps): ReviewPipelinePort {
  return {
    runForLaunch(launchId) {
      const run = getPipelineRunByLaunch(db, launchId);
      return run ? { runId: run.id, currentStage: run.currentStage } : null;
    },
    async advance(runId, input) {
      const result = await advancePipeline(db, runId, { stage: input.stage, evidence: input.evidence }, deps);
      return result.ok ? { ok: true } : { ok: false, error: result.error };
    },
    approvalRefusal(launchId, packetId) {
      const run = getPipelineRunByLaunch(db, launchId);
      const launch = getLaunch(db, launchId);
      const packet = latestSubmittedReviewPacketForLaunch(db, launchId);
      if (!run || run.status === "disabled" || !launch || packet?.id !== packetId) return null;
      // Decided now, so only the checkout can make the approval stale.
      return approvalIsCurrent(launch, { ...packet, decidedAt: new Date().toISOString() }, undefined, run, db)
        ? null
        : STALE_APPROVAL_REASON;
    },
    changesNoCode: (launchId) => launchChangesNoCode(db, launchId, deps),
  };
}

registerPipelineStageRunner(HUMAN_REVIEW_STAGE_KIND, {
  // Only the owner decides a review: the evidence must name the launch's own
  // packet and match the decision recorded on it, so a worker reporting
  // `approved` itself is refused.
  prepareEvidence(ctx) {
    const packetId = String(ctx.evidence.packetId);
    const owner = ctx.launch ? reviewOwnerForLaunch(ctx.db, ctx.launch) : null;
    const packet = owner ? getReviewPacket(ctx.db, packetId, owner) : null;
    if (!packet || packet.launchId !== ctx.run.launchId) {
      return { error: "Unknown review packet for this launch", status: 422, missing: ["evidence.packetId (this launch's review packet)"] };
    }
    if (packet.status !== ctx.evidence.decision) {
      return {
        error: "Only the owner decides a review, in the Review tab: the packet has no such decision",
        status: 409,
      };
    }
    // Only the newest packet speaks for the change, and an approval only while
    // it covers the code as it stands: every advance of the stage — the
    // owner's decision, a replay, a worker's report — passes through here.
    if (latestSubmittedReviewPacketForLaunch(ctx.db, ctx.run.launchId)?.id !== packet.id) {
      return { error: "That review packet has been superseded by a newer one for this launch", status: 409 };
    }
    const current =
      packet.status === "approved"
        ? !ctx.launch || approvalIsCurrent(ctx.launch, packet, undefined, ctx.run, ctx.db)
        : decidedThisEpoch(ctx.run, packet.decidedAt);
    if (!current) {
      return {
        error:
          "That decision doesn't cover the change as it stands: it was made on an earlier round, or the checkout has " +
          "moved or has uncommitted edits since the packet was submitted. Submit a new review packet for the owner.",
        status: 409,
      };
    }
    return { evidence: ctx.evidence };
  },
  // Entering the stage with the launch's packet already decided — the owner
  // approved it or sent it back while the run was still short of the stage
  // (waiting at code_review for an issue id, say) — reports that decision at once, so
  // it isn't lost and the owner isn't asked again. With the packet waiting on
  // the owner there is nothing to do: that is what the stage is for. With
  // none, the owner's draft is opened and the worker steered with the
  // review-writer brief.
  async onEnter(ctx) {
    const latest = latestSubmittedReviewPacketForLaunch(ctx.db, ctx.run.launchId);
    // A decision only counts if it was made on this round of the work — not
    // one the run already acted on — and an approval only while it covers the
    // code as it stands now.
    const current =
      latest?.status === "approved"
        ? !ctx.launch || approvalIsCurrent(ctx.launch, latest, undefined, ctx.run, ctx.db)
        : decidedThisEpoch(ctx.run, latest?.decidedAt);
    if ((latest?.status === "approved" || latest?.status === "changes_requested") && current) {
      await advancePipeline(ctx.db, ctx.run.id, { stage: ctx.stage.id, evidence: { packetId: latest.id, decision: latest.status } }, ctx.deps);
      return;
    }
    if (latest?.status === "pending") return;
    const launch = ctx.launch;
    const owner = launch ? reviewOwnerForLaunch(ctx.db, launch) : null;
    if (!launch || !owner || !launch.sessionId) return;
    // Work that already landed in its target (merged outside the pipeline)
    // has nothing left to review; its job is closed as landed instead, and a
    // packet written now would only hold that close up.
    if (launchWorkLanded(ctx.db, ctx.run, launch)) return;
    onEnterHumanReview(
      ctx.db,
      {
        owner,
        launchId: launch.id,
        sessionId: launch.sessionId,
        jobId: personaJobForLaunch(ctx.db, launch.id)?.job.id,
        projectId: launch.projectId || undefined,
        pipelineRunId: ctx.run.id,
        worktree: launch.worktreePath || undefined,
        scratchDir: ctx.deps.reviewScratchDir(launch.id),
      },
      { broadcast: ctx.deps.broadcast }
    );
  },
  // The worker can't finish the stage — only the owner's decision does — so
  // once its packet is submitted its Stop hands the run to them instead of
  // being blocked. Work that already landed hands it to them too, to close
  // (the pipeline run is what they act on). Otherwise there is nothing in the
  // Review tab to decide, and the Stop is blocked so the worker submits it.
  stopReason: (ctx) => {
    if (hasPendingReviewPacketForLaunch(ctx.db, ctx.run.launchId)) return HUMAN_REVIEW_STOP_REASON;
    return ctx.launch && launchWorkLanded(ctx.db, ctx.run, ctx.launch) ? HUMAN_REVIEW_LANDED_REASON : null;
  },
  stopHint: () => HUMAN_REVIEW_SUBMIT_HINT,
});
