import { describe, expect, test } from "bun:test";
import { BUNNY_ACTIVITIES } from "../../lib/burrow";
import { STATIONS, footprint } from "../../lib/burrowRoom";
import { BUNNY_H, BUNNY_W, FURS, MAX_TINIES, POSES, TINY_POSES, isEvening, lookFor, poseFor, tinySpot, toolFor, type BunnyFrame } from "./room";

describe("the bunny grids", () => {
  const all = { ...POSES, ...Object.fromEntries(Object.entries(TINY_POSES).map(([k, v]) => [`tiny ${k}`, v])) };

  for (const [name, grid] of Object.entries(all)) {
    test(`${name}: only outline on its edges, every shape outlined, only known pixels`, () => {
      const w = grid[0].length;
      for (const row of grid) expect(row.length).toBe(w);
      const edge = [grid[0], grid[grid.length - 1], ...grid.map((r) => r[0]), ...grid.map((r) => r[w - 1])].join("");
      expect(edge.replace(/[.k]/g, "")).toBe("");
      for (let y = 0; y < grid.length; y++) {
        for (let x = 0; x < w; x++) {
          const ch = grid[y][x];
          expect("k.FDLWwPBHG").toContain(ch);
          // A filled pixel never touches the empty background directly: the outline is between.
          if (ch !== "." && ch !== "k") {
            for (const [dx, dy] of [
              [1, 0],
              [-1, 0],
              [0, 1],
              [0, -1],
            ]) {
              expect(grid[y + dy]?.[x + dx] ?? "k").not.toBe(".");
            }
          }
        }
      }
    });
  }

  test("every worker pose is the same size, so swapping poses never shifts the bunny", () => {
    for (const grid of Object.values(POSES)) {
      expect(grid.length).toBe(BUNNY_H);
      expect(grid[0].length).toBe(BUNNY_W);
    }
  });

  test("a chibi: small enough to share a room with its station's work, with a big eye and a highlight", () => {
    const g = POSES.stand;
    expect(BUNNY_H).toBeGreaterThanOrEqual(30);
    expect(BUNNY_H).toBeLessThanOrEqual(36);
    expect(g.join("")).toContain("H");
    expect((g.join("").match(/G/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(POSES.blink.join("")).not.toContain("H");
  });
});

describe("looks and tools", () => {
  test("the same worker always looks the same; looks use the known furs", () => {
    expect(lookFor("session-1")).toEqual(lookFor("session-1"));
    const furs = new Set(Array.from({ length: 50 }, (_, i) => lookFor(`s${i}`).fur));
    for (const f of furs) expect(Object.keys(FURS)).toContain(f);
    expect(furs.size).toBeGreaterThan(2);
  });

  test("each job has its tool; an idle bunny has its mug; asleep and quiet bunnies hold nothing", () => {
    const tools = Object.fromEntries(BUNNY_ACTIVITIES.map((a) => [a, toolFor(a)]));
    expect(tools).toEqual({
      smithing: "hammer",
      fishing: "rod",
      cooking: "book",
      gardening: "crate",
      painting: "brush",
      idle: "mug",
      sign: "letter",
      sleeping: undefined,
      quiet: undefined,
    });
  });
});

describe("poseFor", () => {
  const frame = (over: Partial<BunnyFrame>): BunnyFrame => ({
    look: lookFor("a"),
    // Walking to bed: the one activity with nothing in its paws, so the plain poses show.
    activity: "sleeping",
    x: 0,
    y: 0,
    left: false,
    steps: 0,
    tick: 5,
    seed: 0,
    still: false,
    ...over,
  });

  test("a walking bunny strides; one carrying a tool keeps its paw up", () => {
    expect([2, 4, 6, 8].map((steps) => poseFor(frame({ steps })))).toEqual(["stride1", "stand", "stride2", "stand"]);
    expect([2, 4, 6].map((steps) => poseFor(frame({ steps, activity: "smithing" })))).toEqual(["holdStride1", "hold", "holdStride2"]);
  });

  test("standing bunnies blink now and then; one with empty paws twitches an ear too", () => {
    const poses = (activity: BunnyFrame["activity"]) => new Set(Array.from({ length: 120 }, (_, tick) => poseFor(frame({ tick, activity }))));
    expect(poses("idle")).toEqual(new Set(["hold", "holdBlink"]));
    // An idle bunny walking to the living room holds its mug up; one on its way to bed walks empty-pawed.
    expect(poseFor(frame({ activity: "idle", steps: 2 }))).toBe("holdStride1");
  });

  test("a bunny walking to the fire to doze walks on its feet, then dozes once there", () => {
    expect(poseFor(frame({ activity: "sleeping", steps: 2 }))).toBe("stride1");
    expect(poseFor(frame({ activity: "quiet", steps: 6 }))).toBe("stride2");
    expect(poseFor(frame({ activity: "sleeping", steps: 0 }))).toBe("doze");
  });

  test("asleep or gone quiet, a bunny dozes; under reduced motion nobody blinks", () => {
    expect(poseFor(frame({ activity: "sleeping" }))).toBe("doze");
    expect(poseFor(frame({ activity: "quiet" }))).toBe("doze");
    const still = new Set(Array.from({ length: 120 }, (_, tick) => poseFor(frame({ tick, still: true, activity: "smithing" }))));
    expect(still).toEqual(new Set(["hold"]));
  });
});

describe("subagents at home", () => {
  test("strolling or working, a worker's subagents stay inside its footprint, on the side clear of its work", () => {
    for (const s of Object.values(STATIONS)) {
      for (const spot of s.spots) {
        if (spot.fixture === "bed" || spot.fixture === "futon") continue;
        const [fx0, fy0, fx1, fy1] = footprint(spot);
        const [x0, y0, x1, y1] = spot.wander;
        for (const [x, y] of [
          [x0, y0],
          [x1 - 1, y0],
          [x0, y1 - 1],
          [x1 - 1, y1 - 1],
        ]) {
          // Whichever way it faces mid-stroll.
          for (const left of [false, true]) {
            for (let i = 0; i < MAX_TINIES; i++) {
              const t = tinySpot({ x, y, left, homeLeft: spot.left, travelling: false }, i);
              const g = TINY_POSES.stand;
              const box = [t.x - g[0].length / 2, t.y - g.length, t.x + g[0].length / 2, t.y + 1];
              const inside = box[0] >= fx0 && box[2] <= fx1 && box[1] >= fy0 && box[3] <= fy1;
              expect({ station: s.id, at: [x, y], left, i, inside }).toEqual({ station: s.id, at: [x, y], left, i, inside: true });
            }
          }
        }
      }
    }
  });

  test("travelling to a new spot, they trail behind the way it walks", () => {
    const f = { x: 100, y: 100, homeLeft: false, travelling: true };
    expect(tinySpot({ ...f, left: true }, 0).x).toBeGreaterThan(100);
    expect(tinySpot({ ...f, left: false }, 0).x).toBeLessThan(100);
  });
});

describe("isEvening", () => {
  test("golden hour from 7:00 to 18:00, evening otherwise", () => {
    const at = (h: number) => new Date(2026, 9, 14, h, 30);
    expect([6, 7, 12, 17, 18, 23].map((h) => isEvening(at(h)))).toEqual([true, false, false, false, true, true]);
  });
});
