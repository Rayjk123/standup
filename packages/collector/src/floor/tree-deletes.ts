import { basename, dirname, normalize } from "path";

/**
 * Where a path a script builds starts: its own dir (`import.meta.dir`,
 * `__dirname`, the dir of `__file__`), the cwd, the temp dir (`tmpdir()`,
 * `$TMPDIR`), or a value the scan can't place.
 */
export type CodePathBase = "dir" | "cwd" | "tmp" | "unknown";

/** The paths the bases stand for where the floor knows them: the script's file, the cwd, the temp dir. */
export interface CodePathBases {
  file: string | null;
  cwd: string | null;
  tmp: string | null;
}

/**
 * A call in code that removes a tree at a path climbing above where the
 * path starts: `text` is the call as written in the skeleton, `base` where
 * the path starts, and `path` the absolute path it removes, or null when
 * the base is one the floor doesn't know.
 */
export interface ClimbingTreeDelete {
  text: string;
  base: CodePathBase;
  path: string | null;
}

/** Marks the start of a base in a path value: MARK, the base's letter, then the path below it. */
const MARK = "\u0003";
const BASES: Record<string, CodePathBase> = { d: "dir", c: "cwd", t: "tmp", u: "unknown" };
const UNKNOWN = `${MARK}u`;

/** Node's file calls that remove a tree when their options say `recursive` (or are a value the scan can't read). */
const NODE_RM = /^(?:rm|rmSync|rmdir|rmdirSync)$/;
/** Calls that always remove a tree (or empty one). */
const TREE_CALL = /^(?:rmtree|rimraf|rimrafSync|emptyDir|emptyDirSync)$/;
/** fs-extra's `remove`, only through a receiver that names fs. */
const FSE_REMOVE = /^(?:remove|removeSync)$/;

/** The text of `s` from `open` (an opening bracket) to its matching close, exclusive, or null. */
function balancedEnd(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i]!;
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) return i;
      if (depth < 0) return -1;
    }
  }
  return -1;
}

/** `s` split at each top-level occurrence of `sep` (a one-char separator). */
function splitTop(s: string, sep: string): string[] {
  const out = [""];
  let depth = 0;
  for (const c of s) {
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    if (c === sep && depth === 0) out.push("");
    else out[out.length - 1] += c;
  }
  return out;
}

/**
 * Reads the calls in code (its skeleton, `literals` its strings) that remove
 * a whole tree at a path that climbs above where it starts: `..` or a dirname
 * past the script's dir, the cwd or the temp dir
 * (`rmSync(join(import.meta.dir, ".."), { recursive: true })`,
 * `shutil.rmtree(os.path.dirname(os.path.dirname(__file__)))`), through names
 * bound once to such a path. A path built on a value the scan can't place
 * counts when the steps after it climb (`join(f(), "..")`); one that only
 * descends from it, or that a value the scan can't place continues, does not.
 */
export function climbingTreeDeletes(skeleton: string, literals: readonly string[], python: boolean, valueWord: string, bases: CodePathBases): ClimbingTreeDelete[] {
  const out: ClimbingTreeDelete[] = [];
  // The script file, as a step below its dir.
  const fileStep = bases.file !== null ? basename(bases.file) : "\u0005";
  const known: Record<CodePathBase, string | null> = { dir: bases.file !== null ? dirname(bases.file) : null, cwd: bases.cwd, tmp: bases.tmp, unknown: null };
  const sk = skeleton;
  const lit = (id: string) => literals[Number(id)] ?? "";
  // The expression a name is bound to, when the code binds it exactly once.
  const bindings = new Map<string, string | null>();
  const bindingOf = (name: string): string | null => {
    if (bindings.has(name)) return bindings.get(name)!;
    const n = name.replace(/\$/g, "\\$");
    const assigned = [...sk.matchAll(new RegExp(String.raw`(?<![\w$.])${n}\s*(?::\s*[\w.$<>\[\]|]+\s*)?(?<![=!<>])=(?![=>])`, "g"))];
    const bound = new RegExp(String.raw`(?:\b(?:const|let|var)\s+|^[ \t]*)${n}\s*(?::\s*[\w.$<>\[\]|]+\s*)?=(?![=>])\s*([^;\n]+)`, "m").exec(sk);
    let value = assigned.length === 1 && bound ? bound[1]!.trim() : null;
    if (value !== null && splitTop(value, ",").length !== 1) value = null;
    bindings.set(name, value);
    return value;
  };
  const evaluate = (expr: string, depth: number): string => {
    let e = expr.trim();
    if (depth > 12 || e === "") return UNKNOWN;
    e = e.replace(/\s+as\s+[\w.$<>\[\]|]+$/, "").replace(/!+$/, "").replace(/^await\s+/, "").trim();
    while (e.startsWith("(") && balancedEnd(e, 0) === e.length - 1) e = e.slice(1, -1).trim();
    const plus = splitTop(e, "+");
    if (plus.length > 1) return plus.map((p) => evaluate(p, depth + 1)).join("");
    if (python) {
      const slash = splitTop(e, "/");
      if (slash.length > 1 && slash.every((p) => p.trim() !== "")) return slash.map((p) => evaluate(p, depth + 1)).join("/");
    }
    const one = /^\u0001(\d+)\u0002$/.exec(e);
    if (one) {
      const text = lit(one[1]!);
      // A template's interpolations: a name is what it is bound to, the temp root the temp dir, anything else a value the scan can't place.
      return text
        .split(valueWord)
        .map((piece) => piece.replace(/\$\{([A-Za-z_$][\w$]*)\}/g, (_m, name: string) => evaluate(name, depth + 1)).replace(/\$\{(?:os\.)?tmpdir\(\)\}/g, `${MARK}t`))
        .join(UNKNOWN);
    }
    if (/^(?:import\s*\.\s*meta\s*\.\s*(?:dir|dirname)|__dirname)$/.test(e)) return `${MARK}d`;
    if (/^(?:import\s*\.\s*meta\s*\.\s*(?:path|filename|url)|__filename|__file__)$/.test(e)) return `${MARK}d/${fileStep}`;
    if (/^(?:process|Bun)\s*\.\s*env\s*(?:\.\s*TMPDIR|\[\s*\u0001\d+\u0002\s*\])$/.test(e)) {
      const key = /\u0001(\d+)\u0002/.exec(e);
      return key === null || lit(key[1]!) === "TMPDIR" ? `${MARK}t` : UNKNOWN;
    }
    if (/^os\s*\.\s*environ\s*\[\s*\u0001\d+\u0002\s*\]$/.test(e)) return lit(/\u0001(\d+)\u0002/.exec(e)![1]!) === "TMPDIR" ? `${MARK}t` : UNKNOWN;
    // pathlib's postfix steps: `.parent`, `.resolve()`/`.absolute()`, and `.joinpath(…)`.
    const parent = python ? /\.\s*parent$/.exec(e) : null;
    if (parent) return `${evaluate(e.slice(0, parent.index), depth + 1)}/..`;
    const same = python ? /\.\s*(?:resolve|absolute|expanduser)\s*\(\s*\)$/.exec(e) : null;
    if (same) return evaluate(e.slice(0, same.index), depth + 1);
    const joinpath = python ? /\.\s*joinpath\s*\(([^()]*)\)$/.exec(e) : null;
    if (joinpath) return [e.slice(0, joinpath.index), ...splitTop(joinpath[1]!, ",")].map((p) => evaluate(p, depth + 1)).join("/");
    if (e.endsWith(")")) {
      let open = -1;
      for (let i = e.length - 1, d = 0; i >= 0; i--) {
        if (e[i] === ")") d++;
        else if (e[i] === "(" && --d === 0) {
          open = i;
          break;
        }
      }
      if (open > 0) {
        const callee = e.slice(0, open).trim();
        const args = e.slice(open + 1, -1).trim();
        const argv = args === "" ? [] : splitTop(args, ",").map((a) => a.trim());
        const name = /(?:^|\.\s*)([A-Za-z_$][\w$]*)$/.exec(callee);
        const receiver = name ? callee.slice(0, callee.length - name[1]!.length) : "";
        // A name at the start or after a receiver (`path.`, `os.path.`, `require("path").`), not a method of a value.
        const plainCall = name !== null && (receiver === "" || /^(?:[A-Za-z_$][\w$]*\s*\.\s*)*(?:require\s*\(\s*\u0001\d+\u0002\s*\)\s*\.\s*)?$/.test(receiver.replace(/\s+/g, " ")));
        if (name && plainCall && !argv.some((a) => a.startsWith("..."))) {
          const fn = name[1]!;
          if (fn === "join") {
            if (!argv.length) return UNKNOWN;
            const parts = argv.map((a) => evaluate(a, depth + 1));
            // Python's join starts over at an absolute part.
            const from = python ? Math.max(0, ...parts.map((p, k) => (p.startsWith("/") || p.startsWith(MARK) ? k : 0))) : 0;
            return parts.slice(from).join("/");
          }
          if (fn === "resolve" && !python) {
            const parts = [`${MARK}c`, ...argv.map((a) => evaluate(a, depth + 1))];
            const from = Math.max(0, ...parts.map((p, k) => (p.startsWith("/") || p.startsWith(MARK) ? k : 0)));
            return parts.slice(from).join("/");
          }
          if (fn === "dirname" && argv.length === 1) return `${evaluate(argv[0]!, depth + 1)}/..`;
          if (/^(?:abspath|normpath|realpath|realpathSync|normalize|Path|PurePath|PosixPath|fileURLToPath|fspath|str|String)$/.test(fn) && argv.length === 1) {
            const v = evaluate(argv[0]!, depth + 1);
            return v.startsWith("/") || v.startsWith(MARK) || !/^(?:abspath|realpath|realpathSync)$/.test(fn) ? v : `${MARK}c/${v}`;
          }
          if (/^(?:cwd|getcwd)$/.test(fn) && argv.length === 0) return `${MARK}c`;
          if (/^(?:tmpdir|gettempdir)$/.test(fn) && argv.length === 0) return `${MARK}t`;
          // `os.getenv("TMPDIR")`, `os.environ.get("TMPDIR")`.
          if ((fn === "getenv" || (fn === "get" && /\benviron\s*\.\s*$/.test(receiver))) && argv.length >= 1) {
            const key = /^\u0001(\d+)\u0002$/.exec(argv[0]!);
            return key && lit(key[1]!) === "TMPDIR" ? `${MARK}t` : UNKNOWN;
          }
        }
      }
      return UNKNOWN;
    }
    if (/^[A-Za-z_$][\w$]*$/.test(e)) {
      const bound = bindingOf(e);
      return bound === null ? UNKNOWN : evaluate(bound, depth + 1);
    }
    return UNKNOWN;
  };
  // Where a path value starts, whether it climbs above there, and the absolute path when the base is known; null when the scan doesn't follow it.
  const placed = (value: string): { base: CodePathBase; climbs: boolean; path: string | null } | null => {
    let v = value;
    // A relative path is under the cwd.
    if (!v.startsWith(MARK) && !v.startsWith("/")) v = `${MARK}c/${v}`;
    if (!v.startsWith(MARK)) return null;
    const base = BASES[v[1]!];
    const rest = v.slice(2);
    if (base === undefined || rest.includes(MARK)) return null;
    // Text added to the base's own name names a sibling of it (`dir + "-old"`).
    const steps = normalize(`./${rest === "" || rest.startsWith("/") ? rest : `/../x${rest}`}`.replace(/\/+/g, "/"));
    const root = known[base];
    return { base, climbs: steps === ".." || steps.startsWith("../"), path: root === null ? null : normalize(`${root}${rest}`) };
  };
  const callRe = /(?<![\w$])([A-Za-z_$][\w$]*)\s*\(/g;
  for (const m of sk.matchAll(callRe)) {
    const fn = m[1]!;
    const before = sk.slice(Math.max(0, m.index - 40), m.index);
    // A method of something else (`list.remove(x)`, `arr.rm(…)`) isn't a file call.
    const receiver = /([A-Za-z_$][\w$]*|\))\s*\.\s*$/.exec(before);
    const always = TREE_CALL.test(fn) || (FSE_REMOVE.test(fn) && !python && receiver !== null && /^(?:fse|fsExtra|fs|extra)$/.test(receiver[1]!));
    const node = !python && NODE_RM.test(fn);
    if (!always && !node) continue;
    // The definition of a function of that name.
    if (/\b(?:function|def)\s+$/.test(before)) continue;
    const open = m.index + m[0].length - 1;
    const close = balancedEnd(sk, open);
    if (close < 0) continue;
    const args = splitTop(sk.slice(open + 1, close), ",");
    const target = args[0]!.trim();
    if (target === "") continue;
    if (node) {
      const opts = args.slice(1).map((a) => a.trim()).filter((a) => a !== "" && !/^(?:\([^()]*\)|[\w$]+)\s*=>/.test(a) && !/^function\b/.test(a));
      // `{ force: true }` removes one file at most; `recursive`, or options the scan can't read, may remove a tree.
      const recursive = opts.some((o) => !/^\{[^{}]*\}$/.test(o) || /\brecursive\b/.test(o) || [...o.matchAll(/\u0001(\d+)\u0002/g)].some((x) => lit(x[1]!) === "recursive"));
      if (!recursive) continue;
    }
    const where = placed(evaluate(target, 0));
    if (where === null) continue;
    if (where.climbs) out.push({ text: sk.slice(m.index, close + 1), base: where.base, path: where.path });
  }
  return out;
}
