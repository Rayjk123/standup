# Knowledge system — layers, eval and gate

This note describes how Standup's knowledge layer is organized, how its retrieval quality is measured, and the
regression gate that every change to ranking, scoping or injection must pass. Knowledge is consulted through
`search_knowledge`, `get_knowledge_doc` and `graph_neighbors`; Persona uses `recall`.

## Layers

| Layer | Source of truth | Retrieval | Delivery | Trust / privacy |
|---|---|---|---|---|
| Docs (decision, runbook, code facts, unclassified) | KB docs | Hybrid FTS (porter stemming, slug column) + vectors, calibrated relevance floor, graph rerank off | search / gated injection | Evidence-based confidence, fail-closed judge, dedup across the audience |
| Intent (product, spec) | Per-project spec docs; plan ingests are `spec` | Same, **same-project only** | Launch "product context" block with the floor | Never auto-global; a scope=global proposal from `scratch` is refused |
| Code (live) | The repo at HEAD | `code_symbols` (indexed from HEAD blobs in the background) + code search (rg → git grep → JS walker in a terminable Worker) | Code search serves the `ripgrep` tool and the eval, which reports `codeSearch` status | Allow-list of registered repo roots and launched worktrees; credential, home and system paths refused |
| Personal | Home CLAUDE.md and rules (scope=user), Persona memories (writer-stamped) | Unranked owner profile | Persona's system prompt every turn; the worker-brief block carries only stamp-verified memories | Excluded from every shared surface, writable only via Persona's remember/forget, two-tier redaction |
| Activity | Auto-memory diaries | Ranked, decays with a 14-day half-life | search marked `[activity <date>]`; never injected | Project scope |

### Index integrity

- `upsertDoc` uses the stored id, and chunk sets match the chunker exactly, so FTS rows and chunks never orphan.
- The FTS table uses the porter tokenizer and a slug column, with self-heal and an integrity check.
- Stopwords are dropped from queries; names in quotes or `project/slug` form short-circuit to that doc.
- A markdown-aware chunker adds a `title › section` prefix to each chunk.
- The embedding fingerprint carries the model digest and chunker version and is checked by a boot canary.
- Re-indexing runs in the background after the server listens and never wipes the index when the provider is down.

### Scoping and privacy

- Every doc has a layer (`layerOf`); `unclassified` is the default source kind.
- Home CLAUDE.md mirrors are scope=user for the host user. Personal and activity layers are excluded from shared
  surfaces.
- "global" means `scope='global'` everywhere.
- Product and spec injection is same-project only.
- Redaction has two tiers:
  - **signature** (high-precision formats) on all content;
  - **full** (credential assignments, prose passwords, labelled account ids) on personal and scope=global content.
- Personal-layer containment is the primary control; the redactor is defense in depth.
- Personal content is withheld from distilled drafts and from shared `propose_knowledge` bodies.

### Ranking and gates

- Relevance is batch-independent, calibrated per corpus at index time and stored with the fingerprint.
- One shared confidence floor applies (search 0.18, injection 0.20); search returns "No confident match" when
  nothing clears it, and a launch with nothing confidently relevant gets no injected docs.
- Graph rerank is off by default.
- Contradictions resolve deterministically: settled state, then the day last affirmed, then confidence, then the day
  written. A same-day pair is undecided, and both sides are shown with a conflict marker. Authorship never breaks a
  same-day tie.

### Personal layer

- Persona gets the owner profile in its prompt every turn, and worker briefs get a preferences block.
- Memories are verbatim and topic-keyed, with replace-on-save; `forget` marks a memory superseded, so it is
  recoverable.
- Persona saves only the owner's own words: reported speech, pasted text, quotes, blockquotes and code fences never
  count.
- Trust comes from a DB-only `writer_stamp` that only Persona's secret-bearing write sets. Every other route refuses
  personal-layer writes. File-asserted feedback appears in Persona's profile labelled "unverified" and never reaches
  briefs.

### Write path

- Agent proposals publish at confidence 0.6, and a background fact-check raises or disputes them.
- Dedup covers the caller's whole audience; it never rewrites a different slug and never deletes a draft.
- A correction to another session's doc becomes a review draft that replaces it.
- The contradiction judge fails closed, with retries and a ledger, and marks only the loser.
- Git repo-state claims are checked against the default branch and are informational only.

### Staleness

- A deterministic, git-based evidence pass runs by default: missing paths and symbols, file drift, unmerged shas
  (squash- and cherry-pick-aware), contradicted-by-newer.
- A model-based re-verify pass is opt-in, because it is a recurring cost.
- Confidence (base, as-of date, half-life) is derived on read; status-like docs get a 14-day half-life.
- The decay clock is a content hash plus first-seen time.
- A decayed doc is gated out of injection only where a per-doc recovery path exists; otherwise it is demoted and
  marked "stale since …".

### Observability

- `knowledge_retrievals` records per-component scores, `algo_version`, layer and scope, and a `drop_reason` for each
  gated candidate.
- `get_knowledge_doc` calls are logged, and injection rows can receive outcomes.
- Personal slugs are kept out of usage, changes, WebSocket frames, the digest, bundles and the Slack feed.
- `ALGO_VERSION` is pinned to a fingerprint of the ranking constants.

## The eval

- **Run it:**
  - `bun run eval:kb` runs the fixture tier. It is deterministic and takes seconds.
  - `--gate` compares against `packages/knowledge/eval/accepted.json` and also runs inside `bun test`.
  - `--snapshot [--migrate]` runs the real-corpus tier against a temp copy of your own `standup.db`, with the data
    migrations optionally applied to the copy.
  - `--llm` runs the synthesis tier, which is reported separately and never gated.
  - `--harvest <db-copy>` grows the case set from logged queries.
- **Data and format:** `packages/knowledge/eval/` holds `FORMAT.md` (the contract), the corpus, `fixture-repo`,
  `cases/*.json`, `cases.lock`, `embeddings/`, `baseline.json`, `accepted.json` and `history/`. The runner is in
  `packages/collector/src/kbeval/`.
- **Two tiers:**
  - The fixture tier is a synthetic multi-project corpus with edit histories, plus a fixture source repo that the
    eval pins into a temp git repo with deterministic history.
  - The snapshot tier runs against a copy of a real store. Its labels live under `packages/knowledge/eval/local/`,
    which is gitignored, so no real knowledge-base content is committed.
- **Cases:**
  - Categories: docs, code, personal, leakage, off-topic, staleness, inject.
  - Labels are frozen before tuning (`cases.lock`).
  - About 20% are held out by a hash of the case id. Tune on the dev split only; holdout is reported separately.
- **Surfaces:**
  - search_knowledge and launch injection.
  - Persona has two surfaces. `persona` is the set of docs in its system prompt plus the worker-brief block, scored
    with set metrics. `persona-recall` is its ranked recall tool.
- **Metrics:**
  - Ranking: R@5, MRR@10, nDCG@10, P@5.
  - Negatives: empty-rate.
  - Leakage, two ways: per-case `forbidden` globs, and a policy check computed from doc metadata. Policy rules:
    owner mirror on a shared surface, another user's doc, another project's doc, another project's product doc
    injected.
  - Citation precision, injection precision, code-hit rate.
  - Staleness: fresh-over-stale, stale-flag, stale-hit.
  - Index integrity.
  - Code-search backend and status per case.

## The gate

A change fails the gate if:

- a ranking metric or citation precision drops by more than 0.02;
- negative empty-rate drops by more than 0.03;
- leakage increases at all;
- an integrity count increases;
- persona context set metrics drop by more than 0.02;
- an embedding misses the cache;
- a code-search case fails;
- the `cases.lock` hash changes.

`accepted.json` can record a named exception: the gate ignores a violation only when that one case fully explains it,
and fails if the case gets any worse. A label is never edited to make the gate pass.

## Data migrations

Changes that rewrite existing knowledge data ship as runnable migrations under `scripts/kb-migrations/`, not as boot
side effects.

- **Runner:** `bun run scripts/kb-migrations/run.ts --db <path> [--knowledge-dir <dir>] [--only <ids>] --host-user <user> [--summary]`.
- **Modes:** a dry run is the default and prints every planned row and span change; secrets are never printed.
  `--apply` writes, and `--rollback <backup-dir>` restores.
- **Safeguards:**
  - Apply backs up the DB and every touched file first, and re-plans each step, refusing any step whose plan changed.
  - A failure rolls back automatically, and a pending marker blocks another apply over an incomplete backup.
  - The runner refuses the running install's DB and knowledge dir (the defaults under HOME and whatever `DB_PATH` /
    `KNOWLEDGE_DIR` name, by path, symlink or hard link) unless given `--i-know-this-is-live`, and both apply and
    rollback refuse while another process holds the DB.

| id | what it changes | default / opt-in |
|---|---|---|
| 001-personal-layer | Re-scope `global/native-mem-home-*` to scope=user for the host user; delete stale home-mirror copies; two-tier redaction | default |
| 002-source-kind-relabel | Plan-dir mirrors → `spec`; unlabelled → `unclassified` (needs `--knowledge-dir`) | default |
| 003-demote-scratch-globals | Agent-written scope=global docs homed in `scratch` → project scope | opt-in |
| 004-collapse-identical-duplicates | Retire all but the canonical one of identical-body docs that reach a common audience | default |
| 005-retire-standup-self | Retire `standup-self` copies in favour of `standup/<slug>` | opt-in |
| 006-unverified-confidence | Unverified agent docs stamped confidence 1 → 0.6 (needs `--knowledge-dir`) | default |
| 007-rejudge-contradicted | Queue every unjudged contradicted doc for re-judging; un-hide the winner of each mutually flagged pair | default |
| 009-stamp-persona-memories | Writer-stamp the host user's existing Persona memories that match the earlier trust rule | opt-in |
| 010-classify-knowledge-changes | Mark change-feed rows for personal docs as personal and owned (run before deleting any personal doc) | default |

**Suggested procedure:**
1. Stop the collector.
2. Back up `standup.db` (with -wal and -shm) and `~/.config/standup/knowledge`.
3. Dry-run with `--knowledge-dir` and review the plan.
4. Apply on a copy and run `bun run eval:kb --snapshot <copy>`.
5. Apply on the real store.

## Known limits

- Some off-domain hard negatives clear the relevance floor; no single floor separates them without losing real
  answers.
- Personal-layer edge cases fail safe: an owner line using a display name ("Alice: …"), "Just so you know, going
  forward…" and "Team rule from now on:" go to an approval card rather than saving directly.
- Owner feedback and auto-memory notes are trusted by origin from files, so any process running as the same OS user
  can write them; they are labelled unverified and never reach briefs.
- The writer stamp is an unkeyed sha256, so a same-user process with DB access could forge it.
- Redactor gaps (recorded as `test.todo`): XML element and attribute forms, URL-encoded JSON, netrc, api_keys under
  20 characters, and UUID-shaped API keys in heuristic positions.
- A proposal at a personal-layer slug gets a different answer than one at a free slug, which reveals that the slug is
  taken.
- The content clock lives only in the DB, so a full rebuild resets it to file times. The evidence pass reads the
  checkout's HEAD, not the default branch.
