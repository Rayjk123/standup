import { describe, expect, test } from "bun:test";
import { DEFAULT_IDENTITY_HEADER } from "@standup/shared";
import { OWNER_TOKEN_HEADER } from "@standup/shared/owner-token";
import {
  attachSessionToLaunch,
  createLaunch,
  createPersonaJob,
  createReviewPacket,
  createSession,
  createStore,
  linkPersonaJobLaunch,
  listPersonaCommitments,
  submitReviewPacket,
  upsertProject,
} from "@standup/store";
import { createServer, resolveUserAlias } from "../server.js";
import { generateOwnerSecrets } from "../owner-secret.js";
import { PERSONA_STALE_MS } from "./commitments.js";
import { resolvePersonaConfig } from "./config.js";
import { createBroadcastTap } from "./events.js";
import { PersonaFleet } from "./fleet.js";
import { COMMITMENTS_HEADING } from "./prompt.js";
import { PERSONA_TOKEN_HEADER } from "./routes.js";
import { PersonaRuntime } from "./runtime.js";
import type { TurnInput } from "./turn.js";

const OWNER = resolveUserAlias(undefined);

/**
 * The whole loop through the collector's own routes, on a scratch store: the
 * owner approves a review in the Review tab, Persona's next turn lists the
 * landing commitment first, it goes OVERDUE past its stale time and the tick
 * wakes Persona, and closing it with evidence takes it off the next turn.
 */
describe("commitments end to end", () => {
  test("approve → listed first → OVERDUE (yours) → closed with evidence → gone", async () => {
    const store = createStore(":memory:");
    const tap = createBroadcastTap(() => {});
    const secrets = generateOwnerSecrets();
    let nowMs = Date.parse("2026-10-10T12:00:00.000Z");
    const prompts: string[] = [];
    const runtime = new PersonaRuntime({
      db: store.db,
      owner: OWNER,
      config: { ...resolvePersonaConfig({}), coalesceMs: 0 },
      broadcast: tap.broadcast,
      dataDir: "/nonexistent",
      turnRunner: async (input: TurnInput) => {
        prompts.push(input.prompt);
        return { ok: true, text: "[silent]", sessionId: "sid-1" };
      },
      ownerToken: () => secrets.ownerToken,
      now: () => new Date(nowMs),
    });
    tap.subscribe(runtime.eventListener());
    const fleet = new PersonaFleet({ db: store.db, host: OWNER, hostRuntime: runtime });
    const app = createServer(store, tap.broadcast, null, undefined, undefined, "", "", {}, undefined, undefined, undefined, undefined, {
      fleet,
      ownerSecrets: secrets,
    });
    runtime.bindApp(app);
    const asOwner = { [DEFAULT_IDENTITY_HEADER]: OWNER, [OWNER_TOKEN_HEADER]: secrets.ownerToken, "content-type": "application/json" };

    upsertProject(store.db, { id: "p", name: "P", branch: "main", repos: [] });
    createLaunch(store.db, { id: "launch-1", projectId: "p", task: "t", worktreePath: "/nonexistent/w", branch: "b", status: "running", requester: OWNER, launchedBy: OWNER });
    createSession(store.db, { id: "session-1", projectId: "p", title: "t", cwd: "/nonexistent/w", status: "idle" });
    attachSessionToLaunch(store.db, "launch-1", "session-1");
    const job = createPersonaJob(store.db, { owner: OWNER, threadId: runtime.consoleThreadId(), title: "Commitments ledger", goal: "g" });
    linkPersonaJobLaunch(store.db, job.id, "launch-1");
    const packet = createReviewPacket(store.db, { owner: OWNER, projectId: "p", launchId: "launch-1", jobId: job.id });
    submitReviewPacket(store.db, {
      id: packet.id,
      owner: OWNER,
      draft: {
        title: "Persona commitments ledger",
        intent: "Persona keeps a ledger.",
        changes: [{ area: "Ledger", bullets: ["b"] }],
        validation: { samples: [], tests: { summary: "ok" } },
        risks: { risks: [], questions: [] },
        links: [],
      },
    });

    // 1. The owner approves; the next turn lists the landing commitment at the top.
    const approved = await app.request(`/api/reviews/${packet.id}/approve`, { method: "POST", headers: asOwner, body: "{}" });
    expect(approved.status).toBe(200);
    await runtime.drain();
    const first = prompts[prompts.length - 1]!;
    expect(first.indexOf(COMMITMENTS_HEADING)).toBeLessThan(first.indexOf("# New since your last turn"));
    expect(first).toContain(`"Approved review /review/${packet.id}`);
    expect(first).not.toContain("OVERDUE");

    // 2. Past its stale time the tick wakes Persona and the turn shows it OVERDUE.
    nowMs += PERSONA_STALE_MS + 60_000;
    const turns = prompts.length;
    await runtime.tick();
    expect(prompts.length).toBe(turns + 1);
    const overdue = prompts[prompts.length - 1]!;
    expect(overdue).toContain("- OVERDUE (yours) · 11m old, due 1m ago — act on it now or escalate it: ");
    expect(overdue).toContain("commitment you owe went overdue");

    // 3. Persona closes it with evidence through its tool route; the next turn has no commitments section.
    const [open] = listPersonaCommitments(store.db, OWNER);
    const closed = await app.request("/api/persona/tool", {
      method: "POST",
      headers: { "content-type": "application/json", [PERSONA_TOKEN_HEADER]: runtime.token },
      body: JSON.stringify({ name: "close_commitment", arguments: { id: open!.id, evidence: "git log of install main contains the packet's commit 1a2b3c4" } }),
    });
    expect(((await closed.json()) as { isError?: boolean }).isError).toBeFalsy();
    runtime.receiveUserMessage({ text: "status?", actor: OWNER });
    await runtime.drain();
    expect(prompts[prompts.length - 1]).not.toContain(COMMITMENTS_HEADING);

    const listed = await app.request("/api/persona/commitments?status=closed", { headers: asOwner });
    const body = (await listed.json()) as { commitments: Array<{ status: string; closedEvidence: string }> };
    expect(body.commitments.map((c) => [c.status, c.closedEvidence])).toEqual([
      ["done", "git log of install main contains the packet's commit 1a2b3c4"],
    ]);
  });
});
