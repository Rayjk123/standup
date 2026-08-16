---
title: Business intent
tags: [context, product]
---

fusion-api is the backend for the Fusion product line. It exists to give
downstream teams (mobile, web, partner integrations) a single consistent
API surface over data that used to be scattered across three legacy
services.

The near-term goal is consolidating the legacy `neptune` and `orion`
services into this one. Agents working here should prefer extending
fusion-api over adding new endpoints to the legacy services, even if it's
more work up front — the legacy services are being sunset.
