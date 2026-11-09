# Persona action gating: structured facts at the decision, the safety floor at execution

Status: proposed. Scope: `packages/collector/src/persona/policy.ts`,
`persona/tools.ts`, `floor/*`, `plan-gate.ts`, `launcher.ts`.

## Owner requirement (overrides the options analysis)

1. **No `launch_session` from Persona ever needs the owner's input.** Persona owns its workers.
   Brief text is never classified. A launch waits only on structured limits (daily budget, active
   cap, host headroom), and it **queues** rather than raising a card.
2. The same holds for Persona's other actions on its own workers: **`send_to_session`** and
   **`approve_plan` / `reject_plan`**.
3. Real protection lives where an action actually runs: the **worker safety floor**. Every floor gap
   this makes load-bearing must be listed with how to close it, so that no prose is trusted
   anywhere.

Line numbers are those of the code when this design was written; they drift as the code changes.

## 1. Inventory: every place the policy can hold a Persona action

Every Persona tool call goes through `decide(name, prepared.ctx, settings)` (`persona/tools.ts:2415`).

- **`never`** → refused (`:2419`).
- **`ask`** → an approval card (`requestApproval`, `:2436`), unless the owner's chat message in the
  last 30 minutes passes `checkChatConsent` (`:2422`).
- **Shared threads** narrow first: `outOfScope` (`:2409`) applies, and `remember` is forced to ask
  (`:2416`).
- **Launches** have a second call site at `tools.ts:2287`.

`decide` (`policy.ts:1714`) takes `baseVerdict` and turns an `act` into `ask` for actions the owner
lists in `STANDUP_PERSONA_HOLD`.

| Action | Where | Signal checked | Decision |
|---|---|---|---|
| Reads (`list_*`, `session_status`, `read_session`, `recall`, `ask_user`) | `policy.ts:1766` | action name | act |
| Job bookkeeping, wakeups | `:1767` | action name | act |
| `remember` | `:1769-1796` | **text**: `writesCollectorApi`, `memoryNeedsOwnerWords`, `ownerQuoted`/`ownerAskedToRemember` against owner turns | act / ask |
| `forget` | `:1798-1803` | **text**: `ownerAskedToForget` against owner turns | act / ask |
| `launch_session` | `launchVerdict` `:1723-1734` | `projectLaunchable` (structured) → never; **brief text** via `textVerdict` (`:1518`) → ask; `launchesToday ≥ budget` → ask (`:1729`); `active ≥ cap` → ask (`:1732`) | never / ask / act |
| Host headroom on launch | `launcher.ts:61`, `host-headroom.ts` (`LaunchQueue`) | `/proc/meminfo`, `/proc/loadavg` | **queues** (already structured) |
| `create_/update_schedule` (launch_job) | `scheduleVerdict` `:1746-1763` | `scheduleLaunchChanged`, `projectLaunchable`; **brief text** via `textVerdict` | never / ask / act |
| `run_schedule_now` | `:1749-1755` | as `launch_session` | as launch |
| `delete_schedule`, wake_persona schedules | `:1748` | action / kind | act |
| `restart_standup` | `:1809-1817` | `privateThread` (structured) | act / ask |
| any session action on an unowned session | `:1819` | `owned` (structured) | never |
| `send_to_session` | `:1821-1843` | `workerBypassed` + leading `!` (structured, `:1825`) → never; `sendMode now` + `permissionPending`/`!workerAtPrompt` (structured, `:1831`) → never; **text** via `textVerdict` → ask | never / ask / act |
| `interrupt_session`, `stop_session` | `:1821` | `owned` | act |
| `waive_pipeline_stage` | `:1821` | `owned`; the collector then refuses it unless the worker's launch changed no code (`pipeline/engine.ts` `notApplicableRefusal`) | act |
| `answer_ask` | `:1845-1864` | `askGate`: idle notice → never (`:1846`); floor gate → `floorVerdict` (`:1570-1588`, structured gate + category, plus **text** on `safety_floor` allows); other gate → ask (`:1851`); permission prompt (`askKind !== ask_human`) → ask (`:1854`); ask_human → **text** via `textVerdict` over Persona's answer **and the worker's question** (`authorizes`, `tools.ts:1656`) | never / ask / act |
| `approve_plan` / `reject_plan` | `:1866-1885` | **note text** via `textVerdict`; **acceptance criterion** via `criterionRisk` (`:1694`, allowlist `CHECK_COMMANDS` `:1642`); `HOLD_ACCEPTANCE_CRITERION` knob | ask / act |
| approve_plan side effect | `tools.ts:1713-1718` | `planOutwardSteps` (**text**) over plan + criterion | not a hold: appends a "local work only" reservation to the note |

`textVerdict` (`policy.ts:1518-1543`) is the single prose classifier behind every **text** cell:

- `writesCollectorApi`.
- `outwardStep(..., {honorNegation:false})` on the worker text Persona consents to.
- `outwardMatches` (`:985`, vocabulary `OUTWARD_FACING` `:416`) on Persona's own text, with
  negation, reported-speech, past-tense and hand-off masking.

## 2. Root cause, with evidence (illustrative holds)

The four holds below are invented examples of the false-positive pattern, one per frame the
classifier misreads. A1–A4 are labels used again in §5.

| Example | Action | Recorded reason | What matched |
|---|---|---|---|
| A1 | approve_plan | "the acceptance criterion … is not a plain build or test command in the worktree" | `criterionRisk` allowlist, on the criterion `bunx prettier --check src && test -z "$(git status --porcelain ../shared)"`. `bunx` has no entry, `$(` is in `SHELL_SYNTAX`, and `PLAIN_ARG` bans the `..` in `../shared`. The note itself passed. |
| A2 | launch_session | "the text asks for an outward-facing step ("deploy")" | A **do-not list** in the brief: "Leave anything that publishes a package, tags a release, sends a notification or deploys to the owner." Also the test fixtures the brief quotes as cases to keep: `"npm publish"`, `"git push --tags"`, `"terraform apply"`. |
| A3 | send_to_session | same, ("deploy") | Steering text that **quotes a review comment as data**: "The reviewer wrote 'this deploys to staging on merge'. Check that the fixture still covers that case." |
| A4 | launch_session | same, ("deployed") | A follow-up brief that **quotes the last run's summary**: "Previous run: nothing was pushed or deployed, and the branch is local only." Chat consent refuses the same text. |

Fed line by line through `outwardMatches`, each text would produce the hold shown. §5 lists the
tests to write for them ("New tests that prove the four cases act").

**Why patching didn't converge.**

- `policy.ts` has a long run of commits that each tune the same classifier: "holds instructions …
  not mentions", past-tense and hand-off masking, and others.
- Each patch masks one new linguistic frame: negation, mention vs use, reported speech, past tense,
  hand-off. Persona's briefs are written about safety, so they routinely contain the vocabulary
  they forbid, in frames nobody enumerated: do-not lists, test fixtures, quoted comments and
  summaries.
- A past-tense mask covers "was released" and "the owner would run `x`". It has no frame for
  "leave X, Y or Z to the owner" or for "nothing was pushed or deployed". The space of frames is
  open, and the reason names only the first hit, so fixing one exposes the next.
- **Outcomes:** when nearly every text hold is a false positive, the owner learns to tap through
  them, and the card stops being a check.
  - The holds worth denying are mostly not outward steps at all. Think of Persona telling a worker
    to commit with `-c core.hooksPath=/dev/null` (a hook bypass, which is floor-adjacent), or to
    write to the collector API.
  - The classifier would catch such a text only by accident, on a word like "commit", not for
    what makes it risky.

The classifier answers the wrong question. It asks "does this prose mention an outward step?",
when the question that matters is "will an outward side effect execute?". Only the execution point
can answer that.

## 3. Threat model

Persona is an LLM that reads untrusted text: worker transcripts, checkpoints, asks, KB docs, plan
text and Slack threads. A text hold is meant to stop an injected or confused Persona from making a
worker do something outward or irreversible.

| # | Threat | Today's text hold | Does the floor stop it at execution? |
|---|---|---|---|
| T1 | Persona briefs/steers a worker to `git push` / `gh pr create` / `cdk deploy` / publish | `textVerdict` (unreliable both ways) | **Yes** for bypass-mode Claude workers. Bash is parsed (`floor/shell.ts`, `classify.ts:1017-1024`), outward → `outward`, an owner-only category (`floor/gate.ts:87-92`). Persona can't allow it: `floorVerdict` `policy.ts:1577-1585`, server check `server.ts:4614-4632`. |
| T2 | Persona tells a worker to tamper with the floor (edit hooks/settings, `core.hooksPath`, `NODE_OPTIONS`) | caught only by accident | **Yes** for writes to floor files and env hooks (`classify.ts:969-977`, `:1178-1238`). **Gap G7** for `git -c core.hooksPath=…`. That disables repo hooks, not the floor, so it's weaker, but it should still be classified explicitly. |
| T3 | Worker calls an outward MCP tool (review creator, issue tracker, Slack) | — | **By name only** (`classify.ts:895-928`). Write-verb names → `outward`. Unclear names → `unclassified`, which Persona may allow (**G2**, **G6**). |
| T4 | Worker calls Standup MCP tools that message others (`message_session`, `propose_ticket`, notify, `propose_standup_improvement`) | — | **No**. Standup MCP is allowed unless it sets owner fields (`classify.ts:900-903`) (**G1**). |
| T5 | Data leaves through WebFetch/WebSearch query strings | — | **No**. WebFetch is held only for the collector (`classify.ts:852-856`), and WebSearch is in `SAFE_TOOLS` (**G3**). |
| T6 | HTTP in worker-written code (`fetch(process.env.URL,{method:"POST"})`, a GET carrying data, deps in `node_modules`, compiled binaries) | — | **Partial**. A write is held only with a remote URL literal (`classify.ts:2133-2137`). GETs, env URLs and binaries pass (**G4**, **G5**). |
| T7 | Unknown bespoke CLI that deploys/notifies | — | Only if the vocabulary matches (`classify.ts:2864-2890`) (**G5**). |
| T8 | Persona allows an `unclassified` floor hold (eval, unparseable, unclear MCP) | `textVerdict` on the question (blind to what the command does) | Persona may allow it (`policy.ts:1583-1588`) (**G6**). |
| T9 | Worker without a floor: non-bypass auto mode, pinned `--permission-mode`, Codex, floor unavailable | — | **No floor** (`launcher.ts:1064-1068`, `:1295-1321`). Auto mode still raises Claude permission prompts, which Persona can't answer (`policy.ts:1854`). Codex relies on its own profile (**G8**). |
| T10 | Acceptance criterion runs worker-written code as the owner (`/bin/sh -c`, AWS/git creds kept) | `criterionRisk` allowlist on the *text* | **No**. `checkAcceptanceCriterion` (`plan-gate.ts:68-95`) runs outside the floor. `bun test` runs whatever the worker wrote after approval, so the allowlist only screens the first word (**G9**). |
| T11 | In-place launch: the owner's checkout is the worker's ground | — | Writes in-repo aren't held. Repo `.git/hooks` run and are scanned leniently (`classify.ts:5364-5376`). Commits on `main` are held as outward (`:4998-5003`) (**G10**). |
| T12 | Persona leaks secrets or private context into a brief or steering text | — | Out of scope for the floor. The worker is the owner's own agent, so a leak only matters once something is sent outward, which is T1/T3–T6. |
| T13 | Runaway fan-out (launch storm) | budget/cap → ask | Structured. Should queue (see §5). |

### Floor gaps made load-bearing, and how to close them

Without prose holds, these become the only line. Close each before or with the policy change.
**P0 items are blocking.**

- **G9 (P0) Acceptance criterion runs outside the floor.**
  - Run it through the floor classifier at execution time. In `plan-gate.ts`, classify
    `["/bin/sh","-c",criterion]` with `floor/classify.ts` (the same shell parser, package.json
    script, script-file and import following) against the worktree root.
  - An owner-only category means the criterion is not run. It fails with a floor ask to the owner
    at run time. Other holds → Persona may allow, as today.
  - Also scrub AWS/git credential env (`AWS_*`, `GH_TOKEN`, `GIT_ASKPASS`, `SSH_AUTH_SOCK`) from
    `scrubSecretEnv`.
  - This replaces `criterionRisk` at approve time.
- **G8 (P0) Launches without a floor.**
  - Persona launches must run either under the floor (bypass + hook) or in a posture where every
    tool call that isn't auto-allowed becomes a Claude permission prompt. Persona can't answer
    those (`policy.ts:1854`).
  - Codex launches from Persona are refused (`never`, structured) until Codex has an equivalent
    execution gate.
  - A floor-unavailable fallback to `auto` is fine, because auto still prompts. Record the posture
    on the launch for audit.
- **G1 (P0) Standup MCP tools that reach other people.**
  - Classify by tool name in `classify.ts` `mcpTool`:
    - `message_session` to a session outside the worker's own job → `outward`.
    - `propose_ticket` / `propose_standup_improvement` / any notify or Slack-posting tool →
      `outward`, or keep them as already-confirmation-gated tools (verify each one's server-side
      gate).
  - `checkpoint`, `ask_human`, `search_knowledge`, `propose_knowledge` (own KB) and `submit_plan`
    stay allowed.
- **G6 (P0) Persona allowing `unclassified`.**
  - With prose gone, "Persona may allow what the floor couldn't read" is the remaining hole.
  - Make `unclassified` owner-only when the unreadable part is the program word, `eval`,
    decode-then-exec or an unclear MCP name.
  - Keep it Persona-decidable only for budget exhaustion on a parsed command. Persona can always
    deny.
- **G2 (P1) MCP name heuristics.**
  - Add an explicit per-server allowlist of read-only MCP tools (for example a docs server's
    `SearchDocs` and `ReadDoc`).
  - Every other non-Standup MCP tool → `outward`, instead of guessing from words.
- **G4/G5 (P1) Code-level HTTP and binaries.**
  - Hold any HTTP client call in scanned code whose URL isn't a literal loopback or worktree path,
    for any method.
  - Hold execution of a binary built in the worktree (`./t` after `go build -o t`) as
    `unclassified` → owner-only, per G6.
  - This is a heuristic too, so the fail-closed default is what matters.
- **G3 (P1) WebFetch/WebSearch.**
  - Allow WebFetch GETs only to a domain allowlist (docs sites) and hold others as `outward`.
  - Leave WebSearch allowed: it's a query to a search provider, low risk, so this is accepted
    residual risk. The doc records that.
- **G7 (P2)** Classify `git -c core.hooksPath=…`, `--no-verify` and `GIT_DIR`/`GIT_CONFIG_*`
  overrides as `floor-tamper` when they point outside the worktree's isolated hooks. Inside an
  isolated worktree it's allowed. That was the workaround Persona was trying to give.
- **G10 (P2)** In-place launches: enforce worktree hook isolation, or scan repo hooks strictly
  (non-lenient), for Persona-launched in-place workers.

The floor's own fail-closed properties (`gate.ts:258-273`, `hook.ts:83-103`), inline `--settings`
(`gate.ts:280-297`) and server re-classification (`floor/routes.ts:127-138`) are what make it
trustworthy as the single gate. Keep them covered by tests.

## 4. Options

**(a) Drop text classification for orchestration actions within budget, and rely on the floor.**

- **Pros:** ends this false-positive class outright. It matches the owner's requirement. The
  decision becomes predictable.
- **Cons:** gaps G1–G10 become load-bearing at once.
- **Residual risk:** exactly the open gaps. It's unacceptable before the P0 gaps close, and
  acceptable after.

**(b) Gate on structured facts instead of prose.**

- **Facts:** action type, target ownership (`owned`, job), budget/cap/headroom, project flags
  (`launchable`, `reserved`, `inPlace`), launch posture (floor on, prompting, or Codex), the
  pending ask's server-set gate and floor category, pane state (`sendMode`, `workerAtPrompt`,
  `permissionPending`), and the `!`-escape on bypassed workers.
- **Pros:**
  - Deterministic.
  - Can't be confused by quoting.
  - Every input is server-set and not authored by Persona, so injection can't flip it.
- **Cons:** can't express intent. It simply stops trying to, which is correct, because intent is
  enforced at execution.
- **Residual risk:** same as (a), plus mistakes in the structured facts themselves. Those are
  testable.

**(c) Keep the classifier as a non-blocking annotation or audit log only.**

- **Pros:** keeps visibility. The console can flag "brief mentions deploy" and audits can look for
  drift.
- **Cons:** a second code path to maintain. Noisy annotations train the owner to ignore them.
- **Residual risk:** none added; it never blocks.

**(d) Close the floor gaps first, then (b), with (c) narrowed to two uses.** This is the
recommendation.

- **Use 1:** the plan-approval reservation note (`planOutwardSteps`, `tools.ts:1713`). It's
  advisory text to the worker.
- **Use 2:** an audit line on the approval or launch record.
- **Never** a hold.

## 5. Recommendation and migration

Adopt **(d)**. Close G9, G8, G1 and G6 (P0) first, then switch the policy, then the P1/P2 floor
work.

### Policy changes (`policy.ts`, `tools.ts`)

- **`launchVerdict`:**
  - Remove `textVerdict`.
  - Keep `projectLaunchable` → never.
  - Add the posture check from G8 (Codex → never).
  - Budget or cap reached → **queue**, not ask. Reuse `LaunchQueue` (`host-headroom.ts`): the
    launch waits and starts when a slot or the next day's budget frees. The tool returns
    `status: queued` with a position.
  - No `ask` path remains for launches.
- **`scheduleVerdict`:** drop `textVerdict` on the stored brief. Each scheduled run is a launch, so
  it queues the same way.
- **`send_to_session`:** drop `textVerdict`. Keep the structured `never` rules (`policy.ts:1825`,
  `:1831`).
- **`approve_plan` / `reject_plan`:** drop `textVerdict` on the note and `criterionRisk`. The
  criterion is gated at run time (G9). The `acceptance_criterion` owner knob moves to run time
  too: the owner can require a card before the criterion runs.
- **`answer_ask`:**
  - `ask_human` answers: drop `textVerdict` on Persona's answer and the `authorizes` check of the
    worker's question.
    - A worker that then tries the outward step hits the floor, which is owner-only.
    - An ask that merely *asks permission* for an outward step is answered "go ahead" by Persona.
      The step still stops at the floor and becomes an owner card **there**, showing the exact
      command.
  - Floor asks keep `floorVerdict`, but drop its `textVerdict` line (`:1586`). Category plus gate
    decides. With G6, `unclassified` → owner-only as described.
  - Permission prompts stay held (`:1854`), which is structured.
- **Collector-API references:** `writesCollectorApi` in texts is a prose check too. The floor
  already holds collector calls as `collector-api`, owner-only. Drop it from Persona actions.
- **Kept (structured):** `owned` → never, `!`-escape, pane state, `restart_standup`'s
  `privateThread`, shared-thread `outOfScope`, the `STANDUP_PERSONA_HOLD` knob (owner tightening
  only), and memory rules.
  - Memories are not orchestration and stay out of scope here. `memoryNeedsOwnerWords` is prose,
    but it protects the owner's preference store, not execution. Revisit separately.
- **Chat consent** (`checkChatConsent`) stays for `ask`s that remain: restart from a shared
  thread, permission prompts, and the `HOLD` knob.
- **Remove** the parked narrow `criterionRisk` patches. They aren't committed.

### Tests that change

- `policy.test.ts`:
  - The 4 `criterionRisk` blocks (`"persona policy: plan approval"`, ~85 cases) are rewritten as
    run-time floor-classification tests for `plan-gate.ts`.
  - The outward-step corpus cases that assert `send_to_session` / `launch_session` / `approve_plan`
    *hold* are converted to `act`.
  - `outwardMatches` unit cases stay: the floor still uses the vocabulary per argv
    (`classify.ts:2880-2890`).
- `policy.launch-hold.test.ts`: assertions that a brief line holds a launch flip to `act`.
  Budget/cap cases assert `queued`, not `ask`.
- `policy.chat-consent.test.ts`: drop cases for launch/send/approve. Those actions no longer ask.

### New tests that prove the four cases act

Each feeds the text of one example from §2 through `decide`:

- **A2:** launch with the brief and its do-not list, 4/20 launches, 1/6 active → `act`.
- **A3:** `send_to_session`, owned, `next_turn`, the steering text with the quoted review
  comment → `act`.
- **A1:** `approve_plan` with the note and criterion → `act`. The plan-gate test classifies the
  same criterion with the floor → allowed (a local formatter check and a read-only `git status`).
- **A4:** launch with the brief that quotes "nothing was pushed or deployed" → `act`.
- **Budget/cap:** at 20/20 or 6/6 → `queued`, never `ask`. Host headroom short → `queued`.
- **Structured `never`s still hold:** unowned session, unlaunchable project, Codex launch, `!` on a
  bypassed worker, `now` on a busy pane.

### New tests that prove real outward attempts still stop at the floor

These are `floor/classify.test.ts` and route tests. Each asserts an owner-only category, and that
Persona's allow is refused by `floorVerdict` and by `server.ts:4614-4632`:

- **Bash:** `git push origin HEAD`, `git push` from a package.json script, `npx cdk deploy`,
  `gh pr create`, `corp-review --revise R-1`, `npm publish`, `aws s3 cp`, `git merge` on `main`, and the same
  inside `bash -c`, `make deploy` and a `.ts` file run by bun.
- **G9:** criterion `bun test && git push`; and criterion `bun test` where the test file
  `fetch`es a remote POST → criterion not run, owner floor ask.
- **G1:** `mcp__standup__message_session` to a foreign session and
  `mcp__standup__propose_ticket` → `outward`.
- **G2:** `mcp__corp-mcp__UpdatePullRequest`, `mcp__corp-mcp__CreateTicket` and an unlisted
  `mcp__x__QueryAndUpdate` → `outward`.
- **G6:** `eval "$CMD"` and an unclear MCP tool → owner-only. Persona's allow is refused.
- **G7:** `git -c core.hooksPath=/dev/null commit` in a non-isolated checkout → `floor-tamper`.
- **G8:** a Persona launch that resolves to Codex → `never`. A floor-unavailable launch records
  posture `auto` and Persona can't answer its permission prompts.

### Order

1. Floor P0: G9 plan-gate classification + env scrub, G8 posture rule, G1, G6, each with tests.
2. Policy switch: drop the text holds, queue on budget/cap, and the four regression tests.
3. Floor P1/P2: G2, G3, G4/G5, G7, G10.
4. (c) audit annotation on launch/approval records (optional).

## Implementation notes (recommendation (d), as built)

- **Policy:** `textVerdict`, `criterionRisk` and `isRefusal` are gone. `launchVerdict` refuses an
  unlaunchable project or a non-Claude harness (`launchHarness`), and otherwise acts. Past the
  budget or cap it acts with `queued` set (`launchCapacity`).
- **Launch queue:** the queue is durable (`persona_launch_queue`, migration 055).
  - `runCall` and `launchScheduled` enqueue the launch. The same task from the same thread dedupes
    to the row already queued.
  - The runtime tick drains the queue oldest first, as far as there is room, under the queued
    call's thread, and posts a system line when a launch starts or fails.
  - A queued scheduled run is recorded as skipped with a `queued (<id>)` reason. Its launch keeps
    the run's idempotency key.
- **G9:** implemented in `floor/criterion.ts`, called from `evaluatePlanReadyGate`.
  - The ask's request id is `criterion:<gate>:<callHash>:<n>`. An allow is claimed once, and a
    denial raises no new card.
  - `STANDUP_PERSONA_HOLD=acceptance_criterion` holds every criterion of a Persona-owned launch
    as a floor ask Persona decides, even one the floor would let run. Standup raises no owner card
    for it; Persona escalates with ask_user.
  - The criterion runs under `scrubCredentialEnv`. Owner-authored orchestration-profile steps keep
    `scrubSecretEnv`.
  - Test files run by `bun test` are not scanned. The criterion gets the same floor the worker's
    own `bun test` gets, with a stricter environment.
- **G6, not adopted:** `unclassified` stays Persona-decidable. Most Persona-decidable
  unclassified floor holds in practice are allowed. Common worker idioms such as heredocs and sed
  scripts land there, and making them owner-only would move those cards to the owner. G2 already
  makes unclear MCP names `outward`.
- **G1:** `message_session` is outward for every target. The hook has no job membership, and a
  server allow can't loosen the hook's hold. `create_project` is outward too.
- **G7:** `GIT_CONFIG_*` env is floor-tamper everywhere, since it can also set `core.sshCommand`.
  Hooks are treated as isolated when they are Standup's empty worker-hooks dir, or the worktree's
  own hooks outside a strict-hooks (Persona in-place) launch.
- **Also closed:** `git remote` add/set-url/remove is outward, because remotes live in the shared
  repository config.

## Deferred / not in this design

- `remember` / `forget` prose checks: owner preference store, separate question.
- Codex execution gate: needed before Persona may launch Codex workers.
- WebSearch exfiltration: accepted residual risk.
