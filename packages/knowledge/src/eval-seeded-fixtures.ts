import type { EvalFixture } from "./eval.js";

/**
 * Fixtures for the deterministic seeded corpora that eval.test.ts and
 * eval-graph.test.ts build in memory: a fictional docs site generator (quillstack/*),
 * a fictional tide-prediction library (tidepool/*) and a few standup/* docs. Each key
 * names a doc both test corpora seed. Half keyword (must not regress), half
 * abstract paraphrase (the precision edge).
 */
export const SEEDED_EVAL_FIXTURES: EvalFixture[] = [
  {
    query: "overrides partial shadows theme upgrade pin",
    expected: ["quillstack/override-shadowing"],
    kind: "keyword",
    note: "the copied-override-hides-the-upgrade gotcha",
  },
  {
    query: "nightly refit job constituent set gauge observations",
    expected: ["tidepool/architecture"],
    kind: "keyword",
    note: "on-demand predictions fed by the nightly refit",
  },
  {
    query: "transcript events sequence number durable log",
    expected: ["standup/status"],
    kind: "keyword",
    note: "transcript-as-shared-state substrate",
  },
  {
    query: "Console tabs ProjectsView App.tsx WebSocket components",
    expected: ["standup/ui-components"],
    kind: "keyword",
    note: "web UI as-built structure",
  },
  {
    query: "page graph plugin host stdio render hook",
    expected: ["quillstack/build-pipeline"],
    kind: "keyword",
    note: "the single-process build pass",
  },
  {
    query: "why does my site still show the old header after upgrading the theme",
    expected: ["quillstack/override-shadowing"],
    kind: "paraphrase",
    note: "the upgrade landed but a copied partial still wins — the abstract phrasing of the gotcha",
  },
  {
    query: "are forecasts saved somewhere or computed fresh for each request",
    expected: ["tidepool/architecture"],
    kind: "paraphrase",
    note: "predictions are never persisted, phrased abstractly",
  },
  {
    query: "how is the react frontend organized and where does state live",
    expected: ["standup/ui-components"],
    kind: "paraphrase",
  },
  {
    query: "what landed in the overnight autonomous build",
    expected: ["standup/status"],
    kind: "paraphrase",
  },
  {
    query: "trust classes and provenance of agent-authored memory",
    expected: ["standup/openclaw-architecture"],
    kind: "paraphrase",
    note: "abstract query the tangential remote-runners doc can outrank",
  },
];
