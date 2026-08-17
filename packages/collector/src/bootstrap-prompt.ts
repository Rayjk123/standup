import type { Project } from "@standup/shared";

/**
 * The research prompt for a knowledge-bootstrap run.
 *
 * This is the load-bearing part of the phase. Everything around it —
 * draft storage, the gated tool, the launch route — is plumbing over
 * components that already existed. The prompt decides what gets written,
 * and its failure mode is not a crash: it is a knowledge base full of
 * plausible, derivable, slowly-rotting summaries that outrank real
 * retrieval and quietly make every future answer worse.
 *
 * Three things it has to hold, from Component 4.6:
 *
 * - The capture/leave-to-retrieval split, concrete enough to be applied
 *   *while* writing. Hence the explicit list-then-filter-then-write
 *   procedure rather than a description of the principle: an agent that
 *   filters after drafting keeps what it already wrote.
 * - A hard prohibition on inventing intent. `overview` and `connections`
 *   are stubs *by construction* — their deliverable is a list of questions,
 *   so producing questions is the task rather than a caveat on prose. An
 *   agent told merely to "be careful about intent" writes careful-sounding
 *   intent anyway.
 * - Brevity, as a cap rather than a preference. A long generated doc is
 *   more surface to go stale and more noise in every retrieval.
 *
 * `gotchas` is named as the highest-value document because it is the one
 * that best passes the many-files test, and an agent left to its own
 * priorities will pour its effort into `architecture` instead — that being
 * the one that feels most like real documentation, and is most nearly
 * derivable from the code it is supposed to complement.
 *
 * Expect to iterate on this against Step 7's numbers rather than by
 * reading it and finding it reasonable.
 */
export function bootstrapPrompt(project: Project): string {
  // Naming the project's own setup command makes "verify it" actionable;
  // without one, asking the agent to verify a command it has to guess at
  // invites it to invent a plausible build sequence.
  const setupLine = project.setup
    ? `This project's configured setup command is \`${project.setup}\` — run it and record what actually happens.`
    : `This project has no configured setup command; work out how it is built and run from the repository itself.`;

  return `You are writing the first draft of the knowledge base for ${project.name}.

Standup keeps a few short docs per project holding what an agent CANNOT
recover by searching the code. Agents working here already have \`ripgrep\`
and \`ask_expert\` over this repository. Anything those tools answer is not
knowledge — it is retrieval, and duplicating it here makes every future
search worse: a generated summary competes with the real file in ranking,
and goes stale the moment the code moves.

Your job is the part retrieval cannot cover. Writing less is the harder
skill here, and it is the one being asked for.

## The test every line must pass

Before a line goes into a document, ask: would an agent have to read MANY
files to work this out?

  Keep                                   | Leave to retrieval
  ---------------------------------------|----------------------------------
  How to build, test, lint, run          | Anything one grep answers
  Conventions you can show hold across   | File and directory listings
  many files                             |
  What talks to what, at module level    | Function signatures, API surface
  Traps: README warnings, TODOs, "don't" | Anything restated from one file
  comments, bug-fix commit messages      |

For each document, work in this order: list the candidate facts first, run
each one through the test, discard the failures, and only then write what
survives. Filtering after you have drafted does not work — you will keep
what you already wrote.

## What you must not do

**Do not write intent.** You cannot know why this project exists, who
depends on it, what it competes with, or which parts are being sunset. None
of that is in the repository. A plausible-but-wrong intent document is worse
than no document, because it reads as authoritative and nobody thinks to
correct it.

If you catch yourself typing "this project aims to", "the goal is",
"designed to enable", or "this was built because" — stop. You are inventing.

**Do not summarize the README.** Anyone who wants the README can read it.

**Do not describe anything you have not run.** Run the build. Run the tests.
Run the linter. If a documented command fails, that failure is worth more
than the command was — write down what actually works.

**Do not modify anything.** You are reading and reporting: no edits, no
commits, no new files in the repository.

## Before you start

Call \`search_knowledge\` to see what already exists for this project. If
documents are already there you are regenerating rather than starting fresh:
read them, and propose a replacement only where you have something genuinely
better or newer. Never restate what a human already wrote.

## What to write

Call \`propose_knowledge\` once per document, using exactly these slugs.
Each lands as a draft for a human to review — nothing you write becomes
searchable until they accept it, so an honest short document costs nothing
while a padded one wastes their time.

Work in this order; the early ones give you the grounding for the later ones.

1. \`toolchain\` — how to build, test, lint and run. Commands you have
   actually executed, plus anything surprising about them: a step that is
   easy to miss, a dependency the package manager does not install, an
   environment variable without which something silently does nothing.
   ${setupLine}

2. \`gotchas\` — the highest-value document, and where your remaining effort
   belongs. Mine README warnings, TODO and FIXME comments, comments that say
   "don't", "note that", "careful" or "must", and commit messages describing
   fixes. You are looking for what would have saved the last agent an hour.
   One real trap is worth more than five true observations.

3. \`practices\` — conventions you can demonstrate hold broadly: error
   handling, naming, test layout, how a new module gets wired in. If you saw
   it in three places it is a convention; if you saw it once it is one
   author's habit and does not belong here.

4. \`architecture\` — what talks to what, at module level only. The shape
   someone needs before any individual file makes sense. No file listings,
   no function signatures.

5. \`overview\` — A STUB. Do not write prose. Write the questions only a
   human can answer, as a checklist for them to fill in: what is this for,
   who depends on it, what breaks if it stops, what is being sunset, what
   would you tell someone in their first hour. You may add ONE sentence on
   what the repository appears to do, explicitly marked as an inference.

6. \`connections\` — A STUB, for the same reason: how this project relates
   to other systems is not in this repository. List what you found that
   HINTS at an external relationship — service URLs, shared package names,
   API clients, deploy config naming other systems — and turn each into a
   question rather than a conclusion.

## Rules

- **Never state a number you have not just counted.** Quantities are both
  the easiest thing to get wrong and the fastest thing to go stale — an
  error count changes the moment someone adds a file. Prefer the durable
  shape: "fails with TS6059 rootDir errors in \`store\`, \`collector\` and
  \`mcp\`; \`shared\`, \`knowledge\` and \`web\` pass" says more than a total
  and stays true longer. If a number genuinely carries the point, name the
  command that produces it so the next reader can recheck instead of
  trusting you.
- If you are supplementing a document a human already wrote, say so in the
  first line and describe what to merge. Do not write a replacement that
  silently drops their work.
- Hard cap of 40 lines per document, and shorter is better.
- If a document would have fewer than five worthwhile lines, propose it with
  only those lines. Padding is worse than brevity.
- Prefer "X, because Y" to "X". The reason is the part that is not greppable.
- Write for an agent that lands in this repository tomorrow knowing nothing.
- Do not write that a document was generated, or when, or from which commit.
  That is recorded automatically, and repeating it wastes your line budget.
- Call \`checkpoint\` between documents so the human can follow along and
  stop you if you are heading the wrong way.`;
}
