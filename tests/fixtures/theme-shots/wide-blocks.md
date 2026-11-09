<!--
  Fixture: wide-blocks — engine (two-column presets: ieee-conference,
  newsletter, or any preset with layout.columns 2).
  Stresses: blocks wider than one column. A section whose heading and short
  lead-in come right before a table with long unbreakable cells (the table
  spans the page, and the columns before a spanning block are balanced —
  the heading must not end up alone at the foot of the first column); a
  wide matrix and a big fraction (scaled to fit, else spanning); a sum with
  no relation and a chain of relations that wrap before the operator with
  the continuation lines indented; a short formula that stays centred.
  Suggested title: "Wide blocks in two columns". No patch.
-->

# Cache sizes per tier

The limits below apply per node:

| Setting | Environment variable | Default | Unit |
|---|---|---|---|
| `invalidation.maxQueue` | `FERRULE_INVALIDATION_MAX_QUEUE` | 10000 | entries |
| `invalidation.flushIntervalMs` | `FERRULE_INVALIDATION_FLUSH_INTERVAL_MS` | 250 | ms |
| `replication.standbyNames` | `FERRULE_REPLICATION_STANDBY_NAMES` | `ANY 1 (west_a, west_b)` | list |

Each node keeps its own queue. A queue that is full drops the oldest invalidation and counts it in `ferrule_invalidations_dropped_total`, so an operator can see the loss before a reader sees a stale value. The defaults suit a ring of three to five nodes; larger rings should raise the queue first and the flush interval second.

# Mean waiting time

With arrival rate $\lambda$ and service rate $\mu$, the mean time a message waits is

$$
W = \frac{\lambda}{\mu(\mu - \lambda)} ,
$$

so halving the slack $\mu - \lambda$ more than doubles the wait. Summed over the $n$ shards of a ring,

$$
\mathbb{E}[T] = \sum_{i=1}^{n} \frac{n}{n - i + 1} = n \sum_{j=1}^{n} \frac{1}{j} = n H_n \le n (1 + \ln n) = n + n \ln n \approx n \ln n .
$$

The cost of one full rebuild adds up term by term:

$$
c_1 r_1 + c_2 r_2 + c_3 r_3 + c_4 r_4 + c_5 r_5 + c_6 r_6 + c_7 r_7 + c_8 r_8 + c_9 r_9 + c_{10} r_{10} + c_{11} r_{11}
$$

The routing weights of a ring with twelve shards form one row each:

$$
R = \begin{pmatrix} w_{1,1} & w_{1,2} & w_{1,3} & w_{1,4} & w_{1,5} & w_{1,6} & w_{1,7} & w_{1,8} & w_{1,9} & w_{1,10} & w_{1,11} & w_{1,12} \\ w_{2,1} & w_{2,2} & w_{2,3} & w_{2,4} & w_{2,5} & w_{2,6} & w_{2,7} & w_{2,8} & w_{2,9} & w_{2,10} & w_{2,11} & w_{2,12} \end{pmatrix}
$$

and the share of reads that hit a stale entry is

$$
s = \frac{\Pr[\text{stale} \mid \text{partition}] \, \Pr[\text{partition}]}{\Pr[\text{stale} \mid \text{partition}] \, \Pr[\text{partition}] + \Pr[\text{stale} \mid \text{no partition}]} .
$$

A short formula stays centred:

$$
E = mc^2
$$
