---
title: 'Comments explain why the code is shaped this way; the code itself says what it does'
tags:
  - conventions
  - code-style
  - comments
  - todo
origin_class: owner
source_kind: decision
scope: global
confidence: 0.9
half_life_days: 365
---
Write a comment when the reason behind a piece of code can't be read from the
code. Good reasons to comment:

- a workaround for a bug in a library or platform, with a link to the upstream
  issue so the next reader can check whether it is still needed;
- an invariant the code depends on but doesn't check, such as "the list is
  already sorted by the caller";
- a choice made for performance or compatibility that looks wrong at first
  sight;
- a limit imposed from outside the repo, such as an API quota or a field
  length in another system.

Leave out comments that restate the next line in English. Delete
commented-out code instead of keeping it; version control already has it.
A `TODO` names an issue (`TODO(#123): …`) so it can be found and closed.

On an exported function, the doc comment states the contract: what the
arguments mean, what it returns, and which errors it raises. It doesn't
describe the implementation.

When you change code, update or delete the comments next to it in the same
change.

**Why:** readers trust comments. A missing comment costs a reader some time;
a comment that has gone wrong sends them the wrong way.
