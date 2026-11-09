import { expect, test } from "bun:test";
import { JOBS_HEADING, buildTurnPrompt, sanitizeUntrusted, shortId } from "./prompt.js";
import type { SnapshotJob, TurnSnapshot } from "./prompt.js";

/**
 * A long day: two open jobs with a few ended sessions each, and ten jobs
 * closed earlier, two of them within the last hour.
 */
const CHECKPOINT =
  "built the change, ran the typecheck and the collector tests, all green; now writing the commit message and checking the diff for stray debug output and leftovers";
const OUTCOME =
  "merged into the integration branch after typecheck and tests passed; the owner approved the restart and the health check came back clean, with no rollbacks and nothing left open on this job.";
const NOTE =
  "Waiting on the worker to finish the test run; the owner asked to be told when it's green before anything else. Re-check in 20 minutes if no event arrives.";
const AT = "2026-10-05T15:00:00.000Z";

type Session = SnapshotJob["sessions"][number];
const session = (id: string, status: string): Session => ({
  id: `${id}-0000-1111-2222-333333333333`,
  projectId: "standup",
  status,
  lastCheckpoint: { at: AT, summary: `${id}: ${CHECKPOINT}`.slice(0, 160) },
  pendingAsks: 0,
});
const endedSessions = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => session(`${prefix}e${i}`, "ended"));

const OPEN = [
  { id: "a1a1a1a1-0000-1111-2222-333333333333", title: "Trim persona turn snapshot", status: "active", live: session("a1r", "running"), ended: 3 },
  { id: "b2b2b2b2-0000-1111-2222-333333333333", title: "Merge duplicate tag suggestions", status: "waiting_user", live: session("b2i", "idle"), ended: 2 },
];
const CLOSED: SnapshotJob[] = Array.from({ length: 10 }, (_, i) => ({
  id: `c${i}c${i}c${i}c${i}-0000-1111-2222-333333333333`,
  title: `Closed job number ${i} with a typical title`,
  status: i === 9 ? "failed" : "done",
  unboundLaunches: 0,
  note: NOTE,
  outcome: `job ${i}: ${OUTCOME}`,
  sessions: endedSessions(`c${i}`, 3),
}));
const BUDGET = { activeLaunches: 2, maxActiveLaunches: 3 };

/** The snapshot line format before closed jobs and ended sessions were compacted: every job, every session in full. */
function previousFormatJob(job: SnapshotJob): string {
  const sessions = job.sessions.map((s) => {
    const id = sanitizeUntrusted(s.id, 80);
    const parts = [`${shortId(id)} (${id}) [${sanitizeUntrusted(s.projectId ?? "", 80)}] ${sanitizeUntrusted(s.status ?? "unknown", 40)}`];
    if (s.lastCheckpoint) parts.push(`${new Date(s.lastCheckpoint.at).toISOString().slice(11, 16)} "${sanitizeUntrusted(s.lastCheckpoint.summary, 160)}"`);
    return parts.join(" · ");
  });
  const body = sessions.length > 0 ? sessions.join("; ") : "no sessions";
  const note = job.note ? ` — note: "${sanitizeUntrusted(job.note, 300)}"` : "";
  const outcome = job.outcome ? ` — outcome: "${sanitizeUntrusted(job.outcome, 200)}"` : "";
  const id = sanitizeUntrusted(job.id, 80);
  return `- ${shortId(id)} (${id}) "${sanitizeUntrusted(job.title, 120)}" (${job.status}) — ${body}${note}${outcome}`;
}

function jobsSection(prompt: string): string {
  return prompt.split(`${JOBS_HEADING}\n\`\`\`text\n`)[1]!.split("\n```")[0]!;
}

test("a long day's job snapshot is several times smaller than the previous full listing", () => {
  const before = [
    ...OPEN.map((j) =>
      previousFormatJob({ id: j.id, title: j.title, status: j.status, unboundLaunches: 0, note: NOTE, sessions: [...endedSessions(j.id.slice(0, 2), j.ended), j.live].slice(-4) })
    ),
    ...CLOSED.map(previousFormatJob),
  ].join("\n");
  const snapshot: TurnSnapshot = {
    ...BUDGET,
    olderClosedJobs: 8,
    jobs: [
      ...OPEN.map((j) => ({ id: j.id, title: j.title, status: j.status, unboundLaunches: 0, note: NOTE, endedSessions: j.ended, sessions: [j.live] })),
      ...CLOSED.slice(0, 2).map((j) => ({ ...j, note: undefined, sessions: [] })),
    ],
  };
  const after = jobsSection(buildTurnPrompt({ owner: "alice", now: new Date("2026-10-05T15:30:00.000Z"), items: [], snapshot }));
  console.log(`job snapshot: before ${before.length} chars, after ${after.length} chars`);
  expect(after.split("\n")).toHaveLength(5);
  expect(after).toContain("- +8 closed jobs today (list_jobs for details)");
  expect(after.length).toBeLessThan(before.length / 5);
});
