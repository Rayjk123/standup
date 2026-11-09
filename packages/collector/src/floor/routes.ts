import type { Database } from "bun:sqlite";
import type { Context, Hono } from "hono";
import type { Ask, Launch, Session, WsMessage } from "@standup/shared";
import {
  claimFloorAllowDelivery,
  createAsk,
  getAsk,
  getAskByRequestId,
  getFloorAskState,
  getLaunchBySession,
  getLaunchWorkerTokenHash,
  getPendingAsks,
  getProject,
  getSetting,
  personaJobForLaunch,
  resolveAsk,
  timeoutExpiredGatedAsks,
  timeoutPendingAsk,
  updateSessionStatus,
} from "@standup/store";
import { tokenMatches } from "@standup/shared/write-token";
import { announceAskTimedOut, waitForAskResolution } from "../asks.js";
import { processDrain } from "../drain.js";
import { activeOwnerSecrets, type OwnerSecrets } from "../owner-secret.js";
import { collectorAwsIdentity, type AwsIdentity } from "./aws-identity.js";
import { AWS_NOT_PERSONAL_TEXT, AWS_UNKNOWN_ACCOUNT_TEXT, classifyToolCall, type AwsTarget } from "./classify.js";
import { WORKTREE_ROOT_SETTING, buildLaunchFloorConfig, floorWaitSeconds, foreignLaunchPaths, jobLaunchPaths, launchScratchId } from "./launch.js";
import {
  FLOOR_ABANDON_GRACE_MS,
  FLOOR_ALLOW_OPTION,
  FLOOR_BOOT_REATTACH_GRACE_MS,
  FLOOR_GATE,
  FLOOR_HOLD_ROUTE,
  FLOOR_OPTIONS,
  FLOOR_OWNER_GATE,
  FLOOR_WATCHDOG_MARGIN_S,
  FLOOR_WORKER_TOKEN_HEADER,
  OWNER_ONLY_CATEGORIES,
  floorAnswerAllows,
  floorCallHash,
  floorQuestion,
  isFloorGate,
  signFloorReply,
  workerTokenHash,
  FLOOR_TOOL_NAME,
} from "./gate.js";
import type { FloorCall, FloorCategory, FloorConfig, FloorHold, FloorHoldResponse, FloorVerdict } from "./gate.js";

/** Who an ask the floor answers itself is recorded as answered by: model invokes in a personal account. */
export const PERSONAL_INVOKE_ANSWERER = "safety-floor:personal-invoke";

/** Who an ask is recorded as answered by when it held only for a job root made after the launch (jobRootHoldLifted). */
export const JOB_ROOT_ANSWERER = "safety-floor:job-root";

/*
 * The collector side of the safety floor: the hook POSTs a floored call to
 * FLOOR_HOLD_ROUTE and this route holds it as a pending ask until Persona or
 * the owner answers, then replies allow or deny.
 *
 * The hook's verdict is a floor, never a ceiling. The call is re-classified
 * here against the launch's own facts and the stricter of the two holds wins:
 * a hold can be raised to owner-only, but is otherwise never lowered or turned
 * into an allow (the one exception follows). Which gate the ask carries (and so whether Persona may allow it)
 * is decided from the category, not from the client's `ownerOnly` flag alone.
 * The one hold lowered is an owner-only `aws` hold whose account is personal
 * once the collector looks: the launch's older allowlist didn't list it, or the
 * command doesn't name it and the credentials it runs with belong to it
 * (personalAccountHold, classifyWithCredentials). It goes to Persona as
 * `personal-aws`, still held — unless every step it took for a personal
 * account is a model invoke (sagemaker-runtime, bedrock-runtime), which always
 * passes there: the collector records the ask as answered by the floor
 * (PERSONAL_INVOKE_ANSWERER) and replies allow without raising a card. A hold
 * that stood only because the hook's config predates a worktree another launch
 * of the same Persona job made is answered the same way (jobRootHoldLifted,
 * JOB_ROOT_ANSWERER).
 *
 * Only the launch's own hook may raise or re-attach to its holds: the request
 * must carry the launch's scoped worker token (FLOOR_WORKER_TOKEN_HEADER),
 * whose hash the launch row stores, and name that launch. A re-attach must
 * name the same call the hold was raised for (floorCallHash), and an allow is
 * handed out once: a later re-attach of a delivered allow is denied.
 *
 * Every reply is signed with the collector's floor reply key over the request
 * id, the decision and the call's hash (signFloorReply); the hook honors an
 * allow only when that signature verifies. Any reply other than a signed 200
 * with decision "allow" is a deny to the hook.
 */

const CATEGORIES: ReadonlySet<FloorCategory> = new Set<FloorCategory>([
  "outward",
  "review",
  "aws",
  "nonprod-aws",
  "owner-host",
  "collector-api",
  "standup-ops",
  "floor-tamper",
  "unseen-code",
  "destructive",
  "unclassified",
]);

export { FLOOR_TOOL_NAME };

/** Longest reason or step kept from a client hold; the question clips the call itself. */
const MAX_HOLD_TEXT = 500;

export interface FloorRoutesOptions {
  db: Database;
  broadcast(message: WsMessage): void;
  /** Whether a running Persona owns the session; it escalates itself, so the owner isn't pushed. */
  personaHandles(sessionId: string): boolean;
  /** The calling session: by id, else the most recent active session in `cwd`. */
  resolveCallingSession(sessionId: string | null | undefined, cwd: string): Session | null;
  /** Push-notifies the owner of a held call on a session Persona doesn't handle. */
  notifyOwner(session: Session, question: string): void;
  /** Told when a hook re-attaches to a hold it already raised (a restart report counts these). */
  onReattached?(askId: string): void;
  /** Collector base URL the re-classification treats as Standup's API. Defaults to the launcher's. */
  collectorUrl?: string;
  /** Standup's data dir (the DB's). Defaults to the launcher's. */
  standupDataDir?: string;
  /** Longest a hold waits, in seconds. Defaults to STANDUP_FLOOR_WAIT_S (see floorWaitSeconds). */
  waitCapSeconds?: number;
  /** How long a hold whose hook disconnected waits for it to re-attach before timing out. Defaults to FLOOR_ABANDON_GRACE_MS. */
  abandonGraceMs?: number;
  /** How long a hold pending at mount waits for its hook to re-attach before timing out. Defaults to FLOOR_BOOT_REATTACH_GRACE_MS. */
  bootReattachGraceMs?: number;
  /** Released on a collector shutdown; a draining collector times out no hold. Defaults to the process drain's signal. */
  drainSignal?: AbortSignal;
  /** The secrets whose reply key signs every reply. Defaults to activeOwnerSecrets(). */
  secrets?: OwnerSecrets;
  /** One line per hold and decision. */
  log?: (line: string) => void;
  /** Resolves the account of the credentials an AWS call runs with. Defaults to collectorAwsIdentity. */
  awsIdentity?: AwsIdentity;
}

/**
 * The floor config the collector classifies a launch's calls under: the one
 * the launcher installed for it (buildLaunchFloorConfig), with the launch's own
 * base branch shared too. Its job roots are read afresh, so a worktree another
 * launch of the same Persona job made after this one started counts too; so
 * are its foreign roots, the live worktrees of launches outside the job.
 */
export function serverFloorConfig(
  db: Database,
  launch: Launch,
  overrides: { collectorUrl?: string; standupDataDir?: string } = {},
  env: Record<string, string | undefined> = process.env
): FloorConfig {
  const project = getProject(db, launch.projectId);
  const config = buildLaunchFloorConfig(
    {
      launchId: launch.id,
      root: launch.worktreePath,
      projectBranch: project?.branch,
      // A Persona worker in place runs in the owner's checkout (FloorConfig.strictHooks).
      strictHooks: !!launch.inPlace && !!personaJobForLaunch(db, launch.id),
      worktreeRoots: [getSetting(db, WORKTREE_ROOT_SETTING), project?.worktreeRoot],
      // From the launch records, as the launcher named the pane's TMPDIR.
      scratchId: launchScratchId(db, launch),
      jobRoots: jobLaunchPaths(db, launch.id),
      foreignRoots: foreignLaunchPaths(db, launch.id),
    },
    env
  );
  const base = launch.baseBranch?.trim();
  if (base && !config.sharedBranches.includes(base)) config.sharedBranches.push(base);
  if (overrides.collectorUrl) config.collectorUrl = overrides.collectorUrl;
  if (overrides.standupDataDir) config.standupDataDir = overrides.standupDataDir;
  return config;
}

function ownerOnly(hold: Pick<FloorHold, "category" | "ownerOnly">): boolean {
  return hold.ownerOnly === true || OWNER_ONLY_CATEGORIES.has(hold.category);
}

/**
 * The hold the ask carries: the stricter of the hook's and the collector's.
 * Owner-only beats Persona-decidable; at the same level the collector's own
 * verdict is shown. Either side marking it ownerReserved keeps it so. A server
 * allow never loosens the hook's hold.
 */
export function stricterHold(client: FloorHold, server: FloorVerdict): FloorHold {
  const { scratch: _clientScratch, ...clientHold } = client;
  const fromClient: FloorHold = { ...clientHold, ownerOnly: ownerOnly(client) };
  if (server.action !== "hold") return fromClient;
  const reserved = client.ownerReserved === true || server.ownerReserved === true;
  const fromServer: FloorHold = {
    category: server.category,
    ownerOnly: ownerOnly(server),
    reason: server.reason,
    step: server.step,
    ...(reserved ? { ownerReserved: true } : {}),
    // The scratch-instance marker is the collector's own finding: never the hook's, and gone once the hook's hold was owner-reserved.
    ...(server.scratch && !reserved ? { scratch: server.scratch } : {}),
  };
  if (fromClient.ownerOnly && !fromServer.ownerOnly) return { ...fromClient, ...(reserved ? { ownerReserved: true } : {}) };
  return fromServer;
}

/** The collector's classification of a call, and the accounts its credentials resolved to. */
export interface ServerClassification {
  verdict: FloorVerdict;
  /** Accounts the credentials of the call's AWS steps belong to (classifyWithCredentials). */
  credentialAccounts: string[];
  /** The call is allowed even when only model invokes pass in a personal account (FloorConfig.personalAwsInvokesOnly). */
  invokesOnly: boolean;
}

/**
 * Classifies `call` with the AWS account of each mutating AWS step the command
 * doesn't attribute resolved from the credentials it would run with
 * (aws-identity.ts). STS is asked only when `config` lists a personal or
 * non-prod account (otherwise the answer changes nothing) and only for credentials not already
 * cached; a step whose account still can't be told stays unattributed, as in
 * the hook.
 */
export async function classifyWithCredentials(call: FloorCall, config: FloorConfig, identity: AwsIdentity): Promise<ServerClassification> {
  if (config.personalAwsAccounts.length === 0 && (config.nonProdAwsAccounts ?? []).length === 0) {
    return { verdict: classifyToolCall(call, config, { awsAccount: () => null }), credentialAccounts: [], invokesOnly: false };
  }
  // A first pass collects the credentials not cached yet.
  const pending: AwsTarget[] = [];
  classifyToolCall(call, config, {
    awsAccount: (t) => {
      const known = identity.cached(t);
      if (known === undefined) pending.push(t);
      return known ?? null;
    },
  });
  const run = () => {
    const credentialAccounts = new Set<string>();
    const verdict = classifyToolCall(call, config, {
      awsAccount: (t) => {
        const account = identity.cached(t) ?? null;
        if (account) credentialAccounts.add(account);
        return account;
      },
    });
    const invokesOnly =
      verdict.action === "allow" &&
      classifyToolCall(call, { ...config, personalAwsInvokesOnly: true }, { awsAccount: (t) => identity.cached(t) ?? null }).action === "allow";
    return { verdict, credentialAccounts: [...credentialAccounts], invokesOnly };
  };
  if (pending.length === 0) return run();
  await Promise.all(pending.map((t) => identity.resolve(t).catch(() => null)));
  return run();
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Where a hook's `aws` hold reason names an account it couldn't place as
 * personal (Classifier.awsAccountText): each finding's reason ends with it, so
 * it closes the top reason (at its end, or before ` (also ` or the
 * ` (under the run's complete isolation …)` note) or a clause of
 * the verdict's `(also …; …)` list. Group 1 is the account id the phrase
 * names, if any.
 */
const unplacedAccount = new RegExp(
  `(?:${escapeRegExp(AWS_UNKNOWN_ACCOUNT_TEXT)}|account (\\d{12})${escapeRegExp(AWS_NOT_PERSONAL_TEXT)})(?=$|[;)]| \\(also | \\(under )`,
  "g"
);

/**
 * The unplacedAccount phrases in `reason`, by offset; text it quotes in
 * backticks (a command) holds none. A reason with an unpaired backtick (one in
 * the quoted command, or a quote clipped off) can't be told apart from its
 * quotes, so none are read.
 */
function accountPhrases(reason: string): Array<{ index: number; length: number; id: string | undefined }> {
  if ((reason.match(/`/g)?.length ?? 0) % 2 !== 0) return [];
  const masked = reason.replace(/`[^`]*`/g, (quoted) => "\u0000".repeat(quoted.length));
  return [...masked.matchAll(unplacedAccount)].map((m) => ({ index: m.index, length: m[0].length, id: m[1] }));
}

/**
 * The hook's hold, relabelled `personal-aws` (Persona-decidable) when the only
 * thing that made it owner-only is an account the hook couldn't see was
 * personal:
 * - the launch's floor config was built before the collector's allowlist named
 *   the account: the hook bakes its config in at launch
 *   (buildLaunchFloorConfig), so a worker launched before
 *   STANDUP_PERSONAL_AWS_ACCOUNTS gained an account still holds that account's
 *   calls as owner-only `aws`;
 * - the command doesn't name the account, and the credentials it runs with
 *   (`credentialAccounts`, resolved by classifyWithCredentials) belong to a
 *   listed one: the hook never resolves credentials.
 *
 * That is the case when the hook's hold is an owner-only `aws` one, the
 * collector's verdict (`server`, under its current `config` and resolved
 * credentials) isn't owner-only, and the same call classified with no personal
 * accounts and no resolved credentials yields exactly the hook's hold
 * (category, reason and step), so the hook saw what the collector sees short of
 * the accounts. An account on the non-prod list (FloorConfig.nonProdAwsAccounts)
 * is relabelled the same way, as `nonprod-aws`. Any other hold is returned as is.
 * The relabelled reason keeps the hook's description of the step with the
 * account placed (unplacedAccount), so a signed request or an operation the
 * hook couldn't read is not presented as a change.
 */
export function personalAccountHold(
  client: FloorHold,
  call: FloorCall,
  config: FloorConfig,
  server: FloorVerdict,
  credentialAccounts: readonly string[] = [],
  classify: (call: FloorCall, config: FloorConfig) => FloorVerdict = (c, cfg) => classifyToolCall(c, cfg, { awsAccount: () => null })
): FloorHold {
  const nonProd = config.nonProdAwsAccounts ?? [];
  if (client.category !== "aws" || (config.personalAwsAccounts.length === 0 && nonProd.length === 0)) return client;
  if (server.action === "hold" && ownerOnly(server)) return client;
  const unlisted = classify(call, { ...config, personalAwsAccounts: [], nonProdAwsAccounts: [] });
  if (
    unlisted.action !== "hold" ||
    unlisted.category !== "aws" ||
    unlisted.reason.slice(0, MAX_HOLD_TEXT) !== client.reason ||
    unlisted.step.slice(0, MAX_HOLD_TEXT) !== client.step
  ) {
    return client;
  }
  // The accounts the hook's reason names as not personal; an id elsewhere in it (a quoted command, an ARN) names none.
  const phrases = accountPhrases(client.reason);
  const notPersonal = phrases.flatMap((p) => (p.id === undefined ? [] : [p.id]));
  const relabel = (accounts: readonly string[], kind: "personal" | "non-prod", category: FloorCategory): FloorHold | null => {
    const named = accounts.filter((a) => notPersonal.includes(a));
    const resolved = accounts.filter((a) => !named.includes(a) && credentialAccounts.includes(a));
    const held = [...named, ...resolved];
    if (held.length === 0) return null;
    const why: string[] = [];
    if (named.length > 0) why.push(`this worker's floor was set up before the collector listed it as ${kind}`);
    if (resolved.length > 0) why.push("the command doesn't name the account; the credentials it runs with belong to it");
    // The hook's own account of what the step does (a signed request it can't read, an operation it can't name), with the account placed.
    const where = `${kind} ${held.length === 1 ? "account" : "accounts"} ${held.join(", ")}`;
    let placed = client.reason;
    for (const { index, length, id } of [...phrases].reverse()) {
      const text =
        id === undefined
          ? resolved.length > 0 ? `${kind} ${resolved.length === 1 ? "account" : "accounts"} ${resolved.join(", ")}` : null
          : held.includes(id) ? `${kind} account ${id}` : null;
      if (text !== null) placed = placed.slice(0, index) + text + placed.slice(index + length);
    }
    return {
      category,
      ownerOnly: false,
      // A reason clipped before its account phrase is quoted whole, with the account beside it.
      reason: `${placed !== client.reason ? placed : `the hook held a step in ${where}: ${client.reason}`}; ${why.join(", and ")}, so its hook held the call`,
      step: client.step,
      ...(client.ownerReserved ? { ownerReserved: true } : {}),
    };
  };
  return relabel(config.personalAwsAccounts, "personal", "personal-aws") ?? relabel(nonProd, "non-prod", "nonprod-aws") ?? client;
}

/**
 * Whether the hook's hold stood only for a job root it couldn't know of: the
 * launch's floor config is baked in at launch (buildLaunchFloorConfig), so a
 * worktree another launch of the same Persona job made later is outside the
 * hook's own ground. That is the case when the collector, reading the job's
 * roots afresh (serverFloorConfig), allows the call, the hold is neither
 * owner-only nor owner-reserved, and the same call classified with no job
 * roots yields exactly the hook's hold (category, reason and step), so the
 * hook saw what the collector sees short of those roots.
 */
export function jobRootHoldLifted(
  client: FloorHold,
  call: FloorCall,
  config: FloorConfig,
  server: FloorVerdict,
  classify: (call: FloorCall, config: FloorConfig) => FloorVerdict = (c, cfg) => classifyToolCall(c, cfg, { awsAccount: () => null })
): boolean {
  if (!config.jobRoots?.length || server.action !== "allow" || ownerOnly(client) || client.ownerReserved) return false;
  const without = classify(call, { ...config, jobRoots: [] });
  return (
    without.action === "hold" &&
    without.category === client.category &&
    without.reason.slice(0, MAX_HOLD_TEXT) === client.reason &&
    without.step.slice(0, MAX_HOLD_TEXT) === client.step
  );
}

/** The client's hold, read defensively: an unknown category is unclassified, texts are clipped. */
function readHold(raw: unknown): FloorHold | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const h = raw as Record<string, unknown>;
  const category = typeof h.category === "string" && CATEGORIES.has(h.category as FloorCategory)
    ? (h.category as FloorCategory)
    : "unclassified";
  const text = (v: unknown) => (typeof v === "string" ? v.slice(0, MAX_HOLD_TEXT) : "");
  return {
    category,
    ownerOnly: h.ownerOnly === true,
    reason: text(h.reason) || "held by the safety floor",
    step: text(h.step),
    ...(h.ownerReserved === true ? { ownerReserved: true } : {}),
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * Times out pending floor holds whose waiter's deadline (its wait plus
 * FLOOR_WATCHDOG_MARGIN_S) has passed, or that record none. The collector runs
 * this on start: such a hold's hook has already denied and exited, and a late
 * allow must not sit on the row for a re-attach to read. Returns the ids.
 */
export function sweepExpiredFloorHolds(db: Database, now: Date = new Date()): string[] {
  return timeoutExpiredGatedAsks(db, [FLOOR_GATE, FLOOR_OWNER_GATE], now);
}

export function mountFloorRoutes(app: Hono, opts: FloorRoutesOptions): void {
  const { db } = opts;
  const log = opts.log ?? ((line: string) => console.log(line));
  const waitCap = opts.waitCapSeconds ?? floorWaitSeconds(process.env.STANDUP_FLOOR_WAIT_S);
  const secrets = () => opts.secrets ?? activeOwnerSecrets();
  const drainSignal = opts.drainSignal ?? processDrain.signal;

  /**
   * Hook traffic per session and request id (trafficKey), counted from the
   * moment a request carries its launch's worker token: how many of its
   * requests are in progress here, and a generation that every arrival and
   * departure bumps. A lapse scheduled at one generation acts only if nothing
   * came or went since.
   */
  const traffic = new Map<string, { inFlight: number; generation: number; askId?: string }>();
  const trafficKey = (sessionId: string, requestId: string) => `${sessionId}\n${requestId}`;
  const trafficOf = (key: string) => {
    let t = traffic.get(key);
    if (!t) {
      t = { inFlight: 0, generation: 0 };
      traffic.set(key, t);
    }
    return t;
  };

  /**
   * Times out hold `askId` when it is still pending: its hook is gone, so the
   * hold and its card lapse now rather than at the hold's deadline. A
   * draining collector leaves it for the next leader's re-attach. An
   * acceptance criterion's hold has no waiter and is never timed out this way.
   */
  const lapseUnwaited = (askId: string, why: string): void => {
    try {
      if (drainSignal.aborted) return;
      if (getFloorAskState(db, askId)?.requestId?.startsWith("criterion:")) return;
      const ask = getAsk(db, askId);
      if (!ask || !isFloorGate(ask.gate) || !timeoutPendingAsk(db, askId)) return;
      log(`[floor] timed out ask=${askId} session=${ask.sessionId}: ${why}`);
      announceAskTimedOut(db, opts.broadcast, ask);
    } catch (err) {
      log(`[floor] timing out ask=${askId} failed: ${(err as Error).message}`);
    }
  };

  /**
   * After `graceMs`, lapses hold `askId` unless a request for traffic `key`
   * is in progress or has come or gone since `generation` (the generation
   * then owns its own lapse).
   */
  const scheduleLapse = (askId: string, key: string, generation: number, graceMs: number, why: string): void => {
    const timer = setTimeout(() => {
      const t = traffic.get(key);
      if ((t?.generation ?? 0) !== generation || (t?.inFlight ?? 0) > 0) return;
      traffic.delete(key);
      lapseUnwaited(askId, why);
    }, graceMs);
    timer.unref?.();
  };

  // Holds the previous collector raised wait for their hooks to re-attach
  // here; one whose hook hasn't come back by the time the hook would have
  // given up has nobody left to tell.
  for (const inherited of getPendingAsks(db).filter((a) => isFloorGate(a.gate))) {
    const requestId = getFloorAskState(db, inherited.id)?.requestId;
    if (!requestId || requestId.startsWith("criterion:")) continue;
    scheduleLapse(
      inherited.id,
      trafficKey(inherited.sessionId, requestId),
      0,
      opts.bootReattachGraceMs ?? FLOOR_BOOT_REATTACH_GRACE_MS,
      "its hook didn't re-attach after the collector restarted"
    );
  }

  /** The decision an ask's current row carries once it is no longer pending. */
  const decided = (ask: Ask): FloorHoldResponse => {
    if (ask.status === "answered") {
      const answer = ask.answer ?? "";
      return { decision: floorAnswerAllows(answer) ? "allow" : "deny", askId: ask.id, answer };
    }
    return { decision: "deny", askId: ask.id, answer: "", ...(ask.status === "timeout" ? { timed_out: true } : {}) };
  };

  /** What the reply's signature binds it to: the hook's request and the call it is for. */
  interface HoldRef {
    requestId: string;
    callHash: string;
    /** The call and the hook's own hold, as this request names them: an allow is checked against them again (releaseRefusal). */
    call: FloorCall;
    hold: FloorHold;
  }

  /** `reply`, or a deny when it is an allow `ask` may no longer release (releaseRefusal). */
  const checkedRelease = async (ask: Ask, ref: HoldRef, reply: FloorHoldResponse): Promise<FloorHoldResponse> => {
    if (reply.decision !== "allow") return reply;
    let why: string | null;
    try {
      why = await releaseRefusal(ask, ref.call, ref.hold);
    } catch (err) {
      why = `the call couldn't be classified again before its release (${(err as Error).message})`;
    }
    if (why === null) return reply;
    log(`[floor] ask=${ask.id} session=${ask.sessionId}: allow not released: ${why}`);
    return { decision: "deny", askId: ask.id, answer: "", reason: why };
  };

  /**
   * Sends `reply` signed. An allow is claimed first: only the first reply of a
   * hold's allow carries it; any later one is a deny that says it was used.
   */
  const send = (c: Context, ask: Ask, ref: HoldRef, reply: FloorHoldResponse) => {
    let out = reply;
    if (out.decision === "allow" && !claimFloorAllowDelivery(db, ask.id)) {
      out = { decision: "deny", askId: ask.id, answer: "", reason: "its allow was already used once; raise the call again to ask anew" };
      log(`[floor] ask=${ask.id} session=${ask.sessionId}: allow already delivered, denying the repeat`);
    }
    const signature = signFloorReply(secrets().replyPrivateKey, {
      requestId: ref.requestId,
      askId: out.askId,
      decision: out.decision,
      answer: out.answer,
      callHash: ref.callHash,
    });
    return c.json({ ...out, signature });
  };

  /**
   * Long-polls the hold for its hook and replies with the decision. A hook
   * that disconnects gets no reply (an allow isn't spent on a closed
   * connection): it has FLOOR_ABANDON_GRACE_MS from its last request ending
   * to re-attach under the same request id, after which the hold times out
   * (see the hold route's departure).
   */
  const waitAndReply = async (c: Context, ask: Ask, ref: HoldRef, waitSeconds: number) => {
    trafficOf(trafficKey(ask.sessionId, ref.requestId)).askId = ask.id;
    const result = await waitForAskResolution(db, ask.id, waitSeconds, drainSignal, c.req.raw.signal);
    if (result.abandoned) {
      log(`[floor] ask=${ask.id} session=${ask.sessionId}: the hook disconnected`);
      return c.json({ error: "the hook disconnected" }, 400);
    }
    const row = getAsk(db, ask.id);
    if (row?.status === "timeout" && result.timedOut) announceAskTimedOut(db, opts.broadcast, row);
    const reply: FloorHoldResponse = row
      ? await checkedRelease(row, ref, decided(row))
      : { decision: "deny", askId: ask.id, answer: "", timed_out: true };
    log(
      `[floor] decision ask=${ask.id} session=${ask.sessionId} ${reply.decision}${reply.timed_out ? " (timed out)" : ""}${reply.answer ? ` answer=${JSON.stringify(reply.answer)}` : ""}`
    );
    return send(c, ask, ref, reply);
  };

  app.post(FLOOR_HOLD_ROUTE, async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!isRecord(body)) return c.json({ error: "body must be a JSON object" }, 400);
    const requestId = typeof body.request_id === "string" ? body.request_id.trim() : "";
    const toolName = typeof body.tool_name === "string" ? body.tool_name : "";
    const cwd = typeof body.cwd === "string" ? body.cwd : "";
    const hold = readHold(body.hold);
    if (!requestId || !toolName || !cwd || !isRecord(body.tool_input) || !hold) {
      return c.json({ error: "request_id, tool_name, tool_input, cwd and hold are required" }, 400);
    }
    // The question names the tool; a name of any other shape could spell the question's own lines.
    if (!FLOOR_TOOL_NAME.test(toolName)) return c.json({ error: "tool_name is not a tool's name" }, 400);
    // The hook counts as here once holdCall authenticates it (arrive), so a
    // request for someone else's session can't hold off that hold's lapse.
    // When its last request here ends, it has the abandon grace to come back.
    const arrival: { key?: string } = {};
    try {
      return await holdCall(c, body, body.tool_input, requestId, toolName, cwd, hold, arrival);
    } finally {
      if (arrival.key) depart(arrival.key);
    }
  });

  /** Counts an authenticated request for traffic `key` in. */
  const arrive = (arrival: { key?: string }, key: string): void => {
    const t = trafficOf(key);
    t.inFlight++;
    t.generation++;
    arrival.key = key;
  };

  /** Counts a request for traffic `key` out; the last one out starts its hold's abandon grace. */
  const depart = (key: string): void => {
    const t = trafficOf(key);
    t.inFlight--;
    t.generation++;
    if (t.inFlight > 0) return;
    if (t.askId) {
      scheduleLapse(t.askId, key, t.generation, opts.abandonGraceMs ?? FLOOR_ABANDON_GRACE_MS, "its hook disconnected and didn't re-attach");
    } else {
      traffic.delete(key);
    }
  };

  /**
   * The hold the ask for `call` carries (stricterHold of the hook's `hold`
   * and the collector's own classification under the launch's current
   * config), and whether the floor lets it pass itself: a model invoke in a
   * personal account, or a hold only a job root made after the launch caused.
   */
  async function heldFor(
    launch: Launch,
    sessionId: string,
    call: FloorCall,
    hold: FloorHold
  ): Promise<{ held: FloorHold; personalInvoke: boolean; jobRootLifted: boolean }> {
    let verdict: FloorVerdict;
    let clientHold = hold;
    let personalInvoke = false;
    let jobRootLifted = false;
    try {
      const config = serverFloorConfig(db, launch, {
        collectorUrl: opts.collectorUrl,
        standupDataDir: opts.standupDataDir,
      });
      const server = await classifyWithCredentials(call, config, opts.awsIdentity ?? collectorAwsIdentity);
      verdict = server.verdict;
      clientHold = personalAccountHold(hold, call, config, verdict, server.credentialAccounts);
      // An invoke in a personal account always passes: when the hook held the call only for an account it couldn't see, it runs.
      personalInvoke = server.invokesOnly && clientHold !== hold && clientHold.category === "personal-aws" && !clientHold.ownerReserved;
      jobRootLifted = !personalInvoke && jobRootHoldLifted(hold, call, config, verdict);
    } catch (err) {
      // The collector couldn't read the call either; the hook's hold stands.
      log(`[floor] re-classification failed for session ${sessionId}: ${(err as Error).message}`);
      verdict = { action: "hold", ...hold };
    }
    return { held: stricterHold(clientHold, verdict), personalInvoke, jobRootLifted };
  }

  /**
   * Why an allow of `ask` must not release `call` now, or null when it may:
   * the floor's checks of the files the call runs against (a scratch root
   * that isn't a link, no env file, where a token file lies, what code it
   * loads) ran when it was held, and may read otherwise by the time it is
   * allowed. The call is classified again as it was then (heldFor, with the
   * hook's `hold`), and an ask whose question that no longer writes is the
   * question for another call: its allow is not delivered.
   */
  async function releaseRefusal(ask: Ask, call: FloorCall, hold: FloorHold): Promise<string | null> {
    const launch = getLaunchBySession(db, ask.sessionId);
    if (!launch) return "its session has no launch the safety floor guards";
    const now = await heldFor(launch, ask.sessionId, call, hold);
    if (floorQuestion(call, now.held) === ask.question) return null;
    return "the call no longer classifies as it did when it was held (what it runs against changed since); raise it again to be held anew";
  }

  async function holdCall(
    c: Context,
    body: Record<string, unknown>,
    toolInput: Record<string, unknown>,
    requestId: string,
    toolName: string,
    cwd: string,
    hold: FloorHold,
    arrival: { key?: string }
  ) {
    const sessionId = typeof body.session_id === "string" ? body.session_id : undefined;
    const launchId = typeof body.launch_id === "string" ? body.launch_id : undefined;
    const requested = typeof body.wait_s === "number" && body.wait_s > 0 ? body.wait_s : waitCap;
    const waitSeconds = Math.min(requested, waitCap);

    const session = opts.resolveCallingSession(sessionId, cwd);
    if (!session) return c.json({ error: `No active session found for cwd "${cwd}"` }, 400);

    // A hold attaches only to the launch the session itself belongs to; a
    // launch id in the body never stands in for a session with no launch row.
    const launch = getLaunchBySession(db, session.id);
    if (!launch) return c.json({ error: `session ${session.id} has no launch the safety floor guards` }, 400);
    if (launchId !== launch.id) {
      return c.json({ error: `this hold names launch ${launchId ?? "(none)"}, but session ${session.id} runs under launch ${launch.id}` }, 403);
    }
    const expectedHash = getLaunchWorkerTokenHash(db, launch.id);
    const presented = c.req.header(FLOOR_WORKER_TOKEN_HEADER)?.trim();
    if (!expectedHash || !presented || !tokenMatches(workerTokenHash(presented), expectedHash)) {
      log(`[floor] refused a hold for launch ${launch.id}: missing or wrong worker token`);
      return c.json({ error: `a hold for launch ${launch.id} must carry that launch's worker token` }, 403);
    }
    arrive(arrival, trafficKey(session.id, requestId));

    // The session id the hook classified with, when it is the session the hold resolved to.
    const call: FloorCall = { toolName, toolInput, cwd, ...(sessionId === session.id ? { sessionId } : {}) };
    const ref: HoldRef = { requestId, callHash: floorCallHash(call), call, hold };

    // Re-attach: the hook retries with the same request id after the
    // collector restarts, and must wait on (or read) the ask it already has.
    const existing = getAskByRequestId(db, session.id, requestId);
    if (existing) return reattach(c, existing, ref, waitSeconds);

    const { held, personalInvoke, jobRootLifted } = await heldFor(launch, session.id, call, hold);
    const gate = held.ownerOnly ? FLOOR_OWNER_GATE : FLOOR_GATE;
    const question = floorQuestion(call, held);

    let ask: Ask;
    try {
      ask = createAsk(db, session.id, "ask_human", question, [...FLOOR_OPTIONS], {
        gate,
        requestId,
        callHash: ref.callHash,
        floorExpiresAt: new Date(Date.now() + (waitSeconds + FLOOR_WATCHDOG_MARGIN_S) * 1000),
      });
    } catch (err) {
      // A concurrent retry of the same call won the unique (session, request_id) insert.
      const raced = getAskByRequestId(db, session.id, requestId);
      if (raced) return reattach(c, raced, ref, waitSeconds);
      throw err;
    }
    if (personalInvoke || jobRootLifted) {
      // Recorded as an answered ask for the audit trail; no card is raised.
      resolveAsk(db, ask.id, FLOOR_ALLOW_OPTION, personalInvoke ? PERSONAL_INVOKE_ANSWERER : JOB_ROOT_ANSWERER);
      const why = personalInvoke ? "model invokes in a personal account" : "in a worktree of this worker's own Persona job";
      log(`[floor] allowed ask=${ask.id} session=${session.id}: ${why} step=${JSON.stringify(held.step.slice(0, 200))}`);
      return send(c, ask, ref, decided(getAsk(db, ask.id) ?? ask));
    }
    log(
      `[floor] hold ask=${ask.id} session=${session.id} gate=${gate} category=${held.category} tool=${toolName} step=${JSON.stringify(held.step.slice(0, 200))}`
    );

    updateSessionStatus(db, session.id, "waiting");
    // A hold on a Persona job's worker goes to Persona first; the owner hears
    // of it when Persona escalates, or on their card once Persona's allow of
    // it is blocked.
    const timestamp = new Date().toISOString();
    opts.broadcast({ type: "ask:new", payload: ask, timestamp });
    opts.broadcast({ type: "session:status", payload: { sessionId: session.id, status: "waiting" }, timestamp });
    if (!opts.personaHandles(session.id)) opts.notifyOwner(session, question);

    return waitAndReply(c, ask, ref, waitSeconds);
  }

  async function reattach(c: Context, ask: Ask, ref: HoldRef, waitSeconds: number) {
    if (!isFloorGate(ask.gate)) {
      return c.json({ error: `request ${ask.id} belongs to an ask the safety floor did not raise` }, 409);
    }
    const state = getFloorAskState(db, ask.id);
    if (!state?.callHash || state.callHash !== ref.callHash) {
      log(`[floor] refused a re-attach to ask=${ask.id} session=${ask.sessionId}: a different call`);
      return c.json({ error: `request ${ref.requestId} was raised for a different tool call; a re-attach must repeat the same call` }, 409);
    }
    opts.onReattached?.(ask.id);
    if (ask.status !== "pending") {
      const reply = await checkedRelease(ask, ref, decided(ask));
      log(`[floor] re-attached ask=${ask.id} session=${ask.sessionId}: already ${ask.status}, ${reply.decision}`);
      return send(c, ask, ref, reply);
    }
    // A re-attach waits no longer than the hold's own wait: past it the hold
    // times out, so a late answer can't sit on a row nobody is waiting for.
    const remaining = state.expiresAt
      ? (state.expiresAt.getTime() - Date.now()) / 1000 - FLOOR_WATCHDOG_MARGIN_S
      : waitSeconds;
    log(`[floor] re-attached ask=${ask.id} session=${ask.sessionId}: waiting`);
    return waitAndReply(c, ask, ref, Math.max(0, Math.min(waitSeconds, remaining)));
  }
}
