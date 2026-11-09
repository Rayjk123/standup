import { describe, expect, test } from "bun:test";
import { BUNNY_ACTIVITIES, type BunnyActivity } from "./burrow";
import {
  ARRIVAL_TICKS,
  ROOM,
  SPAWN,
  STATIONS,
  WALK_SPEED,
  TAG_MIN_SCALE,
  TAG_PLACES,
  WANDER_SPEED,
  bobberSpot,
  bodyBox,
  fixtureBox,
  plaqueBox,
  stemBox,
  inWater,
  footprint,
  layoutRoom,
  reconcileWalkers,
  spotMemory,
  stationFor,
  stepToward,
  wanderTarget,
  within,
  type Box,
  type SpotMemory,
  type StationId,
  type Walker,
} from "./burrowRoom";

const walker = (over: Partial<Walker> = {}): Walker => ({ x: 0, y: 0, left: false, steps: 0, arrived: -1, ...over });

const overlaps = (a: Box, b: Box) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
const inside = (a: Box, outer: Box) => a[0] >= outer[0] && a[1] >= outer[1] && a[2] <= outer[2] && a[3] <= outer[3];

/** Every spot in the house, with its station and the space it takes wherever it wanders. */
const ALL = Object.values(STATIONS).flatMap((s) =>
  s.spots.map((spot, i) => ({ station: s, spot, i, space: fixtureBox(spot) && spot.fixture !== "anvil" && spot.fixture !== "easel" ? fixtureBox(spot)! : footprint(spot) }))
);

describe("stationFor", () => {
  test("each kind of work has its room or corner of the yard", () => {
    const want: Record<BunnyActivity, StationId> = {
      smithing: "forge",
      fishing: "pond",
      cooking: "nook",
      painting: "studio",
      gardening: "garden",
      sign: "hall",
      idle: "living",
      sleeping: "bedroom",
      quiet: "bedroom",
    };
    for (const a of BUNNY_ACTIVITIES) expect(stationFor(a)).toBe(want[a]);
  });
});

describe("the stations", () => {
  test("every station's floor is in the scene, and the stations don't overlap", () => {
    const floors = Object.values(STATIONS).map((s) => ({ id: s.id, floor: s.floor }));
    for (const { floor } of floors) expect(inside(floor, [0, 0, ROOM.w, ROOM.h])).toBe(true);
    for (let i = 0; i < floors.length; i++) {
      for (let j = i + 1; j < floors.length; j++) {
        expect({ a: floors[i].id, b: floors[j].id, hit: overlaps(floors[i].floor, floors[j].floor) }).toEqual({ a: floors[i].id, b: floors[j].id, hit: false });
      }
    }
  });

  test("a bunny wandering anywhere around its spot stays on its station's floor", () => {
    for (const { station, spot, i, space } of ALL) {
      expect(within(spot.wander, spot.x, spot.y)).toBe(true);
      expect({ station: station.id, i, inside: inside([space[0], spot.wander[1], space[2], spot.wander[3]], station.floor) }).toEqual({ station: station.id, i, inside: true });
    }
  });

  test("no two bunnies can touch, wherever each wanders round its spot", () => {
    for (let a = 0; a < ALL.length; a++) {
      for (let b = a + 1; b < ALL.length; b++) {
        const hit = overlaps(ALL[a].space, ALL[b].space);
        expect({ a: `${ALL[a].station.id}:${ALL[a].i}`, b: `${ALL[b].station.id}:${ALL[b].i}`, hit }).toEqual({
          a: `${ALL[a].station.id}:${ALL[a].i}`,
          b: `${ALL[b].station.id}:${ALL[b].i}`,
          hit: false,
        });
      }
    }
  });

  test("no bunny wanders into furniture, the water, or another spot's anvil or easel", () => {
    for (const { station, spot, i, space } of ALL) {
      const blocked = [
        ...station.props,
        ...station.spots.flatMap((other, j) => (j !== i && fixtureBox(other) ? [fixtureBox(other)!] : [])),
      ];
      for (const box of blocked) expect({ station: station.id, i, box, hit: overlaps(space, box) }).toEqual({ station: station.id, i, box, hit: false });
      // Its own anvil or easel stands just beside its body: it steps back from it, never into it.
      const own = fixtureBox(spot);
      if (own && (spot.fixture === "anvil" || spot.fixture === "easel")) {
        const [x0, y0, x1, y1] = spot.wander;
        expect(overlaps([x0 - 15, y0 - 30, x1 + 15, y1], own)).toBe(false);
      }
    }
  });

  test("a fisher's bobber lands in the water, with room for its ripples, and every plaque is in the scene", () => {
    for (const s of STATIONS.pond.spots) {
      const b = bobberSpot(s);
      for (const [dx, dy] of [
        [0, 0],
        [-4, 0],
        [4, 0],
        [0, 2],
      ]) {
        expect({ spot: [s.x, s.y], at: [b.x + dx, b.y + dy], wet: inWater(b.x + dx, b.y + dy) }).toEqual({ spot: [s.x, s.y], at: [b.x + dx, b.y + dy], wet: true });
      }
    }
    for (const s of Object.values(STATIONS)) expect(inside([s.plaque[0], s.plaque[1], s.plaque[0] + 40, s.plaque[1] + 10], [0, 0, ROOM.w, ROOM.h])).toBe(true);
  });

  test("every name tag, as drawn, is clear of every other tag, every plaque and every other bunny, inside its station's walls", () => {
    const tags = ALL.map(({ station, i }) => ({ key: `${station.id}:${i}`, station, place: TAG_PLACES.get(`${station.id}:${i}`)! }));
    const plaques = Object.values(STATIONS).map((s) => ({ id: s.id, box: plaqueBox(s) }));
    for (const t of tags) {
      const [x0, y0, x1] = t.place.box;
      expect({ key: t.key, inside: x0 >= t.station.floor[0] && x1 <= t.station.floor[2] && y0 >= 0 }).toEqual({ key: t.key, inside: true });
      expect({ key: t.key, readable: t.place.width >= 56 }).toEqual({ key: t.key, readable: true });
      // The tag is as tall as one is drawn at the smallest scale that shows tags.
      expect(t.place.box[3] - t.place.box[1]).toBeGreaterThanOrEqual(Math.ceil(22 / TAG_MIN_SCALE));
      for (const p of plaques) expect({ tag: t.key, plaque: p.id, hit: overlaps(t.place.box, p.box) }).toEqual({ tag: t.key, plaque: p.id, hit: false });
      for (const o of ALL) {
        if (`${o.station.id}:${o.i}` === t.key) continue;
        expect({ tag: t.key, body: `${o.station.id}:${o.i}`, hit: overlaps(t.place.box, bodyBox(o.spot)) }).toEqual({ tag: t.key, body: `${o.station.id}:${o.i}`, hit: false });
      }
    }
    for (let a = 0; a < tags.length; a++) {
      for (let b = a + 1; b < tags.length; b++) {
        const hit = overlaps(tags[a].place.box, tags[b].place.box);
        expect({ a: tags[a].key, b: tags[b].key, hit }).toEqual({ a: tags[a].key, b: tags[b].key, hit: false });
      }
    }
    // A raised tag's stem runs down to its own bunny past no other tag, so every tag reads as its own bunny's.
    for (const t of tags) {
      const spot = ALL.find((o) => `${o.station.id}:${o.i}` === t.key)!.spot;
      const stem = stemBox(spot, t.place);
      if (!stem) continue;
      for (const o of tags) {
        if (o.key === t.key) continue;
        expect({ stem: t.key, tag: o.key, hit: overlaps(stem, o.place.box) }).toEqual({ stem: t.key, tag: o.key, hit: false });
      }
    }
    // Every title gets about 16 characters at 2x or more; where there is room to stagger, about 22 or more.
    expect(Object.fromEntries(tags.filter((t) => t.place.width < 68).map((t) => [t.key, t.place.width]))).toEqual({});
    expect(tags.filter((t) => t.place.width >= 92).length).toBeGreaterThanOrEqual(tags.length / 2);
  });

  test("the front door's threshold is in the front hall", () => {
    expect(within(STATIONS.hall.floor, SPAWN[0], SPAWN[1])).toBe(true);
  });
});

describe("wanderTarget", () => {
  const spot = STATIONS.nook.spots[0];

  test("now and then a bunny strolls to a point in its wander box, and is back home most of the time", () => {
    let away = 0;
    const points = new Set<string>();
    for (let tick = 0; tick < 2000; tick++) {
      const t = wanderTarget(5, tick, spot);
      expect(within(spot.wander, t.x, t.y)).toBe(true);
      if (t.x !== spot.x || t.y !== spot.y) {
        away++;
        points.add(`${t.x},${t.y}`);
      }
    }
    expect(away).toBeGreaterThan(100);
    expect(away).toBeLessThan(1000);
    // It goes somewhere different on different strolls.
    expect(points.size).toBeGreaterThan(2);
  });

  test("bunnies stroll at different times, and the same bunny's schedule repeats exactly", () => {
    const outAt = (seed: number) => Array.from({ length: 600 }, (_, t) => wanderTarget(seed, t, spot)).findIndex((p) => p.x !== spot.x || p.y !== spot.y);
    const starts = new Set([1, 2, 3, 4, 5, 6].map(outAt));
    expect(starts.size).toBeGreaterThan(3);
    expect(wanderTarget(9, 321, spot)).toEqual(wanderTarget(9, 321, spot));
  });

  test("a sleeper stays in bed", () => {
    const bed = STATIONS.bedroom.spots[0];
    for (let tick = 0; tick < 500; tick++) expect(wanderTarget(3, tick, bed)).toEqual({ x: bed.x, y: bed.y });
  });

  test("a stroll is slow: it takes a couple of seconds to amble out", () => {
    const [x0, y0, x1, y1] = spot.wander;
    expect(Math.hypot(x1 - x0, y1 - y0) / WANDER_SPEED).toBeGreaterThan(12);
    expect(WANDER_SPEED).toBeLessThan(WALK_SPEED / 2);
  });
});

describe("layoutRoom", () => {
  type Item = { id: string; activity: BunnyActivity };
  const item = (id: string, activity: BunnyActivity): Item => ({ id, activity });
  const lay = (items: Item[], memory = new Map()) => layoutRoom(items, (i) => i.activity, (i) => i.id, memory);
  const xy = (s: StationId, i: number) => [STATIONS[s].spots[i].x, STATIONS[s].spots[i].y];

  test("bunnies take their station's spots in order", () => {
    const { placed, overflow } = lay([item("a", "smithing"), item("b", "smithing"), item("c", "sign")]);
    expect(placed.map((p) => [p.item.id, p.station, p.spot, p.x, p.y])).toEqual([
      ["a", "forge", 0, ...xy("forge", 0)],
      ["b", "forge", 1, ...xy("forge", 1)],
      ["c", "hall", 0, ...xy("hall", 0)],
    ]);
    expect(overflow).toEqual({});
  });

  test("a bunny keeps its spot when another one leaves its station: nobody shuffles up", () => {
    const first = lay([item("a", "smithing"), item("b", "smithing"), item("c", "smithing")]);
    const memory = spotMemory(first, (i) => i.id);
    const next = lay([item("a", "fishing"), item("b", "smithing"), item("c", "smithing")], new Map(memory));
    expect(next.placed.map((p) => [p.item.id, p.station, p.spot])).toEqual([
      ["a", "pond", 0],
      ["b", "forge", 1],
      ["c", "forge", 2],
    ]);
    // A newcomer to the forge takes the spot that was freed.
    const later = lay([item("a", "fishing"), item("b", "smithing"), item("c", "smithing"), item("d", "smithing")], new Map(spotMemory(next, (i) => i.id)));
    expect(later.placed.find((p) => p.item.id === "d")?.spot).toBe(0);
  });

  test("a station with more workers than spots lists the rest, in order", () => {
    const n = STATIONS.pond.spots.length;
    const items = Array.from({ length: n + 2 }, (_, i) => item(`t${i}`, "fishing"));
    const { placed, overflow } = lay(items);
    expect(placed).toHaveLength(n);
    expect(overflow.pond?.map((i) => i.id)).toEqual([`t${n}`, `t${n + 1}`]);
  });

  test("at a full station, one arriving waits in the overflow, even ahead in order: those standing there stay put", () => {
    const n = STATIONS.forge.spots.length;
    const held = Array.from({ length: n }, (_, i) => item(`b${i}`, "smithing"));
    const memory = spotMemory(lay(held), (i) => i.id);
    const { placed, overflow } = lay([item("older", "smithing"), ...held], new Map(memory));
    expect(placed.map((p) => [p.item.id, p.spot])).toEqual(held.map((h, i) => [h.id, i]));
    expect(overflow.forge?.map((i) => i.id)).toEqual(["older"]);
  });

  test("at a full front hall, a better tier takes the spot of the last-listed of a worse tier; everyone else keeps theirs", () => {
    const n = STATIONS.hall.spots.length;
    type Tiered = Item & { tier: number };
    const held: Tiered[] = Array.from({ length: n }, (_, i) => ({ ...item(`t${i}`, "sign"), tier: 1 }));
    const layTiered = (items: Tiered[], memory: SpotMemory) => layoutRoom(items, (i) => i.activity, (i) => i.id, memory, (i) => i.tier);
    const memory = spotMemory(layTiered(held, new Map()), (i) => i.id);
    const mine: Tiered = { ...item("mine", "sign"), tier: 0 };
    const { placed, overflow } = layTiered([mine, ...held], memory);
    expect(overflow.hall?.map((i) => i.id)).toEqual([`t${n - 1}`]);
    expect(placed.map((p) => [p.item.id, p.spot]).sort()).toEqual(
      [["mine", n - 1], ...held.slice(0, n - 1).map((h, i) => [h.id, i])].sort()
    );
    // Within its tier a newcomer listed first doesn't bump one standing there.
    const later = layTiered([{ ...item("also", "sign"), tier: 1 }, mine, ...held], spotMemory({ placed, overflow }, (i) => i.id));
    expect(later.overflow.hall?.map((i) => i.id)).toEqual(["also", `t${n - 1}`]);
  });

  test("a full front hall re-sorted (its wait times changed) keeps every bunny on its spot and the same overflow", () => {
    const n = STATIONS.hall.spots.length;
    const waits = Array.from({ length: n + 1 }, (_, i) => item(`w${i}`, "sign"));
    const first = lay(waits);
    const resorted = lay([...waits].reverse(), new Map(spotMemory(first, (i) => i.id)));
    const spots = (l: typeof first) => l.placed.map((p) => [p.item.id, p.spot]).sort();
    expect(spots(resorted)).toEqual(spots(first));
    expect(resorted.overflow.hall?.map((i) => i.id)).toEqual([`w${n}`]);
  });
});

describe("stepToward", () => {
  test("walks straight at the walk speed, counting steps and facing the way it goes", () => {
    let w = walker({ x: 100, y: 100 });
    w = stepToward(w, 40, 100);
    expect(w).toEqual(walker({ x: 100 - WALK_SPEED, y: 100, left: true, steps: 1 }));
    w = stepToward(w, 40, 100);
    expect(w.steps).toBe(2);
  });

  test("arrives exactly and stands, keeping the way it faced; the arrival puff ages and fades", () => {
    let w = stepToward(walker({ x: 42, y: 100, left: true, steps: 9 }), 40, 100);
    expect(w).toEqual(walker({ x: 40, y: 100, left: true, steps: 0, arrived: 0 }));
    for (let i = 0; i < ARRIVAL_TICKS; i++) w = stepToward(w, 40, 100);
    expect(w.arrived).toBe(-1);
    expect(stepToward(w, 40, 100)).toBe(w);
  });

  test("a quiet arrival (back from a stroll) has no puff, and the walker keeps its home", () => {
    const w = stepToward(walker({ x: 40.5, y: 100, steps: 3, home: "nook:0" }), 40, 100, WANDER_SPEED, true);
    expect(w).toEqual(walker({ x: 40, y: 100, left: true, steps: 0, arrived: -1, home: "nook:0" }));
  });

  test("a walk across the scene ends in a bounded number of ticks", () => {
    let w = walker({ x: SPAWN[0], y: SPAWN[1] });
    const { x: tx, y: ty } = STATIONS.pond.spots[0];
    let ticks = 0;
    while ((w.x !== tx || w.y !== ty) && ticks < 1000) {
      w = stepToward(w, tx, ty);
      ticks++;
    }
    expect(ticks).toBeLessThan(Math.ceil(Math.hypot(ROOM.w, ROOM.h) / WALK_SPEED) + 2);
    expect(w.steps).toBe(0);
  });
});

describe("reconcileWalkers", () => {
  const targets = [
    { id: "a", x: 10, y: 20, key: "nook:0" },
    { id: "b", x: 30, y: 40, key: "nook:1" },
  ];

  test("a known bunny keeps where it is (it walks to its new spot); a new one comes in at the front door", () => {
    const prev = new Map([["a", walker({ x: 99, y: 98, left: true, steps: 3 })]]);
    const next = reconcileWalkers(prev, targets, false);
    expect(next.get("a")).toEqual(walker({ x: 99, y: 98, left: true, steps: 3 }));
    expect(next.get("b")).toEqual(walker({ x: SPAWN[0], y: SPAWN[1] }));
  });

  test("one already in the burrow (listed past a full station) appears at its spot, at home there", () => {
    const next = reconcileWalkers(new Map(), targets, false, new Set(["b"]));
    expect(next.get("b")).toEqual(walker({ x: 30, y: 40, home: "nook:1" }));
    expect(next.get("a")).toEqual(walker({ x: SPAWN[0], y: SPAWN[1] }));
  });

  test("snapping puts every bunny at its spot", () => {
    const prev = new Map([["a", walker({ x: 99, y: 98, left: true, steps: 3 })]]);
    const next = reconcileWalkers(prev, targets, true);
    expect(next.get("a")).toEqual(walker({ x: 10, y: 20, left: true, home: "nook:0" }));
    expect(next.get("b")).toEqual(walker({ x: 30, y: 40, home: "nook:1" }));
  });

  test("a bunny given another spot is no longer home there, even one it is walking back to", () => {
    const prev = new Map([["a", walker({ x: 50, y: 50, steps: 4, home: "forge:0" })]]);
    expect(reconcileWalkers(prev, [{ id: "a", x: 10, y: 20, key: "pond:0" }], false).get("a")?.home).toBeUndefined();
    const home = new Map([["a", walker({ x: 10, y: 20, home: "nook:0" })]]);
    expect(reconcileWalkers(home, targets, false).get("a")?.home).toBe("nook:0");
  });

  test("a bunny no longer listed is dropped", () => {
    const prev = new Map([["gone", walker({ x: 1, y: 1 })]]);
    expect([...reconcileWalkers(prev, targets, false).keys()]).toEqual(["a", "b"]);
  });
});
