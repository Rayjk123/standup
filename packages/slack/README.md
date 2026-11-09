# @standup/slack

Bidirectional Slack adapter for Standup. It bridges the Standup collector to a Slack
app over **Socket Mode** (no public request URL), so you can watch and drive Claude
Code sessions from Slack.

## What it does

**Outbound (Standup → Slack):**

- **Session mirror** (opt-in, `mirror on` per channel; off by default) — each session
  gets its own channel thread. Turns stream in live
  via the Slack **Assistant API** (`chat.startStream` / `chat.appendStream` /
  `chat.stopStream`); on a workspace/plan that doesn't allow streaming it falls back to
  `chat.postMessage` + `chat.update` on a single message. Status reactions mark the
  thread root.
- **Feed** — an optional one-line-per-event feed into the standup channel (launched /
  finished / checkpoint / stall / knowledge / ask), tunable per kind.
- **Asks** — an agent's `ask_human` is delivered (in the session thread, or DM'd to the
  responsible owner) with **interactive option buttons**; a tap or free-text reply
  resolves it and the agent unblocks.
- **Plans** — a gated launch's plan is delivered with **Approve / Reject** buttons.

**Inbound (Slack → Standup):**

- **DM** — a reply answers a pending ask; anything else from the owner goes to Persona
  (see "Persona in Slack"), `launch <task> in <project>` included: Persona runs it as a
  job, so its milestones come back to the DM.
- **@-mention** — `launch …` (a Persona job of that thread), or the channel-config
  commands below.
- **Direct launches** — `launch …` starts a session directly, without Persona, when the
  sender has no Persona, their Persona is paused or in error, the command names
  `harness=` / `model=` / `effort=`, the project runs a non-Claude harness, the mention
  is in another user's Persona thread, or it is an `@bot launch …` inside a session's
  mirror thread. A direct launch gets no milestones; its reply links the session. A
  launch sent to Persona while the collector can't reach Persona gets the usual
  "couldn't reach Persona" reply, not a direct launch.
- **In-thread reply** — inside a session's mirror thread, a reply answers that session's
  open ask, else **steers** the live agent.

Driving an agent (launch / steer / answer an ask / approve a plan) and changing a
channel's config are **authority-gated**: only an operator-configured owner
(`SLACK_ASK_USER`), a `SLACK_STEER_ALLOWLIST` entry, or a mapped owner in
`SLACK_OWNER_MAP` may do them. With **no** authority configured the install is treated
as single-operator and those commands stay open (see "Authority" below).

## Persona in Slack

Persona — your always-on orchestrator — talks through this same Slack app. Message it
like a colleague; it turns requests into jobs, runs worker sessions, and reports back
in the thread you asked from. The console shows the same conversations.

### Operator setup

1. **Create or update the app from the manifest.** New app: follow "One-time Slack app
   setup" below. Existing app: <https://api.slack.com/apps> → your app → *App Manifest*
   → paste [`manifest.yaml`](./manifest.yaml) → *Save*. The manifest adds
   `chat:write.customize` (replies show as "Persona"), `groups:history` +
   `message.groups` (private channels), `channels:read` + `groups:read` (channel
   names, and spotting Slack Connect channels), `commands` + the **Send to
   Persona** message shortcut, `files:write` (images Persona attaches to a reply
   upload into the same DM or thread), and `files:read` (images and videos you share in
   your DM with the app are downloaded and sent to Persona as attachments).
2. **Reinstall** after any manifest change: *OAuth & Permissions* → *Reinstall to
   Workspace*. New scopes don't apply until you do.
3. **Tokens** go in `packages/slack/.env` (`SLACK_BOT_TOKEN=xoxb-…`,
   `SLACK_APP_TOKEN=xapp-…`; see `.env.example`).
4. **Set `SLACK_ASK_USER` to your Slack member id** (Slack profile → ⋮ → *Copy member
   ID*). You — the host — are `SLACK_ASK_USER`, else the `SLACK_OWNER_MAP` entry for
   the host's alias (`alias:U…`). With neither — or with both set to different
   people — Persona-in-Slack stays **off** and the adapter logs one line saying so
   (naming both ids when they disagree); the rest of the adapter works as before.
5. **Optional: give other people their own Persona in Slack.** Every user has their
   own Persona on the collector; Slack reaches a guest's only when you opt them in:
   map them in `SLACK_OWNER_MAP` (`bob:U0BBBBBBB`) **and** list their alias in
   `SLACK_PERSONA_USERS` (`bob`). Each such user directs only their own Persona, in
   their own DM and the channel threads they start. A mapped alias that isn't listed
   keeps exactly the pre-Persona behavior (owner-routed asks, the usual DM replies).
   Leave `SLACK_PERSONA_USERS` unset for host-only Persona. Also set
   **`STANDUP_WEB_URL`** to the console origin teammates' browsers reach, for
   example through an authenticating proxy or tunnel (e.g. `https://standup.example.dev`): login links and the console links in
   Slack messages point there. `STANDUP_CONSOLE_ORIGIN` (what
   `scripts/console-login.ts` reads) is used when `STANDUP_WEB_URL` is unset. With
   neither, a `login` DM gets no link — the reply tells the host to set
   `STANDUP_WEB_URL` — and the adapter warns at startup. A value with a query,
   fragment or credentials can't be used to build links; the adapter says so at
   startup and the links stay relative.
   `packages/slack/.env` is read by the adapter alone, so a value only in that
   file never reaches the collector: Persona's doc tools then return a relative
   `/docs/<id>` (which the adapter resolves on the way out, and which the
   console opens as-is). Export `STANDUP_WEB_URL` in the shell that runs
   `bun run dev` to have the collector hand out absolute links too.
6. **Restart** `bun run dev` (it starts the adapter whenever `packages/slack/.env`
   exists). Look for `[persona] Persona in Slack is on` in the log.

### What works where

- **DM the app** — one running conversation with Persona. Persona answers top-level.
  `launch … in <project>` goes to Persona as a request, so the work is a Persona job;
  `active` keeps its existing meaning. To answer an
  agent's ask card, reply **in that card's thread** (or tap a button); every other DM —
  including one with a screenshot or file attached — goes to Persona, even while older
  ask cards are open.
- **Images and videos in your DM** reach Persona as attachments: PNG, JPEG, GIF, WebP
  (up to 10 MB) and MP4, MOV, WebM (up to 50 MB; Persona sees still frames), at most 4
  per message. A file that can't go (another type, too large, a download that fails)
  is named in a ⚠️ reply in the DM; the rest of the message still goes. Files in
  channel threads aren't sent. Needs `files:read`.
- **`login`** (alone, in your DM) — a guest gets a console sign-in link for their own
  alias at `STANDUP_WEB_URL`, shown only to them and valid for 10 minutes; it never
  reaches Persona. The host is told to run `bun run scripts/console-login.ts` on the
  host instead.
- **@-mention the app in a channel** (top-level or in a thread) — starts or joins the
  Persona conversation bound to that Slack thread; Persona replies in the thread. A
  top-level mention roots the thread at your message. The thread's other messages
  (since Persona last looked; first time up to the last 30, ≤ 8,000 chars, always
  including the thread's root) go along as **context** — Persona reads them as
  background, never as your instructions.
- **Keep talking without re-mentioning** — your later messages in that thread reach
  Persona directly. `!mute` in the thread stops that (mentions still work); `!unmute`
  turns it back on.
- **Approvals** — when Persona needs your OK, an approval card with the exact action
  lands in your DM with **Approve / Deny**. If the request came from a channel thread,
  that thread gets only "⏳ Waiting on @you's approval — the details are in their DM"
  (then how it went) — never the action itself. Decisions made in the console update
  the card. An approved action that takes a while shows "Approved — running" until it
  finishes.
- **Quick replies** — when Persona offers options, tap one instead of typing.
- **Send to Persona** — message ⋮ → *Send to Persona* forwards any message (and its
  thread) to Persona in your DM. The forwarded message and its thread's root are always
  kept, led by where it came from (channel and permalink).
- **Status reactions** — 👀 when Persona has your message, ✅ when it replied, ⚠️ if
  it couldn't be delivered.

**Channel replies are public to that channel.** Everyone in the channel (and, in a
Slack Connect channel, people outside your workspace) sees what Persona writes there.
The console says so too: a shared or external thread is labelled in its header, and
its composer warns that replies are posted to the channel.

Each Persona thread has an audience — **private** (your DM, the console), **shared**
(a channel) or **external** (a Slack Connect channel) — and the two sides are kept
apart:

- **A channel turn sees only that thread.** No DM or console conversation, no
  personal memory, and none of your native Claude memory mirrored into the knowledge
  base (your `CLAUDE.md`, rules and memory files): `recall` / `search_knowledge` in a channel
  thread leave those out. For anything beyond the thread's own work Persona answers
  "ask me in a DM".
- **A DM turn can't write into a channel's jobs.** From your DM or the console you can
  still see every job, but updating or closing a job that reports to a channel thread,
  launching a session for it, or steering its sessions (messages, interrupts, stops,
  ask answers, plan approvals) is refused with "that job reports to #channel; ask me
  there, or I can start a separate private job".
- **Work reports where it was asked for.** A scheduled wakeup fires in the thread that
  scheduled it, and a job's worker events go to the job's own thread.
- **Audiences follow the Slack address.** The collector checks a thread's audience
  against its ref: `dm:<id>` must name a Slack DM (`D…`) and is private; a channel
  thread (`C…` / `G…`) is at least shared; an audience is never narrowed. The adapter
  in turn only binds `dm:` refs to DM ids and channel refs to channel ids, and never
  binds a thread whose audience doesn't fit its ref.

Errors in a channel thread show only "Persona couldn't take that — details are in the
console" (the reason stays in your DM, the console and the logs). Persona's posts
never ping `@here` / `@channel` / `@everyone`, user groups, or anyone but you (other
`<@…>` mentions are shown as plain ids); every link — Markdown inline, reference-style
or Slack `<url|label>`, in any scheme — shows its real URL; and nothing unfurls.

Only you can direct your Persona; each Slack Persona user directs only their own, and a
channel thread stays with the Persona of whoever started it. Anyone else who mentions
it there — or anyone without a Persona here — gets one private notice per thread. A DM
from someone the operator hasn't configured gets one reply: while `SLACK_PERSONA_USERS`
lists anyone, a one-time "ask the host to add you" notice, otherwise the adapter's usual
reply. Other people's messages in a Persona thread are only context — as are the author, name
and text of anything you forward, and the display names of people you mention (your
own message reaches Persona with mentions as member ids). Questions Persona asks in
the console reach your DM only when they need you (options or an approval). Slack ask
cards skip asks Persona is already handling, so nothing arrives twice.

If a scope is missing the adapter degrades rather than fails: without
`chat:write.customize` replies post under the app's name, without `groups:history`
private-channel mentions still reach Persona (without thread context), without
`channels:read` / `groups:read` channel threads are titled by their first message and
every channel counts as internal (shared, not external), without `files:write` an
attached image becomes a one-line pointer to the console, without `files:read` a file
you share in your DM isn't sent (Slack serves its sign-in page instead of the file, and
the DM says the scope is missing), and a workspace that rejects
`markdown` blocks gets converted `mrkdwn` text. Each degrade logs once.

State: `slack-persona-threads.json` next to the adapter's other state (the collector
DB's directory, else `~/.local/share/standup/`; override with
`STANDUP_SLACK_PERSONA_STATE`; written owner-only, mode 0600) — Slack thread ↔
Persona thread bindings, delivery cursors, mute flags, and approval-card locations.

**Simulate without Slack:** `bun run packages/slack/src/persona-simulator.ts` drives the real
bridge against a running collector with a recording Slack client (owner DM, channel
mention with context, non-owner mention) and prints every Slack call it would make.

## Channel setup & per-channel toggles

Mention the bot in a channel to configure it. The default posture is **quiet**: no
session mirror threads and no feed lines. Slack works like Persona in the console:
you ask in a thread, Persona answers there, and the thread gets only its jobs'
milestones (started, blocked on you, a worker's findings, review ready, done or
failed). Jobs started in the console stay out of Slack, except approval and plan cards
and questions for you in your DM, the daily brief, and the updates you route to Slack
in Notification settings.

- `feed here` — make this the standup channel (quiet; mirror and feed lines off).
- `mirror on|off` — stream every session into its own thread here (worker turns,
  status, in-thread ask cards). Off by default; `mirror on` also makes this the
  standup channel.
- `feed on` / `feed off` (`feed stop`) — toggle this channel's feed lines.
- `feed <kind> on|off` — toggle one feed event-kind (e.g. `feed checkpoint off`).
  The daily digest line is off by default too; `feed digest on` turns on just it (and,
  like `feed on`, makes this the standup channel).
- `asks on|off` — whether a mirrored session's asks post in its thread here.
- `standup off` (or a bare `off`) — remove Standup from this channel.
- `feed status` — show this channel's effective toggles (read-only, always open).

All of these except `feed status` mutate shared channel config, so they are
authority-gated when an authority set is configured; `feed status` and the help text
stay open.

## Authority

The adapter reads three optional operator-config env vars:

- `SLACK_ASK_USER` — the owner Slack id (`U…`).
- `SLACK_STEER_ALLOWLIST` — extra Slack ids (`U…`, comma/space-separated).
- `SLACK_OWNER_MAP` — `alias:U…` pairs for owner-routed asks/plans.

(`SLACK_PERSONA_USERS` — aliases that get their own Persona in Slack — grants no
authority beyond directing that user's own Persona; see "Persona in Slack". Nor does
the identity email domain (`SLACK_IDENTITY_EMAIL_DOMAIN`, else the org profile's
`identity.emailDomain`) grant authority, but it decides which Slack users merge
into an alias's actor and so take on that alias's project standing; see "Reinstall
for user-identity reconciliation".)

If **any** are set, only those users may drive agents or change channel config; everyone
else is refused with a clear notice. If **none** are set, the install is open by choice
(single-operator) and those commands are unrestricted. The DM-learned ask recipient is
only a delivery target — it never grants authority.

**Safety-floor holds** are stricter. Only the owner (`SLACK_ASK_USER`, else the
`SLACK_OWNER_MAP` entry for the host's alias) may answer one *Allow once*; anyone
the gate above admits may answer *Deny*. A hold takes only its exact option labels
(`Allow once` / `Deny`), never free text. The owner's allow — and every Persona
call the bridge makes, reads and writes alike, plus the collector WebSocket
upgrade — carries the owner secret as `x-standup-owner-token`, read from
`<dataDir>/secrets/owner.token` (the collector's data dir, from `DB_PATH`). When
the adapter runs on another host or as another user, copy that file somewhere
only the adapter can read (0600) and set `STANDUP_OWNER_TOKEN_FILE` to it.
Without a readable token the collector refuses the owner's allows with a 403 and
answers Persona reads with a sign-in state, so **Persona-in-Slack is off**; the
adapter logs `Persona in Slack is off: owner secret unreadable` at startup.

**Privacy between users.** Each user's Persona threads, memories, jobs, schedules
and cards are private to that user (and readable by the host's admin view) through
Standup's API, console and Slack. They are **not** private from workers on this
host: every worker runs as the host's Unix user and can read the collector's
database and data directory directly. Don't tell a Persona anything you wouldn't
want an agent on this host to be able to read.

## One-time Slack app setup

You need your own Slack app installed to a workspace you can test in.

1. **Create the app from the manifest.** <https://api.slack.com/apps> → *Create New App* →
   *From an app manifest* → pick your workspace → paste the contents of
   [`manifest.yaml`](./manifest.yaml) (or [`manifest.json`](./manifest.json)) → *Create*.

2. **App-level token (for Socket Mode).** *Basic Information* → *App-Level Tokens* →
   *Generate Token and Scopes* → add `connections:write` → copy the `xapp-…` token.

3. **Install to workspace.** *Install App* → *Install to Workspace* → authorize. Copy the
   *Bot User OAuth Token* (`xoxb-…`) from *OAuth & Permissions*.

4. **Make a standup channel** and invite the bot: `/invite @standup-dev`. Mention it with
   `feed here` to bind it.

### Reinstall for user-identity reconciliation

The manifest requests `users:read` + `users:read.email` so the adapter can resolve a
Slack answerer's email to their alias and merge the two actor identities (so one
teammate isn't counted as two collaborators). The merge needs the mail domain
whose addresses are `<alias>@<domain>`, with the same alias the console's
identity header carries. The adapter takes it from
`SLACK_IDENTITY_EMAIL_DOMAIN` when that is set, else from the org profile's
`identity.emailDomain` (the file `STANDUP_ORG_PROFILE` names, else
`~/.config/standup/org-profile.json`, read from the adapter's own environment
and home dir). Set `SLACK_IDENTITY_EMAIL_DOMAIN` to a value that is not a
domain, such as `none`, to turn merging off even when the org profile names a
domain. Only an email at exactly that domain is read as an alias (its
local-part, lowercased); any other address, a subdomain or a Slack Connect
guest at another domain stays a separate `slack:U…` collaborator. With neither
source naming a domain, a guest whose address shares a local-part with an alias
would be folded into that alias and inherit its attribution and project
standing, so the adapter merges no one and logs one startup line saying so.

An app installed **before** these scopes were added keeps working, but the adapter
logs a one-time hint to reinstall. To grant them: reimport `manifest.yaml`, then
*OAuth & Permissions* → *Reinstall to Workspace*.

## Run

```bash
cp packages/slack/.env.example packages/slack/.env   # fill in tokens + targets
bun run --filter @standup/slack start                # from repo root
# or:  cd packages/slack && bun run start
```

There is also a standalone streaming probe (`bun run --filter @standup/slack probe`)
that checks whether your workspace exposes the `chat.*Stream` API; it touches neither
the collector nor the database.

## Files

- `src/index.ts` — the adapter entrypoint: Socket Mode wiring + inbound routing.
- `src/mirror.ts` / `src/stream-client.ts` — per-session thread mirror + streaming.
- `src/feed.ts` / `src/channel-features.ts` — the feed and per-channel toggles.
- `src/asks.ts` / `src/plans.ts` — asks and plan-approval delivery + buttons.
- `src/steer.ts` — the inbound authority (steer / launch / answer / approve gate).
- `src/launch.ts` / `src/launch-command.ts` — launch-from-Slack.
- `src/actors.ts` — Slack → alias actor reconciliation.
- `src/collector-client.ts` / `src/env.ts` — collector HTTP/WS client + env loading.
- `src/persona-bridge.ts` — Persona in Slack (inbound routing + outbound delivery);
  `src/persona-routing.ts` / `src/persona-format.ts` / `src/persona-store.ts` — its pure
  routing, formatting, and durable state; `src/persona-simulator.ts` — the recording-Slack
  simulation harness.
- `src/probe.ts` — the standalone streaming-API verifier.
