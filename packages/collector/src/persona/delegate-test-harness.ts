import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import {
  attachSessionToLaunch,
  cancelAsk,
  createLaunch,
  createPersonaJob,
  createSession,
  createStore,
  getAsk,
  linkPersonaJobLaunch,
  listPersonaApprovals,
  setLaunchWorkerTokenHash,
  upsertProject,
} from "@standup/store";
import type { Store } from "@standup/store";
import { FLOOR_WORKER_TOKEN_HEADER, workerTokenHash } from "../floor/gate.js";
import { generateOwnerSecrets } from "../owner-secret.js";
import { FakeProcessSystem } from "../process-registry-fake.js";
import { createServer, resolveUserAlias } from "../server.js";
import type { LaunchFn } from "../server.js";
import { PersonaRuntime } from "./runtime.js";
import { PersonaFleet } from "./fleet.js";
import { createBroadcastTap } from "./events.js";
import { resolvePersonaConfig } from "./config.js";
import { PERSONA_TOKEN_HEADER } from "./routes.js";
import { LANE_EVENTS_HEADING } from "./delegate-lane.js";
import type { TurnInput, TurnResult } from "./turn.js";
import type { AllowChecker } from "./allow-check.js";

/*
 * The delegate tests' harness, in one process: a scratch DB under /tmp, the
 * real HTTP routes, a Persona runtime whose main turns and delegate turns are
 * stubs (no model). A worker's hook holds calls through POST /api/floor/hold;
 * the stub delegate answers or escalates them through the real tool route
 * with its own lane token, as the model would, by the harness's rules.
 */

export const OWNER = resolveUserAlias(undefined);
const WORKER_TOKEN = "w".repeat(64);
// Held commands are built at run time.
// ROUTINE prints the example.corp profile's SSO cookie, a hold Persona decides while that profile is active.
export const ROUTINE = ["cat", ["~", ".corp-sso", "cookie"].join("/")].join(" ");
export const OUTWARD = ["git", "push", "origin", "fix/docs-sync"].join(" ");
export const HIGH_RISK = ["cat", ["", "proc", "1", "environ"].join("/")].join(" ");
const SILENT: TurnResult = { ok: true, text: "[silent]", sessionId: "stub" };

export type Call = (name: string, args: Record<string, unknown>) => Promise<{ isError?: boolean; text: string }>;
/** What the stub delegate does with one held ask; matched on the held command in its question. */
export interface Rule {
  match: string;
  act: (askId: string, call: Call) => Promise<void>;
}

export interface Harness {
  dir: string;
  store: Store;
  runtime: PersonaRuntime;
  app: ReturnType<typeof createServer>;
  job: { id: string; threadId: string };
  launchId: string;
  sessionId: string;
  mainTurns: TurnInput[];
  laneTurns: TurnInput[];
  /** Each delegate turn's lane token, in order. */
  laneTokens: string[];
  rules: Rule[];
  /** Results the delegate's calls got, in order. */
  laneResults: Array<{ name: string; askId: string; isError?: boolean; text: string }>;
  /** Set to make the main runner wait on it before answering. */
  mainGate?: Promise<void>;
  /** Set to make the delegate's turn fail. */
  laneFails?: string;
  /** Every hold's hook reply, settled before the harness closes. */
  replies: Promise<unknown>[];
  subscribe(): void;
  close(): Promise<void>;
}

/** A harness; `env` is Persona's config env, `wireLanes: false` builds no delegate runner. */
export function harness(
  env: Record<string, string> = {},
  opts: { wireLanes?: boolean; subscribe?: boolean; start?: boolean; allowChecker?: AllowChecker } = {}
): Harness {
  const dir = mkdtempSync(join("/tmp", "delegate-lane-"));
  const store = createStore(join(dir, "standup.db"));
  const secrets = generateOwnerSecrets();
  const tap = createBroadcastTap(() => {});
  const h = { dir, store, mainTurns: [], laneTurns: [], laneTokens: [], rules: [], laneResults: [], replies: [] } as unknown as Harness;
  const runtime = new PersonaRuntime({
    db: store.db,
    owner: OWNER,
    config: resolvePersonaConfig({ STANDUP_PERSONA_COALESCE_S: "1", ...env }),
    broadcast: tap.broadcast,
    tickMs: 3_600_000,
    dailyBrief: false,
    ownerToken: () => secrets.ownerToken,
    ...(opts.allowChecker ? { allowChecker: opts.allowChecker } : {}),
    turnRunner: async (input) => {
      h.mainTurns.push(input);
      if (h.mainGate) await h.mainGate;
      return SILENT;
    },
    ...(opts.wireLanes === false
      ? {}
      : {
          delegateRunner: (_agent, token) => async (input: TurnInput): Promise<TurnResult> => {
            h.laneTurns.push(input);
            h.laneTokens.push(token);
            if (h.laneFails) return { ok: false, error: h.laneFails };
            const call = laneCaller(h, token);
            for (const askId of eventsIn(input.prompt)) {
              const question = getAsk(store.db, askId)?.question ?? "";
              const rule = h.rules.find((r) => question.includes(r.match));
              if (rule) await rule.act(askId, call);
            }
            return SILENT;
          },
        }),
  });
  const fleet = new PersonaFleet({ db: store.db, host: OWNER, hostRuntime: runtime, create: () => runtime });
  const noLaunch = (async () => {
    throw new Error("this check launches no workers");
  }) as unknown as LaunchFn;
  const app = createServer(store, tap.broadcast, null, undefined, undefined, dir, "", {}, undefined, undefined, noLaunch, undefined, { fleet, ownerSecrets: secrets }, {}, {
    stopLaunch: async () => ({ ok: true, log: [] }),
    processes: new FakeProcessSystem(),
    paneAlive: () => false,
  });
  runtime.bindApp(app);
  const worktree = join(dir, "wt");
  upsertProject(store.db, { id: "docs-sync", name: "Docs sync", branch: "main", repos: [] });
  const job = createPersonaJob(store.db, {
    owner: OWNER,
    threadId: runtime.consoleThreadId(),
    title: "Fix the docs sync's wiki sign-in",
    goal: "Find out why the nightly docs sync can't reach the internal wiki, and fix it",
  });
  const launchId = randomUUID();
  createLaunch(store.db, { id: launchId, projectId: "docs-sync", task: "fix the docs sync's wiki sign-in", worktreePath: worktree, branch: "fix/docs-sync" });
  linkPersonaJobLaunch(store.db, job.id, launchId);
  const sessionId = randomUUID();
  createSession(store.db, { id: sessionId, projectId: "docs-sync", title: "docs-sync worker", cwd: worktree, status: "running" });
  attachSessionToLaunch(store.db, launchId, sessionId);
  setLaunchWorkerTokenHash(store.db, launchId, workerTokenHash(WORKER_TOKEN));
  let subscribed = false;
  Object.assign(h, {
    runtime,
    app,
    job,
    launchId,
    sessionId,
    subscribe: () => {
      if (subscribed) return;
      subscribed = true;
      tap.subscribe(fleet.eventListener());
    },
    close: async () => {
      runtime.stop();
      // Holds a test left pending are cancelled, so their waiters let go before the DB closes.
      for (const row of store.db.query("SELECT id FROM asks WHERE status = 'pending'").all() as Array<{ id: string }>) cancelAsk(store.db, row.id);
      await Promise.allSettled(h.replies);
      store.db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  });
  if (opts.subscribe !== false) h.subscribe();
  if (opts.start !== false) runtime.start();
  return h;
}

/** Calls the Persona tool route with `token`, recording each result on the harness. */
export function laneCaller(h: Harness, token: string): Call {
  return async (name, args) => {
    const res = await h.app.request("/api/persona/tool", {
      method: "POST",
      headers: { "content-type": "application/json", [PERSONA_TOKEN_HEADER]: token },
      body: JSON.stringify({ name, arguments: args }),
    });
    const body = (await res.json()) as { isError?: boolean; content: Array<{ text: string }> };
    const out = { isError: body.isError, text: body.content.map((c) => c.text).join("\n") };
    h.laneResults.push({ name, askId: String(args.askId ?? ""), ...out });
    return out;
  };
}

/** The ask ids a delegate turn's prompt lists under its events heading. */
export function eventsIn(prompt: string): string[] {
  const at = prompt.indexOf(LANE_EVENTS_HEADING);
  if (at < 0) return [];
  const block = prompt.slice(at).split("```")[1] ?? "";
  return [...block.matchAll(/^- (?:ask|review) (\S+)/gm)].map((m) => m[1]!);
}

/** The hook's own verdict on a held call, as the floor route takes it. */
export interface ClientHold {
  category: string;
  reason: string;
  ownerReserved?: boolean;
}

/** The worker's hook holding `command` through the real floor route, with the hook's verdict `client`. */
export async function hold(h: Harness, command: string, client?: ClientHold) {
  const requestId = `toolu_${randomUUID()}`;
  const reply = Promise.resolve(
    h.app.request("/api/floor/hold", {
      method: "POST",
      headers: { "content-type": "application/json", [FLOOR_WORKER_TOKEN_HEADER]: WORKER_TOKEN },
      body: JSON.stringify({
        session_id: h.sessionId,
        cwd: join(h.dir, "wt"),
        launch_id: h.launchId,
        request_id: requestId,
        tool_name: "Bash",
        tool_input: { command },
        hold: { category: "unclassified", ownerOnly: false, reason: "the hook held it", ...client, step: command },
        wait_s: 30,
      }),
    })
  ).then((r) => r.json() as Promise<Record<string, unknown>>);
  h.replies.push(reply.catch(() => undefined));
  for (let i = 0; i < 400; i++) {
    const row = h.store.db.query("SELECT id FROM asks WHERE request_id = ?").get(requestId) as { id: string } | null;
    if (row) return { askId: row.id, reply };
    await Bun.sleep(5);
  }
  throw new Error("the hold raised no ask");
}

export async function until<T>(read: () => T | undefined | null | false, what: string, ms = 4_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

export const allow = (reason: string): Rule["act"] => async (askId, call) => {
  await call("answer_ask", { askId, answer: "Allow once", reason });
};
export const escalate = (recommendation: string, why: string): Rule["act"] => async (askId, call) => {
  await call("escalate", { askId, recommendation, why });
};
export const tryAllowThenEscalate = (recommendation: string, why: string): Rule["act"] => async (askId, call) => {
  const tried = await call("answer_ask", { askId, answer: "Allow once", reason: "the job needs it" });
  if (tried.isError) await call("escalate", { askId, recommendation, why });
};

export const mainPromptsWith = (h: Harness, text: string) => h.mainTurns.filter((t) => t.prompt.includes(text));
export const cardsFor = (h: Harness, askId: string) =>
  listPersonaApprovals(h.store.db, OWNER).filter((a) => a.action === "answer_ask" && a.args.askId === askId);
export const actionRecords = (h: Harness) =>
  h.store.db
    .query("SELECT value_json, thread_id, job_id, audience FROM persona_signals WHERE owner = ? AND kind = 'persona_action' AND subject = 'answer_ask' ORDER BY rowid")
    .all(OWNER) as Array<{ value_json: string; thread_id: string | null; job_id: string | null; audience: string | null }>;
