# Team notes for Claude Code

A sample set of team conventions for every project, not only Standup. Append
this file to your `~/.claude/CLAUDE.md` (below the Standup block that
`bun run setup` installs), then rewrite it to match how your team works.

## Before writing code

- Read the project's README and the tests next to the code you will change.
  When the file already has a style, follow it, even where you would choose
  differently.
- If the request can be read two ways and the readings lead to different
  designs, ask. Otherwise pick the likelier reading and say which one you
  picked.
- For a change that spans more than a few files, post a short plan first:
  the files you expect to touch and how you will know the change works.

## Writing code

- Make the smallest change that solves the problem. Write down unrelated
  clean-ups you notice as follow-ups instead of folding them into the change.
- Don't swallow errors to get past a failure. Let them surface, or handle
  them with a message that says what went wrong and what to do about it.
- Add a new dependency only when the standard library or an existing
  dependency can't do the job, and say why in the pull request.
- Comments explain why the code is shaped the way it is; see the knowledge doc
  `comments-explain-why-not-what`.

## Testing

- A bug fix comes with a test that fails before the fix and passes after it.
- Run the narrowest test command that covers your change while you iterate,
  then the package's full suite before you call the work done.
- Never report a task as finished while a test you added or touched is red or
  skipped. Say what is failing and what you tried.

## Git and pull requests

- Name branches `<type>/<short-topic>`, for example `fix/login-redirect`.
- Commit subjects are imperative and at most 72 characters; the body says why
  the change is needed.
- Bring the branch up to date with the main branch before you ask for review;
  see the knowledge doc `rebase-before-opening-a-review`.
- A pull request description has a **Summary** (what and why, in plain
  words), **How to test** (commands or steps a reviewer can repeat),
  **Screenshots** for any visible UI change, and **Follow-ups** for work you
  left out on purpose.
- Answer every review comment, with a change or with a reason for not making
  one.

## Environments and secrets

- Staging and production change only through the deploy pipeline. If a task
  seems to need a manual change to a shared environment, stop and ask.
- Secrets never go into the repo, a log line, a test fixture, or a chat
  message. Read them from the environment or the team's secret store.
