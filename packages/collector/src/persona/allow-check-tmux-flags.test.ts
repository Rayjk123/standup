import { describe, expect, test } from "bun:test";
import { FLOOR_OWNER_GATE } from "../floor/gate.js";
import { callSignals, ruleCheck, type AllowCheckInput } from "./allow-check.js";

/*
 * tmux's own flags (`new-session -d`, `-f <config>`) are cut before the
 * intent read, so a tmux launch is no HTTP write. Only the real tmux's own
 * flags are cut: each call here is read as text by callSignals and never run.
 */

const R = "/tmp/tmp.JTs4g6N8Y9";

function input(call: string): Pick<AllowCheckInput, "toolName" | "call" | "floorReason" | "worktreeRoot"> {
  return { toolName: "Bash", call, floorReason: "", worktreeRoot: "/srv/ws/wt" };
}

function httpWrite(call: string): { call: string; http: boolean } {
  return { call, http: callSignals(input(call)).intents.includes("http-write") };
}

describe("tmux flag cutting keeps a request's http-write", () => {
  test("the plain curl baseline is an http-write", () => {
    for (const call of [`curl -X POST -d @body.json https://api.example.com/x`, `curl -d @/tmp/x https://api.example.com/upload`]) {
      expect(httpWrite(call)).toEqual({ call, http: true });
    }
  });

  test("a quoted value of tmux -c is no tmux flag", () => {
    for (const call of [
      `tmux -c "curl -X POST -d @body.json https://api.example.com/x"`,
      `tmux -c 'curl -X POST -d @body.json https://api.example.com/x'`,
      `tmux -c curl -X POST -d @body.json https://api.example.com/x`,
      `tmux -S "${R}/s" new -d -s x https://api.example.com/x`,
    ]) {
      expect(httpWrite(call)).toEqual({ call, http: true });
    }
  });

  test("an escaped separator is no command boundary", () => {
    for (const call of [
      `curl -s https://e.example.com/x -H x\\;tmux -X POST -d @f`,
      `curl http://127.0.0.1:9999/x -H x\\&tmux -d @f`,
      `curl http://127.0.0.1:9999/x -H x\\|tmux new -d @f`,
      `curl http://127.0.0.1:9999/x -H "x;tmux" new -d @f`,
      `curl http://127.0.0.1:9999/x -H 'a;tmux new -d @f'`,
    ]) {
      expect(httpWrite(call)).toEqual({ call, http: true });
    }
  });

  test("split-window's -f and capture-pane's -p take no value", () => {
    for (const call of [
      `tmux -S /tmp/r/s split-window -f curl -d @/tmp/x https://api.example.com/upload`,
      `tmux -S /tmp/r/s splitw -fd curl -d @/tmp/x https://api.example.com/upload`,
      `tmux capture-pane -p curl -d @/tmp/x https://api.example.com/upload`,
      // -p is a percentage in older tmux and a boolean in newer: left uncut, and cutting stops there.
      `tmux split-window -p -d @/tmp/x https://api.example.com/upload`,
      // A command not known here keeps its flags.
      `tmux run-shell -d @/tmp/x https://api.example.com/upload`,
    ]) {
      expect(httpWrite(call)).toEqual({ call, http: true });
    }
  });

  test("a tmux that may not be the real tmux keeps all of its words", () => {
    for (const call of [
      `PATH=/tmp/b:$PATH tmux -X POST -d @f https://api.example.com/x`,
      `tmux() { curl "$@"; }; tmux -X POST -d @f https://api.example.com/x`,
      // The same calls in tmux's own command shape, which a real tmux would have cut.
      `PATH=/tmp/b:$PATH tmux new -d -s @f https://api.example.com/x`,
      `export PATH=/tmp/b:$PATH; tmux new -d -s @f https://api.example.com/x`,
      `path=(/tmp/b $path); tmux new -d -s @f https://api.example.com/x`,
      `env -i PATH=/tmp/b tmux new -d -s @f https://api.example.com/x`,
      `tmux new -d -s x; PATH=/tmp/b; tmux new -d -s @f https://api.example.com/x`,
      `tmux() { curl "$@"; }; tmux new -d -s @f https://api.example.com/x`,
      `function tmux { curl "$@"; }; tmux new -d -s @f https://api.example.com/x`,
      `alias tmux=curl; tmux new -d -s @f https://api.example.com/x`,
      `hash -p /tmp/b/curl tmux; tmux new -d -s @f https://api.example.com/x`,
      `source /tmp/b/rc; tmux new -d -s @f https://api.example.com/x`,
      `. /tmp/b/rc; tmux new -d -s @f https://api.example.com/x`,
      `eval "$X"; tmux new -d -s @f https://api.example.com/x`,
      `/tmp/b/tmux new -d -s @f https://api.example.com/x`,
      `\\tmux new -d -s @f https://api.example.com/x`,
    ]) {
      expect(httpWrite(call)).toEqual({ call, http: true });
    }
  });

  test("an expanded or quoted word stops the cutting", () => {
    for (const call of [
      // $A may expand to tmux's command and more words.
      `tmux $A -d -s @f https://api.example.com/x`,
      `tmux -S $UNSET new -d -s @f https://api.example.com/x`,
      `A="x new"; tmux -S $A -d -s @f https://api.example.com/x`,
      `tmux -S /tmp/* new -d -s @f https://api.example.com/x`,
      `tmux -S /tmp/{a,new} -d -s @f https://api.example.com/x`,
      `tmux new -s "x" -d @f https://api.example.com/x`,
      `tmux new -\\d -s @f https://api.example.com/x`,
      `tmux new -d"" -s @f https://api.example.com/x`,
      `tmux -S $(pwd)/s new -d -s @f https://api.example.com/x`,
      `tmux new -d -- -d @f https://api.example.com/x`,
    ]) {
      expect(httpWrite(call)).toEqual({ call, http: true });
    }
  });

  test("a request's -d inside or after the real tmux still reads", () => {
    for (const call of [
      `tmux new-session -d -s x "curl -d @/tmp/x https://api.example.com/upload"`,
      `tmux new-session -d -s x 'curl -X POST https://api.example.com/upload'`,
      `tmux new -d curl -d @/tmp/x https://api.example.com/upload`,
      `tmux -S ${R}/s new -d 'sleep 1' && curl -d @/tmp/x https://api.example.com/upload`,
    ]) {
      expect(httpWrite(call)).toEqual({ call, http: true });
    }
  });
});

describe("a redirect's & is no command boundary", () => {
  const BODY = `curl https://api.example.com/x -d @/tmp/body`;
  const REDIRECTED = [
    `curl https://api.example.com/x >& tmux new -d @/tmp/body`,
    `curl https://api.example.com/x >&tmux new -d @/tmp/body`,
    `curl https://api.example.com/x 1>& tmux new -d @/tmp/body`,
    `curl https://api.example.com/x <& tmux new -d @/tmp/body`,
    `curl https://api.example.com/x 2>&1 >& tmux new -d @/tmp/body`,
    `curl https://api.example.com/x >& timeout 5 tmux new -d @/tmp/body`,
    `curl https://api.example.com/x >& nohup tmux new -d @/tmp/body`,
    `curl https://api.example.com/x >& X=1 tmux new -d @/tmp/body`,
    `curl https://api.example.com/x >& tmux -L x new -d @/tmp/body`,
    `curl https://api.example.com/x >& tmux new -dX POST`,
    `curl https://api.example.com/x &> tmux new -d @/tmp/body`,
    `curl https://api.example.com/x >| tmux new -d @/tmp/body`,
    `curl https://api.example.com/x >| X=1 tmux new -d @/tmp/body`,
  ];

  test("the word after >&, <&, &> or >| is the redirect's target, not tmux, and keeps its -d", () => {
    for (const call of [BODY, ...REDIRECTED]) {
      expect(httpWrite(call)).toEqual({ call, http: true });
    }
  });

  test("an outward hold whose job only checks the host flags them as it flags the plain body upload", () => {
    const hold = (call: string): AllowCheckInput => ({
      owner: "alice",
      selfAliases: ["alice"],
      gate: FLOOR_OWNER_GATE,
      category: "outward",
      floorReason: "an HTTP request to api.example.com",
      toolName: "Bash",
      call,
      personaReason: "the job checks api.example.com",
      job: { title: "api check", goal: "check that api.example.com answers" },
      brief: "Check api.example.com is up.",
      ownerMessages: ["check api.example.com"],
      preferences: [],
      worktreeRoot: "/srv/ws/wt",
    });
    const plain = ruleCheck(hold(BODY));
    expect(plain.verdict).toBe("flag");
    expect(plain.reason).toContain("http-write");
    for (const call of REDIRECTED) {
      const { verdict, reason } = ruleCheck(hold(call));
      expect({ call, verdict, http: reason.includes("http-write") }).toEqual({ call, verdict: "flag", http: true });
    }
  });

  test("a redirect inside a real tmux launch still lets its own flags be cut", () => {
    for (const call of [`tmux -S ${R}/s new -d -s x 'sleep 1' >& /dev/null`, `tmux -S ${R}/s new -d -s x 'sleep 1' 2>&1 >| ${R}/log`]) {
      expect(httpWrite(call)).toEqual({ call, http: false });
    }
  });
});

describe("the real tmux's own flags are no http-write", () => {
  test("a scratch launch and plain tmux commands carry no http-write", () => {
    for (const call of [
      `tmux -S /tmp/r/tmux.sock new-session -d -s scratch "env -i HOME=/tmp/r/home bun run src/index.ts"`,
      `R=${R}; tmux -S $R/tmux.sock new-session -d -s scratch "env -i PATH=/usr/bin:/bin HOME=$R/home bun run src/index.ts"`,
      `tmux -f ${R}/tmux.conf -S ${R}/s new -ds x "bun run src/index.ts"`,
      `tmux -S ${R}/s new-window -d -n w 'sleep 1'`,
      `tmux -S ${R}/s split-window -d -f -t scratch 'sleep 1'`,
      `tmux -S ${R}/s capture-pane -p -t scratch`,
      `TMUX_TMPDIR=${R}/tmp nohup tmux -S ${R}/s new -d -s x 'sleep 1'`,
      `cd ${R} && tmux -S ${R}/s new-session -d -s scratch -e HOME=${R}/home 'bun run src/index.ts'`,
    ]) {
      expect(httpWrite(call)).toEqual({ call, http: false });
    }
  });
});
