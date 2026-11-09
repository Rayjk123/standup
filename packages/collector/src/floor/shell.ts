/*
 * A POSIX/bash/zsh command parser for the safety floor's classifier.
 *
 * It is not a shell: it never expands or runs anything. It turns a command
 * line into its structure — lists, pipelines, compound commands, simple
 * commands with their assignments, words and redirections — and keeps every
 * expansion it meets (parameters, command and process substitutions,
 * arithmetic) as a typed segment, so the classifier can resolve what it can
 * and fail closed on what it can't. Command substitutions, process
 * substitutions, backticks and heredoc bodies are parsed recursively, since
 * their contents run too.
 *
 * Anything it can't read (an unterminated quote, an unexpected token, zsh
 * syntax it doesn't know) is reported as a parse failure, never thrown.
 */

/** One piece of a word, in source order. */
export type Segment =
  /** Literal text; `quoted` when it came from quotes or a backslash escape. */
  | { kind: "lit"; text: string; quoted: boolean }
  /**
   * `$name`, `${name}`, `${name:-word}` …: `op` is the operator between the
   * name and `operand` (`:-`, `#`, `/` …), `indirect` marks `${!name}` and
   * `length` marks `${#name}`.
   */
  | {
      kind: "param";
      name: string;
      raw: string;
      quoted: boolean;
      op?: string;
      operand?: Segment[];
      indirect?: boolean;
      length?: boolean;
    }
  /** `$(…)` or a backtick substitution. */
  | { kind: "cmdsub"; raw: string; quoted: boolean; script: Script }
  /** `$((…))`; `parts` holds any substitutions inside it. */
  | { kind: "arith"; raw: string; quoted: boolean; parts: Segment[] }
  /** `<(…)` or `>(…)`. */
  | { kind: "procsub"; raw: string; dir: "<" | ">"; script: Script }
  /** An unquoted leading `~`, `~user`, `~+` or `~-`. */
  | { kind: "tilde"; user: string };

export interface Word {
  /** The word as written. */
  raw: string;
  segments: Segment[];
}

export interface Assignment {
  name: string;
  value: Word;
  /** `name+=value`. */
  append: boolean;
  /** `name=(a b c)`. */
  array?: Word[];
  /** `name[index]=value`: the subscript, which the shell expands like a word. */
  index?: Segment[];
  /** The word as written, for an element assignment: a shell without arrays runs it as a command word. */
  word?: Word;
}

export interface Heredoc {
  delimiter: string;
  /** The delimiter was quoted, so the body is literal. */
  quoted: boolean;
  /** `<<-`: leading tabs are stripped. */
  stripTabs: boolean;
  body: string;
  /** The body as an expanding (unquoted-delimiter) document, with its substitutions. */
  bodyWord: Word | null;
}

export interface Redirect {
  /** `>`, `>>`, `<`, `<<`, `<<-`, `<<<`, `>&`, `<&`, `<>`, `>|`, `&>`, `&>>`. */
  op: string;
  /** The explicit fd before the operator (`2>`), or the `{name}` of a named one, if any. */
  fd: string | null;
  /** The file, fd, herestring word or heredoc delimiter. */
  target: Word;
  heredoc?: Heredoc;
}

export interface SimpleCommand {
  kind: "simple";
  assignments: Assignment[];
  words: Word[];
  redirects: Redirect[];
  raw: string;
}

export type Command =
  | SimpleCommand
  | { kind: "subshell"; body: Script; redirects: Redirect[] }
  | { kind: "group"; body: Script; redirects: Redirect[] }
  | { kind: "if"; clauses: Array<{ cond: Script; body: Script }>; elseBody: Script | null; redirects: Redirect[] }
  | { kind: "loop"; keyword: "while" | "until"; cond: Script; body: Script; redirects: Redirect[] }
  /** `for`/`select`; `items` is null for `for name; do` (the positional args) and arithmetic loops. */
  | { kind: "for"; variable: string; items: Word[] | null; arith: Segment[] | null; body: Script; redirects: Redirect[]; /** `select`: each pass binds whatever was picked, "" for an invalid pick. */ select?: boolean }
  | { kind: "case"; subject: Word; arms: Array<{ patterns: Word[]; body: Script }>; redirects: Redirect[] }
  /** `[[ … ]]`. */
  | { kind: "test"; words: Word[]; redirects: Redirect[] }
  /** `(( … ))`. */
  | { kind: "arith"; parts: Segment[]; redirects: Redirect[] }
  | { kind: "function"; name: string; body: Command; raw: string };

export interface Pipeline {
  commands: Command[];
  negated: boolean;
}

export interface AndOr {
  first: Pipeline;
  rest: Array<{ op: "&&" | "||"; pipeline: Pipeline }>;
}

export interface Script {
  items: Array<{ node: AndOr; background: boolean }>;
}

export type ParseResult = { ok: true; script: Script } | { ok: false; error: string };

/** Longest source the parser accepts; anything longer is reported as unparseable. */
export const MAX_SHELL_SOURCE = 1_000_000;

/** Deepest nesting of substitutions and compound commands the parser follows. */
const MAX_DEPTH = 64;

/**
 * Characters one parse may read, over the source and every child parser's and
 * scan's text, per character of the source (with a floor for short sources).
 * Past it the parse fails rather than run on: nesting that rescans the same
 * text costs it again each time.
 */
const WORK_PER_CHAR = 64;
const MIN_WORK = 1 << 20;

/** Reserved words recognized where a command starts. */
const RESERVED_AT =
  /^(?:if|then|elif|else|fi|do|done|case|esac|while|until|for|select|function|time|coproc|\{|\}|!|\[\[)(?=[ \t\n;&|()<>]|$)/;

/** Redirection operators, longest first. */
const REDIRECT_OPS = ["&>>", "&>", "<<<", "<<-", "<<", "<>", "<&", ">>", ">&", ">|", "<", ">"];

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** An operator inside `[[ … ]]`, read from lastIndex: `!`, `=`, `~` only before a blank, another operator character or the end. */
const TEST_OPERATOR = /&&|\|\||(?:(?![<>]\()(?:[;&|()<>]|[!=~](?=[\s;&|()<>!=~]|$)))+/y;

class ParseError extends Error {}
/** Text bash and zsh read differently, or that the floor can't follow: it fails the parse, with no other reading tried. */
class UnreadableError extends ParseError {}

class Parser {
  private pos = 0;
  private pending: Heredoc[] = [];
  private depth: number;
  /** substitutionEnd's results (an end offset or the parse failure), by start offset and quoting. */
  private readonly substitutionEnds = new Map<number, number | ParseError>();
  /** Set while substitutionEnd finds where a substitution ends: nothing in it is read into child parsers. */
  private scanning = false;
  /** The comments skipped in `src`, as [start, end) offsets: from the `#` up to, not including, its newline. */
  readonly comments: Array<[number, number]> = [];

  constructor(
    private readonly src: string,
    depth = 0,
    /** The work left to the parse this parser is part of, shared with its child parsers. */
    private readonly budget = { left: Math.max(MIN_WORK, WORK_PER_CHAR * src.length) }
  ) {
    this.depth = depth;
    this.spend(src.length);
  }

  private child(text: string): Parser {
    return new Parser(text, this.depth + 1, this.budget);
  }

  /** Charges `n` characters read to the parse's budget; fails it once the budget is spent. */
  private spend(n: number): void {
    this.budget.left -= n;
    if (this.budget.left < 0) throw this.unreadable("too much nested text to read");
  }

  program(): Script {
    const script = this.list([]);
    this.skipSpace();
    if (this.pos < this.src.length) throw this.error(`unexpected ${JSON.stringify(this.src[this.pos])}`);
    return script;
  }

  /** Text in double-quote (or heredoc) mode up to the end of the source, as segments. */
  expandingText(heredoc: boolean): Segment[] {
    const segments: Segment[] = [];
    this.doubleQuoted(segments, null, heredoc);
    return segments;
  }

  private error(message: string): ParseError {
    return new ParseError(`${message} at offset ${this.pos}`);
  }

  private unreadable(message: string): UnreadableError {
    return new UnreadableError(`${message} at offset ${this.pos}`);
  }

  private enter(): void {
    if (++this.depth > MAX_DEPTH) throw this.error("nesting too deep");
  }

  private leave(): void {
    this.depth--;
  }

  private at(text: string): boolean {
    return this.src.startsWith(text, this.pos);
  }

  /** Skips blanks, line continuations and a comment (up to, not past, its newline). */
  private skipSpace(): void {
    for (;;) {
      const c = this.src[this.pos];
      if (c === " " || c === "\t" || c === "\r") this.pos++;
      else if (c === "\\" && this.src[this.pos + 1] === "\n") this.pos += 2;
      else if (c === "#") {
        const nl = this.src.indexOf("\n", this.pos);
        const end = nl < 0 ? this.src.length : nl;
        this.comments.push([this.pos, end]);
        this.pos = end;
      } else return;
    }
  }

  private skipSpaceAndNewlines(): void {
    for (;;) {
      this.skipSpace();
      if (this.src[this.pos] === "\n") this.newline();
      else return;
    }
  }

  /** Consumes a newline and reads the bodies of the heredocs opened on its line. */
  private newline(): void {
    this.pos++;
    const pending = this.pending;
    this.pending = [];
    for (const heredoc of pending) this.heredocBody(heredoc);
  }

  private heredocBody(heredoc: Heredoc): void {
    const lines: string[] = [];
    while (this.pos < this.src.length) {
      let nl = this.src.indexOf("\n", this.pos);
      if (nl < 0) nl = this.src.length;
      const line = this.src.slice(this.pos, nl).replace(/\r$/, "");
      this.pos = Math.min(nl + 1, this.src.length);
      const stripped = heredoc.stripTabs ? line.replace(/^\t+/, "") : line;
      if (stripped === heredoc.delimiter) break;
      lines.push(stripped);
    }
    heredoc.body = lines.length ? `${lines.join("\n")}\n` : "";
    if (!heredoc.quoted && !this.scanning) {
      heredoc.bodyWord = { raw: heredoc.body, segments: this.child(heredoc.body).expandingText(true) };
    }
  }

  private reservedAt(): string | null {
    return RESERVED_AT.exec(this.src.slice(this.pos, this.pos + 9))?.[0] ?? null;
  }

  private expectReserved(word: string): void {
    this.skipSpaceAndNewlines();
    if (this.reservedAt() !== word) throw this.error(`expected "${word}"`);
    this.pos += word.length;
  }

  private atCaseTerminator(): boolean {
    return this.at(";;") || this.at(";&");
  }

  /**
   * A command list, ending at the end of input, at one of `terminators` in
   * command position, at `)` when `close` is set, or at `;;` in a case arm.
   */
  private list(terminators: readonly string[], opts: { close?: boolean; caseArm?: boolean } = {}): Script {
    this.enter();
    const items: Script["items"] = [];
    for (;;) {
      this.skipSpaceAndNewlines();
      if (this.pos >= this.src.length) break;
      const c = this.src[this.pos];
      if (c === ")") {
        if (opts.close) break;
        throw this.error("unexpected )");
      }
      if (this.atCaseTerminator()) {
        if (opts.caseArm) break;
        throw this.error("unexpected ;;");
      }
      const reserved = this.reservedAt();
      if (reserved && terminators.includes(reserved)) break;
      const node = this.andOr();
      this.skipSpace();
      let background = false;
      const next = this.src[this.pos];
      if (next === "&") {
        background = true;
        this.pos++;
      } else if (next === ";" && !this.atCaseTerminator()) {
        this.pos++;
      } else if (next === "\n") {
        this.newline();
      } else if (next !== undefined && next !== ")" && !this.atCaseTerminator()) {
        const r = this.reservedAt();
        if (!(r && terminators.includes(r))) throw this.error(`unexpected ${JSON.stringify(next)}`);
      }
      items.push({ node, background });
    }
    this.leave();
    return { items };
  }

  private andOr(): AndOr {
    const first = this.pipeline();
    const rest: AndOr["rest"] = [];
    for (;;) {
      this.skipSpace();
      if (this.at("&&") || this.at("||")) {
        const op = this.src.slice(this.pos, this.pos + 2) as "&&" | "||";
        this.pos += 2;
        this.skipSpaceAndNewlines();
        rest.push({ op, pipeline: this.pipeline() });
      } else return { first, rest };
    }
  }

  private pipeline(): Pipeline {
    let negated = false;
    for (;;) {
      this.skipSpace();
      const r = this.reservedAt();
      if (r === "!") {
        this.pos++;
        negated = !negated;
      } else if (r === "time") {
        this.pos += 4;
        this.skipSpace();
        if (/^-p(?=[ \t\n;&|]|$)/.test(this.src.slice(this.pos, this.pos + 3))) this.pos += 2;
      } else break;
    }
    const commands = [this.command()];
    for (;;) {
      this.skipSpace();
      if (this.src[this.pos] === "|" && this.src[this.pos + 1] !== "|") {
        this.pos += this.src[this.pos + 1] === "&" ? 2 : 1;
        this.skipSpaceAndNewlines();
        commands.push(this.command());
      } else return { commands, negated };
    }
  }

  private command(): Command {
    this.skipSpace();
    if (this.pos >= this.src.length) throw this.error("expected a command");
    if (this.at("((")) {
      this.pos += 2;
      const content = this.arithContent();
      return { kind: "arith", parts: this.expanding(content), redirects: this.trailingRedirects() };
    }
    if (this.src[this.pos] === "(") {
      this.pos++;
      const body = this.list([], { close: true });
      if (this.src[this.pos] !== ")") throw this.error("expected )");
      this.pos++;
      return { kind: "subshell", body, redirects: this.trailingRedirects() };
    }
    const reserved = this.reservedAt();
    switch (reserved) {
      case "{": {
        this.pos++;
        const body = this.list(["}"]);
        this.expectReserved("}");
        return { kind: "group", body, redirects: this.trailingRedirects() };
      }
      case "if":
        return this.ifCommand();
      case "while":
      case "until": {
        this.pos += reserved.length;
        const cond = this.list(["do"]);
        this.expectReserved("do");
        const body = this.list(["done"]);
        this.expectReserved("done");
        return { kind: "loop", keyword: reserved, cond, body, redirects: this.trailingRedirects() };
      }
      case "for":
      case "select":
        return this.forCommand(reserved.length);
      case "case":
        return this.caseCommand();
      case "[[":
        return this.testCommand();
      case "function":
        return this.functionKeyword();
      case "coproc": {
        this.pos += 6;
        // A coprocess runs in a subshell, alongside the shell.
        const c = this.command();
        return { kind: "subshell", body: { items: [{ background: true, node: { first: { commands: [c], negated: false }, rest: [] } }] }, redirects: [] };
      }
      case null:
      case "!":
      case "time":
        return this.simple();
      default:
        throw this.error(`unexpected "${reserved}"`);
    }
  }

  private ifCommand(): Command {
    this.pos += 2;
    const clauses: Array<{ cond: Script; body: Script }> = [];
    let elseBody: Script | null = null;
    const cond = this.list(["then"]);
    this.expectReserved("then");
    clauses.push({ cond, body: this.list(["elif", "else", "fi"]) });
    for (;;) {
      this.skipSpaceAndNewlines();
      const r = this.reservedAt();
      if (r === "elif") {
        this.pos += 4;
        const c = this.list(["then"]);
        this.expectReserved("then");
        clauses.push({ cond: c, body: this.list(["elif", "else", "fi"]) });
      } else if (r === "else") {
        this.pos += 4;
        elseBody = this.list(["fi"]);
        this.expectReserved("fi");
        break;
      } else if (r === "fi") {
        this.pos += 2;
        break;
      } else throw this.error('expected "fi"');
    }
    return { kind: "if", clauses, elseBody, redirects: this.trailingRedirects() };
  }

  private forCommand(keywordLength: number): Command {
    this.pos += keywordLength;
    this.skipSpace();
    let variable = "";
    let items: Word[] | null = null;
    let arith: Segment[] | null = null;
    if (this.at("((")) {
      this.pos += 2;
      arith = this.expanding(this.arithContent());
    } else {
      const name = this.word();
      if (!name) throw this.error("expected a loop variable");
      variable = literalOf(name) ?? "";
      this.skipSpaceAndNewlines();
      if (/^in(?=[ \t\n;]|$)/.test(this.src.slice(this.pos, this.pos + 3))) {
        this.pos += 2;
        items = [];
        for (;;) {
          this.skipSpace();
          const c = this.src[this.pos];
          if (c === ";" || c === "\n" || c === undefined) break;
          const w = this.word(true);
          if (!w) throw this.error("unexpected token in for list");
          items.push(w);
        }
      }
    }
    this.skipSpace();
    if (this.src[this.pos] === ";") this.pos++;
    this.expectReserved("do");
    const body = this.list(["done"]);
    this.expectReserved("done");
    return { kind: "for", variable, items, arith, body, redirects: this.trailingRedirects(), ...(keywordLength === 6 ? { select: true } : {}) };
  }

  private caseCommand(): Command {
    this.pos += 4;
    this.skipSpace();
    const subject = this.word();
    if (!subject) throw this.error("expected a case subject");
    this.skipSpaceAndNewlines();
    if (!/^in(?=[ \t\n;]|$)/.test(this.src.slice(this.pos, this.pos + 3))) throw this.error('expected "in"');
    this.pos += 2;
    const arms: Array<{ patterns: Word[]; body: Script }> = [];
    for (;;) {
      this.skipSpaceAndNewlines();
      if (this.reservedAt() === "esac") {
        this.pos += 4;
        break;
      }
      if (this.pos >= this.src.length) throw this.error('expected "esac"');
      if (this.src[this.pos] === "(") this.pos++;
      const patterns: Word[] = [];
      for (;;) {
        this.skipSpace();
        const w = this.word();
        if (!w) throw this.error("expected a case pattern");
        patterns.push(w);
        this.skipSpace();
        if (this.src[this.pos] === "|") {
          this.pos++;
          continue;
        }
        if (this.src[this.pos] === ")") {
          this.pos++;
          break;
        }
        throw this.error("expected ) after a case pattern");
      }
      const body = this.list(["esac"], { caseArm: true });
      this.skipSpace();
      if (this.at(";;&")) this.pos += 3;
      else if (this.at(";;") || this.at(";&")) this.pos += 2;
      arms.push({ patterns, body });
    }
    return { kind: "case", subject, arms, redirects: this.trailingRedirects() };
  }

  private testCommand(): Command {
    this.pos += 2;
    const words: Word[] = [];
    for (;;) {
      this.skipSpaceAndNewlines();
      if (this.pos >= this.src.length) throw this.error('expected "]]"');
      if (/^\]\](?=[ \t\n;&|)]|$)/.test(this.src.slice(this.pos, this.pos + 3))) {
        this.pos += 2;
        break;
      }
      // `<(…)`/`>(…)` is a process substitution here too, not a comparison.
      const procsub = /^[<>]\(/.test(this.src.slice(this.pos, this.pos + 2)) ? this.word() : null;
      if (procsub) {
        words.push(procsub);
        continue;
      }
      // An operator ends before a glued `<(`/`>(`, which is a process substitution.
      // `!`, `=` and `~` are no shell metacharacters: glued to a word they are
      // part of it, so `!#x` is one word and starts no comment.
      TEST_OPERATOR.lastIndex = this.pos;
      const op = TEST_OPERATOR.exec(this.src);
      if (op) {
        // zsh reads `(#i)` as a glob flag, not a comment: what follows is the test's, not skipped.
        if (op[0].endsWith("(") && this.src[this.pos + op[0].length] === "#") throw this.error("a zsh glob flag in [[ ]]");
        words.push({ raw: op[0], segments: [{ kind: "lit", text: op[0], quoted: false }] });
        this.pos += op[0].length;
        continue;
      }
      const w = this.word();
      if (!w) throw this.error("unexpected token in [[ ]]");
      words.push(w);
    }
    return { kind: "test", words, redirects: this.trailingRedirects() };
  }

  private functionKeyword(): Command {
    const start = this.pos;
    this.pos += 8;
    this.skipSpace();
    const nameWord = this.word();
    const name = nameWord ? literalOf(nameWord) : null;
    if (!name) throw this.error("expected a function name");
    this.skipSpace();
    if (this.src[this.pos] === "(") {
      this.pos++;
      this.skipSpace();
      if (this.src[this.pos] !== ")") throw this.error("expected )");
      this.pos++;
    }
    this.skipSpaceAndNewlines();
    const body = this.command();
    return { kind: "function", name, body, raw: this.src.slice(start, this.pos) };
  }

  /** The content of `((…))` up to its closing `))`, which is consumed. */
  private arithContent(): string {
    const start = this.pos;
    const end = this.arithEnd(start, false);
    // bash reads quotes in `((…))` as quotes, zsh as text: both must close it at the same `))`.
    if (this.arithEnd(start, true) !== end) throw this.unreadable("quotes in ((…)), which bash and zsh read differently");
    if (end < 0) throw this.error("unterminated arithmetic");
    // zsh expands an array subscript in arithmetic again, running a substitution escaped in it.
    if (/\\[$`]/.test(this.src.slice(start, end))) throw this.unreadable("an escaped substitution in ((…)), which zsh runs");
    if (subscriptReexpands(this.src.slice(start, end))) throw this.unreadable("a subscript in ((…)) that ksh expands again");
    this.pos = end + 2;
    return this.src.slice(start, end);
  }

  /** Index of the `))` closing `((…))` content that starts at `from`, or -1; with `quotesAreText` a quote is text. */
  private arithEnd(from: number, quotesAreText: boolean): number {
    let depth = 0;
    for (let i = from; i < this.src.length; i++) {
      this.spend(1);
      const c = this.src[i];
      if (c === "\\") i++;
      else if (c === "(") depth++;
      else if (c === ")") {
        if (depth === 0 && this.src[i + 1] === ")") return i;
        if (--depth < 0) return -1;
      } else if (!quotesAreText && (c === "'" || c === '"')) {
        const end = this.quoteEnd(i);
        if (end < 0) return -1;
        i = end;
      } else if (this.substitutionAt(i)) i = this.substitutionEnd(i, false) - 1;
    }
    return -1;
  }

  /** Whether a `$(…)`, `$((…))`, `$[…]`, `${…}` or backtick substitution starts at `at`. */
  private substitutionAt(at: number): boolean {
    const c = this.src[at];
    const n = this.src[at + 1];
    return c === "`" || (c === "$" && (n === "(" || n === "{" || n === "["));
  }

  /**
   * The index just past the substitution starting at `at`, read with the full
   * parser so that quotes, heredocs and comments inside it don't end the
   * text around it. The parser's position and state are left as they were.
   */
  private substitutionEnd(at: number, quoted: boolean): number {
    const key = at * 2 + (quoted ? 1 : 0);
    const known = this.substitutionEnds.get(key);
    if (known instanceof ParseError) throw known;
    if (known !== undefined) return known;
    const { pos, pending, depth, scanning } = this;
    const comments = this.comments.length;
    this.pos = at;
    this.pending = [];
    this.scanning = true;
    try {
      this.enter();
      if (this.src[at] === "`") this.backtick(quoted);
      else this.dollar([], quoted);
      this.substitutionEnds.set(key, this.pos);
      return this.pos;
    } catch (e) {
      // A failure is kept too, so nested substitutions that don't close are each read once.
      if (e instanceof ParseError) this.substitutionEnds.set(key, e);
      throw e;
    } finally {
      this.pos = pos;
      this.pending = pending;
      this.depth = depth;
      this.scanning = scanning;
      this.comments.length = comments;
    }
  }

  private expanding(text: string): Segment[] {
    if (this.scanning) return [];
    return this.child(text).expandingText(false);
  }

  private isRedirectStart(): boolean {
    const c = this.src[this.pos];
    if ((c === "<" || c === ">") && this.src[this.pos + 1] !== "(") return true;
    return c === "&" && this.src[this.pos + 1] === ">";
  }

  private trailingRedirects(): Redirect[] {
    const redirects: Redirect[] = [];
    for (;;) {
      this.skipSpace();
      if (this.isRedirectStart()) {
        redirects.push(this.redirect(null));
        continue;
      }
      const fd = /^(?:\d+|\{[A-Za-z_]\w*\})(?=[<>])/.exec(this.src.slice(this.pos, this.pos + 64));
      if (fd) {
        this.pos += fd[0].length;
        redirects.push(this.redirect(fd[0]));
        continue;
      }
      return redirects;
    }
  }

  private redirect(fd: string | null): Redirect {
    const op = REDIRECT_OPS.find((o) => this.at(o));
    if (!op) throw this.error("expected a redirection");
    this.pos += op.length;
    this.skipSpace();
    const target = this.word();
    if (!target) throw this.error(`missing target for ${op}`);
    if (op === "<<" || op === "<<-") {
      const quoted = target.segments.some((s) => s.kind === "lit" && s.quoted) || /["'\\]/.test(target.raw);
      const delimiter = target.segments.map((s) => (s.kind === "lit" ? s.text : "raw" in s ? s.raw : "~")).join("");
      const heredoc: Heredoc = { delimiter, quoted, stripTabs: op === "<<-", body: "", bodyWord: null };
      this.pending.push(heredoc);
      return { op, fd, target, heredoc };
    }
    return { op, fd, target };
  }

  private simple(): Command {
    const start = this.pos;
    const assignments: Assignment[] = [];
    const words: Word[] = [];
    const redirects: Redirect[] = [];
    for (;;) {
      this.skipSpace();
      const c = this.src[this.pos];
      if (c === undefined || c === "\n" || c === ";" || c === ")" || c === "|") break;
      if (c === "&" && this.src[this.pos + 1] !== ">") break;
      if (this.isRedirectStart()) {
        redirects.push(this.redirect(null));
        continue;
      }
      if (c === "(") {
        const name = words.length === 1 && !assignments.length && !redirects.length ? literalOf(words[0]!) : null;
        if (name && /^[^\s$`'"\\]+$/.test(name)) return this.functionBody(name, start);
        throw this.error("unexpected (");
      }
      const word = this.word();
      if (!word) throw this.error(`unexpected ${JSON.stringify(c)}`);
      // `2>`, and `{name}>`, which opens a new fd and stores its number in `name`.
      if (/^(?:\d+|\{[A-Za-z_]\w*\})$/.test(word.raw) && (this.src[this.pos] === "<" || this.src[this.pos] === ">")) {
        redirects.push(this.redirect(word.raw));
        continue;
      }
      if (!words.length) {
        const assignment = asAssignment(word);
        if (assignment) {
          if (!assignment.value.raw && this.src[this.pos] === "(") assignment.array = this.arrayLiteral();
          assignments.push(assignment);
          continue;
        }
      }
      words.push(word);
    }
    if (!words.length && !assignments.length && !redirects.length) throw this.error("expected a command");
    return { kind: "simple", assignments, words, redirects, raw: this.src.slice(start, this.pos).trim() };
  }

  /** `name ( ) compound-command`, with the name already read. */
  private functionBody(name: string, start: number): Command {
    this.pos++;
    this.skipSpace();
    if (this.src[this.pos] !== ")") throw this.error("expected ) in a function definition");
    this.pos++;
    this.skipSpaceAndNewlines();
    const body = this.command();
    return { kind: "function", name, body, raw: this.src.slice(start, this.pos) };
  }

  private arrayLiteral(): Word[] {
    this.pos++;
    const items: Word[] = [];
    for (;;) {
      this.skipSpaceAndNewlines();
      if (this.src[this.pos] === ")") {
        this.pos++;
        return items;
      }
      const w = this.word();
      if (!w) throw this.error("unexpected token in an array");
      items.push(w);
    }
  }

  /** One word, or null when the next character is a delimiter. */
  /** One shell word; `forItem` when it is an item of a `for` list, where a zsh glob qualifier is read (see below). */
  private word(forItem = false): Word | null {
    const start = this.pos;
    const segments: Segment[] = [];
    const lit = (text: string, quoted: boolean) => pushLiteral(segments, text, quoted);
    for (;;) {
      const c = this.src[this.pos];
      if (c === undefined || c === " " || c === "\t" || c === "\r" || c === "\n" || c === ";" || c === "&" || c === "|") break;
      if (c === "(") {
        // A zsh glob qualifier ending a glob in a `for` list (`for d in */(N[1,2])`, `*(.om[1])`) only filters
        // and orders the items the loop gets, so the word is read as the glob without it. Only flags that narrow
        // or order and take no argument, `o`/`O` with a sort key and `[n,m]` ranges. Not `D` (it adds dotfiles,
        // which the floor's own glob reading skips), `M`/`T` (they rewrite names), or `e`, `+`, `P`, `u`, `g`,
        // `f` and the rest, whose strings run code or add words. Elsewhere `N` would shift a command's arguments.
        const globbed = forItem && segments.some((s) => s.kind === "lit" && !s.quoted && /[*?\]]/.test(s.text));
        const qualifier = globbed ? /^\((?:[N.\/@=p*%rwxRWXsSt^-]|[oO][nNLamcd]|\[-?\d+(?:,-?\d+)?\])+\)(?=[ \t\r\n;&|)<>]|$)/.exec(this.src.slice(this.pos)) : null;
        if (qualifier) {
          this.pos += qualifier[0].length;
          continue;
        }
      }
      if (c === ")" || c === "(") break;
      if (c === "<" || c === ">") {
        // A substitution glued to other text stays in that word: `--file=<(…)` is one argument.
        if (this.src[this.pos + 1] === "(") {
          segments.push(this.processSubstitution(c));
          continue;
        }
        break;
      }
      if (c === "\\") {
        const n = this.src[this.pos + 1];
        if (n === "\n") {
          this.pos += 2;
          continue;
        }
        if (n === undefined) {
          lit("\\", true);
          this.pos++;
          continue;
        }
        lit(n, true);
        this.pos += 2;
        continue;
      }
      if (c === "'") {
        const end = this.src.indexOf("'", this.pos + 1);
        if (end < 0) throw this.error("unterminated single quote");
        lit(this.src.slice(this.pos + 1, end), true);
        this.pos = end + 1;
        continue;
      }
      if (c === '"') {
        this.pos++;
        this.doubleQuoted(segments, '"', false);
        continue;
      }
      if (c === "$") {
        const n = this.src[this.pos + 1];
        if (n === "'") {
          this.pos += 2;
          lit(this.ansiC(), true);
          continue;
        }
        if (n === '"') {
          this.pos += 2;
          this.doubleQuoted(segments, '"', false);
          continue;
        }
        this.dollar(segments, false);
        continue;
      }
      if (c === "`") {
        segments.push(this.backtick(false));
        continue;
      }
      if (c === "~" && this.pos === start) {
        const m = /^~([A-Za-z0-9._-]*|[+-])(?=[/:]|[ \t\r\n;&|()<>]|$)/.exec(this.src.slice(this.pos, this.pos + 64));
        if (m) {
          segments.push({ kind: "tilde", user: m[1]! });
          this.pos += m[0].length;
          continue;
        }
      }
      lit(c, false);
      this.pos++;
    }
    if (this.pos === start) return null;
    return { raw: this.src.slice(start, this.pos), segments };
  }

  private processSubstitution(dir: "<" | ">"): Segment {
    const start = this.pos;
    this.pos += 2;
    const script = this.list([], { close: true });
    if (this.src[this.pos] !== ")") throw this.error("unterminated process substitution");
    this.pos++;
    return { kind: "procsub", raw: this.src.slice(start, this.pos), dir, script };
  }

  /**
   * Double-quoted text up to `terminator` (consumed), or to the end of input
   * when it is null. In a heredoc body `"` is ordinary.
   */
  private doubleQuoted(segments: Segment[], terminator: '"' | null, heredoc: boolean): void {
    const startCount = segments.length;
    let buf = "";
    const flush = () => {
      if (buf) pushLiteral(segments, buf, true);
      buf = "";
    };
    for (;;) {
      const c = this.src[this.pos];
      if (c === undefined) {
        if (terminator) throw this.error("unterminated double quote");
        break;
      }
      if (terminator && c === terminator) {
        this.pos++;
        break;
      }
      if (c === "\\") {
        const n = this.src[this.pos + 1];
        if (n === "\n") {
          this.pos += 2;
          continue;
        }
        if (n !== undefined && ("$`\\".includes(n) || (!heredoc && n === '"'))) {
          buf += n;
          this.pos += 2;
          continue;
        }
        buf += c;
        this.pos++;
        continue;
      }
      if (c === "$" && /[A-Za-z_{([0-9@*#?$!=~^+-]/.test(this.src[this.pos + 1] ?? "")) {
        flush();
        this.dollar(segments, true);
        continue;
      }
      if (c === "`") {
        flush();
        segments.push(this.backtick(true));
        continue;
      }
      buf += c;
      this.pos++;
    }
    flush();
    if (segments.length === startCount) pushLiteral(segments, "", true);
  }

  /** A `$` expansion at the current position. */
  private dollar(segments: Segment[], quoted: boolean): void {
    const start = this.pos;
    const n = this.src[this.pos + 1];
    if (n === "{") {
      const end = this.matchBrace(this.pos + 2, quoted);
      const inner = this.src.slice(this.pos + 2, end);
      this.pos = end + 1;
      segments.push(this.paramExpansion(inner, this.src.slice(start, this.pos), quoted));
      return;
    }
    if (n === "(") {
      if (this.src[this.pos + 2] === "(") {
        // `$((` is arithmetic when a `))` closes it, whatever its text holds; otherwise it is read as `$( (…) )`.
        let content: string | null = null;
        try {
          this.pos += 3;
          content = this.arithContent();
        } catch (e) {
          if (!(e instanceof ParseError) || e instanceof UnreadableError) throw e;
          this.pos = start;
        }
        if (content !== null) {
          segments.push({ kind: "arith", raw: this.src.slice(start, this.pos), quoted, parts: this.expanding(content) });
          return;
        }
      }
      this.pos += 2;
      const script = this.list([], { close: true });
      if (this.src[this.pos] !== ")") throw this.error("unterminated $(");
      this.pos++;
      segments.push({ kind: "cmdsub", raw: this.src.slice(start, this.pos), quoted, script });
      return;
    }
    // `$[…]` is bash's and zsh's old form of `$((…))`, in which they count nested brackets. dash and ksh keep it as
    // text, which a later unquoted expansion, `eval` or `| sh` splits on blanks and expanded `$name`s and globs. It is
    // read only when that text is one plain word, quoted or not: names, numbers and operators that split no command.
    if (n === "[") {
      const m = /\$\[([A-Za-z0-9_+\-/%^!=,.:]*)\]/y;
      m.lastIndex = this.pos;
      const found = m.exec(this.src);
      if (!found || /\$[({[]/.test(found[1]!)) throw this.unreadable("$[…] arithmetic the floor can't read");
      this.pos += found[0].length;
      segments.push({ kind: "arith", raw: found[0], quoted, parts: this.expanding(found[1]!) });
      return;
    }
    // zsh's `$=name` splits the value into words even inside double quotes: it reads as an unquoted `$name`
    // (which also globs the words, a superset of what zsh gives).
    const split = /^=([A-Za-z_][A-Za-z0-9_]*|[0-9]|[@*])(?![A-Za-z0-9_[{])/.exec(this.src.slice(this.pos + 1, this.pos + 257));
    if (split) {
      this.pos += 1 + split[0].length;
      segments.push({ kind: "param", name: split[1]!, raw: this.src.slice(start, this.pos), quoted: false });
      return;
    }
    // zsh's other unbraced flags `$~name` (glob), `$^name` (array join) and `$+name` (is set), or several together,
    // change what the expansion gives; bash reads them as text. The name is kept with its flags, which no variable
    // has, so every reader takes the value as unknown.
    const flagged = /^([=~^+]+)(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]|[@*#?!-]|(?=\{))/.exec(this.src.slice(this.pos + 1, this.pos + 257));
    if (flagged) {
      this.pos += 1 + flagged[0].length;
      segments.push({ kind: "param", name: flagged[0], raw: this.src.slice(start, this.pos), quoted });
      return;
    }
    const m = /^(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]|[@*#?$!-])/.exec(this.src.slice(this.pos + 1, this.pos + 257));
    if (m) {
      this.pos += 1 + m[0].length;
      // zsh reads `$name[…]` as a subscript of name (`"$x[2,-1]"`, `"$a[@]"`); bash reads it as `$name` then text.
      // The name is kept with its subscript, which no variable has, so every reader takes the value as unknown.
      if (/^[A-Za-z_]/.test(m[0]) && this.src[this.pos] === "[") {
        // Only a plain subscript (indexes, ranges, `@`, `*`) is taken with the name. Any other is left to parse as
        // the text, operators and substitutions it holds, after a name whose value is still unknown.
        const sub = /^\[[A-Za-z0-9_@*#,:+-]*\]/.exec(this.src.slice(this.pos, this.pos + 257));
        if (sub) this.pos += sub[0].length;
        segments.push({ kind: "param", name: sub ? this.src.slice(start + 1, this.pos) : `${m[0]}[`, raw: this.src.slice(start, this.pos), quoted });
        return;
      }
      segments.push({ kind: "param", name: m[0], raw: this.src.slice(start, this.pos), quoted });
      return;
    }
    pushLiteral(segments, "$", quoted);
    this.pos++;
  }

  /**
   * Index of the quote closing the one at `at`, or -1. Nothing is special
   * inside single quotes. Inside double quotes a backslash escapes the next
   * character, so `\"` doesn't close them, and a substitution is skipped
   * whole, so a quote inside it doesn't either.
   */
  private quoteEnd(at: number): number {
    if (this.src[at] === "'") {
      const end = this.src.indexOf("'", at + 1);
      this.spend((end < 0 ? this.src.length : end) - at);
      return end;
    }
    for (let i = at + 1; i < this.src.length; i++) {
      this.spend(1);
      if (this.src[i] === "\\") i++;
      else if (this.src[i] === '"') return i;
      else if (this.substitutionAt(i)) i = this.substitutionEnd(i, true) - 1;
    }
    return -1;
  }

  /** Index of the `}` closing a `${` whose content starts at `from`; `quoted` when the `${` is in double quotes. */
  private matchBrace(from: number, quoted: boolean): number {
    const end = this.braceEnd(from, false, quoted);
    // In a double-quoted `${…}` bash reads a single quote as a quote, zsh as text: both must close it at the same `}`.
    if (quoted && this.braceEnd(from, true, quoted) !== end) throw this.unreadable("a single quote in a double-quoted ${…}, which bash and zsh read differently");
    if (end < 0) throw this.error("unterminated ${");
    return end;
  }

  /** Index of the `}` closing `${…` content that starts at `from`, or -1; with `singleQuoteIsText` a `'` is text. */
  private braceEnd(from: number, singleQuoteIsText: boolean, quoted: boolean): number {
    for (let i = from; i < this.src.length; i++) {
      this.spend(1);
      const c = this.src[i];
      if (c === "\\") i++;
      else if (c === "$" && this.src[i + 1] === "'" && !singleQuoteIsText) {
        i = this.ansiCEnd(i);
        if (i < 0) return -1;
      } else if (c === '"' || (c === "'" && !singleQuoteIsText)) {
        const end = this.quoteEnd(i);
        if (end < 0) return -1;
        i = end;
      } else if (this.substitutionAt(i)) i = this.substitutionEnd(i, quoted) - 1;
      else if (c === "}") return i;
    }
    return -1;
  }

  /** Index of the `'` closing the `$'…'` at `at`, or -1; a backslash escapes the next character. */
  private ansiCEnd(at: number): number {
    for (let i = at + 2; i < this.src.length; i++) {
      this.spend(1);
      if (this.src[i] === "\\") i++;
      else if (this.src[i] === "'") return i;
    }
    return -1;
  }

  /** Index of the `]` closing the `[` that starts the source, or -1; a substitution in it is skipped whole. */
  private subscriptEnd(): number {
    for (let i = 1; i < this.src.length; i++) {
      this.spend(1);
      const c = this.src[i];
      if (c === "\\") i++;
      else if (this.substitutionAt(i)) i = this.substitutionEnd(i, true) - 1;
      else if (c === "]") return i;
    }
    return -1;
  }

  private paramExpansion(inner: string, raw: string, quoted: boolean): Extract<Segment, { kind: "param" }> {
    if (this.scanning) return { kind: "param", name: "", raw, quoted };
    // zsh expands a substitution in a name's place (`${$(cmd)}`, `${${x}…}`), running any command in it; bash refuses it.
    if (/^(?:\$[({[]|`)/.test(inner)) throw this.unreadable("a substitution in a name's place in ${…}, which zsh runs");
    // zsh's `${=name…}` splits the value into words even inside double quotes: it reads as an unquoted `${name…}`
    // (which also globs the words, a superset of what zsh gives). Any other zsh flag is left unread.
    if (/^=(?:[A-Za-z_]|[0-9]|[@*])/.test(inner)) return this.paramExpansion(inner.slice(1), raw, false);
    // What follows `${!` and `${#` is read like any other expansion's, so a subscript or operand in it is parsed.
    if (inner.startsWith("!") && inner.length > 1) return { ...this.paramExpansion(inner.slice(1), raw, quoted), indirect: true };
    if (inner.startsWith("#") && inner.length > 1) return { ...this.paramExpansion(inner.slice(1), raw, quoted), length: true };
    const m = /^(?:[A-Za-z_][A-Za-z0-9_]*|\d+|[@*#?$!-])/.exec(inner);
    if (!m) throw this.error("bad substitution");
    const rest = inner.slice(m[0].length);
    if (!rest) return { kind: "param", name: m[0], raw, quoted };
    const subscript = rest.startsWith("[") ? rest.slice(0, this.child(rest).subscriptEnd() + 1) : "";
    // A subscript is evaluated, running any substitution in it; the segment keeps no subscript parts to show one.
    // zsh expands it again, running a substitution escaped in it too, and bash one that `$'…'` decodes to.
    if (subscript && (/\\[$`]|\$'/.test(subscript) || subscriptReexpands(subscript.slice(1, -1)) || nestedScripts(this.child(subscript.slice(1, -1)).expandingText(false)).length)) {
      throw this.unreadable("a substitution in a subscript");
    }
    const op = subscript + /^(?::-|:=|:\+|:\?|-|=|\+|\?|##|#|%%|%|\/\/|\/#|\/%|\/|\^\^|\^|,,|,|:|@)?/.exec(rest.slice(subscript.length))![0];
    const operandText = rest.slice(op.length);
    const operand = this.child(operandText).expandingText(false);
    return { kind: "param", name: m[0], raw, quoted, op: op || rest, operand };
  }

  private backtick(quoted: boolean): Segment {
    const start = this.pos;
    this.pos++;
    let content = "";
    for (;;) {
      const c = this.src[this.pos];
      if (c === undefined) throw this.error("unterminated backtick");
      if (c === "`") {
        this.pos++;
        break;
      }
      const n = this.src[this.pos + 1];
      if (c === "\\" && (n === "`" || n === "\\" || n === "$" || (quoted && n === '"'))) {
        content += n;
        this.pos += 2;
        continue;
      }
      content += c;
      this.pos++;
    }
    const script = this.scanning ? { items: [] } : this.child(content).program();
    return { kind: "cmdsub", raw: this.src.slice(start, this.pos), quoted, script };
  }

  /** The decoded body of `$'…'`, with the closing quote consumed. */
  private ansiC(): string {
    let out = "";
    for (;;) {
      const c = this.src[this.pos];
      if (c === undefined) throw this.error("unterminated $'");
      if (c === "'") {
        this.pos++;
        return out;
      }
      if (c !== "\\") {
        out += c;
        this.pos++;
        continue;
      }
      const n = this.src[this.pos + 1] ?? "";
      this.pos += 2;
      const simple: Record<string, string> = {
        a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v",
        "\\": "\\", "'": "'", '"': '"', "?": "?",
      };
      if (n in simple) {
        out += simple[n];
      } else if (n === "x") {
        const hex = /^[0-9a-fA-F]{1,2}/.exec(this.src.slice(this.pos, this.pos + 2))?.[0];
        if (hex) {
          out += String.fromCharCode(parseInt(hex, 16));
          this.pos += hex.length;
        } else out += "\\x";
      } else if (n === "u" || n === "U") {
        const hex = new RegExp(`^[0-9a-fA-F]{1,${n === "u" ? 4 : 8}}`).exec(this.src.slice(this.pos, this.pos + 8))?.[0];
        if (hex) {
          const cp = parseInt(hex, 16);
          out += cp <= 0x10ffff ? String.fromCodePoint(cp) : "";
          this.pos += hex.length;
        } else out += `\\${n}`;
      } else if (/[0-7]/.test(n)) {
        const oct = /^[0-7]{0,2}/.exec(this.src.slice(this.pos, this.pos + 2))![0];
        out += String.fromCharCode(parseInt(n + oct, 8) & 0xff);
        this.pos += oct.length;
      } else if (n === "c") {
        const ch = this.src[this.pos] ?? "";
        out += String.fromCharCode(ch.toUpperCase().charCodeAt(0) ^ 0x40);
        this.pos++;
      } else {
        out += `\\${n}`;
      }
    }
  }
}

function pushLiteral(segments: Segment[], text: string, quoted: boolean): void {
  const last = segments[segments.length - 1];
  if (last?.kind === "lit" && last.quoted === quoted) last.text += text;
  else segments.push({ kind: "lit", text, quoted });
}

/** `NAME=value` or `NAME+=value` as an assignment, when the name part is unquoted literal text. */
function asAssignment(word: Word): Assignment | null {
  const first = word.segments[0];
  if (first?.kind !== "lit" || first.quoted) return null;
  const m = /^([A-Za-z_][A-Za-z0-9_]*)(\+?)=/.exec(first.text);
  if (!m) return asElementAssignment(word);
  return {
    name: m[1]!,
    append: m[2] === "+",
    value: { raw: word.raw.slice(m[0].length), segments: assignedValue(first.text.slice(m[0].length), word.segments.slice(1)) },
  };
}

/**
 * Whether arithmetic text holds an array subscript ksh expands a second time, running a `$(…)` that only the first
 * expansion builds: one with a quote, an escape, a backtick or a `$` other than a plain `$name`, `${name}`,
 * `${#name[@]}` or `$((`.
 */
function subscriptReexpands(text: string): boolean {
  for (let i = text.indexOf("["); i >= 0; i = text.indexOf("[", i + 1)) {
    let depth = 0;
    let j = i;
    for (; j < text.length; j++) {
      if (text[j] === "[") depth++;
      else if (text[j] === "]" && --depth === 0) break;
    }
    const span = text.slice(i + 1, j);
    if (/['"\\`]/.test(span) || /\$(?![A-Za-z_]\w*|\d|\{#?[A-Za-z_]\w*(?:\[[@*\d]\])?\}|\(\()/.test(span)) return true;
  }
  return false;
}

/**
 * `NAME[index]=value` or `NAME[index]+=value`: an array element assignment. The subscript runs to the
 * `]` that closes the first `[`, counting only unquoted brackets, and must be followed straight away by
 * `=` or `+=`; anything else is an ordinary word.
 */
function asElementAssignment(word: Word): Assignment | null {
  const first = word.segments[0] as Extract<Segment, { kind: "lit" }>;
  const head = /^([A-Za-z_][A-Za-z0-9_]*)\[/.exec(first.text);
  if (!head) return null;
  const index: Segment[] = [];
  let depth = 1;
  for (let i = 0; i < word.segments.length; i++) {
    const s = word.segments[i]!;
    if (s.kind !== "lit" || s.quoted) {
      // bash evaluates the subscript as arithmetic, expanding a substitution in its quoted text (`$'\x24(cmd)'`) too.
      if (s.kind === "lit" && /\$[({[]|`/.test(s.text)) throw new UnreadableError("a substitution in quoted text in a subscript, which bash runs");
      index.push(s);
      continue;
    }
    const text = i === 0 ? s.text.slice(head[0].length) : s.text;
    for (let j = 0; j < text.length; j++) {
      if (text[j] === "[") depth++;
      else if (text[j] === "]" && --depth === 0) {
        if (j > 0) pushLiteral(index, text.slice(0, j), false);
        const op = /^(\+?)=/.exec(text.slice(j + 1));
        if (!op) return null;
        if (subscriptReexpands(segmentsRaw(index))) throw new UnreadableError("a subscript nested in an element's that ksh expands again");
        const segments = assignedValue(text.slice(j + 1 + op[0].length), word.segments.slice(i + 1));
        return { name: head[1]!, append: op[1] === "+", index, value: { raw: segmentsRaw(segments), segments }, word };
      }
    }
    if (text) pushLiteral(index, text, false);
  }
  return null;
}

/** An assignment's value: the unquoted text after `=` in its first segment, with a leading `~` expanded as the shell does, then the rest of the word. */
function assignedValue(restText: string, later: readonly Segment[]): Segment[] {
  const segments: Segment[] = [];
  if (restText.startsWith("~") && /^~[A-Za-z0-9._-]*(?:\/|$)/.test(restText) && later.length === 0) {
    const user = /^~([A-Za-z0-9._-]*)/.exec(restText)![1]!;
    segments.push({ kind: "tilde", user });
    const tail = restText.slice(1 + user.length);
    if (tail) segments.push({ kind: "lit", text: tail, quoted: false });
  } else if (restText) segments.push({ kind: "lit", text: restText, quoted: false });
  segments.push(...later);
  return segments;
}

/** Segments written back as shell text, quoting literal text that was quoted; empty only when they are. */
function segmentsRaw(segments: readonly Segment[]): string {
  return segments
    .map((s) => (s.kind === "lit" ? (s.quoted ? `'${s.text.replaceAll("'", `'\\''`)}'` : s.text) : s.kind === "tilde" ? `~${s.user}` : s.raw))
    .join("");
}

/** Parses `source` as a shell command line. Never throws. */
export function parseShell(source: string): ParseResult {
  if (source.length > MAX_SHELL_SOURCE) return { ok: false, error: "command too long to read" };
  try {
    return { ok: true, script: new Parser(source).program() };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * `source` with each comment the shell skips (`# …` at a word's start, up to
 * its newline) blanked to spaces, so offsets stay put; as written when it
 * doesn't parse. A `#` inside a word, quotes or a here-doc body is kept, and
 * the source is kept whole when a comment read starts glued to a character
 * that ends no word, where a shell may read the `#` as part of a word.
 */
export function withoutShellComments(source: string): string {
  if (!source.includes("#") || source.length > MAX_SHELL_SOURCE) return source;
  const parser = new Parser(source);
  try {
    parser.program();
  } catch {
    return source;
  }
  for (const [start] of parser.comments) if (start > 0 && !/[\s;&|()<>]/.test(source[start - 1]!)) return source;
  let out = source;
  for (const [start, end] of parser.comments) out = out.slice(0, start) + " ".repeat(end - start) + out.slice(end);
  return out;
}

/** The word's text when it is entirely literal (quotes removed), else null. */
export function literalOf(word: Word): string | null {
  let out = "";
  for (const s of word.segments) {
    if (s.kind !== "lit") return null;
    out += s.text;
  }
  return out;
}

/** Whether any part of the word was quoted or escaped. */
export function wordIsQuoted(word: Word): boolean {
  return word.segments.some((s) => (s.kind === "lit" || s.kind === "param" || s.kind === "cmdsub" || s.kind === "arith") && s.quoted);
}

/** Every script nested in `segments`: command and process substitutions, including inside parameter operands and arithmetic. */
export function nestedScripts(segments: readonly Segment[]): Script[] {
  const out: Script[] = [];
  for (const s of segments) {
    if (s.kind === "cmdsub" || s.kind === "procsub") out.push(s.script);
    else if (s.kind === "param" && s.operand) out.push(...nestedScripts(s.operand));
    else if (s.kind === "arith") out.push(...nestedScripts(s.parts));
  }
  return out;
}

/** Whether `name` is a valid shell variable name. */
export function isShellName(name: string): boolean {
  return NAME.test(name);
}
