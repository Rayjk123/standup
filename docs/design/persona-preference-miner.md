# Persona preference miner: learn the owner's habits from what they do, confirm before keeping

Status: proposed (2026-10-06). Design only, no implementation.
Scope: `packages/collector/src/persona/*`, `packages/store` (one migration), `packages/web`
(`PersonaView`, `KnowledgeView`), `packages/slack` (`persona-bridge`).

Related: `docs/design/persona-action-gating.md`. Both designs read the same approval history. §6
says how they fit together.

Line numbers are those of the code when this design was written; they drift as the code changes.

## 0. Problem and goal

Today Persona learns about its owner only when someone says "remember this":

- **`remember`.** The tool is defined at `persona/tools.ts:412` and handled at `:1955`. It writes a
  `persona-…` personal-layer knowledge doc through `PUT /api/projects/:id/knowledge/:slug`
  (`server.ts:3610`). The route stamps the doc with Persona's writer stamp only when the request
  carries the runtime's per-boot secret (`server.ts:1471`, `persona/memory-trust.ts:102`).
- **The profile.** `buildOwnerProfile` (`owner-profile.ts:592`) loads those memories into every
  private turn (`runtime.ts:488`). `formatOwnerPreferences` (`owner-profile.ts:812`) puts them into
  every worker brief (`tools.ts:1367`).

The owner's actual behaviour is a much richer signal, and it is thrown away: what they approve and
how fast, which quick reply they tap, when they push back, what they rewrite, which project a kind
of request ends up in, when and where they talk to Persona. Standing preferences tend to be typed
out by hand only after something annoys the owner. A hypothetical example: "stop asking me which
branch name to use; pick one".

**Goal.**

1. Capture owner-authored behaviour as structured signal events.
2. Mine those events nightly into *candidate* preferences, each with evidence counts, a confidence
   and examples.
3. Show the candidates to the owner. A candidate becomes a memory only when the owner accepts it,
   and the memory keeps its provenance.
4. Detect hold categories that are pure noise and *propose* policy changes, which the owner must
   approve explicitly.

Nothing the miner learns changes behaviour without the owner's explicit OK. Nothing it learns can
loosen safety behaviour on its own (§7).

### Where the inputs live

| Table | What the miner reads from it |
|---|---|
| `persona_approvals` | One row per hold: `action`, `status`, `created_at`, `decided_at`, `decided_by`, `reason`. Approval rate and time to decide per action are derivable from these columns. |
| `persona_messages` | Owner and Persona messages, with `options_json` on messages that offer quick replies. |
| `persona_threads` | One row per thread, with `channel` and `audience` (private console thread, Slack threads). |
| `persona_jobs` | Job goals and states, for routing (S6). |
| `persona_inbox` | Event kinds (`worker_event`, `user_message`, `approval_result`, `schedule`); used only for timing. |
| Persona memories | `knowledge` rows with `persona-%` slugs and scope `user`, for near-duplicate checks. |

Chat-derived hypotheses need evidence spread over several days and several threads (§3 step 3), so
they take longer to reach threshold than hypotheses over approvals, which accumulate one row per
hold. That is why the policy-noise detector (§5) is the first slice (§8).

There is no separate cards table. An approval card is a rendering of a `persona_approvals` row
(`packages/shared/src/approval-card.ts`). The Slack bridge keeps only card message state, in
`slack-persona-threads.json` (`packages/slack/src/persona-store.ts:184`).

## 1. Signals: where each one comes from today, and what to add

**Rule for every signal: the actor must be the owner, as established by the server.** That means
an owner-token request through `humanGate` (`persona/routes.ts:229`) or the owner's Slack user
via the bridge. Worker text, Persona's own text, KB docs and other Slack users' messages never
produce a preference signal. They may appear only as the *thing the owner reacted to*, stored by id
and never as evidence of what the owner wants (§7).

| # | Signal | Source today | Hook point | What to add |
|---|---|---|---|---|
| S1 | **Approval outcome + time to decide, per action type** | `persona_approvals` (`store/migrations.ts:1445`): `action`, `status`, `created_at`, `decided_at`, `decided_by`, `reason` (prose), `result` (the deny reason) | `runtime.approve` `runtime.ts:928` (the `pending→approved` transition at `:945`), `runtime.deny` `:966`, expiry at `:936-943`, supersede `tools.ts:2219-2226`. All go through `transitionPersonaApproval` (`store/queries/persona.ts:1154`). | A **structured `hold_rule`** on each approval (see §6): a stable id such as `text:outward`, `budget`, `cap`, `hold-knob:<action>`, `memory-owner-words`, `criterion`, `permission-prompt` or `restart-shared`. Today only the prose `decision.reason` exists (`policy.ts:1714-1717`), and grouping prose is fragile. Also record **whether the owner was active**: a user message or tap within ±5 min of `created_at`. Wall-clock time to decide mixes "was away" with "had to think". Write one signal per transition in `transitionPersonaApproval`'s callers. |
| S2 | **`ask_user` option chosen vs Persona's recommendation** | Options live in `persona_messages.options_json` (`tools.ts:1751-1770`). A tap sends the option's **text** as an ordinary user message: web `onQuickReply` → `send` (`web/.../PersonaView.tsx:989`, `:218`); Slack `onOptionButton` (`slack/src/persona-bridge.ts:538-556`, idempotency key `option:<ts>:<index>`). Nothing links the reply to its question. Persona has no way to say which option it recommends. | `ask_user` schema `tools.ts:317-327`; `POST /api/persona/messages` `routes.ts:290`; `receiveUserMessage` `runtime.ts:858` | (a) Add an optional `recommended: <index>` to `ask_user`, stored in `options_json` as `{options, recommended}`. (b) Add `replyTo: {messageId, optionIndex}` to `PersonaSendRequest` (`shared/src/persona.ts:264`), sent by both the web quick-reply buttons and the Slack button handler. A free-text reply to an options message within 10 min records `optionIndex: null` ("answered off-menu"). Signal: `{chosen, recommended, offMenu}`. |
| S3 | **Owner corrections in chat** ("no", "don't", "why did you…", "I said", "again", "stop", "!!", ALL CAPS, "annoyed") | Owner text only, in `persona_messages` (role `user`) | `receiveUserMessage` `runtime.ts:858` | A deterministic lexicon over `withoutOtherVoices(text)` (`owner-speech.ts:117`), so pasted or quoted text from others doesn't count. Link the correction to **what it corrects**: the previous Persona message, plus the Persona tool calls of the previous turn. Those calls are only broadcast today (`persona:tool`, `tools.ts:2259-2275`). Add a `persona_action` signal at that point (action name, job id, approval id, no arg text) so a correction can point at "the `send_to_session` you just made" or "the hold you just raised". |
| S4 | **Owner rewrites of Persona drafts** | Persona drafts are its messages (`runtime.ts:555`) and the brief/message content on approval cards (`approval-card.ts`). An owner rewrite arrives as an ordinary user message. | `receiveUserMessage` `runtime.ts:858` | When an owner message shares ≥50% of its word 5-shingles with one of the last 3 Persona messages, or with a card's content section, and isn't identical, record `rewrite` with diff features only: length ratio, bullets↔prose, hedges removed, headings, sentence count. Store neither text whole; keep the message ids. A later "edit and approve" on cards would give a cleaner signal, but it's out of scope (§9). |
| S5 | **Ignored suggestions** | Options messages with no reply; approvals that `expired` (24 h TTL, `runtime.ts:111`); Persona questions (`ask_user` without options) with no reply before the owner changes subject | Nightly miner (no live hook); expiry path `runtime.ts:936-943` | Derived nightly from S2 and S1: `ignored` once 24 h pass with no linked reply, or when the owner's next message is off-menu and unrelated (cosine < 0.3 against the question). |
| S6 | **Project routing per request type** | `launch_session` `projectId` (`tools.ts:1331-1345`) via `persona_job_launches` → `launches.project_id`. Job goal in `persona_jobs.goal` (`store/migrations.ts:1420`). The owner message that opened the job is in the same thread just before `open_job`. | `launch_session` run (`tools.ts:1343` onward); `stop_session` / relaunch | `routing` signal: `{requestKey, projectId, inferred: projectId absent}`. `requestKey` is the embedding cluster id of the owner message that started the job (§3). **Negative routing:** within 30 min, the owner says "wrong project/repo", or a job is stopped and relaunched in another project → `{from, to}`. |
| S7 | **Active hours and channel** (console vs Slack, phone vs desktop) | `persona_messages.created_at`, `persona_threads.channel`/`audience` (`store/migrations.ts:1363`, `:1484`) | `POST /api/persona/messages` `routes.ts:290` (console); bridge `personaSend` (`slack/src/collector-client.ts:672`) | Coarse `device: 'mobile'\|'desktop'\|'unknown'` from the console request's `User-Agent`. Store only the class, never the UA string. Slack's Events API doesn't say which client posted, so Slack records `unknown`. An approval tapped from the push notification (`push.ts`) records `channel: 'push'`. Hours are bucketed in the owner's timezone (the one `persona_schedules.timezone` uses). |
| S8 | **Message length and style** | Owner message length; Persona reply length; explicit owner feedback ("shorter", "tl;dr", "more detail", "just the command") | `receiveUserMessage` `runtime.ts:858` | Two signals. `style_feedback {direction: shorter\|longer\|format:<bullets\|table\|code>, replyChars}`, tied to the previous Persona message's length. `owner_length {chars}`, which is a weak prior and is never mined alone. |
| S9 | **Repeated requests** | Owner `user_message` text | Nightly miner | The embedding of each owner message, using the same provider the KB uses (`@standup/knowledge` `deriveDocVectors`/`cosineSimilarity`, already used in `owner-profile.ts:439`). Clustered nightly at cosine ≥ 0.85 across ≥ 3 distinct days. Kept as a vector plus a ≤ 200-char redacted excerpt. |

Two signal sources are explicitly **not** captured:

- Worker `ask_human` questions, checkpoints and transcripts (`persona/events.ts:215` onward,
  `worker_event`).
- Persona's own replies, except as the *referent* of an owner action.

## 2. Storage

### Tables (one migration, explicitly versioned)

Migrations from 053 on are `migration(<n>, …)` entries in `packages/store/src/migrations.ts`,
which also lists `RESERVED_MIGRATION_VERSIONS`. The miner takes the next free version number at
implementation time (TBD here); check `packages/store/src/migrations.ts` for the current highest.

```sql
-- Migration TBD (sketch): Persona preference miner.
CREATE TABLE IF NOT EXISTS persona_signals (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'approval', 'option_reply', 'correction', 'rewrite', 'ignored', 'routing',
    'activity', 'style_feedback', 'owner_length', 'request', 'persona_action')),
  -- Always the owner or the system (derived/nightly). There is no 'worker' value on purpose.
  actor TEXT NOT NULL CHECK (actor IN ('owner', 'system')),
  subject TEXT,              -- action name, project id, request cluster id …
  value_json TEXT NOT NULL,  -- kind-specific structured fields, no free text
  excerpt TEXT,              -- ≤200 chars of the OWNER's words, redacted; NULL for most kinds
  vector BLOB,               -- 'request' only
  thread_id TEXT, job_id TEXT, message_id TEXT, approval_id TEXT,
  audience TEXT NOT NULL DEFAULT 'private',  -- the thread's audience at capture time
  channel TEXT, device TEXT,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_persona_signals_kind ON persona_signals(owner, kind, occurred_at);
CREATE INDEX IF NOT EXISTS idx_persona_signals_subject ON persona_signals(owner, subject);

CREATE TABLE IF NOT EXISTS persona_preference_candidates (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  -- kind + normalized key, e.g. 'routing:cluster-7→standup', 'hold-noise:hold-knob:approve_plan'.
  fingerprint TEXT NOT NULL,
  class TEXT NOT NULL CHECK (class IN ('preference', 'routing', 'style', 'schedule', 'policy')),
  autonomy INTEGER NOT NULL DEFAULT 0,  -- 1 = touches approvals/agent latitude (§7); set by code, not the LLM
  statement TEXT NOT NULL,              -- the proposed memory text (or the policy change)
  topic TEXT NOT NULL,                  -- remember topic it would be saved under
  evidence_count INTEGER NOT NULL,
  consistent_count INTEGER NOT NULL,
  confidence REAL NOT NULL,             -- Wilson 95% lower bound of consistent/evidence
  first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
  examples_json TEXT NOT NULL,          -- ≤5 {signalId, at, excerpt?, link}
  evidence_ids_json TEXT NOT NULL,      -- every signal id (kept after the signals are pruned)
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN (
    'proposed', 'accepted', 'rejected', 'snoozed', 'stale', 'forgotten')),
  memory_slug TEXT,                     -- set on accept
  decided_text TEXT,                    -- the text the owner accepted (after edit)
  decided_at TEXT, decided_via TEXT,    -- 'console' | 'slack'
  snooze_until TEXT,
  proposed_count INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (owner, fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_persona_candidates_status ON persona_preference_candidates(owner, status);

-- Shared with persona-action-gating (§6): the structured rule a hold was raised under.
ALTER TABLE persona_approvals ADD COLUMN hold_rule TEXT;
```

Every new column also gets a PRAGMA-guarded mirror in `ensureSchemaRepairs`, the way 051's
columns do (`store/migrations.ts:1873-1884`).

`UNIQUE (owner, fingerprint)` is what enforces "never propose the same thing twice" (§3).

### Retention

- **Raw signals: 90 days.** The nightly run prunes them in the same pass, the way
  `prunePersonaInbox` works (`store/queries/persona.ts:610`).
  - `request` vectors are kept 180 days, because repetition is a long-horizon pattern.
- **Candidates are kept indefinitely.** They are small and hold no raw text beyond ≤5 redacted
  excerpts.
  - A `rejected` row is the suppression record and must outlive its signals.
  - `evidence_ids_json` keeps the ids, so provenance stays countable after pruning. A link to a
    pruned signal shows "older than 90 days".
- An accepted memory's provenance lives in the candidate row and in a footer on the memory body
  (§4). It survives signal pruning.

### Privacy

- **Local only.** Everything stays in the collector's SQLite file (`db-path.ts`). There are no new
  network calls. The only optional model call is the nightly clustering helper (§3), which runs the
  same headless `claude -p` path (Standup's own Claude settings file) the distiller uses.
- **Owner-only.** New routes sit behind `humanGate` (writes) or the owner check (reads), like
  `/api/persona/approvals` (`routes.ts:359-389`).
  - Candidates and signals are **never** in the shared morning digest. It is explicitly read "as no
    one" (`digest-cron.ts:261-262`).
  - They are never in KB search, never in worker briefs, and never in a shared-thread Persona turn.
- **Redaction.** Excerpts pass through `redactSecrets` and `redactProfileText`
  (`owner-profile.ts:192`, account ids included) before they are stored.
- **Shared threads.** Signals from non-private threads (`audience != 'private'`) are recorded, since
  they are still the owner's behaviour, but their excerpts are dropped. Their examples show only
  "in a shared thread".
- **Kill switch and purge.**
  - The setting `persona.preferences.capture` (default on) stops all capture.
  - "Forget everything learned" deletes every signal and every non-accepted candidate. Accepted
    memories are left alone, because they are now ordinary memories that `forget` handles.

## 3. Mining

### Where it runs: in the collector, not as a worker

Recommend an **in-collector nightly pass**, scheduled the way `digest-cron.ts` and
`distill-cron.ts` are (`collector/src/index.ts:583`, `:594`): a plain interval with a once-a-day
settings gate (`persona_preference_miner_last_run`). It runs after 03:00 local time.

Reasons not to use a worker:

1. The data is small: hundreds of rows a day.
2. Most kinds are pure SQL aggregation.
3. A worker would need the floor, a worktree and a launch slot. Pointing a tool-using agent at a
   database of owner behaviour is the wrong blast radius.

The one model-assisted step, labelling clusters of corrections and repeated requests in plain
English, is a tool-less `claude -p` helper. It uses Standup's own headless Claude settings file
and the distiller's pattern. Its input is owner excerpts only, framed as data. Its output is
parsed as JSON. It can **name** a cluster and **draft** the statement. It cannot create or change
counts.

### Steps

1. **Derive.** Emit `ignored` signals (S5). Cluster the new `request` vectors (S9) and the
   correction excerpts (S3) incrementally:
   - Each new item joins the nearest centroid at cosine ≥ 0.85, otherwise it starts a new cluster.
   - Cluster ids are stable, so fingerprints are stable.
2. **Aggregate per kind into hypotheses**, deterministic code only:

   | Hypothesis | Evidence | Consistent when |
   |---|---|---|
   | Routing: "requests like *X* go to project *P*" | S6 in one `requestKey` | `projectId = P` and no negative-routing signal |
   | Recommendation trust: "go with my recommendation on *topic T*" | S2 for options messages whose question clusters to T | `chosen = recommended` |
   | Off-menu: "on *T*, don't offer options, ask openly" | S2 | `offMenu` |
   | Style: "replies over *N* chars draw 'shorter'" | S8 `style_feedback` | the same direction above or below a length split chosen by max consistency |
   | Correction theme: "don't *Y*" | S3 cluster tied to the same `persona_action` kind | the correction followed that action kind |
   | Rewrite style: "the owner turns prose briefs into bullets" | S4 | the same feature direction |
   | Active hours / channel: "on Slack from phone after 20:00; quiet 02–12" | S7 | the hour bucket share |
   | Repeated request → schedule: "every weekday ~09:00 you ask for *X*" | S9 cluster | the same weekday/hour bucket ± 1 h |
   | Hold noise (§5) | S1 per `hold_rule` | approved |

3. **Gate on thresholds** (code constants, not learned; §7):
   - **General:** evidence ≥ 5, consistent/evidence ≥ 90%, ≥ 2 distinct days, ≥ 2 distinct jobs or
     threads (so one burst can't make a habit), and the last evidence < 30 days old.
   - **Repeated request → schedule:** ≥ 3 distinct days, with ≥ 3 of them on the matching
     weekday/hour bucket.
   - **Policy (§5):** ≥ 20 decisions over ≥ 5 days, ≥ 95% approved, and no denial under the same
     rule in the last 14 days.
   - **Confidence** = the Wilson 95% lower bound, shown as a percentage. For example, 5/5 shows
     57% and 42/47 shows 77%. It is a ranking signal, not a gate.
4. **Upsert by fingerprint.**
   - `proposed`: refresh the counts and examples.
   - `accepted`: refresh the counts. If consistency drops below 70% over the last 20 events, the
     candidate becomes **stale**. It shows in the panel as "this may no longer be true" and offers
     forget. It is never auto-forgotten.
   - `rejected`: **never re-proposed.** The row stays as the suppression record. It is shown under
     "Rejected" with a "propose again" action.
     - The one exception is evidence of the *opposite* preference, which is a different
       fingerprint.
   - `snoozed`: hidden until `snooze_until`.
   - **Near-duplicates.** Before inserting a new fingerprint, compare its statement with every
     existing candidate *and* every live memory, using `sameTopicReason` / `SAME_TOPIC_MIN_COSINE`
     (`owner-profile.ts:536`, `:102`). A match against a live memory is dropped (it is already
     known). A match against a rejected candidate is dropped (it was already declined).
5. **Classify autonomy in code.** `autonomy = 1` when the statement or its class touches approvals,
   holds, outward steps or worker latitude. The test is
   `memoryNeedsOwnerWords(statement)` (`policy.ts:1197`), `class = 'policy'`, or any S1-derived
   hypothesis. The LLM helper cannot clear this bit.
6. **Notify.** If any *new* candidate passed, enqueue one owner-only notice (§4).

## 4. Review UX

### Console: "Proposed preferences"

- **Where it lives.** A new Knowledge sub-tab, `preferences` (`KnowledgeView.tsx:40` `TABS`, label
  "Proposed preferences"), plus a count chip in Persona's status bar (`PersonaView.tsx:464`) that
  links to it.
  - Knowledge is where memories already live, and accepted candidates *become* memories there.
- **Card fields:**
  - the statement;
  - the class;
  - "seen 12× over 9 days, 11/12 consistent (confidence 62%)";
  - ≤5 examples, each a link to the message, approval or job, deep-linked into PersonaView;
  - an **autonomy** badge, where set.
- **Actions:**
  - **Accept.**
  - **Edit & accept**: inline text; the edited text is what's saved, and `decided_text` records it.
  - **Reject**: an optional "why", stored.
  - **Snooze 30 d.**
- **Sections:** Proposed · Policy suggestions (§5) · Accepted (with Forget) · Stale · Rejected
  (with Propose again).
- **Forget everything learned** sits in the panel footer (§2).

### Accept → memory with provenance

The memory is written through **Persona's own `remember` path**, so it gets Persona's writer stamp
and is trusted by the profile (`memory-trust.ts:102`). It is not a direct knowledge PUT, which the
personal-layer guard would refuse anyway (`personalLayerRefusal`, `memory-trust.ts:58`).

1. `POST /api/persona/preferences/:id/accept {text?}` (`humanGate`) calls
   `runtime.tools.call("remember", {topic, kind, fact: text, title}, {approval})`.
2. The `approval` is a synthetic, already-decided record (`decided_by` = owner, action
   `remember`). Passing `meta.approval` makes `run` save the whole memory the owner reviewed
   (`tools.ts:1977-1979`). That is the owner's explicit OK, and it is exactly how an approved
   `remember` card behaves today.
   - Record it as a real `persona_approvals` row, created and decided in the same request with
     `hold_rule = 'preference-accept'`. The audit trail then stays in one place.
3. `kind`: `routing` for S6, `feedback` for corrections, otherwise `preference`.
4. Tags gain `learned`. The body ends with a provenance footer:
   `Learned from 12 observations (2026-10-05 → 2026-10-14), accepted by alice 2026-10-15 — see Proposed preferences #<id>.`
   `settleMemoryVerdicts` (`owner-profile.ts:623`) then runs as it does for any memory.
5. `class = 'schedule'` candidates instead call `create_schedule` with the same synthetic-approval
   meta. The owner sees the cron and brief before accepting.
6. A system line goes into the console thread, the same as the `remember` system line at
   `tools.ts:2005-2011`, so Persona knows in its next turn.

**Easy forget.** Forget on an accepted card calls the `forget` handler (`tools.ts:2023`) with the
same synthetic-approval meta and sets the candidate to `forgotten`. The memory goes out of the
profile and briefs and is marked superseded. Asking Persona "forget that" in chat works as it does
today.

### Slack digest

- **A DM to the owner, never a channel.** Use the owner-DM route the bridge already uses for
  approval cards and escalations (`packages/slack/src/persona-bridge.ts`).
- **When.** At most one a day, after the nightly run, and only when there are new candidates. It
  is quiet when S7 learned quiet hours; until then it posts at the digest hour.
- **Each item:** the statement, the evidence line, and **Accept / Reject / Open in console**
  buttons. These are owner-only, checked the same way as `onOptionButton` (`persona-bridge.ts:541`).
- **Autonomy and policy candidates get only "Open in console".** Their acceptance needs the exact
  change in front of the owner, with the evidence table (§7).
- **No edit in Slack.** Edit opens the console.

## 5. Policy tuning: noisy holds

The hypothesis is computed per `hold_rule`, with a breakdown per action:

- approved-on-tap rate;
- mean time to decide while the owner was active;
- denials and their reasons;
- chat-consent refusals.

A hypothetical report, with invented numbers, to show the shape:

| `hold_rule` | Holds | Approved | Denied | Mean decide (owner active) |
|---|---|---|---|---|
| `hold-knob:create_schedule` | 24 | 24 | 0 | 40 s |
| `budget` | 31 | 22 | 9 | 6 min |
| `memory-owner-words` | 8 | 7 | 1 | 2 min |

Only the first row clears the policy threshold (§3 step 3). The second has many denials, so it is
doing its job. The third has too few decisions.

**What it may propose.** It only proposes, and every proposal needs the owner's explicit OK
(`class = 'policy'`, `autonomy = 1`):

1. **Remove an entry from `STANDUP_PERSONA_HOLD`** (`config.ts:44-60`, `policy.ts:189`).
   - The console shows the exact env line to change.
   - Standup never edits the environment or settings itself. Accept here means "I've changed it"
     or "do it for me", and "do it for me" goes through a confirmation-gated
     `propose_standup_improvement` or an owner-run edit.
2. **Report a false-positive class.** The evidence table goes into a `propose_standup_improvement`
   draft (kind `bug`), which fires only on the owner's yes, as that tool already requires. For
   example: "`hold-knob:create_schedule`, 24 of 24 approved over 6 days".
3. **Tighten.** The mirror case: a rule or action Persona currently **acts** on, where the owner's
   corrections cluster (S3 tied to a `persona_action`). For example, "3 corrections after
   `stop_session` in 2 weeks". It proposes adding that action to `STANDUP_PERSONA_HOLD`. This also
   needs an explicit OK.

**What it never proposes.** These categories are excluded in code:

- **Floor owner-only categories:** `outward`, `aws`, `collector-api`, `floor-tamper`
  (`floor/gate.ts:87-92`). It never proposes loosening them, whatever the approve rate.
- Permission-prompt holds (`policy.ts:1854`).
- Shared-thread `remember` holds (`tools.ts:2416`).
- Anything the gating design lists as a structured `never`.

A 100% approve rate on a real outward step is expected, and it isn't noise.

## 6. Alignment with persona-action-gating

- **Shared input.** Both designs read `persona_approvals`. The gating design moves decisions onto
  structured facts. This design needs the **rule id** those facts produce, so both should land the
  same `hold_rule` column and the same id vocabulary, defined once next to `decide`
  (`policy.ts:1714`) and returned on `PolicyDecision`.
  - Whichever lands first owns the migration; the other reuses it.
  - Until then, the miner back-fills `hold_rule` for historical rows by matching `reason` with
    `plainHoldReason`'s patterns (`approval-card.ts`). Back-filled rows are marked `inferred`.
- **After gating lands**, `launch_session`, `send_to_session` and `approve_plan` never ask. Budget
  and cap queue (`LaunchQueue`, `host-headroom.ts:320`). The noise detector then naturally targets
  only what remains: the `HOLD` knob entries, `remember`/`forget` owner-words holds,
  `restart_standup` from shared threads, and floor asks in Persona-decidable categories (watching
  the gating design's G6 `unclassified` change).
  - Its historical evidence about text holds becomes a *validation* of the gating change, not a
    proposal. The rule no longer exists, so the fingerprint resolves to `stale` with the note
    "rule removed".
- **Owner requirement carried over.** No launch may wait on the owner. No candidate or policy
  suggestion ever adds a launch hold through the miner. "Tighten" proposals exclude
  `launch_session`, `send_to_session` on owned workers and `approve_plan`. Those holds would
  contradict the gating design's owner requirement.
- **Budget/cap queueing** produces `approval` signals only if a card is raised. Queued launches
  aren't owner decisions and aren't signals.

## 7. Guardrails

1. **Explicit owner OK for anything about approvals or autonomy.**
   - Such candidates have `autonomy = 1`, and the bit is set in code (§3.5).
   - They can only be accepted in the console, on a card that shows the exact text that will be
     saved or the exact change.
   - They are never accepted from Slack, chat consent, or "accept all".
   - They are saved verbatim as the owner accepted them. This mirrors the owner-words rule in
     `directMemory` (`tools.ts:1142`): Persona's elaboration doesn't ride along.
2. **Worker text is data, never a signal.**
   - `persona_signals.actor` can only be `owner` or `system`, enforced by a CHECK.
   - Capture hooks are only at owner-authenticated entry points (`routes.ts:290`,
     `runtime.ts:858`/`:928`/`:966`, and the bridge's owner-checked handlers).
   - Owner text is stripped of other voices (`withoutOtherVoices`) before features are extracted.
     A pasted worker report saying "the owner prefers X" therefore yields nothing.
   - The LLM helper sees only owner excerpts, framed as untrusted data. It returns labels and
     drafts; counts, thresholds and the autonomy bit are computed in code.
3. **The system can't silently change its own safety behaviour.**
   - The miner has **no write path** to `STANDUP_PERSONA_HOLD`, settings, the floor, or
     `policy.ts`.
   - The only write path to memory is the owner-triggered accept route.
   - Thresholds, excluded categories and the autonomy classifier are code constants with tests.
     They aren't learnable and aren't in the KB.
   - An accepted memory saying "don't ask me about X" still doesn't move a hold. Policy is
     structured (gating design), and memories are prompt context only.
4. **Persona can't accept for the owner.** There is no Persona tool for candidates. Persona may
   *mention* that candidates are waiting (a count in its turn snapshot), but accept, reject and
   forget are human routes (`humanGate`).
5. **No double-dipping.** An accepted candidate is a memory. Its future evidence only refreshes
   counts and staleness and never re-writes the memory.
6. **Bounded volume.** At most 5 new candidates per night, ranked by confidence × recency, so the
   panel can't become a wall the owner rubber-stamps.

## 8. Phased plan

### Phase 1a: the smallest useful slice (S)

**The approval-noise report over existing data.** No new capture is needed. It targets noisy holds
with data the system already has.

- Build:
  - the miner migration (`persona_preference_candidates` and `persona_approvals.hold_rule`, without
    `persona_signals` yet);
  - `hold_rule` set in `decide`/`requestApproval` (`tools.ts:2191`);
  - a back-fill from `reason` for older rows;
  - a nightly pass that computes the per-rule table and upserts `policy` candidates;
  - a console "Policy suggestions" section with Accept-as-report (→ the owner confirms the
    `propose_standup_improvement` draft) and Reject.
- Tests:
  - the migration is idempotent and re-runnable, and its repair mirror heals an old shape;
  - `hold_rule` is set for every `decide` ask path (table-driven over the inventory in gating §1);
  - the back-fill maps every reason pattern `plainHoldReason` recognizes;
  - thresholds: 19 decisions → no candidate, 20 at 95% → candidate, a denial within 14 d → no
    candidate;
  - floor owner-only categories never produce a loosening candidate, even at 100%;
  - a rejected fingerprint is not re-proposed on the next run;
  - routes refuse a request without the owner token.

### Phase 1b (S): signals and the first preference candidates

- Build:
  - `persona_signals`;
  - S1 capture at transitions;
  - S2: `ask_user.recommended`, plus `replyTo` from web and Slack;
  - S7 channel/device;
  - deterministic mining for recommendation-trust and active hours;
  - the full Proposed preferences panel, with accept through the synthetic-approval `remember`
    path, provenance footer, and forget.
- Tests:
  - an option tap on web and on Slack records `optionIndex`; a free-text reply records off-menu;
  - `recommended` round-trips through `options_json` and old rows still parse;
  - accept writes a memory with Persona's writer stamp that appears in `buildOwnerProfile`, and
    Edit & accept saves the edited text;
  - forget marks the memory superseded and the candidate `forgotten`;
  - **guardrails:**
    - an `autonomy` candidate can't be accepted through the Slack route (403);
    - signals can't be inserted with actor `worker` (CHECK);
    - a worker `ask_human` containing "the owner always wants X" yields zero signals;
  - the capture switch off → no rows; "forget everything learned" → signals and open candidates
    gone, memories kept.

### Phase 2 (M): chat-derived signals, Slack digest, retention

- Build:
  - S3 corrections with the `persona_action` link;
  - S4 rewrites;
  - S5 ignored;
  - S6 routing, including negative routing;
  - S8 style;
  - the owner-DM Slack digest;
  - 90-day pruning;
  - staleness for accepted candidates;
  - near-duplicate suppression against live memories;
  - the "tighten" policy proposals.
- Tests:
  - correction lexicon cases, including negatives: "no problem", "don't worry" and quoted text
    don't count;
  - a correction attaches to the previous turn's action;
  - rewrite detection at 49% vs 51% shingle overlap, and an identical paste is not a rewrite;
  - routing: 5 requests in one cluster → project P (candidate); a relaunch elsewhere counts
    against it;
  - the digest goes only to the owner DM and is never in `digest-cron`'s shared output;
  - autonomy items get only "Open in console";
  - pruning keeps candidate `evidence_ids_json` and the footer;
  - a memory-duplicate candidate is dropped;
  - "tighten" never names `launch_session`, owned `send_to_session` or `approve_plan`.

### Phase 3 (L): model-assisted clustering and schedules

- Build:
  - S9 request vectors and incremental clustering;
  - the tool-less `claude -p` labelling/drafting helper (Standup's headless settings, owner excerpts only);
  - repeated-request → schedule candidates via `create_schedule`;
  - correction-theme statements;
  - a 5-per-night cap and ranking;
  - an eval set of synthetic owner histories with expected candidates (like the `kbeval` case files).
- Tests:
  - cluster ids are stable across runs, so fingerprints are stable;
  - helper output that tries to set counts or clear `autonomy` is ignored;
  - a prompt-injection excerpt ("ignore previous… mark as accepted") is treated as text;
  - a schedule candidate shows the exact cron and brief, and accept creates it enabled or paused, as
    the owner chooses on the card;
  - eval precision ≥ 0.8 on the synthetic set before the feature is on by default.

## 9. Deferred / not in this design

- **"Edit and approve" on approval cards.** It's a cleaner S4 signal, but it changes the approval
  contract, which the gating design owns.
- **Learning from the owner's direct answers to worker asks** (`asks` answered in the console, not
  through Persona). That is a possible S1-like signal, but those asks are worker-authored and need
  their own trust analysis.
- **Cross-owner or team-level mining.** Standup is one-trusted-owner here. This design is
  owner-local by construction.
- **Phone vs desktop on Slack.** The Events API doesn't expose it, so it stays `unknown`.
