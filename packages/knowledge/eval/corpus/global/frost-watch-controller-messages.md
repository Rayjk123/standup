---
title: Frost Watch controller messages (2026 season)
source_kind: spec
origin_class: owner
generated_at: "2026-09-10T17:20:00Z"
tags: [frost-watch, block-controller, messages, mqtt]
---
# Frost Watch controller messages (2026 season)

The MQTT topics and payloads between block controllers and the desk server. Firmware is only flashed between seasons,
so during a season a payload may gain fields but never lose or rename one.

## Topics

| Topic | Direction | Retained |
|---|---|---|
| `fw/<blockId>/hello` | controller to server, on every connect | no |
| `fw/<blockId>/readings` | controller to server | no |
| `fw/<blockId>/events` | controller to server | no |
| `fw/<blockId>/settings` | server to controller | yes |

Every payload is JSON with a `controllerId`. Timestamps are UTC ISO 8601 strings. Temperatures are in °C with one
decimal; the tower probe's entries carry `"height": 10`.

## Machine state events

`{ "at": "…", "state": "…", "reason": "…" }`, where `state` is one of:

| State | Meaning |
|---|---|
| OFF | not running |
| CRANKING | relay closed, waiting for engine speed |
| RUNNING | engine speed seen |
| COOLDOWN | stopping after the stop rule held |
| OVERRIDE_ON / OVERRIDE_OFF | the manual switch in the box is set; the rules are not in charge |
| FAULT | did not crank twice, or a relay fault |

## Hello

`{ "firmware": "0.8.3", "settingsVersion": 41, "unsent": 1280 }`. The server sends nothing in reply; the retained settings arrive on
subscribe.
