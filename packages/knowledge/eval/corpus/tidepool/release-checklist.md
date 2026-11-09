---
title: Tidepool release checklist
source_kind: runbook
origin_class: owner
generated_at: "2026-07-25T16:50:00Z"
tags: [tidepool, release, deploy, staging]
---
# Tidepool release checklist

The core crate, the Python package and the API image share one version number and are released together.

## Versioning

Semver. Any change that moves a golden prediction by more than 1 mm is at least a minor release and is listed in the
changelog under **Prediction changes**, with the stations affected and by how much.

## Cut the release

1. `main` is green, including the `golden` job.
2. `just bump 0.14.0` updates `Cargo.toml`, `bindings/python/pyproject.toml` and `services/api/pyproject.toml`.
3. Move the changelog's Unreleased section under the new version and date it.
4. Push a signed tag: `git tag -s v0.14.0 -m v0.14.0 && git push origin v0.14.0`. The tag workflows publish the crate to
   crates.io, the wheels to PyPI through trusted publishing, and the image `ghcr.io/tidepool-tides/api:0.14.0`.

## Environments

| Environment | Where | Data |
|---|---|---|
| local | `docker compose up` in the repository | The twelve public reference stations |
| staging | `staging.tidepool.example` | Public stations plus an anonymized partner set, refreshed nightly |
| demo | `demo.tidepool.example` | Public stations only |
| production | `api.tidepool.example` | The hosted instance: every partner station plus the public ones |

Ports that run their own instance upgrade on their own schedule; nobody on the project has a shell on them.

## Deploy to staging and verify

1. `just deploy staging 0.14.0` runs the Ansible playbook against the staging host.
2. `just smoke staging` checks `/healthz`, fetches a week of predictions for every reference station and compares them
   with the golden files to 1 mm.
3. The next morning, check that the 02:30 UTC refit ran on staging and promoted nothing unexpected.

## Promote to the demo, then production

After 24 hours on staging with nothing new in the logs: `just deploy demo 0.14.0`, then `just smoke demo`. If the demo is
clean the next day, `just deploy production 0.14.0` and `just smoke production`. Post the release notes in the
Discussions "Releases" category so self-hosting ports see them.

## Access

Deploying needs membership of the `release` team on the forge and the deploy key from the project's password vault.
Ask a maintainer in the `#release` channel; keys are never shared over chat.

## Rolling back

`just deploy <env> <previous version>`. Database migrations are additive only, so an older API runs against a newer
schema. A constituent set that the newer version's refit promoted stays promoted; demote it with
`tp-admin set rollback <station>` if its predictions are the problem.
