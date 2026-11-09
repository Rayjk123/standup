# Working in the Standup repo

## First-time setup

If the user is setting Standup up — or `~/.config/standup/projects.toml` does
not exist, or `~/.claude.json` has no `standup` MCP server — walk them through
README "Getting set up" step by step before anything else. Run the steps you
can; tell the user plainly about the ones only they can do. Don't skip the
manual ones:

1. `bun install`, then check the toolchain table (bun, Node 24, tmux, ripgrep).
2. **Before the first `bun run dev`**, if `~/.config/standup/projects.toml`
   does not exist: `cp seed/projects.toml ~/.config/standup/projects.toml`
   (never overwrite an existing one). The file only seeds the registry of a
   fresh install, and knowledge is indexed only for registered projects.
3. `bun run kb:seed` — copies the sample knowledge docs in `seed/knowledge/`
   (they show the doc format); never overwrites.
4. Ask before appending `seed/claude/CLAUDE.md` to `~/.claude/CLAUDE.md`
   (skip if its `# Team notes for Claude Code` heading is already there).
5. `bun run setup` — hooks, MCP server, steering skill.
6. Tell the user to start `bun run dev` in their own terminal (or the systemd
   unit in README step 6) — it is long-running — and to **open the sign-in
   link it prints** (or run `bun run scripts/console-login.ts`). Until they
   sign in they are not the console owner: they can't answer floor holds or
   approve asks.
7. Tell them to set `STANDUP_PERSONAL_AWS_ACCOUNTS=<their dev account id>`
   for the collector, or the floor holds every AWS change their agents make,
   even in their own dev account.
8. Tell them to start a **new** Claude Code session afterwards; running
   sessions don't pick up the hooks or the MCP server.

Rules for agents changing this repo follow. They exist because Standup's safety
floor holds these calls for the owner, and a held call stalls the session until
the owner answers it.

## Edit with Edit/Write only; write probes as tests

Make source and test changes only with the Edit/Write tools — never
python/perl heredocs, `sed -i`, or shell redirection over a file. Instead of
probing behavior with `bun -e '…'`, put the cases into a table-driven
`*.test.ts` and run `bun test <file>`.

The floor holds heredoc/sed edits (and `bun -e` scripts that contain
policy-pattern strings). Probes written as tests also become regression tests.

## Spell the edit rule out in every subagent prompt

Every subagent prompt that may touch files — reviewers included — must say:
files, including throwaway scratch test files, are written only with the
Write/Edit tools; no python/perl/node inline scripts, no `sed -i`, no heredoc
or shell redirection over a file. Run tests as their own command with nothing
chained (e.g. `timeout 300 bun test <file>`). A prompt that only says
"Write/Edit only" is not explicit enough about scratch files and inline scripts.

## Never read the live Standup DB or API

Never read the live database or anything under `~/.local/share/standup`, even
read-only, and don't call the live collector HTTP API. Put this rule in every
subagent prompt too.

- Schema and migration numbers: read `packages/store/src/migrations.ts`.
- Data shapes: read the code, and seed a scratch DB under `/tmp` in tests.
- Live counts: use Standup's MCP read tools (`whats_happening`, etc.).
- Migrations must be idempotent and work on any data volume; never rely on counts.

The owner can lift this for one specific task; that permission covers only
that task.

## Never reshape a floor-denied call

When the floor holds a call and it is denied, never reword or reshape the
command, script or its fixtures so the floor stops seeing it. Treat the deny as
final for that intent: explain what you wanted to run and ask the owner. If the
hold looks like a false positive, offer a floor fix job instead of working
around it.

## Don't resubmit a review packet unasked

Once a review packet is submitted and the owner has its link, don't call
`submit_review_packet` again unless the owner (or Persona) asks for a revision —
each resubmission creates a new `/review/<id>` link and the old one goes stale.
Report small errors in chat instead, and get the packet right before the first
submit (verify test exit codes and counts first).
