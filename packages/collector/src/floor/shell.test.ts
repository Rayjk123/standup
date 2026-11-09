import { describe, expect, test } from "bun:test";
import { literalOf, nestedScripts, parseShell, wordIsQuoted, type Command, type Script, type SimpleCommand } from "./shell.js";

function parse(src: string): Script {
  const r = parseShell(src);
  if (!r.ok) throw new Error(`parse failed: ${r.error}`);
  return r.script;
}

/** Every simple command in source order, including those nested in compound commands (not substitutions). */
function simples(script: Script): SimpleCommand[] {
  const out: SimpleCommand[] = [];
  const visitCommand = (c: Command): void => {
    switch (c.kind) {
      case "simple":
        out.push(c);
        return;
      case "subshell":
      case "group":
        return visit(c.body);
      case "if":
        for (const cl of c.clauses) {
          visit(cl.cond);
          visit(cl.body);
        }
        if (c.elseBody) visit(c.elseBody);
        return;
      case "loop":
        visit(c.cond);
        return visit(c.body);
      case "for":
        return visit(c.body);
      case "case":
        for (const arm of c.arms) visit(arm.body);
        return;
      case "function":
        return visitCommand(c.body);
      default:
        return;
    }
  };
  const visit = (s: Script): void => {
    for (const item of s.items) {
      for (const c of item.node.first.commands) visitCommand(c);
      for (const r of item.node.rest) for (const c of r.pipeline.commands) visitCommand(c);
    }
  };
  visit(script);
  return out;
}

const argv = (c: SimpleCommand) => c.words.map((w) => literalOf(w));

describe("words and quoting", () => {
  test("quotes and escapes are removed and recorded", () => {
    const [c] = simples(parse(`g'i't "pu"sh git\\ push $'\\x67it' ''`));
    expect(argv(c!)).toEqual(["git", "push", "git push", "git", ""]);
    expect(c!.words.map(wordIsQuoted)).toEqual([true, true, true, true, true]);
    const [plain] = simples(parse("git push"));
    expect(plain!.words.map(wordIsQuoted)).toEqual([false, false]);
  });

  test("ANSI-C escapes decode", () => {
    const [c] = simples(parse(String.raw`echo $'a\tb\nA\101\cA'`));
    expect(literalOf(c!.words[1]!)).toBe("a\tb\nAA\x01");
  });

  test("nothing inside single quotes is special, a double quote included", () => {
    const [grep, head] = simples(parse(`grep -n '^ | "' file.txt | head`));
    expect(argv(grep!)).toEqual(["grep", "-n", '^ | "', "file.txt"]);
    expect(argv(head!)).toEqual(["head"]);
    expect(argv(simples(parse(`sed -n 's/"//gp' f`))[0]!)).toEqual(["sed", "-n", 's/"//gp', "f"]);
    expect(argv(simples(parse(`echo '\\' '$x' '\`'`))[0]!)).toEqual(["echo", "\\", "$x", "`"]);
  });

  test("mixed quoting joins into one word", () => {
    expect(argv(simples(parse(`echo 'a"b'"c'd"`))[0]!)).toEqual(["echo", `a"bc'd`]);
    expect(argv(simples(parse(`echo "it's" 'say "hi"'`))[0]!)).toEqual(["echo", "it's", 'say "hi"']);
  });

  test("an escaped double quote stays inside double quotes", () => {
    expect(argv(simples(parse(String.raw`echo "a\"b" "\"" c`))[0]!)).toEqual(["echo", 'a"b', '"', "c"]);
  });

  test("$'…' takes an escaped single quote and a bare double quote", () => {
    expect(argv(simples(parse(String.raw`echo $'a\'b' $'"' c`))[0]!)).toEqual(["echo", "a'b", '"', "c"]);
  });

  test("an escaped double quote inside ${…} and $((…)) doesn't end the quoted text", () => {
    const [c] = simples(parse('echo ${x:-"a\\"b"} "${y:-"\\"}"}" c'));
    expect(c!.words.map((w) => w.raw)).toEqual(["echo", '${x:-"a\\"b"}', '"${y:-"\\"}"}"', "c"]);
    const [a] = simples(parse(String.raw`echo $(( x + "\"" )) c`));
    expect(a!.words[1]!.segments.map((s) => s.kind)).toEqual(["arith"]);
    expect(literalOf(a!.words[2]!)).toBe("c");
  });

  test("text bash and zsh read the same way still parses", () => {
    for (const ok of [
      `(( "$#" > 0 )) && echo y`,
      `echo $(( $(echo 1) + 2 )) $(( a[1] + 1 ))`,
      `echo $((cd x && ls 'a') | cat)`,
      `echo \${x:-"$(cmd "a")"} "\${HOME:-"$(pwd)"}/x" \${x:-$(cat <<E\n}\nE\n)}`,
      `echo "\${x:-'a'}" "\${x:-"it's"}" \${x:-'}'}`,
      `echo \${!x} \${!} \${!prefix*} \${#arr[@]} \${#} \${##} "\${a[$((i + 1))]}"`,
      `echo $[x+1] "$[i+2]"\${x:-$'a\\'b'} $((cd x && ls) | cat)`,
      `echo "\${arr[\${#arr[@]}-1]}" "\${arr[$(( \${#arr[@]} - 1 ))]}" \${a[\${b[0]}]} \${a[\${#a[@]}-1]:-x}`,
    ]) {
      expect({ ok, parsed: parseShell(ok).ok }).toEqual({ ok, parsed: true });
    }
  });

  test("text bash and zsh read differently, or a subscript running a substitution, fails the parse", () => {
    for (const bad of [
      `(( 1 ' )); echo y # ' ))`,
      `(( 1 " )); echo y # " ))`,
      `echo $(( 1 ' )); echo y # ' ))`,
      String.raw`echo $(( x["\")"] )) c`,
      String.raw`echo $(( x["\""] )) c`,
      `echo "\${x:-'}"; echo y; '}"' #'`,
      `echo "\${x[$(echo y)]}" \${#x[\`echo y\`]}`,
    ]) {
      expect({ bad, parsed: parseShell(bad).ok }).toEqual({ bad, parsed: false });
    }
  });

  test("a heredoc or comment in a substitution inside ${…} doesn't end it", () => {
    const [c] = simples(parse(`echo \${x:-"$(cat <<E\n"}\nE\n)"} \${y:-$(echo a # }\n)} z`));
    expect(c!.words.map((w) => nestedScripts(w.segments).length)).toEqual([0, 1, 1, 0]);
    expect(literalOf(c!.words[3]!)).toBe("z");
  });

  test("parameters stay as typed segments, not text", () => {
    const [c] = simples(parse(`echo $X "\${Y:-dflt}" \${!z} \${#w} $1 "$@"`));
    const kinds = c!.words.slice(1).map((w) => w.segments.map((s) => (s.kind === "param" ? `${s.name}${s.op ?? ""}${s.indirect ? "!" : ""}${s.length ? "#" : ""}` : s.kind)));
    expect(kinds).toEqual([["X"], ["Y:-"], ["z!"], ["w#"], ["1"], ["@"]]);
    expect(literalOf(c!.words[1]!)).toBeNull();
  });

  test("zsh's unbraced expansion flags are parameters, not text", () => {
    const [c] = simples(parse(`echo $=x "$~y" a$^z "$+w" "$=" $+`));
    const kinds = c!.words.slice(1).map((w) => w.segments.map((s) => (s.kind === "param" ? `param:${s.name}` : `${s.kind}:${s.kind === "lit" ? s.text : ""}`)));
    // `$=x` splits x into words: it is x, unquoted.
    expect(kinds).toEqual([["param:x"], ["param:~y"], ["lit:a", "param:^z"], ["param:+w"], ["lit:$="], ["lit:$+"]]);
    expect(c!.words.slice(1, 5).map((w) => literalOf(w))).toEqual([null, null, null, null]);
  });

  test("zsh's unbraced subscript `$name[…]` is part of the parameter, not text after it", () => {
    const [c] = simples(parse(`echo "$x[5,-1]" $a[@] "$y[a[1]]b" '$q[1]' "$z[1"`));
    const kinds = c!.words.slice(1).map((w) => w.segments.map((s) => (s.kind === "param" ? `param:${s.name}` : `${s.kind}:${s.kind === "lit" ? s.text : ""}`)));
    expect(kinds).toEqual([["param:x[5,-1]"], ["param:a[@]"], ["param:y[", "lit:[a[1]]b"], ["lit:$q[1]"], ["param:z[", "lit:[1"]]);
    expect(c!.words.slice(1).map((w) => literalOf(w))).toEqual([null, null, null, "$q[1]", null]);
  });

  test("tilde only at the start of a word or assignment value", () => {
    const [c] = simples(parse("X=~/a ls ~ ~/b a~ '~'"));
    expect(c!.assignments[0]!.value.segments[0]).toEqual({ kind: "tilde", user: "" });
    expect(c!.words[1]!.segments[0]!.kind).toBe("tilde");
    expect(c!.words[2]!.segments[0]!.kind).toBe("tilde");
    expect(literalOf(c!.words[3]!)).toBe("a~");
    expect(literalOf(c!.words[4]!)).toBe("~");
  });

  test("line continuations join words", () => {
    const [c] = simples(parse("git \\\n  push \\\n origin"));
    expect(argv(c!)).toEqual(["git", "push", "origin"]);
  });
});

describe("structure", () => {
  test("operators split commands", () => {
    const s = parse("a; b && c || d | e |& f & g\nh");
    expect(simples(s).map((c) => literalOf(c.words[0]!))).toEqual(["a", "b", "c", "d", "e", "f", "g", "h"]);
    expect(s.items.map((i) => i.background)).toEqual([false, true, false, false]);
  });

  test("assignments before the program, and array assignments", () => {
    const [c] = simples(parse("A=1 B+=2 C=(x y) cmd A=3"));
    expect(c!.assignments.map((a) => a.name)).toEqual(["A", "B", "C"]);
    expect(c!.assignments[1]!.append).toBe(true);
    expect(c!.assignments[2]!.array?.map((w) => literalOf(w))).toEqual(["x", "y"]);
    expect(argv(c!)).toEqual(["cmd", "A=3"]);
  });

  test("array element assignments keep their subscript", () => {
    const [c] = simples(parse("n[ki]=$((n[ki] + 1)) m[a[$i]]+='x y' cmd"));
    expect(c!.assignments.map((a) => [a.name, a.append, a.value.raw])).toEqual([
      ["n", false, "$((n[ki] + 1))"],
      ["m", true, "'x y'"],
    ]);
    expect(c!.assignments[0]!.index).toEqual([{ kind: "lit", text: "ki", quoted: false }]);
    expect(c!.assignments[1]!.index?.map((s) => s.kind)).toEqual(["lit", "param", "lit"]);
    expect(argv(c!)).toEqual(["cmd"]);
    expect(nestedScripts(simples(parse("n[$(id)]=1"))[0]!.assignments[0]!.index!)).toHaveLength(1);
    expect(argv(simples(parse("n[i]x=1"))[0]!)).toEqual(["n[i]x=1"]);
    expect(argv(simples(parse("n[i]"))[0]!)).toEqual(["n[i]"]);
  });

  test("compound commands", () => {
    const src = [
      "if [ -f x ]; then a; elif b; then c; else d; fi",
      "while read l; do e; done < f",
      "until false; do g; done",
      "for i in 1 2; do h; done",
      "for ((i=0;i<3;i++)); do j; done",
      "case $1 in a|b) k;; *) l ;; esac",
      "{ m; n; } > out",
      "(o && p)",
      "[[ $x =~ ^(a|b)$ && -n $y ]] && q",
      "(( x > 1 )) && r",
      "f() { s; }",
      "function g { t; }",
      "! u",
      "time -p v",
    ].join("\n");
    expect(simples(parse(src)).map((c) => literalOf(c.words[0]!))).toEqual([
      "[", "a", "b", "c", "d", "read", "e", "false", "g", "h", "j", "k", "l", "m", "n", "o", "p", "q", "r", "s", "t", "u", "v",
    ]);
  });

  test("redirections, fds and heredocs", () => {
    const [c] = simples(parse("cmd 2>&1 >out 2>>err &>all <in <<<'here' 3<>rw >|clob"));
    expect(c!.redirects.map((r) => `${r.fd ?? ""}${r.op}${literalOf(r.target)}`)).toEqual([
      "2>&1", ">out", "2>>err", "&>all", "<in", "<<<here", "3<>rw", ">|clob",
    ]);
    const s = parse("cat <<EOF | sh\ngit push\n$(date)\nEOF\necho after\ncat <<-'Q'\n\tliteral $x\n\tQ");
    const all = simples(s);
    expect(all.map((x) => literalOf(x.words[0]!))).toEqual(["cat", "sh", "echo", "cat"]);
    const doc = all[0]!.redirects[0]!.heredoc!;
    expect(doc.body).toBe("git push\n$(date)\n");
    expect(doc.quoted).toBe(false);
    expect(nestedScripts(doc.bodyWord!.segments)).toHaveLength(1);
    const quoted = all[3]!.redirects[0]!.heredoc!;
    expect(quoted).toMatchObject({ quoted: true, stripTabs: true, body: "literal $x\n", bodyWord: null });
  });

  test("comments are skipped but # inside a word is kept", () => {
    expect(simples(parse("echo a#b # comment\nls")).map(argv)).toEqual([["echo", "a#b"], ["ls"]]);
  });
});

describe("substitutions", () => {
  test("command, backtick and process substitutions are parsed recursively", () => {
    const [c] = simples(parse('echo $(git push) "`docker push img`" <(curl x) "${A:-$(rm -rf /)}" $((1 + $(date +%s)))'));
    const nested = c!.words.slice(1).flatMap((w) => nestedScripts(w.segments));
    expect(nested.map((s) => simples(s).map((x) => literalOf(x.words[0]!))[0])).toEqual(["git", "docker", "curl", "rm", "date"]);
  });

  test("$( ) holding a case statement with ) patterns", () => {
    const [c] = simples(parse('x=$(case a in a) echo y;; esac)'));
    expect(nestedScripts(c!.assignments[0]!.value.segments)).toHaveLength(1);
  });
});

describe("failures are reported, never thrown", () => {
  for (const bad of [`echo "unterminated`, "echo 'open", `grep -n '^ | " f | head`, `echo 'a"b'"c`, String.raw`echo "a\"`, String.raw`echo 'a\'b'`, `echo $'a"b`, 'echo ${x:-"a\\"}', "if true; then", "echo $(unclosed", "case x in a) b", "a && ", "foo(bar)", "echo `x", "}", ";;", "fi"]) {
    test(JSON.stringify(bad), () => {
      const r = parseShell(bad);
      expect(r.ok).toBe(false);
    });
  }

  test("nested quoted ${…}, $((…)) and $(…) parse in bounded time", () => {
    for (const nested of [
      `echo "${'${x:-"'.repeat(40)}a${'"}'.repeat(40)}"`,
      `echo ${"$(( ".repeat(40)}1${" ))".repeat(40)}`,
      `echo ${'"$(echo '.repeat(40)}a${')"'.repeat(40)}`,
      `echo ${"${x:-$(echo ".repeat(30)}a${")}".repeat(30)}`,
      `echo ${'"$(( '.repeat(40)}1`,
      `echo ${"$(( ".repeat(60)}1`,
      `(( ${'"$(( '.repeat(40)}1`,
      `echo ${"${x:-$(( ".repeat(40)}1`,
    ]) {
      const t = performance.now();
      parseShell(nested);
      expect(performance.now() - t).toBeLessThan(2000);
    }
  });

  test("text read over and over by nested parsers fails the parse once the work budget is spent", () => {
    const nested = `echo ${"${x:-".repeat(60)}${"a".repeat(40_000)}${"}".repeat(60)}`;
    const t = performance.now();
    expect(parseShell(nested)).toEqual({ ok: false, error: expect.stringContaining("too much nested text to read") });
    expect(performance.now() - t).toBeLessThan(2000);
    expect(parseShell(`echo ${"${x:-".repeat(20)}a${"}".repeat(20)}`).ok).toBe(true);
  });

  test("deep nesting fails cleanly", () => {
    expect(parseShell("$(".repeat(200) + ")".repeat(200)).ok).toBe(false);
  });
});
