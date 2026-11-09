/*
 * Whether words the owner wrote (or the question of Persona's they answer)
 * name what a held safety-floor call reaches. A yes in chat that stands in
 * for the job asking must be about this call, not just share a word with it:
 * the worker writes the call, so a comment in it (`# tests`), the text it
 * echoes, a /tmp/ name it picked or another word it chose can echo whatever
 * the owner last said. Only the call's distinctive targets count: a path or
 * a script by its distinctive parts, a host, an account, or the step's
 * command word together with its object. On a high-risk hold (reserved) a
 * path is named only by its file's stem together with one of its parent
 * dirs, a host by its own first label, and a step only by its verb together
 * with its object, so the words every Standup job shares (floor, collector,
 * standup, install) name none of them on their own, and every target the
 * call reaches past /tmp/ and the worktree must be named.
 */

import { ISOLATION_PORT_ENV } from "../floor/classify.js";
import { DEFAULT_ORG_PROFILE } from "../org-profile/default.js";
import { activeOrgProfile } from "../org-profile/load.js";
import type { OrgProfile } from "../org-profile/types.js";
import { escapeRegExp } from "./review-noun.js";

/** Words of paths and commands that name nothing in particular. */
const GENERIC_WORDS: ReadonlySet<string> = new Set([
  "tmp", "home", "local", "share", "usr", "bin", "dev", "null", "src", "lib", "package", "node", "module",
  "data", "index", "main", "file", "test", "spec", "dist", "build", "out", "var", "opt", "etc",
  "root", "proc", "self", "config", "json", "yaml", "yml", "toml", "lock", "log", "txt", "tsx", "jsx", "mjs",
  "cjs", "the", "and", "for", "with", "origin", "head", "true", "false", "http", "https", "www", "com", "net",
  "org", "run", "exec", "env", "sudo", "timeout", "nohup", "nice", "time", "command", "xargs", "bash", "zsh",
  "python", "python3", "bun", "bunx", "npm", "npx", "yarn", "pnpm", "cat", "echo", "printf",
  "start", "allow", "yes", "please", "okay",
]);

/**
 * A job, a question or a reply naming a scratch Standup run: the instance
 * named as scratch, test, isolated, throwaway, temporary or a second one. A
 * copy is named only as a copy of the collector, instance or Standup ("a
 * scratch copy of the collector"): a bare "scratch copy" may be one of a
 * database or any file. A "test run" is a run of tests, so "test" names only
 * a collector, instance, server or install.
 */
export const SCRATCH_INSTANCE =
  /\b(?:(?:scratch|isolated|throwaway|disposable|temp|temporary|second|separate|sandbox(?:ed)?)[\s-]+(?:standup\s+|copy\s+of\s+(?:the\s+)?)?(?:collectors?|instances?|servers?|installs?|standup|runs?)|test[\s-]+(?:standup\s+|copy\s+of\s+(?:the\s+)?)?(?:collectors?|instances?|servers?|installs?|standup))\b/;

/** Programs whose first operand is the step itself (`git push`, `aws lambda`, `gh pr`). */
const SUBCOMMAND_TOOLS = /^(?:git|gh|glab|npm|npx|bun|bunx|yarn|pnpm|aws|docker|podman|kubectl|helm|cdk|cargo|go|pip|pip3|systemctl|launchctl|crontab|tmux)$/;

const orgSubcommandCache = new WeakMap<OrgProfile, readonly RegExp[]>();

/**
 * The org profile's own programs whose first operand is the step: those of
 * its outward CLI rules whose subcommand leads the operands (`corp-deploy
 * promote`, not one read `anywhere`), and of its credential CLIs with a
 * subcommand. The default profile's generic rules are left to SUBCOMMAND_TOOLS.
 */
function orgSubcommandTools(profile: OrgProfile = activeOrgProfile()): readonly RegExp[] {
  let cached = orgSubcommandCache.get(profile);
  if (!cached) {
    const builtin = new Set(DEFAULT_ORG_PROFILE.outwardRules.map((r) => r.program));
    const rules = profile.outwardRules.filter((r) => r.subcommand.length > 0 && !r.anywhere && !builtin.has(r.program)).map((r) => r.program);
    const credentials = profile.credentialClis.filter((r) => r.subcommand.length > 0).map((r) => escapeRegExp(r.program));
    cached = [...rules, ...credentials].map((program) => new RegExp(`^(?:${program})$`));
    orgSubcommandCache.set(profile, cached);
  }
  return cached;
}

/** Whether `program`'s first operand is the step itself (SUBCOMMAND_TOOLS, orgSubcommandTools). */
function takesSubcommand(program: string): boolean {
  return SUBCOMMAND_TOOLS.test(program) || orgSubcommandTools().some((re) => re.test(program));
}

/** Programs that only run the command after them. */
const WRAPPERS = /^(?:env|sudo|timeout|nohup|nice|exec|command|time|xargs|stdbuf)$/;
/** Programs that only print their operands: what they print names nothing the call reaches. */
const PRINTERS = /^(?:echo|printf)$/;
/** The last part of a file name that is its type, not its name. */
const FILE_EXTENSION =
  /^(?:ts|tsx|js|jsx|mjs|cjs|json|ya?ml|toml|md|txt|log|sh|bash|zsh|py|rb|go|rs|java|kt|c|h|cc|cpp|hpp|sql|db|sqlite|sqlite3|lock|env|cfg|conf|ini|xml|html|css|csv|pem|key|token|zip|tar|gz|tgz)$/i;

/**
 * One thing a call reaches. Named when any of `any` is said; on a reserved
 * hold, a path or a host (`key` set) only when one of `key` is said and,
 * when it has any, one of `parents`. A step (`verb`) is named when its verb
 * and one of its object's words are said (or its verb alone, outside a
 * reserved hold, when it has no object).
 */
interface Target {
  any?: string[];
  key?: string[];
  parents?: string[];
  /** The words a path's file type is said by (`database` for standup.db). */
  kind?: string[];
  verb?: string;
  object?: string[];
}

/** Lowercased words of three or more letters, singular, as both sides are read. */
function wordsOf(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .filter((w) => w.length >= 3)
    .map((w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w));
}

function distinctive(text: string): string[] {
  return wordsOf(text).filter((w) => !GENERIC_WORDS.has(w) && !/^\d+$/.test(w));
}

/** A Bash command without its `#` comments. */
export function withoutShellComments(text: string): string {
  return text.replace(/(^|[\s;&|(])#[^\n]*/g, "$1");
}

/** Whether a word reads as a path, a file name, or a host. */
function pathLike(token: string): boolean {
  return /[/~]/.test(token) || /^[\w-]+(?:\.[\w-]+)+$/.test(token);
}

/** Whether a path lies under /tmp/, where the worker picks every name. */
function underTmp(path: string): boolean {
  return /^\/+tmp(?:\/|$)/.test(path);
}

/**
 * The target a path, a file name or a host names, or null for one under
 * /tmp/ or one with no distinctive part. On a reserved hold a relative path
 * that stays in the worktree (no `..`) is null too: it reaches nothing the
 * hold is about.
 */
function pathTarget(value: string, reserved = false, outsideWorktree = false): Target | null {
  const text = value.trim().replace(/^[a-z][\w+.-]*:\/\//i, "");
  if (underTmp(text)) return null;
  const any = distinctive(text);
  if (any.length === 0) return null;
  const bare = text.split(/[?#]/)[0]!;
  const labels = bare.split(/[/:]/)[0]!.split(".");
  if (/^[\w-]+(?:\.[\w-]+)+(?::\d+)?(?:\/|$)/.test(bare) && !FILE_EXTENSION.test(labels.at(-1)!)) {
    // A host: named by its first distinctive label (abc123 in abc123.execute-api.us-west-2.amazonaws.com).
    const first = labels.map((l) => distinctive(l)).find((w) => w.length > 0) ?? [];
    return { any, key: first.slice(0, 1), parents: [] };
  }
  if (reserved && !outsideWorktree && !/^[/~$]/.test(bare) && !/(?:^|\/)\.\.(?:\/|$)/.test(bare)) return null;
  const parts = bare.split("/").filter((p) => p !== "" && p !== "." && p !== "~");
  const name = parts.at(-1) ?? "";
  const extension = name.includes(".") && FILE_EXTENSION.test(name.split(".").at(-1)!) ? name.split(".").at(-1)!.toLowerCase() : "";
  const stem = extension ? name.slice(0, name.lastIndexOf(".")) : name;
  const kind = /^(?:db|sqlite3?)$/.test(extension) ? ["database", "db", "sqlite"] : extension.length >= 3 ? [extension] : [];
  const dirs = parts.slice(0, -1);
  let key = distinctive(stem);
  let parents = dirs.flatMap(distinctive);
  if (key.length === 0) {
    // A generic file name (index.ts): its last distinctive dir names it.
    let at = dirs.length - 1;
    while (at >= 0 && distinctive(dirs[at]!).length === 0) at--;
    if (at < 0) return { any, key: any, parents: [] };
    key = distinctive(dirs[at]!);
    parents = dirs.slice(0, at).flatMap(distinctive);
  }
  return { any, key, parents: parents.filter((w) => !key.includes(w)), kind };
}

/**
 * What one step of a Bash call reaches: the paths, hosts and accounts it
 * names (`reach`), the files it redirects into (`redirects`), and the step
 * itself as its verb and object.
 */
interface StepTargets {
  reach: Target[];
  redirects: Target[];
  verb?: Target;
}

/** Whether `dir` lies in one spelling of `root` (as given, or with or without `/local`). */
function inRoot(dir: string, root: string | undefined): boolean {
  const base = root?.replace(/\/+$/, "");
  if (!base) return false;
  const spellings = [base, base.startsWith("/local/") ? base.slice("/local".length) : `/local${base}`];
  return spellings.some((r) => dir === r || dir.startsWith(`${r}/`)) && !/(?:^|\/)\.\.(?:\/|$)/.test(dir);
}

/**
 * The steps of a Bash call and what each reaches. A `cd`, `pushd` or `popd`
 * that may leave the worktree (to an absolute or home path outside
 * `worktreeRoot`, through `..`, `-` or a variable, or home with no operand)
 * makes the relative paths after it reach past the worktree, until a `cd`
 * back into it.
 */
function bashSteps(command: string, reserved: boolean, worktreeRoot?: string): StepTargets[] {
  const steps: StepTargets[] = [];
  const text = withoutShellComments(command);
  let outside = false;
  for (const segment of text.split(/&&|\|\||[;&|\n]/)) {
    const tokens = segment
      .trim()
      .split(/\s+/)
      .map((t) => t.replace(/^['"]+|['"]+$/g, ""))
      .filter(Boolean);
    let i = 0;
    const reach: Target[] = [];
    const redirects: Target[] = [];
    // Assignments before the command: their values are paths it acts on.
    for (; i < tokens.length; i++) {
      const assignment = /^[A-Za-z_]\w*=(.*)$/.exec(tokens[i]!);
      if (assignment) {
        const target = pathLike(assignment[1]!) ? pathTarget(assignment[1]!, reserved, outside) : null;
        if (target) reach.push(target);
        continue;
      }
      const name = tokens[i]!.split("/").pop() ?? "";
      // A wrapper's `-u <name>` (env's variable to clear, sudo's user) is its option's value, not the command.
      if (/^(?:-u|--unset|--user)$/.test(tokens[i]!)) i++;
      else if (WRAPPERS.test(name) || tokens[i]!.startsWith("-") || /^\d+[smh]?$/.test(tokens[i]!)) continue;
      else break;
    }
    const program = tokens[i]?.split("/").pop();
    if (!program || PRINTERS.test(program)) continue;
    if (/^(?:cd|pushd|popd)$/.test(program)) {
      const dest = tokens[i + 1];
      if (dest === undefined || program === "popd" || dest === "-" || /^[~$]/.test(dest) || /(?:^|\/)\.\.(?:\/|$)/.test(dest)) outside = true;
      else if (dest.startsWith("/")) outside = !inRoot(dest, worktreeRoot);
      // On a reserved hold a `cd` only moves where the rest runs; what that reaches is its own target.
      if (reserved) continue;
    }
    const rest = tokens.slice(i + 1);
    for (const m of [tokens[i]!, ...rest].join(" ").matchAll(/(?<!\d)\d{12}(?!\d)/g)) reach.push({ any: [m[0]] });
    // The words a redirect writes into: `> f`, `>>f`, `2> f`.
    const redirected = new Set<number>();
    rest.forEach((t, k) => {
      if (/^\d*>>?$/.test(t)) redirected.add(k + 1);
      else if (/^\d*>>?./.test(t)) redirected.add(k);
    });
    const operands = rest.filter((t, k) => !t.startsWith("-") && !redirected.has(k) && !/^\d*[<>]+$/.test(t));
    const verb = takesSubcommand(program) ? operands.shift() : program;
    [tokens[i]!, ...rest].forEach((token, k) => {
      const value = token.replace(/^-[\w-]*=/, "").replace(/^\d*[<>]+/, "");
      const target = pathLike(value) ? pathTarget(value, reserved, outside) : null;
      if (target) (k > 0 && redirected.has(k - 1) ? redirects : reach).push(target);
    });
    const step: StepTargets = { reach, redirects };
    steps.push(step);
    if (!verb || pathLike(verb)) continue;
    const verbWord = wordsOf(verb)[0];
    if (!verbWord || GENERIC_WORDS.has(verbWord)) continue;
    // Its object: a path operand by its distinctive part, any other operand by its words; nothing under /tmp/.
    const object = operands.flatMap((o) => {
      const value = o.replace(/^\d*[<>]+/, "");
      if (!pathLike(value)) return distinctive(value);
      return pathTarget(value, reserved, outside)?.key ?? [];
    });
    step.verb = { verb: verbWord, object };
  }
  return steps;
}

function bashTargets(command: string, reserved: boolean, worktreeRoot?: string): Target[] {
  return bashSteps(command, reserved, worktreeRoot).flatMap((s) => [...s.reach, ...s.redirects, ...(s.verb ? [s.verb] : [])]);
}

/** Keys of a tool's input that only carry the text it writes. */
const CONTENT_KEYS = /^(?:content|new_string|old_string|new_source|edits|body|text|description)$/;

function toolTargets(toolName: string, call: string): Target[] {
  const targets: Target[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(call);
  } catch {
    parsed = Object.fromEntries([...call.matchAll(/"(file_path|notebook_path|path|url)"\s*:\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => [m[1], m[2]]));
  }
  const walk = (value: unknown, key: string) => {
    if (CONTENT_KEYS.test(key)) return;
    if (typeof value === "string") {
      if (pathLike(value.trim()) || /^[a-z][\w+.-]*:\/\//i.test(value.trim())) {
        const target = pathTarget(value);
        if (target) targets.push(target);
      }
    } else if (Array.isArray(value)) value.forEach((v) => walk(v, key));
    else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) walk(v, k);
  };
  walk(parsed, "");
  // An MCP tool is named by the distinctive parts of its own name (TrackerCreateTask: tracker).
  if (toolName.startsWith("mcp__")) {
    const parts = toolName
      .split(/__|_|-/)
      .flatMap((part) => part.split(/(?<=[a-z0-9])(?=[A-Z])/))
      .join(" ");
    const named = distinctive(parts).filter((w) => !/^(?:mcp|plugin|create|update|get|put|set|read|write|delete|list|add|remove|action|tool)$/.test(w));
    if (named.length > 0) targets.push({ any: named });
  }
  return targets;
}

/** The distinctive targets of a held call (see the module comment); `reserved` for a high-risk hold. */
export function heldCallTargets(toolName: string | undefined, call: string, reserved = false): Target[] {
  return !toolName || toolName === "Bash" ? bashTargets(call, reserved) : toolTargets(toolName, call);
}

/**
 * Words every Standup job's paths share: on a reserved hold a path whose key
 * is only these is named only together with a parent dir that isn't one, or
 * with its file type (standup.db by "the Standup database";
 * `install/packages/collector` never by "the standup collector").
 */
const STANDUP_WORDS: ReadonlySet<string> = new Set(["collector", "standup", "floor", "install", "package", "packages", "src"]);

export interface NamesHeldCallOptions {
  /** A high-risk hold: a path, host or step is named only by its distinctive part (see the module comment). */
  reserved?: boolean;
  /**
   * The call has a scratch Standup run's shape (allow-check's
   * scratchRunShape): the scratch instance it starts or stops is what it
   * reaches, so naming a scratch, test, isolated or throwaway collector or
   * instance (SCRATCH_INSTANCE) names it.
   */
  scratchRun?: boolean;
  /** The worker's worktree: a `cd` into it keeps the relative paths after it in the worktree. */
  worktreeRoot?: string;
}

/**
 * Whether one of `texts` (the owner's yes, and the question of Persona's it
 * answers) names one of the held call's targets. A call with no target to
 * name is named by nothing.
 */
export function namesHeldCall(
  texts: ReadonlyArray<string | undefined>,
  toolName: string | undefined,
  call: string,
  opts: NamesHeldCallOptions = {}
): boolean {
  if (opts.scratchRun && texts.some((t) => !!t && (SCRATCH_INSTANCE.test(t.toLowerCase().replace(/\s+/g, " ")) || namesScratchPlace(t, call)))) return true;
  const said = new Set(texts.flatMap((t) => (t ? wordsOf(t) : [])));
  for (const t of texts) for (const m of (t ?? "").matchAll(/(?<!\d)\d{12}(?!\d)/g)) said.add(m[0]);
  // "db" is the one short word a file's type is said by.
  if (texts.some((t) => !!t && /\bdbs?\b/i.test(t))) said.add("db");
  const named = (target: Target): boolean => {
    if (target.verb) {
      if (!said.has(target.verb)) return false;
      if (target.object!.length === 0) return !opts.reserved;
      return target.object!.some((w) => said.has(w));
    }
    if (opts.reserved && target.key) {
      if (!target.key.some((w) => said.has(w))) return false;
      if (target.key.every((w) => STANDUP_WORDS.has(w))) {
        return target.parents!.some((w) => !STANDUP_WORDS.has(w) && said.has(w)) || (target.kind ?? []).some((w) => said.has(w));
      }
      return target.parents!.length === 0 || target.parents!.some((w) => said.has(w));
    }
    return (target.any ?? []).some((w) => said.has(w));
  };
  if (!opts.reserved) return heldCallTargets(toolName, call).some(named);
  if (toolName && toolName !== "Bash") {
    const targets = toolTargets(toolName, call);
    return targets.length > 0 && targets.every(named);
  }
  // On a reserved hold every step reaching past /tmp/ and the worktree must be named: each path, host and
  // account it reaches, or the step by its verb and object together with each file it redirects into.
  let any = false;
  for (const step of bashSteps(call, true, opts.worktreeRoot)) {
    const verbNamed = !!step.verb && named(step.verb);
    if (step.reach.length + step.redirects.length === 0) {
      any ||= verbNamed;
      continue;
    }
    const stepNamed = [...step.reach, ...step.redirects].every(named) || (verbNamed && step.redirects.every(named));
    if (!stepNamed) return false;
    any = true;
  }
  return any;
}

/**
 * Whether a text names a scratch run by where it runs: a collector, server
 * or instance under /tmp on a port the call sets (ISOLATION_PORT_ENV), never
 * the live collector's 7777 or the console's 5173.
 */
function namesScratchPlace(text: string, call: string): boolean {
  if (!/(?:^|[\s(])\/tmp\b/.test(text) || !/\b(?:collectors?|standup|instances?|servers?)\b/i.test(text)) return false;
  const ports = new Set<string>();
  for (const m of call.matchAll(new RegExp(`(?:^|[\\s;&|(])(?:${ISOLATION_PORT_ENV.join("|")})=['"]?(\\d{2,5})(?![\\d\\w])`, "g"))) {
    if (m[1] !== "7777" && m[1] !== "5173") ports.add(m[1]!);
  }
  return [...text.matchAll(/\bport\s+(\d{2,5})\b/gi)].some((m) => ports.has(m[1]!));
}
