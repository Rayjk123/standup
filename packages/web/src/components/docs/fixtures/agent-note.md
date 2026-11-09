# In-process cache vs shared Redis for session lookups

Status: draft, written by an agent from the load-test notes.
Owner team: platform_core

## Summary

The in-process cache keeps hot sessions next to the handler; shared Redis is the long-standing SESSION_STORE-backed lookup.
The options we compared:
- In-process LRU cache
- Shared Redis cluster
- Database with a read replica

## Latency

|Option|p50|p99|Notes|
|---|---|---|---|
|In-process LRU|0.2 ms|1.1 ms|no network|
|Shared Redis|3 ms|11 ms|one hop|
|Read replica|4 ms|19 ms|SESSION_STORE index lookup first|

The in-process cache wins on tail latency by an order of magnitude.

## Invalidation model

Each cache entry is keyed by `tenant`, `user` and `session`; each key maps onto a session_store row.
Invalidations come from:
1. the logout handler
2. the change feed
3. a per_tenant expiry table

> Note: an entry whose row the change feed has dropped is treated as expired.

## Costs

|Item|Monthly|
|:--|--:|
|Redis cluster|$1,200|
|Replica reads|$300|

## Open questions

* Do we need cross_region invalidation on day one?
* Who owns the SESSION_STORE expiry table?

```ts
const session = await cache.get({ tenant, user, session: id });
```

## Recommendation

Adopt the in-process cache for the read path and keep Redis for the write path until the expiry table has an owner.
