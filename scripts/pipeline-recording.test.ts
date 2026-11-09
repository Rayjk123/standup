import { describe, expect, test } from "bun:test";
import {
  MarkTimeline,
  PERSONA_MARKS,
  RECORDING_LIMITS,
  REPORT_BINDING,
  navigationError,
  overlayScript,
  parseRecordArgs,
  stopConditionMet,
  unreachedMarks,
} from "./pipeline-recording";
import type { PageReport, RecordingMark, RecordingState } from "./pipeline-recording";

const URL = "http://localhost:5173/";

describe("pipeline-recording parseRecordArgs", () => {
  test("applies desktop defaults", () => {
    expect(parseRecordArgs([URL])).toEqual({
      url: URL,
      out: undefined,
      loginUrl: undefined,
      marks: [],
      until: undefined,
      durationMs: undefined,
      timeoutMs: 15_000,
      tailMs: 1_200,
      width: 1280,
      height: 800,
      overlay: true,
    });
  });

  test("reads every flag", () => {
    const args = parseRecordArgs([
      URL,
      "--out",
      "/tmp/rec/a.webm",
      "--login-url",
      "http://localhost:5173/login?code=x",
      "--cold",
      "--mark",
      "chart drawn = svg.chart",
      "--until",
      "#done",
      "--timeout-ms",
      "20000",
      "--tail-ms",
      "300",
      "--width",
      "1024",
      "--height",
      "640",
      "--no-overlay",
    ]);
    expect(args).toMatchObject({
      out: "/tmp/rec/a.webm",
      loginUrl: "http://localhost:5173/login?code=x",
      marks: [{ label: "chart drawn", selector: "svg.chart" }],
      until: "#done",
      timeoutMs: 20_000,
      tailMs: 300,
      width: 1024,
      height: 640,
      overlay: false,
    });
  });

  test("--cold is accepted: every recording is a cold load", () => {
    expect(parseRecordArgs([URL, "--cold"])).toEqual(parseRecordArgs([URL]));
  });

  test("the persona preset adds the composer and messages marks", () => {
    expect(parseRecordArgs([URL, "--preset", "persona"]).marks).toEqual([...PERSONA_MARKS]);
    expect(PERSONA_MARKS.map((m) => m.label)).toEqual(["composer interactive", "latest messages rendered"]);
    expect(() => parseRecordArgs([URL, "--preset", "nope"])).toThrow("--preset must be one of persona");
  });

  test("a selector may itself contain '='", () => {
    expect(parseRecordArgs([URL, "--mark", "ready=[data-state=ready]"]).marks).toEqual([{ label: "ready", selector: "[data-state=ready]" }]);
  });

  test("a mark can't take a built-in mark's label", () => {
    for (const label of ["navigation start", "first paint", "first contentful paint", "navigation → /x"]) {
      expect(() => parseRecordArgs([URL, "--mark", `${label}=#x`])).toThrow("is a built-in mark");
    }
  });

  test("the viewport stays desktop-sized and capped", () => {
    expect(() => parseRecordArgs([URL, "--width", "390"])).toThrow("--width must be an integer from 1024 to 1280");
    expect(() => parseRecordArgs([URL, "--width", "1920"])).toThrow("from 1024 to 1280");
    expect(() => parseRecordArgs([URL, "--height", "1080"])).toThrow("--height must be an integer from 600 to 800");
  });

  test("the length is capped", () => {
    expect(() => parseRecordArgs([URL, "--timeout-ms", String(RECORDING_LIMITS.maxTimeoutMs + 1)])).toThrow("--timeout-ms");
    expect(() => parseRecordArgs([URL, "--duration-ms", "60000"])).toThrow("--duration-ms");
    expect(() => parseRecordArgs([URL, "--tail-ms", "9000"])).toThrow("--tail-ms");
    // The tail is long enough for the stopped overlay to reach the video.
    expect(() => parseRecordArgs([URL, "--tail-ms", "0"])).toThrow("--tail-ms must be an integer from 300 to 5000");
    // A duration longer than the timeout raises the timeout to it.
    expect(parseRecordArgs([URL, "--duration-ms", "20000"]).timeoutMs).toBe(20_000);
  });

  test("numbers are plain decimal digits", () => {
    for (const raw of ["", "1e3", "0x10", "-5", "12.5", " 100"]) {
      expect(() => parseRecordArgs([URL, "--tail-ms", raw])).toThrow("--tail-ms must be an integer");
    }
  });

  test("refuses bad input", () => {
    expect(() => parseRecordArgs([])).toThrow("missing URL");
    expect(() => parseRecordArgs([URL, "--out", "rec.webm"])).toThrow("absolute path");
    expect(() => parseRecordArgs([URL, "--out", "/tmp/rec.mp4"])).toThrow("must end in .webm");
    expect(() => parseRecordArgs([URL, "--mark", "no-selector"])).toThrow("--mark takes LABEL=CSS_SELECTOR");
    expect(() => parseRecordArgs([URL, "--mark", "=x"])).toThrow("--mark takes");
    expect(() => parseRecordArgs([URL, "--mark", "a=x", "--mark", "a=y"])).toThrow('mark "a" is given twice');
    expect(() => parseRecordArgs([URL, "--bogus"])).toThrow("unknown flag --bogus");
    expect(() => parseRecordArgs([URL, URL])).toThrow("unexpected extra argument");
  });
});

describe("pipeline-recording stop condition", () => {
  const marks: RecordingMark[] = [
    { label: "a", selector: "#a" },
    { label: "b", selector: "#b" },
  ];
  const state = (labels: string[], untilMet = false): RecordingState => ({ marks: labels.map((label, i) => ({ label, ms: i })), untilMet });

  test("a duration wins over marks and --until", () => {
    const args = { durationMs: 3000, until: "#x", marks };
    expect(stopConditionMet(args, state(["a", "b"], true), 2999)).toBe(false);
    expect(stopConditionMet(args, state([]), 3000)).toBe(true);
  });

  test("--until waits for its selector and every mark", () => {
    expect(stopConditionMet({ until: "#x", marks }, state(["a", "b"]), 9000)).toBe(false);
    expect(stopConditionMet({ until: "#x", marks }, state(["a"], true), 1)).toBe(false);
    expect(stopConditionMet({ until: "#x", marks }, state(["a", "b"], true), 1)).toBe(true);
    expect(stopConditionMet({ until: "#x", marks: [] }, state([], true), 1)).toBe(true);
  });

  test("without --until it waits for every mark, else 5 s", () => {
    expect(stopConditionMet({ marks }, state(["navigation start", "a"]), 9000)).toBe(false);
    expect(stopConditionMet({ marks }, state(["a", "b"]), 1)).toBe(true);
    expect(stopConditionMet({ marks: [] }, state([]), 4999)).toBe(false);
    expect(stopConditionMet({ marks: [] }, state([]), 5000)).toBe(true);
  });

  test("names the marks never reached", () => {
    expect(unreachedMarks({ until: "#x", marks }, state(["a"]))).toEqual(["b", "until #x"]);
    expect(unreachedMarks({ marks }, state(["a", "b"]))).toEqual([]);
  });
});

describe("pipeline-recording navigationError", () => {
  const nav = (status: number, opts: { navigation?: boolean; mainFrame?: boolean } = {}) => ({
    status,
    navigation: opts.navigation ?? true,
    mainFrame: opts.mainFrame ?? true,
  });

  test("any main-frame document answered with an HTTP error fails the load, the first one or a later navigation", () => {
    expect(navigationError(nav(404))).toBe("HTTP 404");
    expect(navigationError(nav(500))).toBe("HTTP 500");
  });

  test("successes, redirects, subresources and iframes don't", () => {
    for (const ok of [nav(200), nav(204), nav(302), nav(404, { navigation: false }), nav(500, { mainFrame: false })]) {
      expect(navigationError(ok)).toBeNull();
    }
  });
});

describe("pipeline-recording MarkTimeline", () => {
  const report = (origin: number, path: string, label?: string, ms?: number, until?: boolean): PageReport => ({ origin, path, label, ms, until });

  test("measures every document from the first one's navigation start and keeps earlier marks", () => {
    const t = new MarkTimeline();
    expect(t.add(report(1_000_000, "/one", "navigation start", 0))).toBe(true);
    t.add(report(1_000_000, "/one", "a", 26));
    t.add(report(1_000_000, "/one", "first contentful paint", 40));
    expect(t.add(report(1_000_324, "/two", "navigation start", 0))).toBe(true);
    // A later document's paint doesn't replace the first one's.
    t.add(report(1_000_324, "/two", "first contentful paint", 30));
    t.add(report(1_000_324, "/two", "b", 216));
    expect(t.offsetOf(1_000_324)).toBe(324);
    expect(t.state().marks).toEqual([
      { label: "navigation start", ms: 0 },
      { label: "a", ms: 26 },
      { label: "first contentful paint", ms: 40 },
      { label: "navigation → /two", ms: 324 },
      { label: "b", ms: 540 },
    ]);
  });

  test("a blank first document's missing paint comes from the next one", () => {
    const t = new MarkTimeline();
    t.add(report(5_000, "/", "navigation start", 0));
    t.add(report(5_120, "/login", "navigation start", 0));
    t.add(report(5_120, "/login", "first contentful paint", 80));
    t.add(report(5_400, "/", "navigation start", 0));
    expect(t.state().marks).toEqual([
      { label: "navigation start", ms: 0 },
      { label: "navigation → /login", ms: 120 },
      { label: "first contentful paint", ms: 200 },
      { label: "navigation → /", ms: 400 },
    ]);
  });

  test("--until stays met once any document matched it", () => {
    const t = new MarkTimeline();
    t.add(report(1, "/", undefined, undefined, true));
    t.add(report(9, "/next", "navigation start", 0));
    expect(t.state().untilMet).toBe(true);
  });

  test("nothing reached after stop() is recorded", () => {
    const t = new MarkTimeline();
    t.add(report(1_000, "/", "navigation start", 0));
    t.stop(2_500);
    t.add(report(1_000, "/", "first contentful paint", 1_400));
    t.add(report(1_000, "/", "overlay paint", 1_516));
    t.add(report(1_000, "/", undefined, undefined, true));
    expect(t.state()).toEqual({
      marks: [
        { label: "navigation start", ms: 0 },
        { label: "first contentful paint", ms: 1_400 },
      ],
      untilMet: false,
    });
  });

  test("the first document seen starts the timeline; an earlier origin can't move it", () => {
    const t = new MarkTimeline();
    t.add(report(1_000_000, "/", "navigation start", 0));
    expect(t.add(report(1, "/", "fake", 0))).toBe(false);
    expect(t.add(report(999_000, "/frame", "navigation start", 0))).toBe(false);
    expect(t.state().marks).toEqual([{ label: "navigation start", ms: 0 }]);
  });

  test("documents and labels are capped", () => {
    const t = new MarkTimeline();
    for (let i = 0; i < MarkTimeline.MAX_DOCUMENTS + 5; i++) t.add(report(1_000 + i, `/p${i}`, "navigation start", 0));
    expect(t.state().marks).toHaveLength(MarkTimeline.MAX_DOCUMENTS);
    const u = new MarkTimeline();
    for (let i = 0; i < MarkTimeline.MAX_LABELS + 5; i++) u.add(report(1, "/", `m${i}`, i));
    expect(u.state().marks).toHaveLength(MarkTimeline.MAX_LABELS);
  });

  test("ignores malformed reports", () => {
    const t = new MarkTimeline();
    for (const bad of [null, 1, "x", {}, { origin: "1", path: "/" }, { origin: Infinity, path: "/" }, { origin: 1 }]) {
      expect(t.add(bad)).toBe(false);
    }
    t.add({ origin: 1, path: "/", label: "x", ms: -5 });
    t.add({ origin: 1, path: "/", label: "y", ms: Number.NaN });
    expect(t.state().marks).toEqual([]);
  });
});

interface FakeNode {
  tag: string;
  children: FakeNode[];
  textContent: string;
  className: string;
  isConnected: boolean;
  attrs: Record<string, string>;
  append(...n: FakeNode[]): void;
  appendChild(n: FakeNode): void;
  setAttribute(k: string, v: string): void;
  attachShadow(): FakeNode;
}

function node(tag: string): FakeNode {
  const n: FakeNode = {
    tag,
    children: [],
    textContent: "",
    className: "",
    isConnected: false,
    attrs: {},
    append: (...c) => {
      n.children.push(...c);
      for (const x of c) x.isConnected = n.isConnected;
    },
    appendChild: (c) => n.append(c),
    setAttribute: (k, v) => (n.attrs[k] = v),
    attachShadow: () => node("#shadow"),
  };
  return n;
}

/** Runs the overlay script against a stub page and returns what it reported, and ways to drive it. */
function runOverlay(marks: RecordingMark[], opts: { until?: string; overlay?: boolean } = {}) {
  const present = new Set<string>();
  const frames: Array<() => void> = [];
  const reports: PageReport[] = [];
  let now = 0;
  let paintObserver: ((list: { getEntries(): Array<{ name: string; startTime: number }> }) => void) | null = null;
  const html = node("html");
  html.isConnected = true;
  const win: Record<string, unknown> = {
    [REPORT_BINDING]: (r: PageReport) => {
      reports.push(r);
      return Promise.resolve();
    },
  };
  win.top = win;
  const doc = {
    documentElement: html,
    createElement: node,
    querySelector: (sel: string) => {
      if (sel === "[[") throw new Error("bad selector");
      return present.has(sel) ? { getClientRects: () => [{}] } : null;
    },
  };
  class Observer {
    constructor(cb: typeof paintObserver) {
      paintObserver = cb;
    }
    observe() {}
  }
  const script = overlayScript({ marks, until: opts.until, overlay: opts.overlay ?? true, title: "cold load" });
  new Function("window", "document", "performance", "PerformanceObserver", "requestAnimationFrame", "location", script)(
    win,
    doc,
    { now: () => now, timeOrigin: 1_700_000_000_000 },
    Observer,
    (cb: () => void) => frames.push(cb),
    { pathname: "/" }
  );
  const recording = win.__standupRecording as { stop(): void; carry(offset: number, carried: unknown[]): void };
  return {
    reports,
    recording,
    overlayMounted: () => html.children.some((c) => c.tag === "standup-recording-overlay"),
    host: () => html.children.find((c) => c.tag === "standup-recording-overlay"),
    show: (sel: string) => present.add(sel),
    paint: (name: string, startTime: number) => paintObserver?.({ getEntries: () => [{ name, startTime }] }),
    frame: (at: number) => {
      now = at;
      frames.shift()?.();
    },
  };
}

const marksOf = (reports: PageReport[]) => reports.filter((r) => r.label).map((r) => ({ label: r.label, ms: r.ms }));

describe("pipeline-recording overlay script", () => {
  test("reports navigation start, paints and each mark on the first frame its selector renders", () => {
    const page = runOverlay([...PERSONA_MARKS], { until: "#done" });
    expect(marksOf(page.reports)).toEqual([{ label: "navigation start", ms: 0 }]);
    page.paint("first-paint", 41.6);
    page.paint("first-contentful-paint", 58.2);
    page.frame(100);
    page.show(PERSONA_MARKS[0]!.selector);
    page.frame(212.4);
    page.frame(260);
    page.show(PERSONA_MARKS[1]!.selector);
    page.show("#done");
    page.frame(388);
    expect(marksOf(page.reports)).toEqual([
      { label: "navigation start", ms: 0 },
      { label: "first paint", ms: 42 },
      { label: "first contentful paint", ms: 58 },
      { label: "composer interactive", ms: 212 },
      { label: "latest messages rendered", ms: 388 },
    ]);
    expect(page.reports.some((r) => r.until === true)).toBe(true);
    expect(page.reports.every((r) => r.origin === 1_700_000_000_000 && r.path === "/")).toBe(true);
  });

  test("the overlay is drawn only after the page's own first contentful paint", () => {
    const page = runOverlay([{ label: "x", selector: "#x" }]);
    page.frame(10);
    page.paint("first-paint", 12);
    page.frame(20);
    expect(page.overlayMounted()).toBe(false);
    page.paint("first-contentful-paint", 1544);
    page.frame(1550);
    expect(page.overlayMounted()).toBe(true);
    expect(page.host()!.attrs.style).toContain("position:fixed !important");
    expect(page.host()!.attrs.style).toContain("pointer-events:none !important");
  });

  test("a page that never paints content gets the overlay at the stop, and the overlay's paint is not reported", () => {
    const page = runOverlay([{ label: "late", selector: "#late" }]);
    page.frame(10);
    expect(page.overlayMounted()).toBe(false);
    page.frame(1500);
    page.recording.stop();
    expect(page.overlayMounted()).toBe(true);
    // The overlay is the first thing painted, after the stop: neither it nor anything later counts.
    page.paint("first-paint", 1516);
    page.paint("first-contentful-paint", 1516);
    page.show("#late");
    page.frame(1600);
    expect(marksOf(page.reports).map((m) => m.label)).toEqual(["navigation start"]);
  });

  test("a paint that happened before the stop still counts when its entry arrives after it", () => {
    const page = runOverlay([]);
    page.frame(400);
    page.recording.stop();
    page.paint("first-contentful-paint", 380);
    expect(marksOf(page.reports)).toEqual([
      { label: "navigation start", ms: 0 },
      { label: "first contentful paint", ms: 380 },
    ]);
  });

  test("--no-overlay draws nothing but still reports", () => {
    const page = runOverlay([{ label: "x", selector: "#x" }], { overlay: false });
    page.paint("first-contentful-paint", 5);
    page.show("#x");
    page.frame(10);
    page.recording.stop();
    expect(page.overlayMounted()).toBe(false);
    expect(marksOf(page.reports).map((m) => m.label)).toEqual(["navigation start", "first contentful paint", "x"]);
  });

  test("a mark is reported once, and a selector that throws never matches", () => {
    const page = runOverlay([{ label: "x", selector: "#x" }, { label: "bad", selector: "[[" }]);
    page.show("#x");
    page.frame(10);
    page.frame(20);
    expect(marksOf(page.reports).filter((m) => m.label === "x")).toEqual([{ label: "x", ms: 10 }]);
    expect(marksOf(page.reports).some((m) => m.label === "bad")).toBe(false);
  });

  test("configuration is embedded as data, so a hostile selector or label can't break out", () => {
    const evil = `"});globalThis.__pwned=1;({"`;
    const script = overlayScript({ marks: [{ label: evil, selector: `</script><script>${evil}` }], overlay: true, title: "load" });
    expect(() => new Function(script)).not.toThrow();
    const page = runOverlay([{ label: evil, selector: "#y" }]);
    page.show("#y");
    page.frame(5);
    expect(marksOf(page.reports).map((m) => m.label)).toContain(evil);
    expect((globalThis as Record<string, unknown>).__pwned).toBeUndefined();
  });
});
