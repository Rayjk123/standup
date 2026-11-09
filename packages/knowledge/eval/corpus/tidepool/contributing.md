---
title: Contributing to Tidepool
source_kind: runbook
origin_class: owner
generated_at: "2026-07-19T13:40:00Z"
tags: [tidepool, contributing, golden-files, dco, codeowners]
---
# Contributing to Tidepool

Tidepool is maintained by volunteers and a few port staff. Most of this page is about one thing: a change to the maths
must show its effect on real predictions before anyone reads the code.

## Getting a working tree

- The Rust toolchain is pinned in `rust-toolchain.toml`; `rustup` picks it up on the first build.
- `just bootstrap` creates `.venv`, installs the API and job dependencies and builds the bindings into it. The wheel
  builds doc covers the bindings in detail.
- `just check` runs what the forge runs: cargo fmt, clippy and tests for the crates; ruff, mypy and pytest for the
  Python parts.

## Sign-off (DCO)

Tidepool uses the Developer Certificate of Origin instead of a contributor licence agreement. Every commit carries a
`Signed-off-by:` line with your real name, added with `git commit -s`. The `dco` check on the forge lists any commit
without one. Port staff contributing on work time should check with their employer first; the sign-off says you are
allowed to submit the code under Apache-2.0.

## Golden files

`tests/golden/` holds a week of predicted heights and the daily highs and lows for each of the twelve public reference
stations, as CSV. The `golden` job compares every build against them to 1 mm and 1 minute.

- Moving a golden value on purpose: run `just regen-golden`, commit the changed CSVs in the same pull request as the
  code, and add a `changes/<pr-number>.prediction.md` fragment that names the stations and the largest shift.
- Never regenerate the golden files to make an unrelated change pass. A golden diff nobody can explain is a bug.
- The fragments are collected into the changelog's **Prediction changes** section at release time.

## Who reviews the maths

`CODEOWNERS` assigns `crates/tidepool-core/src/harmonics/`, `crates/tidepool-core/src/datum/` and
`tests/golden/` to the `@tidepool-tides/maths` team, and the forge does not merge a change to those paths until that
team has approved it. They look for three things:

- a published source for any formula or constant: Schureman's manual, Foreman's tidal analysis notes or the IHO
  constituent list, with a page or table number in a comment;
- a test against a station whose published constituents are known, not only a golden diff;
- units in names (`speed_deg_per_h`, `phase_deg`, `height_m`), because the code mixes degrees, radians, hours and
  seconds.

Changes everywhere else (the API, the importer, the CLIs, the docs) need any maintainer.

## Adding a constituent

Add it to `harmonics/constituents.rs` with its Doodson numbers; the speed is derived from them, never typed in. Give it
nodal factors from the same source, add it to the list the Rayleigh criterion orders, and run the refit dry-run on the
reference stations to check that no existing constituent's amplitude moves by more than 2 mm.

## Issues and security

- `good first issue` marks issues a newcomer can finish in an evening.
- Report a security problem through a private security advisory on the forge, never in a public issue.
- A wrong prediction is a bug: include the station id, the time range and the value the port's own tables give.
