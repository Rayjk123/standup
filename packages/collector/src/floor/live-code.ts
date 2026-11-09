/*
 * What of a JavaScript or TypeScript module runs when another module imports
 * it. Loading a module runs its top-level statements; a function or class it
 * only defines runs when something calls it. So a module reached through an
 * import is read as its top-level code plus the definitions reachable, by
 * name, from that code and from the bindings its importers use. Whatever the
 * reading can't follow keeps the whole module: an anomaly in the text, a
 * statement that isn't a plain definition, `eval`, a namespace import used as
 * a value, `require` or a dynamic `import(…)`.
 */

/** Exported names an importer uses: a set, or null for every export (the module read whole). */
export type Requested = ReadonlySet<string> | null;

export interface ModuleView {
  /** The code that runs: the whole text for an entry or a module read whole, else its top-level code and reachable definitions. */
  text: string;
  /** Each relative module the code that runs loads, with the names it uses from it (null: read whole). */
  imports: Map<string, Requested>;
  /** Relative modules it imports only types from (`import type …`), which TypeScript erases: they don't load. */
  typesOnly: Set<string>;
  /** With `loading`: definitions the code that runs on load hands on as values without calling them, so they may run later. */
  escapes: Set<string>;
  /** With `loading`: whether the code that runs on load does anything beyond building values (acts); always true otherwise. */
  acts: boolean;
  /** The definitions (by index) the code that runs reaches; those in `read` are left out of `text`. */
  live: ReadonlySet<number>;
  /** With `notMain`: `if (import.meta.main) { … }` blocks were left out of `text` (mainGuards). */
  guarded?: true;
}

type Kind = "id" | "num" | "str" | "tpl" | "regex" | "punct";

export interface Token {
  kind: Kind;
  value: string;
  start: number;
  end: number;
  /** Bracket depth before the token. */
  depth: number;
  /** A line break comes between this token and the one before it. */
  nl: boolean;
  /** A `/` (or a regex starting with one) whose reading as division or as a regex the token before it doesn't settle (ambiguousSlash). */
  unsure?: true;
}

/** Words after which a `/` starts a regex literal rather than a division. */
const REGEX_AFTER = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await", "export", "default", "extends"]);

/** Words a definition can't follow on the line before it: they make it part of an expression. */
const EXPRESSION_LEAD = new Set([...REGEX_AFTER, "async", "as", "satisfies", "import"]);

/** Words of a type declaration kept as written when its names are blanked. */
const TYPE_KEYWORDS = new Set(["export", "declare", "type", "interface", "extends"]);

const OPEN: Record<string, string> = { "(": ")", "[": "]", "{": "}" };

/** The index past a quoted string starting at `i`, or -1 when it doesn't close on its line. */
function skipString(text: string, i: number): number {
  const q = text[i]!;
  for (let j = i + 1; j < text.length; j++) {
    const c = text[j]!;
    if (c === "\\") j++;
    else if (c === q) return j + 1;
    else if (c === "\n") return -1;
  }
  return -1;
}

/** The index past a template literal starting at `i`, `${…}` included, or -1 when it doesn't close. */
function skipTemplate(text: string, i: number): number {
  for (let j = i + 1; j < text.length; j++) {
    const c = text[j]!;
    if (c === "\\") j++;
    else if (c === "`") return j + 1;
    else if (c === "$" && text[j + 1] === "{") {
      const inner = scan(text, j + 2, true);
      if (!inner) return -1;
      j = inner.end - 1;
    }
  }
  return -1;
}

/** The module's tokens, or null when its text can't be read reliably (an unclosed string, comment, regex or bracket). */
export function tokenize(text: string): Token[] | null {
  return scan(text, 0, false)?.tokens ?? null;
}

/** The tokens of each `${…}` part of a template literal's text, or null when one can't be read. */
export function templateParts(tpl: string): Token[][] | null {
  const out: Token[][] = [];
  for (let j = 1; j < tpl.length; j++) {
    if (tpl[j] === "\\") j++;
    else if (tpl[j] === "$" && tpl[j + 1] === "{") {
      const inner = scan(tpl, j + 2, true);
      if (!inner) return null;
      out.push(inner.tokens);
      j = inner.end - 1;
    }
  }
  return out;
}

/** Tokens from `from`; `nested` code is a template's `${…}`, which ends at the `}` it doesn't open. */
/** An ASCII identifier character other than a digit (`A`–`Z`, `a`–`z`, `_`, `$`). */
function idStart(c: string): boolean {
  return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_" || c === "$";
}

function digit(c: string): boolean {
  return c >= "0" && c <= "9";
}

/** Words of REGEX_AFTER that may also be plain identifiers (`const of = 4; of / 2`). */
const IDENTIFIER_KEYWORDS = new Set(["of", "yield", "await"]);

/**
 * Whether a `/` after the last of `tokens` may be either a division or the
 * start of a regex: after `)` (`(a) / 2`, `if (a) /re/`), `}` (an object
 * literal or a block), `++`/`--` (postfix or prefix), a `!` after a value (a
 * TypeScript non-null assertion or a negation), a keyword used as a property
 * name (`o.default / 2`, `this.#in / 2`), a keyword that may be an
 * identifier, `>` (a comparison, or TypeScript type arguments `f<T> / 2`),
 * `break`, `continue` and `debugger` (a statement ends there, so a `/` on
 * the next line starts a regex), or a line break after a token that may end
 * a statement (`let v: T⏎/re/`, where automatic semicolon insertion may end
 * it there).
 */
function slashUnsure(tokens: readonly Token[], lineBreak: boolean): boolean {
  const prev = tokens.at(-1);
  if (!prev) return false;
  const endsValue = prev.kind === "num" || prev.kind === "str" || prev.kind === "tpl" || prev.kind === "regex" || (prev.kind === "id" && !REGEX_AFTER.has(prev.value)) || [")", "]", "}"].includes(prev.value);
  if (lineBreak && endsValue) return true;
  const before = tokens.at(-2);
  if (prev.kind === "id" && ["break", "continue", "debugger"].includes(prev.value)) return true;
  if (prev.kind === "punct") {
    if (prev.value === ")" || prev.value === "}" || prev.value === ">") return true;
    if ((prev.value === "+" || prev.value === "-") && before?.value === prev.value && before.end === prev.start) return true;
    if (prev.value === "!" && before) {
      return before.kind === "num" || before.kind === "str" || before.kind === "tpl" || before.kind === "regex" || (before.kind === "id" && !REGEX_AFTER.has(before.value)) || [")", "]", "}"].includes(before.value);
    }
    return false;
  }
  if (prev.kind !== "id" || !REGEX_AFTER.has(prev.value)) return false;
  return IDENTIFIER_KEYWORDS.has(prev.value) || before?.value === "." || before?.value === "?." || before?.value === "#";
}

function scan(text: string, from: number, nested: boolean): { tokens: Token[]; end: number } | null {
  const tokens: Token[] = [];
  const stack: string[] = [];
  let nl = false;
  let i = from;
  const push = (kind: Kind, end: number) => {
    tokens.push({ kind, value: text.slice(i, end), start: i, end, depth: stack.length, nl });
    nl = false;
    i = end;
  };
  while (i < text.length) {
    const c = text[i]!;
    if (nested && c === "}" && !stack.length) return { tokens, end: i + 1 };
    if (c === "\n") {
      nl = true;
      i++;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r" || (c > "~" && /\s/.test(c))) {
      i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      const end = text.indexOf("\n", i);
      i = end < 0 ? text.length : end;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end < 0) return null;
      if (text.slice(i, end).includes("\n")) nl = true;
      i = end + 2;
      continue;
    }
    if (c === "#" && i === 0 && text[1] === "!") {
      const end = text.indexOf("\n");
      i = end < 0 ? text.length : end;
      continue;
    }
    if (c === "'" || c === '"') {
      const end = skipString(text, i);
      if (end < 0) return null;
      push("str", end);
      continue;
    }
    if (c === "`") {
      const end = skipTemplate(text, i);
      if (end < 0) return null;
      push("tpl", end);
      continue;
    }
    if (idStart(c)) {
      let j = i + 1;
      while (j < text.length && (idStart(text[j]!) || digit(text[j]!))) j++;
      push("id", j);
      continue;
    }
    if (digit(c)) {
      let j = i + 1;
      while (j < text.length && (idStart(text[j]!) || digit(text[j]!) || text[j] === ".")) j++;
      push("num", j);
      continue;
    }
    if (c === "/") {
      const prev = tokens.at(-1);
      const division = prev !== undefined && (prev.kind === "num" || prev.kind === "str" || prev.kind === "tpl" || prev.kind === "regex" || (prev.kind === "id" && !REGEX_AFTER.has(prev.value)) || prev.value === ")" || prev.value === "]");
      const unsure = slashUnsure(tokens, nl);
      if (division) {
        push("punct", i + 1);
        if (unsure) tokens.at(-1)!.unsure = true;
        continue;
      }
      {
        let j = i + 1;
        let cls = false;
        for (; j < text.length; j++) {
          const d = text[j]!;
          if (d === "\n") return null;
          if (d === "\\") j++;
          else if (d === "[") cls = true;
          else if (d === "]") cls = false;
          else if (d === "/" && !cls) break;
        }
        if (j >= text.length) return null;
        j++;
        while (j < text.length && /[a-z]/i.test(text[j]!)) j++;
        push("regex", j);
        if (unsure) tokens.at(-1)!.unsure = true;
        continue;
      }
    }
    if (Object.hasOwn(OPEN, c)) {
      push("punct", i + 1);
      stack.push(OPEN[c]!);
      continue;
    }
    if (c === ")" || c === "]" || c === "}") {
      if (stack.pop() !== c) return null;
      tokens.push({ kind: "punct", value: c, start: i, end: i + 1, depth: stack.length, nl });
      nl = false;
      i++;
      continue;
    }
    if (c === "=" && text[i + 1] === ">") {
      push("punct", i + 2);
      continue;
    }
    if (c === "?" && text[i + 1] === "." && !/\d/.test(text[i + 2] ?? "")) {
      push("punct", i + 2);
      continue;
    }
    push("punct", i + 1);
  }
  return stack.length || nested ? null : { tokens, end: i };
}

/** A top-level statement that only defines names: running the module doesn't run its body. */
interface Definition {
  from: number;
  to: number;
  names: string[];
  /** A type (`interface`, `type`): TypeScript erases it, so it never runs and reaches nothing. */
  erased?: boolean;
}

/** `import …` / `export … from …`: loads a module; the names it lists are another module's. */
interface ModuleStatement {
  from: number;
  to: number;
  spec: string | null;
  kind: "import" | "reexport";
  /** The token of its module name. */
  specAt: number;
}

/** `export { a as b }` or `export default a`: exported names standing for local ones. */
interface Alias {
  from: number;
  to: number;
  pairs: Array<[exported: string, local: string]>;
}

/** The index of the token closing the bracket opened at `at`. */
export function closing(tokens: Token[], at: number): number {
  let match = MATCHES.get(tokens);
  if (!match) {
    match = new Int32Array(tokens.length).fill(-1);
    const stack: number[] = [];
    tokens.forEach((t, k) => {
      if (Object.hasOwn(OPEN, t.value)) stack.push(k);
      else if (/^[)\]}]$/.test(t.value)) {
        const o = stack.pop();
        if (o !== undefined) match![o] = k;
      }
    });
    MATCHES.set(tokens, match);
  }
  if (Object.hasOwn(OPEN, tokens[at]!.value)) return match[at]!;
  const d = tokens[at]!.depth;
  for (let k = at + 1; k < tokens.length; k++) if (tokens[k]!.depth === d && /^[)\]}]$/.test(tokens[k]!.value)) return k;
  return -1;
}

/** Each token list's bracket pairs (closing), worked out once. */
const MATCHES = new WeakMap<Token[], Int32Array>();

/** The index past a run of `<…>` type parameters at `at`, or `at` when there are none; -1 when they don't close. */
function skipTypeParams(tokens: Token[], at: number): number {
  if (tokens[at]?.value !== "<") return at;
  let n = 0;
  for (let k = at; k < tokens.length; k++) {
    const t = tokens[k]!;
    if (t.value === "<") n++;
    else if (t.value === ">") n--;
    else if (t.value === ";" || t.value === "{" || t.value === "=") return -1;
    if (n === 0) return k + 1;
  }
  return -1;
}

/**
 * The index past a return-type annotation starting at `at` (`: Promise<void>`)
 * that stops before `stop`: names, members, generics, unions, arrays and
 * object types (`Promise<{ ok: boolean }>`, `: { a: T } | null`), on one
 * line apart from what an object type spans. -1 for anything else, which may
 * run code.
 */
function skipReturnType(tokens: Token[], at: number, stop: (t: Token) => boolean): number {
  let k = at;
  if (tokens[k]?.value !== ":") return tokens[k] && stop(tokens[k]!) ? k : -1;
  const depth = tokens[k]!.depth;
  let angle = 0;
  for (k++; k < tokens.length; k++) {
    const t = tokens[k]!;
    if (t.nl) return -1;
    const prev = tokens[k - 1]!.value;
    // An object type opens where a type is expected: after `:`, `|`, `&`, `,` or inside `<…>`.
    if (t.value === "{" && (angle > 0 || [":", "|", "&", ","].includes(prev))) {
      k = closing(tokens, k);
      if (k < 0) return -1;
      continue;
    }
    if (t.depth === depth && stop(t)) return k;
    if (t.value === "<") angle++;
    else if (t.value === ">") angle--;
    if (!(t.kind === "id" || t.kind === "str" || t.kind === "num" || /^[.<>|&,[\]]$/.test(t.value))) return -1;
  }
  return -1;
}

/**
 * Whether the token after a definition that ends at `end` starts a new
 * statement, so nothing calls or extends what it defines. After a function or
 * class declaration a new line always does; after a value (`const f = …`) one
 * starting with `(`, `[` or a template may continue the expression.
 */
function endsStatement(tokens: Token[], end: number, declaration: boolean): boolean {
  const next = tokens[end + 1];
  if (!next || next.value === ";") return true;
  if (!next.nl) return false;
  if (declaration && next.value !== "." && next.value !== "?.") return true;
  return next.kind === "id" || next.kind === "str" || next.kind === "num" || next.value === "{" || next.value === "@";
}

/** A function from `at` (`function`, after `async`): the index of its last token, or -1. */
function functionEnd(tokens: Token[], at: number, names: string[], named: boolean): number {
  let k = at + 1;
  if (tokens[k]?.value === "*") k++;
  if (tokens[k]?.kind === "id" && tokens[k]!.value !== "(") names.push(tokens[k++]!.value);
  else if (named) return -1;
  k = skipTypeParams(tokens, k);
  if (k < 0 || tokens[k]?.value !== "(") return -1;
  const close = closing(tokens, k);
  if (close < 0) return -1;
  const body = skipReturnType(tokens, close + 1, (t) => t.value === "{" || t.value === ";");
  if (body < 0) return -1;
  // An overload or `declare` signature: no body.
  if (tokens[body]!.value === ";") return body;
  return closing(tokens, body);
}

/** A class from `at` (`class`): the index of its last token, or -1 when defining it runs code (static members, computed keys, decorators, a computed base). */
function classEnd(tokens: Token[], at: number, names: string[], named: boolean): number {
  let k = at + 1;
  if (tokens[k]?.kind === "id" && !["extends", "implements"].includes(tokens[k]!.value)) names.push(tokens[k++]!.value);
  else if (named) return -1;
  for (; k < tokens.length && tokens[k]!.value !== "{"; k++) {
    const t = tokens[k]!;
    if (!(t.kind === "id" || /^[.<>,]$/.test(t.value))) return -1;
  }
  if (k >= tokens.length) return -1;
  const close = closing(tokens, k);
  if (close < 0) return -1;
  const inner = tokens[k]!.depth + 1;
  for (let j = k + 1; j < close; j++) {
    const t = tokens[j]!;
    // A computed member name (`[k]() {}`, `[k] = …`) opens a member, after `{`, `;`, `}` or a line break.
    const member = t.nl || ["{", ";", "}"].includes(tokens[j - 1]!.value);
    if (t.value === "@" || (t.depth === inner && (t.value === "static" || (t.value === "[" && member)))) return -1;
  }
  return close;
}

/**
 * A type from `at` (`interface`, `type`): the index of its last token, or -1.
 * A `type` alias ends at a `;` or at a line that doesn't continue it (`| …`, `& …`).
 */
function typeEnd(tokens: Token[], at: number): number {
  let k = skipTypeParams(tokens, at + 2);
  if (k < 0) return -1;
  if (tokens[at]!.value === "interface") {
    for (; k < tokens.length && tokens[k]!.value !== "{"; k++) {
      const t = tokens[k]!;
      if (!(t.kind === "id" || /^[.<>,]$/.test(t.value))) return -1;
    }
    return k < tokens.length ? closing(tokens, k) : -1;
  }
  if (tokens[k]?.value !== "=") return -1;
  let end = k;
  for (let j = k + 1; j < tokens.length; j++) {
    const t = tokens[j]!;
    if (t.depth === 0 && t.value === ";") break;
    if (t.depth === 0 && t.nl && !["|", "&", ")", "]", "}"].includes(t.value) && !["=", "|", "&", ",", "?", ":", "=>", "extends", "keyof", "typeof"].includes(tokens[j - 1]!.value)) break;
    end = j;
  }
  return end > k ? end : -1;
}

/** An arrow function's value from `at` (after `=` and `async`): the index of its last token, or -1. */
function arrowEnd(tokens: Token[], at: number): number {
  let k = skipTypeParams(tokens, at);
  if (k < 0) return -1;
  if (tokens[k]?.value === "(") {
    const close = closing(tokens, k);
    if (close < 0) return -1;
    k = skipReturnType(tokens, close + 1, (t) => t.value === "=>");
  } else if (tokens[k]?.kind === "id") k++;
  else return -1;
  if (k < 0 || tokens[k]?.value !== "=>") return -1;
  const body = k + 1;
  if (!tokens[body]) return -1;
  if (tokens[body]!.value === "{") return closing(tokens, body);
  // An expression body ends where its statement does: a `;` or a line break at its own depth.
  const depth = tokens[body]!.depth;
  let end = body;
  for (let j = body + 1; j < tokens.length; j++) {
    const t = tokens[j]!;
    if (t.depth < depth || (t.depth === depth && (t.value === ";" || t.value === ","))) break;
    if (t.depth === depth && t.nl) break;
    end = j;
  }
  return end;
}

interface Analysis {
  tokens: Token[];
  definitions: Definition[];
  modules: ModuleStatement[];
  aliases: Alias[];
  /** parents(tokens) and bindingsOf, worked out on first use. */
  parent?: number[];
  names?: Omit<Bindings, "own" | "keys">;
}

/** Whether token `k` can start a top-level statement. */
function statementStart(tokens: Token[], k: number): boolean {
  const t = tokens[k]!;
  if (t.depth !== 0) return false;
  const p = tokens[k - 1];
  const start =
    !p || p.value === ";" || (p.value === "}" && p.depth === 0)
      ? true
      : !t.nl
        ? false
        : p.kind === "id"
          ? !EXPRESSION_LEAD.has(p.value)
          : p.kind === "num" || p.kind === "str" || p.kind === "tpl" || p.kind === "regex" || p.value === ")" || p.value === "]";
  if (!start) return false;
  // A decorator (`@decorate(…)`) before it makes it part of that call.
  for (let j = k - 1; j >= 0 && j >= k - 64; j--) {
    const u = tokens[j]!;
    if (u.depth === 0 && (u.value === ";" || u.value === "}")) break;
    if (u.value === "@") return false;
  }
  return true;
}

/** The module text's definitions, module statements and aliases, or null when it can't be read reliably. */
function analyze(text: string): Analysis | null {
  // A module is read several ways (its load-time code, the names importers use); its analysis is the same each time.
  if (ANALYSES.has(text)) return ANALYSES.get(text)!;
  const a = analyzeText(text);
  if (ANALYSES.size >= 256) ANALYSES.delete(ANALYSES.keys().next().value!);
  ANALYSES.set(text, a);
  return a;
}

/** Recent analyses by module text (analyze). */
const ANALYSES = new Map<string, Analysis | null>();

function analyzeText(text: string): Analysis | null {
  const tokens = tokenize(text);
  if (!tokens) return null;
  const definitions: Definition[] = [];
  const modules: ModuleStatement[] = [];
  const aliases: Alias[] = [];
  const str = (t: Token | undefined) => (t?.kind === "str" ? t.value.slice(1, -1) : null);
  for (let k = 0; k < tokens.length; k++) {
    if (!statementStart(tokens, k)) continue;
    const t = tokens[k]!;
    const semi = (at: number) => (tokens[at + 1]?.value === ";" ? at + 1 : at);
    // `import x from "./m"`, `import "./m"`; not `import(…)`, `import.meta` or `import x = require(…)`.
    if (t.value === "import" && !["(", ".", "?."].includes(tokens[k + 1]?.value ?? "")) {
      let at = -1;
      for (let j = k + 1; j < tokens.length; j++) {
        const u = tokens[j]!;
        if ((u.depth === 0 && u.value === ";") || u.value === "=" || u.value === "(") break;
        if (u.kind === "str" && (tokens[j - 1]?.value === "from" || j === k + 1)) {
          at = j;
          break;
        }
      }
      if (at < 0) continue;
      modules.push({ from: k, to: semi(at), spec: str(tokens[at]), kind: "import", specAt: at });
      k = semi(at);
      continue;
    }
    if (t.value === "export") {
      const open: number = k + (tokens[k + 1]?.value === "type" && tokens[k + 2]?.value === "{" ? 2 : 1);
      if (tokens[open]?.value === "{") {
        const close = closing(tokens, open);
        if (close < 0) continue;
        if (tokens[close + 1]?.value === "from" && tokens[close + 2]?.kind === "str") {
          modules.push({ from: k, to: semi(close + 2), spec: str(tokens[close + 2]), kind: "reexport", specAt: close + 2 });
          k = semi(close + 2);
          continue;
        }
        // `export { a as b }`: an alias, not a load.
        const pairs: Array<[string, string]> = [];
        for (const part of splitList(tokens, open + 1, close)) {
          const ids = part.filter((p) => p.value !== "type").map((p) => p.value);
          if (ids.length === 1) pairs.push([ids[0]!, ids[0]!]);
          else if (ids.length === 3 && ids[1] === "as") pairs.push([ids[2]!, ids[0]!]);
        }
        aliases.push({ from: k, to: semi(close), pairs });
        k = semi(close);
        continue;
      }
      if (tokens[open]?.value === "*") {
        const f = tokens[open + 1]?.value === "as" ? open + 3 : open + 1;
        if (tokens[f]?.value === "from" && tokens[f + 1]?.kind === "str") {
          modules.push({ from: k, to: semi(f + 1), spec: str(tokens[f + 1]), kind: "reexport", specAt: f + 1 });
          k = semi(f + 1);
        }
        continue;
      }
    }
    // `export default name`: an alias.
    if (t.value === "export" && tokens[k + 1]?.value === "default" && tokens[k + 2]?.kind === "id" && !["function", "class", "async"].includes(tokens[k + 2]!.value) && endsStatement(tokens, k + 2, false)) {
      const to = tokens[k + 3]?.value === ";" ? k + 3 : k + 2;
      aliases.push({ from: k, to, pairs: [["default", tokens[k + 2]!.value]] });
      k = to;
      continue;
    }
    let j = k;
    const names: string[] = [];
    if (tokens[j]!.value === "export") {
      j++;
      if (tokens[j]?.value === "default") {
        names.push("default");
        j++;
      }
    }
    if (tokens[j]?.value === "declare") j++;
    const named = !names.includes("default");
    let end = -1;
    let declaration = true;
    if (named && (tokens[j]?.value === "interface" || tokens[j]?.value === "type") && tokens[j + 1]?.kind === "id") {
      // `interface X {…}`, `type X = …`: erased from what runs.
      end = typeEnd(tokens, j);
      if (end >= 0 && endsStatement(tokens, end, true)) {
        const to = tokens[end + 1]?.value === ";" ? end + 1 : end;
        definitions.push({ from: k, to, names: [tokens[j + 1]!.value], erased: true });
        k = to;
      }
      continue;
    }
    if (tokens[j]?.value === "async" && tokens[j + 1]?.value === "function" && !tokens[j + 1]!.nl) end = functionEnd(tokens, j + 1, names, named);
    else if (tokens[j]?.value === "function") end = functionEnd(tokens, j, names, named);
    else if (tokens[j]?.value === "class") end = classEnd(tokens, j, names, named);
    else if (named && ["const", "let", "var"].includes(tokens[j]?.value ?? "") && tokens[j + 1]?.kind === "id") {
      declaration = false;
      names.push(tokens[j + 1]!.value);
      let v = skipReturnType(tokens, j + 2, (u) => u.value === "=");
      if (v > 0 && tokens[v]?.value === "=") {
        v++;
        if (tokens[v]?.value === "async" && !tokens[v + 1]?.nl) v++;
        if (tokens[v]?.value === "function") end = functionEnd(tokens, v, [], false);
        else if (tokens[v]?.value === "class") end = classEnd(tokens, v, [], false);
        else end = arrowEnd(tokens, v);
      }
    }
    if (end < 0 || !names.length || !endsStatement(tokens, end, declaration)) continue;
    const to = tokens[end + 1]?.value === ";" ? end + 1 : end;
    definitions.push({ from: k, to, names });
    k = to;
  }
  return { tokens, definitions, modules, aliases };
}

/** The comma-separated parts of tokens `from`…`to` (exclusive) at their own depth. */
function splitList(tokens: Token[], from: number, to: number): Token[][] {
  const parts: Token[][] = [[]];
  const depth = tokens[from]?.depth ?? 0;
  for (let k = from; k < to; k++) {
    const t = tokens[k]!;
    if (t.depth === depth && t.value === ",") parts.push([]);
    else parts.at(-1)!.push(t);
  }
  return parts.filter((p) => p.length);
}

/** The names a template literal's `${…}` parts mention, each counted as called; its text around them is data. */
function templateNames(tpl: string): string[] {
  const out: string[] = [];
  for (let j = 1; j < tpl.length; j++) {
    if (tpl[j] === "\\") j++;
    else if (tpl[j] === "$" && tpl[j + 1] === "{") {
      const inner = scan(tpl, j + 2, true);
      if (!inner) return [...tpl.matchAll(/[A-Za-z_$][\w$]*/g)].map((m) => m[0]);
      for (const t of inner.tokens) {
        if (t.kind === "id") out.push(t.value);
        else if (t.kind === "tpl") out.push(...templateNames(t.value));
      }
      j = inner.end - 1;
    }
  }
  return out;
}

/** For each token, the index of the bracket it sits directly inside, or -1 at the top level. */
function parents(tokens: Token[]): number[] {
  const out: number[] = [];
  const stack: number[] = [];
  tokens.forEach((t, k) => {
    if (/^[)\]}]$/.test(t.value)) stack.pop();
    out.push(stack.at(-1) ?? -1);
    // Own keys only: `"toString" in OPEN` is true through the prototype.
    if (Object.hasOwn(OPEN, t.value)) stack.push(k);
  });
  return out;
}

/** Properties of `import.meta` a module may read without being able to change its `main`. */
const META_READS = new Set(["main", "dir", "dirname", "path", "file", "filename", "url", "env", "resolve"]);

/**
 * Whether `tokens`, or any template's `${…}` part, hold a `/` the tokenizer
 * can't be sure is a division or a regex (Token.unsure): read the wrong way,
 * a regex's brackets count as real ones (`if (c) /{/`) or a division's hide
 * real ones (`{} / 1; } run(); { 1 /`), so where a block ends isn't sure. A
 * template whose parts can't be read counts as one, and so does any
 * character the tokenizer reads as punctuation but JavaScript may read as
 * part of a name (a non-ASCII letter, a `\u` escape): a `/` after such a name divides, where the
 * tokenizer starts a regex.
 */
export function ambiguousSlash(tokens: readonly Token[]): boolean {
  return tokens.some((t) => {
    if (t.kind === "tpl") {
      const parts = templateParts(t.value);
      return !parts || parts.some((p) => ambiguousSlash(p));
    }
    if (t.kind === "punct" && !/^[\x21-\x7e]+$/.test(t.value.replace(/\\/g, " "))) return true;
    return t.unsure === true;
  });
}

/**
 * The top-level `if (import.meta.main) { … }` statements, with no `else`: in
 * a module another one imports, `main` is false, so the block doesn't run.
 * None when the module could make `main` true itself: `main` named anywhere
 * but such a test, `import.meta` used other than to read one of META_READS
 * (handed on, indexed, destructured), or named inside a template literal.
 * None either when where a block ends isn't sure (ambiguousSlash). What a
 * guard leaves out is still read by the floor, as code this load may not
 * reach (ModuleView.guarded).
 */
function mainGuards(tokens: Token[]): Array<{ from: number; to: number }> {
  if (ambiguousSlash(tokens)) return [];
  const out: Array<{ from: number; to: number }> = [];
  const tests = new Set<number>();
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k]!;
    if (t.value !== "if" || t.kind !== "id" || !statementStart(tokens, k)) continue;
    const test = tokens.slice(k + 1, k + 9).map((u) => u.value).join(" ");
    if (test !== "( import . meta . main ) {") continue;
    const end = closing(tokens, k + 8);
    if (end < 0 || tokens[end + 1]?.value === "else") continue;
    tests.add(k + 2);
    out.push({ from: k, to: end });
  }
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k]!;
    if (t.kind === "tpl" && /\bimport\b[\s\S]*\bmeta\b/.test(t.value)) return [];
    if (t.value !== "import" || tokens[k + 1]?.value === "(" || tokens[k + 2]?.value !== "meta") continue;
    if (tokens[k + 1]?.value !== "." || tokens[k - 1]?.value === ".") continue;
    const prop = tokens[k + 4];
    if (tokens[k + 3]?.value !== "." || prop?.kind !== "id" || !META_READS.has(prop.value)) return [];
    if (prop.value === "main" && !tests.has(k)) return [];
  }
  return out;
}

/** Words before `(` that open a condition or a parameter list, not a call. */
const NOT_CALLEES = new Set(["if", "for", "while", "switch", "catch", "function", "with"]);

/** Whether the identifier at `k` is a whole argument of a call (`run(cb)`, `setTimeout(cb, 1)`): the callee may call it now. */
function callArgument(tokens: Token[], k: number, parent: readonly number[]): boolean {
  const p = parent[k]!;
  if (p < 0 || tokens[p]!.value !== "(") return false;
  const callee = tokens[p - 1];
  if (!callee || !(callee.kind === "id" || callee.value === ")" || callee.value === "]" || callee.kind === "tpl") || NOT_CALLEES.has(callee.value)) return false;
  return ["(", ","].includes(tokens[k - 1]!.value) && [",", ")"].includes(tokens[k + 1]?.value ?? "");
}

/**
 * Whether the identifier at `k` is only read as a value (`run(cb)`, `{ cb }`,
 * `x = cb;`), not called or constructed: a callback handed on may run later,
 * not necessarily now. Anything else counts as a call.
 */
function valueOnly(tokens: Token[], k: number, parent: readonly number[]): boolean {
  if (tokens[k - 1]?.value === "new" || callArgument(tokens, k, parent)) return false;
  const next = tokens[k + 1];
  if (!next) return true;
  if ([",", ")", "]", "}", ";"].includes(next.value)) return true;
  return next.nl && !["(", "[", ".", "?.", "`"].includes(next.value) && next.kind !== "tpl";
}

/**
 * The code of `text` that runs. `requested` is undefined for an entry (a
 * script run, a test file): it runs whole and exports nothing anyone uses.
 * null for a module whose every export may be used: read whole. A set for a
 * module imported for those names: read for its top-level code and the
 * definitions they and that code reach. With `loading`, what runs when the
 * module loads: its top-level code and the definitions that code calls, a
 * definition it only hands on as a value, or names in a function it only
 * stores, going to `escapes` instead (`storing` false reads stored functions
 * as running too). Definitions in `read`, already read, are left out of the
 * text when pruning. Null
 * when the text can't be read reliably, so the caller reads it whole and
 * follows its imports as before.
 */
export function moduleView(text: string, requested: Requested | undefined, loading = false, storing = true, read?: ReadonlySet<number>, notMain = false): ModuleView | null {
  const a = analyze(text);
  if (!a) return null;
  const { tokens } = a;
  // Which token each statement claims, so the rest is the code that runs on load.
  const owner = new Array<number>(tokens.length).fill(-1);
  a.definitions.forEach((d, n) => owner.fill(n, d.from, d.to + 1));
  const skipped = new Array<boolean>(tokens.length).fill(false);
  for (const s of [...a.modules, ...a.aliases]) skipped.fill(true, s.from, s.to + 1);
  // With `notMain`, the module is imported and isn't the entry, so its `if (import.meta.main) { … }` block never runs.
  const guards = notMain && requested instanceof Set ? mainGuards(tokens) : [];
  for (const g of guards) skipped.fill(true, g.from, g.to + 1);
  // Every name the code that runs mentions, and those it calls (the same, unless `loading`):
  // with `loading`, the names it imports are those it calls, which run as it loads.
  // Only reading what runs as it loads needs the brackets each token sits in and what the module binds.
  const parent = loading ? (a.parent ??= parents(tokens)) : [];
  // What a function the top-level code only stores names is a value, not a call, while it loads.
  const names = loading ? (a.names ??= bindingsOf(a, parent)) : NO_BINDINGS;
  // The keys functions are stored under count either way: a call of one runs what it holds.
  const found = loading ? storedFunctions(tokens, owner, parent, names) : { stored: new Map<number, number>(), keys: new Set<string>() };
  const keys = found.keys;
  const stored = storing ? found.stored : new Map<number, number>();
  const inStored = new Array<boolean>(tokens.length).fill(false);
  for (const [from, to] of stored) inStored.fill(true, from, to + 1);
  const refs = new Set<string>();
  const calls = loading && storing ? new Set<string>() : refs;
  const values = new Set<string>();
  const collect = (from: number, to: number) => {
    for (let k = from; k <= to; k++) {
      const t = tokens[k]!;
      const value = loading && storing && (inStored[k] || (t.kind === "id" && valueOnly(tokens, k, parent)));
      if (t.kind === "id") {
        refs.add(t.value);
        (value ? values : calls).add(t.value);
      } else if (t.kind === "tpl") {
        for (const id of templateNames(t.value)) {
          refs.add(id);
          (value ? values : calls).add(id);
        }
      }
    }
  };
  for (let k = 0; k < tokens.length; k++) if (owner[k] === -1 && !skipped[k]) collect(k, k);
  const pruning = requested instanceof Set;
  const live = new Set<number>();
  if (!pruning) a.definitions.forEach((d, n) => (live.add(n), collect(d.from, d.to)));
  // An exported name an importer uses, through `export { a as b }` and `export default a`.
  const exported = (name: string) => requested === null || (requested !== undefined && requested.has(name));
  for (const al of a.aliases) for (const [ex, local] of al.pairs) if (exported(ex)) (refs.add(local), calls.add(local));
  if (pruning) for (const r of requested) (refs.add(r), calls.add(r));
  for (let grew = true; grew; ) {
    grew = false;
    a.definitions.forEach((d, n) => {
      if (live.has(n) || d.erased || !d.names.some((x) => calls.has(x))) return;
      live.add(n);
      collect(d.from, d.to);
      grew = true;
    });
  }
  const escapes = new Set([...values].filter((v) => !calls.has(v) && a.definitions.some((d, n) => !live.has(n) && !d.erased && d.names.includes(v))));
  const runs = (k: number) => !skipped[k] && (owner[k]! < 0 || live.has(owner[k]!));
  // Code that runs calling what it stored (`o.run()`) may run it now: read every stored function as running.
  if (stored.size && callsStored(tokens, runs, parent, stored, keys)) return moduleView(text, requested, loading, false, undefined, notMain);
  // Direct `eval` reaches any local name by text.
  const evals = (t: Token, k: number) => (t.kind === "id" && t.value === "eval" && tokens[k - 1]?.value !== ".") || (t.kind === "tpl" && templateNames(t.value).includes("eval"));
  if (pruning && tokens.some((t, k) => runs(k) && evals(t, k))) return null;
  const imports = new Map<string, Requested>();
  const typesOnly = new Set<string>();
  const want = (spec: string, names: Requested) => {
    if (!/^\.{1,2}\//.test(spec)) return;
    const prev = imports.get(spec);
    if (prev === null) return;
    if (names === null) imports.set(spec, null);
    else imports.set(spec, new Set([...(prev ?? []), ...names]));
  };
  // Every use of a namespace binding, when each is a member read (`ns.name`); null when it's used any other way.
  const members = (ns: string): Set<string> | null => {
    const out = new Set<string>();
    for (let k = 0; k < tokens.length; k++) {
      const t = tokens[k]!;
      if (t.kind !== "id" || t.value !== ns || !runs(k)) continue;
      if (tokens[k - 1]?.value === "." || tokens[k - 1]?.value === "?.") continue;
      const dot = tokens[k + 1]?.value;
      const name = tokens[k + 2];
      if ((dot === "." || dot === "?.") && name?.kind === "id") out.add(name.value);
      else return null;
    }
    return out;
  };
  for (const s of a.modules) {
    if (s.spec === null) continue;
    const body = tokens.slice(s.from + 1, s.to + 1);
    // `import type …`, `export type … from`: erased.
    if (body[0]?.value === "type" && body[1]?.value !== "," && body[1]?.value !== "from") {
      typesOnly.add(s.spec);
      continue;
    }
    if (s.kind === "reexport") {
      if (body[0]?.value === "*") {
        const ns = body[1]?.value === "as" ? body[2]?.value : undefined;
        if (ns !== undefined) want(s.spec, exported(ns) ? null : new Set());
        else want(s.spec, requested === undefined ? new Set() : requested === null ? null : new Set([...requested].filter((r) => r !== "default")));
        continue;
      }
      const open = s.from + 1 + (body[0]?.value === "type" ? 1 : 0);
      const close = closing(tokens, open);
      const names = new Set<string>();
      for (const part of close > 0 ? splitList(tokens, open + 1, close) : []) {
        const ids = part.map((p) => p.value);
        if (ids[0] === "type") continue;
        const [inner, outer] = ids.length === 3 && ids[1] === "as" ? [ids[0]!, ids[2]!] : [ids[0]!, ids[0]!];
        if (exported(outer)) names.add(inner);
      }
      want(s.spec, close > 0 ? names : null);
      continue;
    }
    // import [D][, {…} | * as NS] from "spec" | import "spec"
    const names = new Set<string>();
    let whole = false;
    let k = s.from + 1;
    if (tokens[k]?.kind === "id" && tokens[k]!.value !== "type" && (tokens[k + 1]?.value === "from" || tokens[k + 1]?.value === ",")) {
      if (calls.has(tokens[k]!.value)) names.add("default");
      k += tokens[k + 1]?.value === "," ? 2 : 1;
    }
    if (tokens[k]?.value === "*" && tokens[k + 1]?.value === "as" && tokens[k + 2]?.kind === "id") {
      const used = refs.has(tokens[k + 2]!.value) ? members(tokens[k + 2]!.value) : new Set<string>();
      if (used === null) whole = true;
      else for (const u of used) names.add(u);
    } else if (tokens[k]?.value === "{") {
      const close = closing(tokens, k);
      if (close < 0) whole = true;
      for (const part of close > 0 ? splitList(tokens, k + 1, close) : []) {
        const ids = part.map((p) => p.value);
        if (ids[0] === "type") continue;
        const [imported, local] = ids.length === 3 && ids[1] === "as" ? [ids[0]!, ids[2]!] : ids.length === 1 ? [ids[0]!, ids[0]!] : [null, null];
        if (imported === null) whole = true;
        else if (calls.has(local!)) names.add(imported);
      }
    } else if (tokens[k]?.kind !== "str" && tokens[k]?.value !== "from") whole = true;
    want(s.spec, whole ? null : names);
  }
  // `require("./m")`, `import("./m")` in the code that runs: whatever they return may be used in full.
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k]!;
    if (!runs(k)) continue;
    // `module.require(…)` and `import.meta.require(…)` load the same way.
    const through = tokens[k - 1]?.value === "." && t.value === "require" && ["module", "meta"].includes(tokens[k - 2]?.value ?? "");
    if ((t.value === "require" || t.value === "import") && tokens[k + 1]?.value === "(" && (tokens[k - 1]?.value !== "." || through)) {
      const s = tokens[k + 2];
      if (s?.kind === "str" || s?.kind === "tpl") want(s.value.slice(1, -1), null);
    }
  }
  for (const spec of imports.keys()) typesOnly.delete(spec);
  if (!pruning) return { text, imports, typesOnly, escapes, acts: true, live };
  // The code that runs, with each definition nothing reaches left out. A type
  // never runs, but its string literals say which words are data (`"git" |
  // "deploy"`): it stays, with its names blanked, so a field named like a
  // helper (`standupDataDir: string`) doesn't read as a use of it. An import
  // none of whose names that code uses is left out too: the module it loads
  // is in `imports` all the same.
  const cuts: Array<{ from: number; to: number; text: string }> = [];
  a.definitions.forEach((d, n) => {
    // A definition this module was already read for is left out too: its findings are in.
    if (live.has(n) && !read?.has(n)) return;
    let blanked = "";
    for (let k = d.from; d.erased && k <= d.to; k++) {
      const t = tokens[k]!;
      if (k > d.from) blanked += text.slice(tokens[k - 1]!.end, t.start);
      blanked += t.kind === "id" && !TYPE_KEYWORDS.has(t.value) ? "_" : t.value;
    }
    // Read again, its types were read the first time.
    cuts.push({ from: d.from, to: d.to, text: d.erased && !read?.size ? blanked : "\n" });
  });
  for (const s of a.modules) {
    if (s.kind !== "import") continue;
    const names = tokens.slice(s.from + 1, s.specAt).filter((t) => t.kind === "id" && !["type", "as", "from"].includes(t.value));
    if (names.length && !names.some((t) => refs.has(t.value))) cuts.push({ from: s.from, to: s.to, text: "\n" });
  }
  // A function only stored doesn't run as the module loads: its body is left to the functions an importer may call.
  for (const [from, to] of stored) cuts.push({ from, to, text: " 0 " });
  for (const g of guards) cuts.push({ from: g.from, to: g.to, text: "\n" });
  // Read again (`read`), its top-level code was read the first time: only the imports stay, beside the definitions newly reached.
  if (read?.size) {
    for (let k = 0; k < tokens.length; k++) {
      if (owner[k] !== -1 || skipped[k]) continue;
      let to = k;
      while (to + 1 < tokens.length && owner[to + 1] === -1 && !skipped[to + 1]) to++;
      cuts.push({ from: k, to, text: "\n" });
      k = to;
    }
  }
  cuts.sort((x, y) => x.from - y.from);
  let out = "";
  let at = 0;
  for (const c of cuts) {
    out += text.slice(at, tokens[c.from]!.start) + c.text;
    at = tokens[c.to]!.end;
  }
  out += text.slice(at);
  const guarded = guards.length ? { guarded: true as const } : {};
  if (!loading) return { text: out, imports, typesOnly, escapes, acts: true, live, ...guarded };
  const own = new Set(a.definitions.filter((_, n) => live.has(n)).flatMap((d) => d.names));
  const acting = acts(tokens, runs, parent, stored, { ...names, own, keys });
  // Code that does something as it loads may run whatever it can reach: what it only names counts as called.
  if (acting && storing) return moduleView(text, requested, true, false, undefined, notMain);
  return { text: out, imports, typesOnly, escapes, acts: acting, live, ...guarded };
}

/** What the module binds, for reading whether its load-time code acts (Bindings, but `own`). */
function bindingsOf(a: Analysis, parent: readonly number[]): Omit<Bindings, "own" | "keys"> {
  const { tokens } = a;
  // Every name an import binds, with the module and the name it is there (`D`, `b` in `a as b`, `ns` in `* as ns`).
  const bound = new Map<string, { spec: string; name: string }>();
  for (const s of a.modules) {
    if (s.kind !== "import" || s.spec === null) continue;
    const clause = tokens.slice(s.from + 1, s.specAt);
    clause.forEach((t, i) => {
      if (t.kind !== "id" || ["type", "as", "from"].includes(t.value) || clause[i + 1]?.value === "as") return;
      bound.set(t.value, { spec: s.spec!, name: clause[i - 1]?.value === "as" ? (clause[i - 2]?.value ?? "") : t.value });
    });
  }
  // Names the module declares or assigns itself (`const join = execSync`, `{ join } = …`), which may be anything.
  // A parameter, destructured or not, holds what its caller hands it, which the caller's call is read for.
  const inParams = (k: number) => {
    for (let p = parent[k]!; p >= 0; p = parent[p]!) {
      if (tokens[p]!.value !== "(") continue;
      const after = tokens[closing(tokens, p) + 1]?.value;
      return after === "=>" || (after === "{" && (tokens[p - 1]?.value === "function" || tokens[p - 2]?.value === "function"));
    }
    return false;
  };
  const declared = new Set<string>();
  tokens.forEach((t, k) => {
    if (t.kind !== "id") return;
    const prev = tokens[k - 1]?.value ?? "";
    const next = tokens[k + 1]?.value ?? "";
    if (["const", "let", "var", "function", "class"].includes(prev) || (next === "=" && !["=", ">"].includes(tokens[k + 2]?.value ?? ""))) declared.add(t.value);
    else if (["{", ","].includes(prev) && ["}", ",", ":", "="].includes(next) && !inParams(k)) declared.add(t.value);
  });
  // Names bound once, by `const`, to a literal (a regex, string, number, array, `new RegExp(…)`, `String.raw\`…\``): their methods are the builtins.
  const literals = new Set<string>();
  const bindings = new Map<string, number>();
  tokens.forEach((t, k) => {
    if (t.kind !== "id" || !declared.has(t.value)) return;
    const next = tokens[k + 1]?.value ?? "";
    const pattern = ["{", ","].includes(tokens[k - 1]?.value ?? "") && ["}", ",", ":", "="].includes(next);
    if ((next === "=" && !["=", ">"].includes(tokens[k + 2]?.value ?? "")) || ["const", "let", "var", "function", "class"].includes(tokens[k - 1]?.value ?? "") || pattern) bindings.set(t.value, (bindings.get(t.value) ?? 0) + 1);
  });
  tokens.forEach((t, k) => {
    if (t.kind !== "id" || tokens[k - 1]?.value !== "const" || bindings.get(t.value) !== 1) return;
    // Past a type annotation (`const X: readonly Rule[] = […]`).
    const eq = skipReturnType(tokens, k + 1, (u) => u.value === "=");
    if (eq < 0 || tokens[eq]?.value !== "=") return;
    const v = tokens[eq + 1];
    const raw = v?.value === "String" && tokens[eq + 2]?.value === "." && tokens[eq + 3]?.value === "raw" && tokens[eq + 4]?.kind === "tpl";
    const builtin = v?.value === "new" && ["RegExp", "Map", "Set", "WeakMap", "WeakSet"].includes(tokens[eq + 2]?.value ?? "");
    if (v && (["regex", "str", "tpl", "num"].includes(v.kind) || v.value === "[" || raw || builtin)) literals.add(t.value);
  });
  const defined = new Set(a.definitions.filter((d) => !d.erased).flatMap((d) => d.names));
  return { bound, declared, defined, literals };
}

const NO_BINDINGS: Omit<Bindings, "own" | "keys"> = { bound: new Map(), declared: new Set(), defined: new Set(), literals: new Set() };

/** Builtins that only build values, called by name: constructors and conversions. */
const PURE_GLOBALS = new Set("Number String Boolean BigInt parseInt parseFloat isNaN isFinite Set Map WeakMap WeakSet RegExp Array Object Symbol Error TypeError RangeError Date URL".split(" "));

/** Modules whose functions only build values (paths, the home and temp dirs). */
const PURE_MODULES = /^(?:node:)?(?:path|os|url)$/;

/** Global namespaces whose PURE_CALLS methods only build values. */
const PURE_NAMESPACES = new Set(["Object", "JSON", "Math", "Array", "Number", "String", "Symbol", "Date", "path"]);

/** Calls that only build values: paths, strings, numbers, collections, patterns. */
const PURE_CALLS = new Set(
  (
    "join resolve dirname basename extname normalize relative isAbsolute homedir tmpdir platform cwd freeze keys values entries fromEntries assign isArray from of " +
    "map filter flatMap flat reduce concat slice split trim trimEnd trimStart toLowerCase toUpperCase replace replaceAll padStart padEnd startsWith endsWith " +
    "includes indexOf lastIndexOf test match matchAll repeat at find findIndex some every sort reverse push add has get set delete clear fill toString toFixed stringify parse " +
    "Number String Boolean BigInt parseInt parseFloat isNaN isFinite isInteger Set Map WeakMap WeakSet RegExp Array Object Symbol Error TypeError RangeError Date now " +
    "max min floor ceil round abs pow sqrt trunc sign raw"
  ).split(" "),
);

/**
 * The last token of a function expression at `k` held as a value: after `:`
 * (an object property, a ternary's branch) or an assignment's `=`, and not
 * called on the spot. -1 otherwise.
 */
function functionValueEnd(tokens: Token[], k: number): number {
  const prev = tokens[k - 1]?.value;
  if (prev !== ":" && !(prev === "=" && !["=", "!", "<", ">"].includes(tokens[k - 2]?.value ?? ""))) return -1;
  // A key the language calls on its own (`toString`, `then`, `[Symbol.iterator]`) runs the function implicitly.
  if (prev === ":" && (tokens[k - 2]?.value === "]" || IMPLICIT_KEYS.has(tokens[k - 2]?.value.replace(/^["']|["']$/g, "") ?? ""))) return -1;
  let j = k;
  if (tokens[j]?.value === "async" && !tokens[j + 1]?.nl) j++;
  const end = tokens[j]?.value === "function" ? functionEnd(tokens, j, [], false) : tokens[j]?.value === "(" || tokens[j]?.kind === "id" ? arrowEnd(tokens, j) : -1;
  if (end < 0) return -1;
  const after = tokens[end + 1];
  return after && (["(", ".", "?.", "["].includes(after.value) || after.kind === "tpl") ? -1 : end;
}

/**
 * The `{` of a method's body when the identifier at `k` names a method written
 * out in an object or class (`run(x) {`, `async *gen(): T {`, `get v() {`),
 * else -1.
 */
function methodBody(tokens: Token[], k: number, parent: readonly number[]): number {
  const t = tokens[k]!;
  if (t.kind !== "id" || tokens[k + 1]?.value !== "(") return -1;
  const p = parent[k]!;
  if (p < 0 || tokens[p]!.value !== "{") return -1;
  const prev = tokens[k - 1]?.value ?? "";
  if (!t.nl && !["{", ",", ";", "}", "*", "async", "static", "get", "set"].includes(prev)) return -1;
  const close = closing(tokens, k + 1);
  if (close < 0 || tokens[close + 1]?.nl) return -1;
  const body = skipReturnType(tokens, close + 1, (u) => u.value === "{");
  return body > 0 && tokens[body]!.value === "{" ? body : -1;
}

/**
 * The functions the top-level code only stores (an object's method or
 * property, an assignment), which run when something calls them, not as the
 * module loads: each body's first token mapped to its last. One the language
 * calls on its own (a getter, a `toString`/`then`/iterator key) isn't stored.
 * `keys` are the names they are stored under.
 */
function storedFunctions(tokens: Token[], owner: readonly number[], parent: readonly number[], { bound, defined }: Omit<Bindings, "own" | "keys">): { stored: Map<number, number>; keys: Set<string> } {
  const stored = new Map<number, number>();
  const keys = new Set<string>();
  for (let k = 0; k < tokens.length; k++) {
    if (owner[k]! >= 0) continue;
    const t = tokens[k]!;
    // A function it defines or imports, stored under a key (`{ push: execSync }`, `{ go }`): calling that key runs it.
    if (t.kind === "id" && (defined.has(t.value) || bound.has(t.value)) && [",", "}"].includes(tokens[k + 1]?.value ?? "")) {
      if (tokens[k - 1]?.value === ":" && tokens[k - 2]) keys.add(tokens[k - 2]!.value.replace(/^["']|["']$/g, ""));
      else if (["{", ","].includes(tokens[k - 1]?.value ?? "")) keys.add(t.value);
    }
    const method = methodBody(tokens, k, parent);
    if (method >= 0) {
      const prev = tokens[k - 1]?.value;
      const end = closing(tokens, method);
      if (end < 0) return { stored: new Map(), keys };
      if (!IMPLICIT_KEYS.has(t.value) && prev !== "get" && prev !== "set") {
        keys.add(t.value);
        if (end > method + 1) stored.set(method + 1, end - 1);
        k = end;
      }
      continue;
    }
    const end = functionValueEnd(tokens, k);
    if (end <= k) continue;
    if (tokens[k - 1]?.value === ":") keys.add(tokens[k - 2]!.value.replace(/^["']|["']$/g, ""));
    else if (tokens[k - 2]?.kind === "id") keys.add(tokens[k - 2]!.value);
    // The body: after the arrow, or inside the braces of a `function`.
    let body = k;
    while (body <= end && tokens[body]!.value !== "=>" && tokens[body]!.value !== "{") body++;
    if (tokens[body]?.value === "{" && tokens[body - 1]?.value !== "=>") stored.set(body + 1, closing(tokens, body) - 1);
    else if (tokens[body]?.value === "=>") stored.set(body + 1, end);
    k = end;
  }
  return { stored, keys };
}

/** Whether code that runs (`runs`, outside `stored`) calls a stored function's key (`o.run()`) or a computed member (`o[k]()`). */
function callsStored(tokens: Token[], runs: (k: number) => boolean, parent: readonly number[], stored: ReadonlyMap<number, number>, keys: ReadonlySet<string>): boolean {
  for (let k = 0; k < tokens.length; k++) {
    if (!runs(k)) continue;
    const skip = stored.get(k);
    if (skip !== undefined) {
      k = skip;
      continue;
    }
    const t = tokens[k]!;
    const next = tokens[k + 1]?.value;
    const callsIt = next === "(" || tokens[k + 1]?.kind === "tpl" || (next === "?." && tokens[k + 2]?.value === "(");
    if (!callsIt || methodBody(tokens, k, parent) >= 0) continue;
    if ((t.kind === "id" && keys.has(t.value) && tokens[k - 1]?.value !== "function") || t.value === "]") return true;
  }
  return false;
}

/** Words that take a parenthesized part without calling anything. */
const PAREN_KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "function", "return", "typeof", "await", "yield", "void", "in", "of", "case", "super", "import"]);

/** Object keys the language itself calls (coercion, iteration, `await`, JSON). */
const IMPLICIT_KEYS = new Set(["toString", "valueOf", "toJSON", "then", "get", "set", "toPrimitive", "iterator", "asyncIterator"]);

interface Bindings {
  /** Its live definitions, whose bodies are part of the code that runs. */
  own: ReadonlySet<string>;
  /** What its imports bind. */
  bound: ReadonlyMap<string, { spec: string; name: string }>;
  /** Names it declares or assigns. */
  declared: ReadonlySet<string>;
  /** Every name a top-level definition gives. */
  defined: ReadonlySet<string>;
  /** Names bound once, by `const`, to a literal value. */
  literals: ReadonlySet<string>;
  /** Keys it stores functions under (storedFunctions). */
  keys: ReadonlySet<string>;
}

/**
 * Whether the code that runs when a module loads does anything beyond
 * building values. It doesn't when every call is to one of its live
 * definitions (their bodies are part of that code), to a relative or
 * `@standup/…` import (read where it is defined, or not at all, as for an
 * entry), or to a builtin that builds values: a PURE_GLOBALS constructor, a
 * PURE_MODULES function, or a PURE_CALLS method of a value or of a
 * PURE_NAMESPACES namespace. A function it only stores (an object's method or
 * property, an assignment) runs when called, which is a call the rest of the
 * code makes; one the language calls on its own (a getter, `toString`, an
 * iterator) is read as running now. A computed callee (`x[k]()`) acts.
 */
function acts(tokens: Token[], runs: (k: number) => boolean, parent: readonly number[], stored: ReadonlyMap<number, number>, names: Bindings): boolean {
  const { own, bound, declared } = names;
  const standup = (name: string) => /^\.{1,2}\/|^@standup\//.test(bound.get(name)?.spec ?? "");
  // A builtin's name used other than to call it or read off it (`const { x: Number } = …`, `[Number] = …`) may be anything.
  const shadowed = new Set([...declared].filter((name) => PURE_GLOBALS.has(name) || PURE_NAMESPACES.has(name)));
  tokens.forEach((t, k) => {
    if (t.kind !== "id" || !(PURE_GLOBALS.has(t.value) || PURE_NAMESPACES.has(t.value))) return;
    if (tokens[k - 1]?.value === "." || tokens[k - 1]?.value === "?.") return;
    // Inside a pattern or a parameter list: `[Number] = …`, `{ a: Number } = …`, `(Number) => …`, `function f(Number) {`.
    const p = parent[k]!;
    if (p < 0) return;
    const after = tokens[closing(tokens, p) + 1]?.value;
    const params = tokens[p]!.value === "(" && (after === "=>" || (after === "{" && (tokens[p - 2]?.value === "function" || tokens[p - 1]?.value === "function")));
    if (params || (after === "=" && tokens[closing(tokens, p) + 2]?.value !== "=")) shadowed.add(t.value);
  });
  const starts = [...stored.keys()];
  // What a call is handed that it may run: a function it stores, or any name but a literal's, a builtin's or the
  // process's data (`process.env`) — a definition, an import, a binding or a parameter may hold code.
  const handsCode = (open: number): boolean => {
    const close = closing(tokens, open);
    if (close < 0) return true;
    if (starts.some((s) => s > open && s < close)) return true;
    for (let j = open + 1; j < close; j++) {
      const u = tokens[j]!;
      if (u.kind !== "id" || tokens[j - 1]?.value === "." || tokens[j - 1]?.value === "?.") continue;
      // Inside an argument's own parentheses (an inline function's parameters, a call): read where it runs.
      let p = parent[j]!;
      while (p > open && tokens[p]!.value !== "(") p = parent[p]!;
      if (p > open || tokens[j + 1]?.value === "(") continue;
      if (names.literals.has(u.value) || u.value === "process" || ((PURE_GLOBALS.has(u.value) || PURE_NAMESPACES.has(u.value)) && !shadowed.has(u.value))) continue;
      if (["true", "false", "null", "undefined", "this", "new", "typeof", "void", "await", "as", "satisfies", "const", "of", "in"].includes(u.value)) continue;
      return true;
    }
    return false;
  };
  for (let k = 0; k < tokens.length; k++) {
    if (!runs(k)) continue;
    const skip = stored.get(k);
    if (skip !== undefined) {
      k = skip;
      continue;
    }
    const t = tokens[k]!;
    const next = tokens[k + 1];
    // A key the language calls on its own holding a function by name (`{ toString: go }`, `{ then }`, `{ [Symbol.iterator]: g }`).
    const inObject = parent[k]! >= 0 && tokens[parent[k]!]!.value === "{";    if (inObject && t.value === ":" && (IMPLICIT_KEYS.has(tokens[k - 1]?.value.replace(/^["']|["']$/g, "") ?? "") || tokens[k - 1]?.value === "]") && next?.kind === "id") return true;
    if (inObject && t.kind === "id" && IMPLICIT_KEYS.has(t.value) && ["{", ","].includes(tokens[k - 1]?.value ?? "") && [",", "}"].includes(next?.value ?? "")) return true;
    const open = next?.value === "(" ? k + 1 : next?.value === "?." && tokens[k + 2]?.value === "(" ? k + 2 : -1;
    const called = open >= 0 || next?.kind === "tpl" || tokens[k - 1]?.value === "new";
    if (!called) continue;
    if (t.kind === "id") {
      if (PAREN_KEYWORDS.has(t.value) || tokens[k - 1]?.value === "function") continue;
      // A method written out in an object or class (`run() { … }`), not a call; a body stored this way is in `stored`.
      if (methodBody(tokens, k, parent) >= 0) continue;
      // A callback taker, or Standup's code read elsewhere, may run what it is handed now (`[0].map(go)`, `use({ run() {…} })`).
      // Its own definitions' bodies are part of this code, so what they do with it is read here.
      const handed = open >= 0 && handsCode(open);
      // After `.` (not a spread's `...`) or `?.`.
      const member = (tokens[k - 1]?.value === "." && tokens[k - 2]?.value !== ".") || tokens[k - 1]?.value === "?.";
      if (member) {
        const ns = tokens[k - 2]?.kind === "id" && bound.has(tokens[k - 2]!.value) && standup(tokens[k - 2]!.value);
        if (ns) {
          if (handed) return true;
          continue;
        }
        // A key it stores a function under (`{ push: execSync }` … `x.push()`) runs that function, whatever its name.
        if (names.keys.has(t.value)) return true;
        if (!PURE_CALLS.has(t.value) || !builtValue(tokens, k - 2, parent, names, shadowed, standup)) return true;
        if (handed && CALLBACK_TAKERS.has(t.value)) return true;
        continue;
      }
      if (own.has(t.value) && !bound.has(t.value)) continue;
      if (bound.has(t.value) && standup(t.value)) {
        if (handed) return true;
        continue;
      }
      if (bound.has(t.value)) {
        const b = bound.get(t.value)!;
        if (PURE_MODULES.test(b.spec) && b.name === t.value && PURE_CALLS.has(t.value)) continue;
        return true;
      }
      if (PURE_GLOBALS.has(t.value) && !shadowed.has(t.value)) continue;
      return true;
    }
    // `(…)(…)`: an inline function called on the spot is read here; any other computed callee may be anything.
    if (t.value === ")" && open >= 0) {
      const opener = openerOf(tokens, parent, k);
      const first = tokens[opener + 1]?.value;
      const grouping = opener >= 0 && !(tokens[opener - 1]?.kind === "id" || [")", "]"].includes(tokens[opener - 1]?.value ?? ""));
      if (grouping && (first === "function" || first === "async" || tokens.slice(opener + 1, k).some((u) => u.value === "=>" && u.depth === t.depth + 1))) {
        if (handsCode(open)) return true;
        continue;
      }
      return true;
    }
    if (t.value === "]" || t.kind === "str" || t.kind === "tpl" || t.value === ")") return true;
  }
  return false;
}

/**
 * Whether `name` at `k` is a parameter of a function around it (`(re) => re.x`,
 * `function f({ re }) { re.x }`): it holds what a caller hands it.
 */
function parameterOf(tokens: Token[], parent: readonly number[], k: number, name: string): boolean {
  const names = (from: number, to: number) => tokens.slice(from, to + 1).some((u) => u.kind === "id" && u.value === name);
  const params = (arrow: number): boolean => {
    const before = tokens[arrow - 1];
    if (!before) return false;
    if (before.value === ")") return names(openerOf(tokens, parent, arrow - 1), arrow - 1);
    return before.kind === "id" && before.value === name;
  };
  // An arrow whose expression body holds it: `=>` earlier at its own depth.
  for (let j = k - 1; j >= 0 && tokens[j]!.depth >= tokens[k]!.depth; j--) {
    const u = tokens[j]!;
    if (u.depth !== tokens[k]!.depth) continue;
    if (u.value === "=>") {
      if (params(j)) return true;
      break;
    }
    if (u.value === "," || u.value === ";") break;
  }
  for (let p = parent[k]!; p >= 0; p = parent[p]!) {
    if (tokens[p - 1]?.value === "=>" && params(p - 1)) return true;
    if (tokens[p]!.value !== "{") continue;
    // A function's body: `) {`, or `): T {` past a return type.
    let close = p - 1;
    if (tokens[close]?.value !== ")") {
      while (close > p - 32 && close > 0 && !(tokens[close]!.value === ")" && tokens[close]!.depth === tokens[p]!.depth && tokens[close + 1]?.value === ":")) close--;
    }
    if (tokens[close]?.value === ")" && names(openerOf(tokens, parent, close), close)) return true;
  }
  return false;
}

/** Methods and functions that call what they are handed (`map(f)`, `replace(re, f)`, `JSON.parse(s, f)`). */
const CALLBACK_TAKERS = new Set("map filter flatMap reduce reduceRight sort find findIndex findLast findLastIndex some every forEach replace replaceAll from parse then catch finally apply call bind".split(" "));

/** The bracket a closing token at `k` closes. */
function openerOf(tokens: Token[], parent: readonly number[], k: number): number {
  const before = tokens[k - 1];
  return before && Object.hasOwn(OPEN, before.value) && closing(tokens, k - 1) === k ? k - 1 : parent[k - 1]!;
}

/**
 * Whether the receiver ending at `r` of a method call is something whose
 * PURE_CALLS methods are the builtins: an array literal, a string, a number,
 * a regex, a call's result, a builtin namespace (`Object`, `JSON`, `path`)
 * the module doesn't rebind, or a namespace it imports from Standup's code or
 * a PURE_MODULES module. A name it binds itself may hold anything.
 */
function builtValue(tokens: Token[], r: number, parent: readonly number[], { bound, declared, defined, literals }: Bindings, shadowed: ReadonlySet<string>, standup: (name: string) => boolean): boolean {
  const t = tokens[r];
  if (!t) return false;
  if (t.kind === "str" || t.kind === "tpl" || t.kind === "num" || t.kind === "regex") return true;
  if (t.kind === "id") {
    // The name a member chain (`env.HOME.trim()`) starts from.
    let root = r;
    while ((tokens[root - 1]?.value === "." || tokens[root - 1]?.value === "?.") && tokens[root - 2]?.kind === "id" && tokens[root - 3]?.value !== ".") root -= 2;
    if (root !== r && (tokens[root - 1]?.value === "." || tokens[root - 1]?.value === "?.")) return false;
    const name = tokens[root]!.value;
    if (root === r && bound.has(name)) return standup(name) || PURE_MODULES.test(bound.get(name)!.spec);
    if (root === r && PURE_NAMESPACES.has(name)) return !shadowed.has(name);
    if (root === r && literals.has(name)) return true;
    if (parameterOf(tokens, parent, root, name)) return true;
    // A parameter or the environment's data, not an object this module (or an import, or a global it can write) gave methods.
    // The process's own data (`process.env.HOME.trim()`); any other global (`Bun.redis`) may be a client that acts.
    return name === "process" && !bound.has(name) && !declared.has(name) && !defined.has(name);
  }
  if (t.value === "]" || t.value === ")") {
    const opener = openerOf(tokens, parent, r);
    const before = tokens[opener - 1];
    const follows = !!before && (before.kind === "id" || before.kind === "str" || before.kind === "tpl" || [")", "]", "."].includes(before.value)) && !PAREN_KEYWORDS.has(before.value);
    // `[…]` built here, not `x[i]`; `f(…)`'s result, or a group of literals (`("a " + "b")`), not `(x)`.
    if (t.value === "]") return !follows;
    return follows || tokens.slice(opener + 1, r).every((u) => u.kind !== "id");
  }
  return false;
}
