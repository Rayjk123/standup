---
title: Standup product gap analysis
ingested_from: "plan/product-gap-analysis.md"
generated_at: "2026-09-10T10:00:00Z"
tags: [planning, gaps, roadmap, knowledge, persona, console]
---
# Standup product gap analysis

This document is the running gap analysis for Standup as a product: the agent session console, the collector, the
MCP surface agents talk to, the knowledge base, ask_expert, launch-time knowledge injection, the Slack mirror, and
Persona. It is deliberately broad. Each numbered section follows the same shape: **Gap** (what is missing or weak
today), **Impact** (who notices and how badly), and **Recommendation** (what we would do about it, roughly sized).
Sections are ordered loosely by the area of the product they touch, not by priority. A separate prioritization pass
lives at the end.

The analysis was assembled from three inputs: a walk through the console as a new user, a read of the collector and
MCP server code paths, and a review of a few weeks of agent transcripts where sessions used (or ignored) the knowledge
tools. Where a claim depends on a specific state of the code at the time of writing, it is called out, because several
of these areas are moving quickly and parts of this doc will age.

---

## 1. Score blending in knowledge search

**Gap.** Knowledge search combines two arms, a full-text arm over SQLite FTS5 and a semantic arm over chunk
embeddings. Historically the two were combined with a weighted sum of normalized scores. The bm25 values from FTS and
the cosine similarities from the vector arm live on very different scales, and normalizing each arm to its own best hit
in the batch means the arms are only comparable in a loose sense. A query with one strong lexical hit and weak semantic
hits ends up with the lexical arm dominating the final order regardless of how good the hit actually is.

**Impact.** Ranking quality varies a lot by query shape. Short keyword queries behave reasonably. Longer natural
language questions, which is what agents actually send, get noisy top results. The score shown to agents is also hard
to interpret because it is a blend of two normalized numbers.

**Recommendation.** Move to a rank-based blending method so the arms only need to agree on order, not on scale.
RRF (reciprocal rank scoring) is the obvious candidate and is cheap to implement. Keep per-arm weights as tunable
constants and expose an override through the environment for experiments. Record which blending was used in telemetry so score
history before and after the switch can be told apart; the score scale will change completely.

## 2. Embedding provider and where embeddings are computed

**Gap.** Embeddings are produced by a locally running model server. That keeps everything on the host and avoids per
call cost, but it also means the quality of semantic recall is tied to whatever model happens to be pulled locally, and
there is no record per chunk of which model produced its vector. Hosted embedding providers were considered and set
aside for now; they would add network dependence and a second credential to manage, and their query versus document
task types are easy to misuse.

**Impact.** If the local model is re-pulled or updated, older vectors and newer vectors may quietly disagree. Nothing
in the stats page would show it; the corpus would still report as fully embedded.

**Recommendation.** Store an identifier of the embedding model alongside each chunk, and make the embedding
fingerprint more specific than provider plus model name. Add a health check that compares a fresh embedding of a known
text against the stored one. Keep the hosted providers behind a config switch but do not enable them by default.

## 3. Vector search implementation

**Gap.** At the time of the first draft of this analysis, semantic search loaded every chunk vector into memory and ran
a linear cosine scan in JavaScript. A sqlite-vec based KNN path was sketched but dormant. With several thousand chunks
the scan is tolerable; with tens of thousands it is not.

**Impact.** Search latency grows linearly with corpus size, and the collector's memory footprint grows with it. Agents
that search several times per turn feel it.

**Recommendation.** Finish the sqlite-vec integration so KNN runs inside SQLite with an over-fetch factor and a parity
check against brute force. Keep the brute-force path as a fallback for environments where the extension cannot load.
(Note: there are conflicting reports on whether this has landed; check the store code before relying on either claim.)

## 4. Graph rerank

**Gap.** The knowledge graph links docs by shared tags, shared authoring session, contradiction, semantic similarity,
and explicit related links. A rerank step can use that graph to pull neighbors of strong hits upward. The experiment
showed small gains on synthetic bridge fixtures and roughly neutral results on the real corpus. As written here the
flag is off by default and the rerank is not enabled in production.

**Impact.** If enabled without care, large hub documents with many edges get promoted for queries they are only loosely
related to. This document itself is a likely hub.

**Recommendation.** Keep graph rerank opt-in until a labeled set of real queries shows a lift. Normalize for hubness
(in-degree) before applying any boost. Track how often rerank changes the top result and whether those changes are
improvements.

## 5. Lexical matching quality

**Gap.** The full-text index uses a plain unicode tokenizer with no stemming. Plurals and verb forms do not match their
roots, so a question about code reviews in the plural misses a doc that uses the singular abbreviation. Every word in
the query, including stopwords, is OR-joined into the match expression, so long questions match almost everything.
Slugs are not indexed, so an agent that knows a doc's exact slug cannot find it by typing the slug.

**Impact.** Recall gaps on exactly the queries people type most naturally, and noisy precision on long questions.

**Recommendation.** Switch the FTS tokenizer to a stemming variant, drop stopwords before building the match
expression, and add an exact-slug short-circuit that returns the named doc first.

## 6. Chunking

**Gap.** Chunks are produced by a sentence splitter targeting a fixed character size with a small word overlap. The
splitter does not understand markdown: headings get separated from their sections, code fences are split mid-block,
and no chunk carries the doc title or its section path. Very long docs produce hundreds of chunks.

**Impact.** Title-shaped queries underperform, and mega-docs collect a disproportionate share of top hits simply because
they have more chunks to match with.

**Recommendation.** Split on headings first, keep fences intact, prefix each chunk with "title > section", and apply a
per-doc chunk-count prior so long docs do not win by volume.

## 7. ask_expert retrieval and synthesis

**Gap.** ask_expert gathers context from a project search, a search of the reserved global corpus, and a keyword
search over the working directory, then hands the merged set to a small model for a synthesized answer with a Sources
list. The code-search arm depends on an external binary that is not always installed; when it is missing the arm fails
and the failure is only logged. The Sources list is the top of the retrieval cut rather than the set of docs the answer
actually cites.

**Impact.** Answers lean entirely on prose docs even for questions about code structure, and the Sources list overstates
how grounded an answer is. Off-topic questions still come back with a full Sources list.

**Recommendation.** Make the code arm fail loudly and report its status in the answer. Reserve slots for code results.
Validate citations against the labels actually used in the answer and return cited and retrieved separately. Gate on a
relevance score that is not normalized per batch.

## 8. Relevance floors across surfaces

**Gap.** ask_expert has a numeric relevance floor, but it is applied to a score that is normalized to the best hit in
the batch, so the top lexical hit in any partition always clears it. Launch-time injection has no floor at all.
search_knowledge always returns results, even for questions the corpus knows nothing about.

**Impact.** "No confident match" is never an answer. Agents learn that the knowledge base always has something to say,
and the irrelevant results crowd their context.

**Recommendation.** Calibrate a single relevance floor on an un-normalized score and apply it to search, ask_expert and
injection. Return an explicit empty result when nothing clears it.

## 9. Launch-time knowledge injection

**Gap.** When the console launches a session, it prepends a block of relevant knowledge to the agent's first prompt.
The injection retrieves by kind: code-flavored docs in one block and product or spec docs in another (this split was
described as planned in earlier notes; check the launcher). It over-fetches and keeps the top few after origin,
verdict and confidence gates. There is no relevance floor and no restriction to the launching project for product docs.

**Impact.** Product docs from unrelated projects that happen to be marked global end up injected into launches that have
nothing to do with them, under a banner that tells the agent to ground its implementation in them.

**Recommendation.** Restrict product and spec injection to the audience project or to docs explicitly linked to it,
add a floor, and log every candidate that was dropped and why.

## 10. Source kind labeling

**Gap.** Every doc carries a source kind (code, product, spec, decision, runbook, native memory). Docs that do not
declare one default to code. Design and plan documents mirrored from the repository's plan directory never set a kind,
so they are all labeled code.

**Impact.** Plans and early designs are presented to agents as if they described the code as it is. Stale plans beat
the live code in answers.

**Recommendation.** Stamp plan ingests as spec, introduce an unclassified default that is excluded from the code block,
and relabel the existing unlabeled docs.

## 11. Native memory mirroring

**Gap.** The collector mirrors Claude Code's native memory files (the home CLAUDE.md, rules files, and per-project
auto-memory notes) into the knowledge corpus so they become searchable. Home-tier files go into the reserved global
corpus. They are mirrored once at boot, gated on file modification time, and older copies are never reclaimed.

**Impact.** Personal configuration, such as how one person likes replies formatted or which sandbox they test in,
shows up as shared global knowledge in answers and injected context. Agents already receive CLAUDE.md natively, so the
mirror mostly duplicates context they have.

**Recommendation.** Mirror home-tier files as user-scoped docs owned by the host user, re-run redaction on every boot,
exclude native memory from topical retrieval, and deliver it through a dedicated owner profile instead.

## 12. Personal identifiers and secrets in the corpus

**Gap.** Several docs, both mirrored and agent-written, carry details that belong to one person: identifiers of their
own cloud sandboxes, hostnames of their machines, and paths to files on their disk. Redaction only runs on the native
memory ingest path, and only when a source file changes.

**Impact.** Today there is one user, so the exposure is latent. Under multiplayer, a doc that is scoped global sends one
person's account details to every teammate's agents.

**Recommendation.** Run redaction on every write path, not just one ingest. Add explicit "do not propose" guidance for
personal resource identifiers. Flag existing docs that contain account-shaped numbers for review.

## 13. Persona memory and the learning loop

**Gap.** Persona, the always-on orchestrator the owner messages, has remember and recall tools. Remembered preferences
are stored as user-scoped docs. The system prompt Persona runs with does not include those memories; they are only
reached if Persona chooses to call recall, which it rarely does. There is no forget tool, and a newer correction does
not replace an older one on the same topic.

**Impact.** The owner gives a correction ("from now on, always do X") and it does not show up in the next worker brief.
The owner repeats it. Older and newer versions of the same preference coexist.

**Recommendation.** Load the owner's profile, small and unranked, into Persona's system prompt every turn, append
feedback memories to every brief, key memories by topic and merge on save, and add forget.

## 14. Persona architecture and state

**Gap.** Persona's design went through several iterations in a short time. Planning notes, implementation specs, and an
architecture doc describe different states of the same work, and some of them disagree about whether the work has been
merged.

**Impact.** Contradiction detection flags the disagreeing docs, and flagged docs are held out of ask_expert on both
sides, so questions about Persona can come back as "not covered" even though the knowledge base has several docs on it.

**Recommendation.** Resolve repository-state contradictions (merged, implemented) automatically against git, and hold
out only the losing side.

## 15. Slack mirror reliability

**Gap.** The Slack mirror streams session activity into a channel. Posts fail under rate limiting and during upstream
blips. Retry behavior has changed over time and the docs describing it have not always kept up. The mirror also has to
render tool output as cards, and the fidelity relative to the terminal is uneven.

**Impact.** Messages are occasionally dropped or delayed, and long tool output is truncated in ways that confuse readers.

**Recommendation.** Treat rate-limit responses as retryable and honor the server's hint, use bounded backoff with
randomization, and add a dead-letter count to the health page. Move tool output to the native streaming card API.

## 16. Outbound HTTP timeouts

**Gap.** The collector makes outbound HTTP calls for webhooks, Slack, and integrations using Bun's built-in fetch. Bun's
fetch does not apply a short per-request timeout on its own, so a stalled upstream can hold a call open for several
minutes.

**Impact.** A single slow webhook can stall a worker loop, and the symptom looks like a hung session rather than a
network problem.

**Recommendation.** Route every outbound call through a shared helper that applies an explicit abort timeout, and log
timeouts as a distinct error class.

## 17. Headless claude subprocess authentication

**Gap.** ask_expert synthesis and the coherence judge spawn the claude CLI in print mode as a subprocess. In environments
that route model calls through Bedrock, the subprocess sometimes gets permission errors. There are at least two
explanations floating around: the subprocess not inheriting the parent's AWS profile, and the profile's cached
credentials having expired.

**Impact.** Synthesis silently falls back to a raw dump of retrieved context, and the judge reads errors as "no
contradiction". Neither failure is visible in the console.

**Recommendation.** Pass the profile and provider settings explicitly to the subprocess, distinguish credential errors
from model refusals, retry once after refreshing, and record whether an answer was synthesized or fell back.

## 18. Contradiction detection and resolution

**Gap.** After a doc is published, a judge model compares it to nearby docs and marks both sides of a detected conflict
as contradicted. A resolver proposes resolutions, but the auto-apply gate effectively never fires. Judge errors are
treated the same as a judgment of no contradiction.

**Impact.** Many docs carry a contradicted verdict indefinitely. search_knowledge shows them without a warning while
ask_expert hides them, so the two surfaces disagree about what the knowledge base says.

**Recommendation.** Separate errored from judged-no and retry errors. Mark contradicted docs visibly in search output.
Hold out only the older or less verified side.

## 19. Deduplication of proposals

**Gap.** When an agent proposes a doc, the write path checks for near duplicates within the same project only, at a
high similarity bar. Paraphrased duplicates score just under the bar. Forks of the same doc across projects are never
compared.

**Impact.** The corpus accumulates paraphrased copies, and result sets return two versions of the same fix side by side.

**Recommendation.** Calibrate the threshold on the real corpus, compare across the caller's whole retrieval audience,
and return the nearest existing docs in the propose response so the agent can update instead of creating.

## 20. Confidence and decay

**Gap.** Each doc has a confidence value that decays over time with a fixed half-life. Docs authored by the owner
without an explicit confidence are exempt. Agent proposals are auto-published at full confidence. Nothing moves
confidence based on evidence.

**Impact.** The confidence number mostly encodes authoring time. Decay, if it ever bites, would demote accurate agent
docs while leaving inaccurate owner docs untouched.

**Recommendation.** Make confidence respond to evidence (verdicts, newer contradicting docs, changes to files a doc
names). Give status-like content a short half-life.

## 21. Re-verification

**Gap.** A re-verification pass is meant to re-check docs against the repository and refresh their verified
timestamp. It is tied to the code review opt-in and only considers docs that record a source commit.

**Impact.** In practice almost nothing is re-verified, and the most retrieved docs are the least checked.

**Recommendation.** Decouple re-verification from the review opt-in, include owner and ingested docs, and anchor checks
to the source file's commit.

## 22. Write path and review

**Gap.** propose_knowledge publishes immediately unless the caller asks for human review. Fact checking runs only on the
review branch. Skill instructions encourage agents to store knowledge after every unit of work.

**Impact.** The corpus grows quickly with session narration, dated validation logs, and status reports. Titles like
"DEPLOYED" and "VALIDATED end-to-end" are common.

**Recommendation.** Verify before publishing or publish at reduced confidence. Add "do not propose" guidance for status,
session tags, and dated validation notes.

## 23. Scope and audience

**Gap.** Docs have a scope of global, project, or user. The retrieval audience for an agent is global plus its project
plus its own user. Global means slightly different things on different surfaces: one surface treats the reserved global
project as global, another treats any doc with scope global as global.

**Impact.** Agent-written docs promoted to global from a scratch session reach every project. Persona's recall sees only
a small slice of the corpus.

**Recommendation.** Define global the same way everywhere, make promotion to global a human decision, and refuse global
scope from scratch-homed sessions.

## 24. The scratch project

**Gap.** Sessions that cannot be matched to a project land in scratch. Many real work sessions in workspaces that are
not registered as project repos end up there, and their proposals land there too.

**Impact.** Scratch fills with product docs for other efforts, some of them promoted to global.

**Recommendation.** Populate project repos, match on workspace roots, and run project inference for hook sessions, not
just console launches.

## 25. Project registry

**Gap.** Projects can be described in a TOML file in the config directory. Earlier designs treated the file as the live
registry with a watcher. The console also edits projects. It is not obvious to a user which one wins.

**Impact.** Edits to the file appear to do nothing, or edits in the console appear to be lost, depending on which the
user believes is authoritative.

**Recommendation.** Document clearly which store is the source of truth and make the other an explicit import or export.

## 26. Multiplayer identity

**Gap.** For teams sharing a collector, the requesting user's identity has to be established server-side. The design
relies on a tunnel that authenticates and forwards an identity header. Callers must not be able to claim an identity in
the request body.

**Impact.** If identity resolution is wrong, user-scoped docs and preferences leak between teammates.

**Recommendation.** Keep identity strictly server-side, fall back to global plus project when it cannot be resolved, and
add tests that pin the header behavior.

## 27. Task tracker integration

**Gap.** Standup can link sessions to tasks in an external task tracker (Jira and GitHub issues are the two we care
about). Sync is one-way today: a task can start a session, but session progress does not flow back. Fields like task
priority and assignee are not modeled, and different owners have strong and different opinions about who sets priority.

**Impact.** People copy status by hand, and agents occasionally fill in fields their owners would rather leave to a
triage process.

**Recommendation.** Two-way sync for status and comments only. Do not let agents set triage fields such as priority;
leave them for the humans who own triage.

## 28. Code review integration

**Gap.** Sessions that end in a code review need to create or revise a review artifact. The seam is pluggable (a pull
request, or a merge request), but the conventions around multi-repository changes, revisions versus new reviews, and
description format live in personal notes rather than in the product.

**Impact.** Agents sometimes open a second review for work that already has one, and the description format varies
from session to session.

**Recommendation.** Make the review provider aware of an existing review for the branch, and surface the project's own
review convention (how a change spanning repositories is grouped, update rather than reopen) in the launch context.

## 29. Scheduler and routines

**Gap.** Recurring background passes (daily review, distillation, reconciliation sweeps) each have their own timer.
There is no single view of what runs when, and several of them are disabled by default with no indication in the UI.

**Impact.** Features described as shipped never actually run on a given install.

**Recommendation.** One scheduler with a routines table, visible in the console, with last-run and next-run times.

## 30. Retrieval telemetry

**Gap.** Each retrieval is logged with a single fused score, a rank, and the surface. Arm-level components, the
un-normalized score, the partition, the doc kind, and the algorithm version are not recorded. Gate drops are not
logged. Outcomes are joined through session ids, which many rows do not have.

**Impact.** Nobody can tell why a hit was returned or why an expected doc was missing, and none of the self-improvement
claims can be checked.

**Recommendation.** Log components, an algorithm version, and per-candidate drop reasons. Log doc fetches as a strong
usage signal. Persist every expert exchange with a synthesized-or-fallback flag.

## 31. The Knowledge tab

**Gap.** The console's Knowledge tab lists docs with columns for title, project, kind, scope, and a usage count. Usage is
computed from logged retrievals, so docs that were never retrieved do not appear in usage views at all. There is no
per-layer breakdown and no view of hub docs.

**Impact.** Dead docs are invisible, and the owner cannot see at a glance that a handful of very large docs dominate
results.

**Recommendation.** Add a dead-doc filter, a hub view sorted by in-degree and retrieval share, and per-layer counts.

## 32. Session sidebar and console polish

**Gap.** The session sidebar groups sessions by project. Long titles overflow, status colors are hard to distinguish in
dark mode, and keyboard navigation is incomplete.

**Impact.** Owners with many concurrent sessions lose track of which one is which.

**Recommendation.** Truncate titles cleanly, revisit the status palette against dark mode tokens, and finish keyboard
navigation.

## 33. Session liveness

**Gap.** Sessions report heartbeats. When a session stops reporting, the console does not always notice promptly, and
reconciling lost runs depends on a periodic sweep.

**Impact.** Stuck sessions look busy. The owner waits on a session that is not doing anything.

**Recommendation.** Mark sessions stalled after a threshold without heartbeats and show it prominently, with a one-click
way to inspect the last transcript event.

## 34. Duplicate corpora

**Gap.** A frozen copy of the Standup project's docs exists under a second project id from an earlier setup. It is never
refreshed or pruned. The copies are starting to diverge from the originals.

**Impact.** Wasted result slots, and stale variants of current docs.

**Recommendation.** Retire the duplicate project and collapse identical bodies at query time.

## 35. Code knowledge

**Gap.** There is no index of source files. All docs are markdown. The only path to live code is a keyword search that
depends on an external binary.

**Impact.** Questions like "where is X defined" or "what calls Y" are answered from prose docs, which go stale, instead of
from the code.

**Recommendation.** Bundle or locate the search binary, fall back to git grep, and route identifier-shaped questions to
code first. Longer term, a symbol and path index keyed to the current commit.

---

## Prioritization

| Area | Sections | Size | Priority |
|---|---|---|---|
| Personal data out of shared corpus | 11, 12, 13 | M | P0 |
| Gates that gate | 7, 8, 9 | M | P0 |
| Index integrity and embeddings | 2, 3, 6, 34 | M | P1 |
| Labels and staleness | 10, 18, 20, 21 | L | P1 |
| Lexical quality | 5 | S | P1 |
| Write path | 19, 22, 23, 24 | M | P1 |
| Observability | 30, 31 | M | P1 |
| Integrations | 15, 16, 17, 27, 28 | M | P2 |
| Console polish | 32, 33 | S | P2 |
| Code layer | 35 | L | P2 |
| Blending and graph | 1, 4 | S | P2 |
| Persona state | 14 | S | P2 |
| Registry and identity | 25, 26 | S | P2 |
| Scheduler | 29 | M | P3 |

The P0 items share a theme: the knowledge layer currently says something, with apparent confidence, in situations where
the right answer is "nothing relevant" or "this is personal and does not belong here". Fixing those first makes every
later improvement measurable.

---

## Appendix A: user journeys walked for this analysis

### A.1 New owner, first day

The owner installs Standup, starts the collector, opens the console, and registers two projects. The registration flow
asks for a project id, a display name, and an optional list of repository paths. Several owners skip the repository
paths because the field looks optional, and that single omission later decides whether hook sessions in that repository
are attributed to the project or dumped into scratch. The console does not explain the consequence. The owner then
launches a first session from the console. The launch prompt contains an injected knowledge block, which on a fresh
install is either empty or full of the reserved global corpus, which on most installs is just the mirrored CLAUDE.md
and rules files. The owner notices their own configuration being fed back to the agent and is confused about why.

Gaps surfaced: registration does not explain repos (section 24), injection pulls personal native memory (section 11),
no relevance floor (section 8).

### A.2 Agent asks a design question

A worker agent in the standup project wants to know why knowledge search uses the blending method it uses. It calls
search_knowledge with a natural language question. The top results include this gap analysis, a high level design
doc, and an implementation plan, all of which mention blending in passing. The focused decision doc that actually records
the choice appears lower. The agent reads the first hit, finds a paragraph of gap analysis rather than a decision, and
calls search again with different words. This search-then-search-again pattern shows up in a large share of transcripts.

Gaps surfaced: mega-docs win by volume (section 6), graph rerank can promote hubs (section 4), no title or section prefix
on chunks (section 6).

### A.3 Agent asks about code

A worker wants to know which constants control the relevance floor and how many sources ask_expert returns. It calls
ask_expert. The answer says the retrieved context does not specify the values, even though the expert module defines
them as named constants and a runbook doc mentions one of them. The code arm did not run because the keyword search
binary was missing on the host, and the failure was only visible in the collector log.

Gaps surfaced: code arm fragile (section 7), no code index (section 35), Sources not citations (section 7).

### A.4 Owner gives Persona a standing instruction

The owner tells Persona, in chat, that from now on every worker brief should include a particular step. Persona
acknowledges and says it will remember. It calls remember, which writes a user-scoped doc. Over the next several
dispatches Persona does not call recall and the step is missing from every brief. When the owner asks why, Persona
apologizes and the next brief is missing the step again.

Gaps surfaced: memories not in the prompt (section 13), no forget, no replacement of older memories on the same topic.

### A.5 A teammate joins

A second user connects through the authenticated tunnel. Their agents search the knowledge base. Because the owner's
home CLAUDE.md is mirrored into the reserved global corpus, the teammate's agents receive the owner's personal account
notes and review preferences as if they were team guidance. The teammate's own user-scoped docs correctly stay out of
the owner's results, which shows the scope gate itself works; the leak is entirely through docs that are marked global.

Gaps surfaced: native memory as global (section 11), secrets in corpus (section 12), meaning of global (section 23).

### A.6 Off-topic question

An agent, or a curious owner, asks ask_expert something the knowledge base has nothing to say about, such as a cooking
or personal finance question. The synthesizer correctly declines, but the answer still lists a full set of Sources,
several of them personal docs. A reader skimming the response would assume the answer was grounded.

Gaps surfaced: floor computed on normalized score (section 8), Sources overstated (section 7).

### A.7 A doc is corrected

An owner edits a runbook to correct the number of retries and add a new detail. Afterwards, searching for the new detail
returns nothing, while searching for the old wording still finds the doc, and the excerpt shown is the new text. The
owner concludes search is flaky. The actual cause is that the full-text rows for edited docs are written under a
different id than the stored doc row, leaving the old rows in place and the new ones orphaned from the join.

Gaps surfaced: index integrity after edits (new; see Appendix B.4).

### A.8 Shrinking a doc

An owner deliberately removes a dangerous command from a deploy runbook. Weeks later an agent quotes the removed command
back from a search excerpt. The vector side keeps tail chunks beyond the new chunk count, so text that no longer exists in
the doc still matches and is still shown.

Gaps surfaced: stale tail chunks (Appendix B.4).

---

## Appendix B: detailed findings by area

### B.1 Search ranking details

The search pipeline, in order: build a full-text match expression from the query; run the FTS arm with bm25; embed the
query and run the vector arm; fuse the two ranked lists; multiply by a title boost when query terms appear in the title;
multiply by a project factor that favors the current project and penalizes others; optionally rerank with the graph;
truncate to the requested limit. Confidence, decay, and verdict are not ranking inputs anywhere in this pipeline; they
only act as gates in ask_expert and injection.

Observations from walking it:

- The project factor is applied to a rank-fused score that carries no relevance magnitude. A highly relevant doc from
  another project can be outranked by a weakly relevant doc from the current project simply because the multiplier
  dominates the small differences between fused scores. This is visible for generic runtime gotchas that were promoted
  to global from one project and are then searched from another.
- The displayed "relevance" number is the un-fused raw score, while the sort order is the fused score. Agents see a
  0.58 listed above a 0.74 and conclude the ranking is broken.
- The title boost helps exact-title queries a lot and does little for anything else.
- The graph rerank, when enabled, changes the top result for a meaningful fraction of real queries. In the sample we
  looked at, more of those changes were for the worse than for the better, typically by replacing a focused doc with a
  broad one.

### B.2 Embedding details

Vectors are 768-dimensional from a local model. Chunk vectors are stored per chunk; doc-level vectors for the graph are
the mean of chunk vectors. Mean vectors of very long docs sit near the centroid of the corpus, which makes them similar
to almost everything and turns them into graph hubs. A fingerprint string records provider and model name and is checked
at boot; a change in vector width is detected, but a change in the underlying model weights under the same name is not.
Re-embedding a sample of older chunks produced noticeably different vectors, suggesting a silent drift at some point.

### B.3 Vector store details

There are two vector paths in the codebase history: a brute-force scan over all chunk vectors in memory, and a KNN query
through a sqlite-vec virtual table with an over-fetch factor to survive post-filtering by scope. The scope predicate is
pushed into candidate selection on the full-text arm and the brute-force arm; for the KNN arm it is applied when
hydrating the over-fetched candidates. Whether the KNN path is the live default has been described inconsistently across
docs; one older status note calls it dormant, other notes say it shipped. Verify against the store module.

### B.4 Index integrity after edits

The loader assigns a fresh random id each time it reads a file. On upsert, the stored row keeps its original id because
the conflict target is project plus slug. The full-text step then deletes by the new id, which matches nothing, and
inserts under the new id, which the join to the knowledge table never matches. The result is a growing set of orphan
full-text rows and docs that are findable only by their old wording. A separate but similar issue affects chunk rows when
a doc shrinks: chunks with an index past the new chunk count are not deleted. The fix direction is to resolve the stored
id before writing full-text rows, delete stale tail chunks, rebuild the full-text table once, and add a health check that
the counts agree.

### B.5 ask_expert details

Retrieval partitions: the asking project (small limit), the reserved global corpus (small limit), and the code keyword
arm over the working directory. The partitions are merged with per-partition normalization, which puts knowledge hits
and code hits on different scales; code would mostly land below the cut even when the keyword arm works. The synthesizer
receives more docs than appear in Sources, so docs logged as dropped were in fact read. Citation labels in the answer are
not parsed or validated. When the synthesizer subprocess fails, the answer falls back to a dump of retrieved excerpts
without a flag, and a large share of recorded answers over a multi-week window were such fallbacks.

### B.6 Injection details

Two blocks: code-flavored kinds and product or spec kinds. Native memory is included in the code-flavored kinds, which
is how the owner's personal configuration ends up under a heading that calls it code knowledge. Each block over-fetches a
dozen candidates and keeps a few after gates. For a project with no eligible product docs of its own, the product block
is filled entirely by global-scoped product docs from other efforts. The launch log reports the number of docs requested
rather than the number actually injected.

### B.7 Persona details

Persona runs as a long-lived Claude session with a dedicated tool set: dispatch work to sessions, check on sessions,
remember, recall, and ask the expert. Its system prompt is built from a personal instructions field and a handoff note
from the previous Persona session. Saved memories are not part of it. The save gate for remember requires the saved text
to overlap heavily with the owner's own message, so paraphrased memories are rejected. Preferences touching code reviews
or deploys require an approval card. Persona's call to ask_expert passes an empty working directory, which would make the
code arm search the collector's own directory regardless of project.

### B.8 Slack mirror details

The mirror maintains one thread per session and posts transcript events as they arrive. Tool calls render as cards.
Posting goes through a retry wrapper. Rate-limit responses from Slack include a hint about when to retry; the wrapper's
handling of that hint has varied between versions. Reconnect after a socket drop replays from the last acknowledged event.
A reliability review documented dropped messages under bursty tool output and recommended batching appends to the
streaming API.

### B.9 Outbound HTTP details

Outbound calls use the runtime's built-in fetch. Without an explicit abort signal, a hung upstream holds the call open far
longer than any caller expects. A shared helper with an explicit timeout exists for some call sites; not all integrations
use it yet. Integrations written in other services (for example Java services in sibling projects) have their own client
timeout settings that are unrelated to this issue.

### B.10 Subprocess model calls

The synthesizer and the coherence judge both spawn the claude CLI in print mode. Environment handling for the subprocess
determines which credentials it uses. When the parent shell's credentials are refreshed under one profile but the
subprocess resolves another, calls fail with permission errors. The judge's parser treats any error as a negative
judgment, so a run of failures looks like a clean bill of health.

### B.11 Task tracker details

The integration reads tasks to start sessions and can link a session to a task. Writing back is limited. Owners have
different conventions about which fields an author should fill in. Some teams leave priority to a weekly triage
rotation. The product should not encode any one owner's convention as a default, and agents should not fill in triage
fields on their own.

### B.12 Code review details

Changes that touch more than one repository come up regularly. Each project has its own answer to the questions that
matter: one review or a stack of them, when an existing review gets a new revision instead of a replacement, and what
the description must contain. Today those answers sit in whoever wrote them down for their own sessions, not in project
configuration, so agents in one project follow a convention that agents in the next project have never seen.

### B.13 Personal account details

The name of someone's own sandbox, and how they sign in to it, is useful to that person's agents and should reach them.
It is not team knowledge. It belongs in a user-scoped profile handed to that person's sessions, not in a global doc that
competes in ranking with everything else.

### B.14 Scheduler details

Daily review, distillation, and the re-verification pass are each gated by a per-project setting that defaults to off.
The settings page does not show them together. Status notes describe several of these as shipped, which is true of the
code and false of every install we checked.

### B.15 Telemetry details

The retrievals table has a row per returned hit with surface, rank, and score. Inject rows cannot be joined to outcomes
because the join path skips the launch to session link. Doc fetches by id, arguably the strongest signal that a hit was
useful, are not logged at all. Expert exchanges are only stored when a session id is present.

### B.16 Knowledge tab details

The tab is the only place an owner can see the corpus as a whole. It reads usage from the retrievals table, which by
construction cannot show never-retrieved docs. Deleted or renamed slugs that still have retrieval rows appear as if live.
A per-layer breakdown (code, intent, team docs, personal, activity) would make most of the problems in this analysis
visible at a glance.

### B.17 Session sidebar details

The sidebar is a virtualized list grouped by project. Title truncation is handled per row with a fixed height, so long
titles either overflow or are clipped mid-word. Status dots use colors that are close in luminance in dark mode. The
sidebar's styles live alongside the other console styles; the spec for the intended behavior is in the console UI specs.

### B.18 Registry details

The collector stores projects in SQLite. A TOML file in the config directory predates that and is still read in some
code paths. Older design docs describe the file as the registry with a live reload; that description should be checked
against the current registry module before anyone relies on it.

### B.19 Identity details

The identity header is set by the tunnel after authentication. The MCP tools forward a scoped flag so the server applies
the strict audience gate. When identity cannot be resolved, retrieval falls back to global plus project and never routes
another user's private docs. Tests pin that a caller-supplied user in the request body is ignored.

### B.20 Duplicate corpus details

The duplicate project holds copies of most Standup docs, nearly all byte-identical, with ingest markers pointing at paths
that no longer exist on this host. A handful have diverged from the originals; in each diverged case the duplicate is the
older text.

---

## Appendix C: open questions

1. Should personal configuration be retrievable at all through search_knowledge, or only through the owner profile?
2. Should product docs ever be injected across projects, for example when two projects are explicitly linked?
3. What is the right default for source kind on docs that do not declare one?
4. Is a single relevance floor across surfaces realistic, or does each surface need its own calibration?
5. Should the duplicate project be deleted outright or archived read-only?
6. Should graph rerank be removed rather than defaulted off, given the cost of maintaining edges?
7. How should Persona present a correction that conflicts with an older memory: replace silently, or ask?
8. Who decides that a doc is global: the author, a reviewer, or a rule?
9. Should code knowledge be stored at all, or always computed live from the repository at the current commit?
10. What is the minimum telemetry needed to evaluate any of the above changes honestly?
