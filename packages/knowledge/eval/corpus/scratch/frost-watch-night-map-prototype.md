---
title: Frost Watch night map prototype
source_kind: runbook
scope: global
origin_class: agent
source_session_id: "sess-scratch-a93c"
generated_at: "2026-09-21T09:00:00Z"
tags: [frost-watch, night-map, prototype]
---
# Frost Watch night map prototype

A Vite app in `night-map/`, in the same repository as the desk server.

## Running it

- `pnpm install`, then `pnpm dev`: Vite on port 5173 together with the replay server (`replay/serve.ts`). Replay
  plays a recorded ndjson file (`replay/nights/2026-08-19.ndjson`) thirty times faster than real time, behind the
  same HTTP routes the server has: `/api/night`, `/api/blocks/:id/readings` and `/api/alerts/:id/ack`.
- `REPLAY=0 DESK_URL=<dev server url> pnpm dev` talks to a real dev server instead. Sign in to it in the same browser
  first.

## Acknowledging in the prototype

- Replay mode: an acknowledgement stays inside the replay server and is lost when it restarts. No phone hears of it.
- Live mode: an acknowledgement is real and ends that alert's escalation, so point live mode at a dev server only.
- `GET /api/me` returns the signed-in user's `role`. The "Acknowledge for someone else" button appears only for
  `lead`; the server rejects it from anyone else anyway.

## Code layout

- Hash routes, one file each under `src/routes/`: `#/blocks` (a grid of cards), `#/alerts` (a list of open alerts)
  and `#/season`.
- `src/api.ts` wraps every fetch, for example `fetchReadings(blockId, hours, stepMinutes)`.
- Charts are uPlot, one per card.

## Building and tests

- `pnpm build` writes `night-map/dist`; `mix night_map.copy` copies it into `priv/static/map`, served at `/map`.
  There is no separate hosting.
- `pnpm test` runs vitest against recorded responses in `replay/fixtures/`.
