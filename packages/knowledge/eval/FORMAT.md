# Knowledge eval — data format

The knowledge eval measures retrieval and answer grounding across every surface that serves knowledge:
`search` (search_knowledge), `code` (code search over the project repo), `inject` (launch injection), and
`persona` (what Persona has in context about its owner, and separately what its `recall` tool returns). The data in this directory is the input; the runner lives in
`packages/collector/src/kbeval/` (the collector owns the surfaces) and is driven by `bun run eval:kb`.

## Tiers

| Tier | Corpus | Committed? |
|---|---|---|
| `fixture` | Synthetic corpus in `corpus/` + fixture source repo in `fixture-repo/` | yes |
| `snapshot` | A copy of a real `standup.db`, labels in `local/` | no (`local/` is gitignored) |

The fixture tier is synthetic on purpose: the repository is public, so no real knowledge-base content is
committed. Its projects are fictional (`tidepool`, a tide-prediction library and API; `quillstack`, a static-site generator for documentation teams;
`frost-watch`, an orchard frost protection system; a `scratch` project) next to `standup` itself, and its users
are `owner` (the host user) and
`alice`. It reproduces the failure modes of a real corpus (personal docs homed in `global`, scratch-homed
`scope=global` product docs, a frozen duplicate project, stale plan docs, contradicted pairs, mega-docs, edit
histories, a product name that is also a retrieval term).

## Corpus — `corpus/<project>/<slug>.md`

Each doc is a markdown file with YAML front matter, the same format the knowledge loader reads:

```yaml
---
title: Retry policy for the Slack mirror
source_kind: runbook        # code | product | spec | decision | runbook | native-memory | unclassified (omit = unclassified)
scope: project              # global | project | user (omit = loader default)
owner_user: owner           # only for scope=user
origin_class: owner         # owner | agent (omit = loader default)
confidence: 1               # optional
generated_at: 2026-09-01T00:00:00Z   # optional
last_verified_at: 2026-09-01T00:00:00Z # optional
verdict: contradicted       # optional
native_memory_from: home    # optional; marks a native-memory mirror (home | project | auto-memory)
tags: [slack, retry]
---
body…
```

The directory name is the `project_id`. `global/` is the reserved global project.

`corpus/_edits/<project>/<slug>.<n>.md` holds earlier versions of a doc. The runner loads version 1, then each
later version in order through the real sync path, and the plain `corpus/<project>/<slug>.md` last. This
replays real edit histories, so index-integrity bugs (orphaned FTS rows, stale tail chunks) appear exactly as
they do live.

`corpus/projects.json` lists projects: `[{ "id", "name", "repo": "fixture-repo" | null, "reserved"?, "related"? }]`.
`reserved: true` marks a system project as the collector does (`standup-self`, the self-fix copy, is reserved in
production); `related` is the projects.toml key of the same name.

### How the runner loads the fixture corpus

The runner boots the corpus the way the collector does: a fresh temp `standup.db` on the real schema, projects
seeded through `ProjectsRegistry` (a `repo: "fixture-repo"` project gets the absolute path of `fixture-repo/`),
then `KnowledgeSync` over a temp copy of the corpus (`reindexOnProviderChange` → `syncAll` → edit replay
via `syncProject` → `ensureVecIndex`). File mtimes are fixed
(version *n* lands at 2026-01-01T00:00Z + *n* minutes) so the sync's mtime skip behaves the same on every run.
Boot-time mirrors (project-docs and native-memory ingest) are not re-run; their output is part of the corpus.

Two front-matter fields are bridged because production keeps them outside the loader:

- `verdict:` is applied after loading through `KnowledgeSync.recordDocVerdict`, as the verification layer
  records it. A `contradicted` doc gets a contradiction dispute naming each counterpart: the slugs in an
  optional `contradicts: [slug, …]` field, or else the other contradicted docs in its project that share the
  most tags with it.
- `native_memory_from: home | project | auto-memory` is rewritten, in the temp copy, to the absolute source path
  the native-memory ingest stamps (e.g. `/home/<owner_user|owner>/.claude/CLAUDE.md`,
  `…/.claude/rules/<name>.md`, `…/.claude/projects/<encoded-repo>/memory/<name>.md`). An absolute value is kept.
  `ingested_from` (the project-docs marker) is kept as written.

A project's `repo` is not registered as the source directory itself: the runner copies it into the temp dir and
makes it a pinned git repo with a fixed history — fixed author and committer, every date pinned — and registers
that copy. Git questions (evidence, code search) are then answered from the fixture alone, identically on every
run, whatever checkout the fixture sits in or how many commits have touched it there. The corpus still names the
source path. For `fixture-repo` the history (`FIXTURE_REPO_HISTORY` in the runner's env) is:

- `2026-08-01T00:00:00Z` — the whole tree except the last five lines of `src/knowledge/search.ts` (before every
  fixture doc's date, so every doc anchors at or after it);
- `2026-09-05` … `2026-09-25` — five commits, each restoring one of those lines, so docs naming the file see drift;
- branch `wikilinks`, `2026-09-26`, never merged — adds `src/knowledge/wikilinks.ts` with `parseWikilinks`, the
  corpus's own account (wikilink parsing exists only on an unmerged branch), so a doc naming that symbol carries an
  unmerged claim.

HEAD is `main` and its work tree is the fixture tree byte for byte. No fixture doc names a path or symbol the history
removes, so missing-path/missing-symbol do not fire in the fixture (the corpus is frozen; they are covered by the
collector's tests).

Then the re-verification cron's deterministic evidence pass (`runEvidencePass`, git only, no model) runs once
over every project re-verification reaches, as the collector runs it shortly after boot. It writes no doc: it
records, in `knowledge_freshness`, each repo mirror's source-commit date, the findings that hold against each
doc (named paths/symbols gone since its anchor, unmerged shas or branch-only symbols and newer contradicting docs
cap its base; file drift does not), and whether the model pass could check the doc against the repo. The freshness
gate reads that record. The docs it checked, capped and re-anchored are recorded in `load.evidence`. The model pass
is not run, and no fixture project opts into it, so decay never gates a fixture doc out: it demotes and marks it
(`staleSince`).

After loading, the random doc and chunk ids the loader assigns are rewritten to ids derived from
`project/slug` (references carried along), so rank tie-breaks on id are reproducible. Orphaned FTS rows stay
orphaned.

### Known duplicates — `dedup-pairs.txt`

`scripts/kb-dedup-calibrate.ts --fixture` labels the corpus's true duplicates from `dedup-pairs.txt` (format in
`scripts/kb-dedup-pairs.ts`): one `project/slug project/slug` pair per line, or `a/* b/*` for every same-slug pair
across two projects (the frozen `standup-self` copy, the `scratch` drafts of `frost-watch`). Rename a project or
slug there in the same change as the corpus. The eval runner does not read it.

## Cases — `cases/*.json`

Each file is a JSON array of cases. Labels are frozen: `cases.lock` holds the sha256 of every case file, and
the gate refuses to compare against a baseline whose lock differs (add new cases in a new file, then
re-baseline deliberately with `--rebaseline`).

```jsonc
{
  "id": "docs-rrf-why",             // unique, stable
  "category": "docs",               // docs | code | personal | leakage | offtopic | staleness | inject
  "surface": ["search", "code"],    // surfaces this case is run against
  "audience": { "projectId": "standup", "user": "owner" },
  "query": "why did we switch score blending to RRF",
  "relevant": [                     // graded relevance; empty for negatives
    { "doc": "standup/knowledge-retrieval-quality", "grade": 2 },
    { "code": "packages/fake/search.ts:fuseRrf", "grade": 1 }   // code location: path[:symbol]
  ],
  "forbidden": ["tidepool/*", "global/native-mem-*"],         // glob over project/slug; any hit = leak
  "expectEmpty": false,             // true = a correct system returns nothing
  "staleOver": [["standup/status-fresh", "standup/status-stale"]], // [fresh, stale]: fresh must rank above stale
  "staleDocs": ["standup/status-stale"], // docs whose claims are false today; returned unflagged = stale hit
  "silver": false,                  // true = agent-labeled, not human-verified (metrics also split gold/silver)
  "source": "review:D1",            // provenance (review probe id, logged query, authored)
  "note": "…"
}
```

The split is deterministic: a case is `holdout` when `parseInt(sha256(id).slice(0, 8), 16) % 5 === 0`
(about 20%). Tuning decisions use `dev` only; `holdout` is reported separately and never tuned against.

Labeling rules: `forbidden` never lists auto-memory notes (`native-mem-memory-*`); on persona cases it lists
only other users' personal docs — everything else outside Persona's audience is caught by `policyLeakage`.

`audience.user` is the requesting user the routes resolve (sent as the tunnel identity header). A case with no
user is sent as a user who owns nothing, so the host-user fallback never applies. Persona cases use
`audience.projectId: "global"` and `audience.user` = the owner.

`cases.lock` is `{ "version": 1, "files": { "<file>.json": "<sha256>" } }`; `bun run eval:kb --lock` writes it.

## Surfaces

Each surface drives the real production entry point with the arguments production passes:

| Surface | Entry point | Hits |
|---|---|---|
| `search` | `POST /api/knowledge/search` `{ cwd, query, project, scoped: true }` (the MCP `search_knowledge` call) | the confident results in order (the route applies the search confidence floor); `marked` = the MCP formatter's ⚠ (verdict `disputed`, `contradicted` or `superseded`, or `injectionEligible: false`) |
| `code` | `searchCode` (the engine the `ripgrep` tool uses) over the case project's repo, with the query's terms (`extractTerms`) as one case-insensitive alternation of literals; `*.eval.ts` excluded | files ranked by the share of distinct query terms they contain, plus a bonus for a term in the file name and a damping for prose, files under the minimum coverage dropped; each hit is `code:<path>` with its matched lines as the excerpt; never `marked` |
| `inject` | `retrieveCodeKnowledge` + `retrieveProductKnowledge` + the char-budgeted `format*KnowledgeInjection`, task = query | the docs actually included in the opening prompt, code block first |
| `persona` | What is in Persona's context without a tool call: the system prompt `buildSystemPrompt` renders for the owner (with the owner profile when the adapter has a hook for one), plus the worker-brief preferences block when the adapter has a hook for one | the set of docs in either: the docs a hook reports it rendered, plus any other doc named (`project/slug` or exact title) in the rest of the prompt or in a hook's text that reports none; unordered |
| `persona-recall` | Persona's `recall` tool: `POST /api/knowledge/search` `{ cwd: "", query, project: "global", scoped: true }` as the owner | the top 6 results in order, no markers |

A case labeled `persona` runs both: `persona` and `persona-recall` are separate pairs with the same labels. The
persona adapter (`PersonaContextAdapter`, recorded as `config.personaAdapter`) returns
`{ contextRefs, briefRefs, recall }` and is swappable; `makePersonaAdapter(name, { ownerProfile, briefPreferencesBlock })`
builds one over the production prompt path. Each hook returns the rendered text, or `{ text, refs }` naming the
docs it drew on (taken as given; the rest of the prompt is still matched by name, so a same-titled copy of a profile
doc elsewhere is not counted). The default adapter (`profile+brief+recall`) wires both hooks to the production
builders: `buildOwnerProfile` (persona/owner-profile.ts) for the system prompt and `formatOwnerPreferences` for the
brief block.

The clock is pinned (`--now`, default 2026-10-01T00:00:00Z) so confidence decay is reproducible. sqlite-vec is
off (brute-force cosine) unless `--vec`. Graph rerank follows its production default.
Before measuring, each tier calibrates the relevance cosine band on its own corpus, as production does once a
corpus is embedded (`ensureCosineCalibration`, packages/knowledge/src/calibration.ts): fixed off-domain probe
questions and a hash-sampled set of doc titles are embedded (they are part of the embedding cache), and the measured
band is recorded as `config.relevanceCalibration` (`status`, `low`, `high`). The snapshot tier calibrates its temp
copy after any `--migrate` migrations, i.e. on the corpus as production would after its backfill. Calibration
embeds every probe and sampled title through the tier's embedding cache, and a single miss leaves the band at the
nomic defaults (`status: "uncalibrated"`, 0.45–0.75): such a run logs the miss count and records it as
`config.relevanceCalibration.embeddingMisses`, and `--refresh-embeddings` fills the cache so the next run is
calibrated. Runs whose band is `uncalibrated` are not comparable with calibrated runs of the same tier.

## Metrics

Per (case, surface) pair, aggregated overall and by surface, category, split, gold/silver, surface×category and
surface×split:

- `recallAt5`, `mrrAt10`, `nDCG@10` (linear gain = grade, log2(rank+1) discount, each label credited once),
  `pAt5` (relevant top-5 hits / 5) — over cases with ≥1 positive label, on the ranked surfaces (every surface
  except `persona`).
- Context set metrics (`persona` only; rank is ignored and the pair carries none of the ranked, negative,
  code, injection or staleness-rank metrics, so it never enters the ranked aggregates):
  `inContextRecall` (mean fraction of positive labels present; `contextCases` = pairs with ≥1 positive label),
  `inContextHit` (fraction of those pairs with ≥1 present), `staleInContext` (mean fraction of the case's stale
  docs — the stale side of each `staleOver` pair plus `staleDocs` — present; `staleContextCases` = pairs with
  any). Label leakage and policy leakage are measured over the context set as on every surface. The report
  prints these in their own table.
- `negativeEmptyRate` — `expectEmpty` cases returning zero hits.
- `leakageRate` / `leakedHits` — cases with `forbidden` globs where any hit matches (`*` spans `/`).
- `policyLeakage` `{ pairs, rate, hits, byRule }` — leakage judged from doc metadata on every pair, no labels
  involved (hits plus docs fed but not listed): `ownerMirror` — a mirror of the owner's home/project CLAUDE.md or
  rules (`native-mem-{home,project}-{claude-md,rule-*}`) on search/inject; `otherUser` — a `scope=user`
  doc owned by someone other than the audience user; `otherProject` — a `scope=project` doc homed in another
  project (the reserved `global` home reaches everyone); `injectForeignProduct` — on inject, a product/spec doc
  from another project. Auto-memory notes (`native-mem-memory-*`) are project activity notes and never leak.
- `codeHitRate` — cases with a code label where a matching code hit appears (same path, and the label's
  symbol in the excerpt or its line among the excerpt's line numbers).
- `injectionPrecision` / `offTopicInjectionRate` (inject).
- `freshOverStaleRate` (fresh ranks above stale, or stale absent while fresh present), `staleFlagRate` (stale doc
  absent or marked), `staleHitRate` (staleDocs cases with a stale doc returned unmarked in the top 5).
- Index integrity (raw counts): FTS rows vs docs, orphan FTS rows, docs whose FTS title/body differs from the
  doc, orphan chunks, tail chunks (`chunk_index` ≥ the production chunker's count for the current body), docs
  without chunks, vec/chunk mismatch (with `--vec`), and whether the embedding fingerprint pins a model digest.

## Embeddings — `embeddings/cache.bin` + `embeddings/index.json`

The cache holds real `nomic-embed-text` vectors for every chunk and query text, so runs are deterministic and
need no network. It is keyed by `sha256(modelDigest + "\n" + text)` and stores int8-quantized vectors.
`--refresh-embeddings` fills misses from a local Ollama. In `--gate` mode a miss is an error.

`cache.bin` (little-endian):

| Bytes | Field |
|---|---|
| 4 | magic `KBEC` |
| 4 | u32 format version (1) |
| 4 | u32 dims (768) |
| 4 | u32 record count |
| count × (36 + dims) | records sorted by key bytes: 32-byte raw sha256 key, f32 scale, dims × i8 |

Quantization is symmetric per vector: `scale = max|v| / 127`, `q[i] = round(v[i] / scale)`, value
`= q[i] × scale`. A freshly fetched vector is returned dequantized too, so a refresh run and a cached run embed
identically. `index.json` holds `{ format, version, provider, model, modelDigest, dims, count, quantization,
binSha256 }`; `modelDigest` is the installed model's digest from Ollama's `/api/tags`, read on
`--refresh-embeddings` and taken from the index otherwise. The runner installs the cache as the `ollama`
provider with the production plugin's model and width, reporting the cache's `modelDigest` as the model digest,
so the corpus fingerprint reads `ollama:nomic-embed-text:768|digest=<modelDigest>|chunker=<CHUNKER_VERSION>`
exactly as a live install of that model. The cache returns the stored vector for a stored text, so the boot
embedding canary reproduces the corpus vectors exactly and never triggers a reindex. `--refresh-embeddings --prune` drops entries the run did not use.

The snapshot tier keeps its query-embedding cache in `local/embeddings/` (same format); chunk vectors come from
the snapshot DB itself.

## Results

- `baseline.json` — the first run recorded on the current corpus and cases. Frozen.
- `accepted.json` — the ratchet the gate compares against; updated when a phase lands.
- `results/<label>.json` — individual runs (gitignored).
- `history/<name>.json` — milestone runs worth committing; `--save-history <name>` writes one (snapshot tier:
  `local/history/`). A history file belongs to the corpus it was run on, so a wholesale corpus change drops them.

Until `baseline.json` or `accepted.json` exists, the gate test skips: the gate is off, not passing.

### Re-recording the references

The fixture references, `embeddings/cache.bin` and `retrieval/embeddings/cache.bin` are recorded together whenever
the corpus or the cases change wholesale (a new corpus invalidates every cached vector):

1. Commit the corpus, cases and fixture repo first: the code search reads only tracked files, and a `git-grep`
   reference needs the fixture repo inside a git checkout.
2. `STANDUP_RG_PATH= bun run eval:kb --refresh-embeddings --prune` — fills `embeddings/` from a local Ollama
   (`nomic-embed-text`). Hiding ripgrep records the `git-grep` engine, which every host with git 2.38+ reproduces.
3. `bun run eval:kb --lock` — rewrites `cases.lock`.
4. `STANDUP_RG_PATH= bun run eval:kb --write-baseline`, then `bun run eval:kb --accept` (pinned to the baseline's
   engine), with `accepted.json` and `baseline.json` removed beforehand.
5. `bun run eval:retrieval --out <dir>` — fills `retrieval/embeddings/` with the texts the retrieval harness adds.
6. `bun run eval:kb --gate`, and the gate test (`packages/collector/src/kbeval/gate.test.ts`).

A results file (`schemaVersion: 1`) has `tier`, `label`, `provenance` (git HEAD, cases.lock hash and whether the
case files match it, corpus hash, embedding model + digest), `config` (clock, vec, graph rerank, embeddings,
`codeSearchBackend` — the engine the `code` surface would use on this host: `rg`, `git-grep` or `js` —
surfaces, persona adapter, and — on a `--migrate` run — one summary line per migration applied), `load` (edit replay counts), `embeddings` (hits, misses, fetched,
miss keys), `integrity`, `codeSearch` (the `code` surface's per-case outcomes: `cases`, counts `byStatus`
— ok / degraded / unavailable / missing — and `byBackend` — rg / git-grep / js / none — and `failing`, one
`<case id>: <status> (<error>)` line per code case whose search was not ok/degraded or reported any error; each case's
own outcome is in its code `detail.codeSearch`), `metrics` (`overall`, `bySurface`, `byCategory`, `bySplit`, `byLabel`,
`bySurfaceCategory`, `bySurfaceSplit`), `errors`, `cases` (per case and surface: top-10 hits with flags, the
pair metrics, surface detail), and `run` (wall-clock stamp and captured production log lines).

Each recorded hit may carry `why: { components }` — every score field the surface's hit carried (`score`,
`rawScore`, `relevance`, and any `signals` / `components` breakdown; rounded like the other scores), the same
fields production records in `knowledge_retrievals.components_json`. The inject surface adds
`detail.gated`: the candidates its gates held back, `{ ref, reason, components }`, where `reason` is the
production drop reason (`floor`, `verdict`, `confidence`, `origin`, `foreign-intent`, `cutoff`, and `budget` — a
result the prompt's char budget squeezed out). These are diagnostic: no metric or gate reads them,
so they explain a metric's movement in a results diff without changing it.
Everything except `run` is byte-identical across runs of the same code, corpus, cases and cache.

## Gate

`bun run eval:kb --gate` compares against `accepted.json`, else `baseline.json`, and fails on: recall@5,
MRR@10, nDCG@10 or P@5 dropping more than 0.02 absolute (overall or any surface);
`inContextRecall` or `inContextHit` dropping, or `staleInContext` rising, more than 0.02 absolute; the
negative empty-rate dropping more than 0.03; any increase in leakage rate or leaked hits, or in policy leakage
(rate, hits, or any rule's count); any increase in an
integrity count; a cases.lock hash different from the reference's, or case files that don't match
`cases.lock`; any embedding cache miss; any surface error; the code-search backend or the sqlite-vec setting differing from
the reference; any code case whose code search was not ok/degraded or reported an error (checked even when the reference has no
`codeSearch` section), or a `codeSearch.byBackend` mix differing from the reference's (when it has one); a
`--case`-filtered run.
A gated run uses the reference's code-search engine: when the reference recorded `git-grep` or `js`, the run hides
ripgrep (`STANDUP_RG_PATH=""`), so a host with `rg` installed measures the same engine rather than failing the
backend checks. An `rg` reference pins nothing, and on a host without `rg` those checks still fail — the `code`
surface is then genuinely not comparable. Every metric, leakage and integrity check applies to the pinned run.
The pin cannot hide git, so the fixture-tier gate also checks that the host can reproduce the reference's conditions
and fails with the cause when it cannot: for a `git-grep` reference, git must run, be 2.38+ (the code search's
per-file cap uses `git grep -m`), and see the fixture repo inside a git checkout; for any reference, the fixture repo must
have no untracked, non-ignored files, which every engine would search.
`--accept` and `--write-baseline` are pinned the same way to the existing reference, so the engine a reference
records carries forward; recording an `rg` reference in place of a `git-grep`/`js` one means removing
`accepted.json` and `baseline.json` first.
`--write-baseline` (refuses to overwrite without `--force`; `--rebaseline` = both) and `--accept` record the
current run and refuse while the lock mismatches or the cache missed.

### Exceptions

`accepted.json` may carry an `exceptions` array of approved regressions, each
`{ surface, metric, caseId, reason, approvedBy, recordedValue }`: a ranked metric (recall@5, MRR@10, nDCG@10,
P@5) of one surface that may drop because of one case. A violation of
`<surface>.<metric>` or `overall.<metric>` is ignored only when the metric, recomputed in both the run and the
reference without that case's pairs, no longer violates — a drop any other case contributes to still fails.
The exception itself fails the gate when the case's own value on the surface falls below `recordedValue`, or
the case is no longer measured there.

Record one with the accept that takes the drop:

```
bun run eval:kb --accept --exception '<surface>:<metric>:<caseId>:<reason>' --approved-by '<who>'
```

`recordedValue` is the case's value in that run. `--exception` repeats, needs `--accept` and `--approved-by`,
and replaces an earlier exception for the same surface, metric and case. A later `--accept` keeps the
exceptions already in `accepted.json`; remove an entry by hand once its case's label is corrected.

Recorded exceptions: none. A fresh `--write-baseline` / `--accept` pair needs none: a label the runtime cannot
meet lowers the recorded value rather than failing. Grade-1 labels on a personal case are the likeliest kind: a
home rule mirror graded 1 for `persona-recall` can sit near the search confidence floor Persona's recall goes
through and drop out of recall@5, while the same doc stays in Persona's in-context profile. If a later accept
takes a drop on such a case, record it as an exception or correct the label in the same change.

## Snapshot tier

`bun run eval:kb --snapshot [db]` (default `local/snapshot.db`) runs the same surfaces against a real DB. The file
is copied to a temp dir first and only the copy is opened — `createStore` migrates and the read routes record
retrieval telemetry. Paths under `~/.local/share/standup/` (other than its `worktrees/`) and the live DB are
refused. Cases come from `local/cases/*.json`, the `code` surface greps `local/repo/`, and results, `cases.lock`,
`baseline.json` and `accepted.json` live under `local/`. No corpus sync runs against a snapshot.

`--migrate` (either tier) applies every migration in `scripts/kb-migrations/` to the run's temp DB, in order, with
`--apply`, DB-only (no knowledge dir), before anything is measured; the host user owns the personal-layer docs the
migrations re-scope. On the snapshot tier, `local/repo/plan/` stands in for the plan dir of each project with a
configured repo (the DB-only signal for which docs the project-docs ingest mirrored). The applied counts are logged
and recorded in `config.migrations`. Compare a `--migrate` run with a plain run of the same code to see what the
data fixes change.

`bun run eval:kb --harvest <db>` opens a DB copy read-only and writes `local/harvest-candidates.json`: distinct
logged queries from `knowledge_retrievals`, unlabeled, with a guessed category, the split,
and the logged top hits as hints.
