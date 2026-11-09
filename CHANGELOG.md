# Changelog

New features and fixes that land on Standup's `main`, newest first, in the
style of [Keep a Changelog](https://keepachangelog.com/). Each landing adds
an entry here.

## Unreleased

### Changed
- Org-specific integrations sit behind five seams, each with a neutral default: the code review adapter (`generic`, `github-pr`), the issue tracker (`STANDUP_TRACKER`), the tunnel provider (`STANDUP_TUNNEL_*`), the project layout (`STANDUP_PROJECT_LAYOUT`) and the org profile (`STANDUP_ORG_PROFILE`), which carries an org's vocabulary for the safety floor and Persona's allow check. The pipeline's review stage is `code_review`.
- The default identity header is `x-tunnel-user`.
- The public knowledge API reads its caller only from `STANDUP_PUBLIC_KB_IDENTITY_HEADER`, which has no default.
- The Slack adapter merges a Slack user into an alias only when their email is at the identity email domain: `SLACK_IDENTITY_EMAIL_DOMAIN`, else the org profile's `identity.emailDomain`. With neither, it merges no one. A `SLACK_IDENTITY_EMAIL_DOMAIN` value that is not a domain (`none`) turns merging off even when the org profile names a domain.
- The floor reads any CLI that names a role and an AWS account as a credential write, holds any CLI's credential print, and treats a cookie-named file under a home dot dir as a secret, with no profile needed.
- Persona's production check reads `prod`, `production` and `prd`, each with an optional number (`Svc-prod1`); a region-code suffix glued to `prod` is no longer read as production.
- The decision port has one built-in backend, `claude`.
- The Codex composer offers the Codex CLI's own default model and a free-text model id.
- `STANDUP_REVIEW_TUNNEL_RESERVED_PORTS` and `STANDUP_REVIEW_TUNNEL_RESERVED_SUFFIXES` add standing tunnels a review tunnel never takes.

### Removed
- The external decision-model backend and its settings.
- Migration 097 is a no-op: stored values from earlier builds are not rewritten.

### Upgrading an existing install
- Start on a fresh database. Earlier builds stored the review stage, its evidence and links, and some project and ticket values under older ids, and this build does not rewrite them. On start, Standup checks stored values before it migrates anything. It refuses to start when a value is one this build never writes: a pipeline stage kind no code registers, a run's current stage or stage attempt that its own pipeline definition lacks, a board or review-packet link key, or a tracker ticket lens. The error names each value and where it is stored. To start fresh, stop Standup, move the database file and its `-wal` and `-shm` files aside, and start Standup again. Values this build can write itself are logged as a warning and Standup starts: a `codeReviewAdapter` in `projects.toml` that no adapter has (read as unset; fix it and import `projects.toml` again), a pipeline layer that names a stage no pipeline it applies to has, and a damaged run definition.
- In `projects.toml`, a project's code review adapter is set only by `codeReviewAdapter`; the older `reviewArtifactProvider` key is not read.
- If your proxy or tunnel stamps an identity header other than `x-tunnel-user`, set `STANDUP_IDENTITY_HEADER` to it. Otherwise every visitor resolves to the host user, and a visitor can name any user by sending `x-tunnel-user` through a proxy that doesn't strip it.
- The public knowledge API needs `STANDUP_PUBLIC_KB_IDENTITY_HEADER` beside `STANDUP_PUBLIC_KB=1`; with only the latter it doesn't listen.
- To keep merging Slack users into their aliases, set `SLACK_IDENTITY_EMAIL_DOMAIN` or the org profile's `identity.emailDomain`.
- Write an org profile for your org's internal hosts, owner hosts, SSO dirs, review CLI, credential CLIs and read-only MCP tools. Without one they are read as any other host, file, program or tool: an unlisted review CLI is not held as a review, and an SSO dir with no cookie-named file is not a secret.
- Owner-host globs match only the host you write (`*` stays within one DNS label and no domain is appended), so give the full name, such as `devbox-{owner}-*.example.corp`.
- `STANDUP_PERSONAL_AWS_ACCOUNTS` and `STANDUP_FLOOR_NONPROD_AWS_ACCOUNTS` have no built-in account ids. Set them, or AWS changes in those accounts go to the owner's card.
- Knowledge staleness reads absolute checkout paths only under `/Users`, `/home`, `/Volumes`, `/opt` and the directory the host's home dir sits in. If your docs name checkouts under another root (such as `/srv` or `/data`), list it in `STANDUP_KNOWLEDGE_PATH_ROOTS` to keep those paths flagged as foreign or stale.
- Worktree roots outside `<dataDir>/worktrees` need `STANDUP_WORKTREE_ROOT`, the `worktreeRoot` setting or `STANDUP_FLOOR_WORKTREE_ROOTS`.
- A workspace of several git checkouts needs `STANDUP_PROJECT_LAYOUT=workspace` and its `STANDUP_WORKSPACE_*` settings. A project whose review tool attaches an issue id needs `{issueId}` in the profile's `codeReview.cutCommand`, and one detected by its remote needs `codeReview.remotePatterns` or `codeReviewAdapter = "generic"`.

## 2026-10-22

### Added
- Doc owners can comment on passages of their own docs, shared or not, and always see every comment in the margin; Comment is an icon in the editor's selection toolbar (a matching chip in the read-only view, or Ctrl/⌘+Alt+M), the doc agent never replies to the owner's own comments, and the owner can reply to, resolve or reopen any comment.

## 2026-10-21

### Added
- `kb:export --from api` writes a shareable knowledge bundle from a running collector's read API, plus the Docs tab and an index of docs and links, without reading its database.

### Changed
- When the second check flags an allow of a high-risk hold on an isolated scratch run, the hold delegate reviews it first, and the owner's card goes up only if it denies the hold or has concerns; holds that read secrets or reach Standup's data, floor or install, outward steps and AWS changes still go to the owner's card.

### Fixed
- Two failing tests: a waiting MCP call's restart window counts the supervisor's migrate timeout, and the pipeline test world no longer runs the real `claude` CLI to title a session.

## 2026-10-20

### Added
- Persona hands floor holds and permission prompts to a background hold delegate, so its own thread stays free for the owner.
- Shareable docs and folders for signed-in users, with comments on a passage of a doc and a doc agent that answers them.
- A launch's base branch is resolved on top of its target branch.
- Tunnel hosts are accepted, and share links are built on `STANDUP_WEB_URL`.
- Persona's composer sends to the one job its filter shows.

### Fixed
- The console-login test calls the sign-in logic in-process instead of running the real login script.
- The floor no longer holds a test that only imports the owner login script's functions.
- Persona starts quickly again on an install with many pending floor holds and a long inbox, so the collector answers its health check during a restart.
- A restart waits for a new collector that is still backing up or migrating a large database, instead of timing out and rolling back.

## 2026-10-19

### Added
- Persona can list signals for a weekly review and search its own thread.
- Persona handoffs keep anchors to the messages they summarize.
- Workers can put images in the docs they write.
- Persona's profile has a size budget and a view in the console.
- A redesigned pipeline-waiver snapshot on the review page.
- Docs editor: `/image` opens a file picker and stores the image beside the doc.

### Fixed
- Quick-reply taps carry the question they answer.
- The distiller updates the doc a session used instead of adding a new one.
- Fewer floor holds for SSO calls and scratch test harnesses.

## 2026-10-18

### Fixed
- The floor no longer treats Standup scratch dirs as owner secrets.
- Nightly jobs use the repo's default branch instead of assuming `main`.
- `write_doc` writes atomically.
- Subagent permission prompts reach the hold path.
- Test baseline fixes.

## 2026-10-16

### Added
- Cheaper schedule watchers.
- Checks on who may call each API route.

### Fixed
- Fewer false floor holds: isolated live checks, personal AWS account reads, a worker's own scratch dir, read-only searches, StructuredOutput, and a shell-parser quoting bug.
- The full test suite passes when run from a launched worker.

## 2026-10-15

### Changed
- Knowledge-base steering is always on.

### Fixed
- Stale docs and silently accepted proposals are caught by the nightly run.
- Floor path resolution and isolated-collector holds.

## 2026-10-14

### Added
- A RAM command and the bunny pixel-art view.
- Setup instructions.

## 2026-10-13

### Added
- Mermaid diagrams in the Docs tab, with the source hidden by default.
- Screenshots embedded in docs.
- Persona's doc tools return links.
- A reconnect banner in the console, and a smaller boot payload.

### Changed
- The floor is loose by default.

### Fixed
- Launch steps that time out are killed; stranded "starting" launches are reconciled.
- Review cron tests, board-test timers, and a knowledge-eval recall gate.
- A gateway WebSocket leak.

## 2026-10-12

### Added
- The Docs editor and shared links, including share links for folders.
- A Board tab for Persona that updates live.
- Slash commands in the console.
- Schedule expiry and handling for failed scheduled runs.

### Fixed
- Orphaned imported sessions are closed.
- The idle reaper cleans up worker scratch dirs.
- Landed knowledge rewrites are fact-checked.
- Console refetches are coalesced; snapshot N+1 queries and timing flakes are gone.

## 2026-10-10

### Added
- A commitments ledger for Persona.
- Video attachments in Persona chat.
- A daily brief, a playbook library, and a second check on allow-once.
- Per-project delivery pipelines, with a review tunnel stage and screenshots in review packets.
- Code review descriptions in the review-packet shape.
- Persona auto-compacts at 40% context.

### Fixed
- The Review tab badge updates live; the sidebar agent count is right.
- Persona chat live updates, review media paths, and a packet/code review deadlock.
- The job graph shows only the live launch.

## 2026-10-09

### Added
- Image and video uploads to Persona.
- A knowledge API for the team.
- Native permission prompts for workers.
- Lazy routes for a faster console load.

### Fixed
- Owner-only cards are visible to the owner; allow-once cards are quieter.
- Lower memory use when ingesting transcripts.
- Hook routes require auth.

## 2026-10-08

### Added
- The delivery pipeline graph, with a human review stage in the Review tab.
- Job tags on Persona messages.
- Zero-downtime restarts.
- Job status derived automatically.
- Cost in the You tab.
- A Persona and schedules for each user.

### Fixed
- A session isn't marked done while its subagents still run.
- Non-coding launches skip the pipeline.
- Persona decides owner gates on the floor itself.

## 2026-10-07

### Added
- A job drawer and job tagging for Persona.
- Host capacity labels in the UI.
