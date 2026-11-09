import type { Database } from "bun:sqlite";
import { MAX_CHECK_TIMEOUT_MS, type PlanApproval } from "@standup/shared";
import { getPlanApproval } from "@standup/store";
import { workerEnv } from "./worker-env.js";
import { DrainReleasedError, killGroupOnRelease, killProcessGroup, processDrain, sleepUnlessReleased } from "./drain.js";

const POLL_INTERVAL_MS = 500;

/**
 * Default cap on how long submit_plan blocks waiting for a human (24 hours).
 * The gate's whole purpose is to steer BEFORE autonomous work — including
 * unattended overnight runs whose approver is asleep — so a single blocking
 * poll must span that window rather than releasing after an hour and letting
 * the agent implement an un-approved plan. submit_plan has no timeout param, so
 * this default is the only lever; it matches the hard ceiling below.
 */
export const PLAN_APPROVAL_DEFAULT_TIMEOUT_S = 24 * 60 * 60;
/** Hard ceiling regardless of a caller-supplied timeout. */
export const PLAN_APPROVAL_MAX_TIMEOUT_S = 24 * 60 * 60;

/**
 * How long the acceptance-criterion command may run before it's killed when
 * neither the caller nor STANDUP_CRITERION_TIMEOUT_S says otherwise. Long
 * enough for a full test suite, short enough that mark_ready_for_review
 * answers before the MCP client's tool timeout (about 25 minutes).
 */
export const CRITERION_DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
/** How long a timed-out command has between SIGTERM and SIGKILL. */
export const CRITERION_KILL_GRACE_MS = 15_000;
/**
 * How long the command's output is still read once its shell has exited. A
 * descendant that escaped the process group can hold the pipes open forever,
 * so the result never waits on their end-of-file.
 */
export const CRITERION_STREAM_DRAIN_MS = 2000;
/** The most output a criterion or check result keeps. */
export const CRITERION_OUTPUT_MAX = 2000;
/** How often a timed-out command's process group is checked for what is left of it during the grace. */
const GROUP_POLL_MS = 50;

/** Whether any process of the group led by `pid` is still there. */
function groupAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/**
 * The criterion timeout: STANDUP_CRITERION_TIMEOUT_S (seconds, a positive
 * number) when set, else CRITERION_DEFAULT_TIMEOUT_MS, and never more than
 * MAX_CHECK_TIMEOUT_MS.
 */
export function criterionTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.STANDUP_CRITERION_TIMEOUT_S?.trim();
  const seconds = raw ? Number(raw) : NaN;
  const ms = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : CRITERION_DEFAULT_TIMEOUT_MS;
  return Math.min(ms, MAX_CHECK_TIMEOUT_MS);
}

/** A duration in seconds as a person reads it: 1200s, 0.3s. */
function formatSeconds(ms: number): string {
  return `${Number((ms / 1000).toFixed(1))}s`;
}

/**
 * Keeps the first CRITERION_OUTPUT_MAX characters written to it and at least
 * the last CRITERION_OUTPUT_MAX, so a command's output is held in bounded
 * memory however much it prints while clipOutput still sees both ends.
 */
class BoundedOutput {
  private head = "";
  private tail = "";

  push(chunk: string): void {
    if (!chunk) return;
    if (this.head.length < CRITERION_OUTPUT_MAX) {
      const take = chunk.slice(0, CRITERION_OUTPUT_MAX - this.head.length);
      this.head += take;
      chunk = chunk.slice(take.length);
    }
    if (!chunk) return;
    this.tail += chunk;
    if (this.tail.length > 2 * CRITERION_OUTPUT_MAX) this.tail = this.tail.slice(-CRITERION_OUTPUT_MAX);
  }

  text(): string {
    return (this.head + this.tail).trim();
  }
}

/** Reads `reader`'s stream into `out` until it ends, errors, or is cancelled. */
async function pump(
  reader: { read(): Promise<{ done: boolean; value?: Uint8Array }> },
  out: BoundedOutput
): Promise<void> {
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out.push(decoder.decode(value, { stream: true }));
    }
  } catch {
    // Cancelled or broken: what was read stands.
  }
  out.push(decoder.decode());
}

/**
 * `output` cut to CRITERION_OUTPUT_MAX: its start and its end, since a test
 * runner prints its failure summary last.
 */
export function clipOutput(output: string): string {
  if (output.length <= CRITERION_OUTPUT_MAX) return output;
  const marker = "\n…\n";
  const head = Math.floor((CRITERION_OUTPUT_MAX - marker.length) / 4);
  const tail = CRITERION_OUTPUT_MAX - marker.length - head;
  return output.slice(0, head) + marker + output.slice(-tail);
}

export type PlanResolution =
  | { status: "approved"; approval: PlanApproval }
  | { status: "rejected"; approval: PlanApproval }
  | { status: "timeout" };

/**
 * Long-polls a plan-approval row until a human resolves it (approved or
 * rejected) or the timeout elapses. Holds the submit_plan HTTP handler open —
 * the same blocking pattern waitForAskResolution gives ask_human — which is
 * what pauses the run at the gate without the agent polling. Returns the
 * resolved approval (carrying any human edits to the plan / acceptance
 * criterion) so submit_plan can hand the approved version back to the agent.
 * Throws DrainReleasedError when `drainSignal` aborts, unless the plan was
 * decided since the last poll, whose decision is returned instead. A plan
 * still awaiting review is left pending for the re-sent call to wait on.
 */
export async function waitForPlanApproval(
  db: Database,
  approvalId: string,
  timeoutSeconds = PLAN_APPROVAL_DEFAULT_TIMEOUT_S,
  drainSignal: AbortSignal = processDrain.signal
): Promise<PlanResolution> {
  const timeoutMs =
    Math.min(timeoutSeconds, PLAN_APPROVAL_MAX_TIMEOUT_S) * 1000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const settled = settledPlanResolution(db, approvalId);
    if (settled) return settled;
    try {
      await sleepUnlessReleased(POLL_INTERVAL_MS, drainSignal);
    } catch (err) {
      // A decision that landed since the last poll is delivered now rather
      // than making the caller re-attach just to collect it.
      if (err instanceof DrainReleasedError) {
        const late = settledPlanResolution(db, approvalId);
        if (late) return late;
      }
      throw err;
    }
  }

  return { status: "timeout" };
}

/** The plan's decision once it is approved or rejected (a vanished row reads as a timeout), else undefined. */
function settledPlanResolution(db: Database, approvalId: string): PlanResolution | undefined {
  const approval = getPlanApproval(db, approvalId);
  if (!approval) return { status: "timeout" };
  if (approval.status === "approved") return { status: "approved", approval };
  if (approval.status === "rejected") return { status: "rejected", approval };
  return undefined;
}

/**
 * Runs a plan's machine-checkable acceptance criterion — a shell command — in
 * the launch's worktree and reports whether it passed (exit 0). This is what
 * makes the criterion "machine-checkable": the collector verifies it rather
 * than trusting the agent's word, the same trust level as the project's setup
 * command (arbitrary code, the user's own config, run only on an explicit
 * action), but run without the owner and Persona credentials in its
 * environment (workerEnv, or the stricter `env` a caller passes: a plan's
 * criterion runs under scrubCredentialEnv, after the safety floor classified
 * it, see floor/criterion.ts). A blank criterion is treated as satisfied — there's nothing to
 * check, so the gate reduces to the plain plan-approval pause. The command runs
 * in its own process group, which a timeout kills whole: SIGTERM, then, once
 * the grace ends, SIGKILL to whatever of the group is left, the shell gone or
 * not. A timed-out run is not met and its output says so, naming SIGKILL only
 * when it was sent, with the last output it printed; a shell that exited
 * before the deadline never timed out. Whatever is left of the group when the
 * check returns (a server the criterion backgrounded) is killed. Output is
 * read as it arrives into a bounded buffer and stops being read shortly after
 * the shell exits, so a descendant that left the group still holding the
 * pipes cannot keep the result waiting. Throws only DrainReleasedError, when
 * `drainSignal` aborts (the collector is shutting down): the group is killed
 * and nothing is recorded, so the caller's retry runs the criterion again on
 * the next leader. Otherwise never throws: a spawn failure resolves to not-met
 * with the error text so the gate stays closed rather than crashing the
 * caller.
 */
export async function checkAcceptanceCriterion(
  cwd: string,
  criterion: string | undefined,
  timeoutMs: number = criterionTimeoutMs(),
  env: Record<string, string> = workerEnv(),
  drainSignal?: AbortSignal,
  { killGraceMs = CRITERION_KILL_GRACE_MS, streamDrainMs = CRITERION_STREAM_DRAIN_MS } = {}
): Promise<{ met: boolean; output: string }> {
  const command = criterion?.trim();
  if (!command) return { met: true, output: "" };
  if (drainSignal?.aborted) throw new DrainReleasedError();

  try {
    const proc = Bun.spawn(["/bin/sh", "-c", command], {
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env,
      detached: true,
    });
    const out = new BoundedOutput();
    const readers = [proc.stdout.getReader(), proc.stderr.getReader()];
    const reading = Promise.all(readers.map((reader) => pump(reader, out)));
    // A command past its time is asked to stop first, so one that cleans up on
    // SIGTERM (a suite tearing down its scratch servers) can, then killed.
    // A descendant ignoring SIGTERM outlives the shell, so once the grace
    // ends the group is killed whether or not the shell is still there.
    let timedOut = false;
    let killed = false;
    let killAt = 0;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const killGroup = () => {
      killed = true;
      killProcessGroup(proc.pid);
    };
    const timer = setTimeout(() => {
      // A shell that exited before the deadline ran in time, however long its output takes to drain.
      if (proc.exitCode !== null || proc.signalCode !== null) return;
      timedOut = true;
      killProcessGroup(proc.pid, "SIGTERM");
      killAt = Date.now() + killGraceMs;
      killTimer = setTimeout(killGroup, killGraceMs);
    }, timeoutMs);
    const stopListening = killGroupOnRelease(proc.pid, drainSignal);
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await proc.exited;
      if (!timedOut) clearTimeout(timer);
      await Promise.race([
        reading,
        new Promise<void>((resolve) => {
          drainTimer = setTimeout(resolve, streamDrainMs);
        }),
      ]);
      for (const reader of readers) reader.cancel().catch(() => {});
      // A pass that landed as the drain began stands; anything else may be the kill.
      if (drainSignal?.aborted && (timedOut || proc.exitCode !== 0)) throw new DrainReleasedError();
      const printed = out.text();
      if (timedOut) {
        // The shell is gone, but its group may not be: give what is left the
        // rest of the grace to stop on SIGTERM, then kill it.
        while (!killed && groupAlive(proc.pid) && Date.now() < killAt) {
          await new Promise((resolve) => setTimeout(resolve, Math.min(GROUP_POLL_MS, Math.max(1, killAt - Date.now()))));
        }
        if (killTimer) clearTimeout(killTimer);
        if (!killed && groupAlive(proc.pid)) killGroup();
        const ending =
          `timed out after ${formatSeconds(timeoutMs)} ` +
          `(SIGTERM${killed ? `, then SIGKILL after ${formatSeconds(killGraceMs)}` : ""})`;
        // Named at both ends, so a cut that keeps only the tail still says so.
        return { met: false, output: clipOutput(`${ending}; last output:\n${printed || "(no output)"}\n${ending}`) };
      }
      if (proc.exitCode === 0) return { met: true, output: clipOutput(printed) };
      const ending = proc.signalCode ? `killed by ${proc.signalCode}` : `exit code ${proc.exitCode}`;
      return { met: false, output: clipOutput(printed ? `${printed}\n${ending}` : ending) };
    } finally {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      // A run leaves nothing of its group behind, however it returns: a criterion that
      // backgrounds a server and exits 0 doesn't leave the server running.
      if (!killed && groupAlive(proc.pid)) killGroup();
      if (drainTimer) clearTimeout(drainTimer);
      stopListening();
    }
  } catch (err) {
    if (err instanceof DrainReleasedError) throw err;
    return { met: false, output: (err as Error).message };
  }
}
