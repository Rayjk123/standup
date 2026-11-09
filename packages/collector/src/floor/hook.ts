/*
 * The safety floor's PreToolUse hook: `bun hook.ts <encoded FloorConfig>`,
 * with Claude Code's hook payload on stdin.
 *
 * Every tool call of a bypass-mode worker passes through here. An ordinary
 * call is classified locally (classify.ts) and allowed by printing nothing.
 * A floored call is POSTed to the collector as a hold (presenting the
 * launch's scoped worker token), and the hook waits for the decision; only an
 * explicit allow whose answer also reads as one (floorAnswerAllows) and whose
 * signature verifies against the collector's public key from the config
 * (verifyFloorReply, over this call's hash) lets the call run. Anything else
 * listening on the collector's port can only deny.
 *
 * Claude Code runs the tool when a hook exits non-zero (other than 2) or
 * times out, so every path here prints a decision and exits 0: a malformed
 * config, unreadable input, a classifier crash, an unreachable collector and
 * a decision that never arrives all deny. Process-level handlers turn any
 * stray exception into a deny too, and the command wrapper in gate.ts
 * (floorHookCommand) turns a hook that can't start into exit 2.
 */
import { randomUUID } from "crypto";
import { writeSync } from "fs";
import { DRAINING_HEADER, DRAINING_RELEASED } from "@standup/shared/topology";
import { classifyToolCall, subagentIsolationDenial } from "./classify.js";
import {
  FLOOR_HOLD_ROUTE,
  FLOOR_UNREACHABLE_GRACE_MS,
  FLOOR_WORKER_TOKEN_HEADER,
  OWNER_ONLY_CATEGORIES,
  floorAnswerAllows,
  floorCallHash,
  readFloorConfigArg,
  verifyFloorReply,
  type FloorCall,
  type FloorConfig,
  type FloorHold,
  type FloorHoldRequest,
  type FloorHoldResponse,
  type FloorVerdict,
} from "./gate.js";

const DEFAULT_UNREACHABLE_GRACE_MS = FLOOR_UNREACHABLE_GRACE_MS;
/** Env override of the unreachable grace (milliseconds); it can only be shortened. */
const UNREACHABLE_GRACE_ENV = "STANDUP_FLOOR_UNREACHABLE_GRACE_MS";
/**
 * Seconds past the configured wait the hook still waits for the collector's
 * own timeout reply: a tenth of the wait, between 2 and 30 seconds — well
 * under FLOOR_HOOK_TIMEOUT_MARGIN_S.
 */
function replyGraceSeconds(waitSeconds: number): number {
  return Math.min(30, Math.max(2, waitSeconds / 10));
}
/** How long the hook waits for its stdin payload. */
const STDIN_TIMEOUT_MS = 10_000;
/** A failed attempt that ran this long reached the collector (its long-poll broke off), so it doesn't count as unreachable time. */
const CONNECTED_ATTEMPT_MS = 5_000;
/** Pause before re-attaching after a second release in a row, so a collector that keeps releasing can't spin the hook. */
const REPEAT_RELEASE_PAUSE_MS = 100;

const NOTHING_RAN = "Nothing ran.";

/** A hold no decision arrived for before its wait ran out (the owner may be offline): nothing ran, and the same call asks anew. */
const EXPIRED =
  `The hold expired: no decision arrived in time (the owner may be offline), so it was denied. ${NOTHING_RAN} ` +
  "Retry the same call later and it will be asked again, or use ask_human to ask the owner first.";

let emitted = false;

/**
 * Prints the hook's decision once; later calls are ignored. A decision that
 * can't be written exits 2, since no output would read as "proceed".
 */
function emit(decision: "allow" | "deny", reason: string): void {
  if (emitted) return;
  emitted = true;
  const out = JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: reason },
  });
  try {
    writeSync(1, `${out}\n`);
  } catch {
    try {
      writeSync(2, `${reason}\n`);
    } catch {
      // Nothing can be written; the exit status alone blocks the call.
    }
    process.exit(2);
  }
}

function deny(reason: string): void {
  emit("deny", reason);
}

/** A last-resort deny for an exception nothing else caught; exit 0 so Claude Code reads it. */
function crashDeny(err: unknown): void {
  try {
    deny(`Standup's safety floor hit an internal error (${err instanceof Error ? err.message : String(err)}), so this call was blocked (fail closed). ${NOTHING_RAN}`);
    process.exit(0);
  } catch {
    try {
      writeSync(2, "Standup safety floor: internal error; the call was blocked.\n");
    } catch {
      // stderr is gone too; exit 2 still blocks the call.
    }
    process.exit(2);
  }
}

process.on("uncaughtException", crashDeny);
process.on("unhandledRejection", crashDeny);

interface HookPayload {
  session_id?: unknown;
  transcript_path?: unknown;
  cwd?: unknown;
  hook_event_name?: unknown;
  tool_name?: unknown;
  tool_input?: unknown;
  tool_use_id?: unknown;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

async function readStdin(): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timed out reading the hook payload")), STDIN_TIMEOUT_MS);
  });
  try {
    return await Promise.race([Bun.stdin.text(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function unreachableGrace(): number {
  const raw = Number(process.env[UNREACHABLE_GRACE_ENV]);
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, DEFAULT_UNREACHABLE_GRACE_MS) : DEFAULT_UNREACHABLE_GRACE_MS;
}

/**
 * The id this hook's retries re-attach under: the call's tool_use_id, else a
 * random one. Never derived from the call itself, so a later identical call
 * can't pick up an earlier call's answer.
 */
function requestIdOf(payload: HookPayload): string {
  if (typeof payload.tool_use_id === "string" && payload.tool_use_id.trim()) return payload.tool_use_id.trim();
  return `floor-${randomUUID()}`;
}

type Outcome =
  | { kind: "decided"; response: FloorHoldResponse }
  | { kind: "refused"; status: number; error: string }
  | { kind: "unreachable"; error: string; waitedMs: number }
  | { kind: "timeout" }
  | { kind: "unreadable"; error: string };

/** A failed attempt; `answered` when the collector sent an HTTP response, so it was reachable. */
class Retryable extends Error {
  constructor(
    message: string,
    readonly answered = false
  ) {
    super(message);
  }
}

/** A draining collector let go of the held wait; the hold stays pending for the next leader to re-attach. */
class Released extends Error {}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));

/**
 * POSTs the hold and waits for the decision. Connection failures and 5xx
 * replies are retried with backoff under the same request id (the collector
 * re-attaches to the ask it already holds); the hook gives up once the
 * collector has been unreachable for the grace period, or at its deadline.
 * Only time without any answer from the collector counts as unreachable: an
 * HTTP response, or a long-poll that ran past CONNECTED_ATTEMPT_MS, restarts
 * that clock. A 503 marked as a drain release re-attaches at once, without
 * backoff.
 */
async function route(config: FloorConfig, request: FloorHoldRequest, deadline: number): Promise<Outcome> {
  const url = `${config.collectorUrl.replace(/\/+$/, "")}${FLOOR_HOLD_ROUTE}`;
  const grace = unreachableGrace();
  let failingSince: number | null = null;
  let attempt = 0;
  let releasesInARow = 0;
  for (;;) {
    const now = Date.now();
    if (now >= deadline) return { kind: "timeout" };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deadline - now);
    const attemptStart = now;
    try {
      const init: RequestInit & { timeout: false } = {
        method: "POST",
        headers: { "content-type": "application/json", [FLOOR_WORKER_TOKEN_HEADER]: config.workerToken },
        body: JSON.stringify(request),
        signal: controller.signal,
        timeout: false,
      };
      const res = await fetch(url, init);
      const text = await res.text();
      if (res.status === 503 && res.headers.get(DRAINING_HEADER) === DRAINING_RELEASED) throw new Released("the collector released the hold while draining");
      if (res.status >= 500) throw new Retryable(`the collector answered ${res.status}`, true);
      if (res.status >= 400) {
        let error = text.trim();
        try {
          const parsed = JSON.parse(text) as { error?: unknown };
          if (typeof parsed.error === "string") error = parsed.error;
        } catch {
          // A non-JSON error body is shown as is.
        }
        return { kind: "refused", status: res.status, error: error.slice(0, 500) || `status ${res.status}` };
      }
      try {
        const parsed = JSON.parse(text) as Partial<FloorHoldResponse>;
        if (parsed.decision !== "allow" && parsed.decision !== "deny") return { kind: "unreadable", error: "no decision in the reply" };
        return {
          kind: "decided",
          response: {
            decision: parsed.decision,
            askId: typeof parsed.askId === "string" ? parsed.askId : "",
            answer: typeof parsed.answer === "string" ? parsed.answer : "",
            ...(parsed.timed_out === true ? { timed_out: true } : {}),
            ...(typeof parsed.signature === "string" ? { signature: parsed.signature } : {}),
            ...(typeof parsed.reason === "string" ? { reason: parsed.reason.slice(0, 500) } : {}),
          },
        };
      } catch {
        return { kind: "unreadable", error: "the reply was not JSON" };
      }
    } catch (err) {
      if (controller.signal.aborted) return { kind: "timeout" };
      const end = Date.now();
      if (err instanceof Released) {
        failingSince = null;
        attempt = 0;
        releasesInARow++;
        if (releasesInARow > 1) await sleep(Math.min(REPEAT_RELEASE_PAUSE_MS, deadline - end));
        continue;
      }
      releasesInARow = 0;
      const error = err instanceof Error ? err.message : String(err);
      if ((err instanceof Retryable && err.answered) || end - attemptStart >= CONNECTED_ATTEMPT_MS) failingSince = end;
      failingSince ??= attemptStart;
      if (end - failingSince >= grace) return { kind: "unreachable", error, waitedMs: end - failingSince };
      attempt++;
      const backoff = Math.min(250 * 2 ** (attempt - 1), 3_000);
      await sleep(Math.min(backoff, deadline - end, grace - (end - failingSince)));
    } finally {
      clearTimeout(timer);
    }
  }
}

function heldText(hold: FloorHold): string {
  return `Standup's safety floor held this ${hold.category} call: ${hold.reason}`;
}

async function main(): Promise<void> {
  const started = Date.now();
  let config: FloorConfig;
  try {
    config = readFloorConfigArg(process.argv[2] ?? "");
  } catch {
    return deny(`Standup's safety floor could not read its configuration, so this call was blocked (fail closed). ${NOTHING_RAN}`);
  }

  let payload: HookPayload;
  try {
    const parsed = JSON.parse(await readStdin()) as unknown;
    if (!isRecord(parsed) || typeof parsed.tool_name !== "string" || !parsed.tool_name) throw new Error("no tool_name");
    payload = parsed;
  } catch {
    return deny(`Standup's safety floor could not read this tool call, so it was blocked (fail closed). ${NOTHING_RAN}`);
  }

  const call: FloorCall = {
    toolName: payload.tool_name as string,
    toolInput: isRecord(payload.tool_input) ? payload.tool_input : {},
    // The hook runs from the floor dir, so a call without a cwd is placed at the launch's root.
    cwd: typeof payload.cwd === "string" && payload.cwd ? payload.cwd : config.root,
    ...(typeof payload.session_id === "string" && payload.session_id ? { sessionId: payload.session_id } : {}),
  };

  // A call the floor refuses outright: no hold is raised, since no answer
  // would make it safe to run. Claude Code names the session's project dir in
  // the hook's environment, which stays put when the worker changes directory.
  const projectDir = process.env.CLAUDE_PROJECT_DIR;
  const refusal = subagentIsolationDenial(call, config, {}, projectDir ? [projectDir] : []);
  if (refusal) return deny(`Standup's safety floor denied this call: ${refusal} ${NOTHING_RAN}`);

  let verdict: FloorVerdict;
  try {
    verdict = classifyToolCall(call, config);
  } catch (err) {
    verdict = {
      action: "hold",
      category: "unclassified",
      ownerOnly: OWNER_ONLY_CATEGORIES.has("unclassified"),
      reason: `the floor failed to classify this call (${err instanceof Error ? err.message : String(err)})`,
      step: call.toolName,
    };
  }
  if (verdict.action === "allow") return;

  const hold: FloorHold = {
    category: verdict.category,
    ownerOnly: verdict.ownerOnly,
    reason: verdict.reason,
    step: verdict.step,
    ...(verdict.ownerReserved ? { ownerReserved: true } : {}),
  };
  const request: FloorHoldRequest = {
    session_id: typeof payload.session_id === "string" ? payload.session_id : "",
    cwd: call.cwd,
    launch_id: config.launchId,
    request_id: requestIdOf(payload),
    tool_name: call.toolName,
    tool_input: call.toolInput,
    hold,
    wait_s: config.waitSeconds,
  };
  const deadline = started + (config.waitSeconds + replyGraceSeconds(config.waitSeconds)) * 1000;
  const outcome = await route(config, request, deadline);

  switch (outcome.kind) {
    case "decided": {
      const { response } = outcome;
      const signed = verifyFloorReply(
        config.replyPublicKey,
        { requestId: request.request_id, askId: response.askId, decision: response.decision, answer: response.answer, callHash: floorCallHash(call) },
        response.signature
      );
      if (response.decision === "allow" && !signed) {
        return deny(`${heldText(hold)}. The reply allowing it was not signed by Standup's collector, so it was denied. ${NOTHING_RAN}`);
      }
      if (response.decision === "allow" && floorAnswerAllows(response.answer)) {
        return emit("allow", `${heldText(hold)}. Persona or the owner allowed it once (ask ${response.askId || "?"}, answer "${response.answer}").`);
      }
      if (response.timed_out) return deny(`${heldText(hold)}. ${EXPIRED}`);
      if (response.reason) {
        return deny(`${heldText(hold)}. It was denied (ask ${response.askId || "?"}: ${response.reason}). ${NOTHING_RAN}`);
      }
      const answer = response.answer ? `"${response.answer}"` : "no allow";
      return deny(`${heldText(hold)}. It was denied (ask ${response.askId || "?"}, answer ${answer}). ${NOTHING_RAN}`);
    }
    case "refused":
      return deny(`${heldText(hold)}. The collector refused the hold (${outcome.status}: ${outcome.error}), so it was denied. ${NOTHING_RAN}`);
    case "unreadable":
      return deny(`${heldText(hold)}. The collector's reply could not be read (${outcome.error}), so it was denied. ${NOTHING_RAN}`);
    case "unreachable":
      return deny(
        `${heldText(hold)}. The collector could not be reached to ask (${outcome.error}) for ${Math.round(outcome.waitedMs / 1000)}s, so it was denied (fail closed). ${NOTHING_RAN} ` +
          "This is usually transient (the collector restarting): retry the same call in a minute and it will be asked again."
      );
    case "timeout":
      return deny(`${heldText(hold)}. ${EXPIRED}`);
  }
}

main().then(
  () => process.exit(0),
  (err) => crashDeny(err)
);
