#!/usr/bin/env bun
/**
 * Slack streaming probe — answers the ONE question that gates the whole Slack streaming design:
 *
 *   Does *your* Slack workspace expose the `chat.startStream` / `chat.appendStream` /
 *   `chat.stopStream` streaming API to *your* app, and does it accept the plan-mode
 *   task-card chunks (`task_display_mode:"plan"`, `task_update`) that map so cleanly
 *   onto Standup's tool-use lifecycle?
 *
 * If yes  → build the rich, streamed task-card UI on the chat.*Stream API.
 * If no   → fall back to `chat.postMessage` + `chat.update` on one message (universal, simpler).
 *
 * It runs four independent checks, each gated on the env it needs, and prints a verdict:
 *   A. auth.test            — is the bot token (xoxb) valid? who are we?           [needs SLACK_BOT_TOKEN]
 *   B. Socket Mode connect  — does the websocket handshake work? ("websockets")    [needs SLACK_APP_TOKEN]
 *   C. chat.*Stream         — THE Q1 answer: basic stream, then plan-mode cards    [needs bot token + channel]
 *   D. postMessage+update   — does the universal fallback path work?               [needs bot token + channel]
 *
 * Run:  bun run --filter @standup/slack probe     (or: cd packages/slack && bun run probe)
 * Env:  copy packages/slack/.env.example → packages/slack/.env and fill in tokens + a scratch channel.
 *
 * Nothing here touches the collector or the DB — it is a pure, read-mostly diagnostic that
 * posts a couple of clearly-labelled test messages into the scratch channel you point it at.
 */

import { WebClient } from "@slack/web-api";
import { loadEnv, maskToken, looksLikeToken, type SlackEnv } from "./env.js";

// ---------------------------------------------------------------------------
// Small output + call helpers
// ---------------------------------------------------------------------------

const OK = "✅";
const NO = "❌";
const WARN = "⚠️ ";
const SKIP = "⏭️ ";

function heading(title: string): void {
  console.log(`\n${"─".repeat(72)}\n${title}\n${"─".repeat(72)}`);
}

/** Normalized result of a Web API call — WebClient rejects on `ok:false`, so we unify both paths. */
interface CallResult {
  ok: boolean;
  error?: string;
  /** The full response body (on success) or `err.data` (on a platform error) — carries needed/provided. */
  data: Record<string, unknown>;
}

async function call(web: WebClient, method: string, args: Record<string, unknown>): Promise<CallResult> {
  try {
    const data = (await web.apiCall(method, args)) as unknown as Record<string, unknown>;
    return { ok: data.ok === true, error: data.ok ? undefined : String(data.error), data };
  } catch (err) {
    const e = err as { data?: Record<string, unknown>; message?: string };
    if (e.data && typeof e.data === "object") {
      return { ok: false, error: String(e.data.error ?? e.message ?? "unknown"), data: e.data };
    }
    return { ok: false, error: e.message ?? String(err), data: {} };
  }
}

/** Turn a Slack error code into a concrete, actionable next step. */
function explain(error: string | undefined, data: Record<string, unknown>): string {
  switch (error) {
    case "unknown_method":
    case "method_not_supported":
    case "method_deprecated":
      return "This streaming method is NOT exposed to your app/workspace → use the chat.update fallback.";
    case "missing_scope":
      return `Missing an OAuth scope. needed=${String(data.needed ?? "?")} provided=${String(data.provided ?? "?")} — add it in the app config and reinstall.`;
    case "not_allowed_token_type":
      return "Wrong token type. The streaming API likely requires the app be configured as an Agent/AI app (enable 'Agents & AI Apps' + assistant:write), and/or a different token.";
    case "invalid_thread_ts":
    case "thread_not_found":
    case "message_not_found":
      return "chat.startStream streams a reply INSIDE a thread, so it needs a valid thread_ts — this means the METHOD IS AVAILABLE, the call just lacked a real parent message. The probe now auto-creates one.";
    case "missing_recipient_team_id":
    case "missing_recipient_user_id":
    case "invalid_recipient":
      return "chat.startStream needs a recipient_* param — again a PARAMETER requirement, so the method is available to this app. The probe now passes recipient_team_id from auth.test.";
    case "channel_not_found":
      return "SLACK_PROBE_CHANNEL is wrong or the bot can't see it. Use the channel ID (starts with C/D/G), not the name.";
    case "not_in_channel":
      return "The bot isn't in that channel. Invite it: `/invite @your-bot` in the channel, then re-run.";
    case "invalid_auth":
    case "account_inactive":
    case "token_revoked":
    case "token_expired":
      return "The bot token is invalid/expired. Re-copy SLACK_BOT_TOKEN (xoxb-…) from the app's OAuth page.";
    case "no_permission":
    case "restricted_action":
      return "The app is installed but lacks permission for this action — check scopes / workspace policy.";
    case undefined:
      return "";
    default:
      return "Unrecognized error — see the raw Slack response above.";
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_resolve, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

// ---------------------------------------------------------------------------
// Check A — auth.test (bot token)
// ---------------------------------------------------------------------------

interface AuthInfo {
  botUserId?: string;
  teamId?: string;
  team?: string;
  url?: string;
}

async function checkAuth(web: WebClient): Promise<AuthInfo | null> {
  heading("A. auth.test — validate the bot token (xoxb) and identify the app");
  const r = await call(web, "auth.test", {});
  if (!r.ok) {
    console.log(`${NO} auth.test failed: ${r.error}`);
    const hint = explain(r.error, r.data);
    if (hint) console.log(`   → ${hint}`);
    return null;
  }
  const info: AuthInfo = {
    botUserId: r.data.user_id as string | undefined,
    teamId: r.data.team_id as string | undefined,
    team: r.data.team as string | undefined,
    url: r.data.url as string | undefined,
  };
  console.log(`${OK} Bot token valid.`);
  console.log(`   team=${info.team} (${info.teamId})  workspace=${info.url}`);
  console.log(`   bot_user_id=${info.botUserId}  bot=${String(r.data.user)}`);
  console.log(`   (bot_user_id is the id you'll compare against for the self-loop filter later.)`);
  return info;
}

// ---------------------------------------------------------------------------
// Check B — Socket Mode handshake (app token)
// ---------------------------------------------------------------------------

async function checkSocketMode(appToken: string): Promise<void> {
  heading("B. Socket Mode — open the outbound websocket ('websockets') with the app token (xapp)");
  // Dynamic import so the whole probe can still run (checks A/C/D) if this dep or token is absent.
  const { SocketModeClient } = await import("@slack/socket-mode");

  // Capture the client's own error logging instead of letting it spew to stdout, so our
  // formatted output is the single source of truth. Present the last one only if it matters.
  const capturedErrors: string[] = [];
  const quietLogger = {
    debug() {},
    info() {},
    warn() {},
    error(...args: unknown[]) {
      capturedErrors.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(" "));
    },
    getLevel() {
      return "error";
    },
    setLevel() {},
    setName() {},
  };

  const sm = new SocketModeClient({
    appToken,
    autoReconnectEnabled: false,
    logger: quietLogger as unknown as never,
  });

  // Two DISTINCT milestones — don't conflate them (that was the bug: resolving on
  // `authenticated` then disconnecting aborted the still-connecting WebSocket):
  //   authenticated → apps.connections.open returned a URL (token + config are valid)
  //   connected     → the actual WSS upgrade to wss-primary.slack.com completed
  const authed = new Promise<void>((resolve) => sm.on("authenticated", () => resolve()));
  const connected = new Promise<void>((resolve) => sm.on("connected", () => resolve()));

  const startP = sm.start();
  startP.catch(() => {}); // late WS failures surface via the logger + the connected-timeout below

  try {
    // Stage 1: token accepted? (a bad xapp/disabled Socket Mode fails here)
    await withTimeout(Promise.race([authed, startP.then(() => undefined)]), 10_000, "apps.connections.open");
    console.log(`${OK} App-level token accepted — apps.connections.open OK (connections:write + Socket Mode enabled).`);
  } catch (err) {
    const e = err as { data?: Record<string, unknown>; message?: string };
    const error = e.data ? String(e.data.error) : e.message;
    console.log(`${NO} Socket Mode auth failed: ${error}`);
    if (e.data?.error === "not_allowed_token_type" || e.data?.error === "invalid_auth") {
      console.log(`   → SLACK_APP_TOKEN must be an app-level token (xapp-…) with connections:write, and Socket Mode`);
      console.log(`     must be enabled in the app config. It is NOT the bot (xoxb) token.`);
    } else {
      console.log(`   → Ensure Socket Mode is enabled and the xapp token has connections:write.`);
    }
    try {
      await sm.disconnect();
    } catch {
      /* already down */
    }
    return;
  }

  // Stage 2: does the real WebSocket finish connecting?
  try {
    await withTimeout(connected, 12_000, "WebSocket upgrade");
    console.log(`${OK} WebSocket connected — inbound events will arrive over this socket (no public URL needed).`);
  } catch (err) {
    const msg = (err as { message?: string }).message ?? String(err);
    console.log(`${WARN}Token/config valid, but the WebSocket did not finish connecting (${msg}).`);
    if (capturedErrors.length) console.log(`   client: ${capturedErrors[capturedErrors.length - 1]}`);
    console.log(`   → apps.connections.open succeeded, so tokens + Socket Mode are set up correctly. The WSS upgrade`);
    console.log(`     may be blocked by this network/runtime; the adapter (Bolt, auto-reconnect) can retry. Not fatal to Q1.`);
  } finally {
    try {
      await sm.disconnect();
    } catch {
      /* already down */
    }
  }
}

// ---------------------------------------------------------------------------
// Check C — the chat.*Stream lifecycle (THE Q1 answer)
// ---------------------------------------------------------------------------

/** Result of one streaming attempt, so the verdict can distinguish "no API" from "no plan mode". */
interface StreamOutcome {
  started: boolean;
  appended: boolean;
  stopped: boolean;
  startError?: string;
}

/**
 * Run one full start→append→stop lifecycle. `planMode` toggles the rich task-card variant
 * (task_display_mode:"plan" + a task_update chunk) vs a plain markdown_text stream.
 */
async function runStreamLifecycle(
  web: WebClient,
  channel: string,
  threadTs: string | undefined,
  planMode: boolean,
  teamId: string | undefined,
  recipientUserId: string | undefined,
): Promise<StreamOutcome> {
  const label = planMode ? "plan-mode (task cards)" : "basic (markdown_text)";
  const out: StreamOutcome = { started: false, appended: false, stopped: false };

  // --- start ---
  const startArgs: Record<string, unknown> = { channel };
  if (threadTs) startArgs.thread_ts = threadTs;
  // The assistant streaming API identifies the recipient's workspace + user; on a
  // same-workspace stream the team id is just our own (from auth.test).
  if (teamId) startArgs.recipient_team_id = teamId;
  if (recipientUserId) startArgs.recipient_user_id = recipientUserId;
  if (planMode) {
    startArgs.task_display_mode = "plan";
    startArgs.chunks = [{ type: "plan_update", title: "Standup streaming probe" }];
  }
  const start = await call(web, "chat.startStream", startArgs);
  if (!start.ok) {
    out.startError = start.error;
    console.log(`   ${NO} [${label}] chat.startStream → ${start.error}`);
    const hint = explain(start.error, start.data);
    if (hint) console.log(`      → ${hint}`);
    if (start.error === "invalid_arguments" || start.error === "streaming_mode_mismatch") {
      console.log(`      raw: ${JSON.stringify(start.data).slice(0, 300)}`);
    }
    return out;
  }
  out.started = true;
  const ts = start.data.ts as string;
  console.log(`   ${OK} [${label}] chat.startStream → ts=${ts}`);

  // --- append (ALWAYS via chunks; mixing top-level text + chunks throws streaming_mode_mismatch) ---
  const appendChunks = planMode
    ? [{ type: "task_update", id: "probe-1", title: "Verify streaming works", status: "in_progress" }]
    : [{ type: "markdown_text", text: "Streaming from the Standup Slack probe… " }];
  const append = await call(web, "chat.appendStream", { channel, ts, chunks: appendChunks });
  if (append.ok) {
    out.appended = true;
    console.log(`   ${OK} [${label}] chat.appendStream → chunk accepted`);
    if (planMode) {
      // Transition the same task id in_progress → complete (this is how progress cards update).
      await call(web, "chat.appendStream", {
        channel,
        ts,
        chunks: [{ type: "task_update", id: "probe-1", title: "Verify streaming works", status: "complete" }],
      });
    }
  } else {
    console.log(`   ${NO} [${label}] chat.appendStream → ${append.error}`);
    const hint = explain(append.error, append.data);
    if (hint) console.log(`      → ${hint}`);
  }

  // --- stop ---
  const stop = await call(web, "chat.stopStream", { channel, ts });
  if (stop.ok) {
    out.stopped = true;
    console.log(`   ${OK} [${label}] chat.stopStream → finalized`);
  } else {
    console.log(`   ${WARN}[${label}] chat.stopStream → ${stop.error} (stream may auto-finalize on timeout)`);
  }
  return out;
}

async function checkStreaming(
  web: WebClient,
  channel: string,
  threadTs: string | undefined,
  teamId: string | undefined,
  recipient: { userId: string | undefined; isPlaceholder: boolean },
): Promise<{ basic: StreamOutcome; plan: StreamOutcome }> {
  heading("C. chat.*Stream — THE Q1 answer: is the streaming API available? does plan mode work?");
  console.log(`Target channel: ${channel}${threadTs ? `  thread_ts=${threadTs}` : ""}`);
  if (recipient.userId) {
    console.log(
      `recipient_user_id=${recipient.userId}` +
        (recipient.isPlaceholder
          ? " (placeholder = the bot itself; set SLACK_PROBE_USER to your own U… id to stream to a real person)"
          : " (from SLACK_PROBE_USER)"),
    );
  }
  console.log("");

  // chat.startStream streams a reply *within a thread*, so it needs a valid thread_ts.
  // If the caller didn't supply one, create a parent message to thread the stream under —
  // otherwise startStream rejects with invalid_thread_ts and looks (wrongly) unavailable.
  let rootTs = threadTs;
  if (!rootTs) {
    const root = await call(web, "chat.postMessage", {
      channel,
      text: "🧪 Standup streaming probe — thread root (the stream attaches under this).",
    });
    if (root.ok) {
      rootTs = root.data.ts as string;
      console.log(`Created a probe thread root: ts=${rootTs}\n`);
    } else {
      console.log(`${WARN}Couldn't create a thread root (${root.error}); trying startStream at channel root.\n`);
    }
  }

  console.log("C1. Basic streaming lifecycle (does the API exist at all?)");
  const basic = await runStreamLifecycle(web, channel, rootTs, false, teamId, recipient.userId);

  console.log("\nC2. Plan-mode task cards (the rich UI that maps to tool-use lifecycle)");
  // Only worth attempting if C1 proved the API exists; otherwise the same error just repeats.
  const plan =
    basic.started || basic.startError === "streaming_mode_mismatch"
      ? await runStreamLifecycle(web, channel, rootTs, true, teamId, recipient.userId)
      : (console.log(`   ${SKIP}skipped — basic startStream unavailable, plan mode can't differ.`),
        { started: false, appended: false, stopped: false, startError: basic.startError });

  return { basic, plan };
}

// ---------------------------------------------------------------------------
// Check D — postMessage + update fallback (always-available baseline)
// ---------------------------------------------------------------------------

async function checkFallback(web: WebClient, channel: string, threadTs: string | undefined): Promise<boolean> {
  heading("D. chat.postMessage + chat.update — the universal fallback path");
  const post = await call(web, "chat.postMessage", {
    channel,
    ...(threadTs ? { thread_ts: threadTs } : {}),
    text: "🧪 Standup Slack probe — testing post + edit (fallback streaming path).",
  });
  if (!post.ok) {
    console.log(`${NO} chat.postMessage → ${post.error}`);
    const hint = explain(post.error, post.data);
    if (hint) console.log(`   → ${hint}`);
    return false;
  }
  const ts = post.data.ts as string;
  console.log(`${OK} chat.postMessage → ts=${ts}`);
  const upd = await call(web, "chat.update", {
    channel,
    ts,
    text: "🧪 Standup Slack probe — edited ✅  (post+update works; this is the fallback 'stream'.)",
  });
  if (upd.ok) {
    console.log(`${OK} chat.update → message edited (fallback streaming is viable).`);
    return true;
  }
  console.log(`${NO} chat.update → ${upd.error}`);
  return false;
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

/**
 * True availability blocks — the method is NOT usable by this app. Everything else
 * (invalid_thread_ts, missing_recipient_*, invalid_arguments, streaming_mode_mismatch, …)
 * is a PARAMETER error, which proves the method IS reachable for this app.
 */
const UNAVAILABLE_ERRORS = new Set([
  "unknown_method",
  "method_not_supported",
  "method_deprecated",
  "not_allowed_token_type",
  "missing_scope",
  "no_permission",
  "restricted_action",
  "access_denied",
]);

function verdict(
  stream: { basic: StreamOutcome; plan: StreamOutcome } | null,
  fallbackOk: boolean | null,
): void {
  heading("VERDICT — Q1: does Slack expose chat.*Stream (plan mode) to this app?");

  if (!stream) {
    console.log(`${SKIP}Streaming not tested (missing bot token or SLACK_PROBE_CHANNEL). Set them and re-run.`);
    return;
  }

  const planWorks = stream.plan.started && stream.plan.appended;
  const basicWorks = stream.basic.started && stream.basic.appended;

  if (planWorks) {
    console.log(`${OK} YES — plan-mode task-card streaming is available.`);
    console.log(`   → Build the rich streamed UI on chat.*Stream through @slack/web-api apiCall().`);
    console.log(`     Map PreToolUse→task_update(in_progress), PostToolUse→complete, checkpoint→markdown_text.`);
  } else if (basicWorks) {
    console.log(`${WARN}PARTIAL — chat.*Stream exists, but plan mode / task_update did not take.`);
    console.log(`   → Stream with markdown_text chunks (still real streaming); skip the task-card UI,`);
    console.log(`     or check whether the app must be an Agent/AI app to unlock plan mode.`);
  } else if (stream.basic.startError && !UNAVAILABLE_ERRORS.has(stream.basic.startError)) {
    // A parameter rejection (invalid_thread_ts, missing_recipient_*, …) means the method
    // EXISTS for this app — not an availability block (unknown_method/not_allowed_token_type).
    console.log(`${WARN}REACHABLE — chat.*Stream exists for this app but the call was rejected on parameters (${stream.basic.startError}).`);
    console.log(`   → Not an availability block. Fix the call params (thread_ts + recipient_team_id) and re-run to confirm streaming.`);
  } else {
    const why = stream.basic.startError ? ` (startStream error: ${stream.basic.startError})` : "";
    console.log(`${NO} NO — chat.*Stream is not usable by this app${why}.`);
    if (fallbackOk) {
      console.log(`   → Use the fallback: chat.postMessage once + coalesced chat.update per checkpoint/turn.`);
      console.log(`     Confirmed working below. Mind the ~1 edit/sec/channel rate ceiling; watch message_changed self-loops.`);
    } else if (fallbackOk === false) {
      console.log(`   → And the fallback failed too — fix channel access / chat:write scope first (see check D).`);
    }
  }

  console.log(
    `\nSummary: basic{started=${stream.basic.started},append=${stream.basic.appended},stop=${stream.basic.stopped}} ` +
      `plan{started=${stream.plan.started},append=${stream.plan.appended},stop=${stream.plan.stopped}} ` +
      `fallback=${fallbackOk === null ? "untested" : fallbackOk}`,
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function preflight(env: SlackEnv): void {
  heading("Standup Slack — streaming probe");
  console.log("Env detected:");
  console.log(`  SLACK_BOT_TOKEN     = ${maskToken(env.botToken)}`);
  console.log(`  SLACK_APP_TOKEN     = ${maskToken(env.appToken)}`);
  console.log(`  SLACK_PROBE_CHANNEL = ${env.probeChannel ?? "(unset)"}`);
  console.log(`  SLACK_PROBE_THREAD_TS = ${env.probeThreadTs ?? "(unset — streams at channel root)"}`);

  if (env.botToken && !looksLikeToken(env.botToken, "xoxb-")) {
    console.log(`\n${WARN}SLACK_BOT_TOKEN does not start with 'xoxb-' — is it the bot token? (auth.test will tell.)`);
  }
  if (env.appToken && !looksLikeToken(env.appToken, "xapp-")) {
    console.log(`${WARN}SLACK_APP_TOKEN does not start with 'xapp-' — Socket Mode needs the app-level token.`);
  }
}

async function main(): Promise<void> {
  const env = loadEnv();
  preflight(env);

  if (!env.botToken) {
    console.log(`\n${NO} SLACK_BOT_TOKEN is required for every check. Copy .env.example → .env and fill it in.`);
    console.log(`   See packages/slack/README.md for the app manifest, scopes, and where to get each token.`);
    process.exit(1);
  }

  const web = new WebClient(env.botToken, { retryConfig: { retries: 1 } });

  const auth = await checkAuth(web);
  if (!auth) {
    // Bad bot token → nothing else can succeed. Stop with a clear signal.
    verdict(null, null);
    process.exit(1);
  }

  if (env.appToken) {
    await checkSocketMode(env.appToken);
  } else {
    heading("B. Socket Mode");
    console.log(`${SKIP}Skipped — set SLACK_APP_TOKEN (xapp-…) to test the websocket handshake.`);
  }

  let stream: { basic: StreamOutcome; plan: StreamOutcome } | null = null;
  let fallbackOk: boolean | null = null;
  if (env.probeChannel) {
    // Prefer a real person (SLACK_PROBE_USER); else fall back to the bot's own id just to
    // drive the full lifecycle. The verdict flags which was used.
    const recipient = {
      userId: env.probeUser ?? auth.botUserId,
      isPlaceholder: !env.probeUser,
    };
    stream = await checkStreaming(web, env.probeChannel, env.probeThreadTs, auth.teamId, recipient);
    fallbackOk = await checkFallback(web, env.probeChannel, env.probeThreadTs);
  } else {
    heading("C/D. Streaming + fallback");
    console.log(`${SKIP}Skipped — set SLACK_PROBE_CHANNEL to a scratch channel id (invite the bot first).`);
  }

  verdict(stream, fallbackOk);

  // Explicit exit so a lingering Socket Mode timer or keep-alive can't hold the process open.
  process.exit(0);
}

main().catch((err) => {
  console.error(`\n${NO} Probe crashed:`, err);
  process.exit(1);
});
