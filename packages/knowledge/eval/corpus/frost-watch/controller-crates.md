---
title: Rust crates in the block controller
source_kind: runbook
origin_class: owner
generated_at: "2026-07-29T16:35:00Z"
tags: [frost-watch, block-controller, rust, dependencies]
---
# Rust crates in the block controller

The controller daemon (`fw-controller`) is Rust, cross-compiled for 32-bit ARM. The crates it leans on:

| Crate | Used for |
|---|---|
| `rumqttc` | the MQTT connection to the night desk's broker |
| `rusqlite` | the offline buffer |
| `gpio-cdev` | closing and opening the wind machine relay through the GPIO character device |
| `tokio-serial` | the LoRa concentrator on the serial port |
| `sunrise` | sunrise time from the block's latitude and longitude, for the stop rule |
| `serde_json` | message payloads |

## Gotchas

- Build `rusqlite` with the `bundled` feature. Without it the cross build links against the build machine's SQLite
  and the binary fails to start on the board.
- `gpio-cdev` opens `/dev/gpiochip0`. The service user must be in the `gpio` group or the open fails with
  permission denied; the daemon then refuses to start rather than run without a relay.
- The cellular carrier drops idle connections after about four minutes. Keep the `rumqttc` keep-alive at 60 seconds,
  or a quiet daytime controller reconnects every few minutes.
