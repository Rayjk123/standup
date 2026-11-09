import type { PersonaApproval, PersonaApprovalStatus } from "./persona.js";

/*
 * What a Persona approval card says, in plain English, for every surface that
 * shows one (the console, Slack, push notifications, the digest). A card says
 * what Persona wants to do, why it needs the owner, and the exact content
 * approving would run (the brief, the message, the command), with no JSON and
 * no ids.
 */

/** One block of what approving runs: a labelled text, or a command shown as code. */
export interface ApprovalCardSection {
  label: string;
  text: string;
  /** A command or tool input, shown verbatim in monospace. */
  code?: boolean;
}

export interface ApprovalCardView {
  /** One sentence in Persona's voice: "I want to start a worker in standup on “Fix the parser”." */
  headline: string;
  /** Persona's own reason for wanting it, when it gave one. */
  note?: string;
  /** Why the owner has to decide, in plain words. */
  why?: string;
  /** The exact content approving runs, in full. */
  sections: ApprovalCardSection[];
  /**
   * When the safety-floor hold the card decides times out (ISO): undecided by
   * then, the hold lapses and the call is denied.
   */
  expiresAt?: string;
}

export type ApprovalCardInput = Pick<PersonaApproval, "action" | "summary"> & {
  args?: Record<string, unknown>;
  reason?: string;
};

/** The decided state of a card, in words. */
export const APPROVAL_STATUS_TEXT: Record<PersonaApprovalStatus, string> = {
  pending: "Waiting for your decision",
  approved: "Approved — running",
  denied: "Denied",
  executed: "Approved and done",
  failed: "Approved, but it failed",
  expired: "Expired before a decision",
  superseded: "Replaced by a newer request",
};

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/** `text` with uuids and the short ids printed beside them (`7c3e9a41`, `(7c3e9a41)`) removed. */
export function withoutIds(text: string): string {
  return text
    .replace(/\s*\(\s*[0-9a-f]{8}-[0-9a-f-]{27}\s*\)/gi, "")
    .replace(UUID, "")
    .replace(/\b(session|plan|ask|approval|job|launch|wakeup)\s+[0-9a-f]{8}\b/gi, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function list(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((v): v is string => typeof v === "string" && v.trim() !== "");
  return items.length > 0 ? items : undefined;
}

function firstLine(text: string, max = 80): string {
  const line = text.replace(/^\s*(?:goal|task)\s*:\s*/i, "").split("\n").find((l) => l.trim()) ?? "";
  const flat = line.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

function quoted(text: string): string {
  return `“${text}”`;
}

/** The worker a card is about: by its session title when the card carries one. */
function workerName(args: Record<string, unknown>): string {
  const title = str(args.sessionTitle);
  return title ? `the worker on ${quoted(firstLine(title, 70))}` : "a worker";
}

function lowerFirst(text: string): string {
  return text ? `${text.charAt(0).toLowerCase()}${text.slice(1)}` : text;
}

/**
 * Splits a stored approval reason into Persona's own note and the policy's
 * hold reason: the tool layer stores `<note> (held: <reason>)`, or the hold
 * reason alone when Persona gave none.
 */
export function splitApprovalReason(reason: string | undefined): { note?: string; held?: string } {
  const text = reason?.trim();
  if (!text) return {};
  const at = text.lastIndexOf(" (held: ");
  if (at >= 0 && text.endsWith(")")) {
    return { note: text.slice(0, at).trim() || undefined, held: text.slice(at + 8, -1).trim() || undefined };
  }
  return { held: text };
}

/** Why a held action needs the owner, from the policy's reason, in plain words. */
export function plainHoldReason(held: string): string {
  const step = /\("([^"]+)"\)|to "([^"]+)"/.exec(held);
  const named = step ? quoted(step[1] ?? step[2]!) : "a step";
  let m: RegExpExecArray | null;
  // A floor hold Persona can't allow (raiseOwnerHold in persona/tools.ts): read first, since the check's own
  // reason, quoted inside, may use any of the phrases below.
  if ((m = /^Persona can't allow this safety-floor hold: the call reads or moves secrets \(([\s\S]+)\)$/.exec(held))) {
    return `It touches secrets: ${withoutIds(m[1]!)}. Persona is never allowed to let that run, so only you can allow it once.`;
  }
  if ((m = /^Persona can't allow this safety-floor hold: the second check blocks its allow \(([\s\S]+)\)$/.exec(held))) {
    return `Standup's second check stopped Persona allowing it (${withoutIds(m[1]!)}), so only you can allow it once.`;
  }
  if (/HTTP API/.test(held)) return "It would change Standup itself through its HTTP API, which only you may do.";
  if ((m = /weakens the pipeline \((.+)\); only the owner weakens it/.exec(held))) {
    return `It weakens the delivery pipeline (${withoutIds(m[1]!)}), so only you can approve it.`;
  }
  if (/whose own pipeline is full/.test(held)) return "It turns off a stage a full pipeline keeps (a code review, a deploy or screenshots), so only you can drop it.";
  if (/pipeline is the owner's setting/.test(held)) return "It changes a pipeline setting of yours, and you haven't asked for this change.";
  if (/a project's repos/.test(held)) return "A project's repos decide where workers launch and what they can reach, so only you can change them.";
  if (/approves a worker's request/.test(held)) return `It says yes to the worker's request${step ? ` to ${named}` : ""}, which other people would see, so it's your call.`;
  if (/acceptance criterion/.test(held)) {
    if (/outward-facing/.test(held)) return `Standup would run the plan's check as you, and it takes a step other people would see (${named}).`;
    return "Standup would run the plan's check as you, and it isn't a plain build or test command.";
  }
  if (/effect only the owner can judge/.test(held)) return `It asks for ${named}, which I can't read well enough to judge, so it's your call.`;
  if (/outward-facing step/.test(held)) return `It asks for ${named}, which other people would see, so it's your call.`;
  if ((m = /active launch cap reached \((\d+)\/(\d+)\)/.exec(held))) return `${m[1]} workers are already running, and ${m[2]} at once is the limit.`;
  if (/tool-permission prompt/.test(held)) return "The worker's own permission settings stopped this tool call, so only you can allow it.";
  if (/safety-floor hold/.test(held)) return "Standup's safety floor stopped this command, and only you can let it run.";
  if (/confirmation gate/.test(held)) return "This step asks for your confirmation directly.";
  if (/STANDUP_PERSONA_HOLD/.test(held)) return "You asked to approve these yourself.";
  if (/thread other people read/.test(held)) return "It was asked for in a thread other people read.";
  if (/forget this memory/.test(held)) return "You haven't asked me to forget this.";
  if (/playbook's approval notes/.test(held)) return "Its approval notes change what agents may do on their own, and they aren't your words.";
  if (/asks to keep it/.test(held)) return "A kept playbook is reused in later briefs, and you haven't asked me to keep this one.";
  if (/asks to retire it/.test(held)) return "Retiring deletes a playbook you kept, and you haven't asked me to retire this one.";
  if (/memory/.test(held)) return "It changes what agents may do on their own, and you haven't asked me to remember it in these words.";
  return withoutIds(held);
}

/** The headline and sections of one action. */
function describeAction(action: string, args: Record<string, unknown>, summary: string): Omit<ApprovalCardView, "note" | "why"> {
  const worker = workerName(args);
  const sections: ApprovalCardSection[] = [];
  const add = (label: string, text: string | undefined, code = false) => {
    if (text) sections.push(code ? { label, text, code } : { label, text });
  };
  switch (action) {
    case "launch_session": {
      const task = str(args.task) ?? "";
      const project = str(args.projectId);
      const title = str(args.title) ?? firstLine(task);
      add("Brief", task);
      add("Playbook added to the brief", str(args.playbook));
      const settings = [
        str(args.model) && `model ${args.model}`,
        str(args.effort) && `${args.effort} effort`,
        args.planGate === true && "plan review before it starts",
        (args.pipeline === "off" || args.pipeline === false) && "no delivery pipeline",
        args.pipeline === "default" && "delivery pipeline on even for a provisioned workspace",
        str(args.pipelineSpec) && `pipeline: ${args.pipelineSpec}`,
        args.pipelineOverride !== undefined && args.pipelineOverride !== null && `pipeline: ${JSON.stringify(args.pipelineOverride)}`,
      ].filter(Boolean);
      if (settings.length > 0) add("Settings", settings.join(", "));
      return { headline: `I want to start a worker${project ? ` in ${project}` : ""} on ${quoted(title)}.`, sections };
    }
    case "send_to_session":
      add("Message", str(args.text));
      return {
        headline: args.mode === "now" ? `I want to type a message into ${worker} right now.` : `I want to send a message to ${worker}.`,
        sections,
      };
    case "interrupt_session":
      return { headline: `I want to interrupt ${worker}.`, sections };
    case "recover_session":
      return { headline: `I want to unstick ${worker}.`, sections };
    case "stop_session":
      return { headline: `I want to stop ${worker}.`, sections };
    case "close_session": {
      const titles = Array.isArray(args.sessionTitles) ? args.sessionTitles.filter((t): t is string => typeof t === "string") : [];
      add("Sessions", titles.map((t) => `• ${t}`).join("\n") || undefined);
      if (titles.length > 1) return { headline: `I want to close ${titles.length} sessions I didn't launch.`, sections };
      const title = str(args.sessionTitle);
      return { headline: `I want to close the session ${title ? quoted(firstLine(title, 70)) : "you named"}.`, sections };
    }
    case "park_session":
      add("Waiting for", str(args.why));
      add("Waiting on job", str(args.waitingOnJobId));
      return { headline: `I want to park ${worker} until what it waits for is done.`, sections };
    case "unpark_session":
      add("Why the wait is over", str(args.why));
      add("Message", str(args.message));
      return { headline: `I want to un-park ${worker}${str(args.message) ? " and tell it what to do next" : ""}.`, sections };
    case "waive_pipeline_stage":
      add("Stage", str(args.stage));
      if (args.kind === "accept_wontfix") {
        add("Why each wontfix finding is out of scope", str(args.why));
        return { headline: `I want to accept the wontfix review findings of ${worker} and waive its review.`, sections };
      }
      if (args.kind === "skip" || args.kind === "waive" || args.kind === "close_out" || args.kind === "escalate") {
        add("Why", str(args.why));
        const verb = { skip: "skip", waive: "waive", close_out: "close out the rest of", escalate: "escalate to you" }[args.kind];
        return {
          headline:
            args.kind === "escalate"
              ? `I want to hand a pipeline stage of ${worker} to you.`
              : args.kind === "close_out"
                ? `I want to ${verb} the delivery pipeline of ${worker}.`
                : `I want to ${verb} a pipeline stage of ${worker}.`,
          sections,
        };
      }
      add("Why it doesn't apply", str(args.why));
      return { headline: `I want to waive a pipeline stage of ${worker} as not applicable.`, sections };
    case "set_pipeline": {
      add("Pipeline", str(args.spec) ?? (args.override !== undefined ? JSON.stringify(args.override) : undefined), args.spec === undefined);
      add("Why", str(args.why));
      const target =
        args.scope === "project"
          ? `project ${str(args.projectId) ?? ""}'s`
          : args.scope === "job"
            ? "a job's"
            : args.scope === "launch"
              ? `${worker}'s`
              : "your own";
      return { headline: `I want to change ${target} delivery pipeline.`, sections };
    }
    case "answer_ask": {
      const tool = str(args.toolName);
      const question = str(args.askQuestion);
      const options = list(args.askOptions);
      const input = args.toolInput;
      if (args.floorHold === true) {
        // A hold only the owner may allow: the question is the floor's
        // account of the held call; approving answers it "Allow once".
        add("What the safety floor held", question);
        add("What your answer does", "Allow once runs the held command this one time. Deny refuses it.");
        return { headline: `Standup's safety floor is holding a command from ${worker}, and only you can let it run.`, sections };
      }
      add("The worker asked", question && (options ? `${question}\n${options.map((o, i) => `${i + 1}. ${o}`).join("\n")}` : question));
      if (tool) {
        const shown = typeof input === "string" ? input : input == null ? undefined : (input as { command?: unknown }).command;
        add(tool === "Bash" ? "Command" : `${tool} input`, typeof shown === "string" ? shown : input == null ? undefined : JSON.stringify(input, null, 2), true);
      }
      add("My answer", str(args.answer));
      return {
        headline: tool ? `I want to let ${worker} run ${tool}.` : `I want to answer a question from ${worker}.`,
        sections,
      };
    }
    case "approve_plan":
    case "reject_plan": {
      add("Plan", str(args.plan));
      add("Done when", str(args.acceptanceCriterion), true);
      add("Files", list(args.relevantFiles)?.join(", "));
      add(action === "approve_plan" ? "My note" : "My feedback", str(action === "approve_plan" ? args.note : args.feedback));
      return {
        headline: action === "approve_plan" ? `I want to approve the plan from ${worker}.` : `I want to send the plan from ${worker} back.`,
        sections,
      };
    }
    case "remember": {
      const title = str(args.title) ?? str(args.topic) ?? "a note";
      add("What I'd save", str(args.fact) ?? str(args.quote));
      add("Why it matters", str(args.why));
      add("How to apply it", str(args.howToApply));
      return { headline: `I want to remember ${quoted(firstLine(title, 100))}.`, sections };
    }
    case "save_playbook": {
      const title = str(args.title) ?? str(args.name) ?? "a playbook";
      add("When to use it", str(args.whenToUse));
      add("Steps", str(args.steps));
      add("Approval notes", str(args.approvalNotes));
      return { headline: `I want to save the playbook ${quoted(firstLine(title, 100))} as a draft.`, sections };
    }
    case "decide_playbook": {
      const title = str(args.title) ?? str(args.slug) ?? "a playbook";
      add("Playbook", str(args.playbook));
      return {
        headline:
          args.decision === "reject"
            ? `I want to drop the playbook draft ${quoted(firstLine(title, 100))}.`
            : args.decision === "retire"
              ? `I want to retire the playbook ${quoted(firstLine(title, 100))}; later briefs won't use it.`
              : `I want to keep the playbook ${quoted(firstLine(title, 100))} and reuse it in later briefs.`,
        sections,
      };
    }
    case "forget": {
      const topic = str(args.topic) ?? str(args.slug) ?? "a note";
      return { headline: `I want to forget my note ${quoted(firstLine(topic.replace(/[-_]+/g, " "), 100))}.`, sections };
    }
    case "update_project_repos": {
      const project = str(args.projectName) ?? str(args.projectId) ?? "a project";
      const current = list(args.currentRepos);
      const repos = list(args.repos);
      add("Repos now", current && current.length > 0 ? current.join("\n") : "(none)", true);
      add("Repos after", repos && repos.length > 0 ? repos.join("\n") : "(none)", true);
      return { headline: `I want to set the repos of ${quoted(firstLine(project, 100))}.`, sections };
    }
    case "restart_standup":
      return { headline: "I want to restart Standup to pick up the latest change. It checks itself and rolls back if anything fails.", sections };
    default:
      return { headline: `I want to ${lowerFirst(withoutIds(summary)).replace(/[.\s]*$/, "")}.`, sections };
  }
}

/** The plain-English card for an approval. */
export function describeApproval(approval: ApprovalCardInput): ApprovalCardView {
  const { note, held } = splitApprovalReason(approval.reason);
  const base = describeAction(approval.action, approval.args ?? {}, approval.summary);
  const expiresAt = approval.action === "answer_ask" ? str(approval.args?.holdExpiresAt) : undefined;
  return {
    ...base,
    ...(note ? { note: withoutIds(note) } : {}),
    ...(held ? { why: plainHoldReason(held) } : {}),
    ...(expiresAt && !Number.isNaN(Date.parse(expiresAt)) ? { expiresAt } : {}),
  };
}

/**
 * When a card's safety-floor hold times out, relative to `now`: "in 42 min",
 * "in 1 h 5 min", or "now" once it has passed.
 */
export function holdExpiresIn(expiresAt: string, now: Date = new Date()): string {
  const minutes = Math.ceil((Date.parse(expiresAt) - now.getTime()) / 60_000);
  if (!(minutes > 0)) return "now";
  if (minutes < 60) return `in ${minutes} min`;
  const rest = minutes % 60;
  return `in ${Math.floor(minutes / 60)} h${rest ? ` ${rest} min` : ""}`;
}

/** One line for a notification or a thread: the headline and why it needs the owner. */
export function approvalHeadline(approval: ApprovalCardInput): string {
  const card = describeApproval(approval);
  return card.why ? `${card.headline} ${card.why}` : card.headline;
}

/**
 * The label of a card's approve button: "Allow once" on the card Standup
 * raises over a safety-floor hold only the owner can let run (approving
 * allows the held call once), "Approve" on every other card.
 */
export function approveLabel(approval: Pick<ApprovalCardInput, "action" | "args">): string {
  return approval.action === "answer_ask" && approval.args?.floorHold === true ? "Allow once" : "Approve";
}

/** The whole card as plain text, ending in the choice it asks for. */
export function approvalCardText(approval: ApprovalCardInput): string {
  const card = describeApproval(approval);
  const parts = [card.headline];
  if (card.why) parts.push(`Why I'm asking: ${card.why}`);
  if (card.note) parts.push(`My reason: ${card.note}`);
  for (const s of card.sections) parts.push(`${s.label}:\n${s.text}`);
  if (card.expiresAt) parts.push(`Decide by ${card.expiresAt}: after that the hold times out and the call is denied.`);
  parts.push(`${approveLabel(approval)} / Deny`);
  return parts.join("\n\n");
}
