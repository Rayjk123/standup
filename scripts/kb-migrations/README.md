# Knowledge-data migrations

Scripts that rewrite knowledge data that already exists: rows in a `standup.db`
and, with `--knowledge-dir`, the markdown files those rows are indexed from. The
convention lives in `runner.ts`; every migration is listed in `index.ts`.

```
bun run scripts/kb-migrations/run.ts --db <copy.db> [--knowledge-dir <dir>] [--only <id,...>] \
  [--host-user <alias>] [--plan-dir <project>=<repo>/plan]... [--summary]          # dry run
bun run scripts/kb-migrations/run.ts --db <copy.db> ... --apply [--backup-dir <dir>]   # apply
bun run scripts/kb-migrations/run.ts --rollback <backup-dir> [--db <path>] [--knowledge-dir <dir>]
```

## Guarantees

- **A dry run is the default.** It prints the host user personal-layer docs are
  re-owned by (and where that alias came from), then every change each step
  would make, one line each: the target (`db` or `file`), the ref
  (`<project>/<slug>`, plus `#<chunk id>` for a chunk or vec row, or
  `schema:<table>`), the field (a `knowledge` column, `fts.<col>`,
  `chunk.<col>`, `vec.<col>`, a whole `row`/`fts`/`chunk`/`vec` row, or for a
  file a front-matter key, `body` or `file`), and either `before → after` (for
  metadata), `delete`/`insert`, `rewrite` (text replaced, value not shown), or
  `redact [start,end) <rule>, …` (offsets into the old text and the rule's
  name — never the redacted value). `--summary` prints only the counts. It
  opens the DB read-only and runs on a scratch copy of the DB and of the
  knowledge dir in a private temp dir (`--scratch-dir <dir>` puts them
  elsewhere; the DB copy is as large as the DB), applying each step there so a
  later step plans against the files and rows an earlier one rewrites, and
  writes nothing else.
- **Memory stays flat however large the DB is.** Every DB copy (the scratch
  copy, the backup) is a `VACUUM INTO` through a read-only connection, a
  rollback is an `INSERT … SELECT` from the attached backup, and snapshots
  iterate the knowledge tables a row at a time; nothing reads the DB file or a
  non-knowledge table (transcript events, sessions…) into memory.
  `large-db.test.ts` runs the CLI on a 400 MB DB under a 200 MB peak-RSS cap.
- **The schema upgrade is a reported step.** `000-schema-upgrade` is what the
  collector's start does to an older DB's knowledge tables — constructing a
  `KnowledgeStore` (added columns, an FTS index rebuilt on the current schema,
  orphan chunks healed) and giving `knowledge_changes` its `personal` /
  `owner_user` columns (store migration 053) — listed as the diff it makes. Every migration plans against the upgraded schema, and each
  later migration against the state the earlier ones leave, exactly as an apply
  will see it.
- **An apply makes exactly the plan.** Migrations write with raw SQL (no
  `KnowledgeStore` side effects) and splice text: only the named front-matter
  keys' lines and a redacted body change, so YAML comments, date formats
  (`last_verified_at: 2026-08-16`), flow lists and block scalars stay byte for
  byte. A delete lists every row it cascades to (chunks, their vec rows, FTS).
  `--apply` re-runs every step on the real DB and refuses any step whose plan
  differs from the dry run's. `kb-migrations.test.ts` diffs every knowledge
  table and every file after an apply against the dry run and fails on any
  unplanned change.
- **`--apply` backs up first.** Before anything is written the runner copies
  the DB and every knowledge file the run will write or delete into the backup
  dir, with a `manifest.json` recording which files existed, their mtimes and a
  `status`. The default backup dir is `<db dir>/kb-migration-backups/<timestamp>`;
  the path is printed as `backup:` under each applied step.
- **A failed apply restores itself.** On any error the runner restores the
  backup, sets the manifest's `status` to `rolled-back` (or `failed` if the
  restore itself failed, with the error recorded), prints the backup dir and,
  if the restore failed, the `--rollback` command, and exits 1. While an apply is
  in progress a `<db>.kb-migration-pending` marker names its backup; a new
  `--apply` on that DB is refused until the apply completes or that backup is
  rolled back, so a re-run never backs up a half-migrated state.
- **`--rollback <backup-dir>` restores it**: the knowledge tables of the DB
  (`knowledge`, its FTS index, chunks, the vec mirror, edges, graph meta,
  drafts, the judgment ledger, the fact-check and freshness state, code
  symbols, and the change feed's `knowledge_changes` — schema, indexes, rows
  and rowids), leaving every other
  table (sessions, launches, persona state…) as it is now; and each backed-up
  file byte-for-byte with its old mtime, or deleted when it did not exist
  before. It refuses while another process (the collector) has the DB open.
  `kb-migrations.test.ts` proves apply → rollback returns every table row-equal
  and every knowledge file byte-equal.
- **Files first, then the DB in one transaction.** With a knowledge dir, file
  work is derived from the files themselves, so a DB-only run or a crash between
  phases never hides it; a re-run converges. A second apply plans nothing.
- **Live targets are refused** — `~/.local/share/standup/standup.db` (and its
  `-wal`/`-shm`), `~/.config/standup/knowledge`, and whatever `DB_PATH` /
  `KNOWLEDGE_DIR` name — by path, symlink or hardlink (same dev+inode), unless
  `--i-know-this-is-live`. Run against copies.
- **The host user** defaults to the collector's resolver (`$STANDUP_HOST_USER`,
  else `$USER`, else `local`). A collector run by a service manager without
  `$USER` resolves `local`; pass `--host-user`, or set `STANDUP_HOST_USER` for
  both, so re-owned docs land with the alias the collector serves them to.
- **Opt-in migrations** (`003`, `005`, `009`) appear in a dry run but are applied only when
  named in `--only`. `bun run eval:kb --migrate` applies the default set only.

## Migrations

### 001-personal-layer

What: re-scopes the home `~/.claude` CLAUDE.md / rules mirrors homed in
`global/` (`native-mem-home-*`) to `scope: user` owned by the host user, with
their vec mirror rows; deletes stale home-mirror copies homed in any other
project — only a copy whose file carries the `native_memory_from` marker (file,
row, chunks, vec and FTS rows), or a row whose file is gone; a curated copy is
kept, and DB-only mode, which cannot see the marker, deletes none; re-redacts
the title, body, FTS row and chunk texts of every doc with the shared redactor
at the tier the doc's placement calls for — the stricter of its row's and its
file's placements, applied to both. The signature tier (every doc) removes
only high-precision secret formats: provider tokens, AWS access keys and
labelled or paired secret keys, JWTs, private key blocks, URL and
connection-string passwords, Azure account keys, `curl -u` and Authorization
headers. The full tier (personal layer and `scope: global` / global-corpus
docs only) adds credential-named assignments, prose passwords and AWS account
ids in account context (ARN, ECR registry host, `account`/`account is`/
`account number`/`acct`/`aws_account_id`/`--account`/`AccountId`/`OwnerId`
labels, or `STANDUP_PERSONAL_ACCOUNT_IDS`). Project-scoped team docs keep their
account ids and credential-shaped team data.

Why: the home config is the host user's personal profile and must not reach
shared retrieval; secrets must not sit in a corpus that is searched across
projects, injected into agents and sent to an embedding endpoint.

### 002-source-kind-relabel

What: docs the project-docs ingest mirrored from a repo `plan/` dir become
`source_kind: spec` (their files also gain `origin_class: owner` when unset);
docs whose file asserts no `source_kind` and whose row reads `code` become
`unclassified`. DB-only, a row is relabeled spec only when it carries the
ingest's legacy stamps AND its body equals the body the ingest renders from the
plan file of the same basename; the unclassified relabel needs the files and is
skipped.

Why: plan docs and unlabeled docs were being injected as verified code facts.

Sample result on one snapshot copy (DB-only, `--plan-dir <project>=packages/knowledge/eval/local/repo/plan`
for each project whose repo holds a `plan/` dir): `toSpec=<n> toUnclassified=0`, with a row that
shares a plan file's name but not its content left alone.

### 003-demote-scratch-globals (opt-in)

What: agent-written (`origin_class: agent`) `scope: global` docs homed in the
`scratch` project become `scope: project`.

Why: scratch is where unmatched sessions land, so these are unanchored agent
claims reaching every project's search and launch injection with no project to own
them. Whether to demote them is an owner decision; apply only with
`--only 003-demote-scratch-globals`.

Sample result on one snapshot copy: `demoted=<n>`. Run it after 001 if at all — 001
redacts the account ids those docs carry while they are still global.

### 004-collapse-identical-duplicates

What: docs whose bodies are identical (whitespace aside) and that reach a common
audience — homed in the same project, or either is `scope: global` / homed in
`global`; a `scope: user` doc only with docs of the same owner — are collapsed
to one canonical doc: owner-written over agent-written, then the older
(`generated_at`, else `updated_at`), then the shorter slug, then `project/slug`.
Every other member is retired: verdict `superseded` with a `Superseded by
<winner>` tombstone (findings a `disputed`/`contradicted` doc carried are kept
ahead of it) and confidence 0.1, in the DB and, with a knowledge dir, the
file's `confidence` line. Rows, files, chunks and bodies stay; editing the doc
revives it.

Why: byte copies spend several result slots on one fact and split its
retrieval and verification history.

Sample result on one snapshot copy: `groups=0 superseded=0` — the snapshot's
identical-body pairs are all `standup` vs `standup-self`, two project-scoped
corpora that no agent retrieves together (005 handles them).

### 005-retire-standup-self (opt-in)

What: each `standup-self` doc with a same-slug `standup` doc whose body is
identical (whitespace aside) or lexically near-identical (`isLexicalNearDup`
over title + body) is retired in favor of `standup/<slug>`, exactly as 004
retires a copy. Copies without such a counterpart are kept and listed in the
notes. Apply only with `--only 005-retire-standup-self`.

Why: `standup-self` is a frozen copy of `standup` that is never refreshed and
already diverges from it. Retiring the copy project is an owner decision.

Sample result on one snapshot copy: `superseded=<n> kept=0`.

### 006-unverified-confidence

What: agent docs (`origin_class: agent`) whose file holds confidence 1 with no
`clean` verdict and a `last_verified_at` that is unset or within two minutes of
`generated_at` (the stamp the propose route used to write at publish time)
drop to confidence 0.6 with `last_verified_at` removed — the file's lines are
spliced and the rows of exactly those files updated to match (a retired
`superseded` doc is left to 004/005). Needs `--knowledge-dir`: confidence lives
in the files, the next sync rewrites a row from its file, and the publish
fact-check reads "pending" off the file, so a DB-only run changes nothing and
says so.

Why: auto-published proposals were stamped as fully verified when nothing had
checked them; 0.6 with no verification stamp is what a proposal is published
at now, and only a passing fact-check raises it.

Sample result on one snapshot copy (DB-only): `downgraded=0`, with the note that it
needs `--knowledge-dir`.

### 007-rejudge-contradicted

What: every `contradicted` doc with no successful judgment (`knowledge_judgments`
outcome `contradicts`/`consistent` naming it) keeps its verdict and gets a
`queued` judgment row, which takes it out of the nightly sweep's cooldown so it
is judged again. Where both docs of a pair carry the `Contradicts` edge to each
other — the old judge flagged both sides — the loser rule the judge applies now
(`chooseLoser`: a fact-disputed doc below a clean one, agent below owner,
unverified below verified, lower confidence, older) picks the side that stays
flagged, and the winner's edge to it is removed (its verdict recomputed from
what it still carries). A pair the rule cannot separate stays as it is.
DB-only, with or without a knowledge dir.

Why: the old judge read every failure (exit codes, model-access 403s, timeouts) as
"no contradiction" — so it missed contradictions but never invented one — yet it
hid both sides of each pair it confirmed and recorded no outcome. The findings
are kept; only the winner of each pair is shown again, and every one is judged
again.

Sample result on one snapshot copy: `queued=<n> winnersCleared=<m>`.

### 009-stamp-persona-memories (opt-in)

What: sets `writer_stamp` to Persona's stamp on the host user's existing
`persona-…` docs that carry the `persona` tag, `scope: user` owned by the host
user, `origin_class: agent`, no source session and a kind other than
`native-memory`. DB-only.

Why: the owner profile and worker briefs trust a memory only when its writer
stamp says Persona wrote it as it stands, and memories saved before the column
existed carry none, so they are left out until Persona saves them again. None
of those properties proves who wrote a doc, so stamping them is an owner
decision: review the dry run's list, then apply only with
`--only 009-stamp-persona-memories`.

Sample result on one snapshot copy: `stamped=0 refused=0` — the snapshot holds no
`persona-…` memory.

### 010-classify-knowledge-changes

What: every `knowledge_changes` row whose doc is in the personal layer now —
`scope: user`, or a home CLAUDE.md / rules mirror (`native-memory` kind,
`native-mem-home-*` slug) — is set `personal = 1`, and given the doc's owner
when it records none (a home mirror with no owner stamp: the host user). Rows
already classified with an owner, rows of shared docs and rows whose doc is
gone are left alone. Runs after 001, so the home mirrors 001 re-scopes are
classified with their new owner. DB-only.

Why: a change row written before the columns existed is shown only to the
owner of its doc while the doc is indexed (the reader joins the knowledge
table), but once that doc is deleted nothing marks the row personal and its
title reaches every viewer and the shared digest. Writing the classification
while the docs exist closes that for every existing row; new rows are written
classified.

Sample result on one snapshot copy: `classified=0 unowned=0` — none of the
snapshot's change rows (`accepted` and `contradiction` alike) is about a
personal-layer doc. On a live DB the count is the change rows of the owner's
`scope: user` docs and home mirrors.

## Snapshot procedure

On a copy of `packages/knowledge/eval/local/snapshot.db`, DB-only, with
`--host-user <alias>` and `--plan-dir <project>=packages/knowledge/eval/local/repo/plan`
for each project whose repo holds a `plan/` dir:

```
cp packages/knowledge/eval/local/snapshot.db /tmp/kb-mig/snapshot.db
bun run scripts/kb-migrations/run.ts --db /tmp/kb-mig/snapshot.db --host-user <alias> --plan-dir … --summary   # review
bun run scripts/kb-migrations/run.ts --db /tmp/kb-mig/snapshot.db … --apply --backup-dir /tmp/kb-mig/backup
bun run scripts/kb-migrations/run.ts --rollback /tmp/kb-mig/backup
```

The sample results in this README show the shape of the output, with `<n>`
standing for a count that depends on the install's data; a zero is shown where
the migration had nothing to do. The guarantees (apply matches the dry run, a second dry run plans
nothing, a rollback restores every table) hold on any snapshot and are what
`kb-migrations.test.ts` enforces.

Sample dry run (and apply, which matches it change for change; the runner
refuses any step whose apply plans differently from the dry run). After the
rollback every table is row-equal to the original, rowids and DDL included;
only the FTS index's internal shadow tables (`knowledge_fts_data`/`_idx`) are
rebuilt byte-differently, with the FTS rows themselves equal:

```
000-schema-upgrade dry-run tables=8 rowsInserted=0 rowsDeleted=<n> fieldsChanged=<n>
001-personal-layer dry-run rescoped=<n> staleDeleted=0 redactedDocs=<n> redactions=<n> redactedChunks=<n> chunkRedactions=<n>
002-source-kind-relabel dry-run toSpec=<n> toUnclassified=0
003-demote-scratch-globals dry-run demoted=<n>        (opt-in; not applied without --only)
004-collapse-identical-duplicates no changes groups=0 superseded=0
005-retire-standup-self dry-run superseded=<n> kept=0 (opt-in; not applied without --only)
006-unverified-confidence no changes downgraded=0  (needs --knowledge-dir)
007-rejudge-contradicted dry-run queued=<n> winnersCleared=<n>
009-stamp-persona-memories no changes stamped=0 refused=0 (opt-in; not applied without --only)
010-classify-knowledge-changes no changes classified=0 unowned=0
```

The default apply (001, 002, 004, 006, 007, 010), an apply of every migration
(the opt-ins 003, 005 and 009 included: every planned DB change after the
schema step is matched by the diff the apply makes) and an `--only` apply of 004–007
(005 included; without 001, 004 then collapses the identical home-mirror
copies) both match their dry runs; a second dry run
after either plans nothing, and a rollback of either leaves every knowledge
table row-equal to the original (a full knowledge-table diff reports 0 changes).

- `000`: the FTS table gains its `slug` column (duplicate FTS rows dropped,
  FTS fields rewritten), `knowledge_chunks` gains `chunker_version`,
  `knowledge_graph_meta` gains `vector_search_suspended` (and its
  `chunk_generation` advances), `code_symbols`, `knowledge_judgments` and
  `knowledge_verifications` are created, `knowledge` gains the content-clock columns `content_hash` and
  `content_first_seen` (the latter backfilled from `generated_at`, else
  `updated_at`) and `writer_stamp`, `knowledge_changes` gains `personal` and
  `owner_user` (NULL on every existing row until 010), and orphan chunks
  are deleted.
- `001`: the `global/native-mem-home-*` mirrors are re-scoped (and their
  vec rows re-keyed); the copies outside `global` are kept (DB-only cannot see
  the marker) and, as personal-layer docs, redacted. Every redaction is an
  account id in the personal layer or a `scope: global` doc (ARNs and labeled
  ids); none is in a project-scoped doc. Neither tier finds a secret span in
  any of the snapshot's docs (the full tier was also run over every doc,
  project-scoped ones included: 0 spans besides account ids).
- `002`: the plan mirrors become `spec`; a row that shares a plan file's name
  but not its content is left alone.
