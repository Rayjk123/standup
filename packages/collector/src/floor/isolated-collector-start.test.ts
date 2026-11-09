import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "path";
import { resolvePipelineLayers, type PipelineRun } from "@standup/shared";
import { openPipelineStageKinds, ruleCheck, type AllowCheckInput } from "../persona/allow-check.js";
import { FLOOR_OWNER_GATE, type FloorCategory } from "./gate.js";
import { DATA, ENV, INSTALL, LIVE_PATH, R, ROOT, TOKEN, VIRTUAL, bash, shape } from "./scratch-harness.js";

/*
 * A worker's live check of its own change: the collector started from the
 * worktree root in a tmux session on a private socket, with every root under
 * one /tmp dir, bound to loopback with every network and reaping feature off,
 * and its output sent to a log under that dir.
 */

// Reading the collector's whole source for one call takes about a second.
setDefaultTimeout(60_000);

const OFF = "STANDUP_BIND_HOST=127.0.0.1 STANDUP_GATEWAY=0 STANDUP_REVIEW_TUNNELS=0 STANDUP_DIGEST=0 STANDUP_PERSONA=0 STANDUP_IDLE_REAP=0";
const ROOTS = [
  `TMUX_TMPDIR=${R}/tmux`,
  `ICONS_DIR=${R}/icons`,
  `STANDUP_PROJECT_DOCS_DIR=${R}/docs`,
  `STANDUP_PROJECTS_PATH=${R}/projects.json`,
  `STANDUP_WRITE_TOKEN_FILE=${R}/data/secrets/write.token`,
].join(" ");

function start(env = `${ENV} ${TOKEN} ${ROOTS} COLLECTOR_PORT=29777 WS_PORT=29778 ${OFF}`, socket = `-S ${R}/tmux.sock`, cwd = ROOT, prelude = ""): string {
  return `tmux ${socket} new-session -d -s scratch -c ${cwd} '${prelude}${env} bun run packages/collector/src/index.ts > ${R}/x.log 2>&1'`;
}

describe("a fully isolated scratch collector start", () => {
  test("the exact shape is not held", () => {
    expect(shape(bash(start()))).toEqual({ action: "allow" });
  });

  test("each single deviation is still held", () => {
    const cases: Record<string, string> = {
      "one root outside /tmp": start(`${ENV} ${TOKEN} ${ROOTS.replace(`ICONS_DIR=${R}/icons`, `ICONS_DIR=${join(DATA, "icons")}`)} COLLECTOR_PORT=29777 WS_PORT=29778 ${OFF}`),
      "PERSONA=1": start(`${ENV} ${TOKEN} ${ROOTS} COLLECTOR_PORT=29777 WS_PORT=29778 ${OFF.replace("STANDUP_PERSONA=0", "STANDUP_PERSONA=1")}`),
      "no BIND_HOST": start(`${ENV} ${TOKEN} ${ROOTS} COLLECTOR_PORT=29777 WS_PORT=29778 ${OFF.replace("STANDUP_BIND_HOST=127.0.0.1 ", "")}`),
      "IDLE_REAP on": start(`${ENV} ${TOKEN} ${ROOTS} COLLECTOR_PORT=29777 WS_PORT=29778 ${OFF.replace("STANDUP_IDLE_REAP=0", "STANDUP_IDLE_REAP=1")}`),
      "the default tmux socket": start(undefined, ""),
      "sourcing env.sh": start(undefined, undefined, undefined, "source ./env.sh && "),
      "eval": start(undefined, undefined, undefined, 'eval "$X" && '),
      "an unseen PATH dir": start(`${ENV.replace(`PATH=${LIVE_PATH}`, `PATH=${R}/bin:${LIVE_PATH}`)} ${TOKEN} ${ROOTS} COLLECTOR_PORT=29777 WS_PORT=29778 ${OFF}`),
      "-c the install": start(undefined, undefined, INSTALL),
    };
    // The scratch root's own bin dir holds a `bun` the worker wrote, which the run starts in place of the real one.
    VIRTUAL[join(R, "bin", "bun")] = "#!/bin/sh\n";
    try {
      for (const [name, command] of Object.entries(cases)) {
        expect({ name, action: bash(command).action }).toEqual({ name, action: "hold" });
      }
    } finally {
      delete VIRTUAL[join(R, "bin", "bun")];
    }
  });
});

describe("the second check on the isolated start", () => {
  // The collector's own finding, as floorScratchInstanceOf reads it back from the ask's question.
  const MARKER = { root: R, assignments: [TOKEN] };
  const base: AllowCheckInput = {
    owner: "alice",
    selfAliases: ["alice"],
    gate: FLOOR_OWNER_GATE,
    category: "floor-tamper",
    floorReason: `code in ${ROOT}/packages/collector/src/index.ts names the Standup data dir`,
    toolName: "Bash",
    call: start(),
    personaReason: "the worker's live check of its own change",
    job: { title: "Fix floor holds", goal: "classify the start" },
    brief: "",
    ownerMessages: [],
    preferences: [],
    worktreeRoot: ROOT,
    pipelineStage: "live_check",
  };

  test("an isolated start the floor vouched for, at the live check, passes", () => {
    expect(ruleCheck({ ...base, scratchInstance: MARKER }).verdict).toBe("allow");
  });

  test("a kill by name under the same isolation keeps its flag", () => {
    const call = `${ENV} pkill -f collector`;
    const v = bash(call);
    if (v.action !== "hold") throw new Error("expected a hold");
    expect(v.scratch).toBeTruthy();
    const kill = { ...base, call, category: v.category, floorReason: v.reason, scratchInstance: v.scratch! };
    expect(ruleCheck(kill).reason).toContain("never asked to stop");
  });

  test("an open run whose pipeline has an isolated live check asks for the start at any of its stages", () => {
    const run = (preset: "light" | "full", over: Partial<Pick<PipelineRun, "status" | "attempts" | "epoch">> = {}) =>
      openPipelineStageKinds({ status: "active", definition: resolvePipelineLayers([], preset).definition, attempts: [], ...over });
    const early = { ...base, scratchInstance: MARKER, pipelineStage: "validation" };
    expect(ruleCheck({ ...early, pipelineStages: run("light") }).verdict).toBe("allow");
    expect(ruleCheck({ ...early, pipelineStages: run("light", { status: "waiting_user" }) }).verdict).toBe("allow");
    // A live check skipped before a rework epoch may be entered again.
    const old = { id: "a", runId: "r", stageId: "live_check", attempt: 1, status: "skipped" as const, epoch: 0, createdAt: "" };
    expect(ruleCheck({ ...early, pipelineStages: run("light", { epoch: 1, attempts: [old] }) }).verdict).toBe("allow");
    // The full preset switches the live check off; a complete or disabled run, or a skipped or waived live check, asks for none.
    const skipped = { id: "a", runId: "r", stageId: "live_check", attempt: 1, status: "skipped" as const, createdAt: "" };
    for (const [what, stages] of [
      ["full", run("full")],
      ["complete", run("light", { status: "complete" })],
      ["disabled", run("light", { status: "disabled" })],
      ["skipped", run("light", { attempts: [skipped] })],
      ["waived", run("light", { attempts: [{ ...skipped, status: "waived" }] })],
      ["skipped this epoch", run("light", { epoch: 1, attempts: [{ ...skipped, epoch: 1 }] })],
      ["no run", undefined],
    ] as const) {
      expect({ what, reason: ruleCheck({ ...early, pipelineStages: stages ? [...stages] : undefined }).reason }).toEqual({ what, reason: expect.stringContaining("never asked for") });
    }
  });

  test("a start that reaches the live DB, the live ports or the install dir still flags with a live check in the pipeline", () => {
    const cases: Record<string, [string, FloorCategory]> = {
      "the live DB": [start(`${ENV.replace(/DB_PATH=\S+/, `DB_PATH=${join(DATA, "standup.db")}`)} ${TOKEN} ${ROOTS} COLLECTOR_PORT=29777 WS_PORT=29778 ${OFF}`), "floor-tamper"],
      "the live port": [start(`${ENV} ${TOKEN} ${ROOTS} COLLECTOR_PORT=7777 WS_PORT=29778 ${OFF}`), "floor-tamper"],
      "-c the install": [start(undefined, undefined, INSTALL), "outward"],
    };
    for (const [name, [call, category]] of Object.entries(cases)) {
      const v = bash(call);
      if (v.action !== "hold") throw new Error(`expected a hold for ${name}`);
      if (v.category !== category) throw new Error(`${name}: held as ${v.category}, not ${category}: ${v.reason}`);
      // The floor vouches for no scratch instance past its isolation, so the live check in the pipeline asks for none.
      expect({ name, scratch: v.scratch ?? null, category: v.category }).toEqual({ name, scratch: null, category });
      const input = { ...base, call, category: v.category, floorReason: v.reason, pipelineStage: "validation", pipelineStages: ["coding", "live_check"] };
      expect({ name, verdict: ruleCheck(input).verdict }).toEqual({ name, verdict: "flag" });
      // The floor's reason names what reaches past the isolation, which unplaces the run even beside a scratch marker.
      expect({ name, verdict: ruleCheck({ ...input, scratchInstance: MARKER }).verdict }).toEqual({ name, verdict: "flag" });
    }
  });

  test("without the floor's marker, or with a reason past its isolation, it still flags", () => {
    expect(ruleCheck(base).reason).toContain("never asked for");
    const past = { ...base, scratchInstance: MARKER, floorReason: `${base.floorReason} (also outward: sends a request to a remote service)` };
    expect(ruleCheck(past).reason).toContain("never asked for");
  });
});
