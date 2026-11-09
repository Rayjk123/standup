---
title: Neighbouring systems
tags: [context, integrations]
---

- **rider-app** polls `GET /stations/availability` every 30 seconds per open
  map. Keep that response small and cacheable; adding a field to it costs
  more than it looks.
- **rebalancer** is a separate job that sends vans to move bikes from full
  stations to empty ones. It reads the `dock-events` stream, not the API, so
  a change to a dock event's shape is a breaking change for it even when no
  endpoint changes.
- Payments go through an outside card processor behind `fare-service`.
  fleet-api only stores a fare reference, never card details; don't add
  fields that would change that.
