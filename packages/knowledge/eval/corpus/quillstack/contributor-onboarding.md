---
title: Getting started as a Quillstack contributor
source_kind: runbook
origin_class: owner
generated_at: "2026-07-30T15:20:00Z"
tags: [quillstack, contributing, onboarding, golden-sites, testing]
---
# Getting started as a Quillstack contributor

Welcome. This page gets you from a fresh clone to a merged first change. It is about the CLI repository; Quill Preview
has its own guide.

## Day one

- Install Go. The version is pinned by the `toolchain` line in `go.mod`, and `go` downloads it on first use.
- `make dev` builds `quill` into `./bin` and installs the linters the CI uses (`golangci-lint`, `staticcheck`) at the
  pinned versions.
- `./bin/quill serve --source testdata/sites/handbook` serves the sample handbook site; edit a page and watch it reload.

## How the tests are organised

| Kind | Where | Run with |
|---|---|---|
| Unit tests | next to the code, `*_test.go` | `go test ./...` |
| Golden sites | `testdata/sites/<name>/` with `expected/` output | `go test ./internal/build -run Golden` |
| Plugin protocol | `pkg/pluginapi/conformance/` | `make conformance` |
| Link checker against a recorded web | `internal/linkcheck/testdata/recordings/` | `go test ./internal/linkcheck` |

A golden-site test builds the site and compares every output file to `expected/`. If your change is meant to alter the
output, rerun with `-update` and commit the regenerated files in the same change, so reviewers see the HTML diff. Never
regenerate goldens for a change that is not supposed to alter output.

The link checker tests never touch the network; they replay recordings. Record a new one with
`go test ./internal/linkcheck -record` and check the file for tokens before committing it.

## Sending a change

- Find something labelled `good-first-issue`, or ask in the contributors' chat before starting something big.
- Sign the contributor licence agreement once; the bot comments with a link on your first pull request.
- One logical change per pull request; the description says what a writer would notice.
- Changes under `pkg/pluginapi` are the plugin API's surface and need approval from two maintainers, plus a passing
  conformance suite. Everything else needs one.
- Changelog entries go in `changes/<pr-number>.md`; the release tooling assembles them.

## Where to ask

The contributors' chat for quick questions, a discussion thread for designs. Maintainers rotate a weekly triage duty and
answer new issues within two working days.
