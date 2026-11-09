import { spawnSync } from "child_process";
import { readFileSync } from "fs";
import { platform } from "os";
import { basename, dirname } from "path";
import type { Database } from "bun:sqlite";
import { formatGb, ramFreeableTitle } from "@standup/shared";
import type { Launch, RamFreeable, RamGroup, RamHost, RamLeftover, RamLeftoverReason, RamReport } from "@standup/shared";
import { scratchRoot } from "@standup/shared/scratch";
import { REDACTED, redactSecrets } from "@standup/knowledge";
import { getLaunches, getSession, listLiveProcesses } from "@standup/store";
import { parseMeminfoField } from "../../host-headroom.js";
import { findOrphans, jobOf, launchFinished, launchPaths, partitionLaunches } from "../../orphan-sweep.js";
import {
  argsReferencePath,
  argv0,
  isServiceManager,
  parseFingerprint,
  sameProcess,
  usablePath,
  type ProcessRow,
  type ProcessSystem,
} from "../../process-registry.js";
import { workerTmux } from "../../tmux-launch.js";
import type { PersonaCommandContext, PersonaCommandHandler } from "./registry.js";

// `/ram`: what holds the host's memory. Every process of the collector's user
// is put in one place: a live worker's session, a leftover of a closed job,
// ended session or gone pane, Standup's own tree, or the unattributed rest. It
// reads /proc/meminfo, `ps` and the workers' tmux server, never another
// process's environment, and it stops nothing.

/** Host reads /ram needs beyond the process table, injectable for tests. */
export interface RamReaders {
  /** /proc/meminfo text; null where there is none. */
  meminfo: () => string | null;
  /** Resident memory per pid, in bytes; null when `ps` can't run. */
  rss: () => Map<number, number> | null;
  /** Each worker tmux session's pane pids; null when the workers' server can't be asked. */
  panes: () => Map<string, number[]> | null;
}

/** `ps -eo pid=,rss=` output → bytes per pid. */
export function parseRssTable(stdout: string): Map<number, number> {
  const out = new Map<number, number>();
  for (const line of stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (m) out.set(Number(m[1]), Number(m[2]) * 1024);
  }
  return out;
}

/** `tmux list-panes -a -F '#{session_name} #{pane_pid}'` output → pane pids per session. */
export function parsePaneList(stdout: string): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const line of stdout.split("\n")) {
    const m = /^(\S+)\s+(\d+)\s*$/.exec(line.trim());
    if (!m) continue;
    const list = out.get(m[1]!) ?? [];
    list.push(Number(m[2]));
    out.set(m[1]!, list);
  }
  return out;
}

/** The real host's readers. */
export const hostRamReaders: RamReaders = {
  meminfo() {
    if (platform() !== "linux") return null;
    try {
      return readFileSync("/proc/meminfo", "utf8");
    } catch {
      return null;
    }
  },
  rss() {
    const out = spawnSync("ps", ["-eo", "pid=,rss="], { encoding: "utf8", timeout: 5_000, maxBuffer: 8 * 1024 * 1024 });
    if (out.status !== 0 || out.error) return null;
    return parseRssTable(out.stdout);
  },
  panes() {
    const [cmd, ...argv] = workerTmux("list-panes", "-a", "-F", "#{session_name} #{pane_pid}");
    const out = spawnSync(cmd!, argv, { encoding: "utf8", timeout: 5_000 });
    if (out.error) return null;
    // No server running means no panes; any other failure is no answer.
    if (out.status !== 0) return /no server running|error connecting/i.test(out.stderr ?? "") ? new Map() : null;
    return parsePaneList(out.stdout);
  },
};

// Quote characters are written \x22 (") and \x27 (') in these patterns.
const CREDENTIAL_WORD = String.raw`(?:token|secret|passw(?:or)?d|pass|pwd|api[-_]?key|apikey|access[-_]?key|private[-_]?key|auth|credential|cookie)`;
const VALUE = String.raw`(\x22[^\x22]*\x22|\x27[^\x27]*\x27|[^\s\x22\x27;&]+)`;
/** An auth scheme a value may carry before the secret: `Bearer x`. */
const SCHEME = String.raw`((?:Bearer|Basic|Token)\s+)?`;
/** Not a value already redacted, after its optional scheme. */
const NOT_REDACTED = String.raw`(?!(?:(?:Bearer|Basic|Token)\s+)?\[REDACTED\])`;
/** A credential-named flag and its value: `--github-token x`, `--client-secret=x`, `--auth Bearer x`; never a next flag. */
const CREDENTIAL_FLAG = new RegExp(String.raw`(^|\s)(--?[\w.-]*${CREDENTIAL_WORD}[\w.-]*)(=|\s+(?!-))${NOT_REDACTED}${SCHEME}${VALUE}`, "gi");
/** A credential-named assignment: `MY_SECRET=x`, `export TOKEN=x`, `?token=x`, `--env=NPM_TOKEN=x`, `auth.token=x`. */
const CREDENTIAL_ASSIGNMENT = new RegExp(String.raw`(^|[\s;\x22\x27?&=.,])((?:[A-Za-z_]\w*)?${CREDENTIAL_WORD}\w*)=(?!\[REDACTED\])${VALUE}`, "gi");
/** A credential-named JSON key: `{"apiKey":"x"}`. */
const CREDENTIAL_JSON = new RegExp(String.raw`(\x22[\w-]*${CREDENTIAL_WORD}[\w-]*\x22\s*:\s*)(?!\x22?\[REDACTED\])(\x22[^\x22]*\x22|[^\s,}]+)`, "gi");
/** A `user:password` after a user flag: `curl -u bob:x`, `--user=bob:x`, `--proxy-user bob:x`. */
const USER_PASSWORD = /(^|\s)(-u|-U|--user|--proxy-user)(=|\s+)([^\s:]+):(?!\[REDACTED\])(\S+)/g;
/** A cookie header: every pair of it, `Cookie: a=1; sid=x`. */
const COOKIE_HEADER = /(^|[\s\x22\x27=])((?:set-)?cookie:)\s*(?!\[REDACTED\])((?:[^\s\x22\x27;]+;\s*)*[^\s\x22\x27;]+;?)/gi;
/** A credential-named header: `X-Api-Key: x`, `Authorization: Bearer x`, `--header=X-Api-Key: x`. */
const CREDENTIAL_HEADER = new RegExp(String.raw`(^|[\s\x22\x27=])([\w-]*${CREDENTIAL_WORD}[\w-]*:)\s*${NOT_REDACTED}${SCHEME}([^\s\x22\x27]+)`, "gi");
/** Clients whose short flag takes a password: `sshpass -p x`, `redis-cli -a x`, `docker login -p x` (a port mapping's `-p` is hidden too). */
const PASSWORD_SHORT_FLAG: Record<string, string> = {
  sshpass: "-p",
  "redis-cli": "-a",
  mysql: "-p",
  mysqladmin: "-p",
  mysqldump: "-p",
  docker: "-p",
  podman: "-p",
};

/**
 * Text for display with every secret shape redacted: what the knowledge
 * corpus scrubs at its full tier, then any value of a credential-named flag,
 * assignment or header whatever its length, since a display needs recall
 * over precision.
 */
export function redactForDisplay(text: string): string {
  return redactSecrets(text, { tier: "full" })
    .replace(CREDENTIAL_FLAG, (_m, pre: string, flag: string, sep: string, scheme: string | undefined) => `${pre}${flag}${sep}${scheme ?? ""}${REDACTED}`)
    .replace(CREDENTIAL_ASSIGNMENT, (_m, pre: string, name: string) => `${pre}${name}=${REDACTED}`)
    .replace(CREDENTIAL_JSON, (_m, key: string) => `${key}\x22${REDACTED}\x22`)
    .replace(USER_PASSWORD, (_m, pre: string, flag: string, sep: string, user: string) => `${pre}${flag}${sep}${user}:${REDACTED}`)
    .replace(COOKIE_HEADER, (_m, pre: string, name: string) => `${pre}${name} ${REDACTED}`)
    .replace(CREDENTIAL_HEADER, (_m, pre: string, name: string, scheme: string | undefined) => `${pre}${name} ${scheme ?? ""}${REDACTED}`);
}

/** An absolute path of more than three parts, shortened to its last two. */
function shortenPath(token: string): string {
  if (token.includes("://")) return token;
  const m = /^(.*?)(\/[^\s]+)$/.exec(token);
  if (!m) return token;
  const parts = m[2]!.split("/").filter(Boolean);
  if (parts.length <= 3) return token;
  return `${m[1]}…/${parts.slice(-2).join("/")}`;
}

/**
 * A command line for display: secrets redacted (redactForDisplay, and the
 * password of a client's short flag), then the program's name, long paths cut
 * to their last two parts, and at most `max` characters.
 */
export function commandSummary(args: string, max = 100): string {
  const tokens = redactForDisplay(args).replace(/\s+/g, " ").trim().split(" ");
  // A password client may run under another program (`timeout 30 sshpass -p x`), so every token is checked.
  let flag: string | undefined;
  const redacted = tokens.map((tok, i) => {
    const prev = tokens[i - 1];
    const own = PASSWORD_SHORT_FLAG[basename(tok)];
    if (own) {
      flag = own;
      return tok;
    }
    if (flag && prev === flag && !tok.startsWith("-")) return REDACTED;
    if (flag && tok.startsWith(flag) && tok.length > flag.length && !tok.includes(REDACTED)) return `${flag}${REDACTED}`;
    return tok;
  });
  const [first = "", ...rest] = redacted;
  const line = [basename(first) || first, ...rest.map(shortenPath)].join(" ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * What kind of process a command line is, for grouping leftovers. Only the
 * program and the script it runs are read, so a prompt or a path elsewhere
 * in the arguments doesn't change the kind; a Java process is told apart by
 * its whole command line, which carries no prompt.
 */
export function processKind(args: string): string {
  const name = argv0(args).toLowerCase();
  const lead = args.trim().split(/\s+/).slice(0, 3).join(" ").toLowerCase();
  if (name === "claude" || /\/claude-code\/|@anthropic-ai\/claude-code/.test(lead)) return "Claude CLI";
  if (name === "vite" || /\bvite\b/.test(lead)) return "vite server";
  if (/packages\/collector\/src\/index\.ts/.test(lead)) return "scratch collector";
  if (/chrom(e|ium)|headless_shell/.test(name) || /ms-playwright/.test(lead)) return "Chromium";
  if (name === "java") {
    const a = args.toLowerCase();
    if (/gradle/.test(a)) return "Gradle daemon";
    return "Java process";
  }
  if (/gradle/.test(name)) return "Gradle daemon";
  if (name === "tmux") return "tmux";
  if (name === "bun") return "bun process";
  if (name === "node") return "node process";
  return name || "process";
}

function iso(epochS: number | undefined): string | undefined {
  return epochS === undefined ? undefined : new Date(epochS * 1000).toISOString();
}

function clip(text: string, max = 80): string {
  const flat = redactForDisplay(text).replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The process tables /ram attributes over. */
interface Tables {
  byPid: Map<number, ProcessRow>;
  children: Map<number, number[]>;
  rss: Map<number, number>;
  /** The user's processes not yet placed. */
  free: Set<number>;
}

/** `pid` and every descendant still free, taken out of `free`. */
function takeTree(t: Tables, pid: number): number[] {
  const out: number[] = [];
  const stack = [pid];
  while (stack.length > 0) {
    const p = stack.pop()!;
    if (!t.free.has(p)) continue;
    t.free.delete(p);
    out.push(p);
    stack.push(...(t.children.get(p) ?? []));
  }
  return out;
}

/** `pid` and every descendant, placed or not. */
function subtree(t: Tables, pid: number): number[] {
  const out: number[] = [];
  const stack = [pid];
  while (stack.length > 0 && out.length < 10_000) {
    const p = stack.pop()!;
    out.push(p);
    stack.push(...(t.children.get(p) ?? []));
  }
  return out;
}

/** The pids in `pids` whose parent isn't one of them. */
function rootsOf(t: Tables, pids: number[]): number[] {
  const set = new Set(pids);
  return pids.filter((p) => !set.has(t.byPid.get(p)?.ppid ?? -1));
}

/** The free pids, ancestors before their descendants. */
function freeByDepth(t: Tables): number[] {
  const depth = (pid: number) => {
    let d = 0;
    for (let cur = t.byPid.get(pid); cur && d < 64; cur = t.byPid.get(cur.ppid)) d++;
    return d;
  };
  return [...t.free].map((p) => [p, depth(p)] as const).sort((a, b) => a[1] - b[1]).map(([p]) => p);
}

/** The group of process trees `roots` → `pids`. */
function groupOf(t: Tables, id: string, label: string, roots: number[], pids: number[], extra: Partial<RamGroup> = {}): RamGroup {
  let heaviest: ProcessRow | undefined;
  let rssBytes = 0;
  for (const p of pids) {
    const bytes = t.rss.get(p) ?? 0;
    rssBytes += bytes;
    if (!heaviest || bytes > (t.rss.get(heaviest.pid) ?? 0)) heaviest = t.byPid.get(p);
  }
  const starts = roots.map((r) => t.byPid.get(r)?.started).filter((s): s is number => s !== undefined);
  const startedAt = iso(starts.length > 0 ? Math.min(...starts) : undefined);
  return {
    id,
    label,
    rssBytes,
    processCount: pids.length,
    pids: roots,
    command: heaviest ? commandSummary(heaviest.args) : "",
    ...(startedAt ? { startedAt } : {}),
    ...extra,
  };
}

/** Whether a process is a Claude CLI: the Persona runtime or an internal helper under the collector. */
function isClaude(row: ProcessRow): boolean {
  return argv0(row.args) === "claude" || /\/claude-code\/|@anthropic-ai\/claude-code/.test(row.args);
}

/**
 * The top of Standup's own tree: the collector's topmost ancestor through
 * bun and node parents only (`bun run dev` → dev.ts → `bun run start` → the
 * collector), so a shell or tmux the collector was started from isn't counted.
 */
function standupRoot(t: Tables, selfPid: number): number {
  let root = selfPid;
  for (let depth = 0; depth < 16; depth++) {
    const parent = t.byPid.get(t.byPid.get(root)?.ppid ?? -1);
    // A Claude CLI runs as node too; the collector started from one isn't part of it.
    if (!parent || !/^(bun|node)$/.test(argv0(parent.args)) || isClaude(parent)) break;
    root = parent.pid;
  }
  return root;
}

/**
 * What a service dev.ts runs is, from the command lines in its tree (dev.ts
 * sets the package only as the working directory): the web console is
 * `bun run serve` (or vite), a standby collector slot `bun run start`, the
 * Slack bridge `bun run dev` running `src/index.ts`.
 */
function serviceLabel(t: Tables, pid: number, selfPid: number): string {
  const tree = subtree(t, pid);
  if (tree.includes(selfPid)) return "Collector";
  const args = tree.map((p) => t.byPid.get(p)?.args ?? "");
  const head = args[0] ?? "";
  if (/\brun serve\b|\bserve\.ts\b/.test(head) || args.some((a) => processKind(a) === "vite server")) return "Web server";
  if (/\brun start\b/.test(head)) return "Standby collector";
  if (args.some((a) => /\bsrc\/index\.ts\b/.test(a))) return "Slack bridge";
  if (/gateway/.test(head)) return "Gateway";
  return `Standup: ${argv0(head) || "process"}`;
}

/** Standup's own tree: the collector, the Persona runtime, each service dev.ts runs, and dev.ts itself. */
function standupGroups(t: Tables, selfPid: number, persona: number[]): RamGroup[] {
  const groups = new Map<string, number[]>();
  const add = (label: string, pids: number[]) => {
    if (pids.length > 0) groups.set(label, [...(groups.get(label) ?? []), ...pids]);
  };
  add("Persona runtime and helpers", persona);
  const root = standupRoot(t, selfPid);
  add("Collector", takeTree(t, selfPid));
  const dev = [...subtree(t, root)].find((p) => /scripts\/dev\.ts\b/.test(t.byPid.get(p)?.args ?? ""));
  for (const child of dev === undefined ? [] : (t.children.get(dev) ?? [])) {
    if (t.free.has(child)) add(serviceLabel(t, child, selfPid), takeTree(t, child));
  }
  add(dev === undefined ? "Collector" : "Dev script", takeTree(t, root));
  return [...groups].map(([label, pids]) => groupOf(t, `standup:${label}`, label, rootsOf(t, pids), pids));
}

/** The launch whose path (longest first) `args` names as a whole path, from a path → launch map. */
function launchByPath(args: string, byPath: Map<string, string>): string | undefined {
  let best: { path: string; launchId: string } | undefined;
  for (const m of args.matchAll(/(?:^|[^\w.\-/])(\/[^\s\x22\x27=:,;]+)/g)) {
    for (let p = m[1]!.replace(/\/+$/, ""); p.length > 1; p = dirname(p)) {
      const launchId = byPath.get(p);
      if (launchId !== undefined) {
        if (!best || p.length > best.path.length) best = { path: p, launchId };
        break;
      }
    }
  }
  return best && argsReferencePath(args, best.path) ? best.launchId : undefined;
}

export interface RamInput {
  db: Database;
  owner: string;
  now: Date;
  sys: Pick<ProcessSystem, "selfPid" | "uid" | "processTable">;
  readers: RamReaders;
  /** Standup's install dir: no path inside or around it identifies a launch. */
  installDir: string;
  /** Where launches' scratch dirs live; defaults to the user's scratch root. */
  scratchRoot?: string;
  /** Whether process details are shown: false for a user who isn't the host's. */
  showProcesses?: boolean;
}

function hostOf(meminfo: string | null): Omit<RamHost, "standupBytes"> | null {
  if (!meminfo) return null;
  const total = parseMeminfoField(meminfo, "MemTotal");
  const available = parseMeminfoField(meminfo, "MemAvailable");
  if (total === null || available === null) return null;
  const swapTotal = parseMeminfoField(meminfo, "SwapTotal") ?? 0;
  const swapFree = parseMeminfoField(meminfo, "SwapFree") ?? swapTotal;
  return {
    totalBytes: total,
    usedBytes: Math.max(0, total - available),
    availableBytes: available,
    swapTotalBytes: swapTotal,
    swapUsedBytes: Math.max(0, swapTotal - swapFree),
  };
}

/** The leftovers cleanup can stop (not still live, not under a running parent), by kind and reason, heaviest first. */
function freeableOf(leftovers: RamLeftover[]): RamFreeable[] {
  const byKey = new Map<string, RamFreeable>();
  for (const l of leftovers) {
    if (l.stillLive || l.hasParent) continue;
    const key = `${l.kind}\t${l.reason}`;
    const f = byKey.get(key) ?? { kind: l.kind, reason: l.reason, count: 0, rssBytes: 0, pids: [], line: "" };
    f.count++;
    f.rssBytes += l.rssBytes;
    f.pids.push(...l.pids);
    byKey.set(key, f);
  }
  return [...byKey.values()]
    .map((f) => ({ ...f, line: `${ramFreeableTitle(f)}, ${formatGb(f.rssBytes)} (pid ${f.pids.join(", ")})` }))
    .sort((a, b) => b.rssBytes - a.rssBytes);
}

/** How many unattributed trees the report lists by name. */
export const RAM_OTHER_LIMIT = 8;

/** The `/ram` report: host totals, then every process of the user attributed to an owner. */
export function buildRamReport(input: RamInput): RamReport {
  const { db, owner, now, sys, readers } = input;
  const baseHost = hostOf(readers.meminfo());
  const empty = (processError: string): RamReport => {
    const host = baseHost ? { ...baseHost, standupBytes: 0 } : null;
    return {
      generatedAt: now.toISOString(),
      host,
      top: [],
      workers: [],
      standup: [],
      leftovers: [],
      other: [],
      otherRest: { count: 0, rssBytes: 0 },
      freeable: [],
      processError,
      summary: summaryLine(host, [], processError),
    };
  };
  if (input.showProcesses === false) return empty("Process details are shown only to the host's owner.");
  const table = sys.processTable();
  const rss = readers.rss();
  if (!table || !rss) return empty("The process table couldn't be read.");

  const uid = sys.uid();
  const t: Tables = { byPid: new Map(table.map((r) => [r.pid, r])), children: new Map(), rss, free: new Set() };
  for (const r of table) {
    const list = t.children.get(r.ppid) ?? [];
    list.push(r.pid);
    t.children.set(r.ppid, list);
    if (r.uid === uid && !isServiceManager(r)) t.free.add(r.pid);
  }

  // 1. The Persona runtime and helpers (whose prompts may name a worktree),
  // and the workers' tmux server, the parent of its panes (its argv keeps
  // its first pane's -c dir).
  const persona = (t.children.get(sys.selfPid) ?? []).filter((p) => isClaude(t.byPid.get(p)!)).flatMap((p) => takeTree(t, p));
  const panes = readers.panes();
  const tmuxServers = [...new Set([...(panes?.values() ?? [])].flat().map((p) => t.byPid.get(p)?.ppid ?? -1))].filter(
    (p) => t.free.has(p) && argv0(t.byPid.get(p)!.args) === "tmux"
  );
  for (const p of tmuxServers) t.free.delete(p);

  // 2. Each launch's processes: its panes' trees, its registered processes,
  // then any tree naming its worktree or scratch dir, before the collector
  // claims its own tree (a launch's setup steps run under the collector).
  // An unanswered pane read counts every pane as up, so nothing is called gone.
  const paneAlive = (s: string) => (panes ? (panes.get(s)?.length ?? 0) > 0 : true);
  const root = input.scratchRoot ?? scratchRoot();
  const { live, targets } = partitionLaunches(db, { installDir: input.installDir, scratchRoot: root, paneAlive, everyLaunch: true });
  const liveIds = new Set(live.map((l) => l.id));
  const launches = new Map(getLaunches(db).map((l) => [l.id, l]));
  const owned = new Map<string, Array<{ root: number; pids: number[]; via: "pane" | "registered" | "path" }>>();
  const own = (launchId: string, pid: number, via: "pane" | "registered" | "path") => {
    const pids = takeTree(t, pid);
    if (pids.length === 0) return;
    owned.set(launchId, [...(owned.get(launchId) ?? []), { root: pid, pids, via }]);
  };
  for (const l of launches.values()) {
    if (l.tmuxSession) for (const pid of panes?.get(l.tmuxSession) ?? []) own(l.id, pid, "pane");
  }
  for (const p of listLiveProcesses(db)) {
    const row = p.pid ? t.byPid.get(p.pid) : undefined;
    if (!row || !t.free.has(row.pid) || !launches.has(p.launchId)) continue;
    // A row without the identity it was registered with can't tell a reused pid.
    if (!p.argsFingerprint || !sameProcess(parseFingerprint(p.argsFingerprint), row.args, row.started ?? null)) continue;
    own(p.launchId, row.pid, "registered");
  }
  const byPath = new Map<string, string>();
  for (const target of targets) for (const p of target.paths) byPath.set(p, target.launchId);
  for (const l of live) for (const p of launchPaths(l, root)) if (usablePath(p, input.installDir)) byPath.set(p, l.id);
  for (const pid of freeByDepth(t)) {
    // A tmux server's argv keeps its first client's -c dir, which says nothing of its panes.
    if (!t.free.has(pid) || argv0(t.byPid.get(pid)!.args) === "tmux") continue;
    const launchId = launchByPath(t.byPid.get(pid)!.args, byPath);
    if (launchId) own(launchId, pid, "path");
  }
  // The trees found by path that the orphan sweep would stop: reparented, not protected.
  const byPathOwners = new Set([...owned].filter(([, trees]) => trees.some((x) => x.via === "path")).map(([id]) => id));
  const pathTargets = targets.filter((x) => byPathOwners.has(x.launchId));
  const orphans = new Set(findOrphans(table, pathTargets, { selfPid: sys.selfPid, uid, installDir: input.installDir }).map((o) => o.row.pid));

  // 3. Standup's own processes.
  const standup = standupGroups(t, sys.selfPid, persona);
  if (tmuxServers.length > 0) standup.push(groupOf(t, "standup:tmux", "Workers' tmux server", tmuxServers, tmuxServers));

  // 4. Each launch with processes is a live worker or a leftover. A leftover
  // whose worker is still live, or found by path under a parent that still
  // runs, is listed but not one to free.
  const workers: RamGroup[] = [];
  const leftovers: RamLeftover[] = [];
  for (const [launchId, trees] of owned) {
    const launch: Launch = launches.get(launchId)!;
    const job = jobOf(db, launch);
    const session = launch.sessionId ? getSession(db, launch.sessionId) : null;
    const label = job ? (job.owner === owner ? clip(job.title) : "Another user's job") : `Launch ${clip(launch.branch || launch.id, 60)}`;
    const href = job && job.owner === owner ? `/persona?job=${encodeURIComponent(job.id)}` : undefined;
    const sessionLine = session ? (session.endedAt ? "session ended" : `session ${session.status}`) : "no session";
    const detail = `${job ? `Job ${job.status}` : "No job"} · ${sessionLine}`;
    const isLive = liveIds.has(launchId);
    const paneUp = !!launch.tmuxSession && paneAlive(launch.tmuxSession);
    let reason: RamLeftoverReason | null = null;
    if (launchFinished(db, launch, job)) reason = "job_closed";
    else if (session?.endedAt && !paneUp) reason = "session_ended";
    else if (!isLive) reason = session?.endedAt || paneUp ? "session_ended" : "pane_gone";
    const extra = { detail, ...(href ? { href } : {}) };
    if (reason === null) {
      workers.push(groupOf(t, `worker:${launchId}`, label, trees.map((x) => x.root), trees.flatMap((x) => x.pids), extra));
      continue;
    }
    const stillLive = isLive;
    for (const tree of trees) {
      const hasParent = !stillLive && tree.via === "path" && !orphans.has(tree.root);
      const note = stillLive
        ? " · its worker is still live"
        : hasParent
          ? " · its parent still runs, so cleanup leaves it"
          : tree.via === "pane"
            ? " · its tmux pane is still open"
            : "";
      const g = groupOf(t, `leftover:${launchId}:${tree.root}`, label, [tree.root], tree.pids, { ...extra, detail: `${detail}${note}` });
      const heaviest = tree.pids.reduce((a, b) => ((rss.get(b) ?? 0) > (rss.get(a) ?? 0) ? b : a), tree.root);
      leftovers.push({
        ...g,
        reason,
        kind: processKind(t.byPid.get(heaviest)?.args ?? ""),
        ...(stillLive ? { stillLive } : {}),
        ...(hasParent ? { hasParent } : {}),
      });
    }
  }

  // 5. Everything else, as whole trees under their topmost unattributed
  // process; a tmux server stands alone, so each of its panes is its own tree.
  const otherAll: RamGroup[] = [];
  for (const pid of freeByDepth(t)) {
    if (!t.free.has(pid)) continue;
    const isTmux = argv0(t.byPid.get(pid)!.args) === "tmux";
    if (isTmux) t.free.delete(pid);
    const pids = isTmux ? [pid] : takeTree(t, pid);
    otherAll.push(groupOf(t, `other:${pid}`, processKind(t.byPid.get(pid)!.args), [pid], pids));
  }

  const byRss = (a: RamGroup, b: RamGroup) => b.rssBytes - a.rssBytes;
  workers.sort(byRss);
  standup.sort(byRss);
  leftovers.sort(byRss);
  otherAll.sort(byRss);
  const other = otherAll.slice(0, RAM_OTHER_LIMIT);
  const rest = otherAll.slice(RAM_OTHER_LIMIT);
  const sum = (gs: RamGroup[]) => gs.reduce((n, g) => n + g.rssBytes, 0);
  const host = baseHost ? { ...baseHost, standupBytes: sum(standup) + sum(workers) + sum(leftovers) } : null;
  const top = [
    ...workers.map((g) => ({ ...g, section: "worker" as const })),
    ...standup.map((g) => ({ ...g, section: "standup" as const })),
    ...leftovers.map((g) => ({ ...g, section: "leftover" as const })),
    ...other.map((g) => ({ ...g, section: "other" as const })),
  ]
    .sort(byRss)
    .slice(0, 5);
  const freeable = freeableOf(leftovers);
  return {
    generatedAt: now.toISOString(),
    host,
    top,
    workers,
    standup,
    leftovers,
    other,
    otherRest: { count: rest.length, rssBytes: sum(rest) },
    freeable,
    processError: null,
    summary: summaryLine(host, freeable, null),
  };
}

/** "41.2 GB used of 62.0 GB · Standup 18.3 GB · 3 leftovers could free 4.1 GB". */
export function summaryLine(host: RamHost | null, freeable: RamFreeable[], processError: string | null): string {
  const parts: string[] = [];
  if (host) {
    parts.push(`${formatGb(host.usedBytes)} used of ${formatGb(host.totalBytes)}`);
    if (!processError) parts.push(`Standup ${formatGb(host.standupBytes)}`);
  } else {
    parts.push("No host memory reading");
  }
  const count = freeable.reduce((n, f) => n + f.count, 0);
  if (processError) parts.push(processError);
  else if (count === 0) parts.push("nothing to free");
  else parts.push(`${plural(count, "leftover")} could free ${formatGb(freeable.reduce((n, f) => n + f.rssBytes, 0))}`);
  return parts.join(" · ");
}

export const ramCommand: PersonaCommandHandler = {
  name: "ram",
  run(ctx: PersonaCommandContext) {
    const noTable = { selfPid: process.pid, uid: () => -1, processTable: () => null };
    const report = buildRamReport({
      db: ctx.db,
      owner: ctx.owner,
      now: ctx.now,
      sys: ctx.processes ?? noTable,
      readers: ctx.ramReaders ?? hostRamReaders,
      installDir: ctx.installDir ?? "",
      showProcesses: !ctx.host || ctx.owner === ctx.host,
    });
    return { data: report, summary: report.summary };
  },
};
