# Standup

A console for running many Claude Code agents at once. See every session in one place, get pinged only when an agent actually needs you, and give every agent a shared knowledge base to consult before it builds.

Agents as collaborators, not sessions in a hundred terminal tabs.

The north star: a multiplayer engineering console where a team shares a growing, self-maintaining knowledge graph across products, hops into each other's coding sessions, and has product knowledge injected to aid implementation.

What it does:

- **One feed for every session.** Claude Code hooks stream each session's
  lifecycle to a local collector; the web console (and an optional Slack
  adapter) shows them live, grouped by project.
- **Asks, not noise.** An agent calls `ask_human` when it needs you; only asks
  push a notification.
- **A shared knowledge base.** Agents search project docs (text, and optionally
  embeddings) before they build, and propose what they learn back.
- **Launching and owning sessions.** Start an agent from the console in its own
  git worktree and tmux pane, with a delivery pipeline (plan, implement,
  review, code review, land) and a review packet for you to approve.
- **Persona and the safety floor.** Launched agents run with a PreToolUse hook
  that holds outward-facing and destructive steps (push, deploy, publish,
  cloud changes, secret reads) for Persona, your assistant agent, or for you.

Everything is built and run with [Bun](https://bun.sh); there is no other build
system.

## Getting set up

Or open Claude Code in the repo and ask it to set Standup up — the repo's
`CLAUDE.md` walks it through these steps, including the ones only you can do.

### 1. Get the code

```bash
git clone https://git.example.com/acme/standup.git
cd standup
```

### 2. Install the toolchain

| Tool | Why | Install (Linux) |
|---|---|---|
| Bun ≥ 1.4 | runtime for every package | `curl -fsSL https://bun.sh/install \| bash` |
| Node 24 | Vite's config imports `.ts` from `@standup/shared` | `mise use -g node@24` (or any Node 24 install on `PATH`) |
| tmux | launched agents run in Standup-owned tmux panes | your package manager (`dnf install tmux`, `apt install tmux`) |
| ripgrep | backs the `ripgrep` MCP tool | your package manager (`dnf install ripgrep`, `apt install ripgrep`) or a release binary |
| Claude Code | the agents themselves | `claude` on `PATH`, signed in |
| Ollama + `nomic-embed-text` (optional) | embedding search; text search works without it | `ollama pull nomic-embed-text` |

On macOS `bun run dev` installs Homebrew, ripgrep and tmux itself (see
[Prerequisites](#prerequisites)).

### 3. Install and run

```bash
bun install
bun run dev        # collector :7777, websocket :7778, web console :5173
```

`bun run dev` prints a sign-in link; open it (or run
`bun run scripts/console-login.ts` for a fresh one) to sign in to the console as
the owner. Without it the console is read-only for you.

### 4. Wire up Claude Code

In another terminal:

```bash
bun run setup
```

This writes the hooks to `~/.claude/settings.json`, the `standup` MCP server to
`~/.claude.json`, and the steering skill + a managed block to
`~/.claude/CLAUDE.md` (details in [Wiring Up Claude Code](#wiring-up-claude-code)).
Start a **new** Claude Code session afterwards; running sessions don't reload
hooks or MCP servers. `bun run setup:remove-steering` takes the steering back out.

### 5. Register your projects and load the starter knowledge

```bash
mkdir -p ~/.config/standup
cp seed/projects.toml ~/.config/standup/projects.toml
bun run kb:seed
cat seed/claude/CLAUDE.md >> ~/.claude/CLAUDE.md
```

- `seed/projects.toml` is a starter project registry. Do this before the first
  `bun run dev` — the file only seeds the registry of a fresh install; on an
  existing install add the projects from the console instead. Edit each
  project's `repos` to point at your own checkouts (see
  [Project Registry](#project-registry)).
- `bun run kb:seed` copies the starter knowledge base in `seed/knowledge/`
  (decisions, runbooks, specs and code facts per project) into
  `~/.config/standup/knowledge/`. It never overwrites a doc you already have.
  The collector indexes the docs on its next sync, and embeds them when
  `EMBEDDING_PROVIDER` is set.
- `seed/claude/CLAUDE.md` holds starter Claude Code conventions (code style,
  code reviews, workflows, deploys); append it to your global `CLAUDE.md` if
  you want them. Rules for working on this repo itself are in the repo's own
  `CLAUDE.md`.

### 6. (Optional) Run it as a service

To keep Standup up across logouts, run it under systemd as a user service.
`~/.config/systemd/user/standup.service`:

```ini
[Unit]
Description=Standup (collector 7777 + web 5173 + ws 7778)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/src/standup
# bun, node 24 and claude must all be on this PATH; adjust to your installs.
Environment=PATH=%h/.bun/bin:%h/.local/share/mise/installs/node/24/bin:%h/.local/bin:/usr/local/bin:/usr/bin:/bin
# Only if Ollama is running with nomic-embed-text pulled:
# Environment=EMBEDDING_PROVIDER=ollama
# Environment=EMBEDDING_MODEL=nomic-embed-text
# Your own dev accounts, so Persona can clear their AWS holds:
# Environment=STANDUP_PERSONAL_AWS_ACCOUNTS=<your-account-id>
# Your org's integrations (see "Integrations"):
# Environment=STANDUP_ORG_PROFILE=%h/.config/standup/org-profile.json
ExecStart=%h/.bun/bin/bun run dev
Restart=always
RestartSec=5
# Signal only the bun supervisor on stop/restart so launched agents' tmux
# sessions survive a collector restart.
KillMode=process

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now standup
loginctl enable-linger "$USER"   # keep it running after you log out
journalctl --user -u standup -f
```

### 7. (Optional) Reach it from your laptop or share it

The console binds to localhost. From a laptop, forward the ports over SSH
(`ssh -L 5173:localhost:5173 <your-dev-host>`), or put the web port behind an
authenticating reverse proxy or tunnel service restricted to the people you
want. The collector reads the acting user from a request header the proxy
stamps (see [Identity provider](#identity-provider)).

To serve the console through a tunnel or proxy:

1. Expose the web port, 5173. It carries the console, `/api` and `/ws` on one
   origin. If Standup opens the tunnel itself (see
   [Tunnel provider](#tunnel-provider)), name it `standup` so no agent's
   cleanup stops it.
2. Set `STANDUP_WEB_URL=https://standup.example.com` (the public URL) in the
   Standup service's environment (for example `Environment=` in the unit from
   step 6), then restart it. Links are built on this URL: the console's Share
   links, Persona's and Slack's doc and review links, and the links agents
   launched after the restart hand out. Without it, Share links use the address
   the console is open at, and Persona's doc links are relative. The console's
   vite server accepts the host of `STANDUP_WEB_URL`, and every host under
   `STANDUP_TUNNEL_DOMAIN` when the tunnel service authenticates
   (`STANDUP_TUNNEL_IDENTITY_HEADER`). Other hosts still get vite's
   `403 Blocked request`. To accept one more, set
   `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS`.
3. Sign in on the public origin (the session cookie is per origin). Your
   shell doesn't have the service's environment, so pass the URL in when you
   run the sign-in script, then open the link it prints:

   ```bash
   STANDUP_WEB_URL=https://standup.example.com bun run scripts/console-login.ts
   ```

   The script uses `STANDUP_WEB_URL`, else `STANDUP_CONSOLE_ORIGIN`, else
   `http://localhost:5173`. To sign in on localhost with `STANDUP_WEB_URL`
   exported, unset it for that run. Teammates the proxy lets through can view
   the console; owner actions need your sign-in.

### Your data

Everything Standup stores is per-user and stays out of git:
`~/.local/share/standup/` (SQLite DB, owner secret, worktrees, tmux socket) and
`~/.config/standup/` (project registry, org profile, knowledge docs).
`bun run kb:seed` loads the starter docs in `seed/knowledge/`;
`bun run kb:export <out-dir>` on one host and `bun run kb:import <dir>` on
another move a whole knowledge base (with its embeddings, verdicts and
telemetry) between your own installs.

### Checking your install

```bash
bun test                              # unit tests
curl -s localhost:7777/health         # {"status":"ok",...} when the collector is up
```

## Architecture

```
 projects.toml ---> registry (grouping · launch · knowledge scoping)
                       |
 Claude Code sessions (N)
   |  HTTP hooks (fire-and-forget POST)
   v
 Collector  --->  SQLite  --->  WebSocket  --->  Chat UI
   ^                                               |
   |  MCP: checkpoint / ask_human / ripgrep        |
   |       search_knowledge / get_knowledge_doc    |
   +-----------------------------------------------+
```

Two independent paths:
- **Read path** — hooks push lifecycle events to the collector
- **Write path** — MCP server for agent-initiated communication

## Prerequisites

`bun run dev` checks for [Homebrew](https://brew.sh) and [ripgrep](https://github.com/BurntSushi/ripgrep)
on startup (macOS only) and installs whichever is missing — ripgrep backs the
`ripgrep` MCP tool and is a system binary `bun install` can't provide. This is
a visible, logged step (`[deps] ...`), not a silent background action; if
Homebrew needs installing you may be prompted for your password in the same
terminal. Run it standalone any time with `bun run scripts/check-deps.ts`.
On non-macOS, install ripgrep yourself for your platform.

## Quick Start

```bash
# Install dependencies
bun install

# Start all services (collector + web UI) — also checks/installs
# Homebrew + ripgrep on macOS, see Prerequisites above
bun run dev

# In another terminal, wire up Claude Code globally — hooks (read path),
# the MCP server (write path), AND the agent steering (skill + CLAUDE.md block)
# for every session on this machine. The app is inert without the steering.
bun run setup   # alias for: bun run scripts/setup-hooks.ts

# Start a new Claude Code session (hooks/MCP are read at session start,
# so sessions already running won't pick this up)
```

Services:
- Collector: http://localhost:7777
- WebSocket: ws://localhost:7778
- Web UI: http://localhost:5173

### Restarting the collector

`bun run dev` runs the collector **without** `--watch` (its `bun run start`
script): a change to the install — a merge, a checkout — takes effect only when
the collector is restarted. Ask Persona to restart Standup (`restart_standup`):
it lets Persona finish its turn, restarts the collector, health-checks the
collector, Persona and the UI, and rolls back to the last known-good commit if
the new one fails, then reports what pending state survived. Rerunning
`bun run dev` works too, without those checks.

Set `STANDUP_COLLECTOR_WATCH=1` to run the collector under `bun --watch`
instead, when working on the collector itself. Every change then reloads it at
once, with no quiesce, health check or rollback; a `restart_standup` asked for
in that mode still runs, and its report warns that merges hot-reload
unguarded. The web UI and the Slack adapter keep their own reload behavior
either way.

### Database backup before a migration

When the collector starts (or `bun run kb:import` opens the database) and the
database needs a schema migration, it first copies the database to
`standup.db.pre-migrate.bak` beside it (one file; each new copy replaces the
last), so a migration briefly needs room for one more copy. A brand-new database gets no backup. If that copy fails, no migration
runs and the collector does not start; the log says why. A migration's version
is recorded only when it succeeds, so when a failed migration is retried the
backup already holds the same schema as the database and is kept, not
replaced by the half-migrated database. To restore after a bad migration:
stop Standup (`systemctl --user stop standup.service`, or stop `bun run dev`),
delete `standup.db-wal` and `standup.db-shm`, then copy
`standup.db.pre-migrate.bak` to `standup.db`.

### How the web UI is served

`bun run dev` serves the console from a production build
(`packages/web/serve.ts`): `vite preview`, with the same `/api` and `/ws`
proxies and owner sign-in as the dev server. Each build, the first and every
rebuild, runs in its own short-lived child process, so the long-lived server
holds only `vite preview` (about 100 MB) and never a build's gigabyte peak or
rollup's module graph. Hashed
assets are cached `immutable` and gzipped; every tab but Persona is its own
chunk, loaded on first open or prefetched once the page is idle. A source
change (a merge) rebuilds in place and shows on the next page load; an open
page keeps its build until reloaded. A change to `vite.config.ts` or a local
module it imports (`owner-proxy.ts`, `static-assets.ts`, `chunks.ts`)
restarts the server; a change in `@standup/shared` that the config uses
needs `bun run dev` rerun. A broken build leaves the last good one served,
and a restart serves the build on disk while the new one runs. The build
lives in `packages/web/dist-serve`, apart from `bun run build`'s `dist`.

Set `STANDUP_WEB_DEV=1` to run the vite dev server instead (hot module
reload, unbundled modules) when working on the console. Over a tunnel it
loads far slower: every source module is its own request.

`bun packages/web/e2e/load-time.measure.ts` times a cold load of the Persona
view on a scratch install (see its header for flags).

`STANDUP_RESTART_BOOT_TIMEOUT_S` lengthens how long a restart waits for the
collector to answer after it is started (default 180s); set it where both the
collector and the MCP server read it, so a waiting `ask_human` rides out the
longer restart too.

## Project Structure

```
standup/
├── packages/
│   ├── shared/      # Types and constants
│   ├── store/       # SQLite database layer
│   ├── knowledge/   # Project knowledge: markdown docs, text + embedding search
│   ├── collector/   # HTTP hook receiver, REST API, Persona, safety floor, pipelines
│   ├── mcp/         # MCP server (checkpoint, ask_human, search_knowledge,
│   │                #             get_knowledge_doc, ripgrep)
│   ├── gateway/     # Proxy that holds the public ports across restarts
│   ├── slack/       # Optional Slack adapter
│   └── web/         # React frontend
├── config/
│   ├── projects.example.toml   # Project registry template
│   ├── hooks.example.json      # Claude Code hooks config
│   ├── knowledge.example/      # Example project knowledge docs
│   └── steering/               # The steering skill `bun run setup` installs
├── seed/
│   ├── projects.toml           # Starter project registry
│   ├── knowledge/              # Starter knowledge base (`bun run kb:seed`)
│   └── claude/CLAUDE.md        # Starter Claude Code conventions
├── scripts/
│   ├── dev.ts           # Run all services
│   └── setup-hooks.ts   # Wire up Claude Code globally: hooks + MCP server
└── docs/                # Design notes and verified Claude Code behavior
```

## Configuration

### Project Registry

Copy `config/projects.example.toml` to `~/.config/standup/projects.toml`
(or point `STANDUP_PROJECTS_PATH` at a different location):

```toml
[[project]]
id      = "my-api"
name    = "my-api"
emoji   = "🛰️"
repos   = ["~/src/my-api"]
setup   = "bun install"
branch  = "main"
launchArgs = "--permission-mode acceptEdits"   # extra `claude` flags, omit if none
# bypassPermissions = false                     # opt out of bypassed launches (default true)
# codeReviewAdapter = "github-pr"               # how this project's changes are reviewed (see Integrations)
```

Launched Claude sessions run `--permission-mode bypassPermissions` with Standup's
safety-floor PreToolUse hook passed inline via `--settings`: outward-facing and
destructive steps are held for Persona or the owner. `bypassPermissions = false`
(or the per-launch toggle) runs `--permission-mode auto` with no hook; a
`--permission-mode` pinned in `launchArgs` wins. If the floor can't be installed
(hook missing, launchArgs with their own `--settings`, or a Claude settings file
with `disableAllHooks`/`allowManagedHooksOnly`) the launch falls back to `auto`.
The floor also stays off (auto mode) when the launch root contains your home
dir, Standup's data dir or the Standup install, or when Claude Code would open
its bypass confirmation dialog (no `skipDangerousModePermissionPrompt` and the
mode not yet accepted). `STANDUP_PERSONAL_AWS_ACCOUNTS` (comma list) lets a
cloud credentials helper fetch credentials for those accounts without a hold. A
mutating AWS call runs without a hold when the same command fetched those
credentials first, or when every ARN it names is in a listed account and none
of its input is unread; otherwise it is held for the owner, since the hook
can't tell which account it hits without trusting the worker's environment.
Set the list on the collector's service (e.g.
`Environment=STANDUP_PERSONAL_AWS_ACCOUNTS=…` in a systemd drop-in) and
restart it. A worker's hook keeps the list it was launched with, so a worker
launched before an account was added still holds that account's calls. The
collector re-checks each hold against its current list and hands such a hold to
Persona (category `personal-aws`) instead of the owner. When the command doesn't
name the account, the collector asks STS (GetCallerIdentity, 3s timeout,
cached per credential set) whose static keys the call would run with: keys in
the environment, else the chosen profile's keys in `~/.aws/credentials`. A
listed account sends the hold to Persona the same way. Role, SSO or
`credential_process` profiles, a moved `HOME`, or an STS failure leave it with
the owner. Removing an account
takes effect only for workers launched afterwards. `STANDUP_FLOOR_WAIT_S` caps how long a
hold waits for a decision. Codex launches keep their own posture (no floor).

**What the floor is for.** It reliably holds the categories in
`packages/collector/src/floor/gate.ts` when a well-meaning worker runs them
directly or through ordinary wrappers (make, npm/bun scripts, task runners,
scripts it runs), or when content it read talked it into one. It is a reader of
commands and files, not a sandbox: deliberately obfuscated commands, code that
builds its commands at run time, code run by test runners and build tools, and
files swapped between two calls can get past it. Those are residual risks; the
structural fix is running workers under a separate Unix user (or a sandbox)
without push, code review or deploy credentials.

**Owner secret.** A worker runs as your Unix user and reaches the collector over
loopback, so neither tells it apart from you. On start the collector writes
`<dataDir>/secrets/owner.token` (dir 0700, file 0600; `<dataDir>` is the directory
of `DB_PATH`) plus `floor-reply.key`, the Ed25519 key it signs floor replies with.
Owner-only decisions need that token in `x-standup-owner-token` *and* a request
identity that is the owner: allowing a safety-floor hold (the host's Persona may
also allow one with its own token, on a session its job owns, recording its reason;
a read of owner secrets or another process's memory, any command naming Standup's database, a write to the floor hook or
install code, or an acceptance criterion the owner holds, never), any
Persona write (messages, approval decisions, pause/resume/reset), answering a
tool-permission prompt, allowing a Standup self-fix, changing a project's
`launchArgs`/`setup`/`provision`/`bypassPermissions`/`inPlace`/`reviewProcess`/`reviewCommand`/`repos`/`worktreeRoot`/`launchSubdir`,
changing the `worktreeRoot` or `multiplayerOverride` settings, an in-place
launch, adopting a session, approving a plan with an edited acceptance
criterion, reading `GET /api/standup/restart` (Persona's token also works), and
`POST /api/projects/import`. Denials need no token. The web console's dev-server
proxy reads the file server-side and adds the header (the browser never sees
it); the Slack adapter sends it only for the configured owner. Launched workers
never get it in their env or argv; each launch instead gets a scoped worker
token that only lets its own hook raise holds. A console or Slack adapter on
another host (or as another user) points `STANDUP_OWNER_TOKEN_FILE` at its own
copy of the token file.

**Console sign-in.** The dev-server proxy forwards the owner token only for the
owner's signed-in browser. Run `bun run scripts/console-login.ts` (or copy the
link `bun run dev` prints at startup) and open the URL within 10 minutes: the
proxy verifies the login code and sets an HttpOnly `standup_owner` cookie
(30 days, valid while the token is unchanged). Requests without the cookie, and
state-changing requests that aren't same-origin, are forwarded without the
token, so a teammate on a shared console can't act as the owner. If a decision
is refused with "doesn't carry the owner token", the console shows a notice to
sign in.

The collector loads this file on startup and watches it for changes — edits
take effect without a restart. Sessions are matched to a project by comparing
their `cwd` against each project's `repos`. A session that starts somewhere else
(e.g. `$HOME`) is re-homed as soon as any path it touches names a project: a later
hook `cwd`, or a working/additional directory (`--add-dir`) recorded in its
transcript, that sits in a project repo or a launch worktree
(`<worktreeRoot>/<project>/<slug>`, e.g. `standup-worktrees/<project>/...`). The
move is stored on the session, so it survives later `cd`s, and subagents inherit
it. Anything that never matches stays in a catch-all `scratch` project, created
automatically even if you never define one; knowledge tools then include a
warning in their response.

### Integrations

Standup talks to the tools your org uses through five pluggable seams. Each
has a neutral built-in default, so a fresh install needs none of them: no code
review tool, no issue tracker, no tunnels, plain git checkouts and a safety
floor with only generic rules.

#### Code review adapter

How a project's changes are reviewed before they land, and what the delivery
pipeline's `code_review` stage records. Pin one per project with
`codeReviewAdapter` in `projects.toml`:

| Adapter | Behavior |
|---|---|
| `github-pr` | Composes a draft `gh pr create --draft …` and a draft-PR request for any project with a repo. Never requires a linked review or an issue id. |
| `generic` | Accepts any http(s) URL as the review link (or the org profile's `codeReview.linkFormat`). Composes the cut and revise commands from the org profile's `codeReview.cutCommand` / `reviseCommand` templates (`{issueId}`, `{descriptionFile}`, `{reviewId}`); without them it tells the worker to open the review the way the repo's changes are reviewed. A project on it must link a review in its review packet. |

A project that pins no adapter is detected: `github-pr` when it has a repo,
`generic` when the org profile's `codeReview.remotePatterns` match a
checkout's remote or its `provisionPatterns` / `launchSubdirPatterns` match the
project. A `cutCommand` containing `{issueId}` makes the code_review stage ask
the owner for an issue id.

#### Issue tracker

Where work items come from and where their status goes back to.

| Env | Meaning |
|---|---|
| `STANDUP_TRACKER` | `none` (default: nothing is pulled or pushed, and `POST /api/tickets/ingest-task` answers 409) or `agent` |
| `STANDUP_TRACKER_NAME` | the tracker's display name for `agent` (e.g. `Jira`) |

With `agent`, the collector can't reach the tracker itself: the dispatched
session holds the tracker's tools (an MCP server, a CLI), and the collector
hands it an instruction to write the status and review link back.

#### Tunnel provider

How Standup opens a public URL for a review build (the pipeline's review
tunnel stage) and lists open tunnels. Disabled by default; review share then
reports that no tunnel provider is configured.

| Env | Meaning |
|---|---|
| `STANDUP_TUNNEL_PROVIDER` | `disabled` (default) or `command` |
| `STANDUP_TUNNEL_CREATE` | create command template: `{port}`, `{name}`, optional `{region}`, `{allow}`. An optional token with no value drops its word, and in the separate form (`--region {region}`) the option word before it too; in the joined form (`--region={region}`) only its own word goes |
| `STANDUP_TUNNEL_OWNER_ALLOW` | the `{allow}` value that admits only you, used when a tunnel names no audience. Required when `STANDUP_TUNNEL_CREATE` has `{allow}`; not allowed when it has none |
| `STANDUP_TUNNEL_URL` | URL template with `{name}`, e.g. `https://{name}.tunnels.example.com` |
| `STANDUP_TUNNEL_LIST` | optional list command printing JSON (an array, or `{tunnels}`, of objects with `name` or `tunnelName`) |
| `STANDUP_TUNNEL_DOMAIN` | the tunnel host domain, e.g. `tunnels.example.com` |
| `STANDUP_TUNNEL_IDENTITY_HEADER` | the header the tunnel service stamps on every request it forwards with the user it authenticated (after removing any client copy) |
| `STANDUP_TUNNEL_UNAUTHENTICATED` | `1`/`true`/`yes`: you acknowledge the tunnel service authenticates no one |

A `command` provider must set exactly one of `STANDUP_TUNNEL_IDENTITY_HEADER`
or `STANDUP_TUNNEL_UNAUTHENTICATED`; with neither or both it stays disabled
with a warning. The collector trusts the identity header on a loopback
request only when the provider's `STANDUP_TUNNEL_IDENTITY_HEADER` is the
header it reads (`STANDUP_IDENTITY_HEADER`, which defaults to the provider's
header), so a request through an
unauthenticated tunnel can't name itself as another user. Note that a
header-less loopback request still resolves to the host user, so an
unauthenticated tunnel to the console gives every visitor your identity.

A tunnel that names no audience is for you alone. With `{allow}` in the create
template, it gets `STANDUP_TUNNEL_OWNER_ALLOW`, never the CLI's own default.
Without `{allow}`, the template itself must open tunnels only you can reach,
and a review tunnel whose project names an audience (`allow`) fails before
its setup runs, because that audience can't be passed.

Put an optional bare token (`{region}` as its own word) before any flag that
takes no value, or use the joined form: `--private {region}` with no region
drops `--private` too, since it reads as `--private`'s value.

Example, for a tunnel CLI that takes a port, a name and an audience:

```bash
STANDUP_TUNNEL_PROVIDER=command
STANDUP_TUNNEL_CREATE='tunnel-cli open {port} --name {name} --allow {allow}'
STANDUP_TUNNEL_OWNER_ALLOW=your-user
STANDUP_TUNNEL_URL='https://{name}.tunnels.example.com'
STANDUP_TUNNEL_DOMAIN=tunnels.example.com
STANDUP_TUNNEL_IDENTITY_HEADER=x-tunnel-user
```

A review tunnel never serves on Standup's own ports (5173, 7777, 7778), and
never takes, opens or stops the console's own tunnel, `<user>-standup`. Those
are the only built-in reservations. If the host keeps other tunnels open for
good, reserve them too, by port with `STANDUP_REVIEW_TUNNEL_RESERVED_PORTS` and
by name suffix (the part after `<user>-`, a lowercase DNS label) with
`STANDUP_REVIEW_TUNNEL_RESERVED_SUFFIXES`, both comma-separated. A reserved
suffix also keeps the tunnel's process from being registered or stopped as a
worker's process. For a long-running preview on port 4000 behind a proxy on
4080, under the name `<user>-preview`:

```bash
STANDUP_REVIEW_TUNNEL_RESERVED_PORTS=4000,4080
STANDUP_REVIEW_TUNNEL_RESERVED_SUFFIXES=preview
```

An entry that doesn't parse is logged and skipped.

#### Project layout

How Standup finds the git checkouts in a launch's working dir. One setting
for the whole install.

| Env | Meaning |
|---|---|
| `STANDUP_PROJECT_LAYOUT` | `git` (default: the launch's worktree is its one checkout) or `workspace` |
| `STANDUP_WORKSPACE_PACKAGES_DIR` | `workspace`: the dir under the root that holds one git checkout per package (default `packages`) |
| `STANDUP_WORKSPACE_MARKER` | `workspace`: a file name that marks a workspace root; the safety floor widens a job's roots to that workspace only when the marker exists |
| `STANDUP_WORKSPACE_FALLBACK_BASE` | `workspace`: the base ref when a checkout's remote has no default branch (default `origin/main`) |

Under `git`, a provisioned working dir that isn't a git repo reads no
checkout, and the collector warns at boot when it finds such dirs.

#### Org profile

Your org's vocabulary for the safety floor and Persona's allow check: internal
hosts, the owner's own hosts, SSO dirs and cookie files, credential CLIs, the
review CLI, org-specific outward CLIs, wrapper CLIs that run a command, MCP
tools that are read-only or write reviews, WebFetch domains and pages, and the
code review link format and commands. The file is `~/.config/standup/org-profile.json`, or the
absolute path in `STANDUP_ORG_PROFILE` (a leading `~/` is read as your home
dir). It is merged onto the built-in default, which carries only generic
outward rules (git push; `gh` PR, release and repo writes; kubectl/oc
mutations; terraform/tofu/terragrunt apply, destroy and import; npm, pnpm,
yarn and bun publish; container image pushes).

A profile's CLI entries only add holds: its own CLIs never drop or soften a
built-in hold. The entries that name what is safe do allow more: read-only MCP
tools, self-filed and checkout tools, WebFetch domains and pages, the internal
hosts the SSO cookie may be sent to, and the owner's own hosts that ssh, scp and
rsync may reach. A profile file that exists but can't be read, isn't JSON, or has an entry that
doesn't validate (including a regex that repeats a group, such as `(ab)+`)
stops the collector at boot with every error listed.

A sketch (the test fixture
`packages/collector/src/org-profile/fixtures/example-corp.json` covers every
field):

```json
{
  "name": "example.corp",
  "internalHostSuffixes": ["example.corp"],
  "ownerHostPatterns": ["devbox-{owner}-*.example.corp"],
  "sso": { "dirs": [".corp-sso"], "cookieFiles": [".corp-sso/cookie"], "loginClis": ["corp-sso-login"] },
  "credentialClis": [
    { "program": "corp-creds", "subcommand": ["login"], "accountOption": "--account", "roleOption": "--role", "printSubcommands": ["export"] }
  ],
  "reviewClis": ["corp-review"],
  "outwardRules": [
    { "program": "corp-deploy", "subcommand": ["promote|release"], "category": "outward", "reason": "deploys through the org's release tool" }
  ],
  "wrapperClis": [{ "program": "corp-env", "valueOptions": ["--stage"] }],
  "mcp": {
    "readOnlyTools": { "corp-mcp": ["SearchCode", "ReadWiki", "GetTicket"] },
    "reviewWriteTools": [],
    "checkoutTools": [],
    "selfFiledTools": [],
    "pluginPrefixes": []
  },
  "webFetchDomains": ["docs.example.corp"],
  "webFetchPages": [{ "host": "www.example.corp", "paths": ["blog"] }],
  "identity": { "emailDomain": "example.corp" },
  "codeReview": {
    "noun": "code review",
    "remotePatterns": ["(?:^|[@/.])code\\.example\\.corp\\b"],
    "provisionPatterns": [],
    "launchSubdirPatterns": [],
    "linkFormat": {
      "urlPattern": "^https://code\\.example\\.corp/reviews/(R-\\d+)(?:[/?#]|$)",
      "idPattern": "\\bR-\\d+\\b",
      "urlTemplate": "https://code.example.corp/reviews/{id}"
    },
    "cutCommand": "corp-review --issue {issueId} --description {descriptionFile}",
    "reviseCommand": "corp-review --revise {reviewId} --description {descriptionFile}"
  }
}
```

Without a profile, the floor still reads these generically:

- **Credential CLIs.** A program the floor has no handler for is read by its
  words. If it names a role (`--role`, `--role-name`) and an AWS account
  (`--account`, `--account-id`, or a bare 12-digit operand), as in
  `cloud-login --account 111122223333 --role Deployer`, it writes that
  account's credentials; after a `creds` or `credentials` operand the short
  `-r` and `-a` count too. A write for a non-personal account with a role that
  isn't read-only is an AWS hold. The floor can't tell which profile the
  program wrote, so a later AWS call in the same command runs in an account it
  doesn't know. A call that shows credentials (`cloud-login creds show`,
  `vault-helper export-credentials`, `docker-credential-pass get`) is held for
  the owner. The command a wrapper starts (`<cli> exec … -- <command>`, or
  `run` in place of `exec`) is read as well.
- **Cookie stores.** A file named for cookies (`cookie`, `cookies.txt`,
  `Cookies`, …) below a dot entry of your home dir is a home secret. An SSO
  dir with no cookie-named file in it is protected only when the profile
  lists it in `sso.dirs`.
- **Code review.** Only the built-in review commands (`gh pr`, `gh release`,
  `hub`) and review wording are read as a code review. Your org's review CLI
  holds as `review` only when `reviewClis` lists it.

List your org's internal hosts, owner hosts, SSO dirs, review CLI and
read-only MCP tools in the profile; otherwise the floor treats them as any
other host, file, program or tool. An owner-host glob's `*` stays within one
DNS label and nothing is appended to it, so name the full host
(`devbox-{owner}-*.example.corp`).

### Wiring Up Claude Code

One script configures all three halves, globally — every Claude Code session on
this machine, not just ones started in this repo:

```bash
bun run setup   # alias for: bun run scripts/setup-hooks.ts
```

This writes to three places:

- **`~/.claude/settings.json`** — HTTP hooks for the read path (see
  `config/hooks.example.json` for the full event list). The hook definition
  must be nested under a `hooks` array on each matcher entry, not placed
  directly on it.
- **`~/.claude.json`** — registers the `standup` MCP server under
  `mcpServers`, giving every session the `checkpoint`, `ask_human`,
  `search_knowledge`, `get_knowledge_doc`, `propose_knowledge`, `ripgrep`, and
  `propose_standup_improvement` tools.
- **`~/.claude/skills/standup/` + a managed block in `~/.claude/CLAUDE.md`** —
  the [agent steering](#agent-steering--the-self-improvement-loop) that makes
  every session actually *use* the knowledge base without being told to. The
  CLAUDE.md block is delimited by `<!-- BEGIN STANDUP STEERING -->` … `<!-- END
  STANDUP STEERING -->` and is added / updated in place / removed on later runs
  — it never duplicates and never touches your own content outside the markers.

Steering-only and uninstall paths:

```bash
bun run setup:steering          # install/update just the steering
bun run setup:remove-steering   # remove the CLAUDE.md block + the skill
bun run scripts/setup-hooks.ts --no-steering   # hooks + MCP only
```

Idempotent — re-running it is safe, and it repairs hook entries an earlier
run may have written in the wrong shape. `COLLECTOR_URL` (default
`http://localhost:7777`) controls both the hook URL and the MCP server's
target, so overriding it once keeps both in sync:

```bash
COLLECTOR_URL=http://localhost:9000 bun run scripts/setup-hooks.ts
```

Hooks and MCP servers are both read once at session start, so a session
already running won't pick up changes — start a fresh one after running this.

To scope either one to a single project instead of globally, add the
equivalent config to a project-level `.mcp.json` / hooks entry in that repo
instead of the global files above:

```json
{
  "mcpServers": {
    "standup": {
      "command": "bun",
      "args": ["run", "/path/to/standup/packages/mcp/src/index.ts"],
      "env": { "COLLECTOR_URL": "http://localhost:7777" }
    }
  }
}
```

### Agent Steering & the Self-Improvement Loop

Standup only pays off if agents actually *use* the knowledge base — an agent
with the tools available but no standing instruction never reaches for them. So
`bun run setup` installs standing steering that makes it **just happen** for
every session on the machine, not just console-launched ones:

- a **`standup` skill** (`~/.claude/skills/standup/SKILL.md`) — the full
  workflow, loaded when the model recognizes a relevant task; and
- a **managed block in the global `~/.claude/CLAUDE.md`** — the always-on,
  behavioral summary.

Together they steer every session to:

1. **Consult the KB before implementing** — `search_knowledge` with
   natural-language questions, then `get_knowledge_doc` on the best hits, to
   ground the work in prior decisions and conventions.
2. **Contribute learnings back as it goes** — `propose_knowledge` for durable
   facts, gotchas, decisions; and fix stale or wrong docs the same way.
3. **Improve the KB** — propose corrected or missing docs a future agent needs.
4. **Fire a self-fix when Standup itself is the problem** — when an agent (or a
   user) notices Standup is broken, has a knowledge gap, or behaves oddly, it
   asks *"I think this is a gap in Standup itself — want me to fire the fix?"*
   and, on your **yes**, calls `propose_standup_improvement`.

> This complements the launcher's own opening-prompt steering
> (`KNOWLEDGE_FIRST_INSTRUCTION`), which reaches only console-*launched* panes.
> The CLAUDE.md block + skill reach **every** session, including ones you start
> by hand in your own terminal.

#### `propose_standup_improvement` — Standup fixing itself

The self-improvement loop closes the circle: Standup can dispatch a fix against
its own repo. The tool takes `{ title, description, kind: bug | kb-gap |
feature }` and is **confirmation-gated**:

1. It surfaces the proposal to you in the console as a blocking ask (the same
   `ask_human` machinery), so nothing happens silently.
2. **Only on your approval** does it launch a Claude session against the
   launchable **`standup`** self project — the Standup repo itself — with the
   fix as its task, reusing the ordinary launch path. It returns the launched
   session id.
3. If you **decline**, **dismiss**, or it **times out**, *nothing is launched*.

The self project is created idempotently on first use, pointing at this
collector's own checkout (override with `STANDUP_SELF_REPO`). The launched fix
agent is itself steered knowledge-first, so it grounds the fix in the KB and
contributes back what it learns — the loop feeding itself.

### Project Knowledge

Human-authored context per project — business intent, cross-project connections,
coding practices — that agents can query with `search_knowledge`. See
`config/knowledge.example/` for the expected layout:

```
~/.config/standup/knowledge/{project-id}/
├── overview.md        # what this project is, why it exists
├── connections.md      # how it relates to other projects
└── practices.md         # coding conventions to follow
```

Files are indexed on collector startup and reloaded automatically when changed.
Text search (SQLite FTS5) always works. Embedding search is optional — set
`EMBEDDING_PROVIDER` to enable it (see [Embedding providers](docs/embedding-providers.md)):

```bash
# Local, no API key needed (requires Ollama running with nomic-embed-text pulled)
EMBEDDING_PROVIDER=ollama bun run dev

# Or a remote provider
EMBEDDING_PROVIDER=voyage VOYAGE_API_KEY=... bun run dev
EMBEDDING_PROVIDER=openai OPENAI_API_KEY=... bun run dev
```

Without `EMBEDDING_PROVIDER` set, the collector uses a local Ollama if one
answers on `localhost:11434`; otherwise `search_knowledge` falls back to
text-only search.

Embedding search runs a brute-force cosine scan by default and transparently
upgrades to a `sqlite-vec` KNN index when the process is backed by an
extension-capable SQLite. On Linux bun's bundled SQLite already loads extensions,
so the KNN path is on with nothing to install (and `STANDUP_SQLITE_PATH` has no
effect, since bun ignores a custom SQLite there); on macOS the bundled SQLite has
no dynamic extension loading, so one must be swapped in. The collector attempts
this **automatically at startup** — on a host with an extension-capable SQLite
(e.g. Homebrew's `sqlite`, or one pointed at by `STANDUP_SQLITE_PATH`) the KNN path turns on with no
configuration; on a host without one it is a clean no-op and search stays on the
brute-force scan. The attempt is fully guarded (each candidate is validated in a
throwaway child process before it is applied), so it never leaves the process on
a broken SQLite. Set `STANDUP_DISABLE_VEC=1` to force the brute-force path.

Agents also get a `ripgrep` MCP tool for exact pattern matching over code — useful
alongside `search_knowledge` when the question is about code structure rather than
intent.

### Launching Sessions

Type a task in the composer at the bottom of the Feed, pick a project, and
Standup will create a git worktree off the project's base branch, run its
`setup` command, and start a detached tmux session running Claude Code there.

Because Standup *owns* a launched session's tmux pane (unlike a monitored
session, where you have the terminal and it does not), launches get controls
a monitored session doesn't — right in the feed entry:

- **view output** — reads the session's screen without attaching
- **send input** — types straight into it, landing immediately rather than
  queueing for a turn boundary the way a steer does
- **stop** — kills the agent but keeps the worktree and branch

For a full interactive terminal, still attach directly:
`tmux -S ~/.local/share/standup/tmux/workers attach -t standup-<project>-<slug>`
(`Ctrl-b d` to detach; from inside another tmux, prefix it with `TMUX=`; with
`DB_PATH` set, the socket is `tmux/workers` next to that DB).

Launched sessions run on a tmux server of their own, whose socket is in
Standup's data dir (`<dataDir>/tmux/workers`, in a 0700 dir), not under
`/tmp`. In each pane `$TMUX` and `$TMUX_PANE` are removed and `TMUX_TMPDIR`
points at a private per-launch dir (`$TMPDIR/standup-tmux-<uid>-<id>`, or
under `/tmp` when that path is too long for a socket), so a worker's bare
`tmux kill-server`, or one with `-L <name>`, reaches only servers the worker
started itself. That dir stays after the launch ends, since a process the
worker detached may still use it. A test collector started from a worker,
with its own data dir, gets its own workers' socket under that dir.

The safety floor holds any worker tmux command that names the workers'
socket (by `-S` or a `$TMUX` that points at it), and its hold on Standup's
data covers links to, moves of and code naming that path. It holds a tmux
command that isn't read-only or pane-creating when its `TMUX_TMPDIR` isn't a
directory, or another step may remove it first (an earlier `rm`/`mv`, one
running alongside, or anything before a trap that runs the kill fires): tmux
skips such a TMUX_TMPDIR and uses `/tmp`, where the default server is.

The collector starts the workers' server, so it lives in the collector's
service cgroup: the service needs `KillMode=process` (a systemd drop-in) or
every collector restart ends every worker.

The real-tmux regression test is opt-in, because it starts and kills real
servers: `bun run test:tmux` in `packages/collector`. The safety floor holds
that run for review; a plain `bun test` skips the file.

**Sessions on the default server.** A session launched by a collector that
ran its workers on the default server (or the one in the collector's own
`$TMUX`) keeps running there until it ends. The collector lists the
sessions on that server (again every 30 seconds, so ones an older collector
still starts during a handoff are picked up); only listed names are looked
for there. Every tmux call for a launch (`capture-pane`, `send-keys`,
`kill-session`) goes through `sessionTmux`, which uses the workers' server
unless the session is one of those listed names and is still alive on the
old server. The liveness check the reaper and recovery use (`sessionAlive`)
lists the old server again, at most every 5 seconds, before it reports a
session found on neither. So `recover_session`, interrupt, view output, send
input and stop all keep working on an old session. Resume still refuses a
session whose old pane is alive (two processes would share one transcript);
once it has ended, the resumed pane starts on the workers' server, like
every new launch. An old session is attached the old way
(`tmux attach -t <name>`), even though the console shows the new command.

Worktrees live in `~/.local/share/standup/worktrees/` (override with
`STANDUP_WORKTREE_ROOT`). Cleaning up a launch removes the worktree and kills
the tmux session but **leaves the branch** — uncommitted work shouldn't
vanish because of a misclick.

Requires `tmux` (installed automatically by `check-deps.ts` on macOS) and a
project with at least one entry in `repos`.

### Proactive Nudging (opt-in)

When an agent looks stuck, Standup can add one line to its context pointing it
at the knowledge base. It never injects the *answer* — a false positive then costs
a single ignorable sentence instead of derailing an agent that was fine.

Off by default. Check what it would do on your real sessions first:

```bash
bun run nudge:report
```

Every firing in that report is a sentence that would have been injected into
a working agent. If any look like normal work rather than being stuck, raise
the relevant threshold in `STUCKNESS` (`packages/shared/src/constants.ts`)
before enabling. Then:

```bash
STANDUP_NUDGE=1 bun run dev
```

Heuristics are cheap and computed from the stored event stream — no model
call is involved in detection. They cover: the same search repeatedly
returning nothing, consecutive failing shell commands, a long chain of tool
calls with no edit, and the same file read over and over.

Protections against the ways nudging can go wrong:
- **Cooldown** per session *per topic* (default 15 min), so a nudge about
  failing tests doesn't mute one about search
- **Cap** of 2 nudges per turn as a runaway backstop
- Standup's own MCP tools are excluded from detection, so a `search_knowledge`
  round trip can't trigger the nudge that caused it

### Checkpoints

Two sources feed the checkpoint feed. Structural checkpoints are the floor that
always fires; self-reported ones are the layer worth reading:

- **Self-reported** — the agent calls the `checkpoint` MCP tool directly.
- **Structural** — the collector infers checkpoints without agent cooperation:
  `SubagentStop` (when a description is present) and `TodoWrite` calls where an
  item's status flips to `completed`.

### Daily Morning Digest

Once a day at the configured local hour (default 9am `America/New_York`), Standup
summarizes the last ~24h of work across every project with Sonnet and posts it to
the feed on both surfaces (web + Slack). It gathers, per project, the active work,
task runs that finished in the window, non-routine checkpoints, knowledge changes,
resolved asks, and launches; renders a compact summary; and hands it to
`STANDUP_DIGEST_MODEL` (falling back to the plain rendered summary if the model
call returns nothing, throws, or times out — the cron never fails). A window with
no activity still posts a brief "quiet day" digest rather than nothing.

Delivery is persist-then-broadcast (the same durable path knowledge changes use),
so a digest survives a reload/reconnect and lands even with no client connected.
On Slack it goes to the feed channel only when that channel opts in: `feed digest on`
(just the digest; it also makes that channel the standup channel) or `feed on` (every
feed line). Mute it again with `feed digest off`.

**On by default.** Disable with `STANDUP_DIGEST=0` (or the `digest.enabled`
setting set to `false`). Tune the hour, timezone, poll interval, and model with
`STANDUP_DIGEST_HOUR` / `STANDUP_DIGEST_TZ` / `STANDUP_DIGEST_INTERVAL_MS` /
`STANDUP_DIGEST_MODEL`. An anacron per-day gate plus a 9am floor mean a restart
never re-posts, and a process that was down at 9am posts on its first poll after
it returns (best-attempt catch-up).

### Push Notifications

Only asks push — checkpoints stay in the feed. Set `NTFY_TOPIC` to enable:

```bash
NTFY_TOPIC=your-private-topic bun run dev
```

Uses [ntfy.sh](https://ntfy.sh) by default; override the server with `NTFY_URL`
if you're self-hosting. Unset `NTFY_TOPIC` and push is a no-op.

### Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `COLLECTOR_PORT` | `7777` | HTTP hook + REST API port |
| `WS_PORT` | `7778` | WebSocket port |
| `COLLECTOR_URL` | `http://localhost:7777` | Base URL the MCP server and `setup-hooks.ts` target — override once to keep hooks and MCP in sync |
| `DB_PATH` | `~/.local/share/standup/standup.db` | SQLite file location |
| `STANDUP_PROJECTS_PATH` | `~/.config/standup/projects.toml` | Project registry file |
| `STANDUP_WORKTREE_ROOT` | `~/.local/share/standup/worktrees` | Where launched sessions get their worktrees |
| `KNOWLEDGE_DIR` | `~/.config/standup/knowledge` | Project knowledge docs root |
| `STANDUP_KNOWLEDGE_PATH_ROOTS` | unset | Comma-separated extra roots (`/srv,/data/work`) under which a path a knowledge doc names is read as an absolute checkout path, besides the built-in `/Users`, `/home`, `/Volumes`, `/opt` and the directory the host's home dir sits in. The staleness check flags such a path when it is foreign to the host or gone; a path under any other root is not checked |
| `EMBEDDING_PROVIDER` | unset (Ollama if one answers on localhost, else text-only) | `ollama` \| `voyage` \| `openai` \| `bedrock` (see [docs/embedding-providers.md](docs/embedding-providers.md)) |
| `STANDUP_FEDERATION_PROJECTS` | unset (no project federates) | Comma-separated project ids whose `search_knowledge` also queries external retrievers (never `standup`, `standup-self`, `global` or a reserved project). External hits are fused by rank, labeled `[external: <label>]`, and never ingested |
| `STANDUP_FEDERATION_COMMANDS` | unset | JSON array of command retrievers, `[{"id","label","command":[argv...],"timeoutMs"?}]`. The command reads the query on stdin and prints one `{"title","ref"\|"url","excerpt"}` JSON object per line; each gets its own budget (default 1500 ms) and a failing one never fails the search |
| `STANDUP_DISABLE_VEC` | unset (auto-on) | Set to `1` to force the brute-force cosine scan even where `sqlite-vec` could load |
| `STANDUP_SQLITE_PATH` | unset (auto-detect Homebrew) | Path to an extension-capable SQLite library to back the process so `sqlite-vec` can load |
| `STANDUP_SQLITE_VEC` | unset | No-op — vec0 is auto-on when available; still accepted, superseded by the auto-detect above |
| `NTFY_TOPIC` | unset (push disabled) | ntfy.sh topic for ask push notifications |
| `NTFY_URL` | `https://ntfy.sh` | ntfy server, for self-hosting |
| `STANDUP_NUDGE` | unset (off) | Set to `1` to enable proactive nudging |
| `STANDUP_DIGEST` | unset (on) | Daily morning digest master switch — DEFAULT ON; set `0`/`false`/`off` to disable (or the `digest.enabled` setting to `false`) |
| `STANDUP_DIGEST_HOUR` | `9` | Local hour (0–23) the digest floor opens at — before it, a poll waits |
| `STANDUP_DIGEST_TZ` | `America/New_York` | Timezone the digest date/hour are computed in |
| `STANDUP_DIGEST_INTERVAL_MS` | `900000` (15 min) | How often the digest cron polls for the daily floor |
| `STANDUP_DIGEST_MODEL` | `claude-sonnet-5` | Model the digest summary is written with |
| `STANDUP_BIND_HOST` | `127.0.0.1` | Host the HTTP + WS ports bind to; set `0.0.0.0` to expose the collector to the network (e.g. behind a tunnel). Every route then checks the caller (`packages/collector/src/caller-guard.ts`): a name other callers dial must be in `STANDUP_ALLOWED_HOSTS`, and a caller on another machine needs a credential (the console's sign-in, `STANDUP_WRITE_TOKEN`, a worker's or Persona's token, or a `STANDUP_TRUSTED_PROXIES` identity) |
| `STANDUP_ALLOWED_HOSTS` | unset | Comma-separated `host[:port]` names, besides loopback names and a specific bind address, that a request's `Host` may name. Any other `Host` (DNS rebinding) is refused on every collector route. The console's proxy rewrites `Host`, so a rebinding page reaching it is stopped there instead: Vite's host check on HTTP, and on `/ws` the proxy keeps the page's `Origin` for the collector to refuse |
| `STANDUP_WEB_URL` / `STANDUP_CONSOLE_ORIGIN` | unset | The console's public URL. Besides links, the collector admits it as a cross-origin `Origin` (with `http://localhost:5173`); every other cross-site browser request is refused |
| `STANDUP_IDENTITY_HEADER` | an authenticating tunnel provider's `STANDUP_TUNNEL_IDENTITY_HEADER`, else `DEFAULT_IDENTITY_HEADER` in `packages/shared/src/constants.ts` | Request header the identity provider reads the acting user from (see below). The collector and the console proxy resolve it the same way (`resolveIdentityHeader`) |
| `STANDUP_IDENTITY_AUTH` | `none` | Auth mode for request identity; only `none` is supported today |
| `STANDUP_TRUSTED_PROXIES` | unset | Comma-separated source addresses trusted to have injected the identity header (in addition to loopback) |
| `STANDUP_WRITE_TOKEN` | unset | Optional out-of-band write token (presented as `x-standup-write-token`) gating profile / coordination writes on a shared or network-exposed collector |
| `STANDUP_OWNER_TOKEN_FILE` | `<dataDir>/secrets/owner.token` | Where an owner channel (the web dev server, the Slack adapter) reads the owner secret from. The collector always writes it under its own data dir; set this on a channel that runs elsewhere and holds a copy |
| `STANDUP_WRITE_TOKEN_FILE` | `~/.standup/write-token` | Per-user local write token. The collector creates it at startup (0600, random) and accepts it as `x-standup-write-token`; the MCP server sends it automatically when `STANDUP_WRITE_TOKEN` is unset, so the operator's own local agents clear the write gate while remote and other-user callers still need `STANDUP_WRITE_TOKEN` |
| `STANDUP_PERSONAL_AWS_ACCOUNTS` | unset (none) | Comma-separated AWS account ids whose holds go to Persona instead of the owner (see [Project Registry](#project-registry)). Set it to your own dev accounts, or every AWS change your agents make there waits on your card |
| `STANDUP_FLOOR_NONPROD_AWS_ACCOUNTS` | unset (none) | Comma-separated shared test account ids: a mutating AWS call there is a `nonprod-aws` hold Persona may allow |
| `STANDUP_FLOOR_OWNER_HOSTS` | the org profile's `ownerHostPatterns` (none by default) | Comma-separated host globs of your own machines; ssh, scp and rsync there are `owner-host` holds. A `*` stays within one DNS label and no domain is appended, so give the full host (`devbox-alice-*.example.corp`) |
| `STANDUP_FLOOR_STANDUP_HOSTS` | the host of the tunnel provider's `<owner>-standup` tunnel, if any | Comma-separated hostnames serving Standup's API besides the collector URL; a call there is held as `standup-ops` |
| `STANDUP_FLOOR_READONLY_MCP` | unset | Comma-separated MCP tools (`server__tool` or `server__*`) the floor treats as read-only |
| `STANDUP_FLOOR_WEBFETCH_DOMAINS` | unset | Comma-separated domains WebFetch may read besides the built-in documentation list |
| `STANDUP_FLOOR_WORKTREE_ROOTS` | unset | Comma-separated dirs, besides `<dataDir>/worktrees`, `STANDUP_WORKTREE_ROOT`, the `worktreeRoot` setting and a project's own root, that the floor treats as launch worktree roots |
| `STANDUP_FLOOR_WAIT_S` | `3600` | Longest a floor hold waits for a decision, in seconds |
| `STANDUP_ORG_PROFILE` | `~/.config/standup/org-profile.json` | Org profile path (see [Org profile](#org-profile)) |
| `STANDUP_TRACKER` / `STANDUP_TRACKER_NAME` | `none` | Issue tracker (see [Issue tracker](#issue-tracker)) |
| `STANDUP_TUNNEL_*` | `STANDUP_TUNNEL_PROVIDER=disabled` | Tunnel provider (see [Tunnel provider](#tunnel-provider)) |
| `STANDUP_REVIEW_TUNNEL_RESERVED_PORTS` / `STANDUP_REVIEW_TUNNEL_RESERVED_SUFFIXES` | unset | Ports and tunnel name suffixes a review tunnel never takes, besides the built-in ones (see [Tunnel provider](#tunnel-provider)) |
| `STANDUP_PROJECT_LAYOUT` / `STANDUP_WORKSPACE_*` | `git` | Project layout (see [Project layout](#project-layout)) |
| `STANDUP_PUBLIC_KB` | unset (off) | Set to `1` to serve the read-only team knowledge API on a Unix socket (see [docs/design/public-knowledge-api.md](docs/design/public-knowledge-api.md)) |
| `STANDUP_PUBLIC_KB_IDENTITY_HEADER` | unset | The header the relay in front of the knowledge API's socket stamps with the caller's alias. Required: without it the API doesn't listen |
| `STANDUP_PUBLIC_KB_SOCKET` | `<dataDir>/public/kb.sock` | The knowledge API's socket path; its directory must be private to you |
| `SLACK_IDENTITY_EMAIL_DOMAIN` | the org profile's `identity.emailDomain`, else unset (no merging) | Slack adapter: the mail domain whose addresses are `<alias>@<domain>`. A Slack user with an email at exactly this domain is counted as that alias. A set value that is not a domain (`none`) turns merging off even when the org profile names one (see `packages/slack/README.md`) |

### Identity provider

Request-identity resolution is a pluggable **identity provider**: an **auth
mode** plus a **user-identifier source** (an HTTP header whose name is
configurable), resolved once at startup and shared by both the REST (`/api/*`)
and WebSocket paths so the two can't drift. The config shape
(`IdentityProviderConfig`, in `@standup/shared`):

```ts
{
  auth: "none",                                            // STANDUP_IDENTITY_AUTH
  userIdentifier: { type: "http-header", header: "…" },    // STANDUP_IDENTITY_HEADER
  trustedProxies: string[],                                // STANDUP_TRUSTED_PROXIES
  loopbackIsTrusted: boolean,                              // see below
}
```

The default reads `DEFAULT_IDENTITY_HEADER` (`x-tunnel-user`) with no auth
challenge and no extra trusted proxies. The identifier header is **trusted only from a loopback
source or a configured trusted proxy** — a client-supplied header on a raw
network bind is never trusted, so it falls back to the host `$USER` on loopback
and to `anonymous` on a network-headerless request. A loopback source is
trusted only while no tunnel provider is open or the provider's
`STANDUP_TUNNEL_IDENTITY_HEADER` is the header read here (see
[Tunnel provider](#tunnel-provider)). Point `STANDUP_IDENTITY_HEADER` at the
header your authenticating proxy or tunnel stamps (and set
`STANDUP_TRUSTED_PROXIES` for the proxy's address when it isn't on loopback).
If your proxy stamps any other header, set `STANDUP_IDENTITY_HEADER` to it:
the collector doesn't read it otherwise, so every visitor resolves to the host
user, and a visitor who sends `x-tunnel-user` through a proxy that doesn't
strip it can name any user.
`STANDUP_WRITE_TOKEN` is a separate write-authorization gate, orthogonal to
identity.

## Documentation

- [Claude Code internals](docs/claude-code-internals.md) — Verified behavior Standup depends on. Read before writing code against any Claude Code behavior.
- [Agent instructions](docs/agent-instructions.md) — How Standup's own prompts and instructions are written.
- [Embedding providers](docs/embedding-providers.md) — Configuring embedding search.
- [Knowledge system](docs/knowledge-system.md) — Knowledge layers, the retrieval eval and its regression gate, and data migrations.
- [Design notes](docs/design/) — Per-user Persona, Persona action gating, the preference miner and the public knowledge API.

## License

MIT — see [LICENSE](LICENSE).
