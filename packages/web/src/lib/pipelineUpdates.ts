import type { PipelineConfigUpdatedPayload, PipelineRun } from "@standup/shared";

type Listener = (run: PipelineRun) => void;
type ResyncListener = () => void;

const listeners = new Set<Listener>();
const resyncListeners = new Set<ResyncListener>();
let viewer: string | null = null;

/**
 * Fans a `pipeline:updated` WebSocket frame out to every mounted pipeline
 * view. App owns the socket and calls this per frame; views subscribe here
 * instead of threading a signal prop through every page that can show a run.
 */
export function publishPipelineUpdate(run: PipelineRun): void {
  for (const listener of listeners) listener(run);
}

/** Calls `listener` for each pipeline update until the returned function is called. */
export function subscribePipelineUpdates(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Tells every mounted pipeline view to re-read its runs. App calls this on
 * each socket (re)connect and on a seq gap, when frames may have been missed.
 */
export function publishPipelineResync(): void {
  for (const listener of resyncListeners) listener();
}

/** Calls `listener` on each resync until the returned function is called. */
export function subscribePipelineResync(listener: ResyncListener): () => void {
  resyncListeners.add(listener);
  return () => {
    resyncListeners.delete(listener);
  };
}

type ConfigListener = (change: PipelineConfigUpdatedPayload) => void;

const configListeners = new Set<ConfigListener>();

/**
 * Fans a `pipeline_config:updated` frame — one of the viewer's pipeline
 * layers changed, by Persona or another tab — out to every mounted settings
 * view.
 */
export function publishPipelineConfigUpdate(change: PipelineConfigUpdatedPayload): void {
  for (const listener of configListeners) listener(change);
}

/** Calls `listener` for each pipeline-config change until the returned function is called. */
export function subscribePipelineConfigUpdates(listener: ConfigListener): () => void {
  configListeners.add(listener);
  return () => {
    configListeners.delete(listener);
  };
}

/** Records the viewer's alias (the hello-ok identity); empty clears it. */
export function setPipelineViewer(alias: string | null): void {
  viewer = alias || null;
}

/** The viewer's alias, or null before the socket's first handshake. */
export function pipelineViewer(): string | null {
  return viewer;
}

/**
 * `runs` with the frame's `run` applied: a run already listed is replaced in
 * place; a run not listed is added only when it belongs to one of `launchIds`
 * and is owned by `viewer` (frames are owner-addressed, so anything else is a
 * run the REST read didn't return to this viewer). Returns `runs` itself when
 * nothing changes.
 */
export function applyPipelineFrame(
  runs: PipelineRun[],
  run: PipelineRun,
  launchIds: ReadonlySet<string>,
  viewerAlias: string | null
): PipelineRun[] {
  const i = runs.findIndex((r) => r.id === run.id);
  if (i !== -1) {
    const next = runs.slice();
    next[i] = run;
    return next;
  }
  if (!launchIds.has(run.launchId) || !viewerAlias || run.owner !== viewerAlias) return runs;
  return [...runs, run];
}

/**
 * A REST read of runs applied over the runs on screen: the read's list wins,
 * except for runs a `pipeline:updated` frame changed after the read began
 * (`framed`, by id): those keep the frame's version unless the read's is
 * newer (`updatedAt`), and one the read doesn't
 * list (a run a frame added meanwhile) stays. A run whose shown version is
 * newer than the read's (`updatedAt`) also stays. A read that started before
 * a change and landed after its frame would otherwise undo it — a park or an
 * unpark doesn't move `updatedAt` — with nothing to correct it when the view
 * doesn't poll.
 */
export function applyRunsRead(onScreen: PipelineRun[], read: PipelineRun[], framed: ReadonlySet<string> = new Set()): PipelineRun[] {
  const shown = new Map(onScreen.map((r) => [r.id, r]));
  const next = read.map((r) => {
    const s = shown.get(r.id);
    return s && ((framed.has(r.id) && s.updatedAt >= r.updatedAt) || s.updatedAt > r.updatedAt) ? s : r;
  });
  const listed = new Set(read.map((r) => r.id));
  for (const s of onScreen) if (framed.has(s.id) && !listed.has(s.id)) next.push(s);
  return next;
}
