import { floorHoldRule, holdKnobRule, pipelineTermsNamed, type HoldRule, type PersonaPolicyRule } from "@standup/shared";
import { collectorPortSet } from "@standup/shared/topology";
import { namesHeldCall, withoutShellComments } from "./consent-target.js";
import { isDirectRequest, withoutInlineCode, withoutOtherVoices } from "./owner-speech.js";
import { escapeRegExp, orNoun, perReviewNoun, reviewNounsOf } from "./review-noun.js";
import {
  FLOOR_GATE,
  FLOOR_OWNER_GATE,
  SHELL_ESCAPE_REFUSAL,
  floorAnswerAllows,
  startsWithShellEscape,
} from "../floor/gate.js";
import { DEFAULT_ORG_PROFILE } from "../org-profile/default.js";
import { activeOrgProfile } from "../org-profile/load.js";
import type { OrgCliRule, OrgProfile } from "../org-profile/types.js";

/*
 * Trust boundary. Approvals guard Persona's own judgment and any instruction
 * injected into it through worker output (asks, checkpoints, transcripts). They
 * are not a boundary against a malicious process running as the owner: the
 * collector is local-first, so any process with the owner's uid can reach the
 * owner routes on loopback exactly as the owner's browser does. The text checks
 * below raise the cost of steering Persona into calling those routes for a
 * worker; they do not make a same-uid process untrusted.
 */

/** `Ask.gate` of the server's idle notice for a launched session (a turn end, not a dialog). */
export const IDLE_NOTICE_GATE = "idle_notice";

/**
 * The facts a policy verdict depends on, gathered by the tool layer from the
 * store before the call. Absent facts are treated as the unsafe answer (not
 * owned, not launchable, not idle), so a handler that forgets one fails closed.
 */
export interface PolicyContext {
  /** The target session/ask/plan belongs to a Persona job of this owner. */
  owned?: boolean;
  /** `close_session`: the session is a worker of an open Persona job (any owner's). */
  openJobWorker?: boolean;
  /** `close_session`: the user the session belongs to, when that isn't the owner. */
  sessionOtherUser?: string;
  /** `answer_ask`: the kind of the ask being answered. */
  askKind?: string;
  /** `answer_ask`: the server-set `Ask.gate` of the ask being answered, if any. */
  askGate?: string;
  /**
   * `answer_ask` on a tool-permission prompt: the answer allows the dialog's
   * call once, and the tool layer classified that call, from its recorded
   * tool_name, tool_input and cwd, as plainly read-only: a read-only shape
   * the safety floor allows with no hold (permission-read-only.ts). Absent,
   * the answer is held for the owner.
   */
  permissionReadOnly?: boolean;
  /**
   * `answer_ask` on a tool-permission prompt: the answer picks the dialog's
   * "No" (permissionDenyDigit), so the call doesn't run.
   */
  permissionDeny?: boolean;
  /**
   * `answer_ask` on a safety-floor ask: the held call's category, as the
   * collector wrote it into the question (see floorQuestion). Absent,
   * Persona's "Allow once" is held for the owner.
   */
  floorCategory?: string;
  /**
   * `answer_ask` on a high-risk safety-floor ask (isHighRiskFloorHold): owner
   * secrets, Standup's DB, another process's memory, the floor hook or
   * install code. Persona still decides it.
   */
  floorHighRisk?: boolean;
  /** `launch_session`: the target project exists, is registered and not reserved. */
  projectLaunchable?: boolean;
  /** `launch_session` and launch_job schedules: the harness the project's workers run under (absent: claude). */
  launchHarness?: string;
  activeLaunches?: number;
  maxActiveLaunches?: number;
  /**
   * `launch_session` into an existing job, or `send_to_session` /
   * `recover_session` on one of its workers: the job has reached its time and
   * spend budget, described (e.g. "$1.20 of $1.00"). More work on it is the
   * owner's to allow.
   */
  jobOverBudget?: string;
  /**
   * `open_job` / `update_job`: the call raises the job's budget above what it
   * is now (for a new job, above the owner's default), described.
   */
  budgetRaise?: string;
  /**
   * The free text Persona itself delivers to a worker or the launcher (a launch
   * task, a message typed or queued into a session, an ask's answer, a plan
   * review's feedback or note, a memory). Only memories, the `!` escape and
   * chat consent read it; orchestration is never decided on its words.
   */
  text?: string;
  /**
   * Worker-authored text the action consents to: the question and options of
   * an ask being answered. Chat consent reads it; the decision does not.
   */
  authorizes?: string[];
  /** `approve_plan`: the plan's acceptance criterion. Recorded only: the floor classifies it when it runs. */
  acceptanceCriterion?: string;
  /**
   * The owner's own message texts in the running turn's batch (empty outside
   * a turn). Read only by `remember`, `forget` and an owner or project
   * `set_pipeline`; owner chat never clears an outward step.
   */
  ownerTexts?: string[];
  /** `set_pipeline`: the layer it sets — user, project, job or launch. */
  pipelineScope?: string;
  /**
   * `set_pipeline`, `launch_session` and `open_job` with a pipeline: how the
   * change weakens the pipeline it lands on, in words (the collector's
   * pipelineLayerWeakens over the resolved pipelines, the same check its
   * config and launch routes refuse on). Read by the tool layer from the
   * layers themselves, never from prose.
   */
  pipelineWeakens?: string[];
  /**
   * `set_pipeline`: what the layer touches — stage ids, a preset, "rounds",
   * "pipeline" (pipelineLayerTouches) — which the owner's words this turn
   * must name for an owner or project layer to be set on them.
   */
  pipelineTouches?: string[];
  /** `remember`: the memory's saved content, compared against the owner's words. */
  fact?: string;
  /**
   * `remember`: the memory's title, compared against the owner's words with
   * the fact. Absent, `text` (title and content together) is compared.
   */
  title?: string;
  /**
   * `remember`: the owner's words Persona quotes as the memory. A quote taken
   * verbatim from an owner clause that asks for it to be kept is saved as the
   * owner wrote it.
   */
  quote?: string;
  /** `forget`: the topic of the memory to drop, which the owner's request must name. */
  topic?: string;
  /** `send_to_session`: the delivery mode. */
  sendMode?: string;
  /** `waive_pipeline_stage`: the waiver's kind (`not_applicable` or `accept_wontfix`). */
  waiveKind?: string;
  /**
   * `send_to_session`: the worker sits idle at its prompt — its session is idle
   * (or only waiting on the idle notice), no tool call is in flight and no
   * real permission dialog is pending. Text typed anywhere else lands in a
   * dialog or interrupts a tool.
   */
  workerAtPrompt?: boolean;
  /** `send_to_session`: the session sits on a real tool-permission dialog. */
  permissionPending?: boolean;
  /** `send_to_session`: the worker may be running with permissions bypassed (launchMayBeBypassed). */
  workerBypassed?: boolean;
  /**
   * `restart_standup`, `decide_knowledge_draft`: the call comes from a thread
   * only the owner reads.
   */
  privateThread?: boolean;
  /**
   * `decide_knowledge_draft`: the draft, or the doc it replaces, is in the
   * owner's personal layer (personalLayerRefusal).
   */
  personalLayer?: boolean;
  /**
   * `decide_playbook`: whether the playbook draft is accepted or rejected, or
   * an accepted one retired. Absent, it is read as accepted. Its `title` and
   * `topic` (the slug) say which playbook, for the owner's words to name.
   */
  playbookDecision?: "accept" | "reject" | "retire";
  /** `decide_playbook`: how many of the owner's playbook drafts are pending. */
  playbookPendingCount?: number;
  /**
   * `save_playbook`: the approval notes change what agents may do unasked
   * (playbook.ts approvalNotesNeedOwnerWords), so they are saved only as the
   * owner's own words (`text`). Absent, it is read as true.
   */
  playbookNeedsOwnerWords?: boolean;
  /**
   * Schedule actions: the kind of the schedule created or acted on. Absent,
   * it is read as `launch_job`, the kind that launches a worker.
   */
  scheduleKind?: string;
  /**
   * `update_schedule` of a launch_job: the update changes the brief or the
   * project, so the launch it will make is new. Absent, it is read as changed.
   */
  scheduleLaunchChanged?: boolean;
}

export interface PolicyDecision {
  rule: PersonaPolicyRule;
  reason: string;
  /**
   * On a hold: the structured id of the rule that raised it (@standup/shared
   * hold-rules), stored on the approval so holds are grouped by rule, not by
   * `reason` prose. Set on every `ask`.
   */
  holdRule?: HoldRule;
  /**
   * On a hold: the owner's own yes in chat may clear it (see chatConsent).
   * Set only on holds that guard Persona's pace or the owner's own settings
   * (cap, owner holds, permission prompts, check commands, restarts),
   * never on an outward step, the collector API, the safety floor, a
   * confirmation gate or a memory.
   */
  consentable?: boolean;
  /**
   * On a launch that acts: why it can't start yet (the active cap is
   * reached). The launch is queued and starts when there is room.
   */
  queued?: string;
}

/*
 * Tiers. Persona is the owner's orchestrator, so what it does to its own
 * workers runs on its word; only the floor goes to the owner.
 *
 * - Reads and owner-facing actions (READ_ACTIONS) always act.
 * - Routine orchestration (ROUTINE_ACTIONS) acts: launching, steering,
 *   interrupting and stopping its own workers, answering their questions,
 *   approving or rejecting their plans, job bookkeeping, wakeups, recurring
 *   schedules (creating, editing, pausing, deleting and running them), memory,
 *   accepting or rejecting pending knowledge drafts outside the personal layer,
 *   writing the owner's own docs, and restarting the owner's Standup to roll
 *   in a merged change. The owner
 *   can hold any of them for approval with `STANDUP_PERSONA_HOLD` (see
 *   PolicySettings).
 * - Orchestration on its own workers is decided on structured facts only, never
 *   on the words of a brief, steering text, answer, note or criterion: what
 *   those words make a worker do is enforced where it runs, at the worker's
 *   safety floor (floor/), and a plan's acceptance criterion is classified by
 *   the same floor before the collector runs it (floor/criterion.ts). A launch
 *   past the active cap acts too: it is queued (launchCapacity)
 *   and starts when there is room, never held for the owner.
 * - Held for the owner whatever the settings: tool-permission prompts,
 *   confirmation gates, safety-floor asks with no
 *   category, an owner-gate floor allow asked for from a thread other people
 *   read, a restart asked for from
 *   a thread other people read, memories that widen what agents may do unless
 *   the owner asked for them (memoryNeedsOwnerWords), dropping a memory the
 *   owner did not ask this turn to drop, a change to a project's repos, a
 *   pipeline layer that turns off a full project's code_review, deploy or screenshot
 *   stage, and an owner or project pipeline change the owner did not ask
 *   for this turn.
 * - Safety-floor asks (a bypass-mode worker's tool call the floor held) are
 *   decided by their server-set gate and category: denying one always acts;
 *   allowing one acts on either gate (FLOOR_GATE or FLOOR_OWNER_GATE), high-risk
 *   holds and the owner's acceptance-criterion holds included, and the tool
 *   layer second-checks it and records Persona's reason for the owner to
 *   review. Persona escalates with ask_user; Standup cards a floor hold by
 *   itself only when the second check blocks Persona's allow of a high-risk hold
 *   (raiseOwnerHold in tools.ts). Calls the
 *   floor denies outright never become asks, so nothing here widens them.
 * - `never`: anything on a session Persona didn't launch, a project that isn't
 *   launchable, a launch into a project whose harness has no safety floor
 *   (Codex), and keystrokes into a pane that isn't idle at its prompt.
 */

/** Reads and owner-facing actions: they change nothing a worker or anyone else sees. */
export const READ_ACTIONS: ReadonlySet<string> = new Set([
  "list_projects",
  "list_jobs",
  "search_board",
  "list_sessions",
  "list_schedules",
  "session_status",
  "read_session",
  "search_thread",
  "get_plan",
  "get_checkpoint",
  "recall",
  "search_knowledge",
  "knowledge_usage",
  "ask_user",
  "close_question",
  "attach_image",
  "attach_video",
  "tag_reply",
  "list_knowledge_drafts",
  "get_knowledge_draft",
  "list_reviews",
  "answer_review_question",
  "list_playbooks",
  "list_commitments",
  "list_signals",
  "read_doc",
  "list_docs",
]);

/** Persona's routine orchestration: acts unless the floor or an owner hold applies. */
export const ROUTINE_ACTIONS = [
  "launch_session",
  "send_to_session",
  "interrupt_session",
  "recover_session",
  "stop_session",
  "set_session_keep_alive",
  "waive_pipeline_stage",
  "park_session",
  "unpark_session",
  "set_pipeline",
  "answer_ask",
  "approve_plan",
  "reject_plan",
  "remember",
  "forget",
  "decide_knowledge_draft",
  "save_playbook",
  "decide_playbook",
  "open_job",
  "update_job",
  "close_job",
  "close_review_tunnel",
  "schedule_wakeup",
  "cancel_wakeup",
  "commit",
  "close_commitment",
  "drop_commitment",
  "update_commitment",
  "create_schedule",
  "update_schedule",
  "delete_schedule",
  "run_schedule_now",
  "restart_standup",
  "write_doc",
] as const;

/**
 * Holds the run of every acceptance criterion of a Persona-approved plan as a
 * floor ask Persona decides, however plain (floor/criterion.ts reads it at
 * run time).
 */
export const HOLD_ACCEPTANCE_CRITERION = "acceptance_criterion";

/**
 * Holds only Persona's acceptance of a review's wontfix findings
 * (waive_pipeline_stage kind accept_wontfix) for the owner, leaving its
 * not-applicable waivers routine.
 */
export const HOLD_ACCEPT_WONTFIX = "accept_wontfix";

/** What `STANDUP_PERSONA_HOLD` may name: a routine action, HOLD_ACCEPTANCE_CRITERION or HOLD_ACCEPT_WONTFIX. */
export const HOLDABLE: ReadonlySet<string> = new Set([...ROUTINE_ACTIONS, HOLD_ACCEPTANCE_CRITERION, HOLD_ACCEPT_WONTFIX]);

/** The owner's own tightening of the routine tier. The floor can't be loosened here. */
export interface PolicySettings {
  /** Routine actions the owner wants held for approval, or HOLD_ACCEPTANCE_CRITERION (held for Persona's floor review). */
  hold?: ReadonlySet<string>;
}

const BOOKKEEPING = new Set([
  "open_job",
  "update_job",
  "close_job",
  "close_review_tunnel",
  "schedule_wakeup",
  "cancel_wakeup",
  "commit",
  "close_commitment",
  "drop_commitment",
  "update_commitment",
]);

// recover_session drives the pane only within what session-recovery.ts allows:
// Escape on a non-permission dialog and a fixed wake line at an idle prompt.
// waive_pipeline_stage only moves pipeline bookkeeping, and the collector
// holds each kind to what the change is: not_applicable only on a launch that
// changed no code, accept_wontfix only on a review whose every High/Medium
// finding is wontfix, skip never on a coded launch's validation or review,
// and skip, waive and close_out never on a protected stage (a full run's code_review,
// human_review) or a full run's deploy or screenshot the change touches. The
// outward steps themselves still stop at the worker's safety floor.
// park_session and unpark_session only say whether the worker's Stop is held
// for a stage report; unpark_session's message is typed in only at an idle
// prompt (queued otherwise), through the same send route as send_to_session.
// set_session_keep_alive only says whether an idle worker may be paused.
const SESSION_ACTIONS = new Set([
  "send_to_session",
  "interrupt_session",
  "recover_session",
  "stop_session",
  "set_session_keep_alive",
  "waive_pipeline_stage",
  "park_session",
  "unpark_session",
]);

const SCHEDULE_ACTIONS = new Set(["create_schedule", "update_schedule", "delete_schedule", "run_schedule_now"]);

// ── Normalization ───────────────────────────────────────────────────────────

/** Cyrillic and Greek letters that render like Latin ones. */
const HOMOGLYPHS: Record<string, string> = {
  а: "a", в: "b", е: "e", ё: "e", к: "k", м: "m", н: "h", о: "o", р: "p", с: "c", т: "t", у: "y", х: "x",
  і: "i", ї: "i", ј: "j", ѕ: "s", ԁ: "d", ɡ: "g", һ: "h", ӏ: "l", ԛ: "q", ԝ: "w",
  А: "A", В: "B", Е: "E", К: "K", М: "M", Н: "H", О: "O", Р: "P", С: "C", Т: "T", У: "Y", Х: "X", І: "I", Ј: "J", Ѕ: "S",
  α: "a", β: "b", ε: "e", ι: "i", κ: "k", ν: "v", ο: "o", ρ: "p", τ: "t", υ: "u", χ: "x", ω: "w",
  Α: "A", Β: "B", Ε: "E", Ζ: "Z", Η: "H", Ι: "I", Κ: "K", Μ: "M", Ν: "N", Ο: "O", Ρ: "P", Τ: "T", Υ: "Y", Χ: "X",
};
const HOMOGLYPH_RE = new RegExp(`[${Object.keys(HOMOGLYPHS).join("")}]`, "g");

/** Apostrophe look-alikes, read as `'`. */
const APOSTROPHES = /[\u02bc\u2018\u2019`\u00b4\u2032]/g;

/** Every line or paragraph break a renderer shows as one: carriage return, VT, FF, NEL, LS, PS. */
const LINE_BREAKS = /\r\n?|[\u000b\u000c\u0085\u2028\u2029]/g;

/** A shell line continuation: a backslash ending the line, joined with the next. */
const LINE_CONTINUATION = /\\[ \t]*\n[ \t]*/g;

/**
 * Removes Markdown emphasis, which renders as plain words: `**`/`__` runs
 * anywhere, and a `*`/`_` run opening or closing a word (`_push_`), while
 * `snake_case` and a lone `*` stay.
 */
function stripEmphasis(text: string): string {
  return text
    .replace(/\*\*+|__+/g, "")
    .replace(/(^|[\s(\[{>"'])[*_]+(?=[^\s*_])/gm, "$1")
    .replace(/(?<=[^\s*_])[*_]+(?=$|[\s.,;:!?)\]}"'])/gm, "");
}

/**
 * `text` NFKC-folded, with every line break kind unified to `\n`, shell line
 * continuations joined, format characters (zero-width, bidi controls)
 * removed, look-alike letters mapped to Latin, apostrophes unified and
 * Markdown emphasis stripped. Line breaks are kept, since they separate
 * clauses.
 */
function foldText(text: string): string {
  return stripEmphasis(
    text
      .normalize("NFKC")
      .replace(LINE_BREAKS, "\n")
      .replace(/\p{Cf}/gu, "")
      .replace(HOMOGLYPH_RE, (ch) => HOMOGLYPHS[ch] ?? ch)
      .replace(APOSTROPHES, "'")
      .replace(LINE_CONTINUATION, " ")
  );
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * The readings of folded text: whitespace collapsed, plus that reading with
 * quotes and backslashes removed, which a shell would drop (`g'i't push`,
 * `ap""i`).
 */
function readingsOf(folded: string): string[] {
  const reading = collapse(folded);
  const unquoted = collapse(reading.replace(/["'\\]/g, ""));
  return unquoted === reading ? [reading] : [reading, unquoted];
}

/** The readings of `text` every verdict tests (see foldText and readingsOf). */
export function normalizedReadings(text: string): string[] {
  return readingsOf(foldText(text));
}

// ── Collector API ───────────────────────────────────────────────────────────

/** The collector's ports: public and slot, for the defaults plus any configured for this process. */
const COLLECTOR_PORTS = [...collectorPortSet(process.env)].map(String);

/**
 * Hosts that reach this machine: loopback names (`localhost`, any
 * `*.localhost`, `localtest.me`, `127.0.0.1.nip.io`), the numeric and IPv6
 * spellings of 127.0.0.1 (including IPv4-mapped hex like `[::ffff:7f00:1]`)
 * and the machine's own name as a shell expands it (`$(hostname)`,
 * `` `hostname` ``, `$HOSTNAME`).
 */
const LOOPBACK_HOST = String.raw`(?:localhost|(?:[\w-]+\.)+localhost|(?:[\w-]+\.)*localtest\.me|(?:[\w-]+\.)*127(?:[.-]\d{1,3}){3}\.(?:nip|sslip|xip)\.io|127(?:\.\d{1,3}){0,3}|0\.0\.0\.0|0x7f[0-9a-f.x]*|0177[0-7.]*|2130706433|\[(?:0*:)*:?0*1\]|::1|\[::ffff:127(?:\.\d{1,3}){3}\]|\[(?:0*:)*:?ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]|\[::\]|\$\(\s*hostname(?:\s+-\w+)*\s*\)|'hostname(?:\s+-\w+)*'|\$\{?HOSTNAME\}?)`;

/**
 * References to the collector's own HTTP API. A worker that is told to call it
 * directly could resolve as the owner on loopback, so such text is held. Only
 * collector-addressing forms count: a loopback host carrying `/api/` or
 * `/hook`, the collector's ports where a port goes (`:7777`, `port 7777`,
 * `-p 7777`; a bare `7777` inside an id or hash is not one), its env vars,
 * its token headers and its own Persona/ask/plan routes. A path like
 * `/api/orders` alone is someone's app.
 */
const COLLECTOR_API: readonly RegExp[] = [
  new RegExp(String.raw`(?:^|[^\w.-])${LOOPBACK_HOST}(?::\d+)?\s*(?:/|%2f)\s*(?:api|hook)\b`, "i"),
  new RegExp(String.raw`(?::|%3a|\bports?\s*(?:[:=#]|\bof\b|\bat\b)?\s*|(?:^|\s)-p\s*)(?:${COLLECTOR_PORTS.join("|")})(?!\d)`, "i"),
  /\bCOLLECTOR_URL\b|\bSTANDUP_URL\b/i,
  /x-standup-(?:write|persona)-token/i,
  /\/api\/(?:persona|asks|plans?)\b/i,
];

export function referencesCollectorApi(text: string | undefined): boolean {
  if (!text) return false;
  return normalizedReadings(text).some((reading) => COLLECTOR_API.some((re) => re.test(reading)));
}

/**
 * What makes a collector reference a write: a write method or request body,
 * the collector's token headers or write-token file, a mutating route, or a
 * verb that changes its state.
 */
const COLLECTOR_WRITE =
  /(?:-X|--request|--method)\s*(?:POST|PUT|PATCH|DELETE)\b|\b(?:POST|PUT|PATCH|DELETE)\b|\bmethod\s*[:=]\s*["']?(?:post|put|patch|delete)|\s(?:-d|--data[\w-]*|-F|--form|-T|--upload-file|--json)\b|x-standup-(?:write|persona)-token|write-token|\/(?:approve|deny|reject|resolve|send|steer|interrupt|stop|launch|pause|resume|reset|submit|ready|answer|tool|hook|knowledge)\b|\b(?:approv\w*|deny|denies|reject\w*|resolv\w*|answer\w*|launch\w*|interrupt\w*|steer\w*|pause|resume|reset|delet\w*|modif\w*|creat\w*|updat\w*|writ\w*|post(?:s|ed|ing)?|put|patch)\b/i;

/**
 * Whether `text` tells a worker to write to the collector's own HTTP API. A
 * worker that does could act as the owner on loopback. Each clause that
 * references the API (see referencesCollectorApi) is held only when it is
 * write-shaped (COLLECTOR_WRITE); a read such as checking `:7777/health` or
 * `/api/persona/state` is not a write.
 */
export function writesCollectorApi(text: string | undefined): boolean {
  if (!text) return false;
  return foldText(text)
    .split(CLAUSE_BREAK)
    .some((clause) => !!clause && referencesCollectorApi(clause) && normalizedReadings(clause).some((r) => COLLECTOR_WRITE.test(r)));
}

// ── Outward-facing steps ────────────────────────────────────────────────────

/** The kinds of outward-facing step, named in a hold's reason. */
export type OutwardCategory =
  | "push"
  | "merge"
  | "review"
  | "release"
  | "remote-write"
  | "message"
  | "opaque"
  | "routine";

/** A push/merge destination that is a branch or remote, not a file like `main.ts`. */
const PROTECTED_REF = String.raw`(?:origin|remote|upstream|mainline|main|master|trunk|github|gitlab|prod|production|fork)(?![\w.-]*\w)`;
const REVIEW_NOUN = String.raw`(?:prs?|mrs?|pull\s+requests?|merge\s+requests?|code\s+reviews?|revisions?)`;
const TICKET_NOUN = String.raw`(?:tickets?|issues?|jira(?:\s+tickets?)?|bug\s+reports?)`;
const DETERMINERS = String.raw`(?:(?:a|an|the|this|that|your|my|our|new|another|draft|separate)\s+)*`;
/** What follows a review noun when it names a file or a feature of the code, not a live review. */
const REVIEW_NOUN_AS_CODE = String.raw`(?!\s+(?:(?:description|title|body)\s+)?(?:templates?|checklists?|parser|labels?|bot|comments?\s+parser|rendering|ui|page|component|view|list|history|model|schema|table)\b)`;

/**
 * A request frame that puts the step it introduces to the owner: "should I",
 * "OK to", "want me to", "ready to", "go ahead and" …
 */
const REQUEST_FRAME = String.raw`(?:(?:should|can|could|may|shall|must)\s+(?:i|we)|(?:is\s+it\s+)?(?:ok(?:ay)?|fine|alright|all\s+right|safe|good)\s+(?:to|if\s+(?:i|we))|(?:do\s+you\s+)?want\s+(?:me|us)\s+to|ready\s+to|proceed\s+(?:and|to)|go\s+ahead\s+and|time\s+to|permission\s+to|(?:i'?d|i\s+would)\s+like\s+to|i'?ll|i\s+will|let\s+me|mind\s+if\s+(?:i|we)|(?:need|going|about|plan(?:ning)?)\s+to)`;
/**
 * The start of an imperative clause: the text or clause start, a list or
 * dash break, a joining word, or an interjection ("yes,", "ok,", "go ahead").
 */
const CLAUSE_OPENER = String.raw`(?:^|[,:;(]|[—–]|\s-\s|\b(?:and|then|or|please|now|finally|also|so|yes|yep|ok(?:ay)?|sure|lgtm|approved|great|fine|alright|done|go\s+ahead)\b)`;
/** Adverbs and local steps that may come between the frame and the outward verb ("also", "commit and"). */
const STEP_LEAD = String.raw`(?:\s*(?:also|just|now|then|actually|finally|first|quickly|please|go\s+ahead\s+and)\b)*(?:\s*(?:commit|rebase|amend|squash|tag|build|test|stage|fix|finish|wrap\s+up|bump|version)(?:\s+(?:it|this|that))?\s*(?:,|and|&&?|\+))*`;
/** The outward verbs read as a step on their own, with or without an object. */
const BARE_VERB = String.raw`(?:force[\s-]?push|push|merge|land|deploy|publish|release|ship|submit|upload|roll\s+(?:(?:it|this|that|them)\s+)?out|promote|approve|tweet)(?![\w-])`;
/** Objects a bare outward verb takes: the work itself, a review, a build or release. */
const STEP_OBJECT = String.raw`(?:changes?|fix(?:es)?|hotfix(?:es)?|branch(?:es)?|commits?|prs?|mrs?|diffs?|patch(?:es)?|revisions?|releases?|builds?|stacks?|services?|apps?|application|packages?|versions?|code|work|features?|updates?|tags?|images?|artifacts?|sites?|lambdas?|pull\s+requests?|merge\s+requests?|code\s+reviews?|stuff|binar(?:y|ies)|bundles?|containers?|charts?|infra(?:structure)?|pipelines?|workflows?|deployments?|rollouts?|migrations?|candidates?)`;
/**
 * What may follow a bare outward verb for it to read as the step: the clause
 * end, a pronoun or adverb, a joining word, or a determiner with one of
 * STEP_OBJECT. So "release it" and "OK to merge?" count, while "release
 * notes", "push notifications" and "release the lock" don't.
 */
const STEP_CONTINUATION = String.raw`(?=\s*(?:$|[?.!,;:)\]—–]|\s-\s|&&|\|\|)|\s+(?:it|them|everything|all|now|up|out|upstream|again|anyway|too|first|today|tonight|yet|immediately|asap|right\s+away|when|once|after|and|or|to|onto|into|without|here|there)(?![\w-])|\s+(?:this|that|these|those)(?=\s*(?:$|[^\w\s-]))|\s+(?:the|a|an|my|your|our|its|their|this|that|these|those)\s+(?:[\w./-]+\s+){0,2}?${STEP_OBJECT}(?![\w-]))`;

/**
 * Proper names the messaging patterns must not read as a person: product and
 * code nouns that are capitalized in briefs ("the Slack Webhook handler").
 */
const NOT_A_PERSON = String.raw`(?!(?:API|App|Apps|Bot|Client|Parser|Handler|Helper|Service|Webhook|Integration|Channel|Template|Queue|Module|Config|Sender|Notifications?|Alerts?|SDK|CLI|Lambda|SNS|SQS|SES|Field|Input|Box|Area|Editor|Thread|Format|Address|Body|Header|Server|Worker|Job|Task|Event|Events|Button|Dialog|Form)\b)`;
/** A capitalized first name ("Alice", "@bob"), matched case-sensitively. */
const PERSON = String.raw`@?${NOT_A_PERSON}[A-Z][a-z]+\b`;

/**
 * What follows a merge that keeps it local: merging with something, together,
 * or into anything but a protected branch ("merge it with the defaults",
 * "merge the latest main into your branch"), or merging "them" (two configs)
 * anywhere but a protected branch.
 */
const LOCAL_MERGE =
  /^\s*(?:(?:it|them|these|those|both|everything|all|(?:the|their|our)\s+(?:[\w-]+\s+){0,3}?[\w-]+)\s+)?(?:with|together|in\b|into\s+(?!(?:the\s+)?(?:main|mainline|master|trunk|prod|production|upstream)\b))|^\s*(?:them|these|those|both)\b(?![^,.;]*\b(?:to|into|onto)\s+(?:the\s+)?(?:main|mainline|master|trunk|prod|production|upstream)\b)/i;

interface OutwardPattern {
  category: OutwardCategory;
  re: RegExp;
  /** A match is dropped when this tests true against the rest of the clause after it. */
  unless?: (rest: string, step: string) => boolean;
}

/** Opening a review: "open a PR", "cut a new code review". `noun` is a regex source naming a review. */
function openReview(noun: string): RegExp {
  return new RegExp(
    String.raw`\b(?:open|create|cut|submit|raise|publish|file|send|put\s+up|post)(?:s|ed|ing|ting)?\s+(?:up\s+)?${DETERMINERS}${noun}\b${REVIEW_NOUN_AS_CODE}`,
    "i"
  );
}

/** Acting on a live review: merging, approving, updating, marking it ready. */
function actOnReview(noun: string): RegExp {
  return new RegExp(
    String.raw`\b(?:merg|land|approv|updat|ship|upload|push|revis|amend|mark|abandon|clos|reopen|re-?open|rebas|edit|retitl|resubmit)(?:e|es|ed|ing|s)?\s+${DETERMINERS}(?:[\w-]+\s+)?${noun}\b${REVIEW_NOUN_AS_CODE}`,
    "i"
  );
}

/** Putting a review up: "get the PR up", "throw a code review up". */
function putReviewUp(noun: string): RegExp {
  return new RegExp(String.raw`\b(?:get|put|throw)\s+${DETERMINERS}${noun}\s+up\b`, "i");
}

/** Commenting or replying on a review, ticket or thread; `nouns` is a regex alternation. */
function commentOn(nouns: string): RegExp {
  return new RegExp(
    String.raw`\b(?:(?:post|leave|add|write|drop)\s+(?:a\s+|an\s+|the\s+|your\s+)?(?:[\w-]+\s+)?(?:comments?|reply|replies|notes?)|comment(?:s|ed|ing)?|repl(?:y|ies|ied|ying))\s+(?:on|to|in)\s+${DETERMINERS}(?:[\w-]+\s+)?(?:${nouns})\b`,
    "i"
  );
}

/** Posting results or a status onto a review or ticket; `nouns` is a regex alternation. */
function postOnto(nouns: string): RegExp {
  return new RegExp(
    String.raw`\b(?:post|put|write|add|share|drop|leave|update)(?:s|ed|ing)?\b[^,]{0,40}?\b(?:on|to|in)\s+${DETERMINERS}(?:[\w-]+\s+)?(?:${nouns})\b(?!\s+(?:templates?|model|schema|parser|table|ui|page|component|form|tracker|history|list)\b)`,
    "i"
  );
}

/**
 * Outward-facing steps: commands and verb+object instructions that publish
 * work or speak for the owner where others will see. Each pattern needs the
 * act itself (a command, a verb with its target, or a bare outward verb in a
 * request or imperative clause), so nouns that merely name such things ("the
 * deploy docs", "release notes", "the PR template") are not steps.
 */
const OUTWARD_FACING: readonly OutwardPattern[] = [
  // git with any global options before the subcommand (`git -C repo push`).
  { category: "push", re: /\bgit\b(?:\s+(?:-C\s+\S+|-c\s+\S+|--[\w-]+(?:=\S+)?|-\w+))*\s+push\b/i },
  { category: "push", re: /\bgit\s+(?:subtree\s+push|review|svn\s+dcommit|p4\s+submit)\b/i },
  { category: "push", re: /\b(?:hg|sl|jj)\s+(?:git\s+)?push\b|\barc\s+(?:land|diff)\b|\brepo\s+upload\b|\bgt\s+submit\b|\bp4\s+submit\b|\bsvn\s+(?:commit|ci)\b/i },
  {
    category: "push",
    re: new RegExp(
      String.raw`\b(?:force[\s-]?)?push(?:es|ed|ing)?\b(?!\s+notifications?\b)[^,]{0,60}?\b(?:to|into|onto|on|up\s+to)\s+(?:[\w/-]+\s+){0,4}?${PROTECTED_REF}`,
      "i"
    ),
  },
  { category: "push", re: new RegExp(String.raw`\bpush(?:es|ed|ing)?\s+(?:origin|upstream)\b`, "i") },
  {
    category: "push",
    re: /\b(?:force[\s-]?)?push(?:es|ed|ing)?\s+(?:(?:the|this|that|your|my|our|these|those)\s+)?(?:branch|branches|commits?|changes|fix|tags?)\b/i,
  },
  { category: "push", re: /\b(?:publish|sync)(?:es|ed|ing)?\s+(?:(?:the|this|that|your|my|our)\s+)?(?:[\w/-]+\s+)?branch(?:es)?\b/i },
  { category: "push", re: /\bsync(?:s|ed|ing)?\b[^,]{0,40}?\b(?:to|with)\s+(?:github|gitlab|bitbucket|the\s+remote|remote|origin|upstream)\b/i },
  // A bare outward verb after a request frame or opening an imperative clause.
  {
    category: "push",
    re: new RegExp(String.raw`(?:\b${REQUEST_FRAME}|${CLAUSE_OPENER})${STEP_LEAD}\s*${BARE_VERB}${STEP_CONTINUATION}`, "i"),
    unless: (rest, step) => /merge/i.test(step) && LOCAL_MERGE.test(rest),
  },
  // A request for the step as a noun ("go ahead with the merge?").
  {
    category: "release",
    re: /\b(?:proceed|go\s+ahead|ready|time|ok(?:ay)?|good)\s+(?:with|for)\s+(?:the\s+|a\s+)?(?:merge|merging|deploy(?:ment)?|release|push|rollout|roll-?out|launch|publish(?:ing)?|submission|ship(?:ping)?|upload)\b(?!\s+(?:notes?|docs?|script|date|template|checklist|notifications?|conflicts?)\b)/i,
  },
  { category: "release", re: /\bclick(?:s|ed|ing)?\s+(?:on\s+)?(?:the\s+)?(?:merge|approve|publish|deploy|release|submit|ship)\b/i },
  {
    category: "merge",
    re: /\bmerg(?:e|es|ed|ing)\b[^,]{0,60}?\b(?:into|to|onto)\s+(?:(?:the\s+)?(?:main|mainline|master|trunk)\s+branch\b|(?:the\s+)?mainline\b|(?:main|master|trunk|upstream|prod|production)(?![\w.\/-]*\w))/i,
  },
  { category: "merge", re: /\bland\s+(?:it\b|(?:the|this|that|your|my)\s+(?:change|pr|mr|diff|commit|branch)s?\b)/i },
  { category: "merge", re: /\bsquash[\s-]+(?:and|&|\+)[\s-]+merge\b|\b(?:enable|turn\s+on|set(?:\s+up)?|arm)\s+(?:the\s+)?auto[\s-]?merge\b/i },
  {
    category: "merge",
    re: /\bmerge\s+it\b/i,
    unless: (rest) => LOCAL_MERGE.test(` it${rest}`),
  },
  { category: "merge", re: /\bglab\s+mr\b(?!\s+(?:list|view|diff|checkout)\b)/i },
  { category: "review", re: /\bgh\s+(?:pr|release)\s+(?:create|merge|edit|close|comment|review|ready|reopen|upload|delete)\b/i },
  { category: "review", re: /\bhub\s+(?:pull-request|release|push)\b/i },
  {
    category: "remote-write",
    re: /\bgh\s+api\b[^|;&\n]{0,200}?(?:(?:-X|--method)\s*(?:POST|PUT|PATCH|DELETE)\b|\s(?:-f|-F|--field|--raw-field|--input)\b)/i,
  },
  { category: "remote-write", re: /\bgh\s+(?:repo|gist|issue)\s+(?:create|edit|delete|fork|comment|close|reopen|rename|archive)\b/i },
  { category: "review", re: openReview(REVIEW_NOUN) },
  { category: "review", re: actOnReview(REVIEW_NOUN) },
  { category: "review", re: /\b(?:submit|send|put)(?:s|ted|ting)?\b[^,]{0,30}?\b(?:for|out\s+for|up\s+for)\s+(?:code\s+)?review\b/i },
  { category: "review", re: /\bget\s+(?:it|this|that|them|(?:the|this|my|your)\s+(?:[\w-]+\s+)?(?:change|changes|pr|mr|diff|code|fix|branch))\s+reviewed\b/i },
  { category: "review", re: putReviewUp(REVIEW_NOUN) },
  {
    category: "review",
    re: /\b(?:request|re-?request|add|assign)(?:s|ed|ing)?\s+(?:a\s+|an?other\s+|the\s+|more\s+)?(?:code\s+)?review(?:ers?|s)?\b(?!\s*(?:fields?|steps?|columns?|tables?|models?|components?|pages?|forms?|flags?|queues?|status|states?|logic|apis?|endpoints?|sections?|tests?|checklists?)\b)/i,
  },
  { category: "review", re: /\badd(?:s|ed|ing)?\s+@?[\w.-]+\s+as\s+(?:a\s+)?reviewers?\b|\b(?:request|ask\s+for)\s+(?:a\s+)?(?:code\s+)?review\s+from\b/i },
  { category: "release", re: /\b(?:npm|yarn|pnpm|bun|cargo|gem|poetry|gradle|dotnet\s+nuget|twine)\s+(?:publish|push|upload)\b/i },
  { category: "release", re: /\b(?:docker|podman)\s+(?:image\s+)?push\b/i },
  { category: "release", re: /\b(?:docker\s+)?(?:buildx\s+build|buildx|build)\b[^|;&\n]{0,200}?\s--push\b/i },
  { category: "release", re: /\bmvn\b[^|;&\n]{0,80}?\bdeploy\b/i },
  {
    category: "release",
    re: /\b(?:cdk|sam|serverless|sls|terraform|tofu|pulumi|kubectl|helm|amplify|flyctl|fly|vercel|firebase|eb|netlify|wrangler|railway|heroku)\s+(?:\S+\s+){0,2}?(?:deploy|apply|destroy|install|upgrade|up|publish|delete|release)\b/i,
  },
  { category: "release", re: /\bvercel\b[^|;&\n]{0,80}?\s--prod\b/i },
  { category: "release", re: /\bkubectl\s+(?:(?:-n|--namespace|--context)[\s=]\S+\s+)*(?:rollout|set\s+image|apply|delete|scale|patch|replace|edit|drain)\b/i },
  { category: "release", re: /\bgcloud\b(?:\s+[\w-]+){1,4}?\s+deploy\b|\baz\s+(?:[\w-]+\s+){1,3}?deploy\b/i },
  { category: "release", re: /\bansible-playbook\b/i },
  { category: "release", re: /\bgh\s+workflow\s+run\b|\bgh\s+run\s+rerun\b/i },
  {
    category: "release",
    re: /\baws\s+(?:lambda\s+(?:update-function-code|update-function-configuration|publish-version|publish-layer-version|create-function|delete-function|update-alias)|cloudformation\s+(?:deploy|create-stack|update-stack|delete-stack|execute-change-set))\b/i,
  },
  {
    category: "release",
    re: /\bdeploy(?:s|ed|ing)?\b[^,]{0,40}?\b(?:to|in|into|on)\s+(?:the\s+)?(?:prod|production|beta|gamma|staging|preprod|aws|live|an?\s+environment|(?:the\s+)?environment|cluster|fleet)\b/i,
  },
  { category: "release", re: /\bdeploy\s+(?:it|this|that|them|(?:the|this|your)\s+(?:stack|stacks|service|app|change|changes|fix|lambda|site|build|release))\b/i },
  { category: "release", re: /\bpromot(?:e|es|ed|ing)\b[^,]{0,30}?\bto\s+(?:prod|production|gamma|beta|staging|live)\b/i },
  { category: "release", re: /\bship\s+it\b/i },
  { category: "release", re: /\broll(?:s|ed|ing)?\s+(?:(?:it|this|that|them|everything)\s+|(?:the|this|that|our|your)\s+(?:[\w-]+\s+){0,2}?)?out\b(?!\s+of\b)/i },
  {
    category: "release",
    re: /\b(?:trigger|kick\s+off|start|re-?run|run|launch|dispatch|re-?trigger)(?:s|ed|ing)?\s+(?:(?:the|a|an|our|this|that|new)\s+)?(?:[\w.-]+\s+){0,2}?(?:pipelines?|workflows?|deployments?|deploys?|rollouts?)\b(?!\s+(?:locally|tests?|code|module|unit|script|docs?|config|definition|file|yaml|yml|notes?)\b)/i,
  },
  { category: "release", re: /\brun\s+(?:the\s+)?(?:deploy(?:ment)?|release|publish|rollout)\s+(?:script|job|task|command|step|target)\b(?!\s+locally\b)/i },
  { category: "release", re: /\b(?:make|just|rake|task|npm\s+run|yarn(?:\s+run)?|pnpm(?:\s+run)?|bun\s+run)\s+(?:[\w-]*:)?(?:deploy|release|publish|ship|rollout)\b(?!-(?:notes|docs)\b)/i },
  { category: "release", re: /(?:^|[\s'"(])(?:\.{1,2}\/|(?:ba|z)?sh\s+|python3?\s+|node\s+)[\w./-]*(?:deploy|release|publish|rollout)[\w.-]*/i },
  { category: "release", re: /\bcut(?:s|ting)?\s+(?:(?:a|an|the|new|another|next)\s+)*(?:release|tag|version)s?\b(?!\s+(?:notes?|docs?|date|template|checklist|script)\b)/i },
  {
    category: "release",
    re: /\b(?:publish|release)(?:es|ed|ing|s)?\s+(?:it\b|(?:version\s+)?v?\d+(?:\.\d+)*\b|(?:(?:the|a|this|that|new|next|our|your)\s+)+(?:[\w-]+\s+){0,2}?(?:package|version|release|crate|gem|module|image|artifact|library)s?\b)/i,
  },
  { category: "remote-write", re: /\baws\s+s3\s+(?:cp|mv|sync|rm)\b[^|;&\n]{0,200}?s3:\/\//i },
  { category: "remote-write", re: /\baws\s+s3\s+(?:rm|rb)\b|\baws\s+dynamodb\s+(?:delete-[\w-]+|put-item|update-item|batch-write-item|update-table)\b/i },
  // A database client pointed at a non-local host, running a write.
  {
    category: "remote-write",
    re: /\b(?:psql|mysql|mariadb|pgcli|mycli)\b[^|\n]{0,200}?(?:\s-h\s*|\s--host[=\s]|(?:postgres(?:ql)?|mysql):\/\/(?:[^@\s/]*@)?)(?!(?:localhost|127\.[\d.]+|::1|\[::1\])(?![\w.-]))[\w.-]+[^|\n]{0,300}?\b(?:DELETE|DROP|UPDATE|TRUNCATE|INSERT|ALTER|GRANT)\b/i,
  },
  { category: "remote-write", re: /\b(?:scp|rsync)\b[^|;&\n]{0,200}?\s[\w.@-]+:/i },
  // HTTP writes: an explicit write method or a request body.
  {
    category: "remote-write",
    re: /\b(?:curl|wget|httpie|xh)\b[^|;&]{0,200}(?:-X\s*(?:POST|PUT|PATCH|DELETE)\b|--request\s+(?:POST|PUT|PATCH|DELETE)\b|\s-d\b|\s--data|\s-F\b|\s--form\b|\s-T\b|\s--upload-file\b|\s--post-(?:data|file)\b)/i,
  },
  { category: "remote-write", re: /\b(?:http|https|xh)\s+(?:POST|PUT|PATCH|DELETE)\b/ },
  // Opaque or remote code piped into a shell.
  { category: "opaque", re: /\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b/i },
  { category: "opaque", re: /\bbase64\s+(?:-d|--decode)\b/i },
  {
    category: "message",
    re: /\b(?:post|send|message|notify|e-?mail|dm|ping|announce|share|tweet|broadcast)(?:s|ed|ing)?\b[^,]{0,60}?\b(?:to|in|on|into|via|over)\s+(?:the\s+)?(?:slack|#[\w-]+|e-?mail|teams|chime|discord|twitter|sns|the\s+team|team\s+channel|everyone|channel)\b/i,
  },
  {
    category: "message",
    re: /\b(?:notify|e-?mail|dm|ping|message|announce\s+to)\s+(?:the\s+team|everyone|the\s+channel|#[\w-]+|stakeholders|the\s+(?:on-?call|reviewers?|owners|users?|customers?))\b/i,
  },
  { category: "message", re: /\bsend\s+(?:an?\s+|the\s+)?(?:e-?mails?|slack\s+messages?|dms?|notifications?\s+to)\b/i },
  { category: "message", re: /\b(?:e-?mail|mail|dm|slack)\s+(?:it|this|that|them)\b/i },
  // Messaging a named person: "message Alice", "Slack Bob", "notify @carol".
  {
    category: "message",
    re: new RegExp(
      String.raw`(?<!\b(?:the|a|an|for|of|in|our|my|your|this|that)\s+)\b(?:[Ee]-?mail|[Mm]essage|[Nn]otify|[Pp]ing|[Ss]lack|DM|[Dd]m|[Tt]ext|[Cc]c|CC|[Bb]cc|[Cc]ontact|[Pp]age)\s+${PERSON}`
    ),
  },
  {
    category: "message",
    re: new RegExp(
      String.raw`\b[Ss]end\s+${PERSON}\s+(?:an?\s+|the\s+)?(?:e-?mails?|messages?|notes?|dms?|pings?|slacks?|texts?|summary|update|link|report|invite)\b`
    ),
  },
  { category: "message", re: /@-?mention(?:s|ed|ing)?\b|\bmention\s+@[\w.-]+/i },
  // An address set as git's identity (`-c user.email=…`, `git config user.email …`, GIT_AUTHOR_EMAIL) is who commits, not who is written to.
  // A verb or an address that is a segment of a file path (`~/.local/share/…`, `…/.bun/typescript@5.9.3/…`) is neither.
  {
    category: "message",
    re: /(?<![/.])\b(?:send|e-?mail|forward|mail|cc|bcc|notify|message|share|post)\b(?![/.]\w)[^,;\n]{0,80}?(?<![\w.+/~-])(?<!(?:\bgit\s+(?:(?:-[Cc]\s+\S+|--[\w-]+(?:=\S+)?)\s+)*(?:config\s+(?:--[\w-]+\s+)*user\.email\s+|-c\s+user\.email=)|(?:^|[;&|(]\s*)GIT_(?:AUTHOR|COMMITTER)_EMAIL=)["']?)[\w.+-]+@[\w-]+(?:\.[\w-]+)+(?![\w.-]*\/)/i,
  },
  { category: "message", re: /\blet\s+(?!me\b|us\b|you\b|it\b)(?:the\s+)?[\w-]+(?:\s+team)?\s+know\b/i },
  {
    category: "message",
    re: /\b(?:send|forward|escalate|page)(?:s|ed|ing)?\b[^,]{0,60}?\bto\s+(?:the\s+)?(?:on-?call|oncall|team|channel|reviewers?|owners|managers?|leads?|stakeholders|everyone|security|support|leadership)\b/i,
  },
  {
    category: "message",
    re: /\b(?:reply|respond|answer)(?:s|ed|ing)?\s+to\s+(?:the\s+|their\s+|all\s+(?:the\s+)?|each\s+)?(?:reviewers?'?s?|review(?:er)?\s+comments?|comments?|feedback|(?:pr|mr|code\s+review)\s+(?:feedback|comments?)|threads?)\b/i,
  },
  { category: "message", re: /\b(?:cc|bcc)\s+(?:the\s+(?:team|channel|on-?call|group|reviewers?|owners?|managers?)|everyone|@[\w.-]+)/i },
  { category: "message", re: /\btweet(?:s|ed|ing)?\s+(?:it|this|that|them|about|out|the|a|an)\b|\b(?:post|share)\b[^,]{0,40}?\bon\s+(?:twitter|x\.com|linkedin|mastodon|bluesky|social\s+media)\b/i },
  { category: "message", re: commentOn(`${REVIEW_NOUN}|${TICKET_NOUN}|reviews?|threads?`) },
  // Posting results or a status onto a review or ticket.
  { category: "message", re: postOnto(`${REVIEW_NOUN}|${TICKET_NOUN}`) },
  {
    category: "message",
    re: new RegExp(
      String.raw`\b(?:create|file|open|update|close|resolve|reopen|cut|raise|assign)(?:s|d|ed|ing)?(?:\s+out)?\s+${DETERMINERS}(?:[\w-]+\s+)?${TICKET_NOUN}\b(?!\s+templates?\b)`,
      "i"
    ),
  },
  {
    category: "message",
    re: new RegExp(String.raw`\b(?:file|open|create|raise|cut|log|report|submit)(?:s|d|ed|ing)?\s+${DETERMINERS}(?:[\w-]+\s+)?(?:bugs?|follow-?up\s+(?:tickets?|issues?))\b`, "i"),
  },
  // The owner's own release routine, invoked by reference.
  { category: "routine", re: /\b(?:usual|normal|standard)\s+(?:final\s+|release\s+|closing\s+)?steps?\b/i },
  { category: "routine", re: /\bfinal\s+steps?\s+(?:from|in|per)\b/i },
];

/** Spaced-out spellings (`g i t push`, `n p m publish`), tested with every space removed. */
const OUTWARD_FACING_COMPACT: ReadonlyArray<{ category: OutwardCategory; re: RegExp }> = [
  { category: "push", re: /gitpush/i },
  { category: "release", re: /npmpublish|dockerpush|cargopublish/i },
];

/** An org profile's own review vocabulary, read beside the built-in patterns (orgOutwardPatterns). */
interface OrgOutwardPatterns {
  facing: OutwardPattern[];
  compact: Array<{ category: OutwardCategory; re: RegExp }>;
}

const orgOutwardCache = new WeakMap<OrgProfile, OrgOutwardPatterns>();

/** Whether two CLI rules read the same words (a profile carried as JSON holds copies of the default's rules). */
function sameCliRule(a: OrgCliRule, b: OrgCliRule): boolean {
  return a.program === b.program && a.category === b.category && !!a.anywhere === !!b.anywhere && a.subcommand.join("\u0000") === b.subcommand.join("\u0000");
}

/**
 * The outward steps an org profile names: its review CLIs run with an option
 * (`corp-review --all`, `run corp-review`, spaced out as `c o r p - r e v i e w --all`),
 * its outward CLI rules' program and subcommand (`corp-deploy promote`; a
 * destructive rule reaches no one and is left out, and so is a rule with no
 * subcommand, which in free text would read every mention of its program as
 * the step: the floor still reads it against the commands a worker runs),
 * and its review nouns (reviewNounsOf: "change request" and its own
 * `codeReview.noun`) as the object of the review, merge, push and message
 * verbs REVIEW_NOUN takes. The default profile names no CLI and only the
 * built-in noun.
 */
function orgOutwardPatterns(profile: OrgProfile): OrgOutwardPatterns {
  let cached = orgOutwardCache.get(profile);
  if (cached) return cached;
  const facing: OutwardPattern[] = [];
  const compact: Array<{ category: OutwardCategory; re: RegExp }> = [];
  for (const program of profile.reviewClis) {
    const name = escapeRegExp(program);
    facing.push({ category: "review", re: new RegExp(String.raw`(?:^|[\s;&|(\x60"'])${name}\s+--?[a-z]`, "i") });
    facing.push({ category: "review", re: new RegExp(String.raw`\brun\s+${name}(?![\w.-])`, "i") });
    compact.push({ category: "review", re: new RegExp(String.raw`(?:^|[^a-z0-9])${escapeRegExp(program.replace(/\s+/g, ""))}--[a-z]`, "i") });
  }
  for (const rule of profile.outwardRules) {
    // The default profile's generic rules (git push, gh pr, terraform apply …) have built-in patterns of their own.
    if (rule.category === "destructive" || rule.subcommand.length === 0 || DEFAULT_ORG_PROFILE.outwardRules.some((d) => sameCliRule(d, rule))) continue;
    const values = (rule.valueOptions ?? []).map(escapeRegExp);
    const lead = rule.anywhere
      ? String.raw`(?:\S+\s+){0,6}?`
      : String.raw`(?:${values.length ? String.raw`(?:${values.join("|")})\s+\S+\s+|` : ""}-\S*\s+){0,6}`;
    const words = rule.subcommand.map((w) => String.raw`(?:${w})(?![\w.-])`).join(String.raw`\s+`);
    facing.push({
      category: rule.category === "review" ? "review" : "release",
      re: new RegExp(String.raw`(?<![\w.-])(?:${rule.program})(?![\w.-])\s+${lead}${words}`, "i"),
    });
  }
  const noun = reviewNounsOf(profile);
  facing.push(
    { category: "review", re: openReview(noun) },
    { category: "review", re: actOnReview(noun) },
    { category: "review", re: putReviewUp(noun) },
    { category: "review", re: new RegExp(String.raw`\bget\s+(?:the|this|my|your)\s+(?:[\w-]+\s+)?${noun}\s+reviewed\b`, "i") },
    { category: "merge", re: new RegExp(String.raw`\bland\s+(?:the|this|that|your|my)\s+${noun}\b`, "i") },
    // A bare outward verb whose object is a review ("ship the CL", "OK to submit the CL?").
    {
      category: "push",
      re: new RegExp(
        String.raw`(?:\b${REQUEST_FRAME}|${CLAUSE_OPENER})${STEP_LEAD}\s*${BARE_VERB}(?=\s+(?:the|a|an|my|your|our|its|their|this|that|these|those)\s+(?:[\w./-]+\s+){0,2}?${noun}(?![\w-]))`,
        "i"
      ),
      unless: (rest, step) => /merge/i.test(step) && LOCAL_MERGE.test(rest),
    },
    { category: "message", re: new RegExp(String.raw`\b(?:reply|respond|answer)(?:s|ed|ing)?\s+to\s+(?:the\s+|their\s+|all\s+(?:the\s+)?|each\s+)?${noun}\s+(?:feedback|comments?)\b`, "i") },
    { category: "message", re: commentOn(noun) },
    { category: "message", re: postOnto(noun) }
  );
  cached = {
    facing: facing.map(({ category, re, unless }) => ({ category, unless, re: new RegExp(re.source, `${re.flags}g`) })),
    compact,
  };
  orgOutwardCache.set(profile, cached);
  return cached;
}

/** One outward-facing step found in a text: its kind and the matched words. */
export interface OutwardMatch {
  category: OutwardCategory;
  step: string;
}

/**
 * A clause break: a line break, sentence punctuation followed by a space,
 * " but ", ", then " or " and then ".
 */
const CLAUSE_BREAK = /\n|[.;!?]+(?=\s|$)|\s+but\s+|,\s*then\s+|\s+and\s+then\s+/i;

/**
 * A negation that turns the verb phrase it governs into a prohibition.
 * Matched against each reading, so both `don't` and its unquoted `dont`
 * count.
 */
const NEGATION =
  /\b(?:not|never|no|none|nothing|without|avoid(?:s|ed|ing)?|stop(?:s|ped|ping)?|hold(?:ing)?\s+off|refrain|skip(?:s|ped|ping)?|do\s+not|dont|cant|wont|shouldnt|mustnt|couldnt|wouldnt|didnt|doesnt)\b|n't\b/gi;

/**
 * Where a negation's reach ends: a colon, semicolon, parenthesis, dash, arrow,
 * pipe or `&&`, a line break, or a word that starts a new instruction, a
 * condition or a contrast ("until you push", "just git push", "instead").
 * Commas end it too, except inside a list of prohibited outward verbs (see
 * negationSpans).
 */
const REACH_END =
  /[:;()|→⇒\n]|[—–]|\s-\s|&&|\b(?:until|unless|before|after|once|just|instead|rather\s+than|then|but|so|if|when|because|since)\b/gi;
/** A joiner between the items of a negated list. */
const LIST_JOINER = /\s*,\s*(?:(or|nor|and)\s+)?|\s+(or|nor|and)\s+/gi;
/** Words between a negation and the verb it governs ("never even run", "don't want you to"). */
const NEGATION_FILLER =
  /^(?:\W*\b(?:ever|even|you|yet|actually|really|run|use|to|on|be|any|further|the|a|an|this|that|your|my|our|also|please|i|we|will|should|must|need|needs|have|has|bother|try|want|wanna|gonna|go)\b)*\W*/i;
/** Outward verbs whose negation is a prohibition of the step, whatever follows. */
const OUTWARD_VERB =
  /^(?:force-?push\w*|push(?:es|ed|ing)?|merg(?:e|es|ed|ing)|land(?:s|ed|ing)?|deploy\w*|publish\w*|releas(?:e|es|ed|ing)|ship(?:s|ped|ping)?|submit\w*|upload\w*|roll(?:s|ed|ing)?|promot(?:e|es|ed|ing)|approv(?:e|es|ed|ing)|trigger\w*|tweet\w*|post(?:s|ed|ing)?|notify\w*|notifie\w*|e-?mail\w*|messag(?:e|es|ed|ing)|dm|ping(?:s|ed|ing)?|announc\w*|broadcast\w*|cc|mention\w*)$/i;
/** An item that is only a verb, perhaps with a pronoun or adverb ("push", "merge it now"). */
const BARE_ITEM = /^\W*[\w'-]+(?:\s+(?:it|them|this|that|now|yet|again|up|out|anything|anywhere|yourself))*\W*$/i;

/**
 * Hyphenated or flag-borne negation words (`--no-verify`, `no-op`,
 * `--skip-tests`) and any negation inside a quoted string (a commit message)
 * blanked out, so they don't read as a prohibition of what follows. Lengths
 * are kept.
 */
function maskInertNegations(text: string): string {
  const blank = (s: string) => s.replace(NEGATION, (w) => "x".repeat(w.length));
  return text
    .replace(/"[^"\n]*"/g, blank)
    .replace(/(^|[\s=(:])'[^'\n]*(?:'[a-z][^'\n]*)*'(?=$|[\s.,;:!?)&|])/gim, blank)
    .replace(/(?<=[-=])(?:no|not|never|skip|without|avoid)\b|\b(?:no|not|never|non)(?=-\w)/gi, (w) => "x".repeat(w.length));
}

/**
 * A quoted phrase the text talks about rather than asks for: one introduced
 * as a mention ("the phrase 'merge into main'", "text containing \"git
 * push\"", "it flagged 'deploy to prod'"). Folding has already turned
 * backticks and curly apostrophes into `'`.
 */
const QUOTED_MENTION =
  /(\b(?:mentions?|mentioned|mentioning|the\s+(?:phrase|phrases|words?|string|strings|text|pattern|line|term)|says|said|reads|such\s+as|e\.g\.,?|quot(?:e|es|ed|ing)|match(?:es|ed|ing)?|flag(?:s|ged|ging)?|contain(?:s|ed|ing)?|detect(?:s|ed|ing)?)\s*[:,]?\s*)(["“']|“)([^"“”'\n]{1,160})(["”'])/gi;

/** A verb that tells the reader to carry out what the clause quotes ("run the command it mentions: '…'", "do that"). */
const CARRY_OUT = /\b(?:run|runs|do|does|execute|use|type|try|perform|enter|paste|issue|invoke|follow|repeat|copy)\b/i;

/**
 * Quoted mentions (see QUOTED_MENTION) blanked out, lengths kept. A mention
 * in a clause that also tells the reader to carry it out stays.
 */
function maskMentions(text: string): string {
  return text.replace(QUOTED_MENTION, (match: string, cue: string, open: string, body: string, close: string, offset: number) => {
    const before = text.slice(0, offset);
    const clauseStart = Math.max(before.lastIndexOf("\n"), before.search(/[.;!?][^.;!?]*$/));
    const after = text.slice(offset + match.length);
    const clauseEnd = after.search(/[\n.;!?]/);
    const clause = `${before.slice(clauseStart + 1)} ${after.slice(0, clauseEnd < 0 ? undefined : clauseEnd)}`;
    if (CARRY_OUT.test(clause)) return match;
    return `${cue}${open}${"x".repeat(body.length)}${close}`;
  });
}

/**
 * Someone other than the worker running a command: "the command the owner
 * would run", "for me to run". "You can run" stays an instruction.
 */
const HANDED_OFF =
  /\b(?:(?:the\s+)?(?:owner|user)|i|we|they)\s+(?:would|will|can|could|may|might|should|(?:is|are)\s+(?:going\s+)?to|gets?\s+to)\s+(?:then\s+)?(?:run|paste|execute|use|type)\b|\bfor\s+(?:the\s+(?:owner|user)|me|us|them)\s+to\s+(?:run|paste|execute|use|type)\b/gi;
/** A quoted command: `'gh pr create …'` once folding has turned backticks into `'`. */
const QUOTED_COMMAND = /(^|[\s=(:])'([^'\n]{1,200})'(?=$|[\s.,;:!?)])/gm;

/**
 * Quoted commands the text hands to someone else to run blanked out, lengths
 * kept: "report the exact 'gh pr create' command the owner would run". A clause
 * that also tells the reader to carry the command out keeps it.
 */
function maskHandoffs(text: string): string {
  return text.replace(QUOTED_COMMAND, (match: string, lead: string, body: string, offset: number) => {
    const before = text.slice(0, offset);
    const clauseStart = Math.max(before.lastIndexOf("\n"), before.search(/[.;!?](?=\s)[^.;!?]*$/));
    const after = text.slice(offset + match.length);
    const clauseEnd = after.search(/\n|[.;!?](?=\s|$)/);
    const clause = `${before.slice(clauseStart + 1)} ${after.slice(0, clauseEnd < 0 ? undefined : clauseEnd)}`.replace(
      QUOTED_COMMAND,
      "$1"
    );
    if (!new RegExp(HANDED_OFF.source, "i").test(clause)) return match;
    if (CARRY_OUT.test(clause.replace(new RegExp(HANDED_OFF.source, "gi"), ""))) return match;
    return `${lead}'${"x".repeat(body.length)}'`;
  });
}

interface Hit {
  category: OutwardCategory;
  index: number;
  step: string;
}

const OUTWARD_FACING_ALL = OUTWARD_FACING.map(({ category, re, unless }) => ({
  category,
  unless,
  re: new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`),
}));

function hitsIn(reading: string, org: OrgOutwardPatterns): Hit[] {
  const hits: Hit[] = [];
  for (const { category, re, unless } of [...OUTWARD_FACING_ALL, ...org.facing]) {
    for (const m of reading.matchAll(re)) {
      if (unless?.(reading.slice(m.index! + m[0].length), m[0])) continue;
      hits.push({ category, index: m.index!, step: m[0] });
    }
  }
  return hits;
}

/** The first index at or after `from` where a negation's reach ends. */
function reachEnd(reading: string, from: number): number {
  const re = new RegExp(REACH_END.source, "gi");
  re.lastIndex = from;
  const m = re.exec(reading);
  return m ? m.index : reading.length;
}

/**
 * Whether the list item at [start, end) is an outward verb phrase: past the
 * filler words, its verb is an outward verb or an outward step starts there
 * (`never run git push`, `don't open a PR`).
 */
function itemIsOutward(reading: string, start: number, end: number, hits: Hit[]): boolean {
  const item = reading.slice(start, end);
  const lead = NEGATION_FILLER.exec(item)?.[0].length ?? 0;
  const word = /^[\w'-]+/.exec(item.slice(lead))?.[0];
  if (!word) return false;
  if (OUTWARD_VERB.test(word.replace(/'/g, ""))) return true;
  const wordEnd = start + lead + word.length;
  return hits.some((h) => h.index >= start && h.index < wordEnd);
}

/**
 * The spans of `reading` a negation prohibits. A negation governs the verb
 * phrase right after it, and hides it only when that verb is an outward step;
 * "don't forget to open a PR" or "no failures, OK to push?" prohibit nothing
 * outward. The span runs on over a coordinated list of outward verbs — joined
 * by "or"/"nor", by commas in a list that ends in "or"/"nor" ("do not push,
 * open a PR, or deploy"), or by "and" between two bare outward verbs ("don't
 * push and deploy", not "don't comment and deploy to prod") — and stops at
 * REACH_END. A negation inside the verb phrase another one governs ("no
 * reason not to merge") cancels it.
 */
function negationSpans(reading: string, hits: Hit[]): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const governed: Array<[number, number]> = [];
  const triggers = [
    ...[...reading.matchAll(NEGATION)].map((m) => ({ at: m.index!, start: m.index! + m[0].length })),
    ...guardTriggers(reading),
  ].sort((a, b) => a.at - b.at);
  for (const { at, start } of triggers) {
    if (governed.some(([from, to]) => at >= from && at < to)) continue;
    const end = reachEnd(reading, start);
    const joiner = new RegExp(LIST_JOINER.source, "gi");
    let itemStart = start;
    let spanEnd = -1;
    let inCommaList = false;
    for (let first = true; ; first = false) {
      joiner.lastIndex = itemStart;
      let j = joiner.exec(reading);
      if (j && j.index >= end) j = null;
      const itemEnd = j ? j.index : end;
      if (first) governed.push([start, itemEnd]);
      if (!itemIsOutward(reading, itemStart, itemEnd, hits)) break;
      spanEnd = itemEnd;
      if (!j) break;
      const next = j.index + j[0].length;
      const word = (j[1] ?? j[2])?.toLowerCase();
      const comma = j[0].includes(",");
      const nextOutward = () => itemIsOutward(reading, next, nextItemEnd(reading, next, end), hits);
      let go: boolean;
      if (word === "or" || word === "nor") go = true;
      else if (comma && word === "and") go = inCommaList && nextOutward();
      else if (comma) go = /\b(?:or|nor)\b/i.test(reading.slice(next, end));
      else {
        const nextItem = reading.slice(next, nextItemEnd(reading, next, end));
        go = BARE_ITEM.test(reading.slice(itemStart, itemEnd)) && BARE_ITEM.test(nextItem) && nextOutward();
      }
      if (!go) break;
      inCommaList = comma;
      itemStart = next;
    }
    if (spanEnd > at) spans.push([at, spanEnd]);
  }
  return spans;
}

/**
 * A check with the owner (or through ask_human) that must come first. The
 * steps it names are what to check about, not requests for them.
 */
const ASK_FIRST = String.raw`(?:ask_human|ask(?:ing)?\s+(?:me|us|the\s+owner|first|for\s+(?:approval|permission|sign-?off|a\s+go-?ahead))|(?:check|confirm)(?:ing)?\s+(?:in\s+)?with\s+(?:me|us|the\s+owner)|get(?:ting)?\s+(?:my\s+|the\s+owner'?s\s+)?(?:approval|sign-?off|go-?ahead|ok)|wait(?:ing)?\s+for\s+(?:my\s+|the\s+owner'?s\s+)?(?:approval|sign-?off|go-?ahead|ok))`;
/**
 * "ask_human before you git push", "check with me before any deploy". A
 * conditional check ("ask me if it fails before …") guards nothing.
 */
const ASK_BEFORE = new RegExp(
  String.raw`\b${ASK_FIRST}\b(?:(?!\b(?:if|only|when|unless|whether|in\s+case)\b)[^.;:!?\n]){0,40}?\bbefore\b`,
  "gi"
);

/** Whether a negation comes before `index`; "stop and ask" is a pause, not one. */
function negatedBefore(reading: string, index: number): boolean {
  return new RegExp(NEGATION.source, "i").test(reading.slice(0, index).replace(/\bstop\s+and\b/gi, ""));
}

/**
 * The "before" of each check-first instruction ("ask_human before you push"),
 * which guards the steps after it the way a negation does. A check that is
 * itself negated ("no need to ask_human before you push") guards nothing.
 */
function guardTriggers(reading: string): Array<{ at: number; start: number }> {
  const triggers: Array<{ at: number; start: number }> = [];
  for (const m of reading.matchAll(ASK_BEFORE)) {
    if (negatedBefore(reading, m.index!)) continue;
    const end = m.index! + m[0].length;
    triggers.push({ at: end - "before".length, start: end });
  }
  return triggers;
}

function nextItemEnd(reading: string, from: number, end: number): number {
  const joiner = new RegExp(LIST_JOINER.source, "gi");
  joiner.lastIndex = from;
  const j = joiner.exec(reading);
  return j && j.index < end ? j.index : end;
}

/**
 * An outward verb in the third person ("escalates", "pushes"): a description
 * of someone else's step. Forms that double as nouns ("comments", "posts",
 * "releases") are left out.
 */
const THIRD_PERSON_VERB =
  /^(?:force-?)?(?:pushes|merges|deploys|publishes|submits|uploads|promotes|notifies|escalates|forwards|announces|broadcasts|triggers|approves|syncs)$/i;
/**
 * A label that names a category of step, so the list after its colon names
 * examples of the category: "Outward-facing actions: git push, cdk deploy".
 */
const CATEGORY_LABEL =
  /\b(?:outward-?facing|risky|high-?risk|destructive|dangerous|forbidden|prohibited|blocked|held|gated|floor(?:ed)?|deny-?list(?:ed)?|block-?list(?:ed)?|intercepted|guarded)\b[^:]{0,40}:/i;
/** What says a step named as a clause's subject is not to be taken: "Merging into main remains held". */
const HELD_PREDICATE =
  /\b(?:is|are|remains?|stays?|will\s+(?:be|stay|remain))\s+(?:still\s+|always\s+|also\s+)?(?:held|gated|blocked|forbidden|prohibited|off-limits|not\s+allowed|disallowed|out\s+of\s+scope|(?:a\s+)?separate(?:\s+step)?|the\s+owner'?s(?:\s+(?:call|decision))?)\b|\b(?:needs?|requires?)\s+(?:the\s+owner'?s\s+|explicit\s+|owner\s+)?(?:approval|sign-?off|decision)\b|\bgoes\s+to\s+the\s+owner\b/i;

/**
 * An auxiliary or adverb that reports a step as already done ("was merged",
 * "has been pushed", "just deployed"). Bare "have" is left out: "have it
 * merged into main" asks for the merge.
 */
const DONE_MARKER = /\b(?:was|were|been|has|had|already|just|recently|previously|earlier)\b/gi;
/** Words after a done marker that turn what follows back into a request ("was tested, now get it merged"). */
const REQUEST_CUE =
  /\b(?:get|have|make\s+sure|ensure|until|once|when|after|before|should|must|need|needs|want|please|now|then|if|to)\b|\?/i;
/** Irregular past forms of outward verbs that don't end in -ed. */
const IRREGULAR_PAST = /^(?:cut|put|sent|wrote|written|made|built|ran)$/i;
/** Irregular past forms spelled like the base form, so "just cut a PR" may be an order. */
const BASE_LIKE_PAST = /^(?:cut|put)$/i;
/** Auxiliaries that make any verb after them a past form ("has cut", "was put up"). */
const PERFECT_MARKER = /^(?:was|were|been|has|had)$/i;
/** A word before "just"/"already" that leaves the verb an order rather than a subject's report ("please just cut"). */
const ORDER_LEAD = /^(?:please|pls|now|then|and|so|also|you|to|first|next|finally|simply|go|can|could|should|will|would|must)$/i;

/**
 * Whether a past-tense hit reports finished work rather than asking for it:
 * "The tokenizer was just rewritten and merged into main (4e8d2f1)",
 * "The owner just cut PR 123". The verb must be in the past tense and a done
 * marker must come before it in the clause, with no request cue between them.
 * A past form spelled like the base form ("cut") also needs a subject before
 * an adverb marker, or a perfect/passive auxiliary, so "just cut a PR" is
 * still read as an order.
 */
function reportsDone(reading: string, hit: Hit, verb: string): boolean {
  if (!/ed$/i.test(verb) && !IRREGULAR_PAST.test(verb)) return false;
  const before = reading.slice(0, hit.index + (hit.step.length - hit.step.replace(/^[\s,:;(—–-]+/, "").length));
  const markers = [...before.matchAll(DONE_MARKER)];
  const last = markers[markers.length - 1];
  if (!last) return false;
  if (REQUEST_CUE.test(before.slice(last.index! + last[0].length))) return false;
  if (!BASE_LIKE_PAST.test(verb) || PERFECT_MARKER.test(last[0])) return true;
  const lead = /([\w'-]+)\W*$/.exec(before.slice(0, last.index!))?.[1];
  return !!lead && !ORDER_LEAD.test(lead);
}

/**
 * Whether a hit in Persona's own text names a step rather than asks for it:
 * a third-person verb ("Persona escalates to the owner"); a past-tense report
 * of finished work ("was merged into main"); a bare command with
 * no arguments listed under a category label ("Outward-facing actions: git
 * push, cdk deploy"); or a gerund opening the clause whose predicate keeps the
 * step from being taken ("Merging into main remains a separate step").
 */
function namesStep(reading: string, hit: Hit): boolean {
  const step = hit.step.replace(/^[\s,:;(—–-]+/, "");
  const verb = /^[\w'-]+/.exec(step)?.[0] ?? "";
  if (THIRD_PERSON_VERB.test(verb)) return true;
  if (reportsDone(reading, hit, verb)) return true;
  const label = CATEGORY_LABEL.exec(reading);
  if (label && hit.index >= label.index + label[0].length) {
    const list = reading.slice(label.index + label[0].length);
    const rest = reading.slice(hit.index + hit.step.length);
    // An item of a list (two or more), with no arguments of its own.
    if (/,|\s\/\s|\s(?:or|and)\s/i.test(list) && /^\s*(?:$|[,;)\/'"]|(?:or|and)\b)/i.test(rest)) return true;
  }
  const opening = /^\W*(?:[-*•]\s*|\d+[.)]\s*)?/.exec(reading)?.[0].length ?? 0;
  if (hit.index <= opening && /ing$/i.test(verb) && HELD_PREDICATE.test(reading.slice(hit.index + hit.step.length))) return true;
  return false;
}

/** `spans` sorted, with overlapping ones joined. */
function mergeSpans(spans: Array<[number, number]>): Array<[number, number]> {
  const merged: Array<[number, number]> = [];
  for (const [from, to] of [...spans].sort((a, b) => a[0] - b[0])) {
    const last = merged[merged.length - 1];
    if (last && from <= last[1]) last[1] = Math.max(last[1], to);
    else merged.push([from, to]);
  }
  return merged;
}

export interface OutwardOptions {
  /**
   * Skip steps a negation prohibits ("do not push or open a PR"). On for
   * Persona's own text; off for worker-authored text, where any outward step
   * named is read as asked for.
   */
  honorNegation?: boolean;
  /**
   * The org profile whose review CLIs and code-review noun are read too (see
   * orgOutwardPatterns). Default: the neutral built-in profile, which names
   * none; Persona's own checks pass the collector's active profile.
   */
  profile?: OrgProfile;
}

/**
 * Every outward-facing step `text` asks for. With `honorNegation` (the
 * default), a step a negation or a check-first instruction governs is a
 * prohibition and is ignored (see negationSpans and guardTriggers), while one before the negation ("git push origin HEAD, not
 * to main") or past its reach ("don't merge yet, push to origin") still
 * counts. Without it, every step named counts.
 */
export function outwardMatches(text: string | undefined, options: OutwardOptions = {}): OutwardMatch[] {
  if (!text) return [];
  const honorNegation = options.honorNegation ?? true;
  const org = orgOutwardPatterns(options.profile ?? DEFAULT_ORG_PROFILE);
  const found: OutwardMatch[] = [];
  const seen = new Set<OutwardCategory>();
  const add = (category: OutwardCategory, step: string) => {
    if (seen.has(category)) return;
    seen.add(category);
    found.push({ category, step: step.replace(/^[\s,:;(—–-]+/, "").trim().slice(0, 80) });
  };
  const folded = foldText(text);
  for (const clause of (honorNegation ? maskHandoffs(maskMentions(maskInertNegations(folded))) : folded).split(CLAUSE_BREAK)) {
    if (!clause?.trim()) continue;
    for (const reading of readingsOf(clause)) {
      const hits = hitsIn(reading, org);
      const spans = honorNegation ? negationSpans(reading, hits) : [];
      // A step a clause only names (see namesStep) is closed like a prohibited one.
      const named = honorNegation ? hits.filter((hit) => namesStep(reading, hit)) : [];
      const closed: Array<[number, number]> = [...spans, ...named.map((h): [number, number] => [h.index, h.index + h.step.length])];
      for (const hit of hits) {
        if (!closed.some(([from, to]) => hit.index >= from && hit.index < to)) add(hit.category, hit.step);
      }
      let open = reading;
      for (const [from, to] of mergeSpans(closed).reverse()) open = `${open.slice(0, from)}|${open.slice(to)}`;
      const compact = open.replace(/\s+/g, "");
      for (const { category, re } of [...OUTWARD_FACING_COMPACT, ...org.compact]) {
        if (re.test(compact)) add(category, open);
      }
    }
  }
  return found;
}

/** The first outward-facing step `text` asks for (the matched words), or null. */
export function outwardStep(text: string | undefined, options: OutwardOptions = {}): string | null {
  return outwardMatches(text, options)[0]?.step ?? null;
}

export function isOutwardFacing(text: string | undefined, options: OutwardOptions = {}): boolean {
  return outwardStep(text, options) !== null;
}

// ── Owner memory requests ───────────────────────────────────────────────────

/**
 * Phrases with which an owner asks for something to be kept. Bare "always",
 * "never" or "prefer" don't count: they turn up in ordinary requests ("it
 * always fails on CI").
 */
const MEMORY_PHRASE =
  /\b(?:remember|from\s+now\s+on|going\s+forward|in\s+the\s+future|note\s+that|keep\s+in\s+mind|make\s+a\s+note|for\s+future\s+reference)\b/i;
/** A clause that opens like a question. */
const INTERROGATIVE =
  /^\W*(?:what|when|where|why|how|is|are|was|did|does|do|can|could|should|would|will|has|have)\b/i;
/**
 * "remember" that recalls rather than asks: negated ("don't remember", "can't
 * remember") or said of oneself ("I remember", "I still remember").
 */
const RECALLED_REMEMBER = /(?:n't|\bnot|\bnever|\bdont|\bcant)\s+(?:\w+\s+)?remember\b|\b(?:i|we)\s+(?:\w+\s+)?remember\b/i;
/** A clause break inside an owner message: sentence punctuation or a line break. */
const OWNER_CLAUSE = /\n|(?<=[.;!?])\s+/;

/**
 * A standing preference stated outright: "Persona should …", "always …", "I
 * want …". Like a memory phrase, it marks a clause as something to keep.
 */
const STANDING_CUE = /\b(?:should|must|always|never|by\s+default|i\s+want|i'?d\s+(?:like|prefer)|i\s+prefer)\b/i;

/**
 * The clauses of one owner message that ask Persona to keep something: each
 * carries a memory phrase or a standing preference and is not a question or a
 * recollection ("I remember …").
 */
function memoryClauses(ownerText: string): string[] {
  return ownerClauses(ownerText).filter((clause) => isMemoryClause(clause) || isStandingPreference(clause));
}

/** A fenced code block, up to its closing fence or the end of the message. */
const CODE_FENCE = /^[ \t]*(`{3,}|~{3,})[^\n]*(?:\n[\s\S]*?(?:\n[ \t]*\1[ \t]*(?=\n|$)|$)|$)/gm;
/** A Markdown blockquote line. */
const BLOCKQUOTE_LINE = /^[ \t]*>[^\n]*/gm;
/**
 * Reported speech: someone's words after "X said:" (or wrote, replied, …), to
 * the end of the line — or the next line when the colon ends one. A quote
 * right after the colon is left to QUOTED_SPAN, which drops just the quote.
 * "I said:" and "we said:" lead the owner's own words.
 */
const REPORTED_SPEECH =
  /(?<!\b(?:i|we)(?:'\w+)?(?:\s+\w+)?\s+)\b(?:said|says|wrote|writes|replied|replies|asked|asks|suggested|suggests|proposed|proposes|posted|commented|claimed|claims|told\s+(?:me|us|you))\s*(?:that\s*)?:(?![ \t]*["“„«'‘])([^\n]*)(\n[^\n]*)?/gi;
/**
 * A quoted span: double quotes, or single quotes that open after a space or
 * opening punctuation and close before one (so an apostrophe never opens one).
 * Backticks are code, not quotation.
 */
const QUOTED_SPAN =
  /"[^"\n]*"|“[^”\n]*”|„[^“”\n]*[“”]|«[^»\n]*»|(?<=^|[\s:(\[])['‘][^'‘’\n]{2,}['’](?=$|[\s.,;:!?)\]])/g;
/** A memory phrase that a quoted span right after it belongs to: `Remember: "…"`. */
const QUOTE_LEAD = new RegExp(`${MEMORY_PHRASE.source}(?:\\s+(?:this|that))?\\s*[:,—–-]?\\s*$`, "i");

/**
 * An owner message less the words that are someone else's: fenced, inline
 * and indented code (withoutInlineCode), blockquotes, lines led by a speaker
 * label, reported speech and pasted text (withoutOtherVoices, and "the worker
 * said: …") and quoted spans — except a quote the owner introduces with a
 * memory phrase ("Remember: \"always run the tests\"") — each replaced by a
 * line break, so what is left on either side stays its own clause. Pasted or
 * quoted text is data about the conversation, not the owner's own request.
 */
function ownerOwnText(ownerText: string): string {
  const text = ownerText.normalize("NFKC").replace(LINE_BREAKS, "\n").replace(/\p{Cf}/gu, "");
  const unquoted = withoutInlineCode(text.replace(CODE_FENCE, "\n").replace(BLOCKQUOTE_LINE, "\n"));
  return withoutOtherVoices(foldText(unquoted))
    .replace(REPORTED_SPEECH, (_m, rest: string, next: string | undefined) =>
      rest.trim() ? `\n${next ?? ""}` : "\n"
    )
    .replace(QUOTED_SPAN, (span: string, offset: number, whole: string) =>
      QUOTE_LEAD.test(whole.slice(Math.max(0, offset - 80), offset)) ? span : "\n"
    );
}

/**
 * The clauses of one owner message, folded and whitespace-collapsed, empty
 * ones dropped. Only the owner's own words count (see ownerOwnText).
 */
function ownerClauses(ownerText: string): string[] {
  return foldText(ownerOwnText(ownerText))
    .split(OWNER_CLAUSE)
    .map(collapse)
    .filter(Boolean);
}

/** A clause that opens like or ends as a question. */
function isQuestion(clause: string): boolean {
  return clause.endsWith("?") || INTERROGATIVE.test(clause);
}

/**
 * A clause asking Persona to keep something: a memory phrase asked in the
 * owner's own voice (isDirectRequest), not a question, not a recollection.
 */
function isMemoryClause(clause: string): boolean {
  if (isQuestion(clause)) return false;
  const m = MEMORY_PHRASE.exec(clause);
  if (!m || !isDirectRequest(clause, m.index, m.index + m[0].length)) return false;
  return !(/^remember$/i.test(m[0]) && RECALLED_REMEMBER.test(clause));
}

/**
 * A clause with no memory phrase that states a standing preference outright
 * (STANDING_CUE: "Persona should …", "always …", "I want …"), not as a
 * question. A clause with a memory phrase is judged by isMemoryClause alone.
 */
function isStandingPreference(clause: string): boolean {
  if (isQuestion(clause) || MEMORY_PHRASE.test(clause)) return false;
  return STANDING_CUE.test(clause);
}

/** Words that carry no content of their own in a memory. Negations are content. */
const STOPWORDS = new Set(
  (
    "a an the and or but if then so to of in on at by for with from into onto over under about as than " +
    "is are was were be been being am will would should could can may might must shall have has had do does did " +
    "i me my mine you your yours we us our ours they them their he him his she her it its this that these those " +
    "there here what which who whom when where why how please just also very really too owner owner's user " +
    "wants want likes like prefers prefer preference preferences style rule rules convention conventions " +
    "guideline guidelines habit habits reminder"
  ).split(" ")
);

/** Stands for every negation word, so "never" and "don't" compare equal. */
const NEGATED = "¬";
const NEGATION_WORD = /^(?:not|never|no|none|nothing|without|avoid|dont|don't|cant|can't|wont|won't|shouldnt|shouldn't|mustnt|mustn't|nor)$/;

/**
 * Content words that change what Persona may do on its own — outward steps,
 * approvals, skipping checks. Every one in a memory must be in the owner's own
 * clause, however close the rest is.
 */
const SENSITIVE_WORD =
  /^(?:push|merg|deploy|publish|releas|ship|submit|upload|approv|skip|bypass|forc|delet|drop|ask|permission|review|land|promot|roll|notif|e-?mail|post|messag|auto|ignor|disabl|prod|card|yes|trust|credential|secret|token|password|passwd|rotat|sudo|admin)/;
/**
 * Phrases that widen what agents may do unasked: "without checking", "no need
 * to confirm", "OK to …", "any worker question".
 */
const LATITUDE_PHRASE =
  /\b(?:go\s+ahead|green-?light\w*|blessing|at\s+will|on\s+(?:its|their|your|his|her)\s+own|by\s+(?:it|them|your)sel(?:f|ves)|itself|themselves|solo|unsupervised|unattended|independently|autonomous(?:ly)?|freely|without\s+me|remote|upstream)\b|\b(?:without|no\s+need\s+to|(?:don'?t|do\s+not|never)\s+(?:need|have)\s+to|never)\s+(?:\w+\s+)?(?:ask|check|tell|confirm|wait|review|verif|consult|notif)|\b(?:ok|okay|fine|allowed|free|safe)\s+to\b|\b(?:any|every|all)\s+(?:\w+\s+)?(?:questions?|requests?|asks?|plans?|changes?|prompts?)\b/i;

/**
 * The content words of `text`: lowercased, stopwords dropped, a plural "s"
 * and an "-ed"/"-ing" folded, negations unified.
 */
function contentWords(text: string): Set<string> {
  const words = new Set<string>();
  for (const w of collapse(foldText(text)).toLowerCase().match(/[a-z0-9]+(?:'[a-z]+)?/g) ?? []) {
    if (STOPWORDS.has(w)) continue;
    if (NEGATION_WORD.test(w) || w.endsWith("n't")) {
      words.add(NEGATED);
      continue;
    }
    const singular = w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w;
    words.add(singular.length > 5 ? singular.replace(/(?:ed|ing)$/, "") : singular);
  }
  return words;
}

/** An MCP write tool's name (TrackerCreateTask, TicketPostComment) or a verb that writes somewhere. */
const MEMORY_WRITE =
  /[A-Z][a-z0-9]+(?:Create|Update|Delete|Add|Post|Send|Put|Set|Remove|Edit|Comment|Publish|Upload|Submit|Write)(?=[A-Z_]|\b)|\b(?:creat(?:e|es|ed|ing)|fil(?:e|es|ed|ing)|open(?:s|ed|ing)?|add(?:s|ed|ing)?|updat(?:e|es|ed|ing)|delet(?:e|es|ed|ing)|remov(?:e|es|ed|ing)|post(?:s|ed|ing)?|send(?:s|ing)?|submit(?:s|ted|ting)?|comment(?:s|ed|ing)?|log(?:s|ged|ging)?|cut(?:s|ting)?|rais(?:e|es|ed|ing)|track(?:s|ed|ing)?|close[sd]?|closing)\b/i;
/** An id a write can go under: letters and digits mixed (E5550001234, T-4f1c), a UUID, or six or more digits. */
const MEMORY_ID = /(?<![\w-])(?:(?=[\w-]*\d)(?=[\w-]*[a-z])[a-z0-9][\w-]{4,}|\d{6,})(?![\w-])/i;

/**
 * Whether a memory may be saved without a card only in the owner's own words:
 * it names an outward-facing step, a write tool or write verb together with
 * an id it goes under (MEMORY_WRITE, MEMORY_ID), or carries a sensitive word
 * (see SENSITIVE_WORD). A memory reaches the owner's other agents through the
 * knowledge base, so one that widens what they may do on their own ("workers
 * may deploy without asking") is the owner's to state.
 */
export function memoryNeedsOwnerWords(text: string | undefined): boolean {
  if (!text) return false;
  if (isOutwardFacing(text, { profile: activeOrgProfile() })) return true;
  // A write tool or a write verb with an id names where an outward write goes ("create a tracker task
  // under epic E5550001234"): the allow check reads such a memory as the owner asking for that write.
  if (MEMORY_WRITE.test(text) && MEMORY_ID.test(text)) return true;
  if (normalizedReadings(text).some((r) => LATITUDE_PHRASE.test(r))) return true;
  return [...contentWords(text)].some((w) => SENSITIVE_WORD.test(w));
}

/** Whether the memory's fact quotes the owner's clause word for word (at least 30 characters of it). */
function quotesOwner(fact: string, clause: string): boolean {
  const said = collapse(foldText(clause)).toLowerCase().replace(/[.!]+$/, "");
  return said.length >= 30 && collapse(foldText(fact)).toLowerCase().includes(said);
}

/** Share of a memory's content words the owner's clause must contain for it to be saved unasked. */
const MEMORY_OVERLAP = 0.8;

/**
 * Whether some owner message in the batch asks, in one clause, to keep what
 * the memory says: the clause carries a memory phrase (see memoryClauses), at
 * least MEMORY_OVERLAP of the content words of the memory's title and fact
 * appear in that clause, every sensitive word of either is in the other, and
 * the clause and the memory agree on whether anything is negated ("never skip
 * the tests" is not "skip the tests").
 */
export function ownerAskedToRemember(fact: string, ownerTexts: readonly string[] | undefined, title?: string): boolean {
  const checked = contentWords([title, fact].filter(Boolean).join("\n"));
  if (checked.size === 0) return false;
  return (ownerTexts ?? []).some(
    (t) =>
      typeof t === "string" &&
      memoryClauses(t).some((clause) => {
        const said = contentWords(clause);
        if (said.has(NEGATED) !== checked.has(NEGATED)) return false;
        let shared = 0;
        for (const w of checked) {
          if (said.has(w)) shared++;
          else if (SENSITIVE_WORD.test(w)) return false;
        }
        // A fragment that leaves out a sensitive word of the clause ("push to
        // main" out of "ask me before you push to main") says less
        // than, or the opposite of, what the owner asked.
        for (const w of said) if (SENSITIVE_WORD.test(w) && !checked.has(w) && !MEMORY_PHRASE_WORDS.has(w)) return false;
        return shared / checked.size >= MEMORY_OVERLAP || quotesOwner(fact, clause);
      })
  );
}

/** Content words that only make up a memory phrase ("from now on", "keep in mind"). */
const MEMORY_PHRASE_WORDS = new Set(["remember", "now", "going", "forward", "future", "note", "keep", "mind", "make", "reference"]);

/** The content words of a clause, less the words of its memory phrase. */
function clauseContent(clause: string): Set<string> {
  const words = contentWords(clause);
  for (const w of MEMORY_PHRASE_WORDS) words.delete(w);
  return words;
}

/**
 * A memory clause that points back at what came before it and says nothing
 * of its own: "Remember that.", "Keep it in mind."
 */
function isAnaphoricMemoryClause(clause: string): boolean {
  return isMemoryClause(clause) && clauseContent(clause).size === 0;
}

/** A quote folded and collapsed like owner clauses, lowercased, its wrapping quotes and end punctuation dropped. */
function normalizeQuote(text: string): string {
  return collapse(foldText(text))
    .toLowerCase()
    .replace(/^["'“”‘’`\s]+|["'“”‘’`.,;!\s]+$/g, "");
}

/**
 * The owner's words `quote` stands for, when it is their own, asked to be kept this turn: it
 * appears verbatim (up to case, whitespace and look-alike characters) in an
 * owner message, within clauses that are not questions; one of those clauses
 * carries a memory phrase or states a standing preference
 * (isStandingPreference), or the clause right after them is a bare "remember
 * that"; and the quote is the whole of what those clauses say — at least
 * MEMORY_OVERLAP of their content words, every sensitive word among them, and
 * the same negation — so a fragment like "skip the tests" out of "never skip
 * the tests" is no quote. A `title` stored with the quote may not add a
 * sensitive word or a negation the quote lacks. Returns the owner's matched
 * words (folded as checked, in the owner's case), or null when the quote is
 * not theirs.
 */
export function ownerQuoted(quote: string, ownerTexts: readonly string[] | undefined, title?: string): string | null {
  const q = normalizeQuote(quote);
  const quoted = contentWords(q);
  if (quoted.size < 2) return null;
  if (title) {
    const titled = contentWords(title);
    if (titled.has(NEGATED) && !quoted.has(NEGATED)) return null;
    for (const w of titled) if (SENSITIVE_WORD.test(w) && !quoted.has(w)) return null;
  }
  for (const text of ownerTexts ?? []) {
    if (typeof text !== "string") continue;
    const clauses = ownerClauses(text);
    const lower = clauses.map((c) => c.toLowerCase());
    for (let i = 0; i < clauses.length; i++) {
      let joined = "";
      let joinedOriginal = "";
      for (let j = i; j < clauses.length; j++) {
        joined = joined ? `${joined} ${lower[j]}` : lower[j]!;
        joinedOriginal = joinedOriginal ? `${joinedOriginal} ${clauses[j]}` : clauses[j]!;
        const at = joined.indexOf(q);
        if (at < 0) continue;
        const span = clauses.slice(i, j + 1);
        if (span.some(isQuestion)) break;
        const asked =
          span.some((c) => isMemoryClause(c) || isStandingPreference(c)) ||
          (j + 1 < clauses.length && isAnaphoricMemoryClause(clauses[j + 1]!));
        if (!asked) break;
        const said = clauseContent(span.join(" "));
        if (said.has(NEGATED) !== quoted.has(NEGATED)) break;
        let shared = 0;
        let sensitiveMissing = false;
        for (const w of said) {
          if (quoted.has(w)) shared++;
          else if (SENSITIVE_WORD.test(w)) sensitiveMissing = true;
        }
        if (!sensitiveMissing && said.size > 0 && shared / said.size >= MEMORY_OVERLAP) {
          // Lowercasing can change a string's length; then only the folded,
          // lowercased span lines up with what was checked.
          return joined.length === joinedOriginal.length ? joinedOriginal.slice(at, at + q.length) : q;
        }
        break;
      }
    }
  }
  return null;
}

/**
 * Phrases with which an owner asks for a memory to be dropped. "Don't forget"
 * asks the opposite and is excluded by the caller.
 */
const FORGET_PHRASE =
  /\b(?:forget|stop\s+remembering|no\s+longer\s+(?:need|want|remember)|(?:drop|delete|remove|discard|scrap|clear)\s+(?:\w+\s+){0,4}?(?:memory|memories|preference|rule|note)|(?:don'?t|do\s+not)\s+(?:need\s+to\s+)?remember)\b/i;
const KEEP_NOT_FORGET = /(?:n't|\bnot|\bnever|\bdont)\s+(?:\w+\s+)?forget\b/i;
const FORGET_PHRASE_WORDS = new Set(["forget", "stop", "remembering", "remember", "longer", "need", "drop", "delete", "remove", "discard", "scrap", "clear", "memory", "memorie", "preference", "rule", "note"]);

/**
 * "Forget" meant for the moment or one piece of work rather than for good:
 * "forget the tests for now", "forget the review rule on this merge", "forget
 * my test preference here", "forget the deploy rules, Bob approved it". A
 * review by any noun for one (reviewNounsOf) is one piece of work too.
 */
const forgetForNow = perReviewNoun(
  (noun) =>
    new RegExp(
      String.raw`\b(?:for\s+now|for\s+(?:a|the)\s+(?:bit|moment|second|minute|while|time\s+being)|for\s+today|for\s+this\s+(?:one|task|run|job)|this\s+time|(?:just\s+)?this\s+once|right\s+now|today|tonight|here|(?:on|for|in)\s+(?:this|that)\s+(?:merge|pr|mr|code\s+review|review|task|run|job|change|branch|commit|deploy(?:ment)?|release|push|ticket|session|launch|one${orNoun(noun)})|\w+\s+(?:already\s+|just\s+)?(?:approved|signed\s+off\s+on|okayed|ok'd)\s+(?:it|this|that|them)?)\b`,
      "i"
    )
);
/**
 * Words that make a forget clause about something Persona keeps, not about a
 * task: a memory noun ("the … rule", "that preference", "the memory") or the
 * owner's own earlier words ("what I said about …", "what I told you", "the
 * thing I asked you to remember"). "Forget about the deploy" names a task.
 */
const MEMORY_REFERENCE =
  /\b(?:memor(?:y|ies)|preferences?|rules?|remember(?:ed|ing)?)\b|\bwhat\s+(?:i|we)\s+(?:\w+\s+)?(?:said|told\s+you|asked(?:\s+you)?)\b|\b(?:i|we)\s+(?:\w+\s+)?(?:told\s+you|asked\s+you\s+to\s+(?:remember|keep))\b/i;
/**
 * A forget clause about the conversation or the work at hand rather than a
 * memory: "forget that Slack message I mentioned", "forget what I said about
 * the deploy, I'll do it myself", "forget what we said in the standup".
 */
const FORGET_TASK_TALK =
  /\b(?:i|we)\s+(?:just\s+)?(?:mentioned|sent|posted|shared|showed|pasted|linked|forwarded)\b|\bi'?ll\s+(?:just\s+)?(?:do|handle|take\s+care\s+of|deal\s+with|fix|ship|run)\b|\bin\s+(?:the|our|this|that|today'?s)\s+(?:standup|meeting|call|sync|thread|channel|chat)\b/i;
/** Share of a memory's topic words a forget clause must name, rounded up. */
const FORGET_TOPIC_OVERLAP = 2 / 3;

/**
 * Whether some owner message in the batch asks, in one clause, to drop the
 * memory saved under `topic`: the clause carries a forget phrase, is not a
 * question, a "don't forget" or a "forget … for now", and names most of the
 * topic's words (FORGET_TOPIC_OVERLAP) — and either refers to something kept
 * (MEMORY_REFERENCE: "the … rule", "what I said about …") or names at least
 * two of them ("forget about the brief length limit"). "Forget the worker,
 * launch a fresh one" names a worker, not a memory, and "forget about the
 * deploy" names a task. `title` stands in for a topic with no words of its
 * own.
 */
export function ownerAskedToForget(
  topic: string,
  ownerTexts: readonly string[] | undefined,
  title?: string
): boolean {
  const wordsOf = (text: string) => {
    const words = contentWords(text.replace(/[-_]+/g, " "));
    words.delete(NEGATED);
    for (const w of FORGET_PHRASE_WORDS) words.delete(w);
    return words;
  };
  // A hashed topic (memory-slug.ts) is named by its words, not its hash.
  let about = wordsOf(topic.replace(/(?:^|-)[0-9a-f]{8}$/, ""));
  if (about.size === 0 && title) about = wordsOf(title);
  if (about.size === 0) return false;
  const needed = Math.ceil(about.size * FORGET_TOPIC_OVERLAP);
  return (ownerTexts ?? []).some(
    (t) =>
      typeof t === "string" &&
      ownerClauses(t).some((clause) => {
        if (isQuestion(clause) || !FORGET_PHRASE.test(clause) || KEEP_NOT_FORGET.test(clause)) return false;
        if (forgetForNow().test(clause) || FORGET_TASK_TALK.test(clause)) return false;
        let named = 0;
        for (const w of contentWords(clause)) if (about.has(w)) named++;
        return named >= needed && (MEMORY_REFERENCE.test(clause) || named >= 2);
      })
  );
}

const PLAYBOOK_WORD = /\bplay-?books?\b/i;
const KEEP_PLAYBOOK = /\b(?:keep|accept|approve|yes|yep|ok(?:ay)?|sure|lgtm)\b/i;
const NOT_KEEP_PLAYBOOK = /\b(?:don'?t|do\s+not|no|never|not|reject|discard|drop|delete|skip)\b/i;
const RETIRE_PLAYBOOK = /\b(?:retire|remove|delete|drop|forget|discard|get\s+rid\s+of)\b/i;
const NOT_RETIRE_PLAYBOOK = /\b(?:don'?t|do\s+not|never|not|keep)\b/i;
/**
 * Words that never name a playbook: the keep and retire vocabulary itself
 * (a title like "Keep: docs" must not be named by the verb that keeps it)
 * and filler.
 */
const PLAYBOOK_NAME_STOPWORDS = new Set([
  "playbook", "playbooks", "that", "this", "these", "those", "with", "from", "when", "into", "your", "mine",
  "keep", "accept", "approve", "okay", "sure", "lgtm", "retire", "remove", "delete", "drop", "forget", "discard",
  "reject", "skip", "please", "thanks", "save", "saved", "also", "both", "them", "they", "just", "it's",
]);

/** Which playbook a keep is about: its title and slug, and how many of the owner's drafts are pending. */
export interface PlaybookKeepTarget {
  title?: string;
  slug?: string;
  pendingCount?: number;
}

/**
 * Whether some owner message in the batch asks, in one clause that is not a
 * question, to keep this playbook: the clause names a playbook and says to
 * keep or accept it (asking to save one is not reviewing what was saved),
 * says nothing against it, and either names this playbook by a word of its
 * title or name, or this is the only draft pending.
 */
export function ownerAskedToKeepPlaybook(ownerTexts: readonly string[] | undefined, target: PlaybookKeepTarget = {}): boolean {
  return ownerAskedAboutPlaybook(ownerTexts, target, KEEP_PLAYBOOK, NOT_KEEP_PLAYBOOK, target.pendingCount === 1);
}

/**
 * Whether some owner message in the batch asks, in one clause that is not a
 * question, to retire this playbook: the clause names a playbook and says to
 * retire, remove or delete it, says nothing against it, and names this
 * playbook by a word of its title or name.
 */
export function ownerAskedToRetirePlaybook(ownerTexts: readonly string[] | undefined, target: PlaybookKeepTarget = {}): boolean {
  return ownerAskedAboutPlaybook(ownerTexts, target, RETIRE_PLAYBOOK, NOT_RETIRE_PLAYBOOK, false);
}

function ownerAskedAboutPlaybook(
  ownerTexts: readonly string[] | undefined,
  target: PlaybookKeepTarget,
  verb: RegExp,
  against: RegExp,
  unnamedSuffices: boolean
): boolean {
  const words = (text: string) => (text.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []).filter((w) => !PLAYBOOK_NAME_STOPWORDS.has(w));
  const named = new Set(words(`${target.title ?? ""} ${(target.slug ?? "").replace(/^playbook-.*?--/, "").replace(/-/g, " ")}`));
  return (ownerTexts ?? []).some(
    (t) =>
      typeof t === "string" &&
      ownerClauses(t).some((clause) => {
        if (isQuestion(clause) || !PLAYBOOK_WORD.test(clause) || !verb.test(clause) || against.test(clause)) return false;
        return unnamedSuffices || words(clause).some((w) => named.has(w));
      })
  );
}

// ── Chat consent ────────────────────────────────────────────────────────────

/** How long an owner's yes in chat stands for an action Persona then takes. */
export const CHAT_CONSENT_WINDOW_MS = 30 * 60 * 1000;

/** An owner message cited as consent, as the store holds it. */
export interface ConsentMessage {
  threadId: string;
  role: string;
  actor?: string;
  text: string;
  createdAt: string;
  /** Set on a slash command the owner ran: a read, never consent. */
  command?: unknown;
}

export interface ChatConsentInput {
  action: string;
  decision: PolicyDecision;
  owner: string;
  /** The thread the held call was made for. */
  threadId: string;
  now: Date;
  /** The cited message, or null when no message has that id. */
  message: ConsentMessage | null;
  /** Persona's message right before the cited one, which a bare "yes" answers. */
  prompt?: string;
  /** What the action is about: its title, brief, message, question, plan. */
  subject: string;
  /** Everything the held action would deliver or run, read for outward steps. */
  actionTexts: string[];
  /**
   * On the allow of a safety-floor hold: the held call (its tool and text).
   * The yes, or the question of Persona's it answers, must then name what
   * the call reaches (namesHeldCall), not just share a word with it: on a
   * high-risk hold (`highRisk`) its distinctive part, and on a call with a
   * scratch run's shape (`scratchRun`) the scratch instance will do. The
   * worker's worktree (`worktreeRoot`) tells a `cd` that stays in it.
   */
  heldCall?: { toolName?: string; call: string; highRisk?: boolean; scratchRun?: boolean; worktreeRoot?: string };
}

/** Words that say yes or ask for the step to go ahead. */
const AFFIRMATIVE =
  /\b(?:yes|yep|yeah|yup|sure|ok(?:ay)?|go\s+ahead|go\s+for\s+it|do\s+it|please|approved?|allow(?:ed)?|let\s+(?:it|them|him|her)|fine|sounds\s+good|lgtm|launch|start|kick\s+off|spin\s+up|send|tell|answer|reply|stop|kill|interrupt|restart|run)\b/i;

/** A content word (see contentWords) that names a step to carry out, as a yes repeats it: "start", "run", "launch". */
const STEP_VERB = /^(?:launch|start|kick|spin|send|tell|answer|reply|stop|kill|interrupt|restart|run|allow|approve|let|proceed|continue|retry|use|open|read|write|install|build|test)$/;

/**
 * Words that take a yes back or put it off. Unlike NEGATION, "stop" is left
 * out: it is what the owner says to have a worker stopped.
 */
const CONSENT_NEGATION =
  /\b(?:not|never|no|nope|nah|none|without|don'?t|do\s+not|can'?t|won'?t|shouldn'?t|mustn'?t|wait|hold\s+(?:off|on)|later|unless|until)\b|n't\b/i;

/**
 * Words any request to close sessions carries whichever sessions it means
 * ("close the old ones", "all those sessions"), so they never name one. Read
 * through contentWords where used, so they match after the same stemming.
 */
const GENERIC_SESSION_WORDS =
  "session sessions chat chats conversation conversations thread threads one ones all both every old stale scratch desktop imported idle stuck waiting";

/**
 * The close_session targets of `targets` the owner's yes doesn't name, on top
 * of chatConsent: each needs its own match in the owner's own words — or, for
 * a short reply, in the question of Persona's it answers — either its short
 * id or a word of its title that no other listed title has. Generic words
 * (GENERIC_SESSION_WORDS), the words that ask for a close and the words that
 * say yes never count, so "yes, close the login one" names neither "Close
 * stale PRs" nor, beside "Refactor login form", "Login rate limiting".
 */
export function closeTargetsUnnamed(
  input: { ownerText: string; prompt?: string },
  targets: ReadonlyArray<{ id: string; title?: string }>
): string[] {
  const verbs = ACTION_WORDS.close_session;
  const generic = contentWords(GENERIC_SESSION_WORDS);
  const naming = (w: string) => w !== NEGATED && !generic.has(w) && !verbs?.test(w) && !AFFIRMATIVE.test(w);
  const own = ownerClauses(input.ownerText).join(" ");
  const question = ownerClauses(input.prompt ?? "").filter((c) => c.endsWith("?")).at(-1);
  const answersQuestion = !!question && contentWords(own).size <= 6;
  const texts = answersQuestion ? [own, question] : [own];
  const said = new Set(texts.flatMap((t) => [...contentWords(t)]).filter(naming));
  const lower = texts.join(" ").toLowerCase();
  const wordsOf = targets.map((t) => new Set([...contentWords(t.title ?? "")].filter(naming)));
  return targets
    .filter((t, i) => {
      const shortId = t.id.slice(0, 8).toLowerCase();
      if (shortId.length >= 8 && lower.includes(shortId)) return false;
      const unique = [...wordsOf[i]!].filter((w) => wordsOf.every((other, j) => j === i || !other.has(w)));
      return !unique.some((w) => said.has(w));
    })
    .map((t) => t.id);
}

/** Words that name each kind of action, in the owner's message or the question it answers. */
const ACTION_WORDS: Record<string, RegExp> = {
  launch_session: /\b(?:launch\w*|start\w*|spin\w*|kick\w*|worker\w*|another|run)\b/i,
  send_to_session: /\b(?:send\w*|tell\w*|message\w*|steer\w*|ask\w*|say)\b/i,
  interrupt_session: /\b(?:interrupt\w*|stop\w*|pause\w*|halt\w*)\b/i,
  recover_session: /\b(?:recover\w*|unstick\w*|unwedg\w*|resync\w*|wake\w*|stuck)\b/i,
  stop_session: /\b(?:stop\w*|kill\w*|end|cancel\w*|shut\w*)\b/i,
  close_session: /\b(?:clos(?:e|es|ing)|delet\w*|dismiss\w*|archiv\w*|end)\b/i,
  answer_ask: /\b(?:answer\w*|repl\w*|allow\w*|let|approv\w*|run|permission)\b/i,
  approve_plan: /\b(?:approv\w*|plan\w*|lgtm)\b/i,
  reject_plan: /\b(?:reject\w*|plan\w*|back|redo)\b/i,
  restart_standup: /\b(?:restart\w*|reboot\w*|redeploy\w*|roll\s+in)\b/i,
  open_job: /\b(?:budget\w*|extend\w*|rais\w*|increas\w*|bump\w*|more)\b/i,
  update_job: /\b(?:budget\w*|extend\w*|rais\w*|increas\w*|bump\w*|more)\b/i,
  set_pipeline: /\b(?:pipelines?|flows?|presets?|stages?|set|change|switch|use)\b/i,
};

/** Words that name a delivery pipeline or one of its stages; the code_review stage by the org's noun for a review too. */
const pipelineTopic = perReviewNoun(
  (noun) =>
    new RegExp(
      String.raw`\b(?:pipelines?|flows?|presets?|stages?|code[\s_]+reviews?${orNoun(noun)}|deploy\w*|screenshots?|live[\s-]+checks?|review\s+packets?|reviewers?|rounds?)\b`,
      "i"
    )
);

/** Words that set a pipeline rather than ask about one: a stage turned on or off, a count, a limit. */
const PIPELINE_SETTING =
  /\b(?:no|skip\w*|without|drop|don'?t|never|always|only|add|use|set|switch|make|turn|enable|disable|require|keep|max|block|preset|light|full|pipeline|flow)\b|\b\d+\s+(?:reviewers?|rounds?)\b/i;

/**
 * Whether some owner message in the batch, in their own words (see
 * ownerClauses), sets this pipeline change: a clause that is not a question,
 * names a pipeline or a stage (pipelineTopic), says what it should be
 * (PIPELINE_SETTING) — "for standup: no code review, isolated live check", "use the
 * light flow" — and, when `touches` is given (pipelineLayerTouches), names
 * at least one thing the change touches in the spec phrase table's words
 * (pipelineTermsNamed): "keep me posted on the code review" doesn't ask for "no
 * validation". Gates only `set_pipeline` on the owner's or a project's
 * layer; a change that weakens the pipeline is decided apart from it.
 */
export function ownerAskedForPipeline(ownerTexts: readonly string[] | undefined, touches?: readonly string[]): boolean {
  return (ownerTexts ?? []).some(
    (t) =>
      typeof t === "string" &&
      ownerClauses(t).some(
        (clause) =>
          !isQuestion(clause) &&
          normalizedReadings(clause).some(
            (r) =>
              pipelineTopic().test(r) &&
              PIPELINE_SETTING.test(r) &&
              (touches === undefined || [...pipelineTermsNamed(r)].some((term) => touches.includes(term)))
          )
      )
  );
}

/** Content words shared by two texts, less words that only name the kind of action. */
function sharedWords(a: string, b: string, action: string): number {
  const words = contentWords(b);
  const verbs = ACTION_WORDS[action];
  let shared = 0;
  for (const w of contentWords(a)) {
    if (w === NEGATED || (verbs && verbs.test(w))) continue;
    if (words.has(w)) shared++;
  }
  return shared;
}

/**
 * Whether the owner's cited chat message clears a held action, and why not
 * when it doesn't. The message must be the owner's own, in the same thread,
 * at most CHAT_CONSENT_WINDOW_MS old, a plain yes (not a question, no
 * negation), and about this action: it, or the question of Persona's it
 * answers, names the kind of action and shares a content word with what the
 * action is about. On a safety-floor allow (heldCall) the held call's
 * comments don't count toward that, and the yes or its question must name
 * one of the call's distinctive targets. Chat consent never covers a hold the policy keeps for the
 * card (see PolicyDecision.consentable), nor an action whose content takes an
 * outward step or reaches the collector API — pushes, PRs, merges and
 * deploys are always decided on the card.
 */
export function chatConsent(input: ChatConsentInput): { ok: true; quote: string } | { ok: false; reason: string } {
  const no = (reason: string) => ({ ok: false as const, reason });
  for (const text of input.actionTexts) {
    if (writesCollectorApi(text) || referencesCollectorApi(text)) return no("the action reaches Standup's HTTP API, which chat consent never covers");
    const step = outwardStep(text, { honorNegation: false, profile: activeOrgProfile() });
    if (step) return no(`the action takes an outward-facing step ("${step}"), which chat consent never covers`);
  }
  if (input.decision.rule !== "ask" || !input.decision.consentable) return no("this hold is decided on the approval card only");
  const m = input.message;
  if (!m) return no("no message has that id");
  if (m.threadId !== input.threadId) return no("the message is in another thread");
  if (m.role !== "user" || m.actor !== input.owner) return no("the message is not the owner's");
  if (m.command) return no("the message is a slash command, not a reply");
  const age = input.now.getTime() - Date.parse(m.createdAt);
  if (!(age >= -60_000 && age <= CHAT_CONSENT_WINDOW_MS)) return no("the message is not from the last 30 minutes");
  const own = ownerClauses(m.text).join(" ");
  const readings = normalizedReadings(own);
  if (!own || isQuestion(own)) return no("the message asks rather than says yes");
  if (readings.some((r) => CONSENT_NEGATION.test(r))) return no("the message carries a negation");
  if (!readings.some((r) => AFFIRMATIVE.test(r))) return no("the message doesn't say yes");
  const verbs = ACTION_WORDS[input.action];
  const prompt = input.prompt?.trim() ?? "";
  // A short yes answers the question Persona asked right before it.
  const answersPrompt = !!prompt && prompt.includes("?") && contentWords(own).size <= 6;
  // Allowing an ask runs the step it holds, so a question naming that step in its own verb ("Start it?") and a
  // yes repeating the verb ("Yes, start it") name the allow, when the question shares more than the verb with the ask.
  const promptWords = answersPrompt ? contentWords(prompt) : new Set<string>();
  // A held call's `#` comments are the worker's words, never what the action is about.
  const subject = input.heldCall ? withoutShellComments(input.subject) : input.subject;
  const subjectWords = contentWords(subject);
  const echoesStep =
    input.action === "answer_ask" &&
    [...contentWords(own)].some((w) => STEP_VERB.test(w) && promptWords.has(w)) &&
    [...promptWords].some((w) => w !== NEGATED && !STEP_VERB.test(w) && subjectWords.has(w));
  const named = !!verbs && (verbs.test(own) || (answersPrompt && verbs.test(prompt)) || echoesStep);
  const about = sharedWords(own, subject, input.action) > 0 || (answersPrompt && sharedWords(prompt, subject, input.action) > 0);
  if (!named || !about) return no("the message isn't about this action");
  const held = input.heldCall;
  if (held && !namesHeldCall([own, answersPrompt ? prompt : undefined], held.toolName, held.call, { reserved: !!held.highRisk, scratchRun: !!held.scratchRun, worktreeRoot: held.worktreeRoot })) {
    return no("neither the message nor the question it answers names what the held call reaches (a path, host, account or the step and its object)");
  }
  return { ok: true, quote: collapse(m.text).slice(0, 200) };
}

/** An affirmative opening an owner's reply, optionally after they address Persona ("Persona, yes …"). */
const YES_OPENING = /^(?:(?:hey|hi)\s+)?(?:persona\s*[,:]?\s+)?(?:yes|yep|yeah|yup|sure|ok(?:ay)?|go\s+ahead|approved|do\s+it|please\s+do)\b[\s,.!:;-]*/i;

/** What follows a yes that tells the step to go ahead: an imperative ("run …", "start …", "and push …"). */
const YES_IMPERATIVE =
  /^(?:please\s+)?(?:and\s+)?(?:please\s+)?(?:run|start|launch|spin\s+up|kick\s+off|restart|push|proceed(?:\s+with)?|go\s+ahead(?:\s+(?:with|and))?|allow|approve|let\s+(?:it|the\s+worker|them))\b/i;

/**
 * Words a reply carries that put a yes off, take it back, attach a condition,
 * hedge it, recall the past or turn it into a question. Any one of them,
 * anywhere in the message, means the message is no yes.
 */
const YES_UNDONE =
  /\b(?:but|first|actually|wait|hold|later|think|thinking|let\s+me|not|don'?t|do\s+not|never|no|nope|nah|stop|cancel|instead|myself|if|unless|until|till|yesterday|earlier|before|already|ran|did|maybe|perhaps|probably|might|explain|why|without|can'?t|won'?t|shouldn'?t|mustn'?t)\b|n't\b|\?|\bscratch\s+that\b|\b(?:once|after|afterwards?|when|whenever|while|whilst|though|although|since|whether|assuming|assume|provided|providing|given|pending|except|excepting|excluding|other\s+than|as\s+(?:long|soon)\s+as|so\s+long\s+as|in\s+case|on\s+(?:the\s+)?condition|subject\s+to|tomorrow|tonight|next|soon|eventually|morning|afternoon|evening|weekend|(?:mon|tues|wednes|thurs|fri|satur|sun)day)\b/i;

/**
 * Words a short reply may carry beside its yes or no that name no step:
 * affirmatives, negatives, courtesies and pronouns ("yes please", "ok, do
 * it", "no thanks", "sure, run it").
 */
const REPLY_FILLER = new Set(
  (
    "yes yep yeah yup sure ok okay go ahead do it please thanks thank you fine sounds good that this approved persona " +
    "run start launch proceed no nope nah wait hold off later not don't dont stop cancel and just now then lgtm great"
  ).split(" ")
);

/** Words of a reply that name what it is about, read as REPLY_FILLER reads them. */
function replyWords(text: string): string[] {
  return (collapse(foldText(text)).toLowerCase().match(/[a-z0-9]+(?:'[a-z]+)?/g) ?? []).filter((w) => !REPLY_FILLER.has(w));
}

/**
 * One owner message read for a yes to a held step. `words`: the owner's own
 * clauses (quoted, fenced, blockquoted and reported text dropped, see
 * ownerOwnText). `yes`: the message opens with an affirmative (YES_OPENING)
 * directed at the step, either an imperative after it (YES_IMPERATIVE) or a
 * bare reply, and carries nothing anywhere that puts the yes off, takes it
 * back, conditions or questions it (YES_UNDONE, CONSENT_NEGATION). When in
 * doubt, it is no yes. `bare`: the reply names nothing beyond yes or no
 * (REPLY_FILLER), so only the question it answers can say what it is about.
 * `short`: few enough words to be read against that question as well.
 */
export function ownerYes(text: string): { words: string; yes: boolean; bare: boolean; short: boolean } {
  const words = ownerClauses(text).join(" ");
  const bare = !!words && replyWords(words).length === 0;
  const short = contentWords(words).size <= 6;
  if (!words) return { words, yes: false, bare, short };
  const readings = [...normalizedReadings(words), collapse(foldText(text))];
  if (readings.some((r) => YES_UNDONE.test(r) || CONSENT_NEGATION.test(r)) || isQuestion(words)) return { words, yes: false, bare, short };
  const opening = YES_OPENING.exec(words);
  const rest = opening ? words.slice(opening[0].length) : "";
  const yes = !!opening && (bare || YES_IMPERATIVE.test(rest));
  return { words, yes, bare, short };
}

/**
 * Whether every word a short reply names beyond yes or no (replyWords) is a
 * word of the question it answers: "yes, run the scratch copy" answering a
 * question about a scratch copy of the collector repeats it, while "yes,
 * push the branch" names a step the question never asked about.
 */
export function replyWithinQuestion(reply: string, question: string): boolean {
  const asked = new Set(replyWords(question));
  const named = replyWords(reply).filter((w) => !STOPWORDS.has(w));
  return named.length > 0 && named.every((w) => asked.has(w));
}

/** A prohibition that covers every step: "hold everything", "stop all of it", "don't run anything". */
const BLANKET_PROHIBITION =
  /\b(?:hold|stop|pause|freeze|block)\s+(?:everything|all\b|it\s+all|anything)|\b(?:don'?t|do\s+not|never)\s+(?:run|start|do|launch|allow)\s+anything\b|\bnothing\s+(?:runs|else\s+runs|gets?\s+(?:run|started))\b/i;

/**
 * A clause that forbids a step: "never …", "don't …", "no …", "stop …",
 * "hold off on …", "avoid …", "skip …", "refrain from …", "… is off limits",
 * "I'd rather you not …", "… is not okay", "… is forbidden".
 */
const PROHIBITION =
  /\b(?:never|don'?t|do\s+not|no|stop|cancel|hold\s+off|shouldn'?t|mustn'?t|must\s+not|not\s+(?:allowed|permitted|okay|ok|fine)|avoid(?:s|ed|ing)?|skip(?:s|ped|ping)?|refrain(?:s|ed|ing)?|off[\s-]+limits|rather\s+(?:you|they|it|the\s+worker)\s+(?:not|didn'?t|did\s+not|don'?t)|forbid(?:s|den)?|prohibit(?:s|ed)?|disallow(?:s|ed)?|leave\s+out)\b/i;

/** A prohibition put off only for a while ("don't run it yet"), which a later yes lifts; "never" is never one. */
const DEFERRAL = /\b(?:yet|until|till|for\s+now|right\s+now)\b/i;

/**
 * The owner's own clauses in one message or preference that forbid a step
 * (`clauses`, each to be matched against the held call), and whether one
 * forbids every step (`blanket`). A "never" clause always forbids; a "don't"
 * or "no" clause put off for a while ("yet", "until") is a deferral, not a
 * prohibition.
 */
export function ownerProhibits(text: string): { clauses: string[]; blanket: boolean } {
  const own = ownerClauses(text);
  const blanket = own.some((c) => BLANKET_PROHIBITION.test(c));
  const clauses = own.filter((c) => /\bnever\b/i.test(c) || (PROHIBITION.test(c) && !DEFERRAL.test(c)));
  return { clauses, blanket };
}

// ── Verdicts ────────────────────────────────────────────────────────────────

/**
 * The outward-facing steps a worker's plan names, read as the worker's text
 * (a negation in it is no prohibition: "I will not push" still names a push).
 * Advisory only, never a hold: Persona's approval of such a plan tells the
 * worker it covers only the local work; the steps themselves stop at the
 * worker's safety floor, where each is decided on its own.
 */
export function planOutwardSteps(texts: ReadonlyArray<string | undefined>): string[] {
  const steps: string[] = [];
  for (const text of texts) {
    for (const m of outwardMatches(text, { honorNegation: false, profile: activeOrgProfile() })) {
      if (!steps.includes(m.step)) steps.push(m.step);
    }
  }
  return steps;
}

/**
 * The verdict on answering a safety-floor ask, or null for any other ask. The
 * gate and category are set by the collector from the held call, so no
 * wording in the worker's question or in Persona's answer changes the verdict.
 * Any answer floorAnswerAllows doesn't read as a plain allow denies the call
 * (the hook reads it the same way), so it acts.
 */
function floorVerdict(ctx: PolicyContext): PolicyDecision | null {
  if (ctx.askGate !== FLOOR_GATE && ctx.askGate !== FLOOR_OWNER_GATE) return null;
  if (!floorAnswerAllows(ctx.text)) {
    return { rule: "act", reason: "denies a call the safety floor held; nothing runs" };
  }
  const category = ctx.floorCategory;
  const named = category ? ` (${category})` : "";
  if (!category || ctx.askKind !== "ask_human") {
    return {
      rule: "ask",
      reason: `a safety-floor hold${named} Persona can't place; the owner decides whether it runs`,
      holdRule: floorHoldRule(category),
    };
  }
  // Persona's allow of an owner-only or high-risk hold runs the call too: the
  // owner reviews it afterwards, from the reason the tool layer records with it.
  const kind = ctx.floorHighRisk ? "a high-risk " : ctx.askGate === FLOOR_OWNER_GATE ? "an owner-only " : "a ";
  return { rule: "act", reason: `allows ${kind}safety-floor hold${named} once on an owned worker` };
}

/**
 * The verdict for one Persona action: `act` runs it, `ask` holds it for the
 * owner's approval, `never` refuses it. Pure — every input is in `ctx` and
 * `settings`. An owner hold (settings.hold) turns a routine `act` into `ask`;
 * it never loosens the floor.
 */
export function decide(action: string, ctx: PolicyContext = {}, settings: PolicySettings = {}): PolicyDecision {
  const verdict = baseVerdict(action, ctx, settings);
  if (verdict.rule === "act" && HOLDABLE.has(action) && settings.hold?.has(action)) {
    return {
      rule: "ask",
      reason: `the owner holds ${action} for approval (STANDUP_PERSONA_HOLD)`,
      holdRule: holdKnobRule(action),
      consentable: action !== "remember" && action !== "forget",
    };
  }
  if (
    verdict.rule === "act" &&
    action === "waive_pipeline_stage" &&
    ctx.waiveKind === "accept_wontfix" &&
    settings.hold?.has(HOLD_ACCEPT_WONTFIX)
  ) {
    return {
      rule: "ask",
      reason: `the owner holds accepting wontfix review findings for approval (STANDUP_PERSONA_HOLD ${HOLD_ACCEPT_WONTFIX})`,
      holdRule: holdKnobRule(HOLD_ACCEPT_WONTFIX),
      consentable: true,
    };
  }
  return verdict;
}

/**
 * Why a Persona launch can't start yet, or null when it can: the active cap
 * (configured, or lowered by host headroom) is reached. Such a launch is
 * queued, not held. There is no daily count limit.
 */
export function launchCapacity(ctx: Pick<PolicyContext, "activeLaunches" | "maxActiveLaunches">): string | null {
  const active = ctx.activeLaunches ?? 0;
  const cap = ctx.maxActiveLaunches ?? 0;
  if (active >= cap) return `active launch cap reached (${active}/${cap})`;
  return null;
}

/** Why a project's workers can't run under the safety floor, or null when they can. */
function harnessRefusal(ctx: PolicyContext): string | null {
  const harness = ctx.launchHarness ?? "claude";
  if (harness === "claude") return null;
  return `the project's ${harness} harness has no safety floor, so Persona doesn't launch into it`;
}

/**
 * A worker launch, decided on structured facts only: a launchable project
 * whose harness runs under the safety floor. The brief is never read; what it
 * makes the worker do stops at the floor. A launch whose job or own layer
 * weakens the project's pipeline is the owner's (pipelineWeakensHold). Past
 * the active cap it still acts, queued (launchCapacity).
 */
function launchVerdict(ctx: PolicyContext): PolicyDecision {
  if (!ctx.projectLaunchable) return { rule: "never", reason: "project is not a registered, launchable project" };
  const harness = harnessRefusal(ctx);
  if (harness) return { rule: "never", reason: harness };
  if (ctx.jobOverBudget) {
    return {
      rule: "ask",
      reason: `the job is over its time and spend budget (${ctx.jobOverBudget}); the owner decides whether it gets another launch`,
      holdRule: "job-budget",
      consentable: true,
    };
  }
  const weakens = pipelineWeakensHold(ctx);
  if (weakens) return weakens;
  const queued = launchCapacity(ctx);
  if (queued) return { rule: "act", reason: `launch queued: ${queued}`, queued };
  return { rule: "act", reason: "launch within the active cap" };
}

/**
 * The hold for a pipeline change that weakens the pipeline it lands on
 * (PolicyContext.pipelineWeakens), or null: a guarded stage removed,
 * bypassed, made optional or skippable, a review loosened, the pipeline
 * turned off, or validation checks changed. Those stages are how a change
 * reaches review, so only the owner's card weakens them — never their word
 * in chat relayed by Persona.
 */
function pipelineWeakensHold(ctx: PolicyContext): PolicyDecision | null {
  const weakens = ctx.pipelineWeakens ?? [];
  if (weakens.length === 0) return null;
  return {
    rule: "ask",
    reason: `the pipeline change weakens the pipeline (${weakens.join("; ")}); only the owner weakens it`,
    holdRule: "pipeline-turns-off",
  };
}

/**
 * A pipeline layer Persona sets. A job's or a launch's layer is routine
 * bookkeeping on Persona's own work; the owner's and a project's layers are
 * the owner's settings, set directly only when the owner asked for this
 * change this turn (ownerAskedForPipeline, naming what it touches) in a
 * private thread. Any change that weakens the pipeline is held for the owner
 * (pipelineWeakensHold). The outward steps themselves are untouched: a layer
 * only decides which stages a run asks for.
 */
function pipelineVerdict(ctx: PolicyContext): PolicyDecision {
  const scope = ctx.pipelineScope;
  if (scope === "job" || scope === "launch") {
    if (!ctx.owned) return { rule: "never", reason: "Persona only changes the pipeline of its own jobs and launches" };
    return pipelineWeakensHold(ctx) ?? { rule: "act", reason: `the ${scope} pipeline of Persona's own work, recorded with its reason` };
  }
  if (scope !== "user" && scope !== "project") return { rule: "never", reason: "set_pipeline needs a scope of user, project, job or launch" };
  const weakens = pipelineWeakensHold(ctx);
  if (weakens) return weakens;
  if (!ctx.privateThread || !ownerAskedForPipeline(ctx.ownerTexts, ctx.pipelineTouches)) {
    return {
      rule: "ask",
      reason: `the ${scope === "user" ? "owner's own" : "project's"} pipeline is the owner's setting, and no message from the owner this turn asks for this change`,
      holdRule: "pipeline-owner-words",
      consentable: true,
    };
  }
  return { rule: "act", reason: `a ${scope === "user" ? "owner" : "project"} pipeline change the owner asked for this turn` };
}

/**
 * A schedule action. A schedule only stores what will run, so creating one,
 * or changing a launch_job's brief or project, is checked by what it stores:
 * the project must be launchable under the safety floor (its brief is not
 * read, like a launch's). Each scheduled run then passes launch_session's
 * policy on its own, unattended. Pausing, retiming, renaming or deleting a
 * schedule, and anything about a wake_persona schedule, which only wakes
 * Persona, act. Running a launch_job now is a launch, checked in full.
 */
function scheduleVerdict(action: string, ctx: PolicyContext, settings: PolicySettings): PolicyDecision {
  const launches = ctx.scheduleKind !== "wake_persona";
  if (action === "delete_schedule" || !launches) return { rule: "act", reason: "schedule bookkeeping" };
  if (action === "run_schedule_now") {
    const verdict = launchVerdict(ctx);
    if (verdict.rule === "act" && settings.hold?.has("launch_session")) {
      return {
        rule: "ask",
        reason: "the owner holds launch_session for approval (STANDUP_PERSONA_HOLD)",
        holdRule: holdKnobRule("launch_session"),
        consentable: true,
      };
    }
    if (verdict.rule !== "act") return verdict;
    return verdict.queued
      ? { rule: "act", reason: `a scheduled launch, run now: ${verdict.reason}`, queued: verdict.queued }
      : { rule: "act", reason: "a scheduled launch within the active cap, run now" };
  }
  if (action === "update_schedule" && ctx.scheduleLaunchChanged === false) {
    return { rule: "act", reason: "edits a schedule's timing or settings, not what it launches" };
  }
  if (!ctx.projectLaunchable) return { rule: "never", reason: "the schedule's project is not a registered, launchable project" };
  const harness = harnessRefusal(ctx);
  if (harness) return { rule: "never", reason: harness };
  return { rule: "act", reason: "a recurring launch into a launchable project" };
}

function baseVerdict(action: string, ctx: PolicyContext, settings: PolicySettings): PolicyDecision {
  if (READ_ACTIONS.has(action)) return { rule: "act", reason: "read or owner-facing action" };
  if ((action === "open_job" || action === "update_job") && ctx.budgetRaise) {
    // Lowering a budget, or setting one within the owner's default, is
    // bookkeeping; giving a job more time or money than the owner set is theirs.
    return {
      rule: "ask",
      reason: `it raises the job's budget (${ctx.budgetRaise}), which only the owner extends`,
      holdRule: "job-budget-raise",
      consentable: true,
    };
  }
  if (BOOKKEEPING.has(action)) return { rule: "act", reason: "job bookkeeping" };
  // A doc in the owner's own tree: only the owner shares one by link, and a
  // link is a read-only view of the doc's latest revision, so a write to a
  // shared doc is the owner's own edit. Its images may land where a link shows
  // them, as the owner's own would; write_doc runs only in the owner's private
  // thread.
  if (action === "write_doc") return { rule: "act", reason: "a doc in the owner's own Docs" };

  if (action === "remember") {
    // A memory is listed for the owner after it is saved, so an ordinary one
    // needs no card. One about outward steps or what agents may do unasked
    // (see memoryNeedsOwnerWords) is saved directly only when the owner asked
    // this turn to keep it and it is their words: a verbatim quote of what
    // they said, or a fact that sticks to it. Words the owner quoted or
    // pasted from someone else are not theirs (see ownerClauses).
    if (writesCollectorApi(ctx.text) || writesCollectorApi(ctx.quote)) {
      return { rule: "ask", reason: "the memory writes to Standup's HTTP API", holdRule: "memory-collector-api" };
    }
    if (!memoryNeedsOwnerWords([ctx.text, ctx.quote].filter(Boolean).join("\n"))) {
      return { rule: "act", reason: "a memory about how the owner works, listed for their review" };
    }
    if (ctx.quote !== undefined && ownerQuoted(ctx.quote, ctx.ownerTexts, ctx.title) !== null) {
      return { rule: "act", reason: "the owner's own words, asked this turn to be kept" };
    }
    const memory = ctx.title !== undefined ? ctx.fact ?? "" : ctx.text ?? ctx.fact ?? "";
    if (!ownerAskedToRemember(memory, ctx.ownerTexts, ctx.title)) {
      const step = outwardStep(ctx.text, { profile: activeOrgProfile() });
      return {
        rule: "ask",
        reason: step
          ? `the memory describes an outward-facing step ("${step}") and no message from the owner this turn asks to remember it in these words`
          : "the memory changes what agents may do on their own, and no message from the owner this turn asks to remember it in these words",
        holdRule: "memory-owner-words",
      };
    }
    return { rule: "act", reason: "a memory the owner asked for this turn" };
  }

  if (action === "forget") {
    if (!ownerAskedToForget(ctx.topic ?? "", ctx.ownerTexts, ctx.title)) {
      return { rule: "ask", reason: "no message from the owner this turn asks Persona to forget this memory", holdRule: "forget-owner-words" };
    }
    return { rule: "act", reason: "a memory the owner asked this turn to drop" };
  }

  if (action === "decide_knowledge_draft") {
    // Reviewing the knowledge base's pending drafts is Persona's to do: the
    // decision and its reason are recorded for the owner to audit. The
    // personal layer stays remember/forget only, and a thread other people
    // read never decides what the knowledge base keeps.
    if (ctx.personalLayer) {
      return { rule: "never", reason: "the draft is in the owner's personal layer; save or drop it with remember or forget" };
    }
    if (!ctx.privateThread) {
      return { rule: "never", reason: "knowledge drafts are decided from a private thread, not one other people read" };
    }
    return { rule: "act", reason: "a knowledge-draft review decision, recorded with its reason" };
  }

  if (action === "save_playbook") {
    // A playbook is a draft in the owner's personal layer, invisible until
    // they accept it, and its text never reaches a pipeline or floor
    // decision. Approval notes that change what agents may do unasked are the
    // owner's to state, like a memory about outward steps.
    if (!ctx.privateThread) {
      return { rule: "never", reason: "playbooks are the owner's personal layer and are saved from a private thread" };
    }
    if (ctx.playbookNeedsOwnerWords !== false && !(ctx.text && ownerQuoted(ctx.text, ctx.ownerTexts, ctx.title))) {
      return {
        rule: "ask",
        reason: "the playbook's approval notes change what agents may do on their own, and they are not the owner's words from this turn",
        holdRule: "playbook-owner-words",
      };
    }
    return { rule: "act", reason: "a playbook draft, kept out of every brief until the owner accepts it" };
  }

  if (action === "decide_playbook") {
    if (!ctx.privateThread) {
      return { rule: "never", reason: "playbooks are the owner's personal layer and are decided from a private thread" };
    }
    if (ctx.playbookDecision === "reject") return { rule: "act", reason: "drops a playbook draft no brief has used" };
    if (ctx.playbookDecision === "retire") {
      if (!ownerAskedToRetirePlaybook(ctx.ownerTexts, { title: ctx.title, slug: ctx.topic })) {
        return {
          rule: "ask",
          reason: "retiring deletes a playbook the owner kept, and no message from the owner this turn asks to retire it",
          holdRule: "playbook-retire",
        };
      }
      return { rule: "act", reason: "a playbook the owner asked this turn to retire" };
    }
    if (!ownerAskedToKeepPlaybook(ctx.ownerTexts, { title: ctx.title, slug: ctx.topic, pendingCount: ctx.playbookPendingCount })) {
      return {
        rule: "ask",
        reason: "a playbook is reused in later briefs once accepted, and no message from the owner this turn asks to keep it",
        holdRule: "playbook-accept",
      };
    }
    return { rule: "act", reason: "a playbook the owner asked this turn to keep" };
  }

  if (action === "launch_session") return launchVerdict(ctx);

  if (action === "set_pipeline") return pipelineVerdict(ctx);

  if (SCHEDULE_ACTIONS.has(action)) return scheduleVerdict(action, ctx, settings);

  if (action === "restart_standup") {
    // A restart reaches no one outside the owner's machine and undoes itself
    // (it rolls back to the last good commit when the health check fails).
    // Merging what it rolls in is a separate, held step.
    if (!ctx.privateThread) {
      return {
        rule: "ask",
        reason: "a restart asked for from a thread other people read needs the owner's approval",
        holdRule: "restart-shared",
        consentable: true,
      };
    }
    return { rule: "act", reason: "restarting the owner's own Standup, health-checked with rollback" };
  }

  if (action === "update_project_repos") {
    // A project's repos are launch posture (the collector refuses to change
    // them without the owner token): they decide where workers launch and
    // which checkouts they reach. The owner approves the exact before/after.
    return {
      rule: "ask",
      reason: "a project's repos decide where workers launch; only the owner changes them",
      holdRule: "project-repos",
    };
  }

  if (action === "close_session") {
    if (ctx.openJobWorker) {
      return {
        rule: "never",
        reason: ctx.owned
          ? "this is one of your workers; stop it with stop_session or close its job"
          : "this session is a worker of another open Persona job",
      };
    }
    if (ctx.sessionOtherUser) return { rule: "never", reason: `the session belongs to ${ctx.sessionOtherUser}` };
    // Ending a session Persona didn't launch is the owner's call: their own
    // yes in chat naming the sessions clears it, else the card decides.
    return {
      rule: "ask",
      reason: "closing a session Persona didn't launch is the owner's call",
      holdRule: "close-session",
      consentable: true,
    };
  }

  if (!ctx.owned) return { rule: "never", reason: "Persona only acts on sessions it launched" };

  if (SESSION_ACTIONS.has(action)) {
    if (action === "send_to_session") {
      // Claude Code runs a leading `!` as a shell command outside every hook,
      // so it never reaches a worker whose permissions are bypassed.
      if (ctx.workerBypassed && startsWithShellEscape(ctx.text ?? "")) {
        return { rule: "never", reason: SHELL_ESCAPE_REFUSAL };
      }
      // Typed text lands wherever the pane's focus is: Enter on a permission
      // dialog selects its default ("Yes"), and keystrokes mid-tool interrupt
      // or answer whatever is showing. `now` is only safe at an idle prompt.
      if (ctx.sendMode === "now" && (ctx.permissionPending || !ctx.workerAtPrompt)) {
        return {
          rule: "never",
          reason: ctx.permissionPending
            ? "the session is on a tool-permission prompt; answer it with answer_ask (held for the owner) or use mode next_turn"
            : "the worker is not idle at its prompt (mid-turn, running a tool or on a dialog); use mode next_turn to steer it, or answer_ask for a pending question",
        };
      }
    }
    // A worker of a job over its budget was asked to stop and wait: what
    // would set it going again is the owner's.
    if ((action === "send_to_session" || action === "recover_session") && ctx.jobOverBudget) {
      return {
        rule: "ask",
        reason: `the worker's job is over its time and spend budget (${ctx.jobOverBudget}); the owner decides whether it goes on`,
        holdRule: "job-budget",
        consentable: true,
      };
    }
    return { rule: "act", reason: "owned session" };
  }

  if (action === "answer_ask") {
    if (ctx.askGate === IDLE_NOTICE_GATE) {
      return { rule: "never", reason: "this is the worker's idle notice, not a question; message it with send_to_session" };
    }
    const floor = floorVerdict(ctx);
    if (floor) return floor;
    if (ctx.askGate) return { rule: "ask", reason: "a confirmation gate asks the owner, not Persona", holdRule: "confirmation-gate" };
    // A one-time allow of a call that only reads, and that the safety floor
    // allows with no hold, writes nothing and goes nowhere: Persona answers it.
    if (ctx.askKind === "permission_prompt" && ctx.permissionReadOnly === true) {
      return { rule: "act", reason: "allows once a read-only call the safety floor allows" };
    }
    // A deny runs nothing and goes nowhere; holding it only blocks the worker.
    if (ctx.askKind === "permission_prompt" && ctx.permissionDeny === true) {
      return { rule: "act", reason: "denies a tool call; nothing runs" };
    }
    // Any other tool-permission answer runs a tool call the worker's own
    // permission rules stopped, so it stays the owner's.
    if (ctx.askKind !== "ask_human") {
      return { rule: "ask", reason: "tool-permission prompts are held for the owner", holdRule: "permission-prompt", consentable: true };
    }
    // Answering lets the worker go on; any outward step it then takes stops
    // at its safety floor, as an owner card showing the exact call.
    return { rule: "act", reason: "worker question on an owned session" };
  }

  if (action === "approve_plan" || action === "reject_plan") {
    // Approving lets the worker start on its plan. The outward steps it may
    // name stop at the worker's safety floor, and the acceptance criterion is
    // classified by the same floor when Standup runs it (floor/criterion.ts,
    // where the owner's HOLD_ACCEPTANCE_CRITERION applies too).
    return { rule: "act", reason: "plan of an owned worker" };
  }

  return { rule: "never", reason: `unknown action ${action}` };
}
