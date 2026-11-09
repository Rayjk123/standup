# Per-user Persona

Every authenticated user gets their own Persona: their own private threads (console and Slack DMs),
profile and memories, jobs, wakeups and schedules, and approval cards. Each Persona takes direction
only from its own user. Sessions stay shared as before.

Terms: the **host** is `hostUserAlias()` — the Unix user the collector and every worker run as, whose
credentials (cloud credentials, ssh, the code review CLI, SSO cookies, git remotes) every worker inherits. A **guest** is any other
authenticated alias.

**Privacy boundary.** A user's Persona data is private from other users through Standup's API,
WebSocket, console and Slack (the host's admin view excepted). It is not private from workers on this
host: they run as the host's Unix user and can read the collector's database (`standup.db`) and data
directory directly, which the safety floor allows today. Holding those reads is a floor change, not
part of this design.

## Identity

Per-user Persona rides the existing identity path: the proxy-authenticated identity header
(`STANDUP_IDENTITY_HEADER`) resolved by `actingAlias` (trusted only from loopback or a configured trusted proxy), the
`actors` table, `sessions.created_actor`, `launches.requester` and `session_participants`.

The caller of a `/api/persona/*` route is resolved server-side, never from a body `actor`:

1. A request carrying a valid **runtime token** (a Persona's own in-process tool calls and turn MCP
   proxy) acts as that runtime's owner.
2. A request carrying the **owner secret** (`x-standup-owner-token`) plus `x-standup-persona-user:
   <alias>` acts as `<alias>`. Only owner channels hold the secret — the Slack bridge uses this to
   speak for the Slack user it authenticated.
3. Otherwise `actingAlias(c)` (the identity header, else the host on loopback, else `anonymous`).
   `anonymous` is refused.

### Every human route needs a human-channel proof

Workers share the host's Unix user and loopback, so a worker could set the identity header itself.
Every human `/api/persona/*` route — reads (state, messages, threads, jobs, approvals, schedules,
attachments, hold report, knowledge decisions) as well as writes (posting a message, deciding a card,
pausing, editing a schedule) and the host's admin routes — therefore needs one of:

- the owner secret, for the host (unchanged: the console proxy adds it for the host's signed-in
  browser);
- the owner secret plus `x-standup-persona-user` (an owner channel speaking for a user);
- the **user channel token** `x-standup-user-token: hmac-sha256(ownerSecret, "user:" + alias)` for the
  caller's own alias. The console's dev-server proxy adds it only for a browser holding a valid signed
  `standup_user` cookie whose alias equals the request's identity header. The cookie comes from a login
  link minted by `scripts/console-login.ts --user <alias>` (run by the host) or sent by the Slack
  bridge to a Slack Persona user (listed in `SLACK_PERSONA_USERS`) who DMs `login`. The host DMing
  `login` is pointed at `bun run scripts/console-login.ts` instead.

Without one the route answers 403 `sign-in` (an anonymous caller 401 `unauthenticated`). The one
exception is `GET /api/persona/state`, which answers an unproven caller 200 with only `{ runState:
"idle", hostAlias, isHost, canWrite: false, reason: "sign-in" }` — no owner, thread, counts or
errors — because the restart supervisor's health probe reads it without credentials and the console
shows its sign-in prompt from it.

This holds for the host too: being on the host machine is not a proof. A host
browser that hasn't signed in with `scripts/console-login.ts` carries no proof, so its Persona reads
get the same `sign-in` answers and the console shows the sign-in note instead of the host's Persona.

### WebSocket `persona:*` frames

The WS upgrade records which Persona audience the socket proved, with the same proofs: the owner
secret proves the host (with `x-standup-persona-user`, the user it names); a service relay
(`SERVICE_CLIENT_HEADER`) holding the owner secret is a **Persona relay** and receives every user's
`persona:*` frames (the Slack bridge, which routes them by audience); a valid user channel token
proves the alias the upgrade resolved to. An addressed `persona:*` frame goes only to sockets whose
proven audience is its audience, or to Persona relays, and only under an allowed `Host`. A forged
identity header proves nothing, so such a socket receives no `persona:*` frame. Other addressed
frames still go by resolved identity, never to a service relay.

### Personal knowledge

A knowledge read unlocks a non-host user's personal layer (scope=user docs, Persona memories) only
with that user's own channel proof: their user channel token, an owner channel naming them (owner
secret plus `x-standup-persona-user`), or their own Persona runtime's token or writer secret. The
identity header alone, which any loopback worker can set, reads as global ∪ project only. The host
is the header-less loopback fallback and reads its own layer as before. Over WebSocket, personal
`knowledge:change` frames and the hello-ok knowledge changes go only to a socket that proved that
user.

## Runtime

`PersonaFleet` (`collector/src/persona/fleet.ts`) holds one `PersonaRuntime` per active user. The
host's runtime starts at boot; a guest's is created on their first proven Persona **write** and
re-created at boot for every owner with a `persona_state` row, so their schedules keep firing. A read
never builds a runtime or writes a row: a user without one reads their stored rows (lists come back
empty), and their state is synthesized as idle (`threadId: ""` until a console thread exists). Each
runtime starts exactly once (`start()` is a no-op while running). Each runtime has its own Persona
token, writer secret and turn cwd (`PERSONA_CWD` for the host, `PERSONA_CWD/users/<alias>` for a
guest).

Restart hold: `fleet.quiesce()` holds every runtime and the fleet itself, so a runtime built during
the hold is held before it starts; a turn that was waiting for a host-wide turn slot when the hold
began releases the slot without running and returns its claimed items to pending.

At boot, idle notices of a worker are taken by its Persona only when its job owner's runtime runs and
can act (`fleet.get(owner)?.canAct()`); stored owners left without a runtime (an invalid alias, past
`STANDUP_PERSONA_MAX_USERS`) are logged and their workers surface to the human.

Limits:

- per user: `STANDUP_PERSONA_MAX_ACTIVE` launches and the per-owner launch queue (unchanged);
- per host: `STANDUP_PERSONA_MAX_CONCURRENT_TURNS` (default 2) Claude turns at once across every
  runtime, and `STANDUP_PERSONA_MAX_USERS` (default 10) runtimes;
- plus the existing host-headroom view.

## Data (migration 059)

All additive and idempotent:

- `persona_approvals.approver` — who must decide the card; NULL means its owner.
- `asks.answered_by` — who resolved an ask or a floor hold (audit).
- `persona_user_access(alias, enabled, launch_projects_json, updated_by, updated_at)` — the host's
  allowlist of projects a guest's Persona may launch into. No row means no launches.

Every other Persona table was already keyed by `owner`.

## Security defaults

A guest's workers act with the host's identity, so:

- **Launch allowlist.** A guest's Persona may launch only into projects in their
  `persona_user_access.launch_projects`; the default is none. Reserved projects and floorless
  harnesses stay refused for everyone. The collector checks the allowlist before the launch route's
  idempotency dedupe, so a key can't resolve a guest's Persona to someone else's launch.
- **Images.** A guest's `attach_image` reads only inside its own turn cwd and the worktrees of its own
  jobs' launches and sessions (checked on the path as given, as resolved and as opened).
- **Every floor hold goes to the host.** In a session owned by a guest Persona's job, the guest's
  Persona may deny a floor hold, but an allow — on either gate — becomes a card whose approver is the
  host, and the collector refuses a guest runtime's Persona-token allow outright. The setting
  `persona.guest_floor = "split"` (off by default) lets the guest's own card decide the
  non-credential categories (`review`, `destructive`, `unclassified`); owner-only categories always go
  to the host.
- **Host-only tools.** A guest's Persona can't restart Standup, change project repos, decide
  knowledge drafts, or use the owner secret except to carry out a card the host approved.
- **Attribution.** A guest Persona's launches record `requester` = the guest (from the runtime
  token); the worker is told who it works for and that outward steps go to the host;
  `asks.answered_by` and the floor log lines name the decider and the Persona owner.

## Approvals routing

| Hold | Card goes to |
|---|---|
| A guest Persona's own policy holds (launch, remember/forget rules, shared-thread restart) | the guest |
| `ask_human` / plan gates from a guest's workers | the guest's Persona, then the guest |
| Any floor hold in a guest's worker (default) | the host, labelled with the guest's name |
| Tool-permission prompts | the host |
| Sessions not owned by any Persona | unchanged (`responsibleAlias`; owner-only floor holds go to the host) |

The approve/deny routes require the decider to be `approver ?? owner`. Web and Slack show a user the
cards they must decide; Slack posts each card to the approver's DM. A card whose owner has no
runtime on this collector (the fleet is full) can still be denied: the card moves to `denied` and the
result waits in the owner's inbox for their Persona's next turn. Approving it needs the runtime
(503 `unavailable`).

## HTTP surface

- `GET /api/persona/state` — the caller's Persona, plus `hostAlias`, `isHost`, `canWrite` (`host`
  stays the host-headroom view).
- `GET /api/persona/approvals` — cards the caller owns or must decide (each carries `owner`).
- Host only (owner secret, caller is the host):
  - `GET /api/persona/users` — every user's Persona: `running`, state (`null` for a user with neither
    a runtime nor stored Persona state, e.g. listed only by an allowlist), pending counts, allowlist;
  - `GET /api/persona/{state,threads,messages,jobs,approvals,schedules,schedules/:id/runs}?user=<alias>`
    — read-only view; builds no runtime;
  - `POST /api/persona/users/:alias/pause|resume`;
  - `PUT /api/persona/users/:alias/access` `{ launchProjects: string[], enabled?: boolean }`.
- Refusals carry a `reason`: `unauthenticated` (anonymous caller), `sign-in` (a request without a
  channel proof), `host-only`, `unavailable` (no runtime can be built for the user).

## Onboarding a guest

1. `bun run scripts/console-login.ts --user <alias>` and send them the printed link (or they DM
   `login` to the Standup Slack app, once Slack is set up for them — step 3).
2. To let their Persona launch workers: `PUT /api/persona/users/<alias>/access` with the projects, or
   the People panel on the host's Persona tab.
3. To give them their Persona in Slack (opt-in): add `<alias>:U…` to `SLACK_OWNER_MAP` **and**
   `<alias>` to `SLACK_PERSONA_USERS` in `packages/slack/.env`, then restart the adapter. A mapped
   alias that isn't listed keeps only owner-routed asks (the ask DM handler in `packages/slack/src/asks.ts`); with nobody listed
   only the host has a Persona in Slack.

### Slack bridge

- The relay's WS upgrade carries the owner secret, so it receives every user's `persona:*` frames;
  the bridge acts on a frame only when its `audience` is a user with a Persona in Slack and matches
  the binding (thread owner) or approval (owner / approver) it names.
- Every bridge call carries the owner secret, with `x-standup-persona-user` for a guest. Resync reads
  only the host and the Slack Persona users the collector reports as running or persisted
  (`GET /api/persona/users`), and issues no writes; reads never create a Persona.
- A DM from a Slack user the operator hasn't configured gets one reply: the "ask the host to add
  you" notice once (only while `SLACK_PERSONA_USERS` lists someone), else the adapter's usual reply.
