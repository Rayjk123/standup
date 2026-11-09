import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { setPipelineViewer } from "../lib/pipelineUpdates";
import { PIPELINE_CATALOG } from "@standup/shared";
import type { PipelineOverride, PipelinePresetId } from "@standup/shared";
import type { Root } from "react-dom/client";
import { GlobalWindow } from "happy-dom";
import { sampleRunNoUi, sampleRunUiChange, sampleRunWontfixAccepted } from "./pipeline-fixtures";

// react-dom decides whether a DOM exists when it is first imported, so the
// window is installed before the view modules load.
const window = new GlobalWindow({ url: "http://localhost/" });
const GLOBALS = [
  "window",
  "document",
  "navigator",
  "Node",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "Element",
  "Text",
  "Event",
  "KeyboardEvent",
  "MutationObserver",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "localStorage",
] as const;
const saved = new Map<string, unknown>();

let act: (fn: () => void | Promise<void>) => Promise<void>;
let createRoot: (el: Element) => Root;
let PipelineView: typeof import("./PipelineView").PipelineView;
let PipelineSettings: typeof import("./PipelineSettings").PipelineSettings;

const realFetch = globalThis.fetch;

beforeAll(async () => {
  for (const name of GLOBALS) {
    saved.set(name, (globalThis as Record<string, unknown>)[name]);
    (globalThis as Record<string, unknown>)[name] = (window as unknown as Record<string, unknown>)[name];
  }
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  ({ act } = (await import("react")) as unknown as { act: typeof act });
  ({ createRoot } = await import("react-dom/client"));
  ({ PipelineView } = await import("./PipelineView"));
  ({ PipelineSettings } = await import("./PipelineSettings"));
  // The viewer is module state another test file's App may have set from its
  // hello-ok; these tests publish config frames as "alice", so start unset.
  (await import("../lib/pipelineUpdates")).setPipelineViewer(null);
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  for (const [name, value] of saved) (globalThis as Record<string, unknown>)[name] = value;
  await window.happyDOM.close();
});

let host: HTMLElement;
let root: Root;

afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  globalThis.fetch = realFetch;
});

async function settle() {
  for (let i = 0; i < 5; i++) await act(async () => new Promise((r) => setTimeout(r, 10)));
}

async function mount(el: ReturnType<typeof createElement>) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(() => root.render(el));
  await settle();
}

function chip(id: string): HTMLElement {
  return host.querySelector(`[data-stage="${id}"]`) as HTMLElement;
}

/** Sets a controlled input's value the way a user edit does, so React's onChange fires. */
function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = Object.getPrototypeOf(el) as object;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  setter?.call(el, value);
  el.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);
}

describe("PipelineView", () => {
  test("highlights the current stage and shows the waiting banner", async () => {
    await mount(createElement(PipelineView, { run: sampleRunUiChange }));
    expect(chip("code_review").getAttribute("data-state")).toBe("current");
    expect(chip("code_review").getAttribute("aria-current")).toBe("step");
    expect(chip("review").getAttribute("data-state")).toBe("passed");
    expect(chip("complete").getAttribute("data-state")).toBe("pending");
    expect(host.querySelector("[role=status]")?.textContent).toBe("Needs you (your input): code review stage needs an issue id from you");
    // The current stage is selected by default.
    expect(host.querySelector("[data-testid=pipeline-stage-detail]")?.textContent).toContain("Code review");
  });

  test("a waiting run with nothing to waive reads as waiting, not as needing the owner", async () => {
    // Waiting at the complete stage with no failed attempt behind it: there is
    // no waive control anywhere in the run, so nothing is the owner's to do.
    const run = {
      ...sampleRunUiChange,
      currentStage: "complete",
      status: "waiting_user" as const,
      attempts: [],
      waitingKind: "stalled" as const,
      waitingReason: "the worker stopped reporting",
    };
    await mount(createElement(PipelineView, { run }));
    const head = host.querySelector("[role=status]")?.textContent ?? "";
    expect(head).toBe("Waiting (worker stalled): the worker stopped reporting");
    expect(head).not.toContain("Needs you");
    expect(chip("complete").textContent).not.toContain("needs you");
    expect(host.textContent).not.toContain("Waive");
  });

  test("labels loop arcs with used/max", async () => {
    await mount(createElement(PipelineView, { run: sampleRunUiChange }));
    const label = (key: string) => host.querySelector(`[data-loop="${key}"] text`)?.textContent;
    expect(label("validation->coding")).toBe("1/4");
    expect(label("review->coding")).toBe("1/4");
    expect(label("deploy->coding")).toBe("0/4");
  });

  test("a skipped screenshot stage is dimmed and tagged skipped", async () => {
    await mount(createElement(PipelineView, { run: sampleRunNoUi }));
    const shot = chip("screenshot");
    expect(shot.getAttribute("data-state")).toBe("skipped");
    expect(shot.textContent).toContain("skipped");
    expect(shot.style.opacity).toBe("0.55");
    expect(host.querySelector("[role=status]")?.textContent).toContain("Complete");
    await act(() => shot.click());
    expect(host.textContent).toContain("auto-skipped: ui_changed is false");
  });

  test("a review Persona waived by accepting its wontfix findings reads as such, with its reason and the findings", async () => {
    await mount(createElement(PipelineView, { run: sampleRunWontfixAccepted }));
    expect(chip("review").getAttribute("data-state")).toBe("waived");
    expect(chip("deploy").getAttribute("data-state")).toBe("current");
    await act(() => chip("review").click());
    const detail = host.querySelector("[data-testid=pipeline-stage-detail]")!;
    const waived = detail.querySelector(`[data-attempt="${sampleRunWontfixAccepted.attempts.at(-1)!.id}"]`)!;
    const decision = waived.querySelector("[data-testid=pipeline-persona-decision]")!;
    expect(decision.getAttribute("data-kind")).toBe("accept_wontfix");
    expect(decision.textContent).toContain("Persona: accepted wontfix — Session token rotation races the refresh path: tracked in job 1a2b3c4d");
    expect(waived.querySelector("[data-testid=pipeline-wontfix-accepted]")!.textContent).toContain(
      "Session token rotation races the refresh path — correctness-reviewer"
    );
  });

  test("review attempts list findings by severity with counts", async () => {
    await mount(createElement(PipelineView, { run: sampleRunUiChange }));
    await act(() => chip("review").click());
    const detail = host.querySelector("[data-testid=pipeline-stage-detail]")!;
    const counts = [...detail.querySelectorAll("[data-testid=review-counts]")].map((c) => c.textContent);
    // Newest first: the clean round, then the round with the open High.
    expect(counts[0]).toContain("High 1");
    expect(counts[0]).not.toContain("open");
    expect(counts[1]).toContain("High 1 (1 open)");
    expect(counts[1]).toContain("Medium 1");
    expect(detail.textContent).toContain("retentionDays accepts 0, which deletes every transcript on the next sweep");
    expect(detail.textContent).toContain("security-reviewer");
  });

  test("validation shows each command's exit code", async () => {
    await mount(createElement(PipelineView, { run: sampleRunUiChange }));
    await act(() => chip("validation").click());
    const exits = [...host.querySelectorAll("[data-command-exit]")].map((r) => r.getAttribute("data-command-exit"));
    expect(exits).toContain("1");
    expect(host.textContent).toContain("bun test packages/store");
  });

  test("screenshots render inline from the collector's screenshot route", async () => {
    await mount(createElement(PipelineView, { run: sampleRunUiChange }));
    await act(() => chip("screenshot").click());
    const attempt = sampleRunUiChange.attempts.find((a) => a.stageId === "screenshot")!;
    const srcs = [...host.querySelectorAll("img")].map((i) => i.getAttribute("src"));
    expect(srcs).toEqual([
      `/api/pipeline/runs/${sampleRunUiChange.id}/screenshots/${attempt.id}/0`,
      `/api/pipeline/runs/${sampleRunUiChange.id}/screenshots/${attempt.id}/1`,
    ]);
  });

  test("deploy evidence shows account, stacks and live samples", async () => {
    await mount(createElement(PipelineView, { run: sampleRunUiChange }));
    await act(() => chip("deploy").click());
    const text = host.textContent ?? "";
    expect(text).toContain("111122223333 · us-west-2");
    expect(text).toContain("standup-dev-api");
    expect(text).toContain('PUT /api/projects/standup {"retentionDays": 30}');
    expect(text).toContain("safety_floor");
  });

  test("read-only views offer no waive control", async () => {
    await mount(createElement(PipelineView, { run: sampleRunUiChange, readOnly: true }));
    expect(host.querySelectorAll("input, textarea")).toHaveLength(0);
    expect(host.textContent).not.toContain("Waive");
  });

  test("the waive control reads as the owner's override of Persona's decision", async () => {
    await mount(createElement(PipelineView, { run: sampleRunUiChange }));
    expect(host.querySelector("[data-testid=pipeline-waive-note]")?.textContent).toBe(
      "Persona decides this gate and escalates when it needs you. You can still override it here."
    );
  });

  test("Persona's waivers are labelled by kind, with their reason", async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ kind: "close_out" }, "Persona: closed out"],
      [{ kind: "not_applicable", notApplicable: true }, "Persona: not applicable"],
      [{ kind: "waive" }, "Persona: waived"],
      [{ notApplicable: true }, "Persona: not applicable"],
      [{ landed: { via: "moot", why: "nothing changed" } }, "Persona: closed out"],
    ];
    for (const [extra, label] of cases) {
      const last = sampleRunWontfixAccepted.attempts.at(-1)!;
      const run = {
        ...sampleRunWontfixAccepted,
        attempts: [
          ...sampleRunWontfixAccepted.attempts.slice(0, -1),
          {
            ...last,
            reason: "waived by Persona",
            evidence: { waiver: { by: "persona", actor: "owner's Persona", reason: "the work landed on main already", notApplicable: false, ...extra } },
          },
        ],
      };
      await mount(createElement(PipelineView, { run }));
      await act(() => chip("review").click());
      const decision = host.querySelector(`[data-attempt="${last.id}"] [data-testid=pipeline-persona-decision]`);
      expect(decision?.textContent).toBe(`${label} — the work landed on main already`);
      // The attempt's own reason adds something here, so it still shows.
      expect(host.querySelector(`[data-attempt="${last.id}"]`)?.textContent).toContain("waived by Persona");
      await act(() => root.unmount());
      host.remove();
    }
    await mount(createElement(PipelineView, { run: sampleRunNoUi }));
  });

  test("an owner's waiver carries no Persona label", async () => {
    const last = sampleRunWontfixAccepted.attempts.at(-1)!;
    const run = {
      ...sampleRunWontfixAccepted,
      attempts: [
        ...sampleRunWontfixAccepted.attempts.slice(0, -1),
        { ...last, reason: "waived by sam: tracked elsewhere", evidence: { waiver: { by: "owner", actor: "sam", reason: "tracked elsewhere", notApplicable: false } } },
      ],
    };
    await mount(createElement(PipelineView, { run }));
    await act(() => chip("review").click());
    expect(host.querySelector("[data-testid=pipeline-persona-decision]")).toBeNull();
    expect(host.querySelector(`[data-attempt="${last.id}"]`)?.textContent).toContain("waived by sam: tracked elsewhere");
  });

  test("a stage Persona skipped reads Persona: skipped with its reason, not raw evidence", async () => {
    const run = {
      ...sampleRunNoUi,
      attempts: sampleRunNoUi.attempts.map((a) =>
        a.stageId === "screenshot"
          ? {
              ...a,
              reason: "skipped by Persona",
              evidence: { decision: { by: "persona", actor: "owner's Persona", kind: "skip", reason: "API-only change, no UI to capture" } },
            }
          : a
      ),
    };
    await mount(createElement(PipelineView, { run }));
    await act(() => chip("screenshot").click());
    const decision = host.querySelector("[data-testid=pipeline-persona-decision]");
    expect(decision?.getAttribute("data-kind")).toBe("skip");
    expect(decision?.textContent).toBe("Persona: skipped — API-only change, no UI to capture");
    expect(host.querySelector("[data-testid=pipeline-raw-evidence]")).toBeNull();
  });

  test("live check evidence shows the environment, its isolation and each sample", async () => {
    const run = {
      ...sampleRunNoUi,
      definition: PIPELINE_CATALOG,
      attempts: [
        ...sampleRunNoUi.attempts,
        {
          id: "att-live",
          runId: sampleRunNoUi.id,
          stageId: "live_check",
          attempt: 1,
          status: "failed" as const,
          evidence: {
            environment: "isolated collector on :17801",
            isolation: { ports: [17801, 17802], tmuxSocket: "/tmp/standup-live-check.sock" },
            liveSamples: [
              { request: "GET /api/pipeline-config?project=standup", response: '200 {"preset":{"auto":"light"}}', ok: true },
              { request: "PUT /api/pipeline-config {spec: \"frobnicate\"}", response: "500 internal error", ok: false },
            ],
          },
          createdAt: "2026-10-08T12:40:00.000Z",
        },
      ],
    };
    await mount(createElement(PipelineView, { run }));
    await act(() => chip("live_check").click());
    const detail = host.querySelector("[data-testid=pipeline-stage-detail]")!;
    expect(detail.textContent).toContain("isolated collector on :17801");
    expect(detail.querySelector("[data-testid=live-check-isolation]")?.textContent).toContain("ports :17801, :17802");
    expect(detail.querySelector("[data-testid=live-check-isolation]")?.textContent).toContain("tmux -S /tmp/standup-live-check.sock");
    const samples = [...detail.querySelectorAll("[data-live-sample]")].map((s) => s.getAttribute("data-live-sample"));
    expect(samples).toEqual(["ok", "fail"]);
    expect(detail.textContent).toContain("500 internal error");
    expect(detail.querySelector("[data-testid=pipeline-raw-evidence]")).toBeNull();
  });

  test("loop arcs sit at distinct depths with a label at each apex", async () => {
    await mount(createElement(PipelineView, { run: sampleRunUiChange }));
    const groups = [...host.querySelectorAll("[data-loop]")];
    const depths = groups.map((g) => Number(g.getAttribute("data-depth")));
    expect(new Set(depths).size).toBe(groups.length);
    for (const g of groups) expect(g.querySelector("text")?.getAttribute("y")).toBe(g.getAttribute("data-depth"));
  });

  test("chip titles wrap to two lines instead of truncating", async () => {
    await mount(createElement(PipelineView, { run: sampleRunUiChange }));
    const title = chip("deploy").querySelector("[data-chip-title]") as HTMLElement;
    expect(title.textContent).toBe("Deploy and live-validate");
    expect(title.style.textOverflow).toBe("");
    expect(title.style.whiteSpace).toBe("");
  });

  test("a complete run selects its last attempted stage and its complete stage reads Run complete", async () => {
    await mount(createElement(PipelineView, { run: sampleRunNoUi }));
    const detail = () => host.querySelector("[data-testid=pipeline-stage-detail]")!.textContent ?? "";
    expect(detail()).toContain("Code review");
    expect(detail()).toContain("3610");
    await act(() => chip("complete").click());
    expect(detail()).toContain("Run complete.");
    expect(detail()).not.toContain("Not attempted yet");
  });

  test("the owner can waive the current stage even when it is the optional start stage", async () => {
    const run = { ...sampleRunUiChange, currentStage: "start", status: "active" as const, attempts: [] };
    await mount(createElement(PipelineView, { run }));
    expect(host.textContent).toContain("Waive this stage");
  });

  test("a code review url that isn't http(s) renders as text, not a link", async () => {
    const run = {
      ...sampleRunNoUi,
      attempts: sampleRunNoUi.attempts.map((a) =>
        a.stageId === "code_review" ? { ...a, evidence: { reviewId: "R-1", url: "javascript:alert(1)", issueId: "X-1" } } : a
      ),
    };
    await mount(createElement(PipelineView, { run }));
    await act(() => chip("code_review").click());
    expect(host.querySelectorAll("a")).toHaveLength(0);
    expect(host.textContent).toContain("R-1");
  });

  test("screenshots are height-capped and open full size in a new tab", async () => {
    await mount(createElement(PipelineView, { run: sampleRunUiChange }));
    await act(() => chip("screenshot").click());
    const img = host.querySelector("img") as HTMLImageElement;
    expect(img.style.maxHeight).toBe("320px");
    const link = img.closest("a")!;
    expect(link.getAttribute("href")).toBe(img.getAttribute("src"));
    expect(link.getAttribute("target")).toBe("_blank");
  });
});

describe("stage evidence renderers", () => {
  const custom = {
    ...sampleRunNoUi,
    definition: {
      ...sampleRunNoUi.definition,
      stages: [
        ...sampleRunNoUi.definition.stages,
        { id: "human-review", kind: "human_review", title: "Human review", required: true, edges: [] },
      ],
    },
    attempts: [
      ...sampleRunNoUi.attempts,
      {
        id: "att-hr",
        runId: sampleRunNoUi.id,
        stageId: "human-review",
        attempt: 1,
        status: "passed" as const,
        evidence: { reviewer: "alice", verdict: "ship it" },
        createdAt: "2026-10-08T12:29:00.000Z",
      },
    ],
  };

  test("a kind with no renderer shows its evidence as JSON", async () => {
    await mount(createElement(PipelineView, { run: custom }));
    await act(() => chip("human-review").click());
    expect(host.querySelector("[data-testid=pipeline-raw-evidence]")?.textContent).toContain('"verdict": "ship it"');
  });

  test("a registered renderer draws its kind's evidence", async () => {
    const { registerStageEvidenceRenderer } = await import("./pipelineRenderers");
    registerStageEvidenceRenderer("human_review", ({ evidence }) =>
      createElement("div", { "data-testid": "hr" }, `${String(evidence.reviewer)}: ${String(evidence.verdict)}`)
    );
    await mount(createElement(PipelineView, { run: custom }));
    await act(() => chip("human-review").click());
    expect(host.querySelector("[data-testid=hr]")?.textContent).toBe("alice: ship it");
    expect(host.querySelector("[data-testid=pipeline-raw-evidence]")).toBeNull();
  });
});

describe("PipelineStrip", () => {
  test("shows the banner and the stage row without stage detail", async () => {
    const { PipelineStrip } = await import("./PipelineView");
    await mount(createElement(PipelineStrip, { run: sampleRunUiChange }));
    expect(host.querySelector("[role=status]")?.textContent).toContain("code review stage needs an issue id");
    expect(chip("code_review").getAttribute("aria-current")).toBe("step");
    expect(host.querySelector("[data-testid=pipeline-stage-detail]")).toBeNull();
    expect(host.querySelectorAll("button")).toHaveLength(0);
  });

  test("a parked run shows what its worker waits for under the banner", async () => {
    const { PipelineStrip } = await import("./PipelineView");
    const parked = { reason: "waiting for the schema job to land", by: "worker" as const, actor: "sess-1", at: "2026-10-07T10:30:00.000Z" };
    await mount(createElement(PipelineStrip, { run: { ...sampleRunUiChange, parked } }));
    expect(host.querySelector("[data-testid=pipeline-parked]")?.textContent).toBe("Parked: waiting for the schema job to land");
    await act(() => root.unmount());
    host.remove();
    await mount(createElement(PipelineView, { run: { ...sampleRunUiChange, parked: { ...parked, waitingOnJobId: "job-9" } } }));
    expect(host.querySelector("[data-testid=pipeline-parked]")?.textContent).toBe("Parked — waiting on job job-9: waiting for the schema job to land");
  });
});

interface Call {
  method: string;
  url: string;
  body?: unknown;
}

function stubConfig(
  opts: { global?: PipelineOverride | null; auto?: PipelinePresetId; putStatus?: number; putBody?: unknown } = {}
): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (method === "PUT" && opts.putStatus && opts.putStatus !== 200) return json(opts.putBody ?? {}, opts.putStatus);
    if (method === "PUT" || method === "DELETE") return json({ ok: true });
    return json({
      global: opts.global ?? null,
      project: null,
      resolved: { enabled: true, definition: null },
      defaults: null,
      ...(opts.auto ? { preset: { auto: opts.auto, effective: opts.auto } } : {}),
    });
  }) as typeof fetch;
  return calls;
}

describe("PipelineSettings", () => {
  // The viewer alias is module state; another test file's console may have
  // left it set to someone else, whose filter would drop these frames.
  beforeEach(() => setPipelineViewer(null));

  test("loads the global layer and previews the default pipeline", async () => {
    const calls = stubConfig();
    await mount(createElement(PipelineSettings, {}));
    expect(calls[0]).toEqual({ method: "GET", url: "/api/pipeline-config", body: undefined });
    expect(host.textContent).toContain("My default for every project");
    const preview = host.querySelector("[data-testid=pipeline-preview]")!;
    expect(preview.querySelector('[data-stage="review"]')).not.toBeNull();
    expect(host.querySelector('[data-stage-row="screenshot"]')).not.toBeNull();
  });

  test("a project layer is labelled as the override for that project", async () => {
    const calls = stubConfig({ global: { stages: { deploy: { skip: true } } } });
    await mount(createElement(PipelineSettings, { projectId: "standup" }));
    expect(calls[0]!.url).toBe("/api/pipeline-config?project=standup");
    expect(host.textContent).toContain("My override for standup");
    // The global layer's skip shows through in the preview.
    expect(host.querySelector('[data-testid=pipeline-preview] [data-stage="deploy"]')).toBeNull();
  });

  test("toggling skip updates the preview, and Save PUTs the override", async () => {
    const calls = stubConfig();
    await mount(createElement(PipelineSettings, {}));
    const skip = host.querySelector('input[aria-label="Skip review"]') as HTMLInputElement;
    await act(() => skip.click());
    expect(host.querySelector('[data-testid=pipeline-preview] [data-stage="review"]')).toBeNull();
    expect(host.querySelector('[data-testid=pipeline-preview] [data-stage="deploy"]')).not.toBeNull();
    const save = [...host.querySelectorAll("button")].find((b) => b.textContent === "Save pipeline")!;
    await act(() => save.click());
    await settle();
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.url).toBe("/api/pipeline-config");
    expect(put.body).toEqual({ override: { stages: { review: { skip: true } } }, ifVersion: null });
  });

  test("an invalid raw override shows the validation errors inline", async () => {
    stubConfig();
    await mount(createElement(PipelineSettings, {}));
    const box = host.querySelector('textarea[aria-label="Raw pipeline override"]') as HTMLTextAreaElement;
    await act(() => setNativeValue(box, JSON.stringify({ stages: { nope: { skip: true } } })));
    expect(host.querySelector("[data-testid=pipeline-preview-errors]")?.textContent).toContain('unknown stage "nope"');
  });

  test("a 400 from Save is shown", async () => {
    stubConfig({
      putStatus: 400,
      putBody: { error: "invalid pipeline configuration", errors: ["stages.code_review.skip: not allowed by policy"] },
    });
    await mount(createElement(PipelineSettings, {}));
    const save = [...host.querySelectorAll("button")].find((b) => b.textContent === "Save pipeline")!;
    await act(() => save.click());
    await settle();
    const err = host.querySelector("[data-testid=pipeline-settings-error]")?.textContent ?? "";
    expect(err).toContain("invalid pipeline configuration");
    expect(err).toContain("stages.code_review.skip: not allowed by policy");
  });

  function previewStage(id: string): Element | null {
    return host.querySelector(`[data-testid=pipeline-preview] [data-stage="${id}"]`);
  }

  function summaryIds(): string[] {
    return [...host.querySelectorAll("[data-summary-stage]")].map((li) => li.getAttribute("data-summary-stage")!);
  }

  test("the stage table lists the live check from the catalog, off under the full preset", async () => {
    stubConfig();
    await mount(createElement(PipelineSettings, {}));
    expect(host.querySelector('[data-stage-row="live_check"]')).not.toBeNull();
    expect((host.querySelector('input[aria-label="Skip live_check"]') as HTMLInputElement).checked).toBe(true);
    expect(previewStage("live_check")).toBeNull();
    expect(previewStage("deploy")).not.toBeNull();
    expect(host.querySelector("[data-testid=pipeline-effective-preset]")?.textContent).toContain("Full");
  });

  test("the preview starts from the project's auto preset, and the preset selector overrides it", async () => {
    const calls = stubConfig({ auto: "light" });
    await mount(createElement(PipelineSettings, { projectId: "standup" }));
    const select = host.querySelector('select[aria-label="Pipeline preset"]') as HTMLSelectElement;
    expect(select.options[0]!.textContent).toBe("Project default (auto: light)");
    expect(previewStage("live_check")).not.toBeNull();
    expect(previewStage("deploy")).toBeNull();
    expect(previewStage("code_review")).toBeNull();
    await act(() => {
      select.value = "full";
      select.dispatchEvent(new window.Event("change", { bubbles: true }) as unknown as Event);
    });
    expect(previewStage("deploy")).not.toBeNull();
    expect(previewStage("code_review")).not.toBeNull();
    const save = [...host.querySelectorAll("button")].find((b) => b.textContent === "Save pipeline")!;
    await act(() => save.click());
    await settle();
    expect(calls.find((c) => c.method === "PUT")!.body).toEqual({ override: { preset: "full" }, ifVersion: null });
  });

  test("Describe it compiles clause by clause, flags clauses it can't map, and Save PUTs the spec", async () => {
    const calls = stubConfig({ auto: "full" });
    await mount(createElement(PipelineSettings, {}));
    const box = host.querySelector('textarea[aria-label="Pipeline spec"]') as HTMLTextAreaElement;
    expect(box.getAttribute("placeholder")).toBe("no code review, isolated live check, review packet");
    await act(() => setNativeValue(box, "no code review, isolated live check, review packet, frobnicate the widget"));
    const known = [...host.querySelectorAll('[data-clause="known"]')].map((li) => li.textContent);
    expect(known).toContain("no code review → code_review: off");
    expect(known).toContain("isolated live check → live_check: on");
    expect(known).toContain("review packet → human_review: on");
    expect(known.some((k) => k?.includes("deploy: off"))).toBe(true);
    const unknown = [...host.querySelectorAll('[data-clause="unknown"]')];
    expect(unknown).toHaveLength(1);
    expect(unknown[0]!.textContent).toContain("frobnicate the widget");
    // The resulting stages: the live check in, the code review and the deploy out.
    expect(summaryIds()).toContain("live_check");
    expect(summaryIds()).not.toContain("code_review");
    expect(summaryIds()).not.toContain("deploy");

    await act(() => setNativeValue(box, "no code review, isolated live check, review packet"));
    expect(host.querySelectorAll('[data-clause="unknown"]')).toHaveLength(0);
    const save = [...host.querySelectorAll("button")].find((b) => b.textContent === "Save pipeline")!;
    await act(() => save.click());
    await settle();
    expect(calls.find((c) => c.method === "PUT")!.body).toEqual({ spec: "no code review, isolated live check, review packet", ifVersion: null });
  });

  test("a spec saved with structured fields sends both", async () => {
    const calls = stubConfig();
    await mount(createElement(PipelineSettings, {}));
    await act(() => setNativeValue(host.querySelector('textarea[aria-label="Pipeline spec"]') as HTMLTextAreaElement, "no code review"));
    await act(() => (host.querySelector('input[aria-label="Skip screenshot"]') as HTMLInputElement).click());
    const save = [...host.querySelectorAll("button")].find((b) => b.textContent === "Save pipeline")!;
    await act(() => save.click());
    await settle();
    expect(calls.find((c) => c.method === "PUT")!.body).toEqual({
      spec: "no code review",
      override: { stages: { screenshot: { skip: true } } },
      ifVersion: null,
    });
  });

  test("a 400 naming unmapped clauses lists them", async () => {
    stubConfig({ putStatus: 400, putBody: { error: "couldn't map 1 clause(s) of the spec to a stage", unknown: ["frobnicate"] } });
    await mount(createElement(PipelineSettings, {}));
    await act(() => setNativeValue(host.querySelector('textarea[aria-label="Pipeline spec"]') as HTMLTextAreaElement, "frobnicate"));
    const save = [...host.querySelectorAll("button")].find((b) => b.textContent === "Save pipeline")!;
    await act(() => save.click());
    await settle();
    expect(host.querySelector("[data-testid=pipeline-settings-error]")?.textContent).toContain("couldn't map 1 clause(s)");
    expect(host.querySelector("[data-testid=pipeline-settings-unknown]")?.textContent).toContain("frobnicate");
  });

  test("a stored spec seeds the box, and its compiled stages stay out of the structured override", async () => {
    stubConfig({ global: { spec: "no code review", stages: { code_review: { skip: true }, screenshot: { skip: true } } } });
    await mount(createElement(PipelineSettings, {}));
    expect(host.querySelector("[data-testid=pipeline-stored-spec]")?.textContent).toBe("Saved spec: no code review");
    expect((host.querySelector('textarea[aria-label="Pipeline spec"]') as HTMLTextAreaElement).value).toBe("no code review");
    expect(JSON.parse((host.querySelector('textarea[aria-label="Raw pipeline override"]') as HTMLTextAreaElement).value)).toEqual({
      stages: { screenshot: { skip: true } },
    });
    expect(previewStage("code_review")).toBeNull();
    // Unticking a stage the spec skips turns it back on over the spec.
    const skipReview = host.querySelector('input[aria-label="Skip code_review"]') as HTMLInputElement;
    expect(skipReview.checked).toBe(true);
    await act(() => skipReview.click());
    expect(previewStage("code_review")).not.toBeNull();
  });

  test("a stored max-rounds spec seeds without leaving maxRounds in the structured override", async () => {
    stubConfig({ global: { spec: "max 2 rounds", maxRounds: 2 } });
    await mount(createElement(PipelineSettings, {}));
    expect(JSON.parse((host.querySelector('textarea[aria-label="Raw pipeline override"]') as HTMLTextAreaElement).value)).toEqual({});
    expect(host.querySelector('[data-testid=pipeline-preview] [data-loop="review->coding"] text')?.textContent).toBe("≤2");
  });

  /** A collector whose global layer is `state` — changed by the test, as Persona or another tab would. */
  function stubLiveConfig(state: { global: PipelineOverride | null; version: string | null }, putStatus = 200): Call[] {
    const calls: Call[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ method, url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
      if (method === "PUT" && putStatus !== 200) return json({ error: "This pipeline changed since you loaded it" }, putStatus);
      return json({ global: state.global, project: null, version: state.version, resolved: { enabled: true, definition: null } });
    }) as typeof fetch;
    return calls;
  }

  test("a pipeline_config:updated frame re-reads the layer; with unsaved edits it shows a notice instead", async () => {
    const { publishPipelineConfigUpdate } = await import("../lib/pipelineUpdates");
    const state: { global: PipelineOverride | null; version: string | null } = { global: null, version: "v1" };
    const calls = stubLiveConfig(state);
    await mount(createElement(PipelineSettings, {}));
    expect(previewStage("screenshot")).not.toBeNull();

    // Persona drops screenshots; the open view follows.
    state.global = { stages: { screenshot: { skip: true } } };
    state.version = "v2";
    const configReads = () => calls.filter((c) => c.method === "GET" && c.url.startsWith("/api/pipeline-config"));
    await act(() => publishPipelineConfigUpdate({ owner: "alice", projectId: null, scope: "user" }));
    await settle();
    expect(previewStage("screenshot")).toBeNull();
    expect(configReads()).toHaveLength(2);

    // A job's layer isn't this view's.
    await act(() => publishPipelineConfigUpdate({ owner: "alice", projectId: null, scope: "job", jobId: "j" }));
    await settle();
    expect(configReads()).toHaveLength(2);

    // With an unsaved edit, a change elsewhere doesn't clobber it.
    await act(() => (host.querySelector('input[aria-label="Skip review"]') as HTMLInputElement).click());
    state.global = {};
    state.version = "v3";
    await act(() => publishPipelineConfigUpdate({ owner: "alice", projectId: null, scope: "user" }));
    await settle();
    expect(previewStage("review")).toBeNull();
    expect(host.querySelector("[data-testid=pipeline-settings-stale]")?.textContent).toContain(
      "Persona (or another tab) changed this pipeline — reload to see it"
    );
    // The save it would make carries the version it was read at.
    const save = [...host.querySelectorAll("button")].find((b) => b.textContent === "Save pipeline")!;
    await act(() => save.click());
    await settle();
    expect(calls.find((c) => c.method === "PUT")!.body).toMatchObject({ ifVersion: "v2" });
  });

  test("Reset is conditional on the version it read", async () => {
    const calls = stubLiveConfig({ global: { stages: { review: { minReviewers: 3 } } }, version: "v7" });
    await mount(createElement(PipelineSettings, { projectId: "standup" }));
    const reset = [...host.querySelectorAll("button")].find((b) => b.textContent === "Reset")!;
    await act(() => reset.click());
    await settle();
    expect(calls.find((c) => c.method === "DELETE")).toEqual({ method: "DELETE", url: "/api/pipeline-config?project=standup", body: { ifVersion: "v7" } });
  });

  test("lists Persona's changes to this layer newest first, and re-reads them when the layer changes", async () => {
    const { publishPipelineConfigUpdate } = await import("../lib/pipelineUpdates");
    const decision = (id: string, reason: string, createdAt: string) => ({
      id,
      owner: "alice",
      projectId: "standup",
      kind: "config",
      reason,
      actor: "alice's Persona",
      detail: { scope: "project" },
      createdAt,
    });
    let decisions = [decision("d1", "three reviewers for the parser work", "2026-10-01T10:00:00.000Z")];
    const reads: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      if (url.startsWith("/api/pipeline/decisions")) {
        reads.push(url);
        return json({ decisions });
      }
      return json({ global: null, project: null, version: null, resolved: { enabled: true, definition: null } });
    }) as typeof fetch;
    await mount(createElement(PipelineSettings, { projectId: "standup" }));
    expect(reads).toEqual(["/api/pipeline/decisions?projectId=standup"]);
    const listed = () => [...host.querySelectorAll("[data-testid=pipeline-layer-decisions] [data-decision]")].map((li) => li.textContent ?? "");
    expect(listed()).toHaveLength(1);
    expect(listed()[0]).toContain("Changed the pipeline — three reviewers for the parser work");
    expect(listed()[0]).toContain("alice's Persona");

    decisions = [...decisions, decision("d2", "no screenshots: the project has no UI", "2026-10-02T10:00:00.000Z")];
    // Another project's change isn't this view's.
    await act(() => publishPipelineConfigUpdate({ owner: "alice", projectId: "other", scope: "project" }));
    await settle();
    expect(reads).toHaveLength(1);
    await act(() => publishPipelineConfigUpdate({ owner: "alice", projectId: "standup", scope: "project" }));
    await settle();
    expect(reads).toHaveLength(2);
    expect(listed().map((t) => t.includes("no screenshots"))).toEqual([true, false]);
  });

  test("the default for every project lists the changes to the owner's own layer", async () => {
    const reads: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/pipeline/decisions")) reads.push(url);
      return new Response(JSON.stringify({ global: null, project: null, resolved: { enabled: true, definition: null }, decisions: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    await mount(createElement(PipelineSettings, {}));
    expect(reads).toEqual(["/api/pipeline/decisions?scope=user"]);
    expect(host.querySelector("[data-testid=pipeline-layer-decisions]")).toBeNull();
  });

  test("a 409 from Save shows the conflict and the changed-elsewhere notice", async () => {
    stubLiveConfig({ global: null, version: "v1" }, 409);
    await mount(createElement(PipelineSettings, {}));
    await act(() => (host.querySelector('input[aria-label="Skip review"]') as HTMLInputElement).click());
    const save = [...host.querySelectorAll("button")].find((b) => b.textContent === "Save pipeline")!;
    await act(() => save.click());
    await settle();
    expect(host.querySelector("[data-testid=pipeline-settings-error]")?.textContent).toContain("changed since you loaded it");
    expect(host.querySelector("[data-testid=pipeline-settings-stale]")).not.toBeNull();
    // The unsaved edit is still there.
    expect(previewStage("review")).toBeNull();
  });
});
