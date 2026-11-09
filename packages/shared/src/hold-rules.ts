// ============================================================================
// Hold rules — the structured id of the policy rule a Persona hold was raised
// under. Persona's policy (collector `persona/policy.ts`) sets one on every
// `ask` decision; the approval it raises stores it (`persona_approvals.
// hold_rule`), and the noisy-hold report groups approvals by it. One
// vocabulary, shared by the policy, the store and the console.
// ============================================================================

/**
 * Kinds of call the worker safety floor holds (collector `floor/gate.ts`
 * FloorCategory), repeated here so the store and the console can read
 * `floor:<category>` rules without depending on the collector.
 */
export const HOLD_FLOOR_CATEGORIES = [
  "outward",
  "review",
  "aws",
  "personal-aws",
  "nonprod-aws",
  "owner-host",
  "collector-api",
  "standup-ops",
  "floor-tamper",
  "unseen-code",
  "destructive",
  "unclassified",
] as const;

/**
 * Floor categories held on the owner gate (collector OWNER_ONLY_CATEGORIES):
 * only the owner, or the host's own Persona with a recorded reason, may allow
 * them.
 */
export const HOLD_OWNER_ONLY_FLOOR_CATEGORIES: ReadonlySet<string> = new Set(["outward", "aws", "collector-api", "floor-tamper"]);

/**
 * Rules the current policy raises holds under. Parameterized ones are
 * `hold-knob:<action>` (the owner's STANDUP_PERSONA_HOLD) and
 * `floor:<category>` (a safety-floor allow held for the owner: Persona's own
 * allow can't place it, or a guest's allow runs with the host's credentials;
 * `unknown` when the ask carries no category).
 */
export const HOLD_RULES = [
  "memory-collector-api",
  "memory-owner-words",
  "memory-shared-thread",
  "forget-owner-words",
  "playbook-owner-words",
  "playbook-accept",
  "playbook-retire",
  "restart-shared",
  "confirmation-gate",
  "permission-prompt",
  "project-repos",
  "job-budget",
  "job-budget-raise",
  "pipeline-owner-words",
  "pipeline-turns-off",
] as const;

/**
 * Rules earlier policies raised holds under that no longer exist: prose
 * matches on outward vocabulary or the collector API in Persona's own text,
 * acceptance-criterion holds, and launches past the budget or cap (now
 * queued). They appear only on approvals inferred from their reason text.
 */
export const RETIRED_HOLD_RULES = ["text:outward", "text:collector-api", "criterion", "budget", "cap"] as const;

export type HoldRule = string;

/** The noisy-hold report flags a rule only after this many owner decisions under it. */
export const NOISY_HOLD_MIN_SAMPLES = 5;

/** …and only when at least this share of them were approvals. */
export const NOISY_HOLD_MIN_APPROVE_RATE = 0.9;

/** `hold-knob:<action>`: the owner holds `action` with STANDUP_PERSONA_HOLD. */
export function holdKnobRule(action: string): HoldRule {
  return `hold-knob:${action}`;
}

/** `floor:<category>`: a safety-floor ask the owner decides. */
export function floorHoldRule(category: string | undefined | null): HoldRule {
  return `floor:${category && category.trim() ? category.trim() : "unknown"}`;
}

/** Whether `rule` is one the current policy can raise. */
export function isKnownHoldRule(rule: string): boolean {
  if ((HOLD_RULES as readonly string[]).includes(rule)) return true;
  if (rule.startsWith("hold-knob:")) return rule.length > "hold-knob:".length;
  if (rule.startsWith("floor:")) {
    const category = rule.slice("floor:".length);
    return category === "unknown" || (HOLD_FLOOR_CATEGORIES as readonly string[]).includes(category);
  }
  return false;
}

/** Whether `rule` names a rule the policy no longer has. */
export function isRetiredHoldRule(rule: string): boolean {
  return (RETIRED_HOLD_RULES as readonly string[]).includes(rule);
}

/**
 * Why holds under `rule` are never a candidate for loosening, whatever their
 * approve rate, or null when they may be. A 100% approve rate on a real
 * outward step is expected, not noise: the floor's owner-only categories (and
 * a floor ask with no category), tool-permission prompts, confirmation gates
 * and memories saved from a shared thread stay the owner's.
 */
export function holdRuleExclusion(rule: string): string | null {
  if (rule.startsWith("floor:")) {
    const category = rule.slice("floor:".length);
    if (HOLD_OWNER_ONLY_FLOOR_CATEGORIES.has(category)) return "an owner-gate safety-floor category, which stays the owner's to allow";
    if (category === "unknown") return "a safety-floor hold of an unknown category";
    return null;
  }
  if (rule === "permission-prompt") return "tool-permission prompts stay the owner's";
  if (rule === "confirmation-gate") return "a confirmation gate asks the owner directly";
  if (rule === "memory-shared-thread") return "memories saved from a thread other people read stay the owner's";
  if (rule === "playbook-owner-words") return "a playbook's notes on approvals and outward steps stay the owner's words";
  if (rule === "playbook-accept") return "which methods ride along in later briefs stays the owner's to review";
  if (rule === "project-repos") return "a project's repos are launch posture, which only the owner changes";
  if (rule === "job-budget" || rule === "job-budget-raise") return "a job's time and spend budget is the owner's to extend";
  if (rule === "pipeline-turns-off") {
    return (
      "weakening an owner-held pipeline stage stays the owner's: validation, review and human review on every project, " +
      "code review, deploy and screenshots on a full project, and every stage's validation checks and UI paths"
    );
  }
  return null;
}

/** Whether holds under `rule` may be suggested for loosening (see holdRuleExclusion). */
export function isLoosenableHoldRule(rule: string): boolean {
  return isKnownHoldRule(rule) && holdRuleExclusion(rule) === null;
}

/**
 * The rule an approval stored without one was most likely held under, read
 * from its reason text (the policy's prose, after Persona's own reason when it
 * gave one: "<persona reason> (held: <policy reason>)"). Null when no pattern
 * matches.
 */
export function inferHoldRule(action: string, reason: string | undefined | null): HoldRule | null {
  if (!reason) return null;
  const marker = reason.lastIndexOf("(held: ");
  const held = marker >= 0 ? reason.slice(marker + "(held: ".length).replace(/\)\s*$/, "") : reason;
  if (/STANDUP_PERSONA_HOLD/.test(held)) {
    const named = /holds (\S+) for approval/.exec(held);
    return holdKnobRule(named?.[1] ?? action);
  }
  if (/safety-floor hold/.test(held)) {
    const category = /safety-floor hold[^(]*\(([a-z-]+)\)/.exec(held);
    return floorHoldRule(category?.[1]);
  }
  if (/tool-permission prompt/.test(held)) return "permission-prompt";
  if (/confirmation gate/.test(held)) return "confirmation-gate";
  if (/thread other people read/.test(held)) {
    if (action === "restart_standup") return "restart-shared";
    if (action === "remember") return "memory-shared-thread";
  }
  if (/forget this memory/.test(held)) return "forget-owner-words";
  if (/playbook's approval notes/.test(held)) return "playbook-owner-words";
  if (action === "decide_playbook" && /asks to keep it/.test(held)) return "playbook-accept";
  if (action === "decide_playbook" && /asks to retire it/.test(held)) return "playbook-retire";
  if (/a project's repos/.test(held)) return "project-repos";
  if (/is over its (time and spend )?budget/.test(held)) return "job-budget";
  if (/raises the job's budget/.test(held)) return "job-budget-raise";
  if (/daily launch budget reached/.test(held)) return "budget";
  if (/active launch cap reached/.test(held)) return "cap";
  if (/acceptance criterion/.test(held)) return "criterion";
  if (/HTTP API/.test(held)) return action === "remember" ? "memory-collector-api" : "text:collector-api";
  if (action === "remember" && /memory/.test(held)) return "memory-owner-words";
  if (/outward-facing|approves a worker's request|effect only the owner can judge/.test(held)) return "text:outward";
  return null;
}
