import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import type { Launch, Session } from "@standup/shared";
import type { Root } from "react-dom/client";
import { GlobalWindow } from "happy-dom";

// react-dom decides whether a DOM exists when it is first imported, so the
// window is installed before the view modules load.
const window = new GlobalWindow({ url: "http://localhost/" });
const GLOBALS = [
  "window",
  "document",
  "navigator",
  "Node",
  "HTMLElement",
  "Element",
  "Text",
  "Event",
  "MutationObserver",
] as const;
const saved = new Map<string, unknown>();
const savedFetch = globalThis.fetch;

let act: (fn: () => void | Promise<void>) => Promise<void>;
let createRoot: (el: Element) => Root;
let MemoryRouter: typeof import("react-router-dom").MemoryRouter;
let mod: typeof import("./BurrowView");
let STATIONS: typeof import("../lib/burrowRoom").STATIONS;
let TAG_PLACES: typeof import("../lib/burrowRoom").TAG_PLACES;

/** Frames scheduled and not yet run or cancelled; the test runs them by hand. */
const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 1;
let reduceMotion = false;

/** A 2D context that accepts every call and draws nothing. */
const fakeCtx = new Proxy({} as Record<string | symbol, unknown>, {
  get: (target, key) => (key in target ? target[key] : () => {}),
  set: (target, key, value) => {
    target[key] = value;
    return true;
  },
});

beforeAll(async () => {
  for (const name of GLOBALS) {
    saved.set(name, (globalThis as Record<string, unknown>)[name]);
    (globalThis as Record<string, unknown>)[name] = (window as unknown as Record<string, unknown>)[name];
  }
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  const w = window as unknown as Record<string, unknown>;
  w.requestAnimationFrame = (cb: FrameRequestCallback) => {
    const id = nextFrame++;
    frames.set(id, cb);
    return id;
  };
  w.cancelAnimationFrame = (id: number) => void frames.delete(id);
  w.matchMedia = (query: string) => ({
    matches: query.includes("reduced-motion") && reduceMotion,
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  (window.HTMLCanvasElement.prototype as unknown as { getContext: () => unknown }).getContext = () => fakeCtx;
  globalThis.fetch = (async () => new Response(JSON.stringify({ runs: [] }), { status: 200 })) as unknown as typeof fetch;
  ({ act } = (await import("react")) as unknown as { act: typeof act });
  ({ createRoot } = await import("react-dom/client"));
  ({ MemoryRouter } = await import("react-router-dom"));
  mod = await import("./BurrowView");
  ({ STATIONS, TAG_PLACES } = await import("../lib/burrowRoom"));
});

afterAll(async () => {
  for (const [name, value] of saved) (globalThis as Record<string, unknown>)[name] = value;
  globalThis.fetch = savedFetch;
  await window.happyDOM.close();
});

beforeEach(() => {
  frames.clear();
  reduceMotion = false;
});

function session(id: string, over: Partial<Session> = {}): Session {
  return { id, projectId: "standup", title: `Worker ${id}`, cwd: "/tmp", status: "running", startedAt: new Date(), owned: true, ...over } as Session;
}

async function render(sessions: Session[]) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  await act(async () => {
    root.render(
      createElement(MemoryRouter, null, createElement(mod.BurrowView, { sessions, launches: [], asks: [], jobs: [] }))
    );
  });
  return {
    host,
    unmount: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

describe("BurrowView", () => {
  test("each open worker is a link named for the worker and its state", async () => {
    const view = await render([
      session("a"),
      session("b", { status: "waiting" }),
      session("a:1", { parentSessionId: "a", kind: "subagent" }),
    ]);
    const links = [...view.host.querySelectorAll("[data-testid=burrow-bunny]")];
    expect(links.map((l) => l.getAttribute("aria-label")).sort()).toEqual([
      "Worker a: coding, 1 subagent",
      "Worker b: has a question for you",
    ].sort());
    expect(links.map((l) => l.getAttribute("href")).sort()).toEqual(["/work/s/a", "/work/s/b"]);
    // Tab order walks the house by station, the front hall (waiting on you) first.
    expect(links.map((l) => l.getAttribute("data-station"))).toEqual(["hall", "forge"]);
    expect(view.host.querySelector("[data-testid=burrow-summary]")?.textContent).toBe(
      "2 workers and 1 subagent. 1 needs you: 1 with a question."
    );
    expect(view.host.querySelector("canvas")?.getAttribute("aria-hidden")).toBe("true");
    await view.unmount();
  });

  test("the frame loop runs while mounted and stops on unmount", async () => {
    const view = await render([session("a")]);
    expect(frames.size).toBe(1);
    // Running a frame schedules the next one.
    for (const [id, cb] of [...frames]) {
      frames.delete(id);
      cb(1000);
    }
    expect(frames.size).toBe(1);
    await view.unmount();
    expect(frames.size).toBe(0);
  });

  test("the loop stops while the tab is hidden and resumes when it shows", async () => {
    const view = await render([session("a")]);
    const doc = document as unknown as { visibilityState: string; dispatchEvent: (e: Event) => boolean };
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    await act(async () => void doc.dispatchEvent(new window.Event("visibilitychange") as unknown as Event));
    expect(frames.size).toBe(0);
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    await act(async () => void doc.dispatchEvent(new window.Event("visibilitychange") as unknown as Event));
    expect(frames.size).toBe(1);
    await view.unmount();
    expect(frames.size).toBe(0);
  });

  test("under reduced motion no frame is scheduled at all", async () => {
    reduceMotion = true;
    const view = await render([session("a")]);
    expect(frames.size).toBe(0);
    expect(view.host.querySelectorAll("[data-testid=burrow-bunny]").length).toBe(1);
    await view.unmount();
  });

  test("an empty burrow shows the lit room, nobody home, and points to Work", async () => {
    const view = await render([session("gone", { endedAt: new Date() })]);
    expect(view.host.querySelector("canvas")).not.toBeNull();
    expect(view.host.textContent).toContain("nobody is home yet");
    expect(view.host.querySelector('a[href="/work"]')).not.toBeNull();
    await view.unmount();
    expect(frames.size).toBe(0);
  });

  test("pausing the room stops the loop and keeps the choice; animating starts it again", async () => {
    const view = await render([session("a")]);
    expect(frames.size).toBe(1);
    const button = [...view.host.querySelectorAll("button")].find((b) => b.textContent === "Pause the animation")!;
    await act(async () => void button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }) as unknown as Event));
    expect(frames.size).toBe(0);
    expect(window.localStorage.getItem("standup:burrow:paused")).toBe("1");
    expect(button.getAttribute("aria-pressed")).toBe("true");
    await act(async () => void button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }) as unknown as Event));
    expect(frames.size).toBe(1);
    expect(window.localStorage.getItem("standup:burrow:paused")).toBe("0");
    await view.unmount();
  });

  test("the summary splits who waits on you into questions and decisions", async () => {
    const view = await render([
      session("q", { status: "waiting" }),
      session("d", { status: "running" }),
    ]);
    expect(view.host.querySelector("[data-testid=burrow-summary]")?.textContent).toBe(
      "2 workers. 1 needs you: 1 with a question."
    );
    await view.unmount();
  });
});

describe("BurrowView movement", () => {
  /** Renders, and returns a rerender and the frame runner. */
  async function mount(sessions: Session[]) {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host as unknown as Element);
    const draw = (list: Session[]) =>
      act(async () => {
        root.render(createElement(MemoryRouter, null, createElement(mod.BurrowView, { sessions: list, launches: [], asks: [], jobs: [] })));
      });
    await draw(sessions);
    let now = 0;
    const runFrames = async (n: number) => {
      for (let i = 0; i < n; i++) {
        now += 1000 / 12 + 1;
        await act(async () => {
          for (const [id, cb] of [...frames]) {
            frames.delete(id);
            cb(now);
          }
        });
      }
    };
    const link = (id: string) => host.querySelector(`[data-testid=burrow-bunny][href="/work/s/${id}"]`) as HTMLElement;
    return {
      host,
      draw,
      runFrames,
      link,
      unmount: async () => {
        await act(async () => root.unmount());
        host.remove();
      },
    };
  }

  const at = (el: HTMLElement) => el.style.transform;

  test("on the first paint each bunny is already at its station", async () => {
    const view = await mount([session("a")]);
    const before = at(view.link("a"));
    await view.runFrames(3);
    expect(at(view.link("a"))).toBe(before);
    expect(view.link("a").getAttribute("data-station")).toBe("forge");
    await view.unmount();
  });

  test("when its work changes, a bunny walks from where it stood to its new station, and its link follows", async () => {
    const view = await mount([session("a")]);
    const atBench = at(view.link("a"));
    await view.draw([session("a", { status: "waiting" })]);
    expect(view.link("a").getAttribute("data-station")).toBe("hall");
    // It has not teleported: the link is still where the bunny stood.
    expect(at(view.link("a"))).toBe(atBench);
    await view.runFrames(4);
    const halfway = at(view.link("a"));
    expect(halfway).not.toBe(atBench);
    await view.runFrames(120);
    const arrived = at(view.link("a"));
    await view.runFrames(5);
    expect(at(view.link("a"))).toBe(arrived);
    expect(arrived).not.toBe(halfway);
    await view.unmount();
  });

  /** Where a link sits when its bunny stands at the front door's threshold (at the test's 2x). */
  const atDoor = "translate(2px, 594px)";

  test("the first worker into a settled, empty room walks in from the front door", async () => {
    const view = await mount([]);
    await view.draw([session("a")]);
    expect(at(view.link("a"))).toBe(atDoor);
    await view.runFrames(120);
    expect(at(view.link("a"))).not.toBe(atDoor);
    await view.unmount();
  });

  test("a worker that appears later comes in at the front door and walks to its station", async () => {
    const view = await mount([session("a")]);
    await view.draw([session("a"), session("b", { startedAt: new Date(Date.now() + 1000) })]);
    expect(at(view.link("b"))).toBe(atDoor);
    await view.runFrames(120);
    expect(at(view.link("b"))).not.toBe(atDoor);
    await view.unmount();
  });

  test("until Persona's jobs are in, a bunny whose work changes is just at its new spot", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host as unknown as Element);
    const draw = (list: Session[]) =>
      act(async () => {
        root.render(
          createElement(MemoryRouter, null, createElement(mod.BurrowView, { sessions: list, launches: [], asks: [], jobs: [], personaLoaded: false }))
        );
      });
    await draw([session("a")]);
    const link = () => host.querySelector('[data-testid=burrow-bunny][href="/work/s/a"]') as HTMLElement;
    const atBench = link().style.transform;
    await draw([session("a", { status: "waiting" })]);
    // Not settled yet: it snapped to the hall rather than starting a walk from the forge.
    expect(link().style.transform).not.toBe(atBench);
    expect(link().getAttribute("data-station")).toBe("hall");
    await act(async () => root.unmount());
    host.remove();
  });

  test("while a later runs read is in flight, a bunny that took a spot keeps it when another arrives", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host as unknown as Element);
    const draw = (list: Session[], launches: Launch[]) =>
      act(async () => {
        root.render(createElement(MemoryRouter, null, createElement(mod.BurrowView, { sessions: list, launches, asks: [], jobs: [] })));
      });
    const t = (i: number) => new Date(Date.now() + i * 1000);
    // All but one of the forge's spots taken, and an older worker in the hall.
    const forge = Array.from({ length: STATIONS.forge.spots.length - 1 }, (_, i) => session(`b${i}`, { startedAt: t(i + 1) }));
    const older = session("old", { status: "waiting", startedAt: t(0) });
    const pending = globalThis.fetch;
    try {
      await draw([older, ...forge], []);
      // A new worker with a launch: its runs read never answers, so the room isn't ready again.
      globalThis.fetch = (() => new Promise(() => {})) as unknown as typeof fetch;
      const late = session("late", { startedAt: t(9) });
      const launches = [{ id: "l-late", sessionId: "late", status: "running", createdAt: new Date().toISOString() } as unknown as Launch];
      await draw([older, ...forge, late], launches);
      expect(host.querySelector('[data-testid=burrow-bunny][href="/work/s/late"]')?.getAttribute("data-station")).toBe("forge");
      // The older worker comes to the full forge: it waits in the overflow, the late one keeps its spot.
      await draw([session("old", { startedAt: t(0) }), ...forge, late], launches);
      expect(host.querySelector('[data-testid=burrow-bunny][href="/work/s/late"]')?.getAttribute("data-station")).toBe("forge");
      expect(host.querySelector("[data-testid=burrow-overflow]")?.textContent).toContain("Worker old");
    } finally {
      globalThis.fetch = pending;
      await act(async () => root.unmount());
      host.remove();
    }
  });

  test("under reduced motion a bunny whose work changes is simply at its new station", async () => {
    reduceMotion = true;
    const view = await mount([session("a")]);
    const atBench = at(view.link("a"));
    await view.draw([session("a", { status: "waiting" })]);
    expect(frames.size).toBe(0);
    expect(at(view.link("a"))).not.toBe(atBench);
    await view.unmount();
  });
});

describe("BurrowView for a viewer with teammates", () => {
  async function renderAs(viewer: string, sessions: Session[]) {
    const { PresenceProvider } = await import("../hooks/presence");
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host as unknown as Element);
    const presence = { roster: [], currentUser: viewer, setViewing: () => {}, setTyping: () => {} };
    await act(async () => {
      root.render(
        createElement(
          PresenceProvider,
          { value: presence },
          createElement(MemoryRouter, null, createElement(mod.BurrowView, { sessions, launches: [], asks: [], jobs: [] }))
        )
      );
    });
    return {
      host,
      unmount: async () => {
        await act(async () => root.unmount());
        host.remove();
      },
    };
  }

  test("a teammate's waiting worker stands in the hall with a cream tag and isn't counted as needing you", async () => {
    const view = await renderAs("owner", [session("t", { status: "waiting", ownerActor: "alice" } as Partial<Session>)]);
    expect(view.host.querySelector("[data-testid=burrow-summary]")?.textContent).toBe("1 worker. None of them need you.");
    const link = view.host.querySelector("[data-testid=burrow-bunny]")!;
    expect(link.getAttribute("data-station")).toBe("hall");
    expect(link.getAttribute("aria-label")).toBe("Worker t: waiting on alice");
    expect((link.querySelector(".burrow-tag") as HTMLElement).style.background).not.toContain("255, 92, 114");
    await view.unmount();
  });

  test("a question for the viewer takes a hall spot from a teammate's wait that already held one", async () => {
    const theirs = Array.from({ length: STATIONS.hall.spots.length }, (_, i) =>
      session(`t${i}`, { status: "waiting", ownerActor: "alice", startedAt: new Date(Date.now() + i) } as Partial<Session>)
    );
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host as unknown as Element);
    const { PresenceProvider } = await import("../hooks/presence");
    const presence = { roster: [], currentUser: "owner", setViewing: () => {}, setTyping: () => {} };
    const draw = (list: Session[]) =>
      act(async () => {
        root.render(
          createElement(
            PresenceProvider,
            { value: presence },
            createElement(MemoryRouter, null, createElement(mod.BurrowView, { sessions: list, launches: [], asks: [], jobs: [] }))
          )
        );
      });
    await draw(theirs);
    expect(host.querySelector("[data-testid=burrow-overflow]")).toBeNull();
    await draw([...theirs, session("mine", { status: "waiting", ownerActor: "owner", startedAt: new Date(Date.now() + 100) } as Partial<Session>)]);
    const mine = host.querySelector('[data-testid=burrow-bunny][href="/work/s/mine"]');
    expect(mine?.getAttribute("data-station")).toBe("hall");
    const overflow = host.querySelector("[data-testid=burrow-overflow]")?.textContent ?? "";
    expect(overflow).toContain("1 more at the front hall");
    // The hall's plaque counts the one waiting past it, in cream: it waits on a teammate.
    expect(host.querySelector("[data-testid=burrow-badge]")?.textContent).toBe("+1");
    expect(overflow).toContain("waiting on alice");
    await act(async () => root.unmount());
    host.remove();
  });

  test("each tag sits where its spot's tag place says: shifted to stay inside its station's walls", async () => {
    const view = await renderAs("owner", [session("a", { status: "waiting" }), session("b", { startedAt: new Date(Date.now() + 1000) })]);
    const tag = (id: string) => view.host.querySelector(`[href="/work/s/${id}"] .burrow-tag`) as HTMLElement;
    // At the test's 2x.
    expect(tag("a").style.getPropertyValue("--dx")).toBe(`${Math.round(TAG_PLACES.get("hall:0")!.dx * 2)}px`);
    expect(tag("b").style.getPropertyValue("--dx")).toBe(`${Math.round(TAG_PLACES.get("forge:0")!.dx * 2)}px`);
    await view.unmount();
  });
});

describe("BurrowView plaques and wandering", () => {
  test("every station's plaque names it, its tooltip says what work goes there, and there is no legend", async () => {
    const view = await render([session("a")]);
    const plaques = [...view.host.querySelectorAll("[data-testid=burrow-plaque]")];
    expect(plaques.map((p) => p.textContent).sort()).toEqual(Object.values(STATIONS).map((s) => s.label).sort());
    for (const p of plaques) {
      const s = Object.values(STATIONS).find((st) => st.label === p.textContent)!;
      const tip = view.host.querySelector(`[id="${p.getAttribute("aria-describedby")}"]`);
      expect({ station: s.id, role: tip?.getAttribute("role"), tip: tip?.textContent }).toEqual({ station: s.id, role: "tooltip", tip: s.work });
      // The tooltip shows on hover and on keyboard focus.
      expect(tip?.className).toBe("burrow-tip");
    }
    expect(mod.BURROW_CSS).toContain(".burrow-pop:hover .burrow-tip, .burrow-pop-btn:focus-visible + .burrow-tip { display: block; }");
    // Escape on a plaque hides its tooltip until focus moves on.
    const living = plaques.find((p) => p.textContent === STATIONS.living.label) as HTMLButtonElement;
    const wrap = living.parentElement!;
    await act(async () => void living.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as unknown as Event));
    expect(wrap.hasAttribute("data-tip-off")).toBe(true);
    expect(mod.BURROW_CSS).toContain(".burrow-pop[data-tip-off] .burrow-tip { display: none; }");
    expect(view.host.querySelector("dl")).toBeNull();
    await view.unmount();
  });

  test("a plaque opens what lands at its station; one popover at a time, shut by Escape or a click outside", async () => {
    const view = await render([session("a")]);
    const plaque = (id: string) =>
      [...view.host.querySelectorAll("[data-testid=burrow-plaque]")].find((p) => p.textContent === STATIONS[id as keyof typeof STATIONS].label) as HTMLButtonElement;
    const cards = () => [...view.host.querySelectorAll("[data-testid=burrow-pop-card]")];
    const down = (el: EventTarget) => el.dispatchEvent(new window.Event("pointerdown", { bubbles: true }) as unknown as Event);
    // A real click: the press, then the click.
    const press = async (el: Element) =>
      act(async () => {
        down(el);
        (el as HTMLElement).click();
      });

    await press(plaque("living"));
    expect(cards().map((c) => c.textContent)).toEqual([`${STATIONS.living.label}${STATIONS.living.about}`]);
    expect(cards()[0].getAttribute("role")).toBe("dialog");
    expect(plaque("living").getAttribute("aria-expanded")).toBe("true");
    expect(plaque("living").getAttribute("aria-controls")).toBe(cards()[0].id);
    // A click inside the card leaves it open.
    await act(async () => void down(cards()[0]));
    expect(cards()).toHaveLength(1);

    // Another plaque's opens in its place.
    await press(plaque("forge"));
    expect(cards().map((c) => c.textContent)).toEqual([`${STATIONS.forge.label}${STATIONS.forge.about}`]);
    expect(plaque("living").getAttribute("aria-expanded")).toBe("false");

    // Escape shuts it, back on its plaque.
    await act(async () => void document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" }) as unknown as Event));
    expect(cards()).toHaveLength(0);
    expect(document.activeElement).toBe(plaque("forge"));

    // So does a click outside, and a second click on the plaque.
    await press(plaque("forge"));
    await act(async () => void down(document.body));
    expect(cards()).toHaveLength(0);
    await press(plaque("pond"));
    await press(plaque("pond"));
    expect(cards()).toHaveLength(0);
    await view.unmount();
  });

  test("a worker whose packet waits on the owner's review reads in the reading nook, from the Review tab's pending list", async () => {
    const asked: string[] = [];
    const before = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      asked.push(String(url));
      const body = String(url).startsWith("/api/reviews?status=pending")
        ? { reviews: [{ id: "rp1", launchId: null, jobId: null, sessionId: "a" }] }
        : { runs: [] };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const view = await render([session("a", { status: "idle" })]);
      await act(async () => {});
      const link = view.host.querySelector("[data-testid=burrow-bunny]");
      expect(link?.getAttribute("data-station")).toBe("nook");
      expect(link?.getAttribute("href")).toBe("/review/rp1");
      expect(asked.filter((u) => u.startsWith("/api/reviews"))).toEqual(["/api/reviews?status=pending"]);
      await view.unmount();
    } finally {
      globalThis.fetch = before;
    }
  });

  test("the info button opens what the tags and the tiny bunnies mean", async () => {
    const view = await render([session("a")]);
    const info = view.host.querySelector("[data-testid=burrow-cues]") as HTMLButtonElement;
    expect(info.getAttribute("aria-label")).toBe("What the tags and tiny bunnies mean");
    await act(async () => info.click());
    const card = view.host.querySelector("[data-testid=burrow-pop-card]");
    expect(card?.textContent).toContain("Red bubble and tag: “?” asks you a question, “!” needs your decision; a cream “?” waits on a teammate");
    expect(card?.textContent).toContain("Tiny bunnies: subagents at work");
    expect(card?.textContent).toContain("+N: more workers at a full station");
    await view.unmount();
  });

  test("a bunny at home now and then strolls a little round its spot, never off its station, and comes back", async () => {
    const view = await render([session("a")]);
    const link = view.host.querySelector("[data-testid=burrow-bunny]") as HTMLElement;
    const home = link.style.transform;
    const [x0, y0, x1, y1] = STATIONS.forge.spots[0].wander;
    const seen = new Set<string>();
    let now = 0;
    for (let i = 0; i < 400; i++) {
      now += 1000 / 12 + 1;
      await act(async () => {
        for (const [id, cb] of [...frames]) {
          frames.delete(id);
          cb(now);
        }
      });
      const m = /translate\((-?\d+)px, (-?\d+)px\)/.exec(link.style.transform)!;
      // Back from the link's corner to the bunny's feet (at the test's 2x).
      const fx = Number(m[1]) / 2 + 15;
      const fy = Number(m[2]) / 2 + 33;
      expect(fx).toBeGreaterThanOrEqual(x0 - 1);
      expect(fx).toBeLessThanOrEqual(x1 + 1);
      expect(fy).toBeGreaterThanOrEqual(y0 - 1);
      expect(fy).toBeLessThanOrEqual(y1 + 1);
      seen.add(link.style.transform);
      // Its tag holds still over the spot while it strolls: the link's move, undone.
      const sx = Number(link.style.getPropertyValue("--sx").replace("px", ""));
      const sy = Number(link.style.getPropertyValue("--sy").replace("px", ""));
      const [hx, hy] = /translate\((-?\d+)px, (-?\d+)px\)/.exec(home)!.slice(1).map(Number);
      expect(Math.abs(Number(m[1]) + sx - hx)).toBeLessThanOrEqual(1);
      expect(Math.abs(Number(m[2]) + sy - hy)).toBeLessThanOrEqual(1);
    }
    expect(seen.size).toBeGreaterThan(2);
    expect(seen.has(home)).toBe(true);
    await view.unmount();
  });

  test("under reduced motion nobody wanders", async () => {
    reduceMotion = true;
    const view = await render([session("a")]);
    const link = view.host.querySelector("[data-testid=burrow-bunny]") as HTMLElement;
    const home = link.style.transform;
    expect(frames.size).toBe(0);
    expect(link.style.transform).toBe(home);
    await view.unmount();
  });
});

describe("roomScale", () => {
  test("as many CSS pixels per art pixel as fit the width, between half and three", () => {
    expect(mod.roomScale(390)).toBe(390 / 720);
    expect(mod.roomScale(1440)).toBe(2);
    expect(mod.roomScale(1400)).toBe(1400 / 720);
    expect(mod.roomScale(2160)).toBe(3);
    expect(mod.roomScale(4000)).toBe(3);
    expect(mod.roomScale(100)).toBe(0.5);
  });
});
