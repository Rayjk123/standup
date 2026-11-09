import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Link } from "react-router-dom";
import type { Ask, Launch, PersonaJob, Session } from "@standup/shared";
import { palettes, theme } from "./theme";
import { usePresence } from "../hooks/presence";
import { usePipelineRuns } from "./PipelineSection";
// useNarrow tracks any media query; here it is prefers-reduced-motion.
import { useNarrow as useMediaQuery } from "../hooks/useNarrow";
import { createFrameLoop } from "../lib/frameLoop";
import { buildBurrow, burrowLaunchIds, subagentCount, type Bunny, type PendingReview } from "../lib/burrow";
import { subscribeReviewUpdates } from "../lib/reviewUpdates";
import { listReviews } from "./review/api";
import {
  ROOM,
  STATIONS,
  TAG_PLACES,
  hasStem,
  WANDER_SPEED,
  layoutRoom,
  reconcileWalkers,
  spotMemory,
  stepToward,
  wanderTarget,
  type Spot,
  type SpotMemory,
  type StationId,
  type TagPlace,
  type Walker,
} from "../lib/burrowRoom";
import {
  BUNNY_H,
  BUNNY_W,
  MAX_TINIES,
  OUT,
  P,
  drawAmbient,
  drawBunny,
  drawTiny,
  isEvening,
  lookFor,
  paintRoom,
  tinySpot,
  type BunnyFrame,
  type Look,
} from "./burrow/room";

/** Animation frames per second: plenty for 2–4 frame pixel loops, and cheap. */
export const BURROW_FPS = 12;

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";
/** Where the owner's "pause the animation" choice is kept. */
const PAUSE_KEY = "standup:burrow:paused";
/** How long the room waits for Persona's jobs before settling without them. */
const PERSONA_GRACE_MS = 3000;

/**
 * The name tags' palette is the room's own: cream cards and dark ink, red for
 * waiting. It is part of the art, so it stays the same in both themes; the
 * red is the dark palette's, which the dark ink reads on (the light one's is
 * too dark under it).
 */
const TAG = {
  ink: OUT,
  card: "#fbf2e2",
  /** The plaques' wood. */
  wood: "#c98a52",
  wait: palettes.dark.waiting,
  workDot: P.leafDark,
  shadow: "rgba(20,10,8,0.3)",
};

/** The order stations are listed and tabbed in: what needs the owner first, then the work, then rest. */
const STATION_ORDER: StationId[] = ["hall", "forge", "pond", "nook", "studio", "garden", "living", "bedroom"];

/**
 * A bunny's tag shows its title, cut to its place's width (TAG_PLACES); on
 * hover or focus it opens to the full title (wrapping when long) and the
 * worker's state, above every other tag. A tag is shifted (--dx) to stay
 * inside its station's walls, and held still (--sx, --sy) while its bunny
 * strolls round its spot; a raised one has a stem down to its bunny. The
 * focus ring is two-tone, so it shows on the dark wood and the cream cards alike.
 * A plaque (and the info button) is a popover button: its tooltip shows on
 * hover or keyboard focus while its card is shut, and opens toward the
 * middle of the room (up from the bottom half, leftward from the right half).
 */
export const BURROW_CSS = `
.burrow-bunny { position: absolute; left: 0; top: 0; text-decoration: none; border-radius: 6px; }
.burrow-bunny:hover, .burrow-bunny:focus-visible { z-index: 100000 !important; }
.burrow-bunny:focus-visible { outline: 2px solid ${OUT}; outline-offset: 2px; box-shadow: 0 0 0 5px #fff2c0; }
.burrow-tag { position: absolute; left: 50%; transform: translate(calc(-50% + var(--dx, 0px) + var(--sx, 0px)), var(--sy, 0px)); }
.burrow-tag[data-stem]::after { content: ""; position: absolute; top: 100%; left: calc(50% - var(--dx, 0px)); width: 2px; margin-left: -1px; height: var(--stem); background: ${OUT}; }
.burrow-bunny:hover .burrow-tag, .burrow-bunny:focus-visible .burrow-tag { transform: translate(calc(-50% + var(--dx, 0px) + var(--sx, 0px)), calc(var(--sy, 0px) - 2px)); white-space: normal !important; width: max-content; max-width: 300px; }
.burrow-tag-title { overflow: hidden; text-overflow: ellipsis; }
.burrow-bunny:hover .burrow-tag-title, .burrow-bunny:focus-visible .burrow-tag-title { overflow: visible; white-space: normal; overflow-wrap: anywhere; max-width: none !important; }
.burrow-tag-state { display: none; font-weight: 500; }
.burrow-bunny:hover .burrow-tag-state, .burrow-bunny:focus-visible .burrow-tag-state { display: block; }
.burrow-pop { position: absolute; z-index: 99998; pointer-events: none; }
.burrow-pop:hover, .burrow-pop:focus-within, .burrow-pop[data-open] { z-index: 100001; }
.burrow-pop-btn { display: flex; align-items: center; gap: 5px; white-space: nowrap; pointer-events: auto; cursor: pointer; font: inherit; background: ${TAG.wood}; border: 2px solid ${OUT}; border-radius: 3px; color: ${OUT}; font-weight: 800; box-shadow: 2px 2px 0 ${TAG.shadow}; }
.burrow-pop-btn:hover { filter: brightness(1.12); }
.burrow-pop-btn:active, .burrow-pop[data-open] .burrow-pop-btn { transform: translate(2px, 2px); box-shadow: none; }
.burrow-pop-btn:focus-visible { outline: 2px solid ${OUT}; outline-offset: 2px; box-shadow: 0 0 0 5px #fff2c0; }
.burrow-tip, .burrow-pop-card { position: absolute; top: calc(100% + 9px); left: 0; width: max-content; background: ${TAG.card}; border: 2px solid ${OUT}; border-radius: 3px; color: ${OUT}; }
.burrow-pop[data-up] .burrow-tip, .burrow-pop[data-up] .burrow-pop-card { top: auto; bottom: calc(100% + 9px); }
.burrow-pop[data-end] .burrow-tip, .burrow-pop[data-end] .burrow-pop-card { left: auto; right: 0; }
.burrow-tip { display: none; max-width: 260px; padding: 2px 7px; box-shadow: 2px 2px 0 ${TAG.shadow}; font-size: 11px; line-height: 14px; font-weight: 600; }
.burrow-tip::first-letter { text-transform: uppercase; }
.burrow-tip { pointer-events: auto; }
.burrow-tip::before { content: ""; position: absolute; left: -2px; right: -2px; top: -11px; height: 11px; }
.burrow-pop[data-up] .burrow-tip::before { top: auto; bottom: -11px; }
.burrow-pop:hover .burrow-tip, .burrow-pop-btn:focus-visible + .burrow-tip { display: block; }
.burrow-pop[data-open] .burrow-tip, .burrow-pop[data-tip-off] .burrow-tip { display: none; }
.burrow-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.burrow-pop-card { max-width: 260px; padding: 9px 12px; box-shadow: 3px 3px 0 ${TAG.shadow}; font-size: 12.5px; line-height: 1.5; pointer-events: auto; }
@keyframes burrow-pop-in { from { opacity: 0; transform: translateY(var(--from, -3px)); } }
.burrow-pop[data-up] .burrow-pop-card { --from: 3px; }
@media (prefers-reduced-motion: no-preference) { .burrow-pop-card { animation: burrow-pop-in 120ms steps(2, end); } }
.burrow-pop-card h3 { margin: 0 0 5px; font-size: 13px; font-weight: 800; }
.burrow-pop-card p { margin: 0; }
.burrow-pop-card p + p { margin-top: 5px; }
.burrow-skip { position: absolute; left: -10000px; }
.burrow-skip:focus { position: static; }
`;

/**
 * CSS pixels per art pixel: as many as fit the width, up to 3, so a desktop
 * window fills with a room whose name tags are readable and a narrow screen
 * still sees the whole room. Whole numbers draw the crispest pixels; a
 * fraction is the price of fitting.
 */
export function roomScale(width: number): number {
  return Math.min(3, Math.max(0.5, width / ROOM.w));
}

/** Below this scale the name tags would be too small to read, and the station list carries the names. */
const TAG_SCALE = 1.5;

/** A per-session seed, so the bunnies don't blink, swing or stroll in step: the id's whole 31-bit hash. */
function seedOf(id: string): number {
  let n = 0;
  for (let i = 0; i < id.length; i++) n = (n * 31 + id.charCodeAt(i)) | 0;
  return n & 0x7fffffff;
}

interface Placed {
  bunny: Bunny;
  look: Look;
  station: StationId;
  spot: number;
  /** The spot itself: where it faces, where it may wander, what stands there. */
  at: Spot;
  /** Its "station:index" key, what a walker is home at once it has arrived. */
  key: string;
  x: number;
  y: number;
}

interface Scene {
  placed: Placed[];
  walkers: Map<string, Walker>;
  room: CanvasImageSource | null;
}

/**
 * One frame: the lit scene, the flames and the water, then every bunny and
 * every subagent, back to front by where its feet are. A bunny at its spot
 * works (and faces its work); one walking there or off on a stroll just
 * carries its tool.
 */
function drawRoom(ctx: CanvasRenderingContext2D, scene: Scene, tick: number, still: boolean): void {
  ctx.imageSmoothingEnabled = false;
  if (scene.room) ctx.drawImage(scene.room, 0, 0);
  else ctx.clearRect(0, 0, ROOM.w, ROOM.h);
  drawAmbient(ctx, tick, still);
  const entries: Array<{ y: number; draw: () => void }> = [];
  for (const p of scene.placed) {
    const w = scene.walkers.get(p.bunny.sessionId) ?? { x: p.x, y: p.y, left: p.at.left, steps: 0, arrived: -1, home: p.key };
    const atSpot = w.x === p.x && w.y === p.y && w.steps === 0;
    const working = atSpot && w.home === p.key;
    const bed = atSpot && (p.at.fixture === "bed" || p.at.fixture === "futon") ? p.at.fixture : undefined;
    const frame: BunnyFrame = {
      look: p.look,
      activity: p.bunny.activity,
      x: w.x,
      y: w.y,
      left: working ? p.at.left : w.left,
      steps: w.steps,
      tick,
      seed: seedOf(p.bunny.sessionId),
      still,
      arrived: w.arrived,
      working,
      homeLeft: p.at.left,
      travelling: w.home !== p.key,
      bed,
    };
    entries.push({ y: w.y, draw: () => drawBunny(ctx, frame, p.bunny.wait) });
    // Tucked into bed, its subagents (if any) are counted on its tag, not drawn beside the bed.
    if (bed) continue;
    for (let i = 0; i < Math.min(p.bunny.subagents, MAX_TINIES); i++) {
      entries.push({ y: tinySpot(frame, i).y, draw: () => drawTiny(ctx, frame, i) });
    }
  }
  entries.sort((a, b) => a.y - b.y);
  for (const e of entries) e.draw();
}

/**
 * Moves every walker one step: one on its way to its spot walks there (and
 * is home once it arrives); one home ambles slowly to where its wander
 * schedule says (mostly its spot, now and then a short stroll round it).
 * Ages arrival puffs too. True when any of them moved.
 */
function stepWalkers(scene: Scene, tick: number): boolean {
  let moved = false;
  for (const p of scene.placed) {
    const w = scene.walkers.get(p.bunny.sessionId);
    if (!w) continue;
    let next: Walker;
    if (w.home === p.key) {
      const to = wanderTarget(seedOf(p.bunny.sessionId), tick, p.at);
      next = stepToward(w, to.x, to.y, WANDER_SPEED, true);
    } else {
      next = stepToward(w, p.x, p.y);
      if (next.x === p.x && next.y === p.y) next = { ...next, home: p.key };
    }
    if (next !== w) {
      scene.walkers.set(p.bunny.sessionId, next);
      moved = moved || next.x !== w.x || next.y !== w.y;
    }
  }
  return moved;
}

/**
 * The viewer's review packets awaiting a decision: the Review tab's pending
 * list, read again on each review update and resync it gets (a newer read
 * wins over a slower older one).
 */
function usePendingReviews(): PendingReview[] {
  const [pending, setPending] = useState<PendingReview[]>([]);
  useEffect(() => {
    let latest = 0;
    let live = true;
    const read = () => {
      const n = ++latest;
      listReviews("pending")
        .then((list) => {
          if (live && n === latest) setPending(list);
        })
        // A collector without the review routes leaves the nook to the review stage.
        .catch(() => {});
    };
    read();
    const off = subscribeReviewUpdates(read);
    return () => {
      live = false;
      off();
    };
  }, []);
  return pending;
}

function readPaused(): boolean {
  try {
    return typeof window !== "undefined" && window.localStorage.getItem(PAUSE_KEY) === "1";
  } catch {
    return false;
  }
}

interface BurrowViewProps {
  sessions: Session[];
  launches: Launch[];
  asks: Ask[];
  jobs: PersonaJob[];
  /** Whether Persona's jobs have loaded (job titles and job-derived waits depend on them). */
  personaLoaded?: boolean;
}

/**
 * The Burrow: one cozy room where every open worker is a chibi bunny at the
 * station for what it is doing (see lib/burrow.ts and lib/burrowRoom.ts),
 * its running subagents trotting after it. When a worker's work changes, its
 * bunny walks across the room to its new station. One canvas draws the room
 * at BURROW_FPS; the loop runs only while the view is mounted and the tab is
 * visible, and not at all under reduced motion or while the owner has paused
 * it, when every bunny stands still at its spot. Each bunny's link (over the
 * canvas) carries its name tag and opens the job or session, and follows it
 * as it walks.
 */
export function BurrowView({ sessions, launches, asks, jobs, personaLoaded = true }: BurrowViewProps) {
  const pendingReviews = usePendingReviews();
  const launchIds = useMemo(() => burrowLaunchIds(sessions, launches, jobs, pendingReviews), [sessions, launches, jobs, pendingReviews]);
  // One read per change of the launch set, then pipeline:updated frames: no polling.
  const { runs, loadedKey } = usePipelineRuns(launchIds, 0);
  // Questions are routed to the viewer as the alert strip routes asks.
  const { currentUser } = usePresence();
  const viewer = currentUser ?? "";
  const bunnies = useMemo(
    () => buildBurrow({ sessions, launches, runs, asks, jobs, viewer, jobsKnown: personaLoaded, pendingReviews }),
    [sessions, launches, runs, asks, jobs, viewer, personaLoaded, pendingReviews]
  );
  const reduced = useMediaQuery(REDUCED_MOTION);
  const [paused, setPaused] = useState(readPaused);
  const still = reduced || paused;

  // The room's light follows the time of day, checked again whenever the tab is shown.
  const [evening, setEvening] = useState(() => isEvening(new Date()));
  useEffect(() => {
    const onShow = () => {
      if (document.visibilityState === "visible") setEvening(isEvening(new Date()));
    };
    document.addEventListener("visibilitychange", onShow);
    return () => document.removeEventListener("visibilitychange", onShow);
  }, []);
  const room = useMemo(() => paintRoom(evening) as CanvasImageSource | null, [evening]);

  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  // Measured before the first paint, so the room never shows at a guessed size.
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver !== "function") return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const scale = roomScale(width || ROOM.w * 2);
  const showTags = scale >= TAG_SCALE;

  // Each bunny keeps its spot while its station stays the same (see
  // layoutRoom); a wait on the viewer takes a door spot from a teammate's,
  // and free door spots go to the longest-waiting first.
  const memoryRef = useRef<SpotMemory>(new Map());
  const layout = useMemo(() => {
    const since = (b: Bunny) => b.waitingSince ?? Number.POSITIVE_INFINITY;
    // What waits on the viewer comes before what waits on a teammate, then the longest wait first.
    const forViewer = (b: Bunny) => (b.wait === "teammate" ? 1 : 0);
    const waiting = bunnies
      .filter((b) => b.activity === "sign")
      .sort((a, b) => forViewer(a) - forViewer(b) || since(a) - since(b));
    const items = [...waiting, ...bunnies.filter((b) => b.activity !== "sign")];
    return layoutRoom(items, (b) => b.activity, (b) => b.sessionId, memoryRef.current, forViewer);
  }, [bunnies]);
  const placed = useMemo<Placed[]>(
    () =>
      layout.placed.map((p) => ({
        bunny: p.item,
        look: lookFor(p.item.sessionId),
        station: p.station,
        spot: p.spot,
        at: STATIONS[p.station].spots[p.spot],
        key: `${p.station}:${p.spot}`,
        x: p.x,
        y: p.y,
      })),
    [layout]
  );
  // Links in station order (what needs the owner first), so Tab walks the room by corner.
  const tabOrder = useMemo(
    () => [...placed].sort((a, b) => STATION_ORDER.indexOf(a.station) - STATION_ORDER.indexOf(b.station) || a.spot - b.spot),
    [placed]
  );

  // Persona's jobs boot after the console's snapshot; if they never come
  // (Persona off), the room settles without them after a short grace.
  const [personaGraceOver, setPersonaGraceOver] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setPersonaGraceOver(true), PERSONA_GRACE_MS);
    return () => clearTimeout(t);
  }, []);
  const ready = (personaLoaded || personaGraceOver) && loadedKey === launchIds.join(",");

  // Where each bunny is now: kept across data updates, so a bunny whose work
  // changed walks from where it stood to its new spot. Until the first full
  // picture is in (Persona's jobs and the runs of the current workers), every
  // bunny is simply at its spot: the room never opens with everyone filing
  // in from the door or walking off to the stage the late data says.
  const walkersRef = useRef<Map<string, Walker>>(new Map());
  const settled = useRef(false);
  const seenRef = useRef<Set<string>>(new Set());
  const sceneRef = useRef<Scene>({ placed, walkers: walkersRef.current, room });
  const linkRefs = useRef(new Map<string, HTMLAnchorElement>());
  const scaleRef = useRef(scale);
  scaleRef.current = scale;

  // Reconciled before paint: a new bunny comes in at the front door; one
  // that was already here, listed past a full station, just appears at its spot.
  useLayoutEffect(() => {
    walkersRef.current = reconcileWalkers(
      walkersRef.current,
      placed.map((p) => ({ id: p.bunny.sessionId, x: p.x, y: p.y, key: p.key })),
      still || !settled.current,
      seenRef.current
    );
    // Spots stick once the room has first settled (and stay sticky while a later read is in flight):
    // until then data still arriving decides who stands where.
    if (ready) settled.current = true;
    if (settled.current) memoryRef.current = spotMemory(layout, (b) => b.sessionId);
    seenRef.current = new Set(bunnies.map((b) => b.sessionId));
    sceneRef.current = { placed, walkers: walkersRef.current, room };
  }, [placed, layout, bunnies, still, room, ready]);

  /**
   * Moves each bunny's link to where the bunny is now, stacked by depth like
   * the canvas draws them (by its spot's depth while it is home, so a stroll
   * never reorders the tags); a bunny home at its spot holds its tag still
   * over the spot while it strolls.
   */
  const placeLinks = () => {
    const s = scaleRef.current;
    const at = new Map(sceneRef.current.placed.map((p) => [p.bunny.sessionId, p]));
    for (const [id, el] of linkRefs.current) {
      const w = walkersRef.current.get(id);
      const p = at.get(id);
      if (!w) continue;
      const home = p !== undefined && w.home === p.key;
      el.style.transform = `translate(${Math.round((w.x - BUNNY_W / 2) * s)}px, ${Math.round((w.y - BUNNY_H) * s)}px)`;
      el.style.zIndex = String(Math.round(home ? p.y : w.y));
      el.style.setProperty("--sx", `${home ? Math.round((p.x - w.x) * s) : 0}px`);
      el.style.setProperty("--sy", `${home ? Math.round((p.y - w.y) * s) : 0}px`);
    }
  };

  const tickRef = useRef(0);
  const occupied = bunnies.length > 0;
  // The loop reads the latest scene each frame, so a data update changes what it draws without restarting it.
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (still || !canvas || !ctx) return;
    const loop = createFrameLoop((tick) => {
      tickRef.current = tick;
      if (stepWalkers(sceneRef.current, tick)) placeLinks();
      drawRoom(ctx, sceneRef.current, tick, false);
    }, BURROW_FPS);
    loop.start();
    return () => loop.stop();
  }, [still]);

  // Redrawn at once on any data, size or motion change (before paint), at the loop's current tick.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    placeLinks();
    if (canvas && ctx) drawRoom(ctx, sceneRef.current, still ? 0 : tickRef.current, still);
  }, [still, placed, room, scale]);

  const togglePause = () => {
    setPaused((p) => {
      try {
        window.localStorage.setItem(PAUSE_KEY, p ? "0" : "1");
      } catch {
        // A browser that won't store it still pauses for this visit.
      }
      return !p;
    });
  };

  // The one popover open (a station's, or the cues'), so opening one shuts any other.
  const [openPop, setOpenPop] = useState<PopId | null>(null);
  const closePop = useCallback(() => setOpenPop(null), []);
  const togglePop = useCallback((id: PopId) => setOpenPop((o) => (o === id ? null : id)), []);
  // A station's popover shuts with its plaque when the room gets too small for tags.
  useEffect(() => {
    if (!showTags) setOpenPop((o) => (o === "cues" ? o : null));
  }, [showTags]);

  const questions = bunnies.filter((b) => b.wait === "question").length;
  const decisions = bunnies.filter((b) => b.wait === "decision").length;
  const helpers = bunnies.reduce((n, b) => n + b.subagents, 0);
  const overflow = STATION_ORDER.flatMap((s) => (layout.overflow[s] ? [[s, layout.overflow[s]!] as [StationId, Bunny[]]] : []));
  const roomW = ROOM.w * scale;

  return (
    <div style={{ height: "100%", overflowY: "auto", background: theme.ground }}>
      <style>{BURROW_CSS}</style>
      <div style={{ maxWidth: ROOM.w * 3 + 40, margin: "0 auto", padding: "18px 20px 28px" }}>
        <div ref={wrapRef} style={{ width: "100%" }}>
          <div style={{ width: roomW, maxWidth: "100%", margin: "0 auto" }}>
            <header style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "6px 16px", marginBottom: 12 }}>
              <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: theme.text }}>Burrow</h2>
              <p data-testid="burrow-summary" style={{ margin: 0, fontSize: 13, color: theme.dim, flex: "1 1 260px" }}>
                <Summary count={bunnies.length} helpers={helpers} questions={questions} decisions={decisions} />
              </p>
              {reduced ? (
                <span style={{ fontSize: 12, color: theme.dim }}>Animation off: your system asks for reduced motion.</span>
              ) : (
                <button
                  type="button"
                  onClick={togglePause}
                  aria-pressed={paused}
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    padding: "4px 10px",
                    borderRadius: 5,
                    border: `1px solid ${theme.edge}`,
                    background: paused ? theme.raised : "transparent",
                    color: theme.text,
                    cursor: "pointer",
                  }}
                >
                  Pause the animation
                </button>
              )}
            </header>
            <a href="#burrow-after-room" className="burrow-skip" style={{ color: theme.accent, fontSize: 12.5 }}>
              Skip past the room
            </a>
            <div style={{ position: "relative", width: roomW, height: ROOM.h * scale }}>
              <canvas
                ref={canvasRef}
                aria-hidden="true"
                data-testid="burrow-canvas"
                width={ROOM.w}
                height={ROOM.h}
                style={{ display: "block", width: roomW, height: ROOM.h * scale, imageRendering: "pixelated", borderRadius: 8 }}
              />
              {!occupied && <EmptyRoom />}
              {showTags &&
                STATION_ORDER.map((id) => (
                  <Plaque key={id} station={id} scale={scale} more={layout.overflow[id]} open={openPop === id} onToggle={togglePop} onClose={closePop} />
                ))}
              <Cues open={openPop === "cues"} onToggle={togglePop} onClose={closePop} />
              <ul aria-label="Workers in the room" aria-hidden={!showTags || undefined} style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {tabOrder.map((p) => (
                  <BunnyLink
                    key={p.bunny.sessionId}
                    bunny={p.bunny}
                    station={p.station}
                    // Every spot has its tag place (TAG_PLACES covers the whole house).
                    tag={TAG_PLACES.get(p.key)!}
                    scale={scale}
                    showTag={showTags}
                    // When the tags are hidden the station list below carries the names and links instead.
                    hidden={!showTags}
                    linkRef={(el) => {
                      if (el) linkRefs.current.set(p.bunny.sessionId, el);
                      else linkRefs.current.delete(p.bunny.sessionId);
                    }}
                  />
                ))}
              </ul>
            </div>
            <div id="burrow-after-room" tabIndex={-1} />
            {!showTags && occupied && <StationList placed={tabOrder} />}
            {overflow.length > 0 && <Overflow groups={overflow} />}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * "30 workers and 10 subagents. 4 need you: 1 with a question, 3 needing a
 * decision." It counts workers (a worker with two asks is one), which is
 * why it is worded apart from the alert strip's count of asks.
 */
function Summary({ count, helpers, questions, decisions }: { count: number; helpers: number; questions: number; decisions: number }) {
  if (count === 0) return <>No workers yet.</>;
  const head = [`${count} worker${count === 1 ? "" : "s"}`, ...(helpers > 0 ? [subagentCount(helpers)] : [])].join(" and ");
  const waiting = questions + decisions;
  if (waiting === 0) return <>{head}. None of them need you.</>;
  const why = [
    ...(questions > 0 ? [`${questions} with a question`] : []),
    ...(decisions > 0 ? [`${decisions} needing a decision`] : []),
  ].join(", ");
  return (
    <>
      {head}.{" "}
      <span style={{ color: theme.waiting, fontWeight: 600 }}>
        {waiting} {waiting === 1 ? "needs" : "need"} you: {why}.
      </span>
    </>
  );
}

/** The empty room: the fire lit and nobody home, with the way to bring a bunny in. */
function EmptyRoom() {
  return (
    <div
      style={{
        position: "absolute",
        left: "50%",
        top: "62%",
        transform: "translate(-50%, -50%)",
        padding: "10px 16px",
        background: TAG.card,
        border: `2px solid ${TAG.ink}`,
        borderRadius: 4,
        boxShadow: `3px 3px 0 ${TAG.shadow}`,
        color: TAG.ink,
        fontSize: 13,
        lineHeight: 1.5,
        textAlign: "center",
        maxWidth: "80%",
      }}
    >
      The fire is lit and nobody is home yet.{" "}
      <Link to="/work" style={{ color: "#8a3a1a", fontWeight: 700 }}>
        Start a worker from Live workers
      </Link>{" "}
      and its bunny moves in.
    </div>
  );
}

/** The words a bunny's tag opens to: its state, and its subagents when it has any. */
function stateLine(b: Bunny): string {
  return b.subagents > 0 ? `${b.state}, ${subagentCount(b.subagents)}` : b.state;
}

/**
 * A bunny's link, laid over the bunny on the canvas (the view moves it as
 * the bunny walks), with its name tag above.
 */
function BunnyLink({
  bunny,
  station,
  tag,
  scale,
  showTag,
  hidden,
  linkRef,
}: {
  bunny: Bunny;
  station: StationId;
  /** Where its spot's tag sits: how high above its head, how wide, and shifted how far to stay inside the walls. */
  tag: TagPlace;
  scale: number;
  showTag: boolean;
  hidden: boolean;
  linkRef: (el: HTMLAnchorElement | null) => void;
}) {
  // Red for what needs the viewer; a teammate's question keeps the cream card with its "?".
  const waiting = bunny.wait === "question" || bunny.wait === "decision";
  const asking = bunny.activity === "sign";
  // A tag raised past its bunny's strolls has a stem down to it.
  const stem = hasStem(tag);
  return (
    <li>
      <Link
        ref={linkRef}
        to={bunny.href}
        aria-label={bunny.ariaLabel}
        aria-hidden={hidden || undefined}
        tabIndex={hidden ? -1 : undefined}
        // The opened tag shows the full title and state; with no tag, the browser's tooltip does.
        title={showTag ? undefined : `${bunny.title}: ${stateLine(bunny)}`}
        data-testid="burrow-bunny"
        data-activity={bunny.activity}
        data-station={station}
        className="burrow-bunny"
        style={{ width: BUNNY_W * scale, height: BUNNY_H * scale }}
      >
        {showTag && (
          <span
            aria-hidden="true"
            className="burrow-tag"
            data-stem={stem || undefined}
            style={{
              bottom: `calc(100% + ${Math.round(tag.rise * scale)}px)`,
              ["--dx" as string]: `${Math.round(tag.dx * scale)}px`,
              ["--stem" as string]: `${Math.round(tag.rise * scale)}px`,
              display: "flex",
              alignItems: "flex-start",
              gap: 5,
              padding: "2px 7px 2px 5px",
              background: waiting ? TAG.wait : TAG.card,
              border: `2px solid ${TAG.ink}`,
              borderRadius: 3,
              boxShadow: `2px 2px 0 ${TAG.shadow}`,
              color: TAG.ink,
              fontSize: 11,
              lineHeight: "14px",
              fontWeight: 700,
              whiteSpace: "nowrap",
            }}
          >
            {asking ? (
              <span
                style={{
                  width: 12,
                  height: 12,
                  marginTop: 1,
                  flexShrink: 0,
                  display: "grid",
                  placeItems: "center",
                  background: TAG.ink,
                  color: "#ffffff",
                  fontSize: 10,
                  lineHeight: "12px",
                  borderRadius: 2,
                }}
              >
                {bunny.wait === "decision" ? "!" : "?"}
              </span>
            ) : (
              <span style={{ width: 6, height: 6, marginTop: 4, background: TAG.workDot, flexShrink: 0 }} />
            )}
            <span style={{ display: "block" }}>
              <span className="burrow-tag-title" style={{ display: "block", maxWidth: tag.width * scale - 30 }}>
                {bunny.title}
              </span>
              <span className="burrow-tag-state">{stateLine(bunny)}</span>
            </span>
          </span>
        )}
      </Link>
    </li>
  );
}

/**
 * A station's name on a wooden plaque at its corner of the scene, with a
 * "+N" when it is full (red when those waiting past it include one for the
 * viewer); the overflow list below the scene names them. Its tooltip is the
 * station's work in a line, and a click opens what lands there.
 */
function Plaque({ station, scale, more, open, onToggle, onClose }: { station: StationId; scale: number; more?: Bunny[] } & PopState) {
  const s = STATIONS[station];
  return (
    <Pop
      id={station}
      open={open}
      onToggle={onToggle}
      onClose={onClose}
      at={{ left: s.plaque[0] * scale, top: s.plaque[1] * scale }}
      up={s.plaque[1] > ROOM.h / 2}
      end={s.plaque[0] > ROOM.w / 2}
      tip={s.work}
      title={s.label}
      testId="burrow-plaque"
      buttonStyle={{ padding: "1px 7px", fontSize: 11.5 }}
      card={<p>{s.about}</p>}
    >
      {s.label}
      {more && more.length > 0 && (
        <span className="burrow-sr">
          , {more.length} more listed below the room{more.some(waitsOnViewer) ? ", waiting on you" : ""}
        </span>
      )}
      {more && more.length > 0 && (
        <span
          aria-hidden="true"
          data-testid="burrow-badge"
          style={{
            padding: "0 4px",
            background: more.some(waitsOnViewer) ? TAG.wait : TAG.card,
            border: `1px solid ${TAG.ink}`,
            borderRadius: 2,
            fontSize: 10.5,
          }}
        >
          +{more.length}
        </span>
      )}
    </Pop>
  );
}

/** A popover in the room: a station's, or the cues'. */
type PopId = StationId | "cues";

/** Whether a popover is the open one, and how it opens and shuts (the view holds which is open). */
interface PopState {
  open: boolean;
  onToggle: (id: PopId) => void;
  onClose: () => void;
}

/**
 * A wooden button over the room with a tooltip (on hover and keyboard focus)
 * that opens a cream card on click, Enter or Space; a click outside or Escape
 * (focus back on the button) shuts it, as the console's other popovers do.
 */
function Pop({
  id,
  open,
  onToggle,
  onClose,
  at,
  up,
  end,
  label,
  tip,
  title,
  testId,
  buttonStyle,
  card,
  children,
}: PopState & {
  id: PopId;
  /** Where its button sits over the room, CSS px. */
  at: CSSProperties;
  /** Opens upward (from the room's bottom half) and toward the left (from its right half). */
  up?: boolean;
  end?: boolean;
  /** The button's name, when its text isn't one. */
  label?: string;
  tip: string;
  /** The card's heading. */
  title: string;
  testId: string;
  buttonStyle: CSSProperties;
  card: ReactNode;
  children: ReactNode;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: Event) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Focus comes back to the button only from the card (or from nowhere), never from elsewhere on the page.
      const from = document.activeElement;
      const back = !from || from === document.body || !!wrapRef.current?.contains(from);
      onClose();
      if (back) buttonRef.current?.focus();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);
  // Escape hides the tooltip too, until the pointer leaves or focus moves on.
  const [hovered, setHovered] = useState(false);
  const [tipOff, setTipOff] = useState(false);
  useEffect(() => {
    if (!hovered || open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setTipOff(true);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [hovered, open]);
  const base = `burrow-pop-${id}`;
  return (
    <div
      ref={wrapRef}
      className="burrow-pop"
      data-open={open || undefined}
      data-up={up || undefined}
      data-end={end || undefined}
      data-tip-off={tipOff || undefined}
      style={at}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => {
        setHovered(false);
        setTipOff(false);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !open) setTipOff(true);
      }}
      // Tabbing on past it shuts the card, so it never covers the bunny that has focus.
      onBlur={(e) => {
        setTipOff(false);
        if (open && e.relatedTarget && !e.currentTarget.contains(e.relatedTarget as Node)) onClose();
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        data-testid={testId}
        className="burrow-pop-btn"
        aria-label={label}
        // The tooltip repeats a button's own name; it only describes one it adds to.
        aria-describedby={tip === label ? undefined : `${base}-tip`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? `${base}-card` : undefined}
        onClick={() => onToggle(id)}
        style={buttonStyle}
      >
        {children}
      </button>
      <span role="tooltip" id={`${base}-tip`} className="burrow-tip" aria-hidden={tip === label || undefined}>
        {tip}
      </span>
      {open && (
        <div role="dialog" id={`${base}-card`} aria-labelledby={`${base}-title`} data-testid="burrow-pop-card" className="burrow-pop-card">
          <h3 id={`${base}-title`}>{title}</h3>
          {card}
        </div>
      )}
    </div>
  );
}

/** What the room's cues mean: the ones no station's plaque explains. */
const CUES: Array<[string, string]> = [
  ["Red bubble and tag", "“?” asks you a question, “!” needs your decision; a cream “?” waits on a teammate"],
  ["Tiny bunnies", "subagents at work"],
  ["+N", "more workers at a full station, listed below the scene"],
];

const CUES_TITLE = "What the tags and tiny bunnies mean";

/** The "?" in the room's top-right corner, opening what the cues mean. */
function Cues(pop: PopState) {
  return (
    <Pop
      {...pop}
      id="cues"
      at={{ right: 8, top: 8 }}
      end
      label={CUES_TITLE}
      tip={CUES_TITLE}
      title={CUES_TITLE}
      testId="burrow-cues"
      buttonStyle={{ width: 24, height: 24, padding: 0, justifyContent: "center", borderRadius: 12, fontSize: 12.5 }}
      card={CUES.map(([term, meaning]) => (
        <p key={term}>
          <strong>{term}:</strong> {meaning}
        </p>
      ))}
    >
      ?
    </Pop>
  );
}

/**
 * The room's workers listed by station (front hall first), each station with
 * its work in a line and what lands there: the names (and the plaques' words)
 * on a screen too narrow for tags.
 */
function StationList({ placed }: { placed: Placed[] }) {
  const groups = STATION_ORDER.map((s) => [s, placed.filter((p) => p.station === s)] as const).filter(([, list]) => list.length > 0);
  return (
    <div data-testid="burrow-stations" style={{ marginTop: 12, display: "grid", gap: 10 }}>
      {groups.map(([station, list]) => (
        <section key={station} aria-label={STATIONS[station].label}>
          <h3 style={{ margin: "0 0 4px", fontSize: 12.5, fontWeight: 700, color: list.some((p) => waitsOnViewer(p.bunny)) ? theme.waiting : theme.text }}>
            {STATIONS[station].label}
            <span style={{ fontWeight: 400, color: theme.dim }}>: {STATIONS[station].work}</span>
          </h3>
          <p style={{ margin: "0 0 4px", fontSize: 12, lineHeight: 1.45, color: theme.dim, maxWidth: 560 }}>{STATIONS[station].about}</p>
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 2 }}>
            {list.map((p) => (
              <li key={p.bunny.sessionId} style={{ fontSize: 12.5, lineHeight: 1.45 }}>
                <Link to={p.bunny.href} aria-label={p.bunny.ariaLabel} style={{ color: theme.text }}>
                  {p.bunny.title}
                </Link>{" "}
                <span style={{ color: theme.dim }}>{stateLine(p.bunny)}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** A question or a decision for the viewer: what draws in red. */
function waitsOnViewer(b: Bunny): boolean {
  return b.wait === "question" || b.wait === "decision";
}

/** The workers a station has no spot left for (front door first): listed by name and state, each a link. */
function Overflow({ groups }: { groups: Array<[StationId, Bunny[]]> }) {
  return (
    <div data-testid="burrow-overflow" style={{ marginTop: 12, fontSize: 12.5, color: theme.dim, lineHeight: 1.6 }}>
      {groups.map(([station, list]) => (
        <p key={station} style={{ margin: 0 }}>
          <span style={{ color: list.some(waitsOnViewer) ? theme.waiting : theme.text, fontWeight: 600 }}>
            {list.length} more at the {STATIONS[station].label.toLowerCase()}:
          </span>{" "}
          {list.map((b, i) => (
            <span key={b.sessionId}>
              {i > 0 && "; "}
              <Link to={b.href} aria-label={b.ariaLabel} style={{ color: theme.text }}>
                {b.title}
              </Link>{" "}
              ({stateLine(b)})
            </span>
          ))}
        </p>
      ))}
    </div>
  );
}
