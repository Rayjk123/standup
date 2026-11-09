#!/usr/bin/env bun
// End-to-end simulation harness for the Persona ↔ Slack bridge: the REAL
// PersonaBridge and CollectorClient against a running collector, with a
// recording Slack client standing in for Slack and simulated inbound events
// standing in for Bolt. Nothing reaches a real Slack workspace.
//
// Library use (tests, orchestration scripts):
//   const simulator = createPersonaSimulator({ collectorUrl, ownerSlackId: "U_OWNER" });
//   await simulator.start();                  // WS connect + resync
//   await simulator.dm("hello");              // owner DM
//   await simulator.waitForPost((c) => c.args.channel === simulator.dmChannel);
//   simulator.close();
//
// CLI (runs a scripted scenario and prints what was posted to "Slack"):
//   COLLECTOR_URL=http://127.0.0.1:7777 bun run packages/slack/src/persona-simulator.ts
// Env: COLLECTOR_URL, SLACK_WS_URL / WS_PORT (as the adapter), SIMULATOR_OWNER_SLACK
// (default U0SIMOWNER), SIMULATOR_TIMEOUT_MS (default 180000 — a real Persona turn),
// STANDUP_SLACK_PERSONA_STATE (default: a fresh temp file, removed on close).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CollectorClient } from "./collector-client.js";
import { PersonaBridge } from "./persona-bridge.js";
import { PersonaThreadStore } from "./persona-store.js";
import type { SlackApi, SlackCallResult } from "./stream-client.js";
import { loadEnv } from "./env.js";

export interface RecordedCall {
  method: string;
  args: Record<string, unknown>;
}

export interface RecordingSlackOptions {
  /** Methods (or the pseudo-scope `username` for chat:write.customize) answered with missing_scope. */
  missingScopes?: Iterable<string>;
  /** Answer any post carrying a `markdown` block with invalid_blocks. */
  rejectMarkdown?: boolean;
  /** Seed thread history: `<channel>:<thread_ts>` → messages (oldest first). */
  threads?: Record<string, Record<string, unknown>[]>;
  /** users.info names by id. */
  users?: Record<string, string>;
  /** conversations.info by channel id: its name, or its name and whether it's a Slack Connect channel. */
  channels?: Record<string, string | { name: string; external?: boolean }>;
  /** Base for generated message ts, so they sort after seeded history. */
  tsBase?: number;
  /** files.info file objects by file id (snake_case, as Slack returns them). */
  files?: Record<string, Record<string, unknown>>;
}

/**
 * A Slack Web API stand-in that records every call and answers like Slack:
 * posts get increasing ts and land in the thread history (so later
 * conversations.replies see them), DMs open as `D-<user>`, permalinks are
 * synthesized. Scope gaps and markdown rejection are switchable.
 */
export class RecordingSlack implements SlackApi {
  readonly calls: RecordedCall[] = [];
  private readonly missing: Set<string>;
  private readonly threads = new Map<string, Record<string, unknown>[]>();
  private seq = 0;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly opts: RecordingSlackOptions = {}) {
    this.missing = new Set(opts.missingScopes ?? []);
    for (const [k, v] of Object.entries(opts.threads ?? {})) this.threads.set(k, [...v]);
  }

  /** Mint a ts for a simulated inbound message (sorted after everything so far). */
  nextTs(): string {
    return `${this.opts.tsBase ?? 1700000000}.${String(++this.seq).padStart(6, "0")}`;
  }

  /** Append a simulated message to a thread's history. */
  addToThread(channel: string, threadTs: string, message: Record<string, unknown>): void {
    const key = `${channel}:${threadTs}`;
    const list = this.threads.get(key) ?? [];
    list.push(message);
    this.threads.set(key, list);
  }

  of(method: string): RecordedCall[] {
    return this.calls.filter((c) => c.method === method);
  }

  /** Resolves on the next recorded call (for polling waits). */
  nextCall(): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        this.listeners.delete(done);
        resolve();
      };
      this.listeners.add(done);
    });
  }

  async call(method: string, args: Record<string, unknown>): Promise<SlackCallResult> {
    this.calls.push({ method, args });
    for (const l of [...this.listeners]) l();
    const fail = (error: string): SlackCallResult => ({ ok: false, error, data: { ok: false, error } });
    if (this.missing.has(method)) return fail("missing_scope");
    switch (method) {
      case "chat.postMessage": {
        if (args.username !== undefined && this.missing.has("username")) return fail("missing_scope");
        const blocks = args.blocks as { type?: string }[] | undefined;
        if (this.opts.rejectMarkdown && blocks?.some((b) => b.type === "markdown")) return fail("invalid_blocks");
        const ts = this.nextTs();
        const channel = String(args.channel);
        const threadTs = typeof args.thread_ts === "string" ? args.thread_ts : ts;
        this.addToThread(channel, threadTs, { ts, user: "U_BOT", bot_id: "B_BOT", text: args.text, thread_ts: threadTs });
        return { ok: true, ts, data: { ok: true, ts, channel } };
      }
      case "conversations.open": {
        const id = `D-${String(args.users)}`;
        return { ok: true, data: { ok: true, channel: { id } } };
      }
      case "conversations.replies": {
        const list = this.threads.get(`${String(args.channel)}:${String(args.ts)}`) ?? [];
        const oldest = typeof args.oldest === "string" ? Number(args.oldest) : undefined;
        const messages = list.filter((m) => oldest === undefined || Number(m.ts) > oldest || m.ts === args.ts);
        return { ok: true, data: { ok: true, messages, has_more: false } };
      }
      case "conversations.info": {
        const info = this.opts.channels?.[String(args.channel)];
        if (!info) return fail("missing_scope");
        const { name, external } = typeof info === "string" ? { name: info, external: false } : info;
        return { ok: true, data: { ok: true, channel: { id: args.channel, name, is_ext_shared: !!external } } };
      }
      case "users.info": {
        const name = this.opts.users?.[String(args.user)];
        return name
          ? { ok: true, data: { ok: true, user: { id: args.user, name, profile: { display_name: name } } } }
          : fail("user_not_found");
      }
      case "chat.getPermalink":
        return {
          ok: true,
          data: { ok: true, permalink: `https://slack.test/archives/${String(args.channel)}/p${String(args.message_ts).replace(".", "")}` },
        };
      case "files.getUploadURLExternal": {
        const fileId = `F${++this.seq}`;
        return { ok: true, data: { ok: true, file_id: fileId, upload_url: `https://files.slack.com/upload/v1/${fileId}` } };
      }
      case "files.info": {
        const file = this.opts.files?.[String(args.file)];
        return file ? { ok: true, data: { ok: true, file } } : fail("file_not_found");
      }
      case "files.completeUploadExternal": {
        const files = JSON.parse(String(args.files ?? "[]")) as { id: string; title?: string }[];
        return { ok: true, data: { ok: true, files: files.map((f) => ({ id: f.id, title: f.title })) } };
      }
      default:
        return { ok: true, data: { ok: true } };
    }
  }
}

export interface PersonaSimulatorOptions {
  collectorUrl?: string;
  wsUrl?: string;
  ownerSlackId?: string;
  botUserId?: string;
  webUrl?: string;
  statePath?: string;
  slack?: RecordingSlack;
  log?: (line: string) => void;
}

/** The real bridge wired to a real collector over HTTP + WS, with a recording Slack. */
export function createPersonaSimulator(opts: PersonaSimulatorOptions = {}) {
  const env = loadEnv();
  const collectorUrl = opts.collectorUrl ?? env.collectorUrl;
  const wsUrl = opts.wsUrl ?? env.wsUrl;
  const ownerSlackId = opts.ownerSlackId ?? "U0SIMOWNER";
  const botUserId = opts.botUserId ?? "U_BOT";
  const slack = opts.slack ?? new RecordingSlack({ users: { [ownerSlackId]: "owner" } });
  // A state dir the simulator makes for itself is its own scratch, removed on close.
  const ownStateDir = opts.statePath === undefined ? mkdtempSync(join(tmpdir(), "persona-simulator-")) : null;
  const statePath = ownStateDir ? join(ownStateDir, "slack-persona-threads.json") : opts.statePath!;
  const store = new PersonaThreadStore(statePath);
  let bridge: PersonaBridge;
  let opened: (() => void) | null = null;
  const collector = new CollectorClient(collectorUrl, wsUrl, {
    onMessage: (msg) => bridge.onWsMessage(msg),
    onReconnect: () => {},
    onOpen: () => {
      void bridge.resync().finally(() => {
        opened?.();
        opened = null;
      });
    },
  });
  bridge = new PersonaBridge({
    slack,
    collector,
    store,
    botUserId,
    ownerConfig: { askUser: ownerSlackId, ownerMap: new Map() },
    webUrl: opts.webUrl ?? env.webUrl,
    log: opts.log,
  });
  const dmChannel = `D-${ownerSlackId}`;

  /** Poll until `pred` matches a recorded call (or time out). */
  async function waitForCall(pred: (c: RecordedCall) => boolean, timeoutMs = 60000): Promise<RecordedCall> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = slack.calls.find(pred);
      if (hit) return hit;
      if (Date.now() > deadline) throw new Error("timed out waiting for a matching Slack call");
      await Promise.race([slack.nextCall(), Bun.sleep(250)]);
    }
  }

  return {
    slack,
    bridge,
    collector,
    store,
    statePath,
    ownerSlackId,
    botUserId,
    dmChannel,
    /** Connect the WS and wait for the first resync. */
    async start(): Promise<void> {
      await bridge.refresh();
      const ready = new Promise<void>((resolve) => (opened = resolve));
      collector.connect();
      await ready;
    },
    close(): void {
      collector.close();
      store.flush();
      if (ownStateDir) rmSync(ownStateDir, { recursive: true, force: true });
    },
    /** The owner DMs the bot. */
    async dm(text: string, user = ownerSlackId): Promise<string> {
      const ts = slack.nextTs();
      slack.addToThread(dmChannel, ts, { ts, user, text });
      if (bridge.takesDm(user, false)) await bridge.onDm({ channel: dmChannel, user, text, ts, clientMsgId: `cmid-${ts}` });
      return ts;
    },
    /** Someone posts a plain message in a channel thread (not to the bot). */
    async threadMessage(channel: string, threadTs: string, text: string, user: string): Promise<string> {
      const ts = slack.nextTs();
      slack.addToThread(channel, threadTs, { ts, user, text, thread_ts: threadTs });
      await bridge.onThreadMessage({ channel, user, text, ts, threadTs, clientMsgId: `cmid-${ts}` });
      return ts;
    },
    /** Someone @-mentions the bot (top-level when `threadTs` is omitted). */
    async mention(channel: string, text: string, user = ownerSlackId, threadTs?: string): Promise<{ ts: string; rootTs: string }> {
      const ts = slack.nextTs();
      const rootTs = threadTs ?? ts;
      const full = `<@${botUserId}> ${text}`;
      slack.addToThread(channel, rootTs, { ts, user, text: full, ...(threadTs ? { thread_ts: threadTs } : {}) });
      await bridge.onMention({ channel, user, text: full, ts, threadTs, clientMsgId: `cmid-${ts}` });
      return { ts, rootTs };
    },
    /** Tap Approve/Deny on an approval card. */
    async tapApproval(approvalId: string, decision: "approve" | "deny", user = ownerSlackId): Promise<void> {
      await bridge.onApprovalButton({ actionId: `persona_approval:${approvalId}:${decision}`, userId: user, channel: dmChannel });
    },
    waitForCall,
    /** Posts the bridge made into a channel (optionally one thread). */
    postsTo(channel: string, threadTs?: string): RecordedCall[] {
      return slack.of("chat.postMessage").filter(
        (c) => c.args.channel === channel && (threadTs === undefined || c.args.thread_ts === threadTs),
      );
    },
  };
}

export type PersonaSimulator = ReturnType<typeof createPersonaSimulator>;

/** The scripted CLI scenario: owner DM, channel mention with context, non-owner mention. */
async function main(): Promise<void> {
  const timeout = Number(process.env.SIMULATOR_TIMEOUT_MS ?? 180000);
  const simulator = createPersonaSimulator({
    ownerSlackId: process.env.SIMULATOR_OWNER_SLACK || "U0SIMOWNER",
    statePath: process.env.STANDUP_SLACK_PERSONA_STATE || undefined,
    log: (l) => console.log(l),
  });
  console.log(`[simulator] state file: ${simulator.statePath}`);
  await simulator.start();
  if (!simulator.bridge.active) {
    console.error("[simulator] Persona in Slack is off (see the log line above) — is the collector running with Persona enabled?");
    simulator.close();
    process.exit(1);
  }
  const isReply = (channel: string, threadTs?: string) => (c: RecordedCall) =>
    c.method === "chat.postMessage" &&
    c.args.channel === channel &&
    c.args.thread_ts === threadTs &&
    c.args.username !== undefined;

  console.log("[simulator] 1. owner DM");
  await simulator.dm("Hi Persona — reply with one short sentence so I know you're there.");
  const dmReply = await simulator.waitForCall(isReply(simulator.dmChannel), timeout);
  console.log(`[simulator]    DM reply: ${String(dmReply.args.text).slice(0, 200)}`);

  console.log("[simulator] 2. owner @-mention in a channel thread with context");
  const channel = "C0SIMCHAN";
  const root = simulator.slack.nextTs();
  simulator.slack.addToThread(channel, root, { ts: root, user: "U0TEAMMATE", text: "The nightly build has been red since Tuesday." });
  const other = simulator.slack.nextTs();
  simulator.slack.addToThread(channel, root, { ts: other, user: "U0TEAMMATE", text: "I think it's the flaky integ test.", thread_ts: root });
  await simulator.mention(channel, "what do you make of this thread? one sentence.", simulator.ownerSlackId, root);
  const threadReply = await simulator.waitForCall(isReply(channel, root), timeout);
  console.log(`[simulator]    thread reply: ${String(threadReply.args.text).slice(0, 200)}`);

  console.log("[simulator] 3. non-owner @-mention");
  await simulator.mention(channel, "hey persona do my thing", "U0STRANGER");
  const notice = simulator.slack.of("chat.postEphemeral").find((c) => c.args.user === "U0STRANGER");
  console.log(`[simulator]    ephemeral notice: ${notice ? String(notice.args.text) : "(none)"}`);

  await simulator.bridge.idle();
  console.log(`[simulator] Slack calls recorded: ${simulator.slack.calls.length}`);
  for (const c of simulator.slack.calls) {
    const text = typeof c.args.text === "string" ? ` ${JSON.stringify(c.args.text.slice(0, 120))}` : "";
    console.log(`  ${c.method} ${String(c.args.channel ?? "")}${c.args.thread_ts ? `/${String(c.args.thread_ts)}` : ""}${text}`);
  }
  simulator.close();
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("[simulator] failed:", err);
    process.exit(1);
  });
}
