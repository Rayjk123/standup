import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { LuCheck } from "react-icons/lu";
import {
  DEFAULT_BLOCK_ON,
  DEFAULT_MIN_REVIEWERS,
  DEFAULT_STAGE_MAX_ATTEMPTS,
  PIPELINE_CATALOG,
  PIPELINE_PRESETS,
  PIPELINE_PRESET_IDS,
  PipelineConfigError,
  compilePipelineSpec,
  isPipelinePresetId,
  loopBudget,
  mergeReviewTunnelConfig,
  pipelinePresetOf,
  pipelineStageSummary,
  resolvePipelineLayers,
} from "@standup/shared";
import type {
  CompiledPipelineSpec,
  PipelineDefinition,
  PipelineOverride,
  PipelinePresetId,
  PipelineStageDef,
  PipelineStagePatch,
} from "@standup/shared";
import { decisionLabel, newestFirst, type PipelineDecisionRecord } from "../lib/pipelineDecisions";
import { pipelineViewer, subscribePipelineConfigUpdates, subscribePipelineResync } from "../lib/pipelineUpdates";
import { theme } from "./theme";
import { ReviewTunnelSettings } from "./ReviewTunnelSettings";
import { PipelineGraph } from "./PipelineView";
import type { LoopArc } from "./PipelineView";

interface PipelineConfigResponse {
  global: PipelineOverride | null;
  project: PipelineOverride | null;
  /** The project's built-in layer beneath your project layer (its review-tunnel seed), when it has one. */
  seed?: PipelineOverride | null;
  resolved: { enabled: boolean; definition: PipelineDefinition };
  defaults?: unknown;
  /** The preset the project gets when no layer names one, and the one its layers resolve to. */
  preset?: { auto?: PipelinePresetId; effective?: PipelinePresetId };
  stages?: Array<{ id: string; title: string; required: boolean }>;
  /** The edited layer's version (when it was last written; null when unset), sent back as `ifVersion` on save. */
  version?: string | null;
}

/** Shown when the layer changed elsewhere while this view holds unsaved edits. */
export const PIPELINE_CHANGED_ELSEWHERE = "Persona (or another tab) changed this pipeline — reload to see it";

/** Removes empty stage patches and an empty `stages`/`add`, so a saved override carries only real changes. */
function compact(o: PipelineOverride): PipelineOverride {
  const out: PipelineOverride = {};
  if (o.preset !== undefined) out.preset = o.preset;
  if (o.enabled !== undefined) out.enabled = o.enabled;
  if (o.maxRounds !== undefined) out.maxRounds = o.maxRounds;
  if (o.stages) {
    const stages: Record<string, PipelineStagePatch> = {};
    for (const [id, patch] of Object.entries(o.stages)) {
      const kept = Object.fromEntries(Object.entries(patch ?? {}).filter(([, v]) => v !== undefined));
      if (Object.keys(kept).length > 0) stages[id] = kept as PipelineStagePatch;
    }
    if (Object.keys(stages).length > 0) out.stages = stages;
  }
  if (o.add && o.add.length > 0) out.add = o.add;
  if (o.reviewTunnel) {
    const kept = Object.fromEntries(Object.entries(o.reviewTunnel).filter(([, v]) => v !== undefined));
    if (Object.keys(kept).length > 0) out.reviewTunnel = kept;
  }
  return out;
}

function stringify(o: PipelineOverride): string {
  return JSON.stringify(o, null, 2);
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The structured part of a stored layer that its spec doesn't account for:
 * the layer without its `spec`, and without each preset or stage field the
 * spec compiles to the same value. Compiling the spec and merging this back
 * (see withSpec) gives the stored layer again.
 */
function withoutSpec(layer: PipelineOverride, compiled: PipelineOverride): PipelineOverride {
  const out: PipelineOverride = { ...layer };
  delete out.spec;
  if (out.preset !== undefined && out.preset === compiled.preset) delete out.preset;
  if (out.maxRounds !== undefined && out.maxRounds === compiled.maxRounds) delete out.maxRounds;
  if (out.stages) {
    const stages: Record<string, PipelineStagePatch> = {};
    for (const [id, patch] of Object.entries(out.stages)) {
      const fromSpec = (compiled.stages?.[id] ?? {}) as Record<string, unknown>;
      stages[id] = Object.fromEntries(
        Object.entries(patch ?? {}).filter(([key, value]) => !same(value, fromSpec[key]))
      ) as PipelineStagePatch;
    }
    out.stages = stages;
  }
  return compact(out);
}

/**
 * The layer the collector stores for a spec and a structured override, as
 * pipelineLayerFromInput merges them: the spec's layer, with the override's
 * fields winning stage by stage.
 */
function withSpec(compiled: PipelineOverride, extra: PipelineOverride): PipelineOverride {
  const stages: Record<string, PipelineStagePatch> = { ...compiled.stages };
  for (const [id, p] of Object.entries(extra.stages ?? {})) stages[id] = { ...stages[id], ...p };
  const out: PipelineOverride = { ...compiled, ...extra, spec: compiled.spec };
  if (Object.keys(stages).length > 0) out.stages = stages;
  return out;
}

/**
 * Every stage a layer can patch, in pipeline order: the base stages plus any
 * stage a layer adds (placed after its anchor). Unlike the resolved
 * definition this keeps skipped stages, so they can be restored.
 */
function editableStages(base: PipelineDefinition, layers: Array<PipelineOverride | null | undefined>): PipelineStageDef[] {
  const rows = base.stages.slice();
  for (const layer of layers) {
    for (const entry of Array.isArray(layer?.add) ? layer!.add : []) {
      if (!entry?.stage?.id || rows.some((s) => s.id === entry.stage.id)) continue;
      const at = rows.findIndex((s) => s.id === entry.after);
      rows.splice(at === -1 ? rows.length - 1 : at + 1, 0, entry.stage);
    }
  }
  return rows;
}

function writeHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  try {
    const tok = localStorage.getItem("standup.writeToken")?.trim();
    if (tok) headers["x-standup-write-token"] = tok;
  } catch {
    // No storage (private mode) — a loopback collector needs no token.
  }
  return headers;
}

/**
 * Your delivery-pipeline configuration for one layer: the default for every
 * project (no `projectId`) or your override for one project, applied over
 * the global layer, over the preset the layers name (else the project's
 * auto preset), over the stage catalog. Edits stay local until Save (PUT) and
 * preview live as the resolved pipeline; Reset (DELETE) drops the layer. The
 * layer is a plain-words spec ("Describe it", compiled live clause by clause)
 * plus a structured override on top of it: the preset selector and the
 * stage-level fields edit the override's `preset` and `stages` patches; the
 * JSON box edits the whole override, including `add` and `edges`.
 */
export function PipelineSettings({ projectId }: { projectId?: string }) {
  const query = projectId ? `?project=${encodeURIComponent(projectId)}` : "";
  const [data, setData] = useState<PipelineConfigResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<PipelineOverride>({});
  const [specText, setSpecText] = useState("");
  const [storedSpec, setStoredSpec] = useState<string | undefined>(undefined);
  const [jsonText, setJsonText] = useState("{}");
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; errors: string[]; unknown: string[] } | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  /** The layer changed elsewhere while this view held unsaved edits, which a reload would discard. */
  const [changedElsewhere, setChangedElsewhere] = useState(false);
  /** Whether the draft holds edits not yet saved; a ref, so a socket frame reads it as it is now. */
  const dirty = useRef(false);
  /** The version of the layer as last read; a save carries it as `ifVersion`. */
  const version = useRef<string | null>(null);

  const seed = useCallback(
    (next: PipelineConfigResponse) => {
      setData(next);
      const stored = (projectId ? next.project : next.global) ?? {};
      const spec = typeof stored.spec === "string" && stored.spec.trim() ? stored.spec : undefined;
      const layer = spec ? withoutSpec(stored, compilePipelineSpec(spec).override) : compact(stored);
      setStoredSpec(spec);
      setSpecText(spec ?? "");
      setDraft(layer);
      setJsonText(stringify(layer));
      setJsonError(null);
      setChangedElsewhere(false);
      dirty.current = false;
      version.current = next.version ?? null;
    },
    [projectId]
  );

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/pipeline-config${query}`);
      if (!res.ok) throw new Error(String(res.status));
      seed((await res.json()) as PipelineConfigResponse);
      setLoadError(null);
    } catch {
      setLoadError("Couldn't load your pipeline settings — reload to try again.");
    }
  }, [query, seed]);

  useEffect(() => {
    setData(null);
    setError(null);
    setSaved(null);
    void load();
  }, [load]);

  // The layer changed elsewhere (Persona, another tab), or frames may have been
  // missed: re-read it — unless that would discard unsaved edits, which get a
  // notice instead.
  useEffect(() => {
    // A frame says the layers changed; a resync only that frames may have been
    // missed, so with unsaved edits it compares the edited layer's version first.
    const refresh = async (changed: boolean) => {
      if (!dirty.current) return load();
      if (changed) {
        setChangedElsewhere(true);
        return;
      }
      try {
        const res = await fetch(`/api/pipeline-config${query}`);
        if (!res.ok) return;
        const next = (await res.json()) as PipelineConfigResponse;
        if ((next.version ?? null) !== version.current) setChangedElsewhere(true);
      } catch {
        // Unreachable for now; the next frame or resync reads it again.
      }
    };
    const unsubscribe = subscribePipelineConfigUpdates((change) => {
      const viewer = pipelineViewer();
      if (viewer && change.owner !== viewer) return;
      // A job's or a launch's layer isn't shown here; the owner's own layer shows on every page.
      if (change.scope !== "user" && change.scope !== "project") return;
      if (change.projectId !== null && change.projectId !== (projectId ?? null)) return;
      void refresh(true);
    });
    const unsubscribeResync = subscribePipelineResync(() => void refresh(false));
    return () => {
      unsubscribe();
      unsubscribeResync();
    };
  }, [load, projectId, query]);

  const lower = projectId ? data?.global ?? null : null;
  const seedLayer = projectId ? data?.seed ?? null : null;
  const serverAuto = data?.preset?.auto;
  const auto: PipelinePresetId = isPipelinePresetId(serverAuto) ? serverAuto : "full";
  const compiled = useMemo((): CompiledPipelineSpec | null => (specText.trim() ? compilePipelineSpec(specText) : null), [specText]);
  const effective = useMemo(() => (compiled ? withSpec(compiled.override, draft) : draft), [compiled, draft]);
  const layers = useMemo(
    () => (projectId ? [lower, seedLayer, effective] : [effective]),
    [projectId, lower, seedLayer, effective]
  );
  const preset = pipelinePresetOf(layers, auto);

  const preview = useMemo((): { enabled: boolean; definition: PipelineDefinition } | { errors: string[] } => {
    try {
      return resolvePipelineLayers(layers, auto);
    } catch (e) {
      return { errors: e instanceof PipelineConfigError ? e.errors : [String(e)] };
    }
  }, [layers, auto]);

  function update(next: PipelineOverride) {
    const clean = compact(next);
    dirty.current = true;
    setDraft(clean);
    setJsonText(stringify(clean));
    setJsonError(null);
    setSaved(null);
  }

  function setPatch<K extends keyof PipelineStagePatch>(id: string, key: K, value: PipelineStagePatch[K] | undefined) {
    const stages = { ...(draft.stages ?? {}) };
    stages[id] = { ...(stages[id] ?? {}), [key]: value };
    update({ ...draft, stages });
  }

  function onJson(text: string) {
    dirty.current = true;
    setJsonText(text);
    setSaved(null);
    try {
      const parsed = JSON.parse(text) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        setJsonError("The override must be a JSON object {preset?, enabled?, stages?, add?}.");
        return;
      }
      setDraft(parsed as PipelineOverride);
      setJsonError(null);
    } catch (e) {
      setJsonError(`Invalid JSON: ${(e as Error).message}`);
    }
  }

  async function send(method: "PUT" | "DELETE") {
    if (busy) return;
    setBusy(true);
    setError(null);
    setSaved(null);
    const spec = specText.trim();
    // ifVersion makes the save or reset conditional: a layer someone changed
    // since it was read is refused (409), never overwritten or dropped.
    const body =
      method === "PUT"
        ? {
            ...(spec ? { spec, ...(Object.keys(draft).length > 0 ? { override: draft } : {}) } : { override: draft }),
            ifVersion: version.current,
          }
        : { ifVersion: version.current };
    try {
      const res = await fetch(`/api/pipeline-config${query}`, {
        method,
        headers: writeHeaders(),
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const failure = (await res.json().catch(() => ({}))) as { error?: string; errors?: string[]; unknown?: string[] };
        if (res.status === 409) setChangedElsewhere(true);
        setError({
          message: failure.error ?? `${method === "PUT" ? "Save" : "Reset"} failed (${res.status})`,
          errors: Array.isArray(failure.errors) ? failure.errors : [],
          unknown: Array.isArray(failure.unknown) ? failure.unknown : [],
        });
        return;
      }
      await load();
      setSaved(method === "PUT" ? "Saved — applies to your next launch." : "Reset — this layer no longer changes anything.");
    } catch {
      setError({ message: "The collector may be unreachable.", errors: [], unknown: [] });
    } finally {
      setBusy(false);
    }
  }

  if (loadError) return <div style={{ ...mono, color: theme.waiting }}>{loadError}</div>;
  if (!data) return null;

  const rows = editableStages(PIPELINE_CATALOG, layers);
  const presetLayer = PIPELINE_PRESETS[preset].layer;
  /** A stage field as the layers beneath the structured override leave it: the spec, the global layer, the preset. */
  const beneath = <K extends keyof PipelineStagePatch>(id: string, key: K): PipelineStagePatch[K] | undefined =>
    compiled?.override.stages?.[id]?.[key] ?? lower?.stages?.[id]?.[key] ?? presetLayer.stages?.[id]?.[key];
  const valueOf = <K extends keyof PipelineStagePatch>(stage: PipelineStageDef, key: K): PipelineStagePatch[K] | undefined =>
    draft.stages?.[stage.id]?.[key] ?? beneath(stage.id, key) ?? (stage as PipelineStagePatch)[key];
  const enabled = effective.enabled ?? lower?.enabled ?? true;
  const previewErrors = "errors" in preview ? preview.errors : [];
  const previewLoops: LoopArc[] =
    "definition" in preview
      ? loopBudget(preview.definition, []).map((b) => ({ from: b.from, to: b.to, label: `≤${b.max}`, pressure: 0 }))
      : [];
  const summary = "definition" in preview ? pipelineStageSummary(preview.definition) : [];

  return (
    <div data-testid="pipeline-settings" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div>
        <div style={{ fontSize: 13.5, fontWeight: 700, color: theme.text }}>Delivery pipeline</div>
        <div style={{ ...labelStyle, marginTop: 4, color: theme.accent }}>
          {projectId ? `My override for ${projectId}` : "My default for every project"}
        </div>
        <div style={help}>
          The stages a launched worker moves through before it can call the work done.
          {projectId ? " Applied over your default for every project." : " Each project can override it."}
        </div>
      </div>

      <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: theme.text }}>
        <input
          type="checkbox"
          aria-label="Pipeline enabled"
          checked={enabled}
          onChange={(e) => update({ ...draft, enabled: e.target.checked })}
        />
        Run the pipeline for launches{projectId ? " in this project" : ""}
      </label>

      <div>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: theme.text }}>
          <span style={labelStyle}>Preset</span>
          <select
            aria-label="Pipeline preset"
            value={draft.preset ?? ""}
            onChange={(e) => {
              const next = { ...draft };
              if (isPipelinePresetId(e.target.value)) next.preset = e.target.value;
              else delete next.preset;
              update(next);
            }}
            style={input}
          >
            <option value="">Project default (auto: {auto})</option>
            {PIPELINE_PRESET_IDS.map((id) => (
              <option key={id} value={id}>
                {PIPELINE_PRESETS[id].title}
              </option>
            ))}
          </select>
        </label>
        <div data-testid="pipeline-effective-preset" style={help}>
          {PIPELINE_PRESETS[preset].title}: {PIPELINE_PRESETS[preset].description}
        </div>
      </div>

      <div>
        <span style={labelStyle}>Describe it</span>
        <textarea
          aria-label="Pipeline spec"
          value={specText}
          onChange={(e) => {
            dirty.current = true;
            setSpecText(e.target.value);
            setSaved(null);
          }}
          placeholder="no code review, isolated live check, review packet"
          rows={3}
          spellCheck={false}
          style={{ ...input, width: "100%", marginTop: 6, fontSize: 12.5, resize: "vertical", boxSizing: "border-box" }}
        />
        <div style={help}>
          Plain words, one clause per comma or line: a preset (&ldquo;light&rdquo;, &ldquo;full&rdquo;), a stage on or off (&ldquo;no
          code review&rdquo;, &ldquo;isolated live check&rdquo;, &ldquo;deploy to personal&rdquo;, &ldquo;no screenshots&rdquo;), &ldquo;3
          reviewers&rdquo;, &ldquo;block on high&rdquo;, &ldquo;max 3 rounds&rdquo;. The fields below apply on top of it.
        </div>
        {storedSpec && (
          <div data-testid="pipeline-stored-spec" style={help}>
            Saved spec: <span style={{ ...mono, color: theme.dim }}>{storedSpec}</span>
          </div>
        )}
        {compiled && (compiled.clauses.length > 0 || compiled.unknown.length > 0) && (
          <ul data-testid="pipeline-spec-clauses" style={{ margin: "6px 0 0", paddingLeft: 16, display: "flex", flexDirection: "column", gap: 2 }}>
            {compiled.clauses.map((c, i) => (
              <li key={`k${i}`} data-clause="known" style={{ fontSize: 12, color: theme.text }}>
                <span style={mono}>{c.text}</span> <span style={{ color: theme.faint }}>→</span> {c.effect}
              </li>
            ))}
            {compiled.unknown.map((u, i) => (
              <li key={`u${i}`} data-clause="unknown" style={{ fontSize: 12, color: theme.waiting }}>
                <span style={mono}>{u}</span> → not understood; rephrase it or use the fields below
              </li>
            ))}
          </ul>
        )}
        {compiled?.project && (
          <div style={help}>
            &ldquo;for {compiled.project}:&rdquo; must name the project this saves to —{" "}
            {projectId ? `your override for ${projectId}` : "your default for every project takes no project; set it on that project"}.
          </div>
        )}
      </div>

      <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
        <thead>
          <tr>
            {["Stage", "Skip", "Max attempts", "Owner gate", "Review"].map((h) => (
              <th key={h} style={th}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((stage) => {
            const fixed = stage.kind === "start" || stage.kind === "complete";
            const skip = valueOf(stage, "skip") === true;
            const skippedBeneath = beneath(stage.id, "skip") === true;
            const maxAttempts = valueOf(stage, "maxAttempts");
            const outward = valueOf(stage, "outward") === true;
            return (
              <tr key={stage.id} data-stage-row={stage.id} style={{ opacity: skip ? 0.55 : 1 }}>
                <td style={td}>
                  <div style={{ color: theme.text, fontWeight: 600 }}>{valueOf(stage, "title") ?? stage.title}</div>
                  <div style={{ ...mono, fontSize: 10.5, color: theme.faint }}>{stage.id}</div>
                </td>
                <td style={td}>
                  <input
                    type="checkbox"
                    aria-label={`Skip ${stage.id}`}
                    disabled={fixed}
                    checked={skip}
                    onChange={(e) => setPatch(stage.id, "skip", e.target.checked ? (skippedBeneath ? undefined : true) : skippedBeneath ? false : undefined)}
                  />
                </td>
                <td style={td}>
                  {!fixed && (
                    <input
                      type="number"
                      min={1}
                      aria-label={`Max attempts for ${stage.id}`}
                      value={maxAttempts ?? ""}
                      placeholder={String(DEFAULT_STAGE_MAX_ATTEMPTS)}
                      onChange={(e) => {
                        const n = Number.parseInt(e.target.value, 10);
                        setPatch(stage.id, "maxAttempts", Number.isFinite(n) ? n : undefined);
                      }}
                      style={{ ...input, width: 64 }}
                    />
                  )}
                </td>
                <td style={td}>
                  {outward && (
                    <input
                      type="checkbox"
                      aria-label={`Require owner gate for ${stage.id}`}
                      checked={valueOf(stage, "requireOwnerGate") === true}
                      onChange={(e) => setPatch(stage.id, "requireOwnerGate", e.target.checked ? true : undefined)}
                    />
                  )}
                </td>
                <td style={td}>
                  {stage.kind === "review" && (
                    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <input
                        type="number"
                        min={1}
                        aria-label={`Min reviewers for ${stage.id}`}
                        value={valueOf(stage, "minReviewers") ?? ""}
                        placeholder={String(DEFAULT_MIN_REVIEWERS)}
                        onChange={(e) => {
                          const n = Number.parseInt(e.target.value, 10);
                          setPatch(stage.id, "minReviewers", Number.isFinite(n) ? n : undefined);
                        }}
                        style={{ ...input, width: 52 }}
                      />
                      <select
                        aria-label={`Block on for ${stage.id}`}
                        value={valueOf(stage, "blockOn") ?? DEFAULT_BLOCK_ON}
                        onChange={(e) => setPatch(stage.id, "blockOn", e.target.value as "high" | "medium")}
                        style={input}
                      >
                        <option value="medium">block on High/Medium</option>
                        <option value="high">block on High only</option>
                      </select>
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <ReviewTunnelSettings
        own={draft.reviewTunnel}
        inherited={mergeReviewTunnelConfig([lower?.reviewTunnel, seedLayer?.reviewTunnel])}
        scope={projectId ? "project" : "global"}
        onChange={(reviewTunnel) => update({ ...draft, reviewTunnel })}
      />

      <div>
        <span style={labelStyle}>Preview</span>
        <div data-testid="pipeline-preview" style={{ marginTop: 6 }}>
          {"definition" in preview ? (
            <>
              {!preview.enabled && <div style={{ ...help, marginTop: 0, marginBottom: 6 }}>Pipeline off — launches run without it.</div>}
              <PipelineGraph definition={preview.definition} loops={previewLoops} />
              <ol data-testid="pipeline-stage-summary" style={{ ...help, margin: "8px 0 0", paddingLeft: 18 }}>
                {summary.map((s) => (
                  <li key={s.id} data-summary-stage={s.id}>
                    <span style={{ color: theme.text }}>{s.title}</span>
                    {!s.required && <span> (optional)</span>}
                  </li>
                ))}
              </ol>
            </>
          ) : (
            <ul data-testid="pipeline-preview-errors" style={{ ...mono, color: theme.waiting, margin: 0, paddingLeft: 16 }}>
              {previewErrors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <details>
        <summary style={{ ...labelStyle, cursor: "pointer", display: "list-item" }}>Advanced · raw override JSON</summary>
        <textarea
          aria-label="Raw pipeline override"
          value={jsonText}
          onChange={(e) => onJson(e.target.value)}
          rows={10}
          spellCheck={false}
          style={{ ...input, width: "100%", marginTop: 6, fontFamily: theme.mono, fontSize: 11.5, resize: "vertical", boxSizing: "border-box" }}
        />
        <div style={help}>
          {"{preset?, enabled?, maxRounds?, stages?: {<id>: {skip?, maxAttempts?, edges?, …}}, add?: [{after, stage}], reviewTunnel?: {serve?, dir?, …}}"} — applied on
          top of the spec; `edges` replaces a stage's edges; `add` inserts a stage after another; `maxRounds` bounds every rework loop;
          `reviewTunnel` fields merge over the layers beneath.
        </div>
        {jsonError && <div style={{ ...mono, color: theme.waiting, marginTop: 4 }}>{jsonError}</div>}
      </details>

      {changedElsewhere && (
        <div data-testid="pipeline-settings-stale" style={{ ...mono, color: theme.waiting, display: "flex", alignItems: "center", gap: 8 }}>
          {PIPELINE_CHANGED_ELSEWHERE}
          <button type="button" onClick={() => void load()} style={secondary}>
            Reload
          </button>
        </div>
      )}
      {error && (
        <div data-testid="pipeline-settings-error" style={{ ...mono, color: theme.waiting }}>
          {error.message}
          {error.errors.length > 0 && (
            <ul style={{ margin: "4px 0 0", paddingLeft: 16 }}>
              {error.errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          )}
          {error.unknown.length > 0 && (
            <div data-testid="pipeline-settings-unknown" style={{ marginTop: 4 }}>
              Clauses it couldn&rsquo;t map:
              <ul style={{ margin: "2px 0 0", paddingLeft: 16 }}>
                {error.unknown.map((u) => (
                  <li key={u}>{u}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      {saved && !error && (
        <div style={{ ...mono, color: theme.checkpoint, display: "flex", alignItems: "center", gap: 5 }}>
          <LuCheck /> {saved}
        </div>
      )}

      <LayerDecisions projectId={projectId} />

      <div style={{ display: "flex", gap: 8 }}>
        <button
          type="button"
          onClick={() => void send("PUT")}
          disabled={busy || jsonError !== null}
          style={{ ...primary, opacity: busy || jsonError !== null ? 0.5 : 1 }}
        >
          {busy ? "Saving…" : "Save pipeline"}
        </button>
        <button type="button" onClick={() => void send("DELETE")} disabled={busy} style={secondary}>
          Reset
        </button>
      </div>
    </div>
  );
}

/**
 * Persona's changes to this layer — the owner's default (no `projectId`) or
 * one project's — newest first, with who made each, why and when. Read on
 * mount, on each change to this layer (pipeline_config:updated) and on each
 * socket resync; a failed read keeps what is shown.
 */
function LayerDecisions({ projectId }: { projectId?: string }) {
  const [decisions, setDecisions] = useState<PipelineDecisionRecord[]>([]);
  useEffect(() => {
    setDecisions([]);
    let cancelled = false;
    const query = projectId ? `projectId=${encodeURIComponent(projectId)}` : "scope=user";
    const load = async () => {
      try {
        const res = await fetch(`/api/pipeline/decisions?${query}`);
        if (!res.ok) return;
        const data = (await res.json()) as { decisions?: PipelineDecisionRecord[] };
        if (!cancelled && Array.isArray(data.decisions)) setDecisions(newestFirst(data.decisions));
      } catch {
        // Unreachable for now; the next frame or resync reads it again.
      }
    };
    void load();
    const unsubscribe = subscribePipelineConfigUpdates((change) => {
      const viewer = pipelineViewer();
      if (viewer && change.owner !== viewer) return;
      if (change.scope !== (projectId ? "project" : "user")) return;
      if ((change.projectId ?? null) !== (projectId ?? null)) return;
      void load();
    });
    const unsubscribeResync = subscribePipelineResync(() => void load());
    return () => {
      cancelled = true;
      unsubscribe();
      unsubscribeResync();
    };
  }, [projectId]);

  if (decisions.length === 0) return null;
  return (
    <div data-testid="pipeline-layer-decisions">
      <span style={labelStyle}>Changed by Persona</span>
      <ul style={{ margin: "6px 0 0", padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 6 }}>
        {decisions.map((d) => (
          <li key={d.id} data-decision={d.id} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <div style={{ fontSize: 12, color: theme.text }}>
              <b>{decisionLabel(d)}</b>
              {d.reason ? ` — ${d.reason}` : ""}
            </div>
            <div style={{ fontSize: 11, color: theme.faint }}>
              {d.actor}
              {d.createdAt ? ` · ${new Date(d.createdAt).toLocaleString()}` : ""}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

const mono: CSSProperties = { fontFamily: theme.mono, fontSize: 11.5 };

const labelStyle: CSSProperties = {
  fontFamily: theme.mono,
  fontSize: 9.5,
  letterSpacing: "0.14em",
  textTransform: "uppercase",
  color: theme.faint,
};

const help: CSSProperties = { fontSize: 11.5, color: theme.faint, marginTop: 5, lineHeight: 1.5 };

const th: CSSProperties = {
  ...labelStyle,
  textAlign: "left",
  fontWeight: 600,
  padding: "4px 8px 6px 0",
  borderBottom: `1px solid ${theme.edgeSoft}`,
};

const td: CSSProperties = { padding: "6px 8px 6px 0", borderBottom: `1px solid ${theme.edgeSoft}`, verticalAlign: "middle" };

const input: CSSProperties = {
  fontSize: 12,
  color: theme.text,
  background: theme.ground,
  border: `1px solid ${theme.edge}`,
  borderRadius: 5,
  padding: "4px 6px",
  outline: "none",
};

const primary: CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: theme.ground,
  background: theme.checkpoint,
  border: "none",
  borderRadius: 6,
  padding: "9px 18px",
  cursor: "pointer",
};

const secondary: CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: theme.dim,
  background: "transparent",
  border: `1px solid ${theme.edge}`,
  borderRadius: 6,
  padding: "9px 18px",
  cursor: "pointer",
};
