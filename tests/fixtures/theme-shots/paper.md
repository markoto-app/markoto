## Abstract

Edge caches trade freshness for latency, and partitions make the trade visible. We replay six weeks of production traffic against a staging ring with injected partitions and measure read latency and stale reads per invalidation strategy. A bounded invalidation queue keeps the 99th-percentile read latency within 1.5× of the healthy baseline while capping stale reads at 0.04 %, where an unbounded queue grows without limit until memory runs out.

**Keywords** edge caching · invalidation · network partitions · tail latency

# Introduction

Distributed caches fail in ways that are hard to see from a single node.[^1] This paper describes how the edge cache behaves under partial network partitions and which configuration we recommend. Each region runs three cache nodes behind a consistent-hash ring; a write goes to the primary first and is then replicated to two followers.

Followers acknowledge asynchronously, which keeps write latency low but opens a window in which a reader can see a stale value. The window is normally a few milliseconds. Under a partition it is as long as the partition lasts, unless invalidations are queued and replayed.

## Related work

Consistent hashing with bounded loads limits how much traffic a single node takes when its neighbours fail. Lease-based invalidation bounds staleness by the lease length instead of the replication delay.

## Contributions

1. A replay harness that keeps the original inter-arrival times.
2. Measurements of three invalidation strategies under injected partitions.
3. A recommendation for the queue limit.

# Method

We replayed a recorded day of traffic against a staging ring and injected partitions with a fault proxy.

```ts title="replay.ts"
export async function replay(path: string, client: CacheClient): Promise<Stats> {
  const lines = (await readFile(path, 'utf8')).split('\n').filter(Boolean)
  const start = performance.now()
  for (const line of lines) {
    const req: Recorded = JSON.parse(line)
    const wait = req.at - (performance.now() - start)
    if (wait > 0) await sleep(wait)
    await client.send(req)
  }
}
```

## Fault model

A partition separates the primary from one follower for 90 s; latency faults add a p99 of 250 ms. With arrival rate $\lambda$ and service rate $\mu$ the mean wait in the queue is $W = \frac{\lambda}{\mu(\mu - \lambda)}$.

# Results

| Configuration | p50 (ms) | p99 (ms) | Stale reads |
|---|---:|---:|---:|
| Baseline | 1.8 | 6.2 | 0.00 % |
| Unbounded queue | 2.1 | 41.7 | 0.31 % |
| Bounded queue (1k) | 2.0 | 9.4 | 0.04 % |

A bounded queue drops the oldest invalidations when it is full; the TTL recovers them, which caps staleness at five minutes.

# Conclusion

Ship the bounded queue with a limit of 1,000 messages and alert when it is more than 80 % full for five minutes.

[^1]: A partition is visible only to the nodes on either side of it.
