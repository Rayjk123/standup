# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

One engineer-owner running Standup as a chief-of-staff dashboard for many Claude Code worker sessions at once. They check in between other work, often from a phone over the tunnel, to see what needs them, answer it, and get out. Teammates can join over the tunnel as participants, but the owner is the user the console is built around; owner actions (approvals, merges, decisions) need the owner's signed-in token, and anyone without it, including a teammate on the tunnel, is refused.

## Product Purpose

Standup's web console is where the owner supervises a fleet of agent sessions without living in a hundred terminal tabs. It shows every session in one place, pings only when an agent actually needs a human, and lets the owner decide, steer or approve in one tap. Success is the owner spending seconds, not minutes, per check-in: they see what is waiting on them, act on it, and trust that everything else is running.

## Positioning

For workers it launches, Standup owns the tmux pane on the owner's own machine: the console can view the session's live output, send input that lands immediately, and stop a run mid-flight, and code never leaves the box. Sessions started outside Standup are monitored only. Persona, an always-on orchestrator, turns requests into jobs, launches and watches workers, answers their routine questions, and holds every outward-facing step (push, code review, merge, deploy, posting) as an approval card. A shared, cross-project knowledge graph is injected into every launch.

## Operating Context

- **Persona chat** — the owner messages Persona instead of picking a project and session; approvals, asks and job updates surface here.
- **Board** — the cross-job status view; its "waiting on you" rule (`packages/shared/src/board.ts`) is the authority every other view must agree with.
- **Jobs and work** — per-job drawers with pipeline stage, budget, worker sessions, transcripts and terminal output.
- **Review** — review packets workers submit for the owner's sign-off (intent, changes, validation samples, risks, media).
- **Schedules** — recurring and scheduled work the owner has set up.
- **Knowledge and docs** — the knowledge base (a graph view, proposals and fact-check state) and the docs editor.
- **Feed and projects** — the cross-session activity stream and the per-project workspace with its composer.
- **Burrow** — a playful view of the worker fleet: each open worker is a bunny at the room or yard station for what it is doing (`src/components/BurrowView.tsx`).
- **Settings / You** — notifications, pipelines, review gates, personalization, usage.

Top-bar tab order is Persona, Schedules, Board, Review, Projects, Knowledge, Docs, Feed, Burrow (`VIEWS` in `src/components/Console.tsx`), with the You button (avatar and gear: profile, usage and every setting) at the bar's far end; `/` lands on Persona for its owner, otherwise on the Board's Live workers drawer (the session list, transcripts and new-chat composer, collapsed under the Board's columns by default; `/work` links open it). Live data arrives over a WebSocket; the console is served by the collector (Vite in dev) and reached over a tunnel from other devices.

## Capabilities and Constraints

- React 18 + Vite single-page app in `packages/web`; styling is inline style objects reading tokens from `src/components/theme.ts`. No CSS framework.
- Must work on a phone browser as well as desktop: the owner acts from mobile, so every decision path (answer an ask, approve a card, review a packet) has to be reachable and tappable on a small screen.
- Many concurrent sessions and jobs: views must stay scannable at high item counts.
- Owner actions are refused server-side without the owner's token; the UI must not imply a non-owner can approve.
- Terminology to keep: Persona, job, worker, session, launch, ask, checkpoint, approval card, review packet, Board, pipeline stage, knowledge doc.

## Brand Commitments

- Name: **Standup**.
- Feel the owner asked for: an operate app, dense but calm.

## Evidence on Hand

- Real product copy and flows live in the code (`packages/web/src/components`), the README and `docs/design/`.
- No testimonials, customers, metrics or marketing claims exist; don't invent them.

## Product Principles

1. **Only ping when a human is needed.** Waiting-on-you is rare and unmistakable; everything else is quiet.
2. **One tap to decide.** Any ask, approval or review the owner must handle is answerable where it appears, including on a phone.
3. **Agree with the Board.** Every view that counts work waiting on the owner uses the same rule, so numbers never disagree across tabs.
4. **Show, don't summarise away.** The owner can always drop from a summary to the real session output, transcript or diff.
5. **Calm density.** Show a lot at once without urgency theatre; status color carries meaning, not decoration.

## Accessibility & Inclusion

Small-screen touch use is a primary scenario, so tap targets, legible type and reachable controls on narrow viewports are product requirements, not polish. Motion respects `prefers-reduced-motion` (the console's pulse animation already does).
