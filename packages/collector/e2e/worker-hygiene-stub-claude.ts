#!/usr/bin/env bun
/*
 * The `claude` the worker-hygiene live check (worker-hygiene.live.ts) puts
 * first on its scratch collector's PATH. Its shim sets HYGIENE_RUN_DIR (the
 * run dir), HYGIENE_API (the scratch collector's URL), HYGIENE_BUN and
 * HYGIENE_DUMMY (the dummy server script). Two shapes:
 *
 *  - `-p` (a Persona turn, a title or summary): reads stdin, answers with one
 *    stream-json result line, and calls no tool. A Persona turn's token (from
 *    its --mcp-config) is copied to <run>/persona-token so the harness can call
 *    Persona's tool route as Persona would.
 *  - a launched worker (interactive): records its argv and temp-dir env, posts
 *    hook events the way Claude Code's hooks would (to the HTTP hook its
 *    --settings carry, with the launch's hook token, else to the bare /hook),
 *    draws Claude Code's idle prompt, and treats each line typed into the pane
 *    as a prompt (UserPromptSubmit, then Stop). `--resume <id>` reuses that
 *    session id. When <run>/start-dummy exists and no dummy was started yet,
 *    it starts the dummy server (startDummy) and registers it with the
 *    collector using the launch's worker token.
 */
import { randomUUID } from "crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const RUN = process.env.HYGIENE_RUN_DIR ?? "";
const API = process.env.HYGIENE_API ?? "";
const BUN = process.env.HYGIENE_BUN ?? process.execPath;
const DUMMY = process.env.HYGIENE_DUMMY ?? "";
const argv = process.argv.slice(2);

function argAfter(flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

if (!RUN || !API) {
  console.error("worker-hygiene stub: HYGIENE_RUN_DIR and HYGIENE_API must be set");
  process.exit(2);
}

if (argv.includes("-p")) {
  const mcpConfig = argAfter("--mcp-config");
  if (mcpConfig) {
    try {
      const cfg = JSON.parse(readFileSync(mcpConfig, "utf8")) as { mcpServers?: { standup?: { env?: { STANDUP_PERSONA_TOKEN?: string } } } };
      const token = cfg.mcpServers?.standup?.env?.STANDUP_PERSONA_TOKEN;
      if (token) writeFileSync(join(RUN, "persona-token"), token, { mode: 0o600 });
    } catch (err) {
      appendFileSync(join(RUN, "claude-stub-errors.log"), `persona mcp-config: ${(err as Error).message}\n`);
    }
  }
  await new Response(Bun.stdin.stream()).text();
  const result = mcpConfig ? "[silent]" : "scratch";
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result, session_id: randomUUID(), total_cost_usd: 0 }));
  process.exit(0);
}

// ── A launched worker ─────────────────────────────────────────────────────

const resumeId = argAfter("--resume");
const sessionId = resumeId ?? randomUUID();
const cwd = process.cwd();
const transcript = join(RUN, "transcripts", `${sessionId}.jsonl`);
const tmpdir = process.env.TMPDIR ?? "";

// argv with the --settings JSON left out: it carries the floor's config.
const loggedArgv = argv.map((a, i) => (i > 0 && argv[i - 1] === "--settings" ? "<settings>" : a));
appendFileSync(join(RUN, "claude-argv.log"), JSON.stringify({ at: new Date().toISOString(), pid: process.pid, sessionId, resume: resumeId ?? null, argv: loggedArgv }) + "\n");

function fsType(path: string): string | null {
  if (!path) return null;
  const res = Bun.spawnSync(["findmnt", "-no", "FSTYPE", "-T", path], { stdout: "pipe", stderr: "ignore" });
  if (res.exitCode === 0) return res.stdout.toString().trim().split("\n")[0]?.trim() || null;
  const df = Bun.spawnSync(["df", "--output=fstype", path], { stdout: "pipe", stderr: "ignore" });
  return df.exitCode === 0 ? df.stdout.toString().trim().split("\n").pop()?.trim() || null : null;
}
appendFileSync(
  join(RUN, "claude-env.log"),
  JSON.stringify({
    at: new Date().toISOString(),
    pid: process.pid,
    sessionId,
    resume: resumeId ?? null,
    TMPDIR: process.env.TMPDIR ?? null,
    TMP: process.env.TMP ?? null,
    TEMP: process.env.TEMP ?? null,
    fstype: fsType(tmpdir),
    workerTokenFile: process.env.STANDUP_WORKER_TOKEN_FILE ? "set" : "unset",
    hookToken: process.env.STANDUP_HOOK_TOKEN ? "set" : "unset",
  }) + "\n"
);

/** The HTTP hook the launch's --settings carry for `event`, else the bare /hook with no token. */
type HttpHook = { type?: string; url?: string; headers?: Record<string, string> };
const settings = (() => {
  const raw = argAfter("--settings");
  if (!raw) return null;
  try {
    return JSON.parse(raw) as { hooks?: Record<string, Array<{ hooks?: HttpHook[] }>> };
  } catch {
    return null;
  }
})();
function hookFor(event: string): { url: string; headers: Record<string, string> } {
  const entries = settings?.hooks?.[event] ?? [];
  for (const entry of entries) {
    for (const hook of entry.hooks ?? []) {
      if (hook.type !== "http" || !hook.url) continue;
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(hook.headers ?? {})) {
        headers[name] = value.replace(/\$([A-Z_][A-Z0-9_]*)/g, (_, v: string) => process.env[v] ?? "");
      }
      return { url: hook.url, headers };
    }
  }
  return { url: `${API}/hook`, headers: {} };
}

async function postHook(event: string, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const { url, headers } = hookFor(event);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ session_id: sessionId, cwd, transcript_path: transcript, hook_event_name: event, ...extra }),
    });
    const text = await res.text();
    appendFileSync(join(RUN, "claude-hooks.log"), `${new Date().toISOString()} ${sessionId.slice(0, 8)} ${event} -> ${res.status}\n`);
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return {};
    }
  } catch (err) {
    appendFileSync(join(RUN, "claude-hooks.log"), `${new Date().toISOString()} ${sessionId.slice(0, 8)} ${event} failed: ${(err as Error).message}\n`);
    return {};
  }
}

/** Ends a turn: a Stop the collector blocks is followed by another, as Claude Code continues and stops again. */
async function stopTurn(): Promise<void> {
  let active = false;
  for (let i = 0; i < 4; i++) {
    const reply = await postHook("Stop", { stop_hook_active: active });
    if (reply.decision !== "block") return;
    active = true;
  }
}

const RULE = "─".repeat(60);
function drawIdle(): void {
  process.stdout.write("\x1b[2J\x1b[H");
  process.stdout.write(["● Done.", RULE, "❯ ", RULE, "  ⏵⏵ auto mode on (shift+tab to cycle) · ? for shortcuts", ""].join("\n"));
}

if (!resumeId || !existsSync(transcript)) {
  writeFileSync(
    transcript,
    JSON.stringify({ type: "user", uuid: randomUUID(), sessionId, timestamp: new Date().toISOString(), cwd, message: { role: "user", content: "worker-hygiene live check" } }) + "\n",
    { flag: existsSync(transcript) ? "a" : "w" }
  );
}

// Typed lines are prompts, each a turn after the session start; a pasted
// multi-line prompt arrives as several lines, so input settles first. The
// terminal goes raw before the prompt is drawn, so nothing typed is echoed.
let buffer = "";
let pending: string[] = [];
let settleTimer: ReturnType<typeof setTimeout> | null = null;
let turn: Promise<void> = postHook("SessionStart", { source: resumeId ? "resume" : "startup" }).then(() => drawIdle());
function submit(): void {
  const prompt = pending.join("\n").trim();
  pending = [];
  if (!prompt) return;
  appendFileSync(join(RUN, "claude-input.log"), JSON.stringify({ at: new Date().toISOString(), pid: process.pid, sessionId, prompt: prompt.slice(0, 500) }) + "\n");
  turn = turn.then(async () => {
    await postHook("UserPromptSubmit", { prompt });
    await stopTurn();
    drawIdle();
  });
}
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.on("data", (chunk: Buffer) => {
  for (const ch of chunk.toString("utf8")) {
    if (ch === "\x03" || ch === "\x04") process.exit(0);
    if (ch === "\r" || ch === "\n") {
      pending.push(buffer);
      buffer = "";
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(submit, 400);
    } else if (ch === "\x7f") {
      buffer = buffer.slice(0, -1);
    } else if (ch >= " " || ch === "\t") {
      buffer += ch;
    }
  }
});
process.on("SIGHUP", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
await turn;

// The dummy server: started once, under its own session id (setsid, so the
// pane's SIGHUP at a pause or stop doesn't reach it), as this process's child.
async function startDummy(): Promise<void> {
  const out = join(RUN, "dummy.json");
  if (resumeId || !existsSync(join(RUN, "start-dummy")) || existsSync(out) || !DUMMY) return;
  Bun.spawn(["setsid", BUN, DUMMY, out, join(tmpdir || RUN, "dummy-server.port")], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  let info: { pid?: number; port?: number } | null = null;
  for (let i = 0; i < 50 && !info; i++) {
    await Bun.sleep(200);
    try {
      info = JSON.parse(readFileSync(out, "utf8")) as { pid?: number; port?: number };
    } catch {
      info = null;
    }
  }
  const record = (value: unknown) => writeFileSync(join(RUN, "register.json"), JSON.stringify(value, null, 2));
  if (!info?.pid) return record({ error: "the dummy server never reported its pid" });
  const tokenFile = process.env.STANDUP_WORKER_TOKEN_FILE;
  if (!tokenFile) return record({ error: "STANDUP_WORKER_TOKEN_FILE is not set in the pane" });
  const token = readFileSync(tokenFile, "utf8").trim();
  const request = { pid: info.pid, label: "dummy", ...(info.port ? { port: info.port } : {}) };
  const res = await fetch(`${API}/api/processes/register`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-standup-worker-token": token },
    body: JSON.stringify(request),
  });
  record({ request, status: res.status, response: await res.json().catch(() => null) });
}
void startDummy().catch((err) => writeFileSync(join(RUN, "register.json"), JSON.stringify({ error: (err as Error).message })));

setInterval(() => {}, 1 << 30);
