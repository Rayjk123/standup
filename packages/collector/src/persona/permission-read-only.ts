import type { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "fs";
import { dirname, isAbsolute, join, relative, resolve } from "path";
import type { Ask } from "@standup/shared";
import { getLaunchBySession, getPermissionAskToolUseId } from "@standup/store";
import { classifyToolCall } from "../floor/classify.js";
import type { FloorCall, FloorVerdict } from "../floor/gate.js";
import { serverFloorConfig } from "../floor/routes.js";
import { literalOf, parseShell, type Command, type Redirect, type Script, type Segment, type SimpleCommand, type Word } from "../floor/shell.js";
import { findToolCall, noticeTarget, unfinishedToolCalls, untiedAskCandidates, type HeldToolCall } from "../held-call.js";
import { classifyClaudePane } from "../session-recovery.js";

/*
 * Whether Persona's "allow once" on a tool-permission prompt can run with no
 * owner card: the dialog's call is plainly read-only.
 *
 * The verdict is read from the call itself, as the worker's PreToolUse hook
 * recorded it (tool_name, tool_input, cwd), never from the ask's question or
 * any other text the worker wrote. Two independent checks must both pass:
 *
 * 1. Shape: the call is a read-only tool (Read, Grep, Glob, LS, NotebookRead)
 *    or a shell command whose every step is on a short list of reading
 *    commands, parsed with the safety floor's own shell parser. It writes no
 *    file (output redirects only to /dev/null), runs no program it names from
 *    a variable or a path, spawns nothing in the background, and uses none of
 *    the options that write or run commands (find -exec/-delete, rg --pre,
 *    sed -i or a sed script that writes, reads another file or runs, sort -o,
 *    git --output …).
 * 2. Floor: the safety floor, classifying the call with the launch's own
 *    config, allows it with no hold. So a read of the owner's secrets,
 *    another process's environment, Standup's DB or data dir, or anything
 *    outward stays held.
 *
 * Anything that can't be recovered or read fails closed: no single call
 * behind the dialog, no cwd, no launch, a parse failure, an unknown command,
 * a computed argument where an option could hide, or a floor error.
 *
 * At answer time the call must still be the only one in flight (so no other
 * dialog can be queued behind it), its literal paths must name no FIFO,
 * socket, device, /proc, /sys or /dev entry, and a git read must run in a
 * repository whose own config runs no program (pager, fsmonitor, external
 * diff, textconv, filters, ssh, includes). The collector then confirms on the
 * pane that the open dialog is this call's and types only the option's digit.
 */

export type PermissionReadOnly = { readOnly: true; call: HeldToolCall } | { readOnly: false; why: string };

/** Dialog options that grant a lasting permission rather than this one call. */
export const PERSISTENT_ALLOW = /don'?t ask again|do not ask again|\balways\b|this session|for (?:the|this) project|allow all|\bremember\b/i;

/**
 * Whether a permission answer allows the dialog's call this once: "1" on a
 * dialog with no listed options, else exactly one option (by number or label)
 * whose label starts with "Yes" and grants nothing lasting.
 */
export function permissionAnswerAllowsOnce(ask: Pick<Ask, "options">, answer: unknown): boolean {
  if (typeof answer !== "string") return false;
  const options = ask.options ?? [];
  if (options.length === 0) return answer === "1";
  const chosen = /^\d+$/.test(answer)
    ? options[Number(answer) - 1]
    : options.filter((o) => o.trim().toLowerCase() === answer.trim().toLowerCase()).length === 1
      ? answer
      : undefined;
  return typeof chosen === "string" && /^\s*yes\b/i.test(chosen) && !PERSISTENT_ALLOW.test(chosen);
}

/**
 * The digit that selects the one-time allow `answer` names on the dialog:
 * "1" on a dialog with no listed options, else the chosen option's number.
 * Null when the answer doesn't allow once (permissionAnswerAllowsOnce).
 */
export function permissionAllowDigit(ask: Pick<Ask, "options">, answer: unknown): string | null {
  if (!permissionAnswerAllowsOnce(ask, answer)) return null;
  const text = answer as string;
  const options = ask.options ?? [];
  if (options.length === 0) return "1";
  const n = /^\d+$/.test(text) ? Number(text) : options.findIndex((o) => o.trim().toLowerCase() === text.trim().toLowerCase()) + 1;
  return n >= 1 && n <= 9 ? String(n) : null;
}

/**
 * The digit that selects the deny `answer` names on the dialog: "3" on a
 * dialog with no listed options (Claude Code's "No"), else the number of the
 * one chosen option whose label starts with "No". Null when the answer
 * doesn't deny. A deny runs nothing, so it needs no read-only verdict.
 */
export function permissionDenyDigit(ask: Pick<Ask, "options">, answer: unknown): string | null {
  if (typeof answer !== "string") return null;
  const options = ask.options ?? [];
  if (options.length === 0) return answer === "3" ? "3" : null;
  const n = /^\d+$/.test(answer)
    ? Number(answer)
    : options.filter((o) => o.trim().toLowerCase() === answer.trim().toLowerCase()).length === 1
      ? options.findIndex((o) => o.trim().toLowerCase() === answer.trim().toLowerCase()) + 1
      : 0;
  const chosen = options[n - 1];
  return n >= 1 && n <= 9 && typeof chosen === "string" && /^\s*no\b/i.test(chosen) ? String(n) : null;
}

/** Tools that only read, by what they are. */
const READ_ONLY_TOOLS = new Set(["Read", "Grep", "Glob", "LS", "NotebookRead"]);

/** Longest shell command read as a read-only shape; anything longer keeps the card. */
const MAX_COMMAND_CHARS = 20_000;

/** How deep `bash -c '…'` may nest before the command is held. */
const MAX_SHELL_DEPTH = 3;

/**
 * Variables a bare assignment must not set: each changes which program a
 * later word runs, what a shell reads at startup, or how a reading command
 * behaves (an exported one reaches every child).
 */
const RESERVED_NAMES = new Set([
  "PATH",
  "IFS",
  "HOME",
  "CDPATH",
  "ENV",
  "BASH_ENV",
  "PS4",
  "PROMPT_COMMAND",
  "SHELLOPTS",
  "BASHOPTS",
  "GLOBIGNORE",
  "FPATH",
  "PAGER",
  "MANPAGER",
  "EDITOR",
  "VISUAL",
  "RIPGREP_CONFIG_PATH",
  "TMPDIR",
]);
const RESERVED_PREFIXES = ["LD_", "DYLD_", "GIT_", "BASH_FUNC_", "LESS", "GREP_", "ZDOTDIR", "NODE_", "BUN_", "PYTHON", "PERL", "RUBY"];

/** Commands that read and write nothing, whatever their (literal) arguments. */
const PLAIN_READERS = new Set([
  "cat",
  "head",
  "tail",
  "wc",
  "grep",
  "egrep",
  "fgrep",
  "ls",
  "echo",
  "pwd",
  "true",
  "false",
  ":",
  "test",
  "[",
  "basename",
  "dirname",
  "realpath",
  "readlink",
  "stat",
  "cut",
  "tr",
  "nl",
  "tac",
  "rev",
  "fold",
  "column",
  "diff",
  "cmp",
  "comm",
  "du",
  "md5sum",
  "sha1sum",
  "sha256sum",
  "sha512sum",
  "cksum",
  "sleep",
  "cd",
]);

/**
 * git subcommands that only read the repository. Whatever program one of them
 * could run comes from the repository's config (gitConfigRefusal checks it).
 */
const GIT_READERS = new Set(["status", "diff", "log", "show", "rev-parse", "ls-files", "ls-tree", "blame", "merge-base", "describe", "grep", "rev-list"]);

/**
 * Long git options that write a file, run a program or a pager, read files
 * outside the repository, or verify signatures with gpg. git takes any
 * unambiguous prefix of a long option, so an argument is refused when its
 * name is a prefix of one of these.
 */
const GIT_RISKY_LONG = ["output", "ext-diff", "open-files-in-pager", "textconv", "exec", "upload-pack", "no-index", "show-signature", "filters", "paginate"];
/** Full option names that are a prefix of a risky one but are themselves plain reads; git matches a full name before an abbreviation. */
const GIT_SAFE_EXACT = new Set(["text"]);

/** find primaries that run a program, delete, or write a file. */
const FIND_ACTIONS = new Set(["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf", "-fls"]);

/** sed options that neither write nor run anything. */
const SED_SAFE_FLAGS = new Set(["-n", "-E", "-r", "-s", "-u", "-z", "--quiet", "--silent", "--posix", "--regexp-extended", "--separate", "--unbuffered", "--null-data"]);

class NotReadOnly extends Error {}

/** What a read-only shape names that is checked against the filesystem at answer time (readOnlyFsRefusal). */
export interface ShapeFacts {
  /** Literal arguments and input-redirect targets, as written: any of them may be a path the command opens. */
  paths: string[];
  /** Literal `cd` targets and `git -C` directories, in the order they appear. */
  dirs: string[];
  /** A `cd` whose target is not literal: none (home), `-`, an option or a computed word. */
  unknownDir: boolean;
  usesGit: boolean;
}

/** The facts of the shape being walked; set only for the duration of readOnlyShape. */
let facts: ShapeFacts | null = null;

const fail = (why: string): never => {
  throw new NotReadOnly(why);
};

/** The word's literal text, or a hold when part of it is computed. */
function literal(word: Word, what: string): string {
  const text = literalOf(word);
  if (text === null) fail(`${what} is computed at run time (${word.raw.slice(0, 80)})`);
  return text!;
}

/**
 * Every word must be literal text. A word computed at run time (`$VAR`,
 * `${…}`, `$(…)`, a backtick, arithmetic, a process substitution or a `~`)
 * can name any path, assembled from pieces no check here or in the floor
 * sees (`a=/pr; b=oc; cat $a$b/1/environ`), so it keeps the card, whatever
 * the command assigned earlier.
 */
function checkSegments(segments: readonly Segment[], _depth: number): void {
  for (const s of segments) {
    if (s.kind === "lit") continue;
    if (s.kind === "procsub" && s.dir === ">") fail("an output process substitution writes through a program");
    if (s.kind === "arith") fail("arithmetic expansion can assign variables");
    if (s.kind === "param" && (s.op === "=" || s.op === ":=")) fail(`\${${s.name}${s.op}…} assigns a variable`);
    const shown = s.kind === "tilde" ? `~${s.user}` : s.raw;
    fail(`a word is computed at run time (${shown.slice(0, 80)}), so the path it names can't be checked`);
  }
}

function checkWord(word: Word, depth: number): void {
  checkSegments(word.segments, depth);
}

function checkRedirects(redirects: readonly Redirect[], depth: number): void {
  for (const r of redirects) {
    if (r.op === "<" || r.op === "<<" || r.op === "<<-" || r.op === "<<<") {
      checkWord(r.target, depth);
      if (r.op === "<") {
        const target = literalOf(r.target);
        if (target !== null) facts?.paths.push(target);
      }
      if (r.heredoc?.bodyWord) checkWord(r.heredoc.bodyWord, depth);
      continue;
    }
    if (r.op === ">&" || r.op === "<&") {
      const target = literal(r.target, "a redirect target");
      if (!/^(?:\d+|-)$/.test(target)) fail(`redirect ${r.op}${target} writes a file`);
      continue;
    }
    if (r.op === ">" || r.op === ">>" || r.op === ">|" || r.op === "&>" || r.op === "&>>") {
      const target = literal(r.target, "a redirect target");
      if (target !== "/dev/null") fail(`redirect ${r.op} ${target} writes a file`);
      continue;
    }
    fail(`redirect ${r.op} is not a plain read`);
  }
}

function checkScript(script: Script, depth: number): void {
  for (const item of script.items) {
    if (item.background) fail("a background job outlives the call");
    const pipelines = [item.node.first, ...item.node.rest.map((r) => r.pipeline)];
    for (const pipeline of pipelines) for (const command of pipeline.commands) checkCommand(command, depth);
  }
}

function checkCommand(command: Command, depth: number): void {
  switch (command.kind) {
    case "simple":
      checkSimple(command, depth);
      break;
    case "subshell":
    case "group":
      checkScript(command.body, depth);
      break;
    case "if":
      for (const clause of command.clauses) {
        checkScript(clause.cond, depth);
        checkScript(clause.body, depth);
      }
      if (command.elseBody) checkScript(command.elseBody, depth);
      break;
    case "loop":
      checkScript(command.cond, depth);
      checkScript(command.body, depth);
      break;
    case "for":
      if (command.arith) fail("an arithmetic for loop can assign variables");
      if (RESERVED_NAMES.has(command.variable) || RESERVED_PREFIXES.some((p) => command.variable.startsWith(p))) {
        fail(`the loop sets ${command.variable}`);
      }
      for (const word of command.items ?? []) checkWord(word, depth);
      checkScript(command.body, depth);
      break;
    case "case":
      checkWord(command.subject, depth);
      for (const arm of command.arms) {
        for (const pattern of arm.patterns) checkWord(pattern, depth);
        checkScript(arm.body, depth);
      }
      break;
    case "test":
      for (const word of command.words) checkWord(word, depth);
      break;
    default:
      fail(`a ${command.kind} command is not a plain read`);
  }
  checkRedirects("redirects" in command ? command.redirects : [], depth);
}

function checkAssignments(command: SimpleCommand, depth: number): void {
  for (const a of command.assignments) {
    if (command.words.length > 0) fail(`${a.name}=… changes the environment of the command it prefixes`);
    if (RESERVED_NAMES.has(a.name) || RESERVED_PREFIXES.some((p) => a.name.startsWith(p))) fail(`it sets ${a.name}`);
    if (a.index) checkSegments(a.index, depth);
    for (const word of a.array ?? []) checkWord(word, depth);
    checkWord(a.value, depth);
  }
}

function checkSimple(command: SimpleCommand, depth: number): void {
  checkAssignments(command, depth);
  if (command.words.length === 0) return;
  for (const word of command.words) checkWord(word, depth);
  const name = literal(command.words[0]!, "the command name");
  if (name.includes("/")) fail(`${name} runs a program by path`);
  const args = command.words.slice(1);
  for (const w of args) {
    const text = literalOf(w);
    if (text !== null && !text.startsWith("-")) facts?.paths.push(text);
  }
  if (name === "cd") {
    const target = args.length === 1 ? literalOf(args[0]!) : null;
    if (target === null || target === "" || target.startsWith("-")) {
      if (facts) facts.unknownDir = true;
    } else facts?.dirs.push(target);
    return;
  }
  if (PLAIN_READERS.has(name)) return;
  switch (name) {
    case "printf": {
      // Only the first word can be an option; a computed one could be -v.
      const first = args[0] ? literalOf(args[0]) : "";
      if (first === null || first.startsWith("-v")) fail("printf -v assigns a variable");
      return;
    }
    case "set":
      for (const w of args) {
        const arg = literal(w, "a set argument");
        if (arg === "--") return;
        if (!/^[-+][eux]+$/.test(arg) && arg !== "-o" && arg !== "pipefail") fail(`set ${arg} changes the shell`);
      }
      return;
    case "find":
      for (const w of args) {
        const arg = literal(w, "a find argument");
        if (FIND_ACTIONS.has(arg)) fail(`find ${arg} runs, deletes or writes`);
      }
      return;
    case "rg":
      for (const w of args) {
        const arg = literal(w, "an rg argument");
        if (arg === "--") break;
        if (arg.startsWith("--pre")) fail(`rg ${arg} runs a program on each file`);
        // -z/--search-zip runs a decompressor on each compressed file; --hostname-bin runs a program.
        if (arg.startsWith("--search-zip") || arg.startsWith("--hostname-bin") || /^-[^-]*z/.test(arg)) fail(`rg ${arg} runs a program`);
      }
      return;
    case "sort":
      for (const w of args) {
        const arg = literal(w, "a sort argument");
        if (/^(?:-o|--output|--compress-program)/.test(arg) || /^-[^-]*o/.test(arg)) fail(`sort ${arg} writes a file or runs a program`);
      }
      return;
    case "uniq": {
      const positional = args.map((w) => literal(w, "a uniq argument")).filter((a) => !a.startsWith("-"));
      if (positional.length > 1) fail("uniq with two files writes the second");
      return;
    }
    case "sed":
      checkSed(args.map((w) => literal(w, "a sed argument")));
      return;
    case "git":
      checkGit(args.map((w) => literal(w, "a git argument")));
      return;
    case "bash":
    case "sh":
      checkShellC(name, args, depth);
      return;
    default:
      fail(`${name} is not on the read-only list`);
  }
}

/** sed commands that take no argument and neither read another file, write one nor run anything. */
const SED_PLAIN_COMMANDS = new Set(["p", "d", "P", "D", "n", "N", "=", "h", "H", "g", "G", "x", "z", "{", "}"]);
/**
 * Commands that can add a newline to the pattern space without reading
 * input: from the hold space (`G`, `g`, `x`) or in the text (`s`, `y`). `D`
 * restarts the cycle without reading input while the pattern space holds a
 * newline, so with one of these it can loop forever (`G;D`). Without them
 * each restart removes a newline, and only `N` adds one, by reading a line.
 */
const SED_NEWLINE_MAKERS = new Set(["G", "g", "x", "s", "y"]);
/** Flags of an `s` command that neither write (`w`) nor run the pattern space (`e`). */
const SED_SAFE_S_FLAGS = /^[gpiImM0-9]*$/;

/**
 * Reads a sed regex or replacement delimited by `delim` from `script` at `i`,
 * returning the index just past the closing delimiter, or -1 when it doesn't
 * close. GNU sed ends the part at the first delimiter not after a backslash; a
 * delimiter inside a bracket expression, where other seds read it as literal,
 * is refused so both readings agree on where the flags start.
 */
function sedPart(script: string, i: number, delim: string, regex: boolean): number {
  let bracket = false;
  for (; i < script.length; i++) {
    const c = script[i]!;
    if (c === "\n" && !regex) return -1;
    if (bracket) {
      if (c === delim) return -1;
      if (c === "]") bracket = false;
      continue;
    }
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === delim) return i + 1;
    if (regex && c === "[") {
      bracket = true;
      if (script[i + 1] === "^") i++;
      if (script[i + 1] === "]") i++;
    }
  }
  return -1;
}

/**
 * The most copies of the match (`&`, `\0`–`\9`) a script's replacements may
 * make, and the most `G`/`H` commands it may run: each doubles what it copies,
 * so a few repeated grow the pattern or hold space past any memory.
 */
const SED_MAX_MATCH_COPIES = 4;
const SED_MAX_APPENDS = 4;

/** sed commands that copy the pattern space into the hold space, and that bring the hold space back (`x` does both). */
const SED_HOLD_WRITES = new Set(["h", "H", "x"]);
const SED_HOLD_READS = new Set(["g", "G", "x"]);

/** The copies of the match (`&`, or a `\0`–`\9` backreference) in an `s` replacement's text. */
function sedMatchCopies(replacement: string): number {
  let n = 0;
  for (let i = 0; i < replacement.length; i++) {
    if (replacement[i] === "\\") {
      if (/\d/.test(replacement[i + 1] ?? "")) n++;
      i++;
    } else if (replacement[i] === "&") n++;
  }
  return n;
}

/**
 * Whether a sed script only filters its input to stdout: line addresses
 * (numbers, `$`, `/regex/`, ranges, `!`) on the plain commands, `s` with no
 * `w` or `e` flag, `y`, and `q`/`Q` with an exit code. No command that reads
 * another file (`r`, `R`), writes one (`w`, `W`), runs one (`e`), or branches,
 * no `D` beside a command that can loop it (SED_NEWLINE_MAKERS), and no more
 * match copies or `G`/`H` appends than SED_MAX_MATCH_COPIES and SED_MAX_APPENDS.
 */
export function sedScriptReadOnly(script: string): boolean {
  let i = 0;
  const commands = new Set<string>();
  let copies = 0;
  let appends = 0;
  const skip = (re: RegExp) => {
    while (i < script.length && re.test(script[i]!)) i++;
  };
  const address = (): boolean => {
    const c = script[i];
    if (c === "$") i++;
    else if (c !== undefined && /\d/.test(c)) skip(/[\d~]/);
    else if (c === "/") {
      i = sedPart(script, i + 1, "/", true);
      if (i < 0) return false;
      skip(/[IM]/);
    }
    return true;
  };
  while (i < script.length) {
    skip(/[\s;]/);
    if (i >= script.length) break;
    const start = i;
    if (!address()) return false;
    if (i > start) {
      skip(/[ \t]/);
      if (script[i] === ",") {
        i++;
        skip(/[ \t]/);
        if (script[i] === "+" || script[i] === "~") i++;
        const second = i;
        if (!address() || i === second) return false;
      }
    }
    skip(/[ \t!]/);
    const command = script[i++];
    if (command === undefined) return false;
    if (command === "s" || command === "y") {
      const delim = script[i];
      if (delim === undefined || delim === "\\" || delim === "\n" || /\s/.test(delim)) return false;
      i = sedPart(script, i + 1, delim, true);
      if (i < 0) return false;
      const replacementAt = i;
      i = sedPart(script, i, delim, false);
      if (i < 0) return false;
      if (command === "s") copies += sedMatchCopies(script.slice(replacementAt, i - 1));
      const flagsAt = i;
      skip(/[^\s;}]/);
      if (command === "s" ? !SED_SAFE_S_FLAGS.test(script.slice(flagsAt, i)) : i > flagsAt) return false;
    } else if (command === "q" || command === "Q") {
      skip(/[ \t]/);
      skip(/\d/);
    } else if (!SED_PLAIN_COMMANDS.has(command)) return false;
    if (command === "G" || command === "H") appends++;
    commands.add(command);
    if (command === "{") continue;
    skip(/[ \t]/);
    if (i < script.length && !/[;\n}]/.test(script[i]!)) return false;
  }
  if (copies > SED_MAX_MATCH_COPIES || appends > SED_MAX_APPENDS) return false;
  // The hold space carries over between lines, so a script that both fills it from the pattern space and reads it back
  // (`G;h`, `H;g;h`, `x;s/.*/&&/;x`) can double it on every line.
  if ([...commands].some((c) => SED_HOLD_READS.has(c)) && [...commands].some((c) => SED_HOLD_WRITES.has(c))) return false;
  return !commands.has("D") || ![...commands].some((c) => SED_NEWLINE_MAKERS.has(c));
}

/** sed that only filters its input to stdout: no -i or -f, and every script read-only (sedScriptReadOnly). */
function checkSed(args: string[]): void {
  const scripts: string[] = [];
  let expressions = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "-e" || arg === "--expression") {
      const script = args[++i];
      if (script === undefined) fail("sed -e with no script");
      scripts.push(script!);
      expressions = true;
      continue;
    }
    if (arg.startsWith("-")) {
      if (!SED_SAFE_FLAGS.has(arg) && !/^-[nErsuz]+$/.test(arg)) fail(`sed ${arg} is not a plain read`);
      continue;
    }
    if (!expressions && scripts.length === 0) scripts.push(arg);
  }
  if (scripts.length === 0) fail("sed with no script");
  // sed joins its -e scripts with newlines before reading them.
  const script = scripts.join("\n");
  if (!sedScriptReadOnly(script)) {
    fail("a sed script other than a line print or a plain substitution can write, read another file or run");
  }
}

/** git with a read-only subcommand, optionally after `-C <dir>` or `--no-pager`. */
function checkGit(args: string[]): void {
  if (facts) facts.usesGit = true;
  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;
    if (arg === "-C") {
      const dir = args[i + 1];
      if (dir === undefined || dir === "") fail("git -C with no directory");
      facts?.dirs.push(dir!);
      i += 2;
      continue;
    }
    if (arg === "--no-pager") {
      i++;
      continue;
    }
    break;
  }
  const sub = args[i];
  if (sub === undefined) fail("git with no subcommand");
  if (!GIT_READERS.has(sub!)) fail(`git ${sub} is not a read-only subcommand`);
  for (const arg of args.slice(i + 1)) {
    if (arg === "--") break;
    // A %G placeholder in a format verifies the commit's signature with gpg.
    if (arg.includes("%G")) fail(`git ${sub} ${arg} runs gpg to verify signatures`);
    if (arg.startsWith("--")) {
      const name = arg.slice(2).split("=")[0]!.toLowerCase();
      if (name && !GIT_SAFE_EXACT.has(name) && GIT_RISKY_LONG.some((risky) => risky.startsWith(name))) {
        fail(`git ${sub} ${arg} writes a file or runs a program`);
      }
      continue;
    }
    if (arg === "-o" || arg.startsWith("-O") || (sub === "grep" && /^-[^-]*O/.test(arg))) fail(`git ${sub} ${arg} writes a file or runs a program`);
  }
}

/** `bash -c '<script>' [args…]`: the inline script is read with the same rules. */
function checkShellC(name: string, args: Word[], depth: number): void {
  let i = 0;
  while (i < args.length) {
    const arg = literal(args[i]!, `a ${name} option`);
    if (arg === "-c") break;
    if (!/^-[eux]+$/.test(arg)) fail(`${name} ${arg} runs a script, not an inline read`);
    i++;
  }
  if (i >= args.length) fail(`${name} without -c runs a script`);
  const scriptWord = args[i + 1];
  if (!scriptWord) fail(`${name} -c with no script`);
  const source = literal(scriptWord!, `the ${name} -c script`);
  for (const rest of args.slice(i + 2)) literal(rest, `a ${name} -c argument`);
  if (depth + 1 > MAX_SHELL_DEPTH) fail(`${name} -c nests too deep`);
  checkShellSource(source, depth + 1);
}

function checkShellSource(source: string, depth: number): void {
  if (source.length > MAX_COMMAND_CHARS) fail("the command is too long to read");
  const parsed = parseShell(source);
  if (!parsed.ok) fail(`the command can't be parsed (${parsed.error})`);
  if (parsed.ok) checkScript(parsed.script, depth);
}

/**
 * Why the tool call is not a plainly read-only shape, or null when it is.
 * Pure: reads only the tool name and input.
 */
export function readOnlyShapeRefusal(toolName: string, toolInput: unknown): string | null {
  const shape = readOnlyShape(toolName, toolInput);
  return "refusal" in shape ? shape.refusal : null;
}

/** The path each read-only tool opens or lists. */
const TOOL_PATH_KEYS: Record<string, string> = { Read: "file_path", Grep: "path", Glob: "path", LS: "path", NotebookRead: "notebook_path" };

/**
 * Text that names a kernel or device filesystem entry: /proc (another
 * process's environment, memory or fds), /sys, or /dev other than /dev/null,
 * absolute or relative to a `cd /`. Over-matching only keeps the card.
 */
const SPECIAL_PATHS = [
  /(?<![\w-])\/(?:proc|sys)(?![\w.-])/,
  /(?<![\w-])\/dev(?![\w.-])(?!\/null(?![\w.\/-]))/,
  /(?:^|[\s'"=:;|&(<>`])(?:proc|sys|dev)\//,
];
const SPECIAL_PATH = { test: (text: string) => SPECIAL_PATHS.some((re) => re.test(text)) };

/**
 * The tool call as a plainly read-only shape, with what it names for the
 * filesystem checks, or why it isn't one. Pure: reads only the tool name and
 * input.
 */
export function readOnlyShape(toolName: string, toolInput: unknown): { facts: ShapeFacts } | { refusal: string } {
  if (!toolInput || typeof toolInput !== "object" || Array.isArray(toolInput)) return { refusal: "the call carries no input to read" };
  const input = toolInput as Record<string, unknown>;
  if (READ_ONLY_TOOLS.has(toolName)) {
    const path = input[TOOL_PATH_KEYS[toolName] ?? ""];
    if (path !== undefined && typeof path !== "string") return { refusal: `${toolName}'s path is not text` };
    if (typeof path === "string" && SPECIAL_PATH.test(path)) return { refusal: `${toolName} of ${path} reads a kernel or device file` };
    return { facts: { paths: typeof path === "string" && path ? [path] : [], dirs: [], unknownDir: false, usesGit: false } };
  }
  if (toolName !== "Bash") return { refusal: `${toolName || "the tool"} is not a read-only tool` };
  if (typeof input.command !== "string" || !input.command.trim()) return { refusal: "the Bash call has no command" };
  if (input.run_in_background === true) return { refusal: "a background Bash call outlives the answer" };
  if (SPECIAL_PATH.test(input.command)) return { refusal: "the command names /proc, /sys or a /dev entry other than /dev/null" };
  const collected: ShapeFacts = { paths: [], dirs: [], unknownDir: false, usesGit: false };
  facts = collected;
  try {
    checkShellSource(input.command, 0);
    return { facts: collected };
  } catch (err) {
    if (err instanceof NotReadOnly) return { refusal: err.message };
    return { refusal: `the command couldn't be read (${err instanceof Error ? err.message : String(err)})` };
  } finally {
    facts = null;
  }
}

/** Most paths (after glob expansion) checked against the filesystem; past it the call keeps the card. */
const MAX_FS_PATHS = 2000;
const GLOB_CHARS = /[*?[]/;
/** Where a read opens a kernel or device file rather than a plain one. */
const SPECIAL_ROOTS = ["/proc", "/sys", "/dev"];

function underSpecialRoot(path: string): boolean {
  if (path === "/dev/null") return false;
  return SPECIAL_ROOTS.some((root) => path === root || path.startsWith(`${root}/`));
}

/**
 * The directories the call's paths may be read relative to: its cwd, and
 * every directory a literal `cd` or `git -C` moves to, followed in order.
 */
function baseDirs(cwd: string, shape: ShapeFacts): string[] {
  const bases = [cwd];
  let current = cwd;
  for (const dir of shape.dirs) {
    current = resolve(current, dir);
    bases.push(current, resolve(cwd, dir));
  }
  return [...new Set(bases)];
}

/** The entries a path names: itself, or what its glob matches (bounded), against `base`. */
function* expand(base: string, path: string): Generator<string> {
  const absolute = isAbsolute(path) ? path : resolve(base, path);
  if (!GLOB_CHARS.test(path)) {
    yield absolute;
    return;
  }
  yield absolute;
  // Segment by segment, the way the shell expands it: every directory entry
  // (FIFOs, sockets and devices included) a glob segment matches.
  let current = [isAbsolute(path) ? "/" : base];
  for (const segment of path.split("/").filter((s) => s && s !== ".")) {
    if (!GLOB_CHARS.test(segment)) {
      current = current.map((dir) => join(dir, segment));
      continue;
    }
    const glob = new Bun.Glob(segment);
    const next: string[] = [];
    for (const dir of current) {
      let names: string[] = [];
      try {
        names = statSync(dir, { throwIfNoEntry: false })?.isDirectory() ? readdirSync(dir) : [];
      } catch {
        names = [];
      }
      for (const name of names) {
        if (name.startsWith(".") && !segment.startsWith(".")) continue;
        if (glob.match(name)) next.push(join(dir, name));
        if (next.length > MAX_FS_PATHS) break;
      }
    }
    current = next;
  }
  yield* current;
}

/**
 * Why the call's paths, read at answer time, are not plain files or
 * directories: one names a FIFO (opening it can wake a waiting writer, or hang
 * the call), a socket or a device, or lies under /proc, /sys or /dev. Null
 * when none does. A path that doesn't exist is no refusal; a call whose
 * directory can't be told fails closed.
 */
export function readOnlyPathRefusal(cwd: string, shape: ShapeFacts): string | null {
  if (underSpecialRoot(cwd)) return `the call runs in ${cwd}`;
  if (shape.unknownDir && shape.paths.some((p) => !isAbsolute(p))) return "a cd to a directory that isn't literal leaves its paths unknown";
  const bases = baseDirs(cwd, shape);
  let seen = 0;
  for (const base of bases) {
    if (underSpecialRoot(base)) return `the call reads from ${base}`;
    for (const path of shape.paths) {
      for (const entry of expand(base, path)) {
        if (++seen > MAX_FS_PATHS) return "the call names too many paths to check";
        if (underSpecialRoot(entry)) return `${entry} is a kernel or device file`;
        let kind: ReturnType<typeof statSync> | undefined;
        let real: string | undefined;
        try {
          kind = statSync(entry, { throwIfNoEntry: false });
          real = kind ? realpathSync(entry) : undefined;
        } catch {
          kind = undefined;
        }
        // A symlink into /proc reads as a plain file there (`environ` is one).
        if (real && underSpecialRoot(real)) return `${entry} leads to ${real}, a kernel or device file`;
        if (kind && !kind.isFile() && !kind.isDirectory()) {
          return `${entry} is ${kind.isFIFO() ? "a FIFO" : kind.isSocket() ? "a socket" : "a device"}, not a plain file`;
        }
      }
    }
  }
  return null;
}

/** Config sections whose every key makes a reading git command run a program or read another file. */
const GIT_RISKY_SECTIONS = new Set(["include", "includeif", "filter", "pager", "gpg", "credential", "uploadpack"]);
/**
 * Config keys, in any section, that make a reading git command run a program
 * (core.pager, core.fsmonitor, diff.external, diff.<driver>.textconv or
 * .command, core.sshCommand, remote.<name>.uploadpack …), fetch from a
 * promisor remote, or move the work tree.
 */
const GIT_RISKY_KEYS = new Set([
  "pager",
  "fsmonitor",
  "external",
  "textconv",
  "command",
  "program",
  "sshcommand",
  "showsignature",
  "uploadpack",
  "askpass",
  "gitproxy",
  "promisor",
  "partialclonefilter",
  "alternaterefscommand",
  "helper",
  "worktree",
]);

/** The first risky setting a git config file's text makes, or null. Unreadable section headers count as risky. */
export function gitConfigRisk(text: string): string | null {
  let section = "";
  let continued = false;
  for (const raw of text.split(/\r?\n/)) {
    const wasContinued = continued;
    continued = /\\\s*$/.test(raw);
    if (wasContinued) continue;
    let line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    if (line.startsWith("[")) {
      const header = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"(?:[^"\\]|\\.)*")?\s*\]/.exec(line);
      if (!header) return `an unreadable section header (${line.slice(0, 60)})`;
      section = header[1]!.toLowerCase().split(".")[0]!;
      if (GIT_RISKY_SECTIONS.has(section)) return `[${header[1]}]`;
      line = line.slice(header[0].length).trim();
      if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    }
    const key = /^([A-Za-z][A-Za-z0-9-]*)/.exec(line)?.[1]?.toLowerCase();
    if (key && GIT_RISKY_KEYS.has(key)) return `${section}.${key}`;
  }
  return null;
}

/** The git directory a work tree at or above `dir` uses, or null when there is none. */
function findGitDir(dir: string): string | null {
  for (let current = dir; ; current = dirname(current)) {
    const dotGit = join(current, ".git");
    const stat = statSync(dotGit, { throwIfNoEntry: false });
    if (stat?.isDirectory()) return dotGit;
    if (stat?.isFile()) {
      const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, "utf8"));
      if (!pointer) throw new Error(`${dotGit} names no git directory`);
      return resolve(current, pointer[1]!);
    }
    if (dirname(current) === current) return null;
  }
}

/**
 * Why a git read in these directories could run a program: the repository's
 * own config (its common config, its worktree's config, and config.worktree)
 * sets a pager, fsmonitor, external diff, textconv or filter driver, ssh
 * command, include or the like, or the repository has submodules (whose
 * configs `git status` and `git diff` read too). Null when none does or
 * there is no repository.
 */
export function gitConfigRefusal(dirs: readonly string[]): string | null {
  for (const dir of dirs) {
    const gitDir = findGitDir(dir);
    if (!gitDir) continue;
    const commonFile = join(gitDir, "commondir");
    const commonDir = existsSync(commonFile) ? resolve(gitDir, readFileSync(commonFile, "utf8").trim()) : gitDir;
    if (existsSync(join(commonDir, "modules"))) return `the repository at ${commonDir} has submodules, whose config git reads too`;
    for (const file of new Set([join(commonDir, "config"), join(gitDir, "config"), join(gitDir, "config.worktree")])) {
      if (!existsSync(file)) continue;
      const risk = gitConfigRisk(readFileSync(file, "utf8"));
      if (risk) return `${file} sets ${risk}, which a git read can run`;
    }
  }
  return null;
}

/**
 * The filesystem side of a read-only call, at answer time: no special file
 * among its paths (readOnlyPathRefusal), and for git, a known directory whose
 * repository config runs nothing (gitConfigRefusal). Null when it passes.
 */
export function readOnlyFsRefusal(cwd: string, shape: ShapeFacts): string | null {
  const paths = readOnlyPathRefusal(cwd, shape);
  if (paths) return paths;
  if (!shape.usesGit) return null;
  if (shape.unknownDir) return "a git read after a cd to a directory that isn't literal";
  return gitConfigRefusal(baseDirs(cwd, shape));
}

/** Whether two records are the same call: by tool_use_id, else by the PreToolUse event. */
function sameCall(a: HeldToolCall, b: HeldToolCall): boolean {
  if (a.toolUseId || b.toolUseId) return a.toolUseId === b.toolUseId;
  return a.event.id === b.event.id;
}

/**
 * Why `call` is not the only call in flight in its session, so another
 * dialog could be open or queued behind its own: another call could open a
 * dialog, or a subagent that could start one is running alongside it (a
 * main-thread call with any subagent running, a subagent's call with another
 * running). Null when it is the only one.
 */
export function soleCallRefusal(db: Database, sessionId: string, call: HeldToolCall): string | null {
  const candidates = noticeTarget(db, sessionId).candidates;
  if (!candidates.some((c) => sameCall(c, call))) return "the prompt's call is no longer in flight";
  if (candidates.length > 1) return `${candidates.length} calls are in flight, so another dialog could be queued behind this one`;
  const subagents = unfinishedToolCalls(db, sessionId).filter((c) => (c.toolName === "Agent" || c.toolName === "Task") && !sameCall(c, call));
  if (call.agentId ? subagents.length > 1 : subagents.length > 0) {
    return "a subagent is running alongside the call and could open a dialog behind this one";
  }
  return null;
}

/**
 * The one call a permission ask is about, as its PreToolUse recorded it: the
 * call it is tied to while that call is in flight, or an untied ask's only
 * live candidate. Null when there is none or more than one.
 */
export function permissionAskTarget(db: Database, ask: Ask): HeldToolCall | null {
  const toolUseId = getPermissionAskToolUseId(db, ask.id);
  if (toolUseId) {
    const record = findToolCall(db, ask.sessionId, toolUseId);
    return record && !record.over ? record.call : null;
  }
  const calls = untiedAskCandidates(db, ask) ?? noticeTarget(db, ask.sessionId).candidates;
  return calls.length === 1 ? calls[0]! : null;
}

export interface PermissionReadOnlyOptions {
  /** The collector's environment, as the floor's server-side config reads it. */
  env?: Record<string, string | undefined>;
  /** The floor's classifier (classifyToolCall with no AWS credential lookups by default). */
  classify?: typeof classifyToolCall;
}

/**
 * Whether the call behind a permission ask is plainly read-only: a read-only
 * shape (readOnlyShapeRefusal) that the safety floor, with the launch's own
 * config, allows with no hold. Fails closed on anything it can't recover.
 */
export function permissionAskReadOnly(db: Database, ask: Ask, opts: PermissionReadOnlyOptions = {}): PermissionReadOnly {
  try {
    if (ask.status !== "pending") return { readOnly: false, why: `the prompt is already ${ask.status}` };
    const call = permissionAskTarget(db, ask);
    if (!call) return { readOnly: false, why: "the prompt's call can't be told (none in flight, or more than one)" };
    const sole = soleCallRefusal(db, ask.sessionId, call);
    if (sole) return { readOnly: false, why: sole };
    if (!call.cwd || !call.cwd.startsWith("/")) return { readOnly: false, why: "the call's working directory is not on record" };
    const shape = readOnlyShape(call.toolName, call.toolInput);
    if ("refusal" in shape) return { readOnly: false, why: shape.refusal };
    const fs = readOnlyFsRefusal(call.cwd, shape.facts);
    if (fs) return { readOnly: false, why: fs };
    const launch = getLaunchBySession(db, ask.sessionId);
    if (!launch) return { readOnly: false, why: "the session has no launch to classify the call against" };
    const config = serverFloorConfig(db, launch, {}, opts.env ?? process.env);
    const floorCall: FloorCall = { toolName: call.toolName, toolInput: call.toolInput as Record<string, unknown>, cwd: call.cwd };
    const classify = opts.classify ?? classifyToolCall;
    const verdict: FloorVerdict = classify(floorCall, config, { awsAccount: () => null });
    if (verdict.action !== "allow") return { readOnly: false, why: `the safety floor holds it (${verdict.category}: ${verdict.reason})` };
    return { readOnly: true, call };
  } catch (err) {
    return { readOnly: false, why: `the call couldn't be classified (${err instanceof Error ? err.message : String(err)})` };
  }
}

/**
 * The call Persona's deny of `ask` is typed for, or null when the deny keeps
 * the owner card: the ask's one call, either of a tool whose dialog the pane
 * check reads (so the "No" lands only on that call's dialog) or the only call
 * in flight (so no other call's dialog can be open).
 */
export function permissionDenyTarget(db: Database, ask: Ask): HeldToolCall | null {
  if (ask.status !== "pending") return null;
  const call = permissionAskTarget(db, ask);
  if (!call) return null;
  if (DIALOG_TOOL_TITLES[call.toolName] && DIALOG_TEXT_KEYS[call.toolName]) return call;
  const candidates = noticeTarget(db, ask.sessionId).candidates;
  return candidates.length === 1 && sameCall(candidates[0]!, call) ? call : null;
}

/** The input a tool's permission dialog shows for the call: the command, or the path or pattern. */
const DIALOG_TEXT_KEYS: Record<string, string> = {
  Bash: "command",
  Read: "file_path",
  Grep: "pattern",
  Glob: "pattern",
  LS: "path",
  NotebookRead: "notebook_path",
};
/** How a tool's permission dialog names the tool in its title. */
const DIALOG_TOOL_TITLES: Record<string, RegExp> = {
  Bash: /\bBash\b/,
  Read: /\bRead\b/,
  Grep: /\b(?:Grep|Search)\b/,
  Glob: /\b(?:Glob|Search)\b/,
  LS: /\b(?:LS|List)\b/,
  NotebookRead: /\b(?:NotebookRead|Notebook|Read)\b/,
};
const DIALOG_RULE = /^[\s╭╰]*[─━]{8,}/;
const DIALOG_QUESTION = /\bDo you want to\b/i;
const DIALOG_OPTION = /^[\s│]*(?:❯|›|>)?\s*(\d+)\.\s+(.*?)[\s│]*$/;
/** Text with every space, line break and box edge taken out, so a command the dialog wraps compares equal to the one recorded. */
const squash = (text: string) => text.replace(/[\s│╭╮╰╯]+/g, "");

/**
 * Why the captured pane is not showing this call's tool-permission dialog
 * with option `digit` a one-time "Yes", or null when it is. The dialog is the
 * block under the last rule above its "Do you want to …" question: its title
 * names the call's tool, its body is exactly the call's command (or path or
 * pattern), optionally followed by the Bash call's description, and its
 * options are numbered from 1 with `digit` among them. Text above the rule is
 * transcript and is never read. With `want` "deny", option `digit` must read
 * "No" instead, and a call of a tool whose dialog isn't read here (the only
 * call in flight, permissionDenyTarget) skips the call check. Pure.
 */
export function permissionDialogRefusal(
  screen: string,
  call: HeldToolCall,
  digit: string,
  want: "allow" | "deny" = "allow"
): string | null {
  if (classifyClaudePane(screen).kind !== "permission") return "the pane shows no tool-permission dialog";
  const lines = screen.split("\n").map((l) => l.trimEnd());
  const questions = lines.flatMap((l, i) => (DIALOG_QUESTION.test(l) ? [i] : []));
  const questionAt = questions[questions.length - 1];
  if (questionAt === undefined) return "the dialog's question isn't on screen";
  let ruleAt = -1;
  for (let i = questionAt - 1; i >= 0; i--) {
    if (DIALOG_RULE.test(lines[i]!)) {
      ruleAt = i;
      break;
    }
  }
  if (ruleAt < 0) return "the dialog's top edge isn't on screen";
  if (questions.some((i) => i > ruleAt && i !== questionAt)) return "the dialog asks more than one question";

  const options = lines.slice(questionAt + 1).flatMap((l) => {
    const m = DIALOG_OPTION.exec(l);
    return m ? [{ n: m[1]!, label: m[2]! }] : [];
  });
  if (options.length === 0 || options.some((o, i) => o.n !== String(i + 1))) return "the dialog's options aren't numbered 1, 2, …";
  const chosen = options.find((o) => o.n === digit);
  if (!chosen) return `the dialog has no option ${digit}`;
  if (want === "deny") {
    if (!/^no\b/i.test(chosen.label)) return `option ${digit} reads "${chosen.label}", not a no`;
    if (!DIALOG_TOOL_TITLES[call.toolName]) return null;
  } else if (!/^yes\b/i.test(chosen.label) || PERSISTENT_ALLOW.test(chosen.label)) {
    return `option ${digit} reads "${chosen.label}", not a one-time yes`;
  }

  const header = lines.slice(ruleAt + 1, questionAt).filter((l) => l.trim() !== "");
  const title = header[0];
  const titled = DIALOG_TOOL_TITLES[call.toolName];
  const key = DIALOG_TEXT_KEYS[call.toolName];
  if (!titled || !key) return `a ${call.toolName} dialog isn't one Standup reads`;
  if (!title || !titled.test(title)) return `the dialog is not a ${call.toolName} dialog`;
  const input = (call.toolInput ?? {}) as Record<string, unknown>;
  const shownText = input[key];
  if (typeof shownText !== "string" || !shownText.trim()) return "the call has no text the dialog shows";
  const forms = [shownText];
  if (call.cwd && isAbsolute(shownText)) forms.push(relative(call.cwd, shownText));
  const description = typeof input.description === "string" ? squash(input.description) : "";
  const body = squash(header.slice(1).join(""));
  const whole = squash(header.join(""));
  const matches = forms.some((form) => {
    const text = squash(form);
    return !!text && (body === text || (!!description && body === text + description) || whole === squash(`${call.toolName}(${form})`));
  });
  return matches ? null : `the open dialog shows a different ${call.toolName} call`;
}
