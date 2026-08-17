# Phase 7 — Knowledge bootstrap

Implementation plan for Component 4.6. The design is in
[high-level-design.md](high-level-design.md); the phase table and model
assignments are in [implementation.md](implementation.md).

Run an agent over a newly wired project and have it write the first draft of
that project's knowledge base. Output lands as drafts, requires human review
before it becomes searchable, and records the commit it came from so
staleness can be surfaced later.

---

## Decisions already taken

These were open when planning started and are settled. Recorded here so they
are not relitigated mid-build.

| Decision | Choice | Why |
|---|---|---|
| Phase 5 ranking gap | **Close it first, as Step 0** | Adding generated text to a corpus whose ranking is already imperfect makes a regression impossible to attribute. Step 0 is the instrument the rest of the phase is measured with. |
| Draft storage | **Markdown in `.drafts/`, indexed in its own SQLite table** | Same split as accepted knowledge — files are the source of truth, SQLite is the index. Drafts get their own table with no FTS and no chunks, so exclusion from search is structural rather than a filter four call sites must remember. |
| Delivery from the agent | **A gated `propose_knowledge` MCP tool** | The collector stamps provenance from the worktree's real git HEAD, so a sha cannot be self-reported wrong. Drafts broadcast to the feed as they arrive, so the run is watchable and stoppable. |

On the storage split, to be explicit about what "both" means: a draft is a
markdown file at
`~/.config/standup/knowledge/{project}/.drafts/{slug}.md` **and** a row in
`knowledge_drafts`. The file is editable in your own editor and survives a
database wipe; the row is what the review UI lists. This mirrors accepted
knowledge exactly — `knowledge-sync.ts:40` reads `.md` files off disk and
`store.ts:46` indexes them into `knowledge` + `knowledge_fts` +
`knowledge_chunks`. Nothing in the search path ever opens a file.

---

## Step 0 — Close the Phase 5 ranking gap ✅ DONE

**Model: Opus.** This is a gate, not a warm-up. Nothing downstream is
measurable until it passes.

> **Outcome: 12/12, multi-hop 4/4** (from a true baseline of 7/8, 3/4 — the
> recorded 8/8 was stale). Changes landed in `ripgrep.ts`, `expert.ts` and
> `expert.eval.ts`. Three defects, all found by measuring:
>
> 1. `--max-count 3` capped how many distinct terms a file could be *observed*
>    to contain, so coverage on a 7-term question maxed at 0.43 while a
>    filename match was worth 0.6. Now 10.
> 2. `MAX_MATCHES = 200` truncated by line in traversal order, making file
>    eligibility a function of alphabetical path — `packages/web/` was
>    systematically invisible. Latent at max-count 3 (volume sat at 196–201
>    against the 200 cap), fatal above it. `runRipgrep` now takes a
>    caller-supplied budget; the agent-facing tool keeps 200.
> 3. Name bonus rebalanced 0.6 → 0.45, the middle of the passing band.
>
> An IDF-weighted coverage was tried and measured no better; not in the code.
>
> **Baseline for Step 7: 12/12 with embeddings, 11/12 text-only, multi-hop 4/4
> either way.** Found while verifying Step 1: `single-hop: intent from
> knowledge` cannot pass on text search alone — FTS5 does no stemming, so that
> question's distinguishing words never match, and `mergeResults`' `Math.max(
> ...scores, 1)` clamp leaves the score four orders of magnitude below the
> relevance floor. It was passing on the embedding half, and the chunk index
> has since been cascade-deleted by test cleanup (see the runbook). Record
> which mode a number was measured in, or it is not comparable.

`implementation.md:29-34` records the symptom: the eval passes 8/8, but an
ad-hoc question about how a launched session gets matched to its owning
project failed to surface `launcher.ts` or `findLaunchByCwd` in the top 6,
returning tangentially related files instead. The architecture is right;
ranking is mediocre for some phrasings.

**Do not quote an eval question verbatim in these plan docs.** They are in
the searched corpus, so a doc repeating the exact wording becomes a fixture
for the case it describes — the `*.eval.ts` trap from Phase 5, in a form the
glob exclusion does not catch. This bit during Step 0: with the question
quoted here and in `implementation.md`, both files outranked every real
source for it. Paraphrase instead.

1. Add the known-failing question to `expert.eval.ts` as a case expecting
   `launcher.ts` and `launches.ts` (`findLaunchByCwd` lives at
   `packages/store/src/queries/launches.ts:116`, not in the launcher — a case
   worth writing precisely because the obvious guess is wrong).
2. Add three or four more ad-hoc phrasings in the same spirit — questions a
   real agent would ask, phrased the way a person phrases them, not the way
   the corpus words them.
3. Fix ranking until they pass **without regressing 8/8 or multi-hop 4/4.**

Where to look, in the order worth trying:

- `expert.ts:239` — `coverage` divides by `terms.length`, and `extractTerms`
  caps at 8 terms (`expert.ts:79`). A long question dilutes every file's
  coverage score uniformly, which flattens exactly the ranking signal being
  relied on.
- `expert.ts:212` — `--max-count 3` caps matches per file before scoring, so
  a file that mentions a term many times looks identical to one that mentions
  it once.
- `expert.ts:248` — `nameBonus` should have fired for `launcher.ts` on a
  question containing "launcher". Establish whether it did and was outweighed,
  or never fired at all. These have different fixes.

**Do not hand-tune by feel.** `runbook.md:145-150` records that the `design`
region weight see-saws between failure modes — 1.2 loses intent questions,
1.6 steals attribution from code lookups, 1.3 passes. Re-run
`bun run eval:expert` after every change.

**Exit criterion:** all cases pass, multi-hop still 4/4, and the numbers are
written into `implementation.md`'s progress table. That recorded baseline is
what Step 7 compares against.

---

## Step 1 — Draft storage

**Model: Sonnet.**

### Schema

Add to `KnowledgeStore.ensureTables()` in
`packages/knowledge/src/store.ts:9` — **not** to `migrations.ts`. See the
trap below; this is not a style preference.

```sql
CREATE TABLE IF NOT EXISTS knowledge_drafts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  tags_json TEXT,
  file_path TEXT NOT NULL,

  -- Provenance, stamped by the collector rather than the agent.
  generated_from_sha TEXT,
  generated_at TEXT,
  generated_by_launch_id TEXT,

  -- Review state. 'pending' is the only state a row lives in for long:
  -- accept moves the file and deletes the row, discard deletes both.
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'discarded')),

  -- Set on regenerate: the accepted doc this draft would overwrite. NULL on
  -- a first bootstrap, which is why review shows a preview then and a diff
  -- only on regeneration.
  replaces_slug TEXT,

  reviewed_at TEXT,
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(project_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_knowledge_drafts_project
  ON knowledge_drafts(project_id);
```

**There is deliberately no `embedding_json` column and no FTS table.** A
draft is listed for review, never retrieved semantically. `searchText`
(`search.ts:78`) queries `knowledge_fts` and `searchEmbeddings`
(`search.ts:111`) queries `knowledge_chunks` — neither table has any path to
`knowledge_drafts`, so a draft cannot leak into an agent's context even if
someone later forgets this constraint exists. That is the whole point of
choosing a separate table over a `status` column.

Accepted docs also need provenance. Add two columns to the `knowledge`
CREATE statement in the same method:

```sql
generated_from_sha TEXT,
generated_at TEXT,
```

plus a guarded backfill for databases that already exist:

```ts
// CREATE TABLE IF NOT EXISTS silently does nothing when the table is already
// there, so new columns need an explicit add. PRAGMA-checked because SQLite
// has no ADD COLUMN IF NOT EXISTS.
private ensureColumns(): void {
  const existing = new Set(
    (this.db.query("PRAGMA table_info(knowledge)").all() as Array<{ name: string }>)
      .map((c) => c.name)
  );
  for (const col of ["generated_from_sha", "generated_at"]) {
    if (!existing.has(col)) {
      this.db.exec(`ALTER TABLE knowledge ADD COLUMN ${col} TEXT`);
    }
  }
}
```

### Loader and writer changes

- `KnowledgeLoader.loadProject()` (`loader.ts:16`) already ignores `.drafts/`
  for free — `readdir` returns the directory name, which fails the
  `.endsWith(".md")` check at `loader.ts:24`. **Verify this rather than
  assuming it**, and add a test, because it is load-bearing by accident
  rather than by design.
- Add `loadDrafts(projectId)` reading from the `.drafts/` subdirectory,
  parsing the provenance frontmatter.
- `writer.ts` gains `writeDraftFile` / `acceptDraftFile` / `deleteDraftFile`.
  `acceptDraftFile` moves `.drafts/{slug}.md` to `{slug}.md`, preserving the
  provenance frontmatter so an accepted doc still records where it came from.
- Reuse `isValidSlug` (`writer.ts:34`) unchanged — a draft slug becomes a
  filename on accept, so it needs the same constraint.

### Sync

`KnowledgeSync.syncProject()` (`knowledge-sync.ts:40`) gains a parallel
`syncDrafts(projectId)` that reconciles `.drafts/` against
`knowledge_drafts`. It does **not** chunk or embed — skipping that is what
makes bootstrap cheap to re-run and drafts impossible to retrieve.

---

## Step 2 — `propose_knowledge`

**Model: Sonnet.**

A sixth MCP tool, in `packages/mcp/src/tools.ts:37` alongside the existing
five.

```
propose_knowledge(slug: string, title: string, body: string, tags?: string[])
  -> { ok: true, slug: string }
```

Tool description should state plainly that it writes a *draft* requiring
human review, so the agent does not treat a successful call as publication.

### Collector endpoint

`POST /api/knowledge/propose` in `server.ts`:

1. Resolve session and project through the existing correlation path used by
   `/api/checkpoint` (`server.ts:893`).
2. `findLaunchByCwd(store.db, cwd)` (`launches.ts:116`). **Reject unless
   `launch.kind === "bootstrap"` and `launch.status === "running"`.** Any
   other session calling this gets an error explaining the tool is only
   available inside a bootstrap run. Without this gate, any agent anywhere
   can write into your knowledge base.
3. `git rev-parse HEAD` in `launch.worktreePath` for the provenance sha.
4. Validate the slug; reject reserved names that would collide with a doc the
   human is actively editing.
5. Write `.drafts/{slug}.md` and upsert the `knowledge_drafts` row.
6. If an accepted doc with the same slug exists, set `replaces_slug`.
7. Broadcast so the console updates live.

### Wiring that is easy to miss

- Add `"knowledge:draft"` to the `WsMessageType` union at
  `packages/shared/src/events.ts:86`. The union is exhaustive; a broadcast
  with an unlisted type will not typecheck.
- Add `propose_knowledge` to the Standup-tool regex at `server.ts:103`.
  That regex is what stops Phase 6's nudging from firing on Standup's own
  tool calls — omit it and a bootstrap run nudges itself.
- Add a `'bootstrap'` launch kind. `launches.kind` has a CHECK constraint
  (migration 004, `migrations.ts:157`) and SQLite cannot alter one in place,
  so this is a table recreation following the pattern of migration 005
  (`migrations.ts:169`). Update `LaunchKind` in `shared/src/types.ts`.

`cleanupLaunch` (`launcher.ts:469`) already refuses to `git worktree remove`
an `adopted` launch. A bootstrap launch *does* own a real worktree, so it
takes the normal cleanup path — confirm the new kind does not accidentally
fall into the adopted branch.

---

## Step 3 — The bootstrap launch

**Model: Sonnet.**

`POST /api/projects/:id/bootstrap-knowledge` reuses `launchSession`
(`launcher.ts:151`) wholesale, passing `kind: "bootstrap"` and the research
prompt as the task.

- **A real worktree, not the repo.** Research is read-only, so isolation is
  not the point — a stable sha is. A worktree pins HEAD for the duration of
  the run, so provenance means something even if you commit to the repo
  while the bootstrap is going.
- **Default to Opus at high effort.** This is judgment work: deciding what
  *not* to write is the entire task. Keep the composer's model/effort
  override available.
- **Append `CHECKPOINT_INSTRUCTION`** (`launcher.ts:34`) as normal, so the
  run narrates itself into the feed rather than going dark for ten minutes.
- **Explicitly triggered, never automatic.** A button on the project's
  Knowledge tab, per `high-level-design.md:326-330`. It shows in the launches
  list like any other launch and is stoppable with the existing controls.

The button needs honest cost copy — this runs an agent across a whole
repository. Something like *"Reads the repo and drafts ~6 knowledge docs for
review. Runs as a normal launch, so you can watch and stop it."*

---

## Step 4 — The research prompt

**Model: Opus.** `implementation.md:274-288` is blunt about why: everything
else in this phase is plumbing over components that already exist. The prompt
decides what gets written, and the failure mode is not a crash — it is a
knowledge base full of plausible, derivable, slowly-rotting summaries that
outrank real retrieval and quietly make answers worse.

Lives in `packages/collector/src/bootstrap-prompt.ts` as a template function
over the project. Draft below; expect to iterate against Step 7's numbers.

````text
You are writing the first draft of the knowledge base for {project.name}.

Standup keeps a small set of docs per project holding what an agent CANNOT
recover by searching the code. Agents already have `ripgrep` and `ask_expert`
over this repository. Anything those tools answer is not knowledge — it is
retrieval. Duplicating it here makes every future search worse: a generated
summary competes with the real file in ranking, and rots the moment the code
moves.

Your job is to write the part retrieval cannot cover, and to leave the rest
alone. Writing less is the harder skill here and the one being asked for.

## The test every line must pass

Before you write a sentence, ask: would an agent have to read MANY files to
infer this?

If a single `rg` answers it, delete it.

  Capture                              | Leave to retrieval
  -------------------------------------|------------------------------------
  How to build, test, lint, run         | Anything a grep answers directly
  Observed conventions — error handling,| File and directory listings
  naming, test layout                   |
  Architecture shape: what talks to what| Function signatures, API surface
  at module level                       |
  Gotchas from READMEs, TODOs, and      | Anything restated from a single
  comment warnings                      | file

## What you must not do

Do NOT write intent. You cannot know why this project exists, what it is
competing with, which parts are being sunset, or how it relates to other
projects. None of that is in the repository. A plausible-but-wrong intent
document is worse than an empty one, because it will be read as authoritative
and nobody will think to correct it.

If you catch yourself writing "this project aims to", "the goal of this is",
or "this was built because" — stop. You are inventing.

Do NOT summarize the README. If someone wanted the README they would read it.

Do NOT describe anything you have not verified. Run the build. Run the tests.
If a documented command fails, that failure is more valuable than the command
— write down what actually works.

## Deliverables

Call `propose_knowledge` once per document. Call `checkpoint` between
documents so the human can follow along.

1. `toolchain.md` — how to build, test, lint, and run. Commands you have
   actually executed, with anything surprising about them. If setup has a
   step that is easy to miss, that step is the most valuable line in the doc.

2. `architecture.md` — what talks to what, at module level only. The shape a
   newcomer needs before any individual file makes sense. No file listings,
   no function signatures.

3. `practices.md` — conventions you can demonstrate hold across MANY files.
   Error handling, naming, test layout, how new modules get wired in. For
   each convention, having read enough to be confident it is a convention and
   not one author's habit is the requirement. If you saw it three times, say
   so; if you saw it once, leave it out.

4. `gotchas.md` — the highest-value document. Mine READMEs, TODO and FIXME
   comments, comments that warn ("don't", "note that", "this must", "careful"),
   and commit messages describing fixes. You are looking for what would have
   saved the last agent an hour. Prefer one real trap to five true
   observations.

5. `overview.md` — A STUB. Do not write prose here. Write the questions only
   a human can answer, as a checklist for them to fill in. For example: what
   is this for, who uses it, what would break if it stopped, which parts are
   being sunset. You may note what the repository *appears* to do in one
   sentence clearly marked as an inference, and nothing more.

6. `connections.md` — A STUB, for the same reason. How this project relates
   to others is not in this repository. List what you found that HINTS at
   external relationships — service URLs, shared package names, API clients,
   deploy config referencing other systems — as questions, not conclusions.

## Rules

- Hard cap 40 lines per document. A long generated doc is more surface area
  to go stale and more noise in every future retrieval.
- Write for an agent that lands in this repo tomorrow knowing nothing.
- Prefer "X because Y" to "X". The reason is the part that is not greppable.
- If a document would have fewer than five worthwhile lines, propose it
  anyway with only those lines. Padding is worse than brevity.
- Do not modify any file in the repository. You are reading and reporting.
````

Two things this prompt is deliberately doing:

**`overview.md` and `connections.md` are stubs by construction, not by
instruction.** They are the two docs whose honest content is questions, so
the prompt makes producing questions the deliverable. An agent asked to "be
careful about intent" writes careful-sounding intent anyway; an agent asked
for a checklist writes a checklist.

**`gotchas.md` is named as the highest-value doc** because it is the one that
best passes the many-files test, and an agent left to its own priorities will
spend its effort on the architecture doc instead — that being the one that
feels most like real documentation and is most nearly derivable.

---

## Step 5 — Review UI

**Model: Sonnet.**

Extend `KnowledgePanel.tsx:50`. Drafts get a section above the doc list,
shown only when drafts exist.

Per draft: title, a provenance line (*generated from `43f6d2c`, 2 hours ago,
by this launch* — link to the launch), the rendered body via the existing
`Markdown` component, and three actions.

- **Accept** — moves the file, deletes the row, calls `syncProject()` so it
  is searchable immediately.
- **Edit** — opens the existing `DocEditor` (`KnowledgePanel.tsx:298`)
  pre-filled. Saving writes back to `.drafts/`; accepting stays a separate
  click, so editing is not an accidental approval.
- **Discard** — deletes file and row.

Plus **Accept all**, answering `implementation.md:298-299`'s open question
directly: per-document review is right, but it should not be the only path
for a first run producing six files. Per-doc buttons with an accept-all
escape hatch is cheaper to build than either alone and does not force a
choice now.

**Preview for new docs, diff only on regenerate.** The design says "diff
view" (`high-level-design.md:317`), but on a first bootstrap there is nothing
to diff against — `replaces_slug` is NULL and a diff against empty is just
the document. Render a preview then, and a real diff only when
`replaces_slug` is set. This is a refinement of the design, not a departure
from it: the point of the diff was making a wrong inference cheap to correct,
which a preview serves equally well when nothing is being replaced.

### API

```
GET    /api/projects/:id/knowledge/drafts
PUT    /api/projects/:id/knowledge/drafts/:slug          # edit before accepting
POST   /api/projects/:id/knowledge/drafts/:slug/accept
POST   /api/projects/:id/knowledge/drafts/:slug/discard
POST   /api/projects/:id/knowledge/drafts/accept-all
```

The project list at `server.ts:197` already counts knowledge docs per
project. Add a pending-draft count so the Projects view can badge a project
with unreviewed drafts — otherwise a bootstrap run that finishes while you
are elsewhere is invisible until you happen to open the tab.

---

## Step 6 — Staleness and regenerate

**Model: Sonnet.**

Only docs with a `generated_from_sha` are ever flagged. **A human-authored
doc has no sha and is never called stale** — they wrote it on purpose, and
second-guessing that is exactly the authority-spending the design warns
about.

Computed on demand when the Knowledge tab opens, not on a timer — it is two
git commands and nobody needs it while the tab is closed:

```bash
git rev-list --count <sha>..HEAD          # commits since generation
git diff --name-only <sha>..HEAD | wc -l  # files touched since
```

Start with the commit count alone and a threshold around 50, surfaced as
*"generated 214 commits ago — possibly outdated"* with a Regenerate button.
Resist making this clever before there is evidence about what actually
correlates with a doc going wrong. Show the number even below threshold; the
raw count is more useful than the judgment.

Regenerate starts a new bootstrap launch. Because accepted docs already exist,
every proposed draft gets `replaces_slug` set, so review renders as a diff —
which is the case the design's diff view was really for.

Handle the sha being unreachable (branch deleted, history rewritten,
`repos[0]` moved) by showing "generated from an unknown commit" rather than
erroring. A knowledge tab that fails to load because git is confused is a
worse outcome than a missing badge.

---

## Step 7 — Does bootstrapped knowledge actually help?

**Model: Opus.** `implementation.md:291-294` frames this as the phase's real
question, and it is a measurement, not an assumption.

Three separate things to measure, against the Step 0 baseline.

### A. Non-regression

Run the full eval before accepting any drafts, accept them, run it again.
The existing eight cases plus Step 0's additions must not regress — **most
importantly multi-hop, which must stay 4/4.** This is the direct test of the
design's central worry: does generated text outrank real retrieval?

**Both runs must be in the same embedding mode**, and say which. Text-only
tops out at 11/12 for a reason unrelated to bootstrapping (see Step 0's note),
so a before-run with embeddings and an after-run without would manufacture a
regression that is purely an artifact of the environment. Check
`knowledge_chunks` is populated before starting, not after being surprised.
This matters more here than anywhere else in the phase: bootstrapping adds
*six new docs* to embed, so the after-state depends on the provider actually
being configured and having run.

The Phase 5 lesson applies with force. `runbook.md:151-155`: the eval file
itself was in the searched corpus containing every test question verbatim,
and excluding `*.eval.ts` alone moved 6/8 → 7/8, revealing the real numbers
had been flattered throughout. Before trusting any number here, confirm the
drafts are genuinely not in the corpus: they live in `~/.config/standup/`
while `runRipgrep` searches the session cwd, so they should be out of reach
by construction — **but write a test that asserts it** rather than reasoning
about it, because this is precisely the class of mistake that already cost
this project a phase's worth of misleading results.

### B. New capability

Add eval cases whose answers should come *only* from bootstrapped material —
"what command runs the test suite?", "why is the SQLite file outside the
source tree?" — and check they fail before acceptance and pass after. A case
that passes in both states is measuring nothing and should be cut.

Give the eval a run label (`EVAL_LABEL` env var) so the two runs' output can
be diffed mechanically instead of by eye.

### C. Provenance weighting

`implementation.md:295-297` asks whether generated and human-authored
knowledge should be weighted differently at retrieval time, and answers
"probably yes — a human wrote theirs on purpose — but that is a claim to
test, not assume."

Make it testable: `SearchResult` (`search.ts:5`) gains `generated: boolean`,
and `expert.ts:198`'s knowledge score gains a provenance multiplier.

```ts
score: (1 + hit.score * 2) * (hit.generated ? GENERATED_PROVENANCE_WEIGHT : 1)
```

Run the eval at 1.0, 0.85, and 0.7. Ship the winner as a constant with the
measured numbers in the comment beside it — the same discipline
`expert.ts:34`'s relevance floor already follows, and for the same reason.

---

## Traps

Things that will silently not work, found while reading the code.

**Knowledge schema cannot go in `migrations.ts`.** `runMigrations` is called
inside `createStore` (`store.ts:16`), which `index.ts:28` runs before
`KnowledgeSync` constructs `KnowledgeStore` at `index.ts:50`. The `knowledge`
table is created by `ensureTables()`, not by a migration — so on a fresh
database, a migration doing `ALTER TABLE knowledge` executes when that table
does not yet exist and throws. All knowledge schema changes belong in
`ensureTables()` with PRAGMA-guarded column adds. Launch-table changes
(`kind`) do belong in `migrations.ts`, since `launches` is created there.

**`packages/mcp` does not hot-reload.** `runbook.md:14-19`: it is a
persistent subprocess spawned once per session. Adding `propose_knowledge`
requires a fresh Claude Code session to test at all. Everything else in this
phase hot-reloads through `bun --watch`.

**`WsMessageType` is a closed union.** New broadcast types need adding at
`events.ts:86` or they will not typecheck.

**Test through the UI.** `runbook.md:221-225`: a green `curl` does not mean
the feed renders. The `ended_at IS NULL` bug passed every backend check
because those all queried by explicit id. The draft-count badge and the
review list are both UI-only paths.

**Empty string is not NULL.** `runbook.md:203-207`. `generated_from_sha`
must be NULL for human-authored docs, not `""` — Step 6 keys "is this
generated" off exactly that distinction, and an empty string would flag every
hand-written doc as stale.

---

## Sequencing

Step 0 gates everything. Steps 1–3 are independent plumbing and can go in any
order. Step 4 can be drafted in parallel but cannot be evaluated until 1–3
land. Steps 5–6 need drafts to exist. Step 7 needs all of it.

| Step | Model | Depends on |
|---|---|---|
| 0 — Close the ranking gap | **Opus** | — |
| 1 — Draft storage | Sonnet | — |
| 2 — `propose_knowledge` | Sonnet | 1 |
| 3 — Bootstrap launch | Sonnet | 2 |
| 4 — The research prompt | **Opus** | 3 to test, not to write |
| 5 — Review UI | Sonnet | 1 |
| 6 — Staleness / regenerate | Sonnet | 5 |
| 7 — Eval | **Opus** | 0, all |

The first genuinely informative moment is the end of Step 4: a real bootstrap
run against this repository, reviewed by hand. Read those six documents and
ask whether you would have wanted them. That judgment arrives before Step 7's
numbers and is worth more for deciding whether the prompt is close.

---

## Left open deliberately

- **Which repo gets bootstrapped when a project has several.**
  `projects.toml` allows `repos = [...]` and `launchSession` uses `repos[0]`
  (`launcher.ts:161`). For a microservice fleet behind one project, one
  bootstrap over one repo is the wrong shape, but the right shape is unclear
  until it is a real problem. Start with `repos[0]` and note the limitation
  in the UI.
- **Whether a bootstrap should ever run unattended.** Currently no, per the
  design's cost argument. If Step 7 shows a large improvement, offering it on
  project creation becomes tempting — revisit then, with numbers.
- **Whether `gotchas.md` should feed Phase 6's nudging.** A known trap and an
  agent about to walk into it is a natural pairing, and both halves now
  exist. Out of scope here; worth writing down before it is forgotten.
