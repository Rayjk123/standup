import type { BunnyActivity } from "./burrow";

/**
 * The Burrow's house: a cutaway single-story house, seen from slightly above,
 * split into a room per kind of work behind low interior walls, and the yard
 * outside it (a garden with a cart, and a fishing pond). Each station has a
 * few spots (feet positions in art pixels); a bunny keeps its spot while its
 * work stays at that station, wanders a little around it now and then, and
 * walks to a free spot at another station when its work changes. Pure data
 * and functions — the canvas view (components/BurrowView.tsx) draws them.
 */

/** The scene's size in art pixels; the view scales it to fit. */
export const ROOM = { w: 720, h: 420 } as const;

export type StationId = "hall" | "forge" | "pond" | "nook" | "studio" | "garden" | "living" | "bedroom";

/** A rectangle in art pixels: [left, top, right, bottom], right and bottom exclusive. */
export type Box = readonly [number, number, number, number];

/** What stands at a spot for its bunny's work, drawn with the room. */
export type Fixture = "anvil" | "easel" | "bed" | "futon";

export interface Spot {
  /** Feet position, art pixels. */
  x: number;
  y: number;
  /** Faces left at its work (its fixture or the water is on that side). */
  left: boolean;
  /** Where its feet may wander, around (x, y); a single point for a spot it doesn't leave (a bed). */
  wander: Box;
  fixture?: Fixture;
}

export interface Station {
  id: StationId;
  /** What the station is, in words: its plaque and the overflow list. */
  label: string;
  /** The kinds of work that happen there, in a line: its plaque's tooltip. */
  work: string;
  /** What puts a bunny there and what to do about it, in a few sentences: its plaque's popover. */
  about: string;
  /** Its floor: every bunny's feet, and its whole body, stay inside. */
  floor: Box;
  /** Where its name plaque (and "+N" when it is full) sits, top-left, art pixels. */
  plaque: readonly [number, number];
  spots: readonly Spot[];
  /** Furniture a bunny must not walk into (beyond each spot's own fixture). */
  props: readonly Box[];
}

/**
 * How much room a bunny takes around its feet: its body and the tool it holds
 * out front, and on its back side the subagents trotting after it.
 */
export const FOOTPRINT = { front: 16, back: 30, up: 30, down: 4 } as const;

/** The space a bunny takes when its feet are anywhere in `wander`, facing its spot's way. */
export function footprint(spot: Pick<Spot, "left" | "wander">): Box {
  const [x0, y0, x1, y1] = spot.wander;
  const ahead = FOOTPRINT.front;
  const behind = FOOTPRINT.back;
  return [x0 - (spot.left ? ahead : behind), y0 - FOOTPRINT.up, x1 + (spot.left ? behind : ahead), y1 + FOOTPRINT.down];
}

/** Where a spot's fixture stands (art pixels), beside the bunny on the side it faces. */
export function fixtureBox(spot: Spot): Box | undefined {
  const { x, y, left } = spot;
  switch (spot.fixture) {
    case "anvil":
      return left ? [x - 30, y - 10, x - 16, y] : [x + 16, y - 10, x + 30, y];
    case "easel":
      return left ? [x - 32, y - 26, x - 16, y] : [x + 16, y - 26, x + 32, y];
    case "bed":
      return [x - 20, y - 34, x + 20, y + 14];
    case "futon":
      return [x - 22, y - 34, x + 22, y + 2];
    default:
      return undefined;
  }
}

/** A spot that wanders within (dx0..dx1, dy0..dy1) of its feet. */
function at(x: number, y: number, left: boolean, [dx0, dy0, dx1, dy1]: readonly [number, number, number, number], fixture?: Fixture): Spot {
  return { x, y, left, wander: [x + dx0, y + dy0, x + dx1 + 1, y + dy1 + 1], fixture };
}

/** A spot it never leaves (a sleeper's bed). */
function stay(x: number, y: number, fixture: Fixture): Spot {
  return { x, y, left: false, wander: [x, y, x + 1, y + 1], fixture };
}

/**
 * How far a bunny strolls from its spot ([dx0, dy0, dx1, dy1], art pixels).
 * Up and down it goes only so far that the row behind still has room for
 * its tag, above the highest this row strolls.
 */
const ROAM: readonly [number, number, number, number] = [-8, -6, 8, 6];
const ROAM_FRONT: readonly [number, number, number, number] = [-8, -6, 8, 8];
const BACK_ROOM: readonly [number, number, number, number] = [-8, -6, 8, 4];
const YARD: readonly [number, number, number, number] = [-6, -6, 6, 3];
/** A worker at a fixture in front of it only steps back from it, never into it. */
const BACK: readonly [number, number, number, number] = [-12, -6, 0, 6];
const BACK_FRONT: readonly [number, number, number, number] = [-12, -6, 0, 8];

/**
 * The stations: the back rooms are the reading nook, the living room by the
 * fire and the bedroom; the front rooms the front hall (by the front door),
 * the forge and the studio; outside, the garden with its cart and the pond.
 */
export const STATIONS: Record<StationId, Station> = {
  hall: {
    id: "hall",
    label: "Front hall",
    work: "waiting on you or a teammate",
    about:
      "A worker waits here when it needs someone: a question it asked, or a decision its job or its run is stopped for. Whoever waits on you gets a spot before a teammate's, longest wait first; the rest are counted on the plaque's +N. Open the bunny to answer.",
    floor: [10, 224, 150, 420],
    plaque: [16, 228],
    spots: [at(48, 322, false, ROAM), at(110, 322, true, ROAM), at(48, 390, false, ROAM_FRONT), at(110, 390, true, ROAM_FRONT)],
    props: [
      [126, 230, 140, 272],
      [112, 252, 132, 268],
    ],
  },
  forge: {
    id: "forge",
    label: "Forge",
    work: "coding",
    about:
      "A worker at its run's coding stage works the forge, and so does a running session with no pipeline step underway. Nothing to do here: once the change is committed, the bunny walks to the pond for its tests.",
    floor: [156, 224, 360, 420],
    plaque: [162, 228],
    spots: [at(198, 322, false, BACK, "anvil"), at(294, 322, false, BACK, "anvil"), at(198, 390, false, BACK_FRONT, "anvil"), at(294, 390, false, BACK_FRONT, "anvil")],
    props: [
      [170, 220, 234, 266],
      [246, 226, 300, 252],
      [310, 232, 336, 262],
    ],
  },
  pond: {
    id: "pond",
    label: "Fishing pond",
    work: "running tests",
    about:
      "A run at its validation stage fishes here while the build, typecheck and tests run. If they fail, the run goes back to coding and the bunny walks back to the forge.",
    floor: [544, 228, 716, 420],
    plaque: [548, 405],
    spots: [at(584, 280, false, [-8, -3, 0, 3]), at(584, 340, false, [-8, -3, 0, 3]), at(584, 400, false, [-8, -3, 0, 3])],
    // The water (an oval filling this box), and the tackle box by the bank.
    props: [
      [604, 262, 714, 418],
      [554, 228, 588, 240],
    ],
  },
  nook: {
    id: "nook",
    label: "Reading nook",
    work: "reviewing, or a review packet waiting on you",
    about:
      "A run at its review stage reads here while reviewers try to refute the change; a High or Medium finding sends it back to the forge. A worker whose review packet waits on your decision reads here too, even asleep or ended: open it to review the packet.",
    floor: [10, 56, 186, 210],
    plaque: [16, 38],
    spots: [at(54, 132, false, BACK_ROOM), at(140, 132, true, BACK_ROOM), at(54, 200, false, BACK_ROOM), at(140, 200, true, BACK_ROOM)],
    props: [[152, 70, 172, 94]],
  },
  studio: {
    id: "studio",
    label: "Studio",
    work: "screenshots, opening the code review, the review packet",
    about:
      "A run takes its screenshots, opens its code review and writes its review packet at the easel. Once the packet is sent, the bunny moves to the reading nook while the packet waits on your review, or to the front hall with a red “!” when its run is stopped for your decision.",
    floor: [366, 224, 530, 420],
    plaque: [372, 228],
    spots: [at(408, 322, false, BACK, "easel"), at(492, 322, false, BACK, "easel"), at(408, 390, false, BACK_FRONT, "easel"), at(492, 390, false, BACK_FRONT, "easel")],
    props: [
      [374, 226, 446, 260],
      [462, 228, 518, 252],
    ],
  },
  garden: {
    id: "garden",
    label: "Garden and cart",
    work: "a live check or a deploy",
    about:
      "A run at its live check or deploy stage loads the cart in the garden: the change is running on an isolated instance, or going out to an environment. A failed check or deploy sends it back to the forge.",
    floor: [544, 56, 716, 214],
    plaque: [550, 40],
    spots: [at(586, 140, false, YARD), at(672, 140, true, YARD), at(586, 206, false, YARD), at(672, 206, true, YARD)],
    // The vegetable rows and the cart.
    props: [
      [548, 56, 654, 100],
      [660, 64, 712, 102],
    ],
  },
  living: {
    id: "living",
    label: "Living room",
    work: "idle, starting, landing the work",
    about:
      "A worker sits here while its run is starting or landing finished work, and when its session is idle with no pipeline step underway. An idle worker with nothing waiting may be done: open it to give it a next step, or close it.",
    floor: [192, 56, 354, 210],
    plaque: [196, 40],
    spots: [at(236, 132, false, BACK_ROOM), at(314, 132, true, BACK_ROOM), at(236, 200, false, BACK_ROOM), at(314, 200, true, BACK_ROOM)],
    // The two armchairs and the plant in the corner.
    props: [
      [202, 72, 238, 96],
      [306, 72, 342, 96],
      [336, 76, 352, 92],
    ],
  },
  bedroom: {
    id: "bedroom",
    label: "Bedroom",
    work: "paused (asleep) or gone quiet (dozing)",
    about:
      "A worker sleeps here when its run is parked, waiting on something outside it, or when its session was paused and can be resumed. One whose session has gone quiet dozes instead: if it stays quiet, open it to see whether it is stuck.",
    floor: [360, 56, 530, 210],
    plaque: [366, 40],
    spots: [stay(388, 120, "bed"), stay(444, 120, "bed"), stay(500, 120, "bed"), stay(402, 192, "futon"), stay(492, 192, "futon")],
    props: [[436, 72, 452, 84]],
  },
};

/**
 * Where each activity happens: coding at the forge, tests at the pond,
 * review in the reading nook, screenshots, the code review and the packet in the
 * studio, a live check or deploy out at the garden cart, waiting by the front
 * door, idle in the living room, and asleep or dozing in the bedroom.
 */
const ACTIVITY_STATION: Record<BunnyActivity, StationId> = {
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

export function stationFor(activity: BunnyActivity): StationId {
  return ACTIVITY_STATION[activity];
}

/** How far out a fisher's bobber lands, from its feet (the art draws the rod and line to it). */
export const ROD_REACH = 47;

/** Where a fisher's bobber lands, from its feet: out over the water on the side it faces. */
export function bobberSpot(spot: Pick<Spot, "x" | "y" | "left">): { x: number; y: number } {
  return { x: spot.x + (spot.left ? -ROD_REACH : ROD_REACH), y: spot.y - 2 };
}

/** Whether a point is in the pond's water: the oval filling its first prop box. */
export function inWater(x: number, y: number): boolean {
  const [x0, y0, x1, y1] = STATIONS.pond.props[0];
  const rx = (x1 - 1 - x0) / 2;
  const ry = (y1 - 1 - y0) / 2;
  const dx = (x - (x0 + rx)) / rx;
  const dy = (y - (y0 + ry)) / ry;
  return dx * dx + dy * dy < 1;
}

/**
 * Where a spot's name tag sits, worked out once for the whole house: `rise`
 * art pixels above its bunny's head at the spot (clear of the highest it
 * strolls, raised further when a neighbour's tag needs the room), `width`
 * wide, shifted `dx` from centred to stay inside its station's walls,
 * filling `box` (art pixels). The tag stays put while its bunny strolls
 * round the spot (the view holds it there); it only rides along when the
 * bunny walks to a new spot.
 */
export interface TagPlace {
  rise: number;
  width: number;
  dx: number;
  box: Box;
}

/** A bunny's height above its feet, art pixels: a tag sits on top of it. */
const BODY_H = 33;
/**
 * A tag's height in art pixels, with a pixel of air: a tag is 22 CSS pixels
 * tall, which is about 15 art pixels at TAG_MIN_SCALE, the smallest scale
 * that shows tags; at any larger scale it is shorter still.
 */
export const TAG_H = 16;
/** The smallest scale (CSS pixels per art pixel) at which the view shows tags. */
export const TAG_MIN_SCALE = 1.5;
/** The widest a tag runs (art pixels: about 24 characters at 2x), and the narrowest. */
const TAG_MAX = 112;
const TAG_MIN = 56;
/** How many tag heights above its bunny a tag may be raised to find room. */
const TAG_LEVELS = 3;

const overlap = (a: Box, b: Box) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];

/** A station's plaque (with room for a "+N"), as tags must keep clear of it, art pixels. */
export function plaqueBox(s: Station): Box {
  const w = Math.ceil((s.label.length * 6.6 + 30 + 24) / TAG_MIN_SCALE);
  return [s.plaque[0], s.plaque[1], s.plaque[0] + w, s.plaque[1] + Math.ceil(22 / TAG_MIN_SCALE)];
}

/**
 * The space a bunny takes for a tag to keep clear of: wherever it strolls,
 * from its ears to its feet, with its tool and its trailing subagents (its
 * footprint); a sleeper, its bed.
 */
export function bodyBox(spot: Spot): Box {
  if (spot.fixture === "bed" || spot.fixture === "futon") return fixtureBox(spot)!;
  const [x0, , x1, y1] = footprint(spot);
  return [x0, spot.wander[1] - BODY_H, x1, y1];
}

/** A tag is raised (and has a stem down to its bunny) once it is more than half a tag height above its bunny's head. */
export function hasStem(t: Pick<TagPlace, "rise">): boolean {
  return t.rise > TAG_H / 2;
}

/** A raised tag's stem: a 2-pixel column from the tag's bottom down to its bunny's head at its highest stroll. */
export function stemBox(spot: Spot, t: TagPlace): Box | undefined {
  if (!hasStem(t)) return undefined;
  return [spot.x - 1, t.box[3], spot.x + 1, spot.wander[1] - BODY_H];
}

/**
 * The tags a spot could have at `lift`, `width` wide, kept inside its
 * station's walls: over its bunny leaning away from the station's middle
 * (so two side by side lean apart), then centred, then leaning the other way.
 */
function tagsAt(spot: Spot, floor: Box, lift: number, width: number): TagPlace[] {
  // Above the highest its bunny strolls, then `lift` more.
  const bottom = spot.wander[1] - BODY_H - lift;
  const centred = spot.x - width / 2;
  const outward = spot.x < (floor[0] + floor[2]) / 2 ? spot.x + 15 - width : spot.x - 15;
  const inward = spot.x < (floor[0] + floor[2]) / 2 ? spot.x - 15 : spot.x + 15 - width;
  return [outward, centred, inward].map((want) => {
    const x0 = Math.min(Math.max(want, floor[0] + 1), floor[2] - 1 - width);
    return { rise: spot.y - BODY_H - bottom, width, dx: x0 - centred, box: [x0, bottom - TAG_H, x0 + width, bottom] as Box };
  });
}

/**
 * Each spot's tag placement, by "station:index". Station by station, back
 * row first, each tag takes the lowest height (on its bunny's head, or one,
 * two tag heights up) where it is clear of every tag placed so far, every
 * plaque, and every other bunny wherever it strolls; each row takes the
 * widest width, up to TAG_MAX, at which every tag in it finds such a place.
 * A raised tag has a stem down to its bunny (the view draws it).
 */
export const TAG_PLACES: ReadonlyMap<string, TagPlace> = (() => {
  const stations = Object.values(STATIONS) as Station[];
  const all = stations.flatMap((s) => s.spots.map((spot, i) => ({ key: `${s.id}:${i}`, spot })));
  const plaques = stations.map(plaqueBox);
  const placed = new Map<string, TagPlace>();
  const spotOf = new Map(all.map((a) => [a.key, a.spot]));
  const clear = (key: string, t: TagPlace, also: ReadonlyMap<string, TagPlace>) => {
    const others = [...placed.entries(), ...also.entries()];
    const mine = stemBox(spotOf.get(key)!, t);
    return (
      t.box[1] >= 0 &&
      !others.some(([, o]) => overlap(o.box, t.box)) &&
      // A stem crosses no other tag, and no tag covers another's stem: each reads as its own bunny's.
      !others.some(([k, o]) => (mine && overlap(mine, o.box)) || overlap(stemBox(spotOf.get(k)!, o) ?? [0, 0, 0, 0], t.box)) &&
      !plaques.some((p) => overlap(p, t.box)) &&
      !all.some((o) => o.key !== key && overlap(bodyBox(o.spot), t.box))
    );
  };
  for (const s of stations) {
    const rows = [...new Set(s.spots.map((p) => p.y))].sort((a, b) => a - b);
    const widest = Math.min(TAG_MAX, s.floor[2] - s.floor[0] - 2);
    for (const y of rows) {
      const row = s.spots.map((spot, i) => ({ key: `${s.id}:${i}`, spot })).filter((r) => r.spot.y === y);
      let fitted: Map<string, TagPlace> | undefined;
      for (let cap = widest; cap >= TAG_MIN && !fitted; cap -= 4) {
        const trial = new Map<string, TagPlace>();
        for (const { key, spot } of row) {
          let chosen: TagPlace | undefined;
          for (let level = 0; level < TAG_LEVELS && !chosen; level++) {
            chosen = tagsAt(spot, s.floor, level * TAG_H, cap).find((t) => clear(key, t, trial));
          }
          if (!chosen) break;
          trial.set(key, chosen);
        }
        if (trial.size === row.length) fitted = trial;
      }
      for (const { key, spot } of row) placed.set(key, fitted?.get(key) ?? tagsAt(spot, s.floor, 0, TAG_MIN)[1]);
    }
  }
  return placed;
})();

/** Where a bunny that just appeared starts: the front door's threshold. */
export const SPAWN: readonly [number, number] = [16, 330];

export interface Placement<T> {
  item: T;
  station: StationId;
  /** Which of the station's spots it has. */
  spot: number;
  /** The spot (feet, art pixels). */
  x: number;
  y: number;
}

export interface RoomLayout<T> {
  placed: Placement<T>[];
  /** Workers beyond a station's spots, per station: listed and counted on its plaque, not drawn. */
  overflow: Partial<Record<StationId, T[]>>;
}

/** Each bunny's spot from the last layout, by id: what keeps it where it stands. */
export type SpotMemory = ReadonlyMap<string, { station: StationId; spot: number }>;

/**
 * Gives each item a spot at its station. A station draws as many items as
 * it has spots: those of the best tier first (a lower tierOf), and within a
 * tier a bunny already standing there before one arriving (so one arriving
 * never bumps one that stayed put), then input order. Of the drawn, a bunny
 * whose station hasn't changed keeps the spot it had (so one bunny leaving
 * never reshuffles the rest); the others take the station's first free
 * spots. The rest are listed as overflow, in input order.
 */
export function layoutRoom<T>(
  items: T[],
  activityOf: (item: T) => BunnyActivity,
  idOf: (item: T) => string,
  memory: SpotMemory = new Map(),
  tierOf: (item: T) => number = () => 0
): RoomLayout<T> {
  const taken = new Map<StationId, Set<number>>();
  const kept = new Map<T, number>();
  const stationOf = new Map<T, StationId>();
  const holds = new Map<T, number>();
  const atStation = new Map<StationId, T[]>();
  for (const item of items) {
    const station = stationFor(activityOf(item));
    stationOf.set(item, station);
    const had = memory.get(idOf(item));
    if (had && had.station === station && had.spot < STATIONS[station].spots.length) holds.set(item, had.spot);
    const list = atStation.get(station);
    if (list) list.push(item);
    else atStation.set(station, [item]);
  }
  const drawn = new Set<T>();
  for (const [station, list] of atStation) {
    const order = list
      .map((item, i) => ({ item, key: [tierOf(item), holds.has(item) ? 0 : 1, i] }))
      .sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1] || a.key[2] - b.key[2]);
    for (const { item } of order.slice(0, STATIONS[station].spots.length)) drawn.add(item);
  }
  for (const item of items) {
    const station = stationOf.get(item)!;
    const used = taken.get(station) ?? new Set<number>();
    taken.set(station, used);
    const had = holds.get(item);
    if (drawn.has(item) && had !== undefined && !used.has(had)) {
      used.add(had);
      kept.set(item, had);
    }
  }
  const placed: Placement<T>[] = [];
  const overflow: Partial<Record<StationId, T[]>> = {};
  for (const item of items) {
    const station = stationOf.get(item)!;
    const spots = STATIONS[station].spots;
    let spot = kept.get(item);
    if (spot === undefined && drawn.has(item)) {
      const used = taken.get(station)!;
      for (let i = 0; i < spots.length; i++) {
        if (!used.has(i)) {
          spot = i;
          used.add(i);
          break;
        }
      }
    }
    if (spot === undefined) {
      (overflow[station] ??= []).push(item);
      continue;
    }
    placed.push({ item, station, spot, x: spots[spot].x, y: spots[spot].y });
  }
  return { placed, overflow };
}

/** The spots of a layout, to keep bunnies where they stand next time. */
export function spotMemory<T>(layout: RoomLayout<T>, idOf: (item: T) => string): SpotMemory {
  return new Map(layout.placed.map((p) => [idOf(p.item), { station: p.station, spot: p.spot }]));
}

/** How far a walking bunny moves per animation tick, in art pixels. */
export const WALK_SPEED = 3;
/** How far a wandering bunny moves per tick: a slow amble. */
export const WANDER_SPEED = 0.75;

export interface Walker {
  x: number;
  y: number;
  /** Facing left (walking or last walked leftwards). */
  left: boolean;
  /** Ticks spent walking so far: drives the stride; 0 when standing. */
  steps: number;
  /** Ticks since it last arrived at a spot after a walk (for the arrival puff); -1 once it has faded. */
  arrived: number;
  /** The spot it has reached and now wanders around ("station:index"), once it has. */
  home?: string;
}

/** How many ticks the little puff of an arrival lasts. */
export const ARRIVAL_TICKS = 8;

/**
 * One tick of a bunny walking towards (tx, ty) at `speed`: it moves straight
 * there, arriving exactly, and faces the way it goes. An arrival starts the
 * arrival puff unless `quiet` (a wander's step back to its spot); standing,
 * it counts the ticks since it arrived until the puff has faded.
 */
export function stepToward(w: Walker, tx: number, ty: number, speed = WALK_SPEED, quiet = false): Walker {
  const dx = tx - w.x;
  const dy = ty - w.y;
  const d = Math.hypot(dx, dy);
  const left = dx < 0 ? true : dx > 0 ? false : w.left;
  if (d === 0) {
    if (w.steps !== 0) return { ...w, steps: 0 };
    if (w.arrived < 0) return w;
    return { ...w, arrived: w.arrived + 1 >= ARRIVAL_TICKS ? -1 : w.arrived + 1 };
  }
  if (d <= speed) return { ...w, x: tx, y: ty, left, steps: 0, arrived: quiet ? -1 : 0 };
  return { ...w, x: w.x + (dx / d) * speed, y: w.y + (dy / d) * speed, left, steps: w.steps + 1, arrived: -1 };
}

/** The ticks of one wander cycle: a stroll out, a short look around, and back to work. */
const WANDER_OUT = 40;
/** The shortest and longest wait between strolls, in ticks (about 6 to 13 seconds at 12 fps). */
const WANDER_MIN = 72;
const WANDER_SPAN = 84;

function hash(a: number, b: number): number {
  let h = (a * 374761393 + b * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * Where a bunny at home at `spot` is headed at `tick`: its spot, except now
 * and then — every six to thirteen seconds, staggered by `seed` and skipped
 * at random a third of the time — a short stroll to a point in its wander
 * box, a pause there, and back. The same seed and tick always give the same
 * answer. A spot it never leaves (a bed) keeps it home.
 */
export function wanderTarget(seed: number, tick: number, spot: Spot): { x: number; y: number } {
  const [x0, y0, x1, y1] = spot.wander;
  if (x1 - x0 <= 1 && y1 - y0 <= 1) return { x: spot.x, y: spot.y };
  const period = WANDER_MIN + Math.floor(hash(seed, 7) * WANDER_SPAN);
  const t = tick + Math.floor(hash(seed, 11) * period);
  const cycle = Math.floor(t / period);
  const phase = t % period;
  if (phase >= WANDER_OUT || hash(seed, cycle) < 0.34) return { x: spot.x, y: spot.y };
  return {
    x: Math.round(x0 + hash(cycle, seed + 1) * (x1 - 1 - x0)),
    y: Math.round(y0 + hash(seed + 2, cycle) * (y1 - 1 - y0)),
  };
}

/** Whether a point is inside a box. */
export function within([x0, y0, x1, y1]: Box, x: number, y: number): boolean {
  return x >= x0 && x < x1 && y >= y0 && y < y1;
}

/**
 * The walkers for the current targets: a known bunny keeps its position (it
 * will walk to its new spot); a new one appears at the front door, or right
 * at its spot when `snap` (reduced motion, or before the room has settled, so
 * it never opens with everyone filing in) or when it was already in the
 * burrow, listed past a full station (`seen`); one no longer listed is
 * dropped. A bunny put right at its spot is home there (`key`) at once.
 */
export function reconcileWalkers(
  prev: ReadonlyMap<string, Walker>,
  targets: ReadonlyArray<{ id: string; x: number; y: number; key?: string }>,
  snap: boolean,
  seen: ReadonlySet<string> = new Set()
): Map<string, Walker> {
  const next = new Map<string, Walker>();
  for (const t of targets) {
    const had = prev.get(t.id);
    if (snap || (!had && seen.has(t.id))) next.set(t.id, { x: t.x, y: t.y, left: had?.left ?? false, steps: 0, arrived: -1, home: t.key });
    // A bunny given a different spot is no longer home: it walks there (even back to a spot it left mid-walk).
    else if (had && had.home !== undefined && had.home !== t.key) next.set(t.id, { ...had, home: undefined });
    else next.set(t.id, had ?? { x: SPAWN[0], y: SPAWN[1], left: false, steps: 0, arrived: -1 });
  }
  return next;
}
