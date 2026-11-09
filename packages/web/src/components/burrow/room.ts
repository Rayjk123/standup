import type { BunnyActivity } from "../../lib/burrow";
import { ARRIVAL_TICKS, ROD_REACH, ROOM, STATIONS, fixtureBox, type Spot, type Station } from "../../lib/burrowRoom";

/*
 * The Burrow's art: a cutaway single-story house seen from slightly above,
 * a room per kind of work, with the yard outside (a garden and a pond), and
 * small chibi bunnies. The scene is painted once per light (golden hour or
 * evening) into a background canvas, its fixtures (anvils, easels, beds)
 * and its lamp, fire and forge glow baked in; each frame blits it, then the
 * flames and the water, and the bunnies with whatever their work has them
 * doing. A bunny is a palette-indexed grid built from blobs with a thick
 * outline, made once per pose and fur colour and blitted with smoothing off;
 * its accessory and its tool are a few rects on top.
 */

const W = ROOM.w;
const H = ROOM.h;

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;

export const OUT = "#2a1a1e";

export const P = {
  floor: ["#b97e50", "#b07548", "#c08654", "#a46c42"],
  floorSeam: "#8a5636",
  wallTop: "#e9c79a",
  wall: "#d9b07e",
  wainscot: "#8a5a38",
  wainscotLight: "#a8734a",
  trim: "#6e4228",
  rug: "#c0564a",
  rugDark: "#8e3a3a",
  rugGold: "#e8b85a",
  rugBlue: "#5a7ab0",
  rugBlueDark: "#3f5888",
  rugLilac: "#a888c8",
  rugLilacDark: "#7a5a9a",
  wood: "#a8693e",
  woodLight: "#c98a52",
  woodDark: "#6e4228",
  stone: "#9a8e88",
  stoneLight: "#bcb0a6",
  stoneDark: "#6e6260",
  flag: ["#8e8682", "#9a928c", "#857c78"],
  tile: ["#d8c8a8", "#c4b08c"],
  fire: ["#fff1a8", "#ffc94a", "#ff8a2a", "#e0502a"],
  leaf: "#5aa84a",
  leafLight: "#8fd060",
  leafDark: "#2e7040",
  pot: "#c8643a",
  potDark: "#904428",
  glass: "#a8dcf0",
  skyGolden: "#f8c27a",
  skyEvening: "#2a3060",
  paper: "#f6ecd6",
  paperShade: "#d8c8a8",
  metal: "#8a92a0",
  metalLight: "#c4ccd6",
  metalDark: "#565c68",
  red: "#d0484a",
  blue: "#4a6ec0",
  green: "#4c9a5a",
  greenDark: "#2a5a34",
  mustard: "#e0a83a",
  pink: "#e86a8a",
  cream: "#f4e2c0",
  grass: "#7cbc54",
  grassDark: "#5a9a40",
  grassLight: "#94d064",
  water: "#4a9ad0",
  waterDark: "#3a78b0",
  waterLight: "#8ccaf0",
  soil: "#7a4a2e",
  soilDark: "#5a341e",
  shadow: "rgba(40,20,10,0.28)",
};

function hash(a: number, b: number): number {
  let h = (a * 374761393 + b * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export function makeCanvas(w: number, h: number): { canvas: AnyCanvas; ctx: Ctx } | null {
  if (typeof OffscreenCanvas === "function") {
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d");
    if (ctx) return { canvas, ctx };
  }
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  return ctx ? { canvas, ctx } : null;
}

// ---------------------------------------------------------------------------
// Drawing helpers (on whichever context is current)
// ---------------------------------------------------------------------------
let c!: Ctx;

function rect(x: number, y: number, w: number, h: number, color: string): void {
  c.fillStyle = color;
  c.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
}
function px(x: number, y: number, color: string): void {
  rect(x, y, 1, 1, color);
}
function box(x: number, y: number, w: number, h: number, color: string, o = OUT): void {
  rect(x, y, w, h, o);
  rect(x + 1, y + 1, w - 2, h - 2, color);
}
function ellipse(cx: number, cy: number, rx: number, ry: number, color: string): void {
  c.fillStyle = color;
  for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
    for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
      const dx = (x + 0.5 - cx) / rx;
      const dy = (y + 0.5 - cy) / ry;
      if (dx * dx + dy * dy <= 1) c.fillRect(x, y, 1, 1);
    }
  }
}
function line(x0: number, y0: number, x1: number, y1: number, color: string): void {
  const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
  for (let i = 0; i <= n; i++) px(Math.round(x0 + ((x1 - x0) * i) / n), Math.round(y0 + ((y1 - y0) * i) / n), color);
}

// ---------------------------------------------------------------------------
// Bunnies
// ---------------------------------------------------------------------------
export type Grid = readonly string[];

export interface Fur {
  F: string;
  D: string;
  L: string;
}
export const FURS: Record<string, Fur> = {
  tan: { F: "#d29a72", D: "#9a4a46", L: "#eebc94" },
  white: { F: "#f6f0ea", D: "#c8b6d6", L: "#ffffff" },
  grey: { F: "#a9a4b2", D: "#6e6480", L: "#d2cdd8" },
  brown: { F: "#9a6442", D: "#62343a", L: "#c08a62" },
  cream: { F: "#efd6a8", D: "#c08e6a", L: "#fff0ce" },
};
const EYES = ["#4caf3a", "#4a8ad0", "#8a5ac8", "#c07a2a"];

export type Accessory = "straw" | "bow" | "beanie" | "glasses" | "scarf" | "cap" | "flower";
const ACCESSORIES: Accessory[] = ["straw", "bow", "beanie", "glasses", "scarf", "cap", "flower"];

export interface Look {
  fur: keyof typeof FURS;
  eye: string;
  accessory: Accessory;
}

/** A bunny's look from its session id: the same worker always looks the same. */
export function lookFor(id: string): Look {
  let n = 0;
  for (let i = 0; i < id.length; i++) n = (n * 31 + id.charCodeAt(i)) | 0;
  const furs = Object.keys(FURS) as Array<keyof typeof FURS>;
  return {
    fur: furs[Math.floor(hash(n, 1) * furs.length)],
    eye: EYES[Math.floor(hash(n, 2) * EYES.length)],
    accessory: ACCESSORIES[Math.floor(hash(n, 3) * ACCESSORIES.length)],
  };
}

export type Tool = "hammer" | "rod" | "book" | "brush" | "crate" | "letter" | "mug";

/** What a bunny holds for its work; asleep and quiet bunnies hold nothing. */
export function toolFor(activity: BunnyActivity): Tool | undefined {
  switch (activity) {
    case "smithing":
      return "hammer";
    case "fishing":
      return "rod";
    case "cooking":
      return "book";
    case "painting":
      return "brush";
    case "gardening":
      return "crate";
    case "sign":
      return "letter";
    case "idle":
      return "mug";
    default:
      return undefined;
  }
}

interface BunnyPose {
  blink?: boolean;
  twitch?: boolean;
  stride?: 0 | 1 | 2;
  pawUp?: boolean;
  /** Ears drooping back: dozing. */
  droop?: boolean;
}

function blob(g: string[][], cx: number, cy: number, rx: number, ry: number, ch: string, angle = 0, keep?: (v: string) => boolean): void {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const r = Math.max(rx, ry) + 1;
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
    for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
      if (y < 0 || x < 0 || y >= g.length || x >= g[0].length) continue;
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const u = (dx * cos + dy * sin) / rx;
      const v = (-dx * sin + dy * cos) / ry;
      if (u * u + v * v <= 1 && (!keep || keep(g[y][x]))) g[y][x] = ch;
    }
  }
}

/** The bunny is designed on a 30x33 grid and built at this many times that. */
const BUNNY_SCALE = 1;
export const BUNNY_W = Math.ceil(30 * BUNNY_SCALE);
export const BUNNY_H = Math.ceil(33 * BUNNY_SCALE);

/**
 * A chibi bunny facing right: a big round head (half its height), long ears
 * with pink insides, a big eye with a highlight, blush, a white muzzle, chest
 * and tail, stubby feet, and a thick dark outline. Characters: k outline,
 * F/D/L fur (base, shade, light), W/w white and its shade, P pink, B blush,
 * H eye highlight, G eye colour.
 */
export function makeBunny(pose: BunnyPose, s = BUNNY_SCALE): Grid {
  const w = Math.ceil(30 * s);
  // A small grid rounds its ear tips and feet outwards: two more rows keep them outlined.
  const small = s < 0.8;
  const h = Math.ceil(33 * s) + (small ? 2 : 0);
  const g = Array.from({ length: h }, () => Array<string>(w).fill("."));
  // A stride lifts the bunny a row; the top rows of margin keep its ear tips outlined.
  const bob = pose.stride ? -1 : 0;
  const y0 = (small ? 4 : 2) + bob;
  const b = (cx: number, cy: number, rx: number, ry: number, ch: string, angle = 0, keep?: (v: string) => boolean) =>
    blob(g, cx * s, (cy + y0) * s, rx * s, ry * s, ch, angle, keep);
  const set = (x: number, y: number, ch: string) => {
    const yy = Math.round((y + y0) * s);
    const xx = Math.round(x * s);
    if (g[yy] && xx >= 0 && xx < w) g[yy][xx] = ch;
  };
  // Ears: the back ear darker and upright, the front ear long and leaning
  // back; dozing, both droop further back.
  b(12, 6, 2.4, 6.2, "D", pose.droop ? -0.5 : pose.twitch ? -0.25 : -0.12);
  const earFront = pose.droop ? -0.85 : pose.twitch ? -0.62 : -0.42;
  b(16.5, 6.2, 3.3, 7, "F", earFront);
  b(16.8, 6.8, 1.6, 5, "P", earFront);
  // A small body, the tail and the chest.
  b(13, 23.5, 6.6, 5, "F");
  b(13, 25.5, 6, 3, "D", 0, (v) => v === "F");
  b(6, 23, 3, 3, "W");
  b(6.5, 24.3, 2, 1.5, "w", 0, (v) => v === "W");
  b(17, 22, 2.8, 3.2, "W");
  // Stubby feet, stepping on the strides.
  const fb = pose.stride === 1 ? -1.5 : pose.stride === 2 ? 1.5 : 0;
  b(9 + fb, 28.4 - bob, 3.2, 1.6, "D");
  b(17 - fb, 28.4 - bob, 3.4, 1.7, "W");
  // The big round head, lit from the upper left.
  b(15, 14.5, 9.2, 8.3, "F");
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (g[y][x] !== "F") continue;
      const dx = (x + 0.5) / s - 15;
      const dy = (y + 0.5) / s - (y0 + 14.5);
      if (dx * dx + dy * dy < 85 && dx + dy < -8) g[y][x] = "L";
      if (dx * dx + dy * dy < 85 && dx * 0.6 + dy > 6) g[y][x] = "D";
    }
  }
  b(20.5, 17.4, 3.8, 3, "W");
  // The face: an eye sized for the grid (a subagent's is two pixels across).
  const ex = Math.round(17.6 * s);
  const ey = Math.round((y0 + 11.6) * s);
  const eye =
    s < 0.8
      ? pose.blink
        ? ["..", "kk"]
        : ["kk", "kG"]
      : pose.blink
        ? ["...", "...", "kkk", ".kk"]
        : [".kk", "kHk", "kkk", "kGG"];
  eye.forEach((row, j) => [...row].forEach((ch, i) => ch !== "." && g[ey + j] && (g[ey + j][ex + i] = ch)));
  set(15.6, 17, "B");
  set(17.2, 17.2, "B");
  set(23.6, 16, "P");
  // The front paw: by the chest, or raised to hold something.
  b(20, pose.pawUp ? 20 : 22, 2.2, 1.9, "W");
  // The thick outline.
  const out = g.map((r) => r.slice());
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (g[y][x] !== ".") continue;
      if ([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => g[y + dy]?.[x + dx] && g[y + dy][x + dx] !== ".")) out[y][x] = "k";
    }
  }
  return out.map((r) => r.join(""));
}

export const POSES = {
  stand: makeBunny({}),
  blink: makeBunny({ blink: true }),
  twitch: makeBunny({ twitch: true }),
  stride1: makeBunny({ stride: 1 }),
  stride2: makeBunny({ stride: 2 }),
  hold: makeBunny({ pawUp: true }),
  holdBlink: makeBunny({ pawUp: true, blink: true }),
  holdStride1: makeBunny({ pawUp: true, stride: 1 }),
  holdStride2: makeBunny({ pawUp: true, stride: 2 }),
  doze: makeBunny({ blink: true, droop: true }),
};
export type PoseName = keyof typeof POSES;

/** A subagent: the same bunny, small, trotting after its worker. */
const TINY_SCALE = 0.6;
export const TINY_POSES = {
  stand: makeBunny({}, TINY_SCALE),
  blink: makeBunny({ blink: true }, TINY_SCALE),
  stride1: makeBunny({ stride: 1 }, TINY_SCALE),
  stride2: makeBunny({ stride: 2 }, TINY_SCALE),
};
type TinyPoseName = keyof typeof TINY_POSES;

const spriteCache = new Map<string, AnyCanvas | null>();

function sprite(pose: PoseName | `tiny:${TinyPoseName}`, look: Look): AnyCanvas | null {
  const key = `${pose}:${look.fur}:${look.eye}`;
  if (spriteCache.has(key)) return spriteCache.get(key)!;
  const g = pose.startsWith("tiny:") ? TINY_POSES[pose.slice(5) as TinyPoseName] : POSES[pose as PoseName];
  const made = makeCanvas(g[0].length, g.length);
  if (made) {
    const fur = FURS[look.fur];
    const map: Record<string, string> = { k: OUT, F: fur.F, D: fur.D, L: fur.L, W: "#ffffff", w: "#d8cce6", P: "#e8506e", B: "#f39aa8", H: "#ffffff", G: look.eye };
    for (let j = 0; j < g.length; j++) {
      for (let i = 0; i < g[j].length; i++) {
        const color = map[g[j][i]];
        if (!color) continue;
        made.ctx.fillStyle = color;
        made.ctx.fillRect(i, j, 1, 1);
      }
    }
  }
  spriteCache.set(key, made?.canvas ?? null);
  return made?.canvas ?? null;
}

/** Blits a sprite at (gx, gy), mirrored when it faces left; `rows` crops it to its top rows (tucked in bed). */
function blit(ctx: Ctx, img: AnyCanvas, gx: number, gy: number, left: boolean, rows?: number): void {
  const w = img.width;
  const h = rows ?? img.height;
  if (left) {
    ctx.save();
    ctx.translate(gx + w, gy);
    ctx.scale(-1, 1);
    ctx.drawImage(img as CanvasImageSource, 0, 0, w, h, 0, 0, w, h);
    ctx.restore();
  } else {
    ctx.drawImage(img as CanvasImageSource, 0, 0, w, h, gx, gy, w, h);
  }
}

/** An accessory in the bunny's own 30x33 design grid, mirrored when it faces left. */
function accessory(a: Accessory, gx: number, gy: number, left: boolean, lift: number): void {
  const at = (x: number, y: number, w: number, h: number, color: string) => {
    const s = BUNNY_SCALE;
    const sw = Math.max(1, Math.round(w * s));
    const sx = Math.round(x * s);
    rect(left ? gx + (BUNNY_W - sx - sw) : gx + sx, gy + Math.round((y + 1) * s) + lift, sw, Math.max(1, Math.round(h * s)), color);
  };
  if (a === "straw") {
    at(7, 6, 17, 3, OUT);
    at(8, 7, 15, 1, "#e8c466");
    at(10, 3, 11, 4, OUT);
    at(11, 4, 9, 3, "#f2d47e");
    at(11, 6, 9, 1, P.red);
  } else if (a === "bow") {
    at(19, 3, 7, 5, OUT);
    at(20, 4, 2, 3, P.pink);
    at(23, 4, 2, 3, P.pink);
  } else if (a === "beanie") {
    at(8, 5, 15, 5, OUT);
    at(9, 6, 13, 3, P.blue);
    at(14, 3, 3, 3, OUT);
  } else if (a === "glasses") {
    at(16, 12, 6, 4, OUT);
    at(17, 13, 4, 2, "#c8e8f8");
  } else if (a === "scarf") {
    at(9, 20, 13, 3, OUT);
    at(10, 21, 11, 1, P.green);
  } else if (a === "cap") {
    at(9, 5, 13, 4, OUT);
    at(10, 6, 11, 2, P.red);
    at(19, 8, 7, 2, OUT);
  } else {
    at(9, 6, 5, 5, OUT);
    at(10, 7, 3, 3, P.mustard);
  }
}

/**
 * The tool in a bunny's paw, and its work when `working` (at its spot, the
 * loop running): `f` is the work's slow frame, `i` a per-bunny offset. Away
 * from its spot (walking, wandering) or still, it just holds the tool.
 */
function tool(kind: Tool, x: number, feet: number, left: boolean, f: number, i: number, working: boolean): void {
  const d = left ? -1 : 1;
  const hx = x + d * 7;
  const hy = feet - 14;
  if (kind === "hammer") {
    // Up on two beats, down on the anvil with sparks on the next two.
    const down = working && f % 4 >= 2;
    const ex = hx + d * (down ? 9 : 3);
    const ey = hy + (down ? 2 : -9);
    line(hx, hy, ex, ey, OUT);
    line(hx, hy + 1, ex, ey + 1, P.woodLight);
    box(ex - 3, ey - 2, 6, 4, P.metal);
    if (working) {
      const ax = x + d * 23;
      rect(ax - 4, feet - 10, 7, 2, f % 4 < 2 ? P.fire[1] : P.fire[2]);
      if (down) {
        for (let k = 0; k < 5; k++) {
          const a = -Math.PI / 2 + (k - 2) * 0.55;
          const r = 3 + hash(k, f) * 5;
          px(ax + Math.cos(a) * r, feet - 11 + Math.sin(a) * r, k % 2 ? P.fire[0] : P.fire[1]);
        }
      }
    }
  } else if (kind === "rod") {
    // Cast over the water: the line to a bobber that dips, ripples round it, a fish now and then.
    const bite = working && (f + i * 17) % 60 > 50;
    const tipX = hx + d * (working ? 22 : 4);
    const tipY = hy - (working ? (bite ? 10 : 15) : 16);
    line(hx, hy, tipX, tipY, OUT);
    line(hx + d, hy, tipX, tipY + 1, P.woodLight);
    if (!working) return;
    const bx = x + d * ROD_REACH;
    const by = feet - 2 + ((f + i * 5) % 8 < 4 ? 0 : 1) + (bite ? 2 : 0);
    line(tipX, tipY, bx, by - 1, "#e8e8f0");
    const r = ((f + i * 7) % 12) / 2;
    ellipse(bx, by + 1, 3 + r, 1 + r / 3, P.waterLight);
    ellipse(bx, by + 1, 2 + r, r / 3 + 0.5, P.water);
    rect(bx - 1, by - 2, 3, 2, "#ffffff");
    rect(bx - 1, by, 3, 1, P.red);
    if (bite) {
      const fx = bx + d * 6;
      const fy = by - 5 - (f % 4 < 2 ? 1 : 0);
      ellipse(fx, fy, 3.5, 2, OUT);
      ellipse(fx, fy, 2.5, 1.2, P.mustard);
    }
  } else if (kind === "book") {
    const bx = x + d * 9;
    const by = feet - 16;
    box(bx - 6, by - 5, 12, 7, P.blue);
    rect(bx - 5, by - 4, 5, 5, P.paper);
    rect(bx, by - 4, 5, 5, P.paperShade);
    for (let k = 0; k < 2; k++) {
      rect(bx - 4, by - 3 + k * 2, 3, 1, P.metal);
      rect(bx + 1, by - 3 + k * 2, 3, 1, P.metal);
    }
    if (working && (f + i * 9) % 16 < 2) box(bx - 1, by - 8, 5, 4, P.paper);
  } else if (kind === "brush") {
    // Dabbing at the easel, whose canvas fills in as it works.
    const dab = working && f % 4 < 2;
    line(hx, hy, hx + d * (dab ? 6 : 4), hy - (dab ? 6 : 8), P.woodDark);
    const cols = [P.blue, P.red, P.leaf, P.mustard];
    px(hx + d * (dab ? 6 : 4), hy - (dab ? 7 : 9), cols[i % 4]);
    if (working) {
      const ex = x + d * 24;
      const done = ((f + i * 13) % 40) / 40;
      for (let k = 0; k < Math.ceil(done * 6); k++) rect(ex - 6 + (k % 3) * 4, feet - 24 + Math.floor(k / 3) * 5, 3, 3, cols[(k + i) % 4]);
    }
  } else if (kind === "crate") {
    if (i % 2 === 0) {
      // A crate of produce for the cart.
      const bx = x + d * 8;
      const by = feet - 12 - (working && f % 4 >= 2 ? 1 : 0);
      box(bx - 6, by - 7, 12, 8, P.woodLight);
      rect(bx - 5, by - 4, 10, 1, P.woodDark);
      ellipse(bx - 2, by - 8, 2.5, 2, P.pot);
      ellipse(bx + 2, by - 8, 2.5, 2, P.leaf);
    } else {
      // A watering can, tipped over the rows.
      const tilt = working && f % 4 < 2;
      const cx = x + d * 9;
      box(cx - 4, feet - 16, 8, 6, P.green, P.greenDark);
      line(cx + d * 4, feet - 13, cx + d * 8, feet - (tilt ? 12 : 16), P.greenDark);
      if (tilt) for (let k = 0; k < 3; k++) px(cx + d * (8 + k), feet - 10 + k * 2 + (f % 2), P.glass);
    }
  } else if (kind === "mug") {
    const mx = x + d * 9;
    box(mx - 2, feet - 15, 5, 5, P.cream);
    if (working) for (let k = 0; k < 3; k++) px(mx + Math.round(Math.sin((f + k * 3) / 3)), feet - 17 - k * 2 - (f % 3), "#ffffff");
  } else {
    // A letter held up for whoever it waits on.
    const lx = x + d * 9;
    const ly = feet - 22 - (working && f % 6 >= 3 ? 1 : 0);
    box(lx - 4, ly, 9, 7, P.paper);
    line(lx - 3, ly + 1, lx, ly + 3, P.paperShade);
    line(lx + 4, ly + 1, lx + 1, ly + 3, P.paperShade);
    rect(lx - 1, ly + 3, 3, 2, P.red);
  }
}

/** Ticks between blinks (about every three seconds at 12 fps), and how long one lasts. */
const BLINK_EVERY = 36;
const BLINK_TICKS = 2;
/** Ticks between ear twitches, and how long one lasts. */
const TWITCH_EVERY = 50;
const TWITCH_TICKS = 3;

export interface BunnyFrame {
  look: Look;
  activity: BunnyActivity;
  /** Feet position, art pixels. */
  x: number;
  y: number;
  left: boolean;
  /** Ticks walked so far, or 0 when standing. */
  steps: number;
  tick: number;
  /** A per-bunny offset, so they don't blink and swing in step. */
  seed: number;
  /** The still pose (reduced motion, or paused): no blink, no twitch, tools at rest. */
  still: boolean;
  /** Ticks since it arrived at its spot after a walk, for the little arrival puff; -1 when there is none. */
  arrived?: number;
  /** At its spot doing its work (not walking there, nor off on a short stroll). */
  working?: boolean;
  /** The way its spot faces: its subagents trail on the other side, so a stroll never swings them into a neighbour. */
  homeLeft?: boolean;
  /** On its way to a new spot (not home yet): its subagents trail behind the way it walks. */
  travelling?: boolean;
  /** Tucked into its spot's bed or futon (asleep or dozing in the bedroom). */
  bed?: "bed" | "futon";
}

/** The pose for a frame: walking strides (whoever walks), or standing with blinks and ear twitches. */
export function poseFor(f: BunnyFrame): PoseName {
  const holding = toolFor(f.activity) !== undefined;
  if (f.steps > 0) {
    const s = Math.floor(f.steps / 2) % 4;
    if (holding) return s === 1 ? "holdStride1" : s === 3 ? "holdStride2" : "hold";
    return s === 1 ? "stride1" : s === 3 ? "stride2" : "stand";
  }
  if (f.activity === "sleeping" || f.activity === "quiet") return "doze";
  if (f.still) return holding ? "hold" : "stand";
  const t = f.tick + f.seed;
  const blink = t % BLINK_EVERY < BLINK_TICKS;
  if (holding) return blink ? "holdBlink" : "hold";
  if (blink) return "blink";
  return (t + 17) % TWITCH_EVERY < TWITCH_TICKS ? "twitch" : "stand";
}

/** Where up to three subagents trot, relative to their worker's feet (on its back side, facing right). */
const TINY_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [-16, -2],
  [-10, 4],
  [-21, 3],
];
export const MAX_TINIES = TINY_OFFSETS.length;

/**
 * The side a worker's subagents trail on: behind the way it walks while it
 * travels to a new spot; at home, strolling or working, behind the way its
 * spot faces, so they stay on the side clear of its work.
 */
function trailLeft(f: Pick<BunnyFrame, "left" | "homeLeft" | "travelling">): boolean {
  return f.homeLeft === undefined || f.travelling ? f.left : f.homeLeft;
}

/** Where a worker's i-th subagent stands: its feet, just behind the worker. */
export function tinySpot(f: Pick<BunnyFrame, "x" | "y" | "left" | "homeLeft" | "travelling">, i: number): { x: number; y: number } {
  const [ox, oy] = TINY_OFFSETS[i];
  return { x: f.x + (trailLeft(f) ? -ox : ox), y: f.y + oy };
}

/**
 * A worker's i-th subagent: a tiny bunny just behind it, hopping now and
 * then, walking when it walks. Drawn as its own entry in the room's
 * back-to-front order, so one standing in front of its worker is in front.
 */
export function drawTiny(ctx: Ctx, f: BunnyFrame, i: number): void {
  c = ctx;
  const t = f.tick + f.seed;
  const { x, y } = tinySpot(f, i);
  const walking = f.steps > 0;
  const phase = (t + i * 5) % 14;
  const lift = f.still ? 0 : walking ? (Math.floor(f.steps / 2) + i) % 2 : phase === 1 ? 2 : phase === 2 ? 1 : 0;
  const s = Math.floor((f.steps + i * 2) / 2) % 4;
  const pose: TinyPoseName = walking
    ? s === 1
      ? "stride1"
      : s === 3
        ? "stride2"
        : "stand"
    : !f.still && (t + i * 11) % BLINK_EVERY < BLINK_TICKS
      ? "blink"
      : "stand";
  const g = TINY_POSES[pose];
  const gx = Math.round(x - g[0].length / 2);
  const gy = Math.round(y - g.length + 1 - lift);
  shadow(ctx, x, y, "tiny");
  const img = sprite(`tiny:${pose}`, f.look);
  if (img) blit(ctx, img, gx, gy, f.left);
}

const shadowCache = new Map<string, AnyCanvas | null>();

/** A soft oval shadow under a bunny's feet, made once per size and blitted. */
function shadow(ctx: Ctx, x: number, y: number, size: "worker" | "tiny"): void {
  const [rx, ry] = size === "worker" ? [9, 2] : [5, 1.5];
  if (!shadowCache.has(size)) {
    const made = makeCanvas(rx * 2 + 2, Math.ceil(ry * 2) + 2);
    if (made) {
      const prev = c;
      c = made.ctx;
      ellipse(rx + 1, ry + 1, rx, ry, P.shadow);
      c = prev;
    }
    shadowCache.set(size, made?.canvas ?? null);
  }
  const img = shadowCache.get(size);
  if (img) ctx.drawImage(img as CanvasImageSource, Math.round(x - rx - 1), Math.round(y - ry - 1));
}

/** A few sparkles around the feet of a bunny that has just arrived at its new spot. */
function arrivalPuff(x: number, y: number, age: number): void {
  const r = 5 + age * 1.5;
  const colour = age < ARRIVAL_TICKS / 2 ? "#fff6c8" : "#f2d47e";
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2 + age * 0.2;
    const sx = Math.round(x + Math.cos(a) * r);
    const sy = Math.round(y - 3 + Math.sin(a) * r * 0.45);
    px(sx, sy, colour);
    if (age < 3) {
      px(sx - 1, sy, colour);
      px(sx, sy - 1, colour);
    }
  }
}

/**
 * Where a bunny's head-side cue bubble sits (a "?" or "!" waiting on the
 * owner, a "…" gone quiet): beside the head, on its back side, clear of the
 * name tag above.
 */
export function cueSpot(f: Pick<BunnyFrame, "x" | "y" | "left">): { x: number; y: number } {
  return { x: Math.round(f.left ? f.x + 10 : f.x - 20), y: Math.round(f.y - BUNNY_H + 6) };
}

const BLANKETS = [P.blue, "#6a5aa8", P.green, "#b0585a", "#4a8a9a"];

/** A bed's or futon's blanket for the bed whose sleeper's feet are at (x, y): drawn over the sleeper. */
function blanket(kind: "bed" | "futon", x: number, y: number): void {
  const colour = BLANKETS[Math.floor(hash(x, y) * BLANKETS.length)];
  const top = y - 12;
  const [bx, bw, bh] = kind === "bed" ? [x - 18, 36, 25] : [x - 20, 40, 14];
  box(bx, top, bw, bh, colour, "#3a2a5a");
  for (let i = bx + 4; i < bx + bw - 2; i += 8) rect(i, top + 2, 3, bh - 4, "rgba(255,255,255,0.18)");
  rect(bx, top, bw, 2, "rgba(255,255,255,0.35)");
}

/** Draws one bunny with its accessory, its tool and work, and its little cues (Zzz, a "?", a "!", a "…"). */
export function drawBunny(ctx: Ctx, f: BunnyFrame, wait?: "question" | "decision" | "teammate"): void {
  c = ctx;
  const pose = poseFor(f);
  const walking = f.steps > 0;
  const hop = walking && Math.floor(f.steps / 2) % 2 === 1 ? 1 : 0;
  const gx = Math.round(f.x - BUNNY_W / 2);
  const gy = Math.round(f.y - BUNNY_H + 1 - hop);
  const tucked = f.bed !== undefined && !walking;
  if (!tucked) shadow(ctx, f.x, f.y, "worker");
  if (!f.still && f.arrived !== undefined && f.arrived >= 0) arrivalPuff(f.x, f.y, f.arrived);
  const img = sprite(pose, f.look);
  // Tucked in, it shows from the shoulders up, under the blanket.
  if (img) blit(ctx, img, gx, gy, f.left, tucked ? 24 : undefined);
  accessory(f.look.accessory, gx, gy, f.left, pose.includes("tride") ? -1 : 0);
  if (tucked) blanket(f.bed!, f.x, f.y);
  const held = toolFor(f.activity);
  const t = f.tick + f.seed;
  // Still (reduced motion, paused), a bunny at its spot shows one frame of its work, so what it does still reads.
  const working = !walking && f.working !== false;
  if (held) tool(held, f.x, f.y, f.left, working && !f.still ? Math.floor(t / 3) : 1, f.seed, working);
  if (f.activity === "sleeping" && !walking) {
    for (let k = 0; k < 3; k++) {
      const r = f.still ? k * 4 : (t / 3 + k * 4) % 12;
      // Rising from beside the head, on the side away from the name tag above it.
      const zx = Math.round((f.left ? f.x - 24 : f.x + 12) + k * 4);
      const zy = Math.round(f.y - BUNNY_H + 6 - r * 1.2 - k * 3);
      rect(zx, zy, 3, 1, "#ffffff");
      px(zx + 1, zy + 1, "#ffffff");
      rect(zx, zy + 2, 3, 1, "#ffffff");
    }
  }
  // A waiting bunny shows its bubble on the way to the hall too; a quiet one only once it lies down.
  if (f.activity === "sign" || (!walking && f.activity === "quiet")) {
    const bob = f.still ? 0 : Math.floor(t / 6) % 2;
    const { x: bx, y: cy } = cueSpot(f);
    const by = cy - bob;
    if (f.activity === "sign") {
      // A red speech bubble with a white "?" (a question asked) or "!" (a
      // decision needed); a teammate's question is a quiet cream bubble.
      const fill = wait === "teammate" ? P.cream : P.red;
      const glyph = wait === "teammate" ? OUT : "#ffffff";
      box(bx, by, 9, 10, fill, OUT);
      if (wait === "decision") {
        rect(bx + 4, by + 2, 1, 4, glyph);
        px(bx + 4, by + 7, glyph);
      } else {
        rect(bx + 3, by + 2, 3, 1, glyph);
        px(bx + 5, by + 3, glyph);
        px(bx + 4, by + 4, glyph);
        px(bx + 4, by + 6, glyph);
      }
    } else {
      box(bx, by, 11, 7, "#ffffff");
      const dots = f.still ? 3 : (Math.floor(t / 4) % 3) + 1;
      for (let k = 0; k < dots; k++) px(bx + 3 + k * 2, by + 3, OUT);
    }
  }
}

// ---------------------------------------------------------------------------
// The house and the yard
// ---------------------------------------------------------------------------
const WALL_H = 56;
const SIDE = 10;
/** The house's right outer wall; the yard is beyond it. */
const HOUSE_R = 540;
/** The low wall between the back rooms and the front rooms, and its front face's height. */
const MID = 210;
const MID_FACE = 14;
/** The doorway in the left wall (the front door) and in the right wall (the back door to the garden). */
const FRONT_DOOR: readonly [number, number] = [294, 350];
const BACK_DOOR: readonly [number, number] = [126, 160];

function planks(x0: number, y0: number, x1: number, y1: number): void {
  for (let y = y0; y < y1; y++) {
    const row = Math.floor((y - y0) / 9);
    for (let x = x0; x < x1; x++) {
      const plank = Math.floor((x + (row % 2) * 27) / 54);
      let color = P.floor[Math.floor(hash(plank, row) * 4)];
      if ((y - y0) % 9 === 0 || (x + (row % 2) * 27) % 54 === 0) color = P.floorSeam;
      px(x, y, color);
    }
  }
}

function flagstones(x0: number, y0: number, x1: number, y1: number): void {
  for (let y = y0; y < y1; y++) {
    const row = Math.floor((y - y0) / 12);
    for (let x = x0; x < x1; x++) {
      const col = Math.floor((x + (row % 2) * 9) / 18);
      let color = P.flag[Math.floor(hash(col, row) * 3)];
      if ((y - y0) % 12 === 0 || (x + (row % 2) * 9) % 18 === 0) color = P.stoneDark;
      px(x, y, color);
    }
  }
}

function tiles(x0: number, y0: number, x1: number, y1: number): void {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) px(x, y, P.tile[((x >> 3) + (y >> 3)) % 2]);
}

function grassField(x0: number, y0: number, x1: number, y1: number, evening: boolean): void {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const v = hash(x >> 1, y >> 1);
      px(x, y, evening ? (v > 0.9 ? "#2e4a3a" : "#26402f") : v > 0.92 ? P.grassLight : v > 0.6 ? P.grass : P.grassDark);
    }
  }
}

function backWall(x0: number, x1: number): void {
  rect(x0, 0, x1 - x0, WALL_H, P.wall);
  rect(x0, 0, x1 - x0, 4, P.trim);
  for (let x = x0; x < x1; x += 12) rect(x, 4, 4, WALL_H - 24, P.wallTop);
  rect(x0, WALL_H - 20, x1 - x0, 20, P.wainscot);
  for (let x = x0; x < x1; x += 16) rect(x + 2, WALL_H - 17, 12, 14, P.wainscotLight);
  rect(x0, WALL_H - 21, x1 - x0, 2, P.trim);
  rect(x0, WALL_H - 2, x1 - x0, 2, P.trim);
}

/** The low wall between back and front rooms, seen from the front, its doorways showing the floor through. */
function midWall(gaps: ReadonlyArray<readonly [number, number]>): void {
  for (const [a, b] of gaps) planks(a, MID, b, MID + MID_FACE);
  for (let x = SIDE; x < HOUSE_R - SIDE; x++) {
    if (gaps.some(([a, b]) => x >= a && x < b)) continue;
    rect(x, MID, 1, MID_FACE, x % 16 < 2 ? P.trim : P.wainscotLight);
    px(x, MID, P.trim);
    px(x, MID + 1, P.wallTop);
    px(x, MID + MID_FACE - 1, P.trim);
  }
}

/** A thin interior wall running front to back, with a doorway. */
function sideWall(x: number, y0: number, y1: number, gap: readonly [number, number]): void {
  planks(x, gap[0], x + 6, gap[1]);
  for (let y = y0; y < y1; y++) {
    if (y >= gap[0] && y < gap[1]) continue;
    rect(x, y, 6, 1, P.wainscot);
    px(x, y, P.trim);
    px(x + 5, y, P.trim);
  }
  rect(x, y0, 6, 3, P.wallTop);
}

function windowAt(x: number, y: number, w: number, h: number, evening: boolean): void {
  box(x - 2, y - 2, w + 4, h + 4, P.woodLight, P.trim);
  rect(x, y, w, h, evening ? P.skyEvening : P.skyGolden);
  if (evening) {
    for (let k = 0; k < 4; k++) px(x + hash(k, x) * w, y + hash(x, k) * h * 0.7, P.paper);
    ellipse(x + w * 0.7, y + h * 0.3, 2, 2, P.paper);
  } else {
    rect(x, y + h - 5, w, 5, "#e8a060");
    ellipse(x + w * 0.65, y + h - 4, 4, 3, "#fff0b0");
  }
  rect(x + w / 2 - 1, y, 2, h, P.woodLight);
  rect(x - 4, y - 3, 4, h + 4, P.red);
  rect(x + w, y - 3, 4, h + 4, P.red);
}

function rug(x: number, y: number, w: number, h: number, main: string, dark: string): void {
  box(x, y, w, h, P.rugGold, dark);
  rect(x + 3, y + 3, w - 6, h - 6, main);
  for (let i = x + 6; i < x + w - 6; i += 6) {
    px(i, y + 5, P.rugGold);
    px(i + 3, y + h - 6, P.rugGold);
  }
}

function bookshelf(x: number, y: number, w: number, h: number): void {
  box(x, y, w, h, P.woodDark, P.trim);
  const cols = [P.red, P.blue, P.green, P.mustard, P.pink, P.cream];
  for (let r = 0; r < Math.floor((h - 4) / 11); r++) {
    const sy = y + 3 + r * 11;
    rect(x + 2, sy + 9, w - 4, 2, P.woodLight);
    let bx = x + 3;
    while (bx < x + w - 5) {
      const bw = 2 + Math.floor(hash(bx, r) * 2);
      const bh = 5 + Math.floor(hash(r, bx) * 4);
      rect(bx, sy + 9 - bh, bw, bh, cols[Math.floor(hash(bx * 3, r) * cols.length)]);
      bx += bw + 1;
    }
  }
}

function plantPot(x: number, y: number, size: number): void {
  box(x - size / 2, y - size * 0.7, size, size * 0.7 + 1, P.pot, P.potDark);
  for (let k = 0; k < 6; k++) {
    const a = -Math.PI / 2 + (k - 2.5) * 0.45;
    const len = size * (0.6 + hash(k, size) * 0.4);
    const lx = x + Math.cos(a) * len;
    const ly = y - size * 0.7 + Math.sin(a) * len;
    ellipse(lx, ly, 2.4, 1.8, OUT);
    ellipse(lx, ly, 1.7, 1.2, k % 2 ? P.leaf : P.leafLight);
  }
}

function armchair(x: number, y: number): void {
  box(x, y, 26, 10, P.green, "#2e6040");
  box(x - 3, y + 5, 7, 14, P.green, "#2e6040");
  box(x + 22, y + 5, 7, 14, P.green, "#2e6040");
  box(x + 2, y + 8, 22, 12, "#62b070", "#2e6040");
}

function nook(s: Station, evening: boolean): void {
  const [x0, y0, x1, y1] = s.floor;
  planks(x0, y0, x1, y1);
  bookshelf(x0 + 6, 6, 44, WALL_H + 6);
  bookshelf(x0 + 56, 6, 44, WALL_H + 6);
  windowAt(x0 + 118, 14, 34, 22, evening);
  rug(x0 + 12, y0 + 40, x1 - x0 - 24, 100, P.rugBlue, P.rugBlueDark);
  // Stacks of books and a reading lamp in the corner.
  for (let k = 0; k < 4; k++) box(x0 + 144, y0 + 30 - k * 4, 14 - k, 4, [P.red, P.blue, P.mustard, P.green][k]);
  rect(x0 + 160, y0 + 4, 2, 30, P.woodDark);
  box(x0 + 154, y0 - 2, 14, 8, P.mustard, P.trim);
}

/** The living room's fireplace: where drawAmbient paints its flames. */
const HEARTH = { x: 260, y: WALL_H + 9 } as const;
/** The forge's furnace mouth: where drawAmbient paints its fire. */
const FURNACE = { x: 190, y: 257 } as const;

function living(s: Station, evening: boolean): void {
  const [x0, y0, x1, y1] = s.floor;
  planks(x0, y0, x1, y1);
  const fx = HEARTH.x - 17;
  box(fx, 10, 60, WALL_H + 2, P.stone, P.stoneDark);
  for (let j = 12; j < WALL_H + 10; j += 6) {
    for (let i = fx + 2 + ((j / 6) % 2) * 5; i < fx + 58; i += 10) rect(i, j, 9, 5, (i + j) % 3 ? P.stoneLight : P.stone);
  }
  box(fx - 4, 8, 68, 5, P.woodLight, P.trim);
  box(fx + 14, 26, 32, WALL_H - 14, "#2a1410", P.stoneDark);
  box(fx + 25, 0, 10, 9, P.paper, P.trim);
  rug(x0 + 14, y0 + 40, x1 - x0 - 28, 100, P.rug, P.rugDark);
  armchair(x0 + 14, y0 + 18);
  armchair(x1 - 42, y0 + 18);
  plantPot(x1 - 10, y0 + 30, 10);
  void evening;
}

function bedroom(s: Station, evening: boolean): void {
  const [x0, y0, x1, y1] = s.floor;
  planks(x0, y0, x1, y1);
  const mid = (x0 + x1) / 2;
  windowAt(mid - 16, 14, 32, 22, evening);
  rug(x0 + 10, y0 + 96, x1 - x0 - 20, 50, P.rugLilac, P.rugLilacDark);
  // A nightstand with a candle between the beds.
  box(mid - 5, y0 + 16, 10, 10, P.wood, P.trim);
  rect(mid - 1, y0 + 10, 2, 6, P.cream);
}

function hall(s: Station, evening: boolean): void {
  const [x0, y0, x1] = s.floor;
  tiles(x0, y0, x1, H);
  // The front door in the left wall, open onto the lawn, and the welcome mat.
  rect(0, FRONT_DOOR[0], SIDE, FRONT_DOOR[1] - FRONT_DOOR[0], evening ? "#26402f" : P.grass);
  box(x0, FRONT_DOOR[0] - 4, 6, FRONT_DOOR[1] - FRONT_DOOR[0] + 6, P.woodDark, P.trim);
  box(x0 + 2, FRONT_DOOR[0] + 4, 22, 6, P.wood, P.trim);
  box(x0 + 4, FRONT_DOOR[1] + 10, 26, 8, P.mustard, P.woodDark);
  // A coat rack and a basket of mail.
  rect(x1 - 18, y0 + 6, 2, 40, P.woodDark);
  ellipse(x1 - 17, y0 + 10, 6, 4, P.red);
  box(x1 - 34, y0 + 36, 14, 8, P.woodLight, P.trim);
  for (let k = 0; k < 3; k++) box(x1 - 32 + k * 3, y0 + 31 - k, 6, 5, P.paper);
}

function forge(s: Station): void {
  const [x0, y0, x1] = s.floor;
  flagstones(x0, y0, x1, H);
  // The furnace against the back with its hood, a rack of tools, a quenching barrel.
  const fx = FURNACE.x - 16;
  box(fx, y0 + 4, 56, 36, P.stoneDark, OUT);
  for (let j = y0 + 6; j < y0 + 38; j += 6) for (let i = fx + 2 + ((j / 6) % 2) * 4; i < fx + 54; i += 9) rect(i, j, 8, 5, P.stone);
  box(fx + 14, y0 + 16, 28, 18, "#2a1410", OUT);
  box(fx - 4, y0 - 4, 64, 8, P.metalDark, OUT);
  box(x0 + 92, y0 + 4, 50, 22, P.woodDark, P.trim);
  for (let k = 0; k < 5; k++) {
    rect(x0 + 98 + k * 9, y0 + 8, 2, 14, P.metal);
    box(x0 + 96 + k * 9, y0 + 6, 6, 4, P.metalDark);
  }
  box(x0 + 156, y0 + 10, 22, 26, P.wood, P.trim);
  rect(x0 + 158, y0 + 12, 18, 3, P.waterLight);
  rect(x0 + 156, y0 + 18, 22, 2, P.metalDark);
  rect(x0 + 156, y0 + 28, 22, 2, P.metalDark);
}

function studio(s: Station): void {
  const [x0, y0, x1] = s.floor;
  planks(x0, y0, x1, H);
  for (let k = 0; k < 18; k++) px(x0 + 8 + hash(k, 41) * (x1 - x0 - 16), y0 + 40 + hash(41, k) * (H - y0 - 50), [P.red, P.blue, P.leaf, P.mustard][k % 4]);
  // Finished canvases on a rack, a table of paint jars.
  box(x0 + 8, y0 + 4, 70, 30, P.woodDark, P.trim);
  for (let k = 0; k < 4; k++) box(x0 + 11 + k * 16, y0 + 7, 14, 24, [P.cream, P.glass, P.paper, "#f0d0d8"][k], P.trim);
  box(x0 + 98, y0 + 12, 52, 14, P.woodLight, P.trim);
  for (let k = 0; k < 5; k++) box(x0 + 102 + k * 9, y0 + 6, 6, 7, [P.red, P.blue, P.leaf, P.mustard, P.pink][k], OUT);
}

function garden(s: Station, evening: boolean): void {
  const [x0, y0] = s.floor;
  grassField(HOUSE_R, 0, W, MID + 18, evening);
  // The sky and a hedge above the back of the yard.
  rect(HOUSE_R, 0, W - HOUSE_R, 18, evening ? P.skyEvening : P.skyGolden);
  for (let x = HOUSE_R; x < W; x += 9) ellipse(x + 4, 24, 7, 8, evening ? "#1e3428" : P.leafDark);
  // Vegetable rows.
  for (let row = 0; row < 3; row++) {
    const ry = y0 + 4 + row * 14;
    box(x0 + 6, ry, 96, 9, P.soil, P.soilDark);
    for (let k = 0; k < 8; k++) {
      const sx = x0 + 12 + k * 12;
      ellipse(sx, ry + 2, 2.5, 2, OUT);
      ellipse(sx, ry + 2, 1.8, 1.4, row === 1 ? P.pot : P.leafLight);
    }
  }
  // The cart, half loaded.
  const cx = 660;
  box(cx, 74, 46, 16, P.wood, P.trim);
  for (const wx of [cx + 8, cx + 38]) {
    ellipse(wx, 94, 5, 5, OUT);
    ellipse(wx, 94, 3, 3, P.woodDark);
  }
  for (let k = 0; k < 3; k++) box(cx + 4 + k * 14, 64, 12, 11, P.woodLight, P.trim);
  rect(cx + 46, 80, 6, 2, P.woodDark);
  // A low fence between the garden and the pond.
  for (let x = HOUSE_R + 4; x < W - 2; x++) {
    if (x % 12 < 3) rect(x, 214, 1, 12, P.woodDark);
  }
  rect(HOUSE_R + 4, 217, W - HOUSE_R - 6, 2, P.woodLight);
  rect(HOUSE_R + 4, 222, W - HOUSE_R - 6, 2, P.woodLight);
}

function pond(s: Station, evening: boolean): void {
  grassField(HOUSE_R, MID + 18, W, H, evening);
  const [wx0, wy0, wx1, wy1] = s.props[0];
  const cx = (wx0 + wx1 - 1) / 2;
  const cy = (wy0 + wy1 - 1) / 2;
  const rx = (wx1 - 1 - wx0) / 2;
  const ry = (wy1 - 1 - wy0) / 2;
  ellipse(cx, cy, rx, ry, OUT);
  ellipse(cx, cy, rx - 2, ry - 2, evening ? "#1e3a68" : P.waterDark);
  ellipse(cx - 2, cy - 2, rx - 8, ry - 8, evening ? "#264a80" : P.water);
  for (const [lx, ly] of [
    [cx + 20, cy - 40],
    [cx - 14, cy + 44],
    [cx + 28, cy + 22],
  ] as const) {
    ellipse(lx, ly, 5, 3, P.leafDark);
    ellipse(lx, ly, 4, 2, P.leaf);
  }
  ellipse(cx + 22, cy - 41, 1.5, 1.5, P.pink);
  for (let k = 0; k < 6; k++) rect(cx + 38 + (k % 3) * 3, cy - 60 + k * 3, 1, 9, P.leafDark);
  // A tackle box and a bucket of the day's catch on the bank.
  const [tx, ty] = s.props[1];
  box(tx + 2, ty + 2, 14, 8, P.green, P.greenDark);
  box(tx + 20, ty, 10, 10, P.metal, P.metalDark);
  ellipse(tx + 25, ty + 1, 3, 1.5, P.waterLight);
  if (evening) {
    // A lantern by the water.
    rect(700, 236, 2, 14, P.woodDark);
    box(696, 230, 10, 8, P.mustard, P.trim);
  }
}

/** Each spot's fixture (an anvil, an easel, a bed or a futon), painted with the room. */
function fixture(spot: Spot): void {
  const b = fixtureBox(spot);
  if (!b) return;
  const [x0, y0, x1, y1] = b;
  if (spot.fixture === "anvil") {
    const ax = (x0 + x1) / 2;
    const f = y1;
    box(ax - 7, f - 9, 14, 4, P.metalDark, OUT);
    box(ax - 3, f - 6, 6, 4, P.metalDark, OUT);
    box(ax - 5, f - 3, 10, 3, P.metalDark, OUT);
    rect(ax - 6, f - 8, 12, 1, P.metalLight);
  } else if (spot.fixture === "easel") {
    const ex = (x0 + x1) / 2;
    line(ex - 5, y1, ex - 1, y1 - 22, P.woodDark);
    line(ex + 5, y1, ex + 1, y1 - 22, P.woodDark);
    line(ex, y1, ex, y1 - 20, P.woodDark);
    box(ex - 8, y1 - 26, 16, 13, P.paper, P.trim);
  } else if (spot.fixture === "bed") {
    box(x0, y0, x1 - x0, y1 - y0, P.woodLight, P.trim);
    box(x0 + 3, y0 + 3, x1 - x0 - 6, 10, P.paper, P.paperShade);
    blanket("bed", spot.x, spot.y);
  } else {
    // A low futon on the rug: a cream mattress, a pillow under the sleeper's head, a blanket.
    box(x0 + 2, y0 + 8, x1 - x0 - 4, y1 - y0 - 8, P.cream, P.trim);
    box(spot.x - 9, y0 + 10, 18, 7, P.paper, P.paperShade);
    blanket("futon", spot.x, spot.y);
  }
}

/** The light the scene is lit by: the fire, the forge, the lamps, and a lantern by the pond at night. */
export interface RoomLight {
  glows: ReadonlyArray<{ x: number; y: number; r: number; k: number }>;
}

export function lightFor(evening: boolean): RoomLight {
  return {
    glows: [
      { x: HEARTH.x + 13, y: 62, r: evening ? 130 : 90, k: evening ? 0.55 : 0.2 },
      { x: FURNACE.x + 12, y: 254, r: evening ? 120 : 90, k: evening ? 0.6 : 0.25 },
      { x: 170, y: 66, r: 60, k: evening ? 0.4 : 0.1 },
      { x: 445, y: 72, r: 50, k: evening ? 0.35 : 0.06 },
      ...(evening ? [{ x: 701, y: 240, r: 70, k: 0.35 }] : []),
    ],
  };
}

/** Bakes the light into the painted scene: brighter and warmer near the fire, the forge and the lamps. */
function bakeLight(ctx: Ctx, evening: boolean): void {
  const img = ctx.getImageData(0, 0, W, H);
  if (!img?.data) return;
  const d = img.data;
  const { glows } = lightFor(evening);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let l = evening ? 0.6 : 0.95;
      let warm = 0;
      for (const g of glows) {
        const dd = Math.hypot(x - g.x, (y - g.y) * 1.25) / g.r;
        if (dd < 1) {
          const v = g.k * (1 - dd) * (1 - dd);
          l += v;
          warm += v;
        }
      }
      const o = (y * W + x) * 4;
      let r = d[o] * l + warm * 40;
      let g = d[o + 1] * l + warm * 20;
      let b = d[o + 2] * l * (evening ? 1.05 : 0.97);
      if (evening) {
        r *= 0.92;
        g *= 0.9;
        b += 8;
      }
      d[o] = Math.min(255, r);
      d[o + 1] = Math.min(255, g);
      d[o + 2] = Math.min(255, b);
    }
  }
  ctx.putImageData(img, 0, 0);
}

const roomCache = new Map<boolean, AnyCanvas>();

/** Paints the whole scene, lit, into a ROOM-sized canvas; null where no canvas can be made. */
export function paintRoom(evening: boolean): AnyCanvas | null {
  // The same light always paints the same scene: painted once, kept for every later visit.
  const cached = roomCache.get(evening);
  if (cached) return cached;
  const made = makeCanvas(W, H);
  if (!made) return null;
  c = made.ctx;
  // The yard first (it runs behind the house's right wall), then the house.
  garden(STATIONS.garden, evening);
  pond(STATIONS.pond, evening);
  backWall(0, HOUSE_R);
  nook(STATIONS.nook, evening);
  living(STATIONS.living, evening);
  bedroom(STATIONS.bedroom, evening);
  hall(STATIONS.hall, evening);
  forge(STATIONS.forge);
  studio(STATIONS.studio);
  // Interior walls between the rooms, each with a doorway.
  const back: readonly [number, number] = [WALL_H + 90, WALL_H + 124];
  const front: readonly [number, number] = [MID + 70, MID + 110];
  sideWall(STATIONS.living.floor[0] - 6, WALL_H, MID, back);
  sideWall(STATIONS.bedroom.floor[0] - 6, WALL_H, MID, back);
  sideWall(STATIONS.forge.floor[0] - 6, MID + MID_FACE, H, front);
  sideWall(STATIONS.studio.floor[0] - 6, MID + MID_FACE, H, front);
  midWall([
    [80, 114],
    [252, 292],
    [430, 464],
  ]);
  // The house's outer walls: left (with the front door) and right (with the back door to the garden).
  for (let y = 0; y < H; y++) {
    if (y < FRONT_DOOR[0] || y >= FRONT_DOOR[1]) rect(0, y, SIDE, 1, P.wainscot);
    if (y < BACK_DOOR[0] || y >= BACK_DOOR[1]) rect(HOUSE_R - SIDE, y, SIDE, 1, P.wainscot);
  }
  rect(SIDE - 2, WALL_H, 2, FRONT_DOOR[0] - WALL_H, P.trim);
  rect(SIDE - 2, FRONT_DOOR[1], 2, H - FRONT_DOOR[1], P.trim);
  rect(HOUSE_R - SIDE, WALL_H, 2, BACK_DOOR[0] - WALL_H, P.trim);
  rect(HOUSE_R - SIDE, BACK_DOOR[1], 2, H - BACK_DOOR[1], P.trim);
  // The back door stands open onto the lawn.
  grassField(HOUSE_R - SIDE, BACK_DOOR[0], HOUSE_R, BACK_DOOR[1], evening);
  for (const s of Object.values(STATIONS)) for (const spot of s.spots) fixture(spot);
  bakeLight(made.ctx, evening);
  roomCache.set(evening, made.canvas);
  return made.canvas;
}

/** Flames in a fire mouth `width` wide whose bottom-left is (x, y). */
function flames(x: number, y: number, width: number, t: number): void {
  for (let i = 0; i < width; i++) {
    const fh = 9 + Math.sin(i / 2 + t * 0.9) * 3 + hash(i, t) * 3 - Math.abs(i - width / 2) * 0.45;
    for (let j = 0; j < fh; j++) {
      const k = j / fh;
      px(x + i, y - j, P.fire[k < 0.3 ? 3 : k < 0.6 ? 2 : k < 0.85 ? 1 : 0]);
    }
  }
}

/** The scene's own motion, each frame: the fire and the forge, the bedroom candle, the pond's glints. */
export function drawAmbient(ctx: Ctx, tick: number, still: boolean): void {
  c = ctx;
  const t = still ? 0 : tick;
  flames(HEARTH.x, HEARTH.y, 26, t);
  flames(FURNACE.x, FURNACE.y, 24, t + 5);
  px(445, 64 + (t % 6 < 3 ? 0 : 1), P.fire[1]);
  px(445, 65, P.fire[0]);
  const [wx0, wy0, wx1, wy1] = STATIONS.pond.props[0];
  for (let k = 0; k < 7; k++) {
    const gx = wx0 + 16 + hash(k, 77) * (wx1 - wx0 - 32);
    const gy = wy0 + 20 + hash(77, k) * (wy1 - wy0 - 40);
    rect(gx + ((t + k * 4) % 8 < 4 ? 0 : 1), gy, 5, 1, P.waterLight);
  }
}

/** Golden hour from 7:00 to 18:00 local time; evening the rest of the day. */
export function isEvening(date: Date): boolean {
  const h = date.getHours();
  return h < 7 || h >= 18;
}
