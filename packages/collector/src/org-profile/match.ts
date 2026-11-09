import type { CheckoutToolRule, CredentialCliRule, OrgCliRule, OrgHttpClient, OrgProfile, OrgWrapperRule, ReviewWriteToolRule, SelfFiledToolRule } from "./types.js";

/**
 * Pure readings of an OrgProfile, for the safety floor, Persona's allow
 * check and the code-review adapter. Patterns are compiled once per profile
 * object and cached.
 */

interface CompiledCliRule {
  program: RegExp;
  valueOptions: ReadonlySet<string>;
  subcommand: RegExp[];
  rule: OrgCliRule;
}

interface Compiled {
  outward: CompiledCliRule[];
  remotes: RegExp[];
  provisions: RegExp[];
  subdirs: RegExp[];
  pluginPrefixes: RegExp[];
}

const compiled = new WeakMap<OrgProfile, Compiled>();

function compile(source: string, flags = ""): RegExp | null {
  try {
    return new RegExp(source, flags);
  } catch {
    return null;
  }
}

function compiledOf(profile: OrgProfile): Compiled {
  let c = compiled.get(profile);
  if (!c) {
    c = {
      outward: profile.outwardRules.flatMap((rule) => {
        const program = compile(`^(?:${rule.program})$`);
        const subcommand = rule.subcommand.map((w) => compile(`^(?:${w})$`));
        if (!program || subcommand.some((re) => !re)) return [];
        return [{ program, valueOptions: new Set(rule.valueOptions ?? []), subcommand: subcommand as RegExp[], rule }];
      }),
      remotes: profile.codeReview.remotePatterns.flatMap((p) => compile(p, "i") ?? []),
      provisions: profile.codeReview.provisionPatterns.flatMap((p) => compile(p, "i") ?? []),
      subdirs: profile.codeReview.launchSubdirPatterns.flatMap((p) => compile(p) ?? []),
      pluginPrefixes: profile.mcp.pluginPrefixes.flatMap((p) => compile(`^(?:${p})`) ?? []),
    };
    compiled.set(profile, c);
  }
  return c;
}

/** Whether `host` (a DNS name) is one of the org's internal hosts: equal to, or under, an internalHostSuffixes entry. */
export function isOrgInternalHost(profile: OrgProfile, host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return profile.internalHostSuffixes.some((s) => h === s || h.endsWith(`.${s}`));
}

/** Whether `subcommand` matches the words of `words` from `at` on, one pattern per word. */
function subcommandAt(subcommand: readonly RegExp[], words: readonly string[], at: number): boolean {
  return at + subcommand.length <= words.length && subcommand.every((re, k) => re.test(words[at + k]!));
}

function cliRuleMatches(c: CompiledCliRule, words: readonly string[]): boolean {
  if (!c.program.test(words[0] ?? "")) return false;
  if (c.rule.anywhere) {
    for (let at = 1; at + c.subcommand.length <= words.length; at++) if (subcommandAt(c.subcommand, words, at)) return true;
    return false;
  }
  let at = 1;
  while (at < words.length && words[at]!.startsWith("-")) {
    if (words[at] === "--") {
      at++;
      break;
    }
    at += c.valueOptions.has(words[at]!) ? 2 : 1;
  }
  return subcommandAt(c.subcommand, words, at);
}

/**
 * The profile rules that match `named` — `<program> <args…>` with free text
 * masked, words split on spaces — in profile order. Each rule's patterns are
 * tried against single words only, so the work is linear in the word count.
 */
export function orgCliRulesMatching(profile: OrgProfile, named: string): OrgCliRule[] {
  const words = named.split(" ").filter((w) => w !== "");
  if (words.length === 0) return [];
  return compiledOf(profile).outward.filter((c) => cliRuleMatches(c, words)).map((c) => c.rule);
}

/**
 * Whether a regex source repeats a group (`(…)*`, `(…)+`, `(…){n,m}`). A
 * repeated group whose body can match one stretch of text more than one way
 * backtracks exponentially when the match fails, and the floor classifies
 * synchronously, so the loader refuses every profile pattern that has one.
 */
export function repeatsGroup(source: string): boolean {
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      continue;
    }
    if (c === "[") {
      // In a JS regex a `]` right after `[` or `[^` closes the class (`[]`, `[^]`).
      inClass = true;
      if (source[i + 1] === "^") i++;
      continue;
    }
    if (c === ")" && /[*+{]/.test(source[i + 1] ?? "")) return true;
  }
  return false;
}

/** Whether `program` (a bare name) is one of the org's code-review CLIs. */
export function isOrgReviewCli(profile: OrgProfile, program: string): boolean {
  return profile.reviewClis.includes(program);
}

/** The credential-CLI rule for `program`, or undefined. */
export function orgCredentialCli(profile: OrgProfile, program: string): CredentialCliRule | undefined {
  return profile.credentialClis.find((r) => r.program === program);
}

/** The wrapper rule for `program` (a bare name), or undefined. */
export function orgWrapperCli(profile: OrgProfile, program: string): OrgWrapperRule | undefined {
  return profile.wrapperClis.find((r) => r.program === program);
}

/** The HTTP client entry for `program` (a bare name), or undefined. */
export function orgHttpClient(profile: OrgProfile, program: string): OrgHttpClient | undefined {
  return profile.httpClients.find((r) => r.program === program);
}

const programNames = new WeakMap<OrgProfile, ReadonlySet<string>>();

/**
 * The org's own CLIs the profile names by their bare name: its review,
 * credential, SSO login and wrapper CLIs. Text that names one as a command
 * word is read as naming a command the floor holds or reads through.
 */
export function orgProgramNames(profile: OrgProfile): ReadonlySet<string> {
  let names = programNames.get(profile);
  if (!names) {
    names = new Set([...profile.reviewClis, ...orgCredentialPrograms(profile), ...profile.wrapperClis.map((r) => r.program)]);
    programNames.set(profile, names);
  }
  return names;
}

/**
 * The options a credential write is read by for any program the floor has
 * no handler for, whatever the org profile lists: a role and an account.
 * The floor and Persona's allow check read the same names.
 */
export const GENERIC_ROLE_OPTIONS: readonly string[] = ["--role", "--role-name"];
/** See GENERIC_ROLE_OPTIONS. */
export const GENERIC_ACCOUNT_OPTIONS: readonly string[] = ["--account", "--account-id"];
/** An operand naming credentials. Beside one, `-r` and `-a` name the role and the account too. */
export const CREDENTIAL_NOUN = /^cred(?:s|ential|entials)?$/i;
/** An operand that prints what the operand before it names (`<cli> credentials show`). */
export const CREDENTIAL_PRINT_VERB = /^(?:print|get|export|show|dump|display|env|output|cat|reveal)$/i;
/** One operand that prints credentials by itself (`print-credentials`, `creds-export`). */
export const CREDENTIAL_PRINT_WORD = /^(?:(?:print|get|export|show|dump)-cred(?:s|entials?)|cred(?:s|entials?)-(?:print|get|export|show|dump))$/i;
/** A program named for credentials (`docker-credential-pass`, `corp-creds`): a print verb as its first operand prints them. */
export const CREDENTIAL_PROGRAM = /(?:^|[-_.])cred(?:s|ential|entials)?(?:[-_.]|$)/i;

/**
 * Programs that only print, read or test the words they are given, which the
 * floor reads as data and never as a credential CLI: a credential noun, a
 * role or an account they name (`grep -q 444455556666`,
 * `[ "$acct" = 444455556666 ]`) writes and switches no credentials.
 */
const WORD_READER = /^(?:echo|printf|cat|grep|egrep|fgrep|zgrep|rg|test|\[|\[\[|true|false|jq|head|tail|wc|sort|uniq|cut|tr|ls|pwd|sleep|date|expr|seq|printenv|basename|dirname|diff|cmp|stat|file)$/;
/** Words that may stand before a step's program without being one: shell keywords and grouping. */
const STEP_KEYWORD = /^(?:if|then|elif|else|do|while|until|!|\{|\()$/;
/**
 * A shell word as written, quotes kept: a quoted span with spaces in it
 * (`-m "rotate credentials"`) is one word, as the shell reads it.
 */
const SHELL_WORD = /(?:[^\s'"]+|'[^']*'|"(?:[^"\\]|\\.)*"|['"])+/g;

/**
 * A command that runs the command after its own options and operands, as a
 * prefix of a step (`env FOO=1 <cli> …`, `sudo -u bob <cli> …`,
 * `timeout 30 <cli> …`): `valued` names its options that take the next word
 * as their value, `operands` counts the operands it reads before the
 * command (`timeout`'s duration, `flock`'s file; Infinity for one that runs
 * no command operand, as `su bob`), and `assignments` whether it reads
 * `NAME=value` words before the command. `script` names the options whose
 * value is a shell script it runs (`su -c '<command>'`, `flock <file> -c
 * '<command>'`), `split` those whose value it splits into the command it
 * runs (`env -S '<command> …'`), and `joins` whether it runs the words after
 * its options joined as one shell script (`watch '<command>'`).
 */
interface PrefixCommand {
  valued: readonly string[];
  operands: number;
  assignments: boolean;
  script: readonly string[];
  split: readonly string[];
  joins: boolean;
}
const prefix = (
  valued: readonly string[],
  operands = 0,
  assignments = false,
  { script = [], split = [], joins = false }: { script?: readonly string[]; split?: readonly string[]; joins?: boolean } = {}
): PrefixCommand => ({ valued, operands, assignments, script, split, joins });
/** The options of `su` and `runuser` that take a value, and those whose value is the shell script they run. */
const SU_VALUED = ["-s", "--shell", "-g", "--group", "-G", "--supp-group", "-w"];
const SU_SCRIPT = ["-c", "--command", "-C", "--session-command"];
const PREFIX_COMMANDS: ReadonlyMap<string, PrefixCommand> = new Map([
  ["env", prefix(["-u", "--unset", "-C", "--chdir"], 0, true, { split: ["-S", "--split-string"] })],
  [
    "sudo",
    prefix(
      ["-u", "--user", "-g", "--group", "-h", "--host", "-p", "--prompt", "-C", "--close-from", "-D", "--chdir", "-r", "--role", "-t", "--type", "-U", "--other-user", "-T", "--command-timeout"],
      0,
      true
    ),
  ],
  ["doas", prefix(["-u", "-C"])],
  ["nice", prefix(["-n", "--adjustment"])],
  ["ionice", prefix(["-c", "--class", "-n", "--classdata", "-p", "--pid", "-P", "--pgid", "-u", "--uid"])],
  ["timeout", prefix(["-s", "--signal", "-k", "--kill-after"], 1)],
  ["command", prefix([])],
  ["builtin", prefix([])],
  ["exec", prefix(["-a"])],
  ["nohup", prefix([])],
  ["setsid", prefix([])],
  ["time", prefix(["-f", "--format", "-o", "--output"])],
  ["stdbuf", prefix(["-i", "--input", "-o", "--output", "-e", "--error"])],
  ["xargs", prefix(["-a", "--arg-file", "-d", "--delimiter", "-E", "-I", "-L", "--max-lines", "-n", "--max-args", "-P", "--max-procs", "-s", "--max-chars", "--process-slot-var"])],
  ["flock", prefix(["-w", "--timeout", "-E", "--conflict-exit-code"], 1, false, { script: ["-c", "--command"] })],
  ["su", prefix(SU_VALUED, Infinity, false, { script: SU_SCRIPT })],
  // `runuser -u <user> [--] <command>` runs a command operand; `runuser <user> -c '<command>'` runs a script.
  ["runuser", prefix([...SU_VALUED, "-u", "--user"], Infinity, false, { script: SU_SCRIPT })],
  [
    "script",
    prefix(["-E", "--echo", "-I", "--log-in", "-O", "--log-out", "-B", "--log-io", "-T", "--log-timing", "-m", "--logging-format"], Infinity, false, {
      script: ["-c", "--command"],
    }),
  ],
  ["watch", prefix(["-n", "--interval"], 0, false, { joins: true })],
  ["chroot", prefix(["--userspec", "--groups"], 1)],
  ["nsenter", prefix(["-t", "--target", "-S", "--setuid", "-G", "--setgid"])],
  ["strace", prefix(["-e", "-o", "-p", "-s", "-u", "-E", "-a", "-b", "-I", "-P", "-X", "-O", "-S"])],
  ["taskset", prefix([], 1)],
  ["chrt", prefix(["-T", "--sched-runtime", "-P", "--sched-period", "-D", "--sched-deadline"], 1)],
  [
    "systemd-run",
    prefix(["-u", "--unit", "-p", "--property", "-E", "--setenv", "-M", "--machine", "-H", "--host", "--uid", "--gid", "--nice", "--description", "--slice", "--working-directory"]),
  ],
  ["pkexec", prefix(["--user"])],
  ["unbuffer", prefix([])],
  ["busybox", prefix([])],
]);
/** A shell whose `-c` operand is a script it runs (`sh -c '<command>'`, `bash -lc "<command>"`, `fish --command='<command>'`). */
const SHELL_PROGRAMS: ReadonlySet<string> = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "ash", "fish"]);
/**
 * A redirect word (`>/dev/null`, `2>&1`, `&>log`, `<in`), which may stand
 * anywhere in a step, before its program too; group 1 is its target, and
 * when that is empty the target is the next word (`> /dev/null`).
 */
const REDIRECT = /^\d*(?:&>>|&>|<<<|<<-?|>>|>\||>&|<&|<>|>|<)([\s\S]*)$/;
/** A `find` action that runs the command after it, up to a `;` or `+` word. */
const FIND_EXEC = /^-(?:exec|execdir|ok|okdir)$/;
/** How deep shell scripts nested in shell scripts are read; a step nested deeper is read as a credential write naming no account. */
const MAX_SCRIPT_DEPTH = 8;

/** A shell word with its quotes and backslashes read as the shell reads them: `'a b'` is `a b`, `"say \"hi\""` is `say "hi"`. */
function shellUnquote(word: string): string {
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < word.length; i++) {
    const c = word[i]!;
    if (quote === "'") {
      if (c === "'") quote = null;
      else out += c;
      continue;
    }
    if (c === "\\" && i + 1 < word.length) {
      const next = word[i + 1]!;
      // Inside double quotes a backslash escapes only `$`, a backtick, `"`, `\` and a newline.
      if (quote === '"' && !/[$`"\\\n]/.test(next)) {
        out += c;
        continue;
      }
      // A backslash before a newline joins the lines.
      if (next !== "\n") out += next;
      i++;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = null;
      else out += c;
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else out += c;
  }
  return out;
}

/** A script split into its steps at the shell's operators (`;`, `&`, `|`, `&&`, `||`, newlines) outside quotes; `2>&1` and `&>` are redirects. */
function scriptSteps(script: string): string[] {
  const steps: string[] = [];
  let text = "";
  let quote: string | null = null;
  for (let i = 0; i < script.length; i++) {
    const c = script[i]!;
    if (c === "\\" && quote !== "'") {
      text += c + (script[i + 1] ?? "");
      i++;
      continue;
    }
    if (quote) {
      if (c === quote) quote = null;
      text += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      text += c;
      continue;
    }
    const redirect = c === "&" && (/[<>]$/.test(text) || script[i + 1] === ">");
    if (/[;&|\n]/.test(c) && !redirect) {
      steps.push(text);
      text = "";
      continue;
    }
    text += c;
  }
  steps.push(text);
  return steps.map((s) => s.trim()).filter(Boolean);
}

/**
 * The generic reading of each step of a script (credentialStepAccounts), or
 * null when no step of it is a credential step: the accounts every
 * credential step names, together.
 */
function scriptAccounts(script: string, depth: number, known: KnownCredentialProgram): string[] | null {
  return together(scriptSteps(script).map((s) => credentialStepAccounts(s, depth + 1, known)));
}

/** Several readings as one: null when each is null, else the accounts each names, together. */
function together(reads: readonly (string[] | null)[]): string[] | null {
  return reads.some((r) => r !== null) ? reads.flatMap((r) => r ?? []) : null;
}

/**
 * The scripts a step's command substitutions run, outside single quotes:
 * `$(…)` (not `$((…))`, which is arithmetic) and backticks, and `<(…)` and
 * `>(…)` outside double quotes too. One unclosed runs to the end of the step.
 */
function substitutions(step: string): string[] {
  const found: string[] = [];
  // The index of the `)` closing the parenthesis opened before `from`, past quoted spans and nested parentheses.
  const closing = (from: number): number => {
    let depth = 1;
    let quote: string | null = null;
    for (let j = from; j < step.length; j++) {
      const c = step[j]!;
      if (quote) {
        if (c === quote) quote = null;
        else if (c === "\\" && quote === '"') j++;
        continue;
      }
      if (c === "\\") j++;
      else if (c === "'" || c === '"') quote = c;
      else if (c === "(") depth++;
      else if (c === ")" && --depth === 0) return j;
    }
    return step.length;
  };
  let quote: string | null = null;
  for (let i = 0; i < step.length; i++) {
    const c = step[i]!;
    if (quote === "'") {
      if (c === "'") quote = null;
      continue;
    }
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === '"') quote = quote ? null : '"';
    else if (c === "'" && !quote) quote = "'";
    else if (c === "`") {
      let j = i + 1;
      while (j < step.length && step[j] !== "`") j += step[j] === "\\" ? 2 : 1;
      found.push(step.slice(i + 1, j));
      i = j;
    } else if (step[i + 1] === "(" && (c === "$" || (!quote && (c === "<" || c === ">")))) {
      if (c === "$" && step[i + 2] === "(") {
        i++;
        continue;
      }
      const end = closing(i + 2);
      found.push(step.slice(i + 2, end));
      i = end;
    }
  }
  return found;
}

/** A program the caller knows writes credentials (an org profile's credential CLIs), given as the step runs it, its quotes read: `/opt/bin/corp-creds`. */
export type KnownCredentialProgram = (program: string) => boolean;
const NO_KNOWN_PROGRAM: KnownCredentialProgram = () => false;

/**
 * A shell step's credential step as the generic reading sees it in text, as
 * the floor reads a program with no handler of its own: null when its
 * program (after any shell keyword and variable assignments) only reads its
 * words (WORD_READER), or when it writes no credentials and names no
 * account. It writes credentials when the program is named for credentials
 * (CREDENTIAL_PROGRAM: `cloud-creds refresh`, `docker-credential-x $VERB`),
 * or has a credential noun among its own words (before a `run|exec`
 * wrapper's `--`), whatever else it names (`<cli> credentials refresh`); is
 * a `run|exec` wrapper naming an account or role before its `--`; or names a
 * role option (GENERIC_ROLE_OPTIONS, or `-r` beside a credential noun) and
 * an account or a word the reader can't read. Any verb is read as a write
 * there, not only the write verbs the floor reads as one (`update`,
 * `refresh`, `renew`): `<cli> credentials list` may still write an account
 * no one can tell.
 * A role alone away from a credential noun (`kubectl … --role=viewer`,
 * `<cli> assume --role Admin`) is no write, and nor is a step naming no role,
 * account or credential noun (`<cli> assume`): the generic reading has
 * nothing that names it a credential step. An account named without a role
 * or noun (`<cli> assume 444455556666`, `<cli> --account N`) is no write
 * either, but may switch the credentials a later AWS call uses. Words are
 * read as the shell splits them: a credential noun inside a quoted message
 * (`git commit -m "rotate credentials"`) is no operand.
 * The program is the one a step runs: past any redirect (`>/dev/null
 * <cli>`), and any prefix command and its options (one short-option cluster
 * as getopt reads it: `sudo -iu bob <cli>`) and operands (PREFIX_COMMANDS:
 * `env FOO=1 <cli>`, `sudo -u bob <cli>`, `timeout 30 <cli>`, `command
 * <cli>`, `\sudo <cli>`; `command -v <cli>` only prints where it is). A
 * shell's `-c` script (`sh -c '<command>'`, `sudo bash -lc "<command>"`),
 * `eval`'s words, `env -S`'s string, a prefix command's script option
 * (`su bob -c '<command>'`, `flock <file> -c '<command>'`), `watch`'s words,
 * the command of each `find -exec … ;` and each command substitution
 * (`$(<command>)`, backticks, `<(<command>)`) are read as the steps they
 * run, each by this reading: a credential step among them makes the step
 * one, naming the accounts each names.
 * Otherwise the values its account options (GENERIC_ACCOUNT_OPTIONS, or
 * `-a` beside a credential noun) give, as written, quotes kept — or, with
 * no account option, its bare 12-digit words, or with neither, the
 * program's own words the reader can't read (`$ARGS`), any of which may
 * name the account. An empty list: a credential write naming no account the
 * reader can see.
 * A `known` program is read as one named for credentials, wherever the step
 * runs it.
 */
export function genericCredentialStepAccounts(step: string, known: KnownCredentialProgram = NO_KNOWN_PROGRAM): string[] | null {
  return credentialStepAccounts(step, 0, known);
}

function credentialStepAccounts(step: string, depth: number, known: KnownCredentialProgram): string[] | null {
  if (depth > MAX_SCRIPT_DEPTH) return [];
  return together([...substitutions(step).map((s) => scriptAccounts(s, depth, known)), programAccounts(step, depth, known)]);
}

/** The words of a shell step, quotes kept, read by credentialStepAccounts for the program it runs. */
function programAccounts(step: string, depth: number, known: KnownCredentialProgram): string[] | null {
  const all: string[] = step.match(SHELL_WORD) ?? [];
  // A program word as the shell runs it: its quotes and backslashes read, past a subshell's `(`.
  const programOf = (w: string) => shellUnquote(w).replace(/^\(+/, "");
  const baseOf = (w: string) => programOf(w).replace(/^.*\//, "");
  const assignment = (w: string) => /^[A-Za-z_]\w*=/.test(w);
  // The index of the first word at or after `at` that is no shell keyword, assignment or redirect (with its target).
  const skip = (at: number): number => {
    let p = at;
    while (p < all.length) {
      const w = all[p]!;
      const redirect = REDIRECT.exec(w);
      if (redirect) p += redirect[1] ? 1 : 2;
      else if (STEP_KEYWORD.test(w) || assignment(w)) p++;
      else break;
    }
    return p;
  };
  let p = skip(0);
  if (p >= all.length) return null;
  // Past each prefix command, its options (and the values of those that take one), its assignments and its operands.
  for (let rule = PREFIX_COMMANDS.get(baseOf(all[p]!)); rule; rule = PREFIX_COMMANDS.get(baseOf(all[p]!))) {
    const name = baseOf(all[p]!);
    let operands = rule.operands;
    let i = p + 1;
    for (; i < all.length; i++) {
      const w = all[i]!;
      if (w === "--") {
        i++;
        break;
      }
      const redirect = REDIRECT.exec(w);
      if (redirect) {
        if (!redirect[1]) i++;
        continue;
      }
      if (w.startsWith("-") && w.length > 1) {
        if (name === "command" && /^-[a-zA-Z]*[vV]/.test(w)) return null;
        // A long option with its value after `=` or in the next word, or a cluster of short options (`-iu bob`), where
        // the first that takes a value takes the rest of the word, or the next word when it ends the word.
        const long = /^(--[^=]+)(?:=([\s\S]*))?$/.exec(w);
        const options = long ? [{ o: long[1]!, value: long[2] }] : [...w.slice(1)].map((c, k) => ({ o: `-${c}`, value: w.slice(k + 2) || undefined }));
        for (const { o, value } of options) {
          const given = shellUnquote(value ?? all[i + 1] ?? "");
          // `env -S '<command> …'` splits its string into the command it runs, before the words after it.
          if (rule.split.includes(o)) return credentialStepAccounts([given, ...all.slice(value === undefined ? i + 2 : i + 1)].join(" "), depth + 1, known);
          if (rule.script.includes(o)) return scriptAccounts(given, depth, known);
          // `runuser -u <user>` runs the command after its options.
          if (name === "runuser" && (o === "-u" || o === "--user")) operands = 0;
          if (rule.valued.includes(o)) {
            if (value === undefined) i++;
            break;
          }
        }
        continue;
      }
      if (rule.assignments && assignment(w)) continue;
      if (operands > 0) {
        operands--;
        continue;
      }
      break;
    }
    p = skip(i);
    if (p >= all.length) return null;
    if (rule.joins) return scriptAccounts(all.slice(p).map(shellUnquote).join(" "), depth, known);
  }
  const words = all.slice(p);
  const program = programOf(words[0]!);
  const base = program.replace(/^.*\//, "");
  if (WORD_READER.test(base)) return null;
  if (base === "eval") return scriptAccounts(words.slice(1).map(shellUnquote).join(" "), depth, known);
  if (SHELL_PROGRAMS.has(base)) {
    let command = false;
    for (let i = 1; i < words.length; i++) {
      const w = words[i]!;
      const long = /^--command(?:=([\s\S]*))?$/.exec(w);
      if (long) return scriptAccounts(shellUnquote(long[1] ?? words[i + 1] ?? ""), depth, known);
      if (/^[-+][oO]$|^--(?:rcfile|init-file)$/.test(w)) i++;
      else if (/^-[A-Za-z]*c[A-Za-z]*$/.test(w)) command = true;
      else if (!/^[-+]/.test(w)) {
        if (command) return scriptAccounts(shellUnquote(w), depth, known);
        break;
      }
    }
    if (command) return null;
  }
  if (base === "find") {
    // The command of each `-exec … ;` (or `… +`) is a step of its own; find's own words are read as any program's.
    const execs: (string[] | null)[] = [];
    let own = words.length;
    for (let i = 1; i < words.length; i++) {
      if (!FIND_EXEC.test(shellUnquote(words[i]!))) continue;
      own = Math.min(own, i);
      let j = i + 1;
      while (j < words.length && !/^(?:;|\+)$/.test(shellUnquote(words[j]!))) j++;
      execs.push(credentialStepAccounts(words.slice(i + 1, j).join(" "), depth + 1, known));
      i = j;
    }
    if (execs.length > 0) return together([...execs, wordsAccounts(words.slice(0, own), program, known)]);
  }
  return wordsAccounts(words, program, known);
}

/** The generic reading of a step's program (`program`, its quotes read) and its words (`words`, quotes kept, the program first). */
function wordsAccounts(words: readonly string[], program: string, known: KnownCredentialProgram): string[] | null {
  const bare = (w: string) => w.replace(/['"]/g, "");
  const base = program.replace(/^.*\//, "");
  const credential = words.some((w, i) => i > 0 && CREDENTIAL_NOUN.test(bare(w)));
  const roles = credential ? [...GENERIC_ROLE_OPTIONS, "-r"] : GENERIC_ROLE_OPTIONS;
  const accounts = credential ? [...GENERIC_ACCOUNT_OPTIONS, "-a"] : GENERIC_ACCOUNT_OPTIONS;
  const named = (options: readonly string[], w: string) => options.includes(w) || options.some((o) => o.startsWith("--") && w.startsWith(`${o}=`));
  const twelve = (w: string) => /^(['"]?)\d{12}\1$/.test(w);
  // The program's own words: before the `--` of a wrapped command (`<cli> run|exec … -- <command…>`), as the floor reads them.
  const first = words.slice(1).find((w) => !w.startsWith("-"));
  const dash = first !== undefined && /^(?:run|exec)$/.test(bare(first)) ? words.indexOf("--", 1) : -1;
  const own = dash > 0 ? words.slice(0, dash) : words;
  const ownNoun = own.some((w, i) => i > 0 && !w.startsWith("-") && CREDENTIAL_NOUN.test(bare(w)));
  // A program named for credentials writes them by any verb: a write verb (`cloud-creds refresh`), one the reader
  // can't read (`cloud-creds $VERB`), or another verb, any of which may write an account no one can tell. So does a
  // program the caller knows writes credentials.
  const credentialProgram = CREDENTIAL_PROGRAM.test(base) || known(program);
  const wraps = dash > 0 && own.some((w) => named(roles, w) || named(accounts, w) || twelve(w));
  const namesAccount = words.some((w) => named(accounts, w) || twelve(w));
  const unread = own.some((w, i) => i > 0 && /[$`]/.test(w));
  const writes = credentialProgram || ownNoun || wraps || (words.some((w) => named(roles, w)) && (namesAccount || unread));
  if (!writes && !namesAccount) return null;
  const found: string[] = [];
  words.forEach((w, i) => {
    if (accounts.includes(w)) found.push(words[i + 1] ?? "");
    else {
      const o = accounts.find((a) => a.startsWith("--") && w.startsWith(`${a}=`));
      if (o) found.push(w.slice(o.length + 1));
    }
  });
  if (found.length) return found;
  const digits = words.filter(twelve);
  if (digits.length) return digits;
  // A word of the program's own the reader can't read (`$ARGS`) may name the account, as the floor reads it.
  return own.filter((w, i) => i > 0 && /[$`]/.test(w));
}

/** Every program name of the profile that writes or refreshes credentials: its credential CLIs and SSO login CLIs. */
export function orgCredentialPrograms(profile: OrgProfile): string[] {
  return [...new Set([...profile.credentialClis.map((r) => r.program), ...profile.sso.loginClis])];
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A pattern matching any of orgCredentialPrograms as a word, or null when the
 * profile names none.
 */
export function orgCredentialProgramPattern(profile: OrgProfile): RegExp | null {
  const names = orgCredentialPrograms(profile);
  return names.length ? new RegExp(`(?<![\\w.-])(?:${names.map(escapeRegExp).join("|")})(?![\\w.-])`) : null;
}

/** An MCP server's own name: `server` with any `plugin_<plugin>_` prefix dropped. */
export function mcpServerOwnName(server: string): string {
  return server.startsWith("plugin_") ? server.slice(7).replace(/^[^_]*_/, "") : server;
}

/** Whether the profile lists `tool` of `server` (its own name) as read-only. */
export function orgReadOnlyMcpTool(profile: OrgProfile, server: string, tool: string): boolean {
  const tools = profile.mcp.readOnlyTools[mcpServerOwnName(server)];
  return !!tool && !!tools && (tools.includes(tool) || tools.includes("*"));
}

/** Whether the profile knows `server` by name (it lists read-only tools for it). */
export function orgKnownMcpServer(profile: OrgProfile, server: string): boolean {
  return Object.hasOwn(profile.mcp.readOnlyTools, mcpServerOwnName(server));
}

/** Whether `server` (as written, prefix included) starts with one of the profile's plugin prefixes. */
export function orgKnownPluginPrefix(profile: OrgProfile, server: string): boolean {
  return compiledOf(profile).pluginPrefixes.some((re) => re.test(server));
}

/** The profile's review write rule a call of `tool` on `server` with `input` falls under, or undefined. */
export function orgReviewWriteRule(profile: OrgProfile, server: string, tool: string, input: Record<string, unknown>): ReviewWriteToolRule | undefined {
  const own = mcpServerOwnName(server);
  return profile.mcp.reviewWriteTools.find((r) => r.server === own && r.tool === tool && (r.action === undefined || input.action === r.action));
}

/** Whether a call of `tool` on `server` is one of the profile's review write tools (a Persona-decidable review hold). */
export function orgReviewWriteTool(profile: OrgProfile, server: string, tool: string, input: Record<string, unknown>): boolean {
  return orgReviewWriteRule(profile, server, tool, input) !== undefined;
}

/** The profile's checkout rule for `tool` on `server`, or undefined. */
export function orgCheckoutTool(profile: OrgProfile, server: string, tool: string): CheckoutToolRule | undefined {
  const own = mcpServerOwnName(server);
  return profile.mcp.checkoutTools.find((r) => r.server === own && r.tool === tool);
}

const operandPatterns = new Map<string, RegExp | null>();

/** Whether `operand` matches a credential rule's subcommand word `source` in full. */
export function operandMatches(source: string, operand: string | null | undefined): boolean {
  if (operand === null || operand === undefined) return false;
  if (!operandPatterns.has(source)) operandPatterns.set(source, compile(`^(?:${source})$`));
  return operandPatterns.get(source)?.test(operand) ?? false;
}

/**
 * Whether the profile's codeReview.provisionPatterns or launchSubdirPatterns
 * match `project`: a project the `generic` code-review adapter takes without
 * a pin.
 */
export function orgCodeReviewProject(profile: OrgProfile, project: { provision?: string; launchSubdir?: string }): boolean {
  const c = compiledOf(profile);
  return (!!project.provision && c.provisions.some((re) => re.test(project.provision!))) || (!!project.launchSubdir && c.subdirs.some((re) => re.test(project.launchSubdir!)));
}

/** The self-filed rule for `tool` on `server`, or undefined. */
export function orgSelfFiledTool(profile: OrgProfile, server: string, tool: string): SelfFiledToolRule | undefined {
  const own = mcpServerOwnName(server);
  return profile.mcp.selfFiledTools.find((r) => r.server === own && r.tool === tool);
}

/** Whether a call's `input` files a record for its caller alone under `rule`. */
export function filesForSelf(rule: SelfFiledToolRule, input: Record<string, unknown>): boolean {
  const unset = (v: unknown) => v === undefined || v === null || v === "";
  for (const [field, selves] of Object.entries(rule.selfFields)) {
    const v = input[field];
    if (!unset(v) && !(typeof v === "string" && selves.includes(v))) return false;
  }
  return rule.unsetFields.every((field) => unset(input[field]));
}

/** Whether WebFetch may read `host` by the profile's list (subdomains match). */
export function orgWebFetchHost(profile: OrgProfile, host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return profile.webFetchDomains.some((d) => h === d || h.endsWith(`.${d}`));
}

const pagePatterns = new WeakMap<OrgProfile, Array<{ host: string; paths: RegExp[] }>>();

/**
 * Whether `url` is one of the profile's public pages (webFetchPages): https
 * or http on the default port, the host exactly, no credentials or query,
 * plain word segments whose leading ones match one of the host's paths.
 */
export function orgWebFetchPage(profile: OrgProfile, url: string): boolean {
  if (profile.webFetchPages.length === 0) return false;
  let pages = pagePatterns.get(profile);
  if (!pages) {
    pages = profile.webFetchPages.map((p) => ({ host: p.host, paths: p.paths.flatMap((s) => compile(`^(?:${s})(?:/|$)`) ?? []) }));
    pagePatterns.set(profile, pages);
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  if (parsed.username || parsed.password || parsed.port || parsed.search || url.includes("?")) return false;
  const host = parsed.hostname.toLowerCase();
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (!segments.every((s) => /^[A-Za-z0-9][A-Za-z0-9._~-]*$/.test(s))) return false;
  const path = segments.join("/");
  return pages.some((p) => p.host === host && p.paths.some((re) => re.test(path)));
}

/** Whether a git remote URL is on the org's code host (codeReview.remotePatterns). */
export function orgCodeReviewRemote(profile: OrgProfile, url: string): boolean {
  return compiledOf(profile).remotes.some((re) => re.test(url));
}
