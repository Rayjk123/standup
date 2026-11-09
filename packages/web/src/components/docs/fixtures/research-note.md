# Rate limiting for the ingest API: token bucket or sliding window?

Status: decision doc, revision 2. Research only; nothing was deployed. Written 2026-10-01.

Revision 2 follows review feedback: the gateway is out of scope, so the **ingest service enforces limits itself**, keyed by tenant.

## TL;DR

- **Use a token bucket per tenant, held in Redis.** It allows short bursts, which the batch uploaders depend on (`ingest/src/batch.ts`).
- **A sliding window is fairer but costs more.** Each request needs a sorted-set write and a range count; at peak that is roughly 3× the Redis load.
- **There are two different limits:**
  - The **burst limit** caps how many requests land at once.
  - The **sustained limit** caps the average rate over a minute.
- **Return `429` with `Retry-After`** rather than queueing. Clients already retry with backoff.

Citation prefixes used below:
- `R:` = `https://redis.io/docs/`
- `RFC:` = `https://www.rfc-editor.org/rfc/`

## 1. What needs limiting

### The ingest API today

**Routes:**

| Kind | Routes |
|---|---|
| Read | GetBatch, ListBatches (`?tenant=`) |
| Write | CreateBatch, AppendRecords, CloseBatch |
| Admin | PurgeTenant |

There is no limit at all today. Any tenant can saturate the writers.

**Measurements:**

| Tenant | p50 req/s | p99 req/s | Burst size |
|---|---:|---:|---:|
| `alpha` | 12 | 140 | 600 |
| `beta` | 3 | 9 | 20 |

### Options compared

1. **Token bucket**
   - Refill at the sustained rate; capacity is the burst limit.
   - One `INCRBY` plus a TTL per request.
2. **Sliding window log**
   - Exact, but stores every request timestamp.
3. **Sliding window counter**
   - Approximates the log with two fixed windows.

> **UNCONFIRMED:** whether the Redis cluster's eviction policy could drop a bucket key under memory pressure. If it can, a tenant briefly gets a fresh bucket.

## 2. Sketch

```ts
export async function take(tenant: string, cost = 1): Promise<boolean> {
  const key = `bucket:${tenant}`;
  const left = await redis.decrby(key, cost);
  return left >= 0;
}
```

```sh
redis-cli --latency -h ingest-cache
```

The diagram below shows the request path:

![Request path through the limiter](images/limiter-path.png)

## 3. Open questions

- [x] Do batch uploaders retry on `429`? Yes, with jittered backoff.
- [ ] Should admin routes be exempt?
- [ ] What happens during a Redis failover?

See [RFC 6585 §4](https://www.rfc-editor.org/rfc/rfc6585#section-4) for `429 Too Many Requests`.
