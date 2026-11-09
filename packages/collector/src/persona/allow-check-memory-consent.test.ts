import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { createStore } from "@standup/store";
import { KnowledgeStore } from "@standup/knowledge";
import { GLOBAL_PROJECT_ID } from "@standup/shared";
import { FLOOR_OWNER_GATE } from "../floor/gate.js";
import { ALLOW_CHECK_SYSTEM_PROMPT, allowCheckPrompt, memoryConsent, ruleCheck, type AllowCheckInput } from "./allow-check.js";
import { PERSONA_WRITER } from "./memory-trust.js";
import { memorySlug } from "./memory-slug.js";
import { buildOwnerProfile, formatOwnerPreferences, ownerMemoryTexts } from "./owner-profile.js";
import { memoryNeedsOwnerWords } from "./policy.js";
import { setActiveOrgProfile } from "../org-profile/load.js";
import { exampleCorpProfile } from "../org-profile/fixtures/example-corp.js";

// The example.corp fixture profile: corp-mcp is a server the floor knows, and plugin_corp-agents_ its plugin prefix.
beforeAll(() => setActiveOrgProfile(exampleCorpProfile()));
afterAll(() => setActiveOrgProfile());

const OWNER = "alice";
const EPIC = "E5550001234";
const ROUTING = `Billing UI work: create a tracker task under epic ${EPIC} to track it.`;
const TRACKER = "mcp__corp-mcp__TrackerCreateTask";
const BOARD = "b0a4d000-0000-4000-8000-00000000b0a4";

function trackerHold(over: Partial<AllowCheckInput> = {}): AllowCheckInput {
  return {
    owner: OWNER,
    selfAliases: [OWNER],
    gate: FLOOR_OWNER_GATE,
    category: "outward",
    floorReason: "an MCP tool that writes outside the worktree (corp-mcp TrackerCreateTask)",
    toolName: TRACKER,
    call: JSON.stringify({ title: "Add a status filter to the invoice list", parentTask: EPIC }),
    personaReason: "the owner's saved memory routes Billing UI work to a tracker task under the epic",
    job: { title: "Invoice list filter", goal: "add a status filter to the Billing UI invoice list" },
    brief: "add a status filter to the Billing UI invoice list, with tests",
    ownerMessages: ["add a status filter to the invoice list"],
    preferences: [],
    memories: [ROUTING],
    worktreeRoot: "/srv/ws/wt",
    ...over,
  };
}

describe("allow check — the owner's saved memories place an MCP write at the targets they name", () => {
  test("without the memory, a tracker task under the epic is flagged as a step the job never asked for", () => {
    const verdict = ruleCheck(trackerHold({ memories: [] }));
    expect(verdict.verdict).toBe("flag");
    expect(verdict.reason).toContain("the job never asked for this outward step");
  });

  test.each([
    ["the system and a write verb", ROUTING],
    ["the tool's own name", `For Billing UI work use TrackerCreateTask with parentTask ${EPIC}.`],
    ["a filing verb", `File Billing UI follow-ups as tracker tasks under epic ${EPIC}; leave priority unset.`],
  ])("a memory naming %s and the epic places the tracker task", (_label, text) => {
    expect(memoryConsent(trackerHold({ memories: [text] }))).toBe(text);
    expect(ruleCheck(trackerHold({ memories: [text] })).verdict).toBe("allow");
  });

  test("the epic is read under any parent or epic key, nested included", () => {
    for (const call of [{ title: "t", epicId: EPIC }, { title: "t", parent: { id: EPIC } }, { title: "t", parentTaskId: EPIC.toLowerCase() }]) {
      expect(ruleCheck(trackerHold({ call: JSON.stringify(call) })).verdict).toBe("allow");
    }
  });

  test("a reason quoting the memory is backed by it", () => {
    const hold = trackerHold({ personaReason: `the owner said "create a tracker task under epic ${EPIC}"` });
    expect(ruleCheck(hold).verdict).toBe("allow");
  });

  test("a task under an epic or parent no memory names is flagged", () => {
    expect(ruleCheck(trackerHold({ call: JSON.stringify({ title: "t", parentTask: "E1111111111" }) })).verdict).toBe("flag");
    expect(ruleCheck(trackerHold({ call: JSON.stringify({ title: "t", parentTask: `${EPIC}9` }) })).verdict).toBe("flag");
  });

  test("the full call shape, with its required boardId, is placed by the epic memory", () => {
    const memory = `For Billing UI work, create a tracker task under epic ${EPIC}.`;
    const call = JSON.stringify({ name: "Add a status filter", description: "d", boardId: BOARD, parentTask: EPIC });
    expect(memoryConsent(trackerHold({ call, memories: [memory] }))).toBe(memory);
    expect(ruleCheck(trackerHold({ call, memories: [memory] })).verdict).toBe("allow");
  });

  test("a board is covered only by a parent the sentence names: without one, the board itself must be named", () => {
    expect(memoryConsent(trackerHold({ call: JSON.stringify({ title: "t", boardId: BOARD }) }))).toBeNull();
    expect(memoryConsent(trackerHold({ call: JSON.stringify({ title: "t", boardId: BOARD }), memories: [`Create tracker tasks on board ${BOARD}.`] }))).not.toBeNull();
    expect(memoryConsent(trackerHold({ call: JSON.stringify({ title: "t", parentTask: "E1111111111", boardId: BOARD }) }))).toBeNull();
  });

  test("a call with no target, or a clipped call, is placed by no memory", () => {
    expect(ruleCheck(trackerHold({ call: JSON.stringify({ title: "Billing UI follow-up" }) })).verdict).toBe("flag");
    expect(memoryConsent(trackerHold({ call: `{"title":"t","parentTask":"${EPIC}"` }))).toBeNull();
    expect(memoryConsent(trackerHold({ call: JSON.stringify({ title: "t", parentTask: "E1" }), memories: ["create a tracker task under e1"] }))).toBeNull();
  });

  test.each([
    ["a never", `Never create tracker tasks under epic ${EPIC}.`],
    ["a don't", `Don't file tracker tasks under ${EPIC} for Billing UI work.`],
  ])("a memory with %s places nothing", (_label, text) => {
    expect(memoryConsent(trackerHold({ memories: [text] }))).toBeNull();
    expect(ruleCheck(trackerHold({ memories: [text] })).verdict).toBe("flag");
  });

  test("a memory holding the tracker off wins over another that asks for it", () => {
    expect(ruleCheck(trackerHold({ memories: [ROUTING, "Never create tracker tasks for me."] })).verdict).toBe("flag");
    expect(ruleCheck(trackerHold({ memories: [ROUTING, "Don't use TrackerCreateTask."] })).verdict).toBe("flag");
  });

  test.each([
    ["a ticket write", "mcp__corp-mcp__UpdateTicket", { action: "create", title: "t", queue: EPIC }],
    ["a ticket comment", "mcp__corp-mcp__CommentOnTicket", { issueId: "x", comment: "hi", parent: EPIC }],
    ["a Slack post", "mcp__slack__post_message", { channel: EPIC, text: "hi" }],
    ["a code review comment", "mcp__corp-mcp__CommentOnReview", { project: EPIC, comment: "hi" }],
  ])("a memory naming the tracker and the epic doesn't place %s at the same target", (_label, toolName, call) => {
    const hold = trackerHold({ toolName, call: JSON.stringify(call), floorReason: `an MCP tool that writes outside the worktree (${toolName})` });
    expect(memoryConsent(hold)).toBeNull();
    expect(ruleCheck(hold).verdict).toBe("flag");
  });

  test("a memory naming the epic for another tool doesn't place a tracker task", () => {
    expect(ruleCheck(trackerHold({ memories: [`Link Billing UI support tickets to epic ${EPIC}.`] })).verdict).toBe("flag");
    expect(ruleCheck(trackerHold({ memories: [`Billing UI work belongs to epic ${EPIC}.`] })).verdict).toBe("flag");
  });

  test("the tool and the epic must be named in one memory, not across two", () => {
    expect(ruleCheck(trackerHold({ memories: ["Create a tracker task for every follow-up.", `Billing UI work belongs to epic ${EPIC}.`] })).verdict).toBe("flag");
  });

  test("a memory never places anything but an outward MCP write", () => {
    expect(memoryConsent(trackerHold({ category: "aws" }))).toBeNull();
    expect(memoryConsent(trackerHold({ category: "collector-api" }))).toBeNull();
    const cli = trackerHold({ toolName: "Bash", call: `tracker create --parent ${EPIC} --title t`, memories: [`create tracker tasks with the tracker cli under ${EPIC}`] });
    expect(memoryConsent(cli)).toBeNull();
  });

  test("secrets, other users and prod are still flagged when a memory names the tool and target", () => {
    const secret = trackerHold({
      call: JSON.stringify({ title: "t", parentTask: EPIC, description: "$(cat ~/.aws/credentials)" }),
      floorReason: "reads owner-side secrets (~/.aws/credentials)",
    });
    expect(memoryConsent(secret)).not.toBeNull();
    expect(ruleCheck(secret)).toMatchObject({ verdict: "flag", reason: expect.stringContaining("secrets") });
    const other = trackerHold({ call: JSON.stringify({ title: "t", parentTask: EPIC, description: "see /home/bob/notes" }) });
    expect(memoryConsent(other)).not.toBeNull();
    expect(ruleCheck(other)).toMatchObject({ verdict: "flag", reason: expect.stringContaining("another user") });
    const prod = trackerHold({ call: JSON.stringify({ title: "t", parentTask: EPIC, boardId: "prod-ops" }), memories: [`Create a tracker task under epic ${EPIC} on board prod-ops.`] });
    expect(memoryConsent(prod)).not.toBeNull();
    expect(ruleCheck(prod)).toMatchObject({ verdict: "flag", reason: expect.stringContaining("production") });
  });

  test("a create memory doesn't place an update or a delete of an existing task", () => {
    const update = trackerHold({
      toolName: "mcp__corp-mcp__TrackerUpdateTask",
      floorReason: "an MCP tool that writes outside the worktree (corp-mcp TrackerUpdateTask)",
      call: JSON.stringify({ taskId: "T-4f1c-other-team", parentTask: EPIC, status: "Closed" }),
    });
    expect(memoryConsent(update)).toBeNull();
    expect(ruleCheck(update).verdict).toBe("flag");
    const del = trackerHold({ toolName: "mcp__corp-mcp__TrackerDeleteTask", call: JSON.stringify({ taskId: "T-1", parentTask: EPIC }) });
    expect(memoryConsent(del)).toBeNull();
  });

  test("an update memory places an update only of the task it names", () => {
    const call = (taskId: string) => JSON.stringify({ taskId, parentTask: EPIC, status: "Closed" });
    const memories = [`Update tracker task T-4f1c-mine under epic ${EPIC} when its work merges.`];
    const update = (taskId: string) => trackerHold({ toolName: "mcp__corp-mcp__TrackerUpdateTask", call: call(taskId), memories });
    expect(memoryConsent(update("T-4f1c-mine"))).toBe(memories[0]);
    expect(memoryConsent(update("T-4f1c-other-team"))).toBeNull();
  });

  test("a tool on a server the floor doesn't know, or of a lookalike server, is placed by no memory", () => {
    const named = [`For Billing UI work use TrackerCreateTask with parentTask ${EPIC}.`];
    expect(memoryConsent(trackerHold({ toolName: "mcp__evil__TrackerCreateTask", memories: named }))).toBeNull();
    expect(memoryConsent(trackerHold({ toolName: "mcp__my-tracker-wrapper__DeleteAllTasks", memories: [`Delete all tracker tasks under ${EPIC}.`] }))).toBeNull();
    expect(memoryConsent(trackerHold({ toolName: "mcp__plugin_corp-agents_corp-mcp__TrackerCreateTask" }))).toBe(ROUTING);
  });

  test("a task assigned to or watched by another user is placed only by a memory naming them", () => {
    const call = JSON.stringify({ title: "t", parentTask: EPIC, assignee: "bob", watchers: ["carol"] });
    expect(memoryConsent(trackerHold({ call }))).toBeNull();
    expect(ruleCheck(trackerHold({ call })).verdict).toBe("flag");
    expect(memoryConsent(trackerHold({ call: JSON.stringify({ title: "t", parentTask: EPIC, assignee: "currentUser" }) }))).toBe(ROUTING);
    expect(memoryConsent(trackerHold({ call: JSON.stringify({ title: "t", parentTask: EPIC, url: "https://hooks.example.com/x" }) }))).toBeNull();
  });

  test("the tool, the verb and every target are read in one sentence", () => {
    expect(memoryConsent(trackerHold({ memories: [`Create tracker tasks under my own epic E1111111111. Epic ${EPIC} is Bob's; ask me first.`] }))).toBeNull();
    expect(memoryConsent(trackerHold({ memories: [`Create a tracker task for follow-ups. Use epic ${EPIC}.`] }))).toBeNull();
  });

  test.each([
    ["if I ask", `If I ask for it, create a tracker task under epic ${EPIC}.`],
    ["when I say so", `When I say so, create a tracker task under epic ${EPIC}.`],
    ["only if", `Create a tracker task under epic ${EPIC} only if the work ships.`],
    ["ask me first", `Ask me first, then create a tracker task under epic ${EPIC}.`],
    ["after my sign-off", `After my sign-off, create a tracker task under epic ${EPIC}.`],
    ["get my OK first", `Get my OK, then create a tracker task under epic ${EPIC}.`],
    ["after I approve", `Create a tracker task under epic ${EPIC} after I approve it.`],
  ])("a conditional memory (%s) places nothing", (_label, text) => {
    expect(memoryConsent(trackerHold({ memories: [text] }))).toBeNull();
  });

  test.each([
    ["when I work on", `When I work on Billing UI, create a tracker task under epic ${EPIC}.`],
    ["always", `Always create a tracker task under epic ${EPIC} for Billing UI work.`],
    ["please", `Please file a tracker task under epic ${EPIC} for each Billing UI change.`],
    ["you should", `You should create a tracker task under epic ${EPIC} for Billing UI work.`],
    ["I want you to", `I want you to create a tracker task under epic ${EPIC} for Billing UI work.`],
    ["go ahead and", `Go ahead and create a tracker task under epic ${EPIC} for UI work.`],
  ])("a standing ask (%s) places the task", (_label, text) => {
    expect(memoryConsent(trackerHold({ memories: [text] }))).toBe(text);
  });

  test.each([
    ["stop creating", `Stop creating tracker tasks under epic ${EPIC}.`],
    ["no longer", `No longer create tracker tasks under epic ${EPIC}.`],
    ["used to", `I used to create tracker tasks under epic ${EPIC}.`],
    ["someone else does it", `Bob creates the tracker tasks under epic ${EPIC}; I only review them.`],
    ["a description of the tool", `TrackerCreateTask with parentTask ${EPIC} gets held by the floor.`],
    ["a past act", `Yesterday I created a tracker task under epic ${EPIC}.`],
  ])("a memory that doesn't ask now (%s) places nothing", (_label, text) => {
    expect(memoryConsent(trackerHold({ memories: [text] }))).toBeNull();
  });

  test.each([
    ["closed, don't file", `Epic ${EPIC} is closed now; don't file anything under it anymore.`],
    ["retired", `Epic ${EPIC} was retired.`],
    ["never under", `Never put anything under ${EPIC}.`],
  ])("a later memory holding the epic off (%s) revokes the routing", (_label, text) => {
    expect(memoryConsent(trackerHold({ memories: [ROUTING, text] }))).toBeNull();
  });

  test("a memory that asks and also says what not to set still places the task", () => {
    const text = `Create a tracker task under epic ${EPIC}; don't set a priority.`;
    expect(memoryConsent(trackerHold({ memories: [text] }))).toBe(text);
  });

  test("a plugin copy of a known server counts only under one of the profile's plugin prefixes", () => {
    expect(memoryConsent(trackerHold({ toolName: "mcp__plugin_evil_corp-mcp__TrackerCreateTask" }))).toBeNull();
    expect(memoryConsent(trackerHold({ toolName: "mcp__plugin_corp-agents-evil_corp-mcp__TrackerCreateTask" }))).toBeNull();
    expect(memoryConsent(trackerHold({ toolName: "mcp__plugin_evil-corp-agents_corp-mcp__TrackerCreateTask" }))).toBeNull();
    expect(memoryConsent(trackerHold({ toolName: "mcp__plugin_corp-agents_corp-mcp__TrackerCreateTask" }))).toBe(ROUTING);
  });

  test("a full call is placed by the owner's memory, and a priority rule under the epic doesn't revoke it", () => {
    const memory = `For Billing UI work, create a tracker task under epic ${EPIC}.`;
    const call = JSON.stringify({ name: "Add a status filter", description: "d", boardId: BOARD, parentTask: EPIC });
    expect(memoryConsent(trackerHold({ call, memories: [memory] }))).toBe(memory);
    expect(ruleCheck(trackerHold({ call, memories: [memory] })).verdict).toBe("allow");
    for (const extra of [`Tracker tasks under epic ${EPIC}: never set a priority.`, `Never set a priority on tracker tasks under ${EPIC}.`]) {
      expect(memoryConsent(trackerHold({ call, memories: [memory, extra] }))).toBe(memory);
    }
  });

  test.each([
    ["if I agree", `If I agree, create a tracker task under epic ${EPIC}.`],
    ["if the owner approves", `If the owner approves, create a tracker task under epic ${EPIC}.`],
    ["once I've reviewed", `Create a tracker task under epic ${EPIC} once I've reviewed the design.`],
    ["when I give the word", `When I give the word, create a tracker task under epic ${EPIC}.`],
    ["until I", `Until I confirm the design, don't wait: create a tracker task under epic ${EPIC}.`],
  ])("a condition with the owner as its subject (%s) places nothing", (_label, text) => {
    expect(memoryConsent(trackerHold({ memories: [text] }))).toBeNull();
  });

  test.each([
    ["when working on", `When working on Billing UI, create a tracker task under epic ${EPIC}.`],
    ["if I'm working on", `If I'm working on Billing UI, create a tracker task under epic ${EPIC}.`],
    ["in … work", `In Billing UI work, create a tracker task under epic ${EPIC}.`],
  ])("a work-scope clause (%s) is no condition", (_label, text) => {
    expect(memoryConsent(trackerHold({ memories: [text] }))).toBe(text);
  });

  test.each([
    ["done", `Epic ${EPIC} is done.`],
    ["completed", `Epic ${EPIC} is completed.`],
    ["cancelled", `Epic ${EPIC} was cancelled.`],
    ["canceled", `Epic ${EPIC} was canceled.`],
    ["obsolete", `Epic ${EPIC} is obsolete.`],
    ["superseded", `Epic ${EPIC} has been superseded by E5550000001.`],
    ["abandoned", `Epic ${EPIC} is abandoned.`],
    ["paused", `Epic ${EPIC} is paused.`],
    ["on hold", `Epic ${EPIC} is on hold.`],
    ["archived", `Epic ${EPIC} got archived.`],
    ["deprecated", `Epic ${EPIC} is deprecated.`],
    ["frozen", `Epic ${EPIC} is frozen.`],
    ["moved", `Epic ${EPIC} moved to another team.`],
    ["no more", `No more tasks under ${EPIC}.`],
  ])("a later memory retiring the epic (%s) revokes the routing", (_label, text) => {
    expect(memoryConsent(trackerHold({ memories: [ROUTING, text] }))).toBeNull();
  });

  test("an epic id under a nested field is no parent: it covers no board and must be named itself", () => {
    const OTHER_BOARD = "66666666-7777-4888-9999-aaaaaaaaaaaa";
    expect(memoryConsent(trackerHold({ call: JSON.stringify({ name: "x", description: "d", boardId: OTHER_BOARD, labels: { epicRef: EPIC } }) }))).toBeNull();
    expect(memoryConsent(trackerHold({ call: JSON.stringify({ name: "x", parentTask: EPIC, labels: { epicRef: "E1111111111" } }) }))).toBeNull();
  });

  test("a target that isn't shaped as an id is named by no memory", () => {
    expect(memoryConsent(trackerHold({ call: JSON.stringify({ title: "t", parentTask: EPIC, boardId: "track" }) }))).toBeNull();
    expect(memoryConsent(trackerHold({ call: JSON.stringify({ title: "t", parentTask: "invoice" }), memories: ["create a tracker task under invoice"] }))).toBeNull();
  });

  test("the model layer sees the memory only when it names the call's tool and target", () => {
    expect(ALLOW_CHECK_SYSTEM_PROMPT).toContain("saved memory");
    expect(allowCheckPrompt(trackerHold())).toContain(`saved memory naming this call's tool and every target it files under: «${ROUTING}»`);
    expect(allowCheckPrompt(trackerHold({ call: JSON.stringify({ title: "t", parentTask: "E1111111111" }) }))).not.toContain("saved memory naming");
  });

  test.each([
    ["the retiring word before the epic", `We retired epic ${EPIC}; new UI work goes under E5560000000.`],
    ["a colon between the epic and closed", `Epic ${EPIC}: closed.`],
    ["no longer in use", `Epic ${EPIC} is no longer in use.`],
    ["not active anymore", `Epic ${EPIC} isn't active anymore.`],
    ["archived before the epic", `Archived epic ${EPIC} last sprint.`],
    ["a backticked epic, closed", `Epic \`${EPIC}\` is closed now.`],
    ["inactive", `Epic ${EPIC} is inactive.`],
    ["not in use", `${EPIC} is not in use.`],
  ])("a second memory holding the epic off (%s) wins over the routing memory", (_label, text) => {
    expect(memoryConsent(trackerHold({ memories: [ROUTING, text] }))).toBeNull();
  });

  test("a hold-off in another sentence of the asking memory itself still wins", () => {
    expect(memoryConsent(trackerHold({ memories: [`${ROUTING} Epic ${EPIC} is closed now.`] }))).toBeNull();
  });

  test.each([
    ["a condition in the sentence before", `I'll tell you when. Then create a tracker task under epic ${EPIC} for Billing UI work.`],
    ["after that", `Wait for the review. After that, create a tracker task under epic ${EPIC}.`],
    ["once approved, no subject", `Once approved, create a tracker task under epic ${EPIC}.`],
    ["if asked, no subject", `If asked, create a tracker task under epic ${EPIC}.`],
    ["when ready", `When ready, create a tracker task under epic ${EPIC}.`],
    ["the owner by name", `When ${OWNER} says so, create a tracker task under epic ${EPIC}.`],
    ["a work scope joined to an owner condition", `If I'm working on Billing UI and I've reviewed it, create a tracker task under epic ${EPIC}.`],
  ])("a conditional ask (%s) places nothing now", (_label, text) => {
    expect(memoryConsent(trackerHold({ memories: [text] }))).toBeNull();
  });

  test.each([
    ["pick up", `When I pick up Billing UI work, create a tracker task under epic ${EPIC}.`],
    ["start", `When I start Billing UI work, create a tracker task under epic ${EPIC}.`],
    ["touch", `Whenever I touch the Billing UI, create a tracker task under epic ${EPIC}.`],
    ["handle", `When I handle Billing UI tickets, create a tracker task under epic ${EPIC}.`],
  ])("a work condition (%s) still places the task", (_label, text) => {
    expect(memoryConsent(trackerHold({ memories: [text] }))).toBe(text);
  });

  test.each([
    ["don't add a priority when you create", "Don't add a priority when you create tracker tasks."],
    ["never set a priority", `Tracker tasks under epic ${EPIC}: never set a priority.`],
    ["don't set priority, no article", `Don't set priority on tracker tasks under ${EPIC}.`],
  ])("a field-scoped negation (%s) doesn't revoke the routing", (_label, text) => {
    expect(memoryConsent(trackerHold({ memories: [ROUTING, text] }))).toBe(ROUTING);
  });

  test("a field-scoped verb on a task itself is no field: it still revokes", () => {
    expect(memoryConsent(trackerHold({ memories: [ROUTING, `Don't add tasks under ${EPIC}.`] }))).toBeNull();
  });

  test.each([
    ["the owner holds the step off", { ownerMessages: ["add a status filter to the invoice list. Don't create a tracker task for this one."] }],
    ["the owner holds the epic off", { ownerMessages: [`add a status filter to the invoice list; nothing goes under ${EPIC} anymore`] }],
    ["an untagged thread message holds the tracker off", { ownerThreadMessages: ["no tracker tasks this week"] }],
    ["the owner says no since the hold", { ownerApprovals: [{ text: "no, don't file that tracker task" }] }],
    ["the job's own goal holds it off", { job: { title: "Invoice list filter", goal: "add a status filter; don't create tracker tasks for it" } }],
  ])("%s about this job: that wins over the saved memory", (_label, over) => {
    const hold = trackerHold(over as Partial<AllowCheckInput>);
    expect(memoryConsent(hold)).toBeNull();
    expect(ruleCheck(hold).verdict).toBe("flag");
  });
});

describe("allow check — a memory that places a write is one Persona saves only from the owner's words", () => {
  test.each([
    ["the routing memory", ROUTING],
    ["the tool's own name", `For Billing UI work use TrackerCreateTask with parentTask ${EPIC}.`],
    ["an update by id", "Update tracker task T-4f1c-mine when its work merges."],
    ["a board UUID", `File tracker tasks on board ${BOARD}.`],
  ])("%s needs the owner's words", (_label, text) => {
    expect(memoryNeedsOwnerWords(text)).toBe(true);
  });

  test("a memory with no write or no id is unchanged", () => {
    expect(memoryNeedsOwnerWords("Prefer short function names.")).toBe(false);
    expect(memoryNeedsOwnerWords("Create small helper functions.")).toBe(false);
    expect(memoryNeedsOwnerWords("Billing UI work lives in epic E5550001234.")).toBe(false);
  });
});

describe("allow check — memories come from the owner's own saved memories, routing hints included", () => {
  function store() {
    const s = createStore(":memory:");
    const k = new KnowledgeStore(s.db);
    const dir = mkdtempSync(join(tmpdir(), "memory-consent-"));
    const memory = (owner: string, topic: string, body: string, kind: string) => {
      const slug = memorySlug(owner, topic)!.slug;
      const filePath = join(dir, GLOBAL_PROJECT_ID, `${slug}.md`);
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, `---\ntitle: ${slug}\n---\n${body}\n`);
      k.upsertDoc({
        id: randomUUID(),
        projectId: GLOBAL_PROJECT_ID,
        slug,
        title: slug,
        body,
        filePath,
        tags: ["persona", kind],
        scope: "user",
        ownerUser: owner,
        sourceKind: "decision",
        originClass: "agent",
        updatedAt: new Date("2026-10-01T00:00:00Z"),
      });
      k.stampWriter(GLOBAL_PROJECT_ID, slug, PERSONA_WRITER);
    };
    return { db: s.db, memory };
  }

  test("a routing memory stays out of the brief's preferences but reaches the check in full, and places the task", () => {
    const h = store();
    h.memory(OWNER, "billing-ui-tracker-epic", ROUTING, "routing");
    h.memory(OWNER, "tests", "Run the unit tests before every review.", "preference");
    const profile = buildOwnerProfile(h.db, OWNER);
    expect(formatOwnerPreferences(profile, OWNER).text).not.toContain(EPIC);
    const memories = ownerMemoryTexts(profile);
    expect(memories.some((m) => m.includes(EPIC))).toBe(true);
    expect(ruleCheck(trackerHold({ memories })).verdict).toBe("allow");
  });

  test("another owner's memory naming the tool and the epic places nothing for this owner", () => {
    const h = store();
    h.memory("bob", "billing-ui-tracker-epic", ROUTING, "routing");
    const memories = ownerMemoryTexts(buildOwnerProfile(h.db, OWNER));
    expect(memories).toEqual([]);
    expect(ruleCheck(trackerHold({ memories })).verdict).toBe("flag");
  });
});
