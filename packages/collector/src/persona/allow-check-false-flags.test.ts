import { describe, expect, test } from "bun:test";
import { ruleCheck, type AllowCheckInput } from "./allow-check.js";

/*
 * A delete the job named, flagged by the rules check only because the call
 * also wrote under /tmp/, a path the job never had to name.
 */

const WT = "/home/alice/.local/share/standup/worktrees/standup/feat-1";
const R = "/tmp/tmp.Q1w2E3";
const OTHER = "/home/alice/src/OtherPkg/build";

function del(call: string): AllowCheckInput {
  return {
    owner: "alice",
    selfAliases: ["alice"],
    gate: "safety_floor",
    category: "destructive",
    floorReason: `deletes ${OTHER}, outside the worktree`,
    toolName: "Bash",
    call,
    personaReason: "the job's own cleanup",
    job: { title: "Clean", goal: "delete OtherPkg's build dir" },
    brief: "",
    ownerMessages: [],
    preferences: [],
    worktreeRoot: WT,
  };
}

describe("writes under /tmp/ beside a delete the job named", () => {
  test("a scratch dir made under /tmp/ needs no name of its own", () => {
    expect(ruleCheck(del(`rm -rf ${OTHER}`)).verdict).toBe("allow");
    expect(ruleCheck(del(`mkdir -p ${R}/out && echo done > ${R}/out/log && rm -rf ${OTHER}`)).verdict).toBe("allow");
  });

  test("a delete under /tmp/ is still named", () => {
    expect(ruleCheck(del(`rm -rf ${R}/keepme ${OTHER}`)).verdict).toBe("flag");
  });
});
