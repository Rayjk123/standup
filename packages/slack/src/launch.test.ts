// Launch-from-Slack routing. Capabilities-only: a recording fake stands in for
// the collector's launch + project-list endpoints, so NO live Slack or HTTP call
// runs. Asserts that a launch command calls collector.launch with the right args
// (task + resolved project + attribution), that the project resolves by id and
// name and defaults to scratch when omitted, and that a non-launch message does
// NOT launch (so the router keeps its ask/steer behavior).

import { describe, expect, test } from "bun:test";
import type { Launch, Project } from "@standup/shared";
import type { LaunchOutcome } from "./collector-client.js";
import { LaunchFromSlack, resolveProjectId, type LaunchContext, type LaunchSink } from "./launch.js";

interface LaunchCall {
  projectId: string;
  task: string;
  actor?: string;
  idempotencyKey?: string;
}

function fakeLaunch(over: Partial<Launch> = {}): Launch {
  return {
    id: "launch-1",
    kind: "worktree",
    projectId: "scratch",
    task: "t",
    worktreePath: "/tmp/wt",
    branch: "standup/x",
    status: "starting",
    keepAlive: false,
    createdAt: new Date(),
    ...over,
  };
}

function proj(id: string, name: string): Project {
  return { id, name, repos: [], branch: "main" };
}

/** Records every launch call; returns a canned outcome (default: ok). */
class RecordingCollector implements LaunchSink {
  readonly calls: LaunchCall[] = [];
  constructor(
    private readonly projects: Project[] | null = [],
    private readonly outcome: LaunchOutcome = { ok: true, launch: fakeLaunch() },
  ) {}
  launch = async (
    projectId: string,
    task: string,
    opts: { actor?: string; idempotencyKey?: string } = {},
  ): Promise<LaunchOutcome> => {
    this.calls.push({ projectId, task, actor: opts.actor, idempotencyKey: opts.idempotencyKey });
    return this.outcome;
  };
  listProjects = async (): Promise<Project[] | null> => this.projects;
}

interface Notice {
  channel: string;
  threadTs: string;
  text: string;
}
function recordingNotify(sink: Notice[]) {
  return async (channel: string, threadTs: string, text: string) => {
    sink.push({ channel, threadTs, text });
  };
}

const ctx = (over: Partial<LaunchContext> = {}): LaunchContext => ({
  channel: "C1",
  threadTs: "root-1",
  text: "launch add a health check in standup",
  actor: "slack:Uowner",
  ...over,
});

describe("LaunchFromSlack.needsDirect", () => {
  const projects = [proj("standup", "Standup"), { ...proj("codexy", "Codexy"), harness: "codex" as const }];
  const launcher = new LaunchFromSlack(new RecordingCollector(projects), { webUrl: "http://localhost:5173" });

  test("a plain launch into a Claude project can go to Persona", async () => {
    expect(await launcher.needsDirect("launch add a health check in standup")).toBe(false);
    expect(await launcher.needsDirect("launch fix the flaky test")).toBe(false); // default project
  });

  test("a harness, model or effort clause needs the direct launch", async () => {
    expect(await launcher.needsDirect("launch harness=codex fix it in standup")).toBe(true);
    expect(await launcher.needsDirect("launch model=opus fix it in standup")).toBe(true);
    expect(await launcher.needsDirect("launch effort=high fix it in standup")).toBe(true);
  });

  test("a project on a non-Claude harness needs the direct launch", async () => {
    expect(await launcher.needsDirect("launch fix it in codexy")).toBe(true);
  });

  test("a message that isn't a launch command needs nothing", async () => {
    expect(await launcher.needsDirect("what's running?")).toBe(false);
  });
});

describe("LaunchFromSlack.tryLaunch", () => {
  test("a launch command calls collector.launch with task, resolved project, and actor", async () => {
    const collector = new RecordingCollector([proj("standup", "Standup")]);
    const notices: Notice[] = [];
    const launcher = new LaunchFromSlack(collector, {
      webUrl: "http://localhost:5173",
      notify: recordingNotify(notices),
    });

    const handled = await launcher.tryLaunch(ctx());

    expect(handled).toBe(true);
    expect(collector.calls).toEqual([
      { projectId: "standup", task: "add a health check", actor: "slack:Uowner" },
    ]);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.channel).toBe("C1");
    expect(notices[0]!.threadTs).toBe("root-1");
  });

  test("resolves the project by (case-insensitive) NAME", async () => {
    const collector = new RecordingCollector([proj("standup", "Standup")]);
    const launcher = new LaunchFromSlack(collector, { webUrl: "http://localhost:5173" });

    await launcher.tryLaunch(ctx({ text: "launch add a health check in standup" }));
    // name "Standup" typed lowercased still resolves to the id.
    expect(collector.calls[0]!.projectId).toBe("standup");
  });

  test("defaults to the scratch project when the command names none", async () => {
    const collector = new RecordingCollector([]);
    const launcher = new LaunchFromSlack(collector, { webUrl: "http://localhost:5173" });

    await launcher.tryLaunch(ctx({ text: "launch fix the flaky test" }));

    expect(collector.calls).toEqual([
      { projectId: "scratch", task: "fix the flaky test", actor: "slack:Uowner" },
    ]);
  });

  test("a non-launch message does NOT launch and is not handled", async () => {
    const collector = new RecordingCollector([]);
    const launcher = new LaunchFromSlack(collector, { webUrl: "http://localhost:5173" });

    const handled = await launcher.tryLaunch(ctx({ text: "run the tests" }));

    expect(handled).toBe(false);
    expect(collector.calls).toHaveLength(0);
  });

  test("the reply carries the session share link once the session id is present", async () => {
    const collector = new RecordingCollector([proj("standup", "Standup")], {
      ok: true,
      launch: fakeLaunch({ sessionId: "abcdef12-3456-7890-aaaa-bbbbbbbbbbbb" }),
    });
    const notices: Notice[] = [];
    const launcher = new LaunchFromSlack(collector, {
      webUrl: "http://localhost:5173",
      notify: recordingNotify(notices),
    });

    await launcher.tryLaunch(ctx());

    expect(notices[0]!.text).toContain("http://localhost:5173/s/abcdef12");
  });

  test("an explicit project= that the collector rejects is surfaced in-thread (still handled)", async () => {
    const collector = new RecordingCollector([], {
      ok: false,
      error: "Unknown project: nope",
      status: 404,
    });
    const notices: Notice[] = [];
    const launcher = new LaunchFromSlack(collector, {
      webUrl: "http://localhost:5173",
      notify: recordingNotify(notices),
    });

    // An EXPLICIT project=<id> that doesn't resolve is a real error — it's passed
    // through to the collector, which 404s, and the failure is surfaced.
    const handled = await launcher.tryLaunch(ctx({ text: "launch: do a thing project=nope" }));

    expect(handled).toBe(true);
    expect(collector.calls[0]!.projectId).toBe("nope");
    expect(notices[0]!.text).toContain("Couldn't launch");
    expect(notices[0]!.text).toContain("Unknown project");
  });

  test("an inferred ' in ' project that doesn't resolve launches the whole phrase in scratch", async () => {
    // "launch fix the bug in the parser" has no real project named — the greedy
    // split guessed "the parser". A resolve-miss on that inferred guess must NOT
    // 404; it launches the WHOLE phrase in the default (scratch) project.
    const collector = new RecordingCollector([proj("standup", "Standup")]);
    const notices: Notice[] = [];
    const launcher = new LaunchFromSlack(collector, {
      webUrl: "http://localhost:5173",
      notify: recordingNotify(notices),
    });

    const handled = await launcher.tryLaunch(ctx({ text: "launch fix the bug in the parser" }));

    expect(handled).toBe(true);
    expect(collector.calls).toEqual([
      { projectId: "scratch", task: "fix the bug in the parser", actor: "slack:Uowner" },
    ]);
    expect(notices[0]!.text).toContain("scratch");
  });

  test("the idempotency key is forwarded to collector.launch", async () => {
    const collector = new RecordingCollector([proj("standup", "Standup")]);
    const launcher = new LaunchFromSlack(collector, { webUrl: "http://localhost:5173" });

    await launcher.tryLaunch(ctx({ idempotencyKey: "C1:170.5" }));

    expect(collector.calls[0]!.idempotencyKey).toBe("C1:170.5");
  });

  test("requireMentionOf: a bare 'launch …' is NOT handled (no hijack of a steer/ask reply)", async () => {
    const collector = new RecordingCollector([proj("standup", "Standup")]);
    const launcher = new LaunchFromSlack(collector, { webUrl: "http://localhost:5173" });

    const handled = await launcher.tryLaunch(
      ctx({ text: "launch it with vitest", requireMentionOf: "U0BOT" }),
    );

    expect(handled).toBe(false);
    expect(collector.calls).toHaveLength(0);
  });

  test("requireMentionOf: an explicit @-mention of the bot launches", async () => {
    const collector = new RecordingCollector([proj("web", "Web")]);
    const launcher = new LaunchFromSlack(collector, { webUrl: "http://localhost:5173" });

    const handled = await launcher.tryLaunch(
      ctx({ text: "<@U0BOT> launch add tests in web", requireMentionOf: "U0BOT" }),
    );

    expect(handled).toBe(true);
    expect(collector.calls[0]!.projectId).toBe("web");
    expect(collector.calls[0]!.task).toBe("add tests");
  });

  test("an ambiguous project name asks for project=<id> and does not launch", async () => {
    const collector = new RecordingCollector([proj("web-a", "Web"), proj("web-b", "Web")]);
    const notices: Notice[] = [];
    const launcher = new LaunchFromSlack(collector, {
      webUrl: "http://localhost:5173",
      notify: recordingNotify(notices),
    });

    const handled = await launcher.tryLaunch(ctx({ text: "launch add tests in Web" }));

    expect(handled).toBe(true);
    expect(collector.calls).toHaveLength(0);
    expect(notices[0]!.text).toContain("project=");
  });
});

describe("resolveProjectId", () => {
  const projects = [proj("standup", "Standup"), proj("web", "Web Console")];

  test("empty ref → the default", () => {
    expect(resolveProjectId(undefined, projects, "scratch")).toEqual({ id: "scratch" });
    expect(resolveProjectId("  ", projects, "scratch")).toEqual({ id: "scratch" });
  });

  test("exact id, case-insensitive id, and case-insensitive name all match", () => {
    expect(resolveProjectId("standup", projects, "scratch")).toEqual({ id: "standup" });
    expect(resolveProjectId("STANDUP", projects, "scratch")).toEqual({ id: "standup" });
    expect(resolveProjectId("web console", projects, "scratch")).toEqual({ id: "web" });
  });

  test("no match leaves the id undefined", () => {
    expect(resolveProjectId("nope", projects, "scratch")).toEqual({});
  });

  test("a name matching more than one project is ambiguous", () => {
    const dupes = [proj("a", "Dup"), proj("b", "Dup")];
    expect(resolveProjectId("dup", dupes, "scratch")).toEqual({ ambiguous: true });
  });
});
