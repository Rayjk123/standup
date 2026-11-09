/*
 * What of a script entry its own command-line flags skip. A script that reads
 * its flags as `const args = process.argv.slice(2)` in one top-level function
 * and tests them only as `args.includes("--flag")` decides, for a run whose
 * arguments are known, which of its `if` statements run: an `if` whose test
 * is false never runs its body, one that is true and ends its block with
 * `return;` ends the function there. Another top-level function the flag
 * function calls exactly once with an object literal of those flags
 * (`run({ hooks: !steeringOnly })`) decides its own `if`s on that object's
 * properties.
 *
 * Only that shape is read; anything else returns null and the caller reads
 * the entry whole. The reading trusts that the arguments and the builtins it
 * calls are the ones the run starts with, so it refuses code that runs and
 * could change them: any other mention of `argv`, `process` or `Bun` used
 * other than as a member read, identifier escapes, reflection and prototype
 * names, computed member writes, computed keys, string evaluation, dynamic
 * imports, relative imports (modules the floor would read as part of this
 * run), and builtin modules beyond the file and path ones. Nor may the code
 * that runs start the entry again with other arguments (selfRunAt).
 */

import { ambiguousSlash, closing, moduleView, templateParts, tokenize, type ModuleView, type Token } from "./live-code.js";

/** A value the reading knows: a boolean, undefined, or `UNKNOWN`. */
type Value = boolean | undefined | typeof UNKNOWN;
const UNKNOWN = Symbol("unknown");

/** Line and paragraph separators, which JavaScript reads as line breaks and the tokenizer as spaces. */
const LINE_SEPARATORS = String.fromCharCode(0x2028, 0x2029);

/** Names that reach reflection, prototypes, globals or string evaluation; `this` is the global object in a sloppy-mode function. */
const REFUSED_NAMES = new Set([
  "prototype", "__proto__", "constructor", "defineProperty", "defineProperties", "setPrototypeOf", "getPrototypeOf", "assign",
  "getOwnPropertyDescriptor", "getOwnPropertyDescriptors", "this", "__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__",
  "Reflect", "Proxy", "Symbol", "globalThis", "global", "self", "window", "eval", "Function", "require", "module", "exports",
  "arguments", "with", "setTimeout", "setInterval", "setImmediate", "queueMicrotask", "plugin",
]);

/** Builtin modules the entry may import: none of them can change the arguments or evaluate text. */
const ALLOWED_BUILTINS = new Set(["fs", "node:fs", "fs/promises", "node:fs/promises", "os", "node:os", "path", "node:path", "child_process", "node:child_process", "url", "node:url", "crypto", "node:crypto"]);

/** Specifiers that name a builtin module of Node or Bun. */
const BUILTIN_SPEC = /^(?:node:|bun(?::|$))|^(?:assert|async_hooks|buffer|child_process|cluster|console|constants|crypto|dgram|diagnostics_channel|dns|domain|events|fs|http|http2|https|inspector|module|net|os|path|perf_hooks|process|punycode|querystring|readline|repl|stream|string_decoder|sys|timers|tls|trace_events|tty|url|util|v8|vm|wasi|worker_threads|zlib)(?:\/|$)/;

/** Punctuation the tokenizer emits for ASCII operators; anything else (`\`, a non-ASCII character) is refused. */
const PLAIN_PUNCT = /^(?:[(){}[\];,.<>=!+\-*/%&|^~?:@#]|=>|\?\.)$/;

/** Words before `[` that start an array literal rather than index a value. */
const ARRAY_AFTER = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await", "export", "default", "extends", "const", "let", "var"]);

interface Fn {
  name: string;
  /** The `(` of its parameters. */
  open: number;
  /** The `{` and `}` of its body. */
  body: number;
  end: number;
}

/** Character ranges of the text that don't run. */
type Ranges = Array<[number, number]>;

/** The text of a string token with no escapes, else null. */
function plainString(t: Token | undefined): string | null {
  return t?.kind === "str" && !t.value.includes("\\") ? t.value.slice(1, -1) : null;
}

/** Whether `a` and `b` are written with nothing between them. */
function adjacent(a: Token | undefined, b: Token | undefined): boolean {
  return !!a && !!b && a.end === b.start;
}

/** The operator starting at token `k` (`===`, `!==`, `||`, `&&`, `??`, or the token itself) and how many tokens it spans. */
function operatorAt(tokens: readonly Token[], k: number): { op: string; width: number } {
  const t = tokens[k];
  if (!t || t.kind !== "punct") return { op: t?.value ?? "", width: 1 };
  for (const op of ["===", "!==", "||", "&&", "??"]) {
    let ok = true;
    for (let i = 0; i < op.length; i++) {
      const u = tokens[k + i];
      if (!u || u.value !== op[i] || (i > 0 && !adjacent(tokens[k + i - 1], u))) ok = false;
    }
    // `||=`, `&&=`, `??=` assign.
    if (ok && !(tokens[k + op.length]?.value === "=" && adjacent(tokens[k + op.length - 1], tokens[k + op.length]))) return { op, width: op.length };
  }
  return { op: t.value, width: 1 };
}

/** The top-level function declarations with a body this reading can find, by name; null when two share a name. */
function functions(tokens: Token[]): Map<string, Fn> | null {
  const out = new Map<string, Fn>();
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k]!;
    if (t.kind !== "id" || t.value !== "function" || t.depth !== 0) continue;
    const name = tokens[k + 1];
    if (name?.kind !== "id") continue;
    if (out.has(name.value)) return null;
    const open = k + 2;
    if (tokens[open]?.value !== "(") continue;
    const close = closing(tokens, open);
    if (close < 0) return null;
    let body = close + 1;
    if (tokens[body]?.value === ":" && tokens[body + 1]?.kind === "id") body += 2;
    // A return type other than one name: not a function this reading prunes, though its name still counts where it is used.
    if (tokens[body]?.value !== "{") continue;
    const end = closing(tokens, body);
    if (end < 0) return null;
    out.set(name.value, { name: name.value, open, body, end });
  }
  return out;
}

/** Whether token `k` starts a statement in the block it sits in. */
function statementStart(tokens: readonly Token[], k: number): boolean {
  const prev = tokens[k - 1]?.value;
  return prev === "{" || prev === ";" || prev === "}";
}

interface Scope {
  /** The flags' values: `const name = args.includes("--x")`. */
  flags: Map<string, boolean>;
  /** The arguments' binding, read only as `args.includes("…")`. */
  args: string | null;
  argv: readonly string[];
  /** A parameter read only as `param.prop`, and the properties its one call passes. */
  param: string | null;
  props: Map<string, Value>;
}

/** The value of the expression in tokens `from`…`to` (exclusive), or UNKNOWN when any part of it isn't one the reading knows. */
function evaluate(tokens: Token[], from: number, to: number, scope: Scope): Value {
  let k = from;
  const peek = () => (k < to ? operatorAt(tokens, k) : { op: "", width: 0 });
  const primary = (): Value => {
    const t = tokens[k];
    if (!t || k >= to) return UNKNOWN;
    if (t.value === "(") {
      const close = closing(tokens, k);
      if (close < 0 || close >= to) return UNKNOWN;
      const v = evaluate(tokens, k + 1, close, scope);
      k = close + 1;
      return v;
    }
    if (t.kind !== "id" || tokens[k - 1]?.value === "." || tokens[k - 1]?.value === "?.") return UNKNOWN;
    const member = tokens[k + 1]?.value === ".";
    // `undefined` is a name a declaration can shadow; `true` and `false` are keywords.
    if (!member && (t.value === "true" || t.value === "false")) {
      k++;
      return t.value === "true";
    }
    if (!member && scope.flags.has(t.value)) {
      k++;
      return scope.flags.get(t.value)!;
    }
    if (t.value === scope.args && member && tokens[k + 2]?.value === "includes" && tokens[k + 3]?.value === "(" && tokens[k + 5]?.value === ")") {
      const flag = plainString(tokens[k + 4]);
      if (flag === null || k + 6 > to) return UNKNOWN;
      k += 6;
      return scope.argv.includes(flag);
    }
    if (t.value === scope.param && member && tokens[k + 2]?.kind === "id" && k + 3 <= to && tokens[k + 3]?.value !== "." && tokens[k + 3]?.value !== "(") {
      const prop = tokens[k + 2]!.value;
      k += 3;
      // A property the literal doesn't set is undefined, unless every object inherits it (`toString`).
      return scope.props.has(prop) ? scope.props.get(prop) : prop in Object.prototype ? UNKNOWN : undefined;
    }
    return UNKNOWN;
  };
  const unary = (): Value => {
    if (peek().op === "!") {
      k++;
      const v = unary();
      return v === UNKNOWN ? UNKNOWN : !v;
    }
    return primary();
  };
  const compare = (): Value => {
    const left = unary();
    const { op, width } = peek();
    if (op !== "===" && op !== "!==") return left;
    k += width;
    const right = unary();
    if (left === UNKNOWN || right === UNKNOWN) return UNKNOWN;
    return op === "===" ? left === right : left !== right;
  };
  const and = (): Value => {
    let v = compare();
    while (peek().op === "&&") {
      k += 2;
      const r = compare();
      v = v === UNKNOWN ? UNKNOWN : !v ? v : r;
    }
    return v;
  };
  const or = (): Value => {
    let v = and();
    while (peek().op === "||") {
      k += 2;
      const r = and();
      v = v === UNKNOWN ? UNKNOWN : v ? v : r;
    }
    return v;
  };
  const v = or();
  return k === to ? v : UNKNOWN;
}

/** The index of the `;` ending the statement that starts at `k`, written on one line at its own depth; -1 otherwise. */
function simpleStatementEnd(tokens: readonly Token[], k: number): number {
  const depth = tokens[k]!.depth;
  for (let j = k; j < tokens.length; j++) {
    const t = tokens[j]!;
    if (t.depth < depth) return -1;
    if (t.depth === depth && j > k && t.nl) return -1;
    if (t.depth === depth && t.value === ";") return j;
    if (t.depth === depth && t.value === "{") return -1;
  }
  return -1;
}

/** Whether character offset `at` lies inside one of `ranges`. */
function inRanges(ranges: Ranges, at: number): boolean {
  return ranges.some(([a, b]) => at >= a && at < b);
}

/**
 * Prunes the `if` statements of `fn` whose tests `scope` decides: a false one
 * (with no `else`) is dead whole; a true one at the body's top level whose
 * block ends in `return;` leaves the rest of the body dead. Adds the dead
 * character ranges to `dead`; false when the body can't be read this way.
 */
function prune(tokens: Token[], fn: Fn, scope: Scope, dead: Ranges): boolean {
  const top = tokens[fn.body]!.depth + 1;
  for (let k = fn.body + 1; k < fn.end; k++) {
    const t = tokens[k]!;
    if (inRanges(dead, t.start)) continue;
    if (t.kind !== "id" || t.value !== "if" || tokens[k + 1]?.value !== "(" || !statementStart(tokens, k)) continue;
    const close = closing(tokens, k + 1);
    if (close < 0 || close >= fn.end) return false;
    const value = evaluate(tokens, k + 2, close, scope);
    if (value === UNKNOWN) continue;
    const first = close + 1;
    const block = tokens[first]?.value === "{";
    const last = block ? closing(tokens, first) : simpleStatementEnd(tokens, first);
    if (last < 0 || last >= fn.end) continue;
    if (tokens[last + 1]?.value === "else") continue;
    if (!value) {
      dead.push([t.start, tokens[last]!.end]);
      continue;
    }
    const returns = block && tokens[last - 1]?.value === ";" && tokens[last - 2]?.value === "return" && statementStart(tokens, last - 2) && tokens[last - 2]!.depth === tokens[first]!.depth + 1;
    if (t.depth === top && returns) {
      if (last + 1 < fn.end) dead.push([tokens[last + 1]!.start, tokens[fn.end]!.start]);
      return true;
    }
  }
  return true;
}

/** The names a `const`/`let`/`var` at `k` may bind: every identifier before its `=`, `of` or `in` (keys and types included). */
function declared(tokens: readonly Token[], k: number, end: number): string[] {
  const depth = tokens[k]!.depth;
  const out: string[] = [];
  for (let j = k + 1; j < end; j++) {
    const u = tokens[j]!;
    if (u.depth === depth && (u.value === "=" || u.value === "of" || u.value === "in" || u.value === ";")) break;
    if (u.kind === "id") out.push(u.value);
  }
  return out;
}

/** Whether a function body defines no functions or classes and, apart from the declarations at `own`, binds none of `names`. */
function plainBody(tokens: readonly Token[], fn: Fn, names: ReadonlySet<string>, own: ReadonlySet<number>): boolean {
  for (let k = fn.body + 1; k < fn.end; k++) {
    const t = tokens[k]!;
    if (t.value === "=>" || (t.kind === "id" && ["function", "class", "catch"].includes(t.value))) return false;
    if (!own.has(k) && t.kind === "id" && ["const", "let", "var"].includes(t.value) && declared(tokens, k, fn.end).some((n) => names.has(n))) return false;
  }
  return true;
}

/**
 * The index of the first token of `tokens` (a template's when one of its
 * `${…}` parts is the one) whose code could change the arguments or the
 * builtins the reading trusts; -1 when there is none.
 */
export function unsafeAt(tokens: Token[], site: number | null): number {
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k]!;
    const prev = tokens[k - 1];
    const next = tokens[k + 1];
    if (t.kind === "punct" && !PLAIN_PUNCT.test(t.value)) return k;
    if (t.kind === "tpl") {
      const parts = templateParts(t.value);
      if (!parts || parts.some((p) => unsafeAt(p, null) >= 0)) return k;
      continue;
    }
    if (t.kind === "str" && /^["'](?:__proto__|prototype|constructor|includes|slice)["']$/.test(t.value)) return k;
    // A TypeScript index signature (`[key: string]: T`), which is erased.
    if (t.value === "[" && (prev?.value === "{" || prev?.value === ";" || prev?.value === ",") && next?.kind === "id" && tokens[k + 2]?.value === ":") continue;
    if (t.value === "[") {
      const close = closing(tokens, k);
      const member = prev !== undefined && ((prev.kind === "id" && !ARRAY_AFTER.has(prev.value)) || prev.value === ")" || prev.value === "]" || prev.value === "?.");
      // A computed key in an object, a class or a destructuring pattern (`{ [k]: v }`).
      if (!member && (prev?.value === "{" || prev?.value === ",") && close > 0 && tokens[close + 1]?.value === ":") return k;
      if (member && close !== k + 1) {
        const index = tokens[k + 1]!;
        if (close !== k + 2 || (index.kind !== "num" && index.kind !== "str")) return k;
        // Written through: `x[0] = v`, `x["a"] += v`.
        const after = tokens[close + 1];
        if (after?.value === "=" && tokens[close + 2]?.value !== "=") return k;
        if (after && after.value !== "=" && ["+", "-", "*", "/", "%", "&", "|", "^", "<", ">", "?"].includes(after.value) && tokens[close + 2]?.value === "=") return k;
      }
    }
    if (t.kind !== "id") continue;
    // A `__` name may be one of the legacy accessors (`__lookupGetter__`, `__defineGetter__`), which reach and rewrite prototypes.
    if (REFUSED_NAMES.has(t.value) || t.value.startsWith("__")) return k;
    if (t.value === "argv" && k !== site) return k;
    if (t.value === "import" && next?.value === "(") return k;
    const member = prev?.value === "." || prev?.value === "?.";
    if ((t.value === "includes" || t.value === "slice") && (!member || next?.value !== "(")) return k;
    if (t.value === "process" && !member && !(next?.value === "." && (tokens[k + 2]?.value === "env" || k + 2 === site))) return k;
    if (t.value === "Bun" && !member) {
      if (next?.value === "." && tokens[k + 2]?.kind === "id") continue;
      // `(Bun as unknown as { TOML: … }).TOML`
      if (prev?.value === "(" && next?.value === "as") {
        const close = closing(tokens, k - 1);
        if (close > 0 && tokens[close + 1]?.value === "." && tokens[close + 2]?.kind === "id") continue;
      }
      return k;
    }
  }
  return -1;
}

/** Calls that start another process: `child_process`'s, Bun's, execa's and Bun's shell. */
const EXEC_NAMES = new Set(["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork", "execa", "execaSync", "execaCommand", "execaCommandSync", "$"]);

/** Calls whose one command argument is a shell line. */
const SHELL_LINE_CALLS = new Set(["exec", "execSync", "execaCommand", "execaCommandSync", "$"]);

/** A program name that runs a script it is handed: a JavaScript runtime or a shell. */
const RUNTIME_PROGRAM = /^(?:.*\/)?(?:bun|bunx|node|deno|sh|bash|zsh|dash)$/;

/** Whether tokens `from`…`to` (exclusive), template parts included, name where the entry itself lies: `import.meta.path`/`url`/`filename`, `Bun.main`, `__filename`, `argv`. */
function namesSelf(tokens: readonly Token[], from: number, to: number): boolean {
  for (let k = from; k < to; k++) {
    const t = tokens[k]!;
    if (t.kind === "tpl") {
      const parts = templateParts(t.value);
      if (!parts || parts.some((p) => namesSelf(p, 0, p.length))) return true;
      continue;
    }
    if (t.kind !== "id") continue;
    if (t.value === "__filename" || t.value === "argv") return true;
    if (t.value === "meta" && tokens[k - 1]?.value === "." && tokens[k - 2]?.value === "import" && tokens[k + 1]?.value === "." && ["path", "url", "filename", "file"].includes(tokens[k + 2]?.value ?? "")) return true;
    if (t.value === "main" && tokens[k - 1]?.value === "." && tokens[k - 2]?.value === "Bun") return true;
  }
  return false;
}

/** Whether tokens `from`…`to` (exclusive) are anything but literal text: a name, a template with a `${…}` part, an operator joining parts. */
function computed(tokens: readonly Token[], from: number, to: number): boolean {
  for (let k = from; k < to; k++) {
    const t = tokens[k]!;
    if (t.kind === "id") {
      // An object literal's key (`{ stdout: "pipe" }`) is text.
      if (tokens[k + 1]?.value === ":" && (tokens[k - 1]?.value === "{" || tokens[k - 1]?.value === ",")) continue;
      return true;
    }
    if (t.kind === "tpl") {
      const parts = templateParts(t.value);
      if (!parts || parts.length > 0) return true;
      continue;
    }
    if (t.kind === "punct" && !/^[[\]{}(),:]$/.test(t.value)) return true;
  }
  return false;
}

/**
 * The index of the first token of `tokens` where the code may start the entry
 * again with arguments the reading didn't see: a process call that names the
 * entry's own location, runs a runtime or shell (RUNTIME_PROGRAM) on any
 * computed argument, runs a computed program or shell line, or a process
 * function taken other than as a call or a plain import; -1 when there is none.
 */
export function selfRunAt(tokens: Token[]): number {
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k]!;
    if (t.kind === "str" && EXEC_NAMES.has(plainString(t) ?? "")) return k;
    if (t.kind !== "id" || !EXEC_NAMES.has(t.value)) continue;
    const next = tokens[k + 1];
    if (t.value === "$" && next?.kind === "tpl") {
      if (namesSelf(tokens, k + 1, k + 2) || computed(tokens, k + 1, k + 2)) return k;
      continue;
    }
    if (next?.value !== "(") {
      // A `$` that isn't Bun's shell called is some other name.
      if (t.value === "$") continue;
      // `import { spawnSync } from "child_process"`: named in an import list, not renamed.
      let open = k - 1;
      while (open >= 0 && !["{", "}", ";"].includes(tokens[open]!.value)) open--;
      const listed = open >= 0 && tokens[open]!.value === "{" && (next?.value === "," || next?.value === "}");
      if (listed && (tokens[open - 1]?.value === "import" || (tokens[open - 1]?.value === "," && tokens[open - 3]?.value === "import"))) continue;
      return k;
    }
    const close = closing(tokens, k + 1);
    if (close < 0) return k;
    if (namesSelf(tokens, k + 2, close)) return k;
    // The first argument, up to its `,` at the call's own depth.
    const depth = tokens[k + 2]?.depth ?? 0;
    let firstEnd = k + 2;
    while (firstEnd < close && !(tokens[firstEnd]!.depth === depth && tokens[firstEnd]!.value === ",")) firstEnd++;
    if (SHELL_LINE_CALLS.has(t.value)) {
      if (computed(tokens, k + 2, firstEnd)) return k;
      continue;
    }
    // The program: the first argument, or the first element of an argv array (`Bun.spawn([…])`, execa's `[…]`).
    const arrayForm = tokens[k + 2]?.value === "[";
    const progAt = arrayForm ? k + 3 : k + 2;
    const prog = plainString(tokens[progAt]);
    const progEnds = [",", arrayForm ? "]" : ")"].includes(tokens[progAt + 1]?.value ?? "");
    // `fork` runs a module under Node, with whatever it is handed.
    if (t.value === "fork" || prog === null || !progEnds) return k;
    if (RUNTIME_PROGRAM.test(prog) && computed(tokens, k + 2, close)) return k;
  }
  return -1;
}

/** Whether the module imports only builtins that can't change the run, and packages (which the floor reads for no run). */
function plainImports(tokens: readonly Token[]): boolean {
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k]!;
    if (t.kind !== "str") continue;
    const prev = tokens[k - 1]?.value;
    const spec = prev === "from" || (prev === "import" && tokens[k - 2]?.value !== ".") ? plainString(t) : null;
    if (spec === null) {
      if (prev === "from" || prev === "import") return false;
      continue;
    }
    if (/^\.{0,2}\//.test(spec)) return false;
    if (BUILTIN_SPEC.test(spec) && !ALLOWED_BUILTINS.has(spec)) return false;
  }
  return true;
}

/** `text` with the character ranges blanked, line breaks kept. */
function blank(text: string, ranges: Ranges): string {
  // Ranges are UTF-16 offsets, so the text is worked on as code units.
  const units = text.split("");
  for (const [a, b] of ranges) for (let i = a; i < b; i++) if (units[i] !== "\n") units[i] = " ";
  return units.join("");
}

/**
 * The index of the `;` ending the initializer of the `const` at `k`, written
 * on one line, when its value is a primitive built only from literals,
 * environment reads (`process.env.NAME`) and names of `primitives`, with
 * `??`, `||` and `+`; -1 otherwise. Any other name may hold an object, whose
 * `toString` or `valueOf` a template or a `+` calls.
 */
function primitiveInitializerEnd(tokens: readonly Token[], k: number, primitives: ReadonlySet<string>): number {
  const known = (u: Token | undefined) => u?.kind === "id" && (primitives.has(u.value) || ["true", "false", "null"].includes(u.value));
  const member = (u: Token | undefined) => /^(?:\.|\?\.|\(|\[|`)$/.test(u?.value ?? "") || u?.kind === "tpl";
  for (let j = k + 3; j < tokens.length; j++) {
    const u = tokens[j]!;
    if (u.depth === 0 && u.value === ";") return j > k + 3 ? j : -1;
    if (u.depth !== 0 || (j > k + 3 && u.nl)) return -1;
    if (u.kind === "str" || u.kind === "num") continue;
    if (u.kind === "tpl") {
      const parts = templateParts(u.value);
      if (!parts || parts.some((p) => p.length !== 1 || !known(p[0]))) return -1;
    } else if (u.kind === "id" && u.value === "process" && tokens[j + 1]?.value === "." && tokens[j + 2]?.value === "env" && tokens[j + 3]?.value === "." && tokens[j + 4]?.kind === "id" && !member(tokens[j + 5])) {
      j += 4;
    } else if (known(u) && !member(tokens[j + 1])) {
      continue;
    } else if ((u.value === "?" || u.value === "|") && tokens[j + 1]?.value === u.value && adjacent(u, tokens[j + 1]) && tokens[j + 2]?.value !== "=") {
      j++;
    } else if (u.value === "+" && tokens[j + 1]?.value !== "=" && tokens[j + 1]?.value !== "+") {
      continue;
    } else return -1;
  }
  return -1;
}

/**
 * Top-level `const name = …;` statements in `tokens` whose value is a
 * primitive built from literals and environment reads alone, or from
 * constants built that way before it (primitiveInitializerEnd), and whose
 * name nothing else in the code mentions: building the value runs no code,
 * so leaving them out changes nothing that runs.
 */
function unusedConstants(tokens: readonly Token[]): Ranges {
  const mentions = new Map<string, number>();
  const count = (ts: readonly Token[]) => {
    for (const t of ts) {
      if (t.kind === "id") mentions.set(t.value, (mentions.get(t.value) ?? 0) + 1);
      else if (t.kind === "tpl") for (const p of templateParts(t.value) ?? []) count(p);
    }
  };
  count(tokens);
  const primitives = new Set<string>();
  const out: Ranges = [];
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k]!;
    if (t.depth !== 0 || t.value !== "const" || !(k === 0 || statementStart(tokens, k))) continue;
    const name = tokens[k + 1];
    if (name?.kind !== "id" || tokens[k + 2]?.value !== "=") continue;
    const end = primitiveInitializerEnd(tokens, k, primitives);
    if (end < 0) continue;
    primitives.add(name.value);
    if ((mentions.get(name.value) ?? 0) === 1) out.push([t.start, tokens[end]!.end]);
  }
  return out;
}

/**
 * What of the entry `text` runs when it is started with the arguments
 * `argv`, as moduleView reads it; null when its shape isn't the one read
 * here or nothing in it is skipped.
 */
export function argvGatedView(text: string, argv: readonly (string | null)[]): ModuleView | null {
  if (argv.some((a) => a === null)) return null;
  const args = argv as readonly string[];
  if ([...LINE_SEPARATORS].some((c) => text.includes(c)) || text.includes("\\u") || (text.match(/argv/g) ?? []).length !== 1) return null;
  const tokens = tokenize(text);
  // Where a block ends isn't sure when a `/` may be a division or a regex, so neither is what a pruned `if` covers.
  if (!tokens || !plainImports(tokens) || ambiguousSlash(tokens)) return null;
  const site = tokens.findIndex((t) => t.kind === "id" && t.value === "argv");
  // `const args = process.argv.slice(2);`
  const decl = site - 5;
  const shape = ["const", null, "=", "process", ".", "argv", ".", "slice", "(", "2", ")", ";"];
  if (site < 0 || decl < 1 || shape.some((v, i) => (v === null ? tokens[decl + i]?.kind !== "id" : tokens[decl + i]?.value !== v)) || !statementStart(tokens, decl)) return null;
  const fns = functions(tokens);
  if (!fns) return null;
  const main = [...fns.values()].find((f) => decl > f.body && decl < f.end && tokens[decl]!.depth === tokens[f.body]!.depth + 1);
  if (!main) return null;
  const argsName = tokens[decl + 1]!.value;
  const flags = new Map<string, boolean>();
  const own = new Set<number>([decl]);
  for (let k = main.body + 1; k < main.end; k++) {
    const t = tokens[k]!;
    if (t.kind !== "id" || t.value !== argsName || k === decl + 1) continue;
    // Each other use is `args.includes("--x")`.
    if (tokens[k - 1]?.value === "." || tokens[k - 1]?.value === "?." || tokens[k + 1]?.value !== "." || tokens[k + 2]?.value !== "includes" || tokens[k + 3]?.value !== "(" || plainString(tokens[k + 4]) === null || tokens[k + 5]?.value !== ")") return null;
    // `const flag = args.includes("--x");` at the body's top level.
    const c = k - 3;
    if (tokens[c]?.value === "const" && tokens[c + 1]?.kind === "id" && tokens[c + 2]?.value === "=" && tokens[k + 6]?.value === ";" && tokens[c]!.depth === tokens[decl]!.depth && statementStart(tokens, c)) {
      if (flags.has(tokens[c + 1]!.value)) return null;
      flags.set(tokens[c + 1]!.value, args.includes(plainString(tokens[k + 4])!));
      own.add(c);
    }
  }
  if (!plainBody(tokens, main, new Set([argsName, ...flags.keys()]), own)) return null;
  const mainScope: Scope = { flags, args: argsName, argv: args, param: null, props: new Map() };
  const dead: Ranges = [];
  if (!prune(tokens, main, mainScope, dead)) return null;
  // A function the flag function calls exactly once, where the code still runs, with an object literal.
  for (const fn of fns.values()) {
    if (fn === main) continue;
    const param = tokens[fn.open + 1];
    const close = closing(tokens, fn.open);
    if (param?.kind !== "id") continue;
    const tail = tokens.slice(fn.open + 2, close).map((t) => t.value).join(" ");
    if (!/^(?:: [A-Za-z_$][\w$]*)?(?: = \{ \})?$/.test(tail)) continue;
    const uses: number[] = [];
    // The name written in a string, a template or a regex, dead or not, may be a call (a template's `${…}`) or reach one: no single call is sure.
    const word = new RegExp(`(?<![\\w$])${fn.name.replace(/\$/g, "\\$")}(?![\\w$])`);
    let named = false;
    tokens.forEach((t, k) => {
      if (t.kind === "id" && t.value === fn.name && k !== fn.open - 1 && !inRanges(dead, t.start)) uses.push(k);
      else if ((t.kind === "tpl" || t.kind === "str" || t.kind === "regex") && word.test(t.value)) named = true;
    });
    if (named || uses.length !== 1) continue;
    const call = uses[0]!;
    if (call <= main.body || call >= main.end || tokens[call - 1]?.value === "." || tokens[call + 1]?.value !== "(" || tokens[call + 2]?.value !== "{") continue;
    const objEnd = closing(tokens, call + 2);
    if (objEnd < 0 || tokens[objEnd + 1]?.value !== ")") continue;
    const props = new Map<string, Value>();
    let ok = true;
    let start = call + 3;
    const depth = tokens[call + 2]!.depth + 1;
    for (let k = call + 3; k <= objEnd && ok; k++) {
      if (k < objEnd && !(tokens[k]!.depth === depth && tokens[k]!.value === ",")) continue;
      if (k > start) {
        const key = tokens[start]!;
        if (key.kind !== "id" || props.has(key.value)) ok = false;
        else if (k === start + 1) props.set(key.value, flags.has(key.value) ? flags.get(key.value)! : UNKNOWN);
        else if (tokens[start + 1]?.value === ":") props.set(key.value, evaluate(tokens, start + 2, k, mainScope));
        else ok = false;
      }
      start = k + 1;
    }
    if (!ok) continue;
    // The parameter is only read, as `param.prop`, in a test or an argument.
    const name = param.value;
    let reads = true;
    for (let k = fn.body + 1; k < fn.end && reads; k++) {
      const t = tokens[k]!;
      if (t.kind !== "id" || t.value !== name || tokens[k - 1]?.value === "." || tokens[k - 1]?.value === "?.") continue;
      if (tokens[k + 1]?.value !== "." || tokens[k + 2]?.kind !== "id") reads = false;
      else if (![")", ",", ";", "||", "&&", "===", "!=="].includes(operatorAt(tokens, k + 3).op)) reads = false;
    }
    if (!reads || !plainBody(tokens, fn, new Set([name]), new Set())) continue;
    if (!prune(tokens, fn, { flags: new Map(), args: null, argv: args, param: name, props }, dead)) return null;
  }
  if (!dead.length) return null;
  let view = moduleView(blank(text, dead), new Set(), false);
  // Constants only skipped code reads.
  for (let round = 0; view && round < 8; round++) {
    const viewTokens = tokenize(view.text);
    if (!viewTokens) return null;
    const unused = unusedConstants(viewTokens);
    if (!unused.length) break;
    view = moduleView(blank(view.text, unused), new Set(), false);
  }
  if (!view) return null;
  const live = tokenize(view.text);
  if (!live) return null;
  const liveSite = live.findIndex((t) => t.kind === "id" && t.value === "argv");
  if (unsafeAt(live, liveSite < 0 ? null : liveSite) >= 0 || selfRunAt(live) >= 0) return null;
  return view;
}
