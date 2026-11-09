// The plan-approval loop: a gated launch submits its plan → the collector
// broadcasts `plan:updated` (status `awaiting_approval`) → this routes it to the
// owner as an attention message with Approve/Reject buttons. Tapping one POSTs
// /api/plans/:id/approve|reject, releasing the paused `submit_plan` long-poll.
// Editing the plan before approval stays in the web UI's PlanApprovalPanel;
// Slack offers only the as-is decisions.
//
// This composes with wave-2 owner-routed attention: it delivers to the SAME
// owner the ask path DMs (resolved via Asks.ownerChannel), so a plan-gated
// overnight launch pings the owner in Slack instead of blocking silently until
// the approval times out.
//
// Bindings are in-memory; resync() re-fetches /api/plans/pending on startup and
// every reconnect and re-delivers anything still pending — the collector is the
// source of truth.

import type { WebClient } from "@slack/web-api";
import type { PlanApproval } from "@standup/shared";
import type { CollectorClient } from "./collector-client.js";
import { planMessage, planResolvedBlocks, type PlanActionValue } from "./format.js";

/** How the owner recipient is resolved — shared with the ask path so both route to one owner. */
export interface OwnerRecipient {
  ownerChannel(): Promise<string | undefined>;
  readonly ownerUserId: string | undefined;
}

interface PlanBinding {
  channel: string;
  ts: string;
  plan: PlanApproval;
}

export class Plans {
  private readonly byPlan = new Map<string, PlanBinding>();
  private readonly handled = new Set<string>();
  private readonly inFlight = new Set<string>();
  private readonly deciding = new Set<string>();
  private resyncing: Promise<void> | null = null;

  constructor(
    private readonly web: WebClient,
    private readonly collector: CollectorClient,
    private readonly owner: OwnerRecipient,
    private readonly webUrl: string,
    /**
     * Whether a Slack user may APPROVE/REJECT a plan — the SAME authority gate
     * steer/launch/asks use: the operator-configured owner (SLACK_ASK_USER) or
     * the allowlist, NEVER the DM-learned recipient the plan happens to be
     * delivered to. Deciding releases (or revises) a gated launch on the
     * operator's host, so it is privileged. Composed from Steer.allowed at the
     * wiring site; absent leaves deciding ungated (tests only).
     */
    private readonly authorized?: (userId: string | undefined) => boolean,
  ) {}

  /** A `plan:updated` frame — deliver a fresh awaiting-approval plan, or retire a resolved one. */
  async onPlanUpdated(plan: PlanApproval): Promise<void> {
    if (plan.status === "awaiting_approval") {
      await this.deliver(plan);
      return;
    }
    // Any terminal-for-us transition (approved / rejected / back to awaiting_plan
    // on resubmit) retires the delivered card if we posted one.
    await this.retire(plan);
  }

  async onButton(value: PlanActionValue, actor?: string, userId?: string): Promise<void> {
    // Approving/rejecting releases or revises a gated launch on the operator's
    // host — gate it to the owner/allowlist. The plan card sits in the delivery
    // recipient's DM, so without this whoever that recipient is could decide it.
    if (this.authorized && !this.authorized(userId)) return;
    await this.decide(value.planId, value.decision, actor);
  }

  async resync(): Promise<void> {
    if (this.resyncing) return this.resyncing;
    this.resyncing = this.runResync().finally(() => {
      this.resyncing = null;
    });
    return this.resyncing;
  }

  private async runResync(): Promise<void> {
    const pending = await this.collector.getPendingPlans();
    if (pending === null) return; // fetch failed — don't retire anything
    const pendingIds = new Set(pending.map((p) => p.id));
    for (const [planId, b] of [...this.byPlan]) {
      if (!pendingIds.has(planId)) {
        this.byPlan.delete(planId);
        await this.updateMessage(b, planResolvedBlocks({ ...b.plan, status: "approved" }, "☑️ Resolved while the Slack app was offline."));
      }
    }
    for (const plan of pending) {
      await this.deliver(plan); // dedups via handled/inFlight
    }
  }

  // ---- internals ----------------------------------------------------------

  private async deliver(plan: PlanApproval): Promise<void> {
    if (this.handled.has(plan.id) || this.inFlight.has(plan.id)) return;
    this.inFlight.add(plan.id);
    try {
      const channel = await this.owner.ownerChannel();
      if (!channel) return; // no owner learned yet — warned at startup
      const { text, blocks } = planMessage(plan, this.webUrl, this.owner.ownerUserId);
      const res = await this.web.chat.postMessage({ channel, text, blocks });
      if (typeof res.ts === "string") {
        this.byPlan.set(plan.id, { channel, ts: res.ts, plan });
        this.handled.add(plan.id);
      }
    } catch (err) {
      console.error(`[plans] deliver failed for ${plan.id}:`, err instanceof Error ? err.message : err);
    } finally {
      this.inFlight.delete(plan.id);
    }
  }

  private async retire(plan: PlanApproval): Promise<void> {
    if (this.deciding.has(plan.id)) return; // decide() updates the card itself
    const b = this.byPlan.get(plan.id);
    // Clear `handled` even without a live card so a rejected plan the agent
    // resubmits (status back to awaiting_approval) is delivered afresh.
    this.handled.delete(plan.id);
    if (!b) return;
    this.byPlan.delete(plan.id);
    const note =
      plan.status === "approved"
        ? `✅ Approved${plan.approvedBy ? ` by ${plan.approvedBy}` : " elsewhere"}.`
        : plan.status === "rejected"
          ? "🚫 Rejected — the agent will revise and resubmit."
          : "☑️ No longer awaiting approval.";
    await this.updateMessage(b, planResolvedBlocks(plan, note));
  }

  private async decide(planId: string, decision: PlanActionValue["decision"], actor?: string): Promise<void> {
    const b = this.byPlan.get(planId);
    this.deciding.add(planId);
    try {
      const res = await this.collector.decidePlan(planId, decision, actor);
      if (res.ok) {
        this.byPlan.delete(planId);
        // A rejected plan will be resubmitted — let the fresh submission through.
        if (decision === "reject") this.handled.delete(planId);
        if (b) {
          const resolved: PlanApproval = { ...b.plan, status: decision === "approve" ? "approved" : "rejected", approvedBy: actor };
          await this.updateMessage(b, planResolvedBlocks(resolved, decision === "approve" ? "✅ Approved." : "🚫 Rejected — the agent will revise and resubmit."));
        }
        return;
      }
      if (b) {
        await this.web.chat
          .postMessage({
            channel: b.channel,
            text:
              res.status === 404
                ? "That plan is no longer awaiting approval."
                : `Couldn't submit that decision${res.error ? `: ${res.error}` : "."}`,
          })
          .catch(() => {});
      }
    } finally {
      this.deciding.delete(planId);
    }
  }

  private async updateMessage(b: PlanBinding, blocks: ReturnType<typeof planResolvedBlocks>): Promise<void> {
    try {
      await this.web.chat.update({ channel: b.channel, ts: b.ts, blocks, text: b.plan.plan ?? "Plan" });
    } catch (err) {
      console.error("[plans] chat.update failed:", err instanceof Error ? err.message : err);
    }
  }
}
