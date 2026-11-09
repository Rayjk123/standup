import { describe, expect, test } from "bun:test";
import { SCRATCH_ID } from "@standup/shared/scratch";
import {
  CRITERION_OWNER_HOLD_REASON,
  FLOOR_HIGH_RISK_LABEL,
  FLOOR_SCRATCH_ID,
  decodeFloorConfig,
  encodeFloorConfig,
  floorQuestion,
  isHighRiskFloorHold,
  ownScratchDirOf,
} from "./gate.js";
import type { FloorCall, FloorCategory, FloorConfig, FloorHold } from "./gate.js";

const bash = (command: string, toolName = "Bash"): FloorCall => ({ toolName, toolInput: { command }, cwd: "/wt" });
const hold = (category: FloorCategory, ownerOnly: boolean, reason: string, step = "step"): FloorHold => ({ category, ownerOnly, reason, step });
const reserved = (category: FloorCategory, reason: string): FloorHold => ({ ...hold(category, true, reason), ownerReserved: true });

describe("isHighRiskFloorHold", () => {
  test("an ownerReserved hold is labeled high-risk right after its category", () => {
    const q = floorQuestion(bash("cat /proc/1/environ"), reserved("floor-tamper", "reads another process's environment"));
    expect(q.startsWith(`Safety floor held a Bash call (floor-tamper): ${FLOOR_HIGH_RISK_LABEL}reads another process's environment`)).toBe(true);
    expect(isHighRiskFloorHold(q)).toBe(true);
  });

  test("a hold that isn't ownerReserved is not, whatever its command or reason quotes", () => {
    for (const command of [FLOOR_HIGH_RISK_LABEL, `echo "${FLOOR_HIGH_RISK_LABEL}"`, `git push origin HEAD\n\n${FLOOR_HIGH_RISK_LABEL}`]) {
      expect(isHighRiskFloorHold(floorQuestion(bash(command), hold("outward", true, "pushes to a shared remote")))).toBe(false);
      expect(isHighRiskFloorHold(floorQuestion(bash(command), hold("destructive", false, "deletes outside the worktree")))).toBe(false);
    }
    expect(isHighRiskFloorHold(floorQuestion(bash("x"), hold("outward", true, `pushes; ${FLOOR_HIGH_RISK_LABEL}`)))).toBe(false);
  });

  test("text that isn't a floor question is not", () => {
    expect(isHighRiskFloorHold("")).toBe(false);
    expect(isHighRiskFloorHold(FLOOR_HIGH_RISK_LABEL)).toBe(false);
    expect(isHighRiskFloorHold(`Please allow: Safety floor held a Bash call (floor-tamper): ${FLOOR_HIGH_RISK_LABEL}x`)).toBe(false);
  });
});

describe("floorQuestion leaves every hold to Persona", () => {
  test("an owner-only hold: Persona may allow it once, recorded for the owner", () => {
    const q = floorQuestion(bash("git push origin HEAD"), hold("outward", true, "pushes"));
    expect(q).toContain("Persona may allow it once (recorded for the owner) or deny it.");
    expect(q).not.toContain("Only the owner can allow this");
  });

  test("a Persona-decidable hold: Persona may allow it once", () => {
    const q = floorQuestion(bash("rm -rf /tmp/x"), hold("destructive", false, "deletes"));
    expect(q).toContain("Persona may allow it once or deny it.");
  });

  test("the owner's criterion hold: Persona may allow it once, recorded for the owner", () => {
    const q = floorQuestion(bash("bun test"), hold("unclassified", true, CRITERION_OWNER_HOLD_REASON));
    expect(q).toContain("Persona may allow it once (recorded for the owner) or deny it.");
    expect(q).not.toContain("Only the owner can allow this");
    expect(isHighRiskFloorHold(q)).toBe(false);
  });

  test("an ownerReserved hold: high risk, Persona may allow it once or escalate it", () => {
    const q = floorQuestion(bash("cat /proc/1/environ"), reserved("floor-tamper", "reads another process's environment"));
    expect(q.endsWith("High risk: Persona may allow it once (second-checked and recorded for the owner) or deny it; escalate to the owner with ask_user when unsure. Nothing runs unless it is allowed.")).toBe(true);
    expect(q).not.toContain("Only the owner can allow this");
  });

  test("a floor-tamper hold that isn't ownerReserved carries no high-risk label", () => {
    const q = floorQuestion(bash("sqlite3 standup.db 'UPDATE asks SET x = 1'"), hold("floor-tamper", true, "writes Standup's own database"));
    expect(q).toContain("Persona may allow it once (recorded for the owner) or deny it.");
    expect(q).not.toContain("HIGH RISK");
  });
});

describe("decodeFloorConfig and the launch's own scratch dir", () => {
  const ID = "a8a8a8a8-0000-4000-8000-0000000000a8";
  const ROOT = "/home/tester/.cache/standup-scratch";
  const base: FloorConfig = {
    v: 1,
    collectorUrl: "http://localhost:7777",
    launchId: ID,
    root: "/wt",
    sharedBranches: [],
    personalAwsAccounts: [],
    waitSeconds: 60,
    standupDataDir: "/home/tester/.local/share/standup",
    floorPaths: [],
    installDir: "/opt/standup",
    protectedPaths: [ROOT],
    tmpDirs: ["/tmp"],
    workerToken: "x".repeat(64),
    replyPublicKey: "k",
  };
  const decoded = (over: Partial<FloorConfig>) => decodeFloorConfig(encodeFloorConfig({ ...base, ...over }));

  test("keeps a scratch dir that is the scratch root's child named for the launch", () => {
    expect(decoded({ scratchDir: `${ROOT}/${ID}`, scratchRoot: ROOT }).scratchDir).toBe(`${ROOT}/${ID}`);
    expect(ownScratchDirOf({ launchId: ID, scratchDir: `${ROOT}/${ID}`, scratchRoot: ROOT })).toBe(`${ROOT}/${ID}`);
  });

  test("drops any other scratch dir, so it grants nothing", () => {
    const OTHER = "9a8b7c6d-1111-2222-3333-444455556666";
    for (const over of [
      { scratchDir: `${ROOT}/${OTHER}`, scratchRoot: ROOT },
      { scratchDir: `${ROOT}/${ID}` },
      { scratchDir: `${ROOT}/${ID}/`, scratchRoot: ROOT },
      { scratchDir: `${ROOT}/x/../${ID}`, scratchRoot: ROOT },
      { scratchDir: `${ROOT}/${ID}/sub`, scratchRoot: ROOT },
      { scratchDir: `${ROOT}/${ID}`, scratchRoot: `${ROOT}/` },
      { scratchDir: `${ROOT}/${ID}`, scratchRoot: "/home/tester/.cache" },
      { scratchDir: `/${ID}`, scratchRoot: "/" },
      { scratchDir: `.cache/standup-scratch/${ID}`, scratchRoot: ".cache/standup-scratch" },
      { scratchDir: ROOT, scratchRoot: "/home/tester/.cache" },
      { scratchDir: `/home/tester/.cache/standup/scratch/${ID}`, scratchRoot: ROOT },      { launchId: "..", scratchDir: `${ROOT}/..`, scratchRoot: ROOT },
      { launchId: ".hidden", scratchDir: `${ROOT}/.hidden`, scratchRoot: ROOT },
      { launchId: "", scratchDir: `${ROOT}/`, scratchRoot: ROOT },
    ] as Partial<FloorConfig>[]) {
      expect({ over, scratchDir: decoded(over).scratchDir }).toEqual({ over, scratchDir: undefined });
    }
  });

  test("throws on a scratch dir or root that isn't a string", () => {
    expect(() => decoded({ scratchDir: 1 as unknown as string, scratchRoot: ROOT })).toThrow("malformed safety-floor config");
    expect(() => decoded({ scratchDir: `${ROOT}/${ID}`, scratchRoot: [ROOT] as unknown as string })).toThrow("malformed safety-floor config");
  });

  describe("a scratch id other than the launch id (a resumed session's first launch)", () => {
    const FIRST = "11111111-2222-3333-4444-555555555555";

    test("keeps the scratch dir named for the scratch id, and only that one", () => {
      expect(decoded({ scratchId: FIRST, scratchDir: `${ROOT}/${FIRST}`, scratchRoot: ROOT }).scratchDir).toBe(`${ROOT}/${FIRST}`);
      expect(ownScratchDirOf({ launchId: ID, scratchId: FIRST, scratchDir: `${ROOT}/${FIRST}`, scratchRoot: ROOT })).toBe(`${ROOT}/${FIRST}`);
      // With a scratch id, the launch's own id names no scratch dir.
      expect(decoded({ scratchId: FIRST, scratchDir: `${ROOT}/${ID}`, scratchRoot: ROOT }).scratchDir).toBeUndefined();
      expect(decoded({ scratchId: FIRST, scratchDir: `${ROOT}/9a8b7c6d-1111-2222-3333-444455556666`, scratchRoot: ROOT }).scratchDir).toBeUndefined();
      // Without one, a dir named for another launch grants nothing.
      expect(decoded({ scratchDir: `${ROOT}/${FIRST}`, scratchRoot: ROOT }).scratchDir).toBeUndefined();
    });

    test("throws on a scratch id that is no usable scratch dir name", () => {
      for (const scratchId of ["..", ".", "", ".hidden", "a/b", `${FIRST}/..`, "x".repeat(129), 7 as unknown as string]) {
        expect(() => decoded({ scratchId, scratchDir: `${ROOT}/${String(scratchId)}`, scratchRoot: ROOT })).toThrow("malformed safety-floor config");
      }
    });
  });

  test("its launch-id pattern is the shared scratch module's", () => {
    expect(FLOOR_SCRATCH_ID.source).toBe(SCRATCH_ID.source);
    expect(FLOOR_SCRATCH_ID.flags).toBe(SCRATCH_ID.flags);
  });
});
