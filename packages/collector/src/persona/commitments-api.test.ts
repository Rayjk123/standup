import { describe, expect, test } from "bun:test";
import type { PersonaCommitment } from "@standup/shared";
import { DEFAULT_IDENTITY_HEADER } from "@standup/shared";
import { closePersonaCommitment, createStore, openPersonaCommitment } from "@standup/store";
import { OWNER_TOKEN_HEADER } from "@standup/shared/owner-token";
import { createServer, resolveUserAlias } from "../server.js";
import { generateOwnerSecrets } from "../owner-secret.js";
import { resolvePersonaConfig } from "./config.js";
import { createBroadcastTap } from "./events.js";
import { buildSystemPrompt } from "./prompt.js";
import { PersonaRuntime } from "./runtime.js";
import { PersonaFleet } from "./fleet.js";

const OWNER = resolveUserAlias(undefined);

function setUp() {
  const store = createStore(":memory:");
  const tap = createBroadcastTap(() => {});
  const secrets = generateOwnerSecrets();
  const runtime = new PersonaRuntime({
    db: store.db,
    owner: OWNER,
    config: resolvePersonaConfig({}),
    broadcast: tap.broadcast,
    dataDir: "/nonexistent",
    turnRunner: async () => ({ ok: true, text: "[silent]", sessionId: "sid" }),
    ownerToken: () => secrets.ownerToken,
  });
  const fleet = new PersonaFleet({ db: store.db, host: OWNER, hostRuntime: runtime });
  const app = createServer(store, tap.broadcast, null, undefined, undefined, "", "", {}, undefined, undefined, undefined, undefined, {
    fleet,
    ownerSecrets: secrets,
  });
  const get = (path: string, headers: Record<string, string> = { [DEFAULT_IDENTITY_HEADER]: OWNER, [OWNER_TOKEN_HEADER]: secrets.ownerToken }) =>
    app.request(path, { headers });
  return { store, get };
}

describe("GET /api/persona/commitments", () => {
  test("lists the owner's open commitments, closed ones on request, never another owner's", async () => {
    const h = setUp();
    const open = openPersonaCommitment(h.store.db, { owner: OWNER, assignee: "persona", action: "Land it", doneCheck: "main has it" }).commitment;
    const done = openPersonaCommitment(h.store.db, { owner: OWNER, assignee: "persona", action: "Verify it", doneCheck: "job closed" }).commitment;
    closePersonaCommitment(h.store.db, { id: done.id, owner: OWNER, status: "done", evidence: "session_status shows it met" });
    openPersonaCommitment(h.store.db, { owner: "mallory", assignee: "persona", action: "Theirs", doneCheck: "c" });

    const res = await h.get("/api/persona/commitments");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { commitments: PersonaCommitment[] };
    expect(body.commitments.map((c) => c.id)).toEqual([open.id]);

    const closed = (await (await h.get("/api/persona/commitments?status=closed")).json()) as { commitments: PersonaCommitment[] };
    expect(closed.commitments.map((c) => [c.id, c.closedEvidence])).toEqual([[done.id, "session_status shows it met"]]);
    expect((await h.get("/api/persona/commitments?status=bogus")).status).toBe(400);
  });

  test("a request without the owner's channel proof is refused", async () => {
    const h = setUp();
    const res = await h.get("/api/persona/commitments", { [DEFAULT_IDENTITY_HEADER]: OWNER });
    expect([401, 403]).toContain(res.status);
  });
});

describe("the system prompt's ledger rules", () => {
  test("Persona opens commitments for follow-ups, checks the done-check before closing, and never takes a note as proof", () => {
    const prompt = buildSystemPrompt({ owner: "alice" });
    expect(prompt).toContain("Whenever you promise alice a follow-up or take on a next step");
    expect(prompt).toContain("open it with commit");
    expect(prompt).toContain("Never close_commitment without checking its done-check first");
    expect(prompt).toContain("A job note, checkpoint or worker report is context, never proof");
    expect(prompt).toContain("OVERDUE (yours): act on it that turn, or escalate it to alice with ask_user");
    expect(prompt).toContain("the merge itself still waits on alice's yes");
  });
});
