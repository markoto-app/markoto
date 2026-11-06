<!--
  Fixture: conference-paper — template "Conference paper" (Academic, IEEE-like,
  two columns).
  Stresses: leading "Abstract" section (moved into the title block) followed by
  an "Index Terms" line; short numbered-style sections (h1/h2 only); narrow
  tables that must fit one column and one wide table; inline + display math
  incl. an aligned block and a matrix; a small figure; a short code listing
  with a long line; an algorithm as a numbered list; footnotes; numeric
  references [1]…[n] as an ordered list.
  Suggested title: "Tidewater: Energy-Proportional Batching for Edge
  Inference Servers". Patch: conference-paper-patch.json.
-->

## Abstract

Inference servers at the network edge run on power budgets of a few tens of watts, yet they are usually configured with the same static batching policies as datacenter accelerators. We present **Tidewater**, a batching controller that chooses batch size and accelerator frequency jointly so that energy per request stays close to its minimum while a latency objective is met. Tidewater models the accelerator's energy as a convex function of frequency and batch size, estimates arrival rates online, and solves a small integer program every 50 ms. On three edge devices and four vision and speech models, Tidewater reduces energy per request by 23–41 % compared with fixed-batch serving and by 12–19 % compared with latency-only adaptive batching, while violating a 100 ms p99 objective in fewer than 0.5 % of windows.

**Index Terms** — edge computing, inference serving, dynamic voltage and frequency scaling, batching, energy efficiency

# Introduction

Edge inference moves models closer to the sensors that produce their inputs: cameras on factory floors, microphones in vehicles, and gateways in retail stores. The devices that host these models are small accelerators with tight thermal envelopes, and a growing share of them run on batteries or harvested power [1], [2].

Batching amortises the fixed cost of a forward pass over several requests and is the main lever for throughput in datacenter serving [3]. At the edge, however, load is low and bursty, and waiting to fill a batch costs latency that the application cannot spare. Existing adaptive batchers [4], [5] therefore optimise only for latency, leaving energy as an afterthought.

We make three contributions:

1. an empirical energy model for edge accelerators that captures the interaction between batch size and frequency (Section II);
2. Tidewater, a controller that minimises energy per request subject to a tail-latency objective (Section III);
3. an evaluation on three devices and four models, including a week-long trace from a deployed retail analytics system (Section IV).

# Energy model

We measured energy per batch $E(b, f)$ for batch size $b$ and accelerator frequency $f$ on each device with an inline power meter sampling at 10 kHz. Across all devices, the measurements fit

$$
E(b, f) = \underbrace{c_0 \, f^{-1}}_{\text{static}} + \underbrace{c_1 \, b \, f^{2}}_{\text{dynamic}} + c_2
$$

with $R^2 > 0.97$. The static term dominates at low frequency, where leakage accumulates over a longer runtime; the dynamic term dominates at high frequency. Energy *per request* is $e(b, f) = E(b, f) / b$, which for fixed $f$ decreases monotonically in $b$.

TABLE I. Fitted coefficients per device.

| Device | $c_0$ | $c_1$ | $c_2$ | $R^2$ |
|---|---:|---:|---:|---:|
| Jetsam X2 | 4.1 | 0.82 | 0.31 | 0.98 |
| Corvid NPU | 2.7 | 1.10 | 0.12 | 0.97 |
| Lumen M4 | 3.3 | 0.64 | 0.27 | 0.99 |

The latency of a batch is $L(b, f) = (a_0 + a_1 b) / f$. A request that arrives into an empty queue waits for the batch to fill and then for the batch to execute, so its latency is bounded by

$$
\begin{aligned}
T(b, f, \lambda) &\le \frac{b - 1}{\lambda} + L(b, f) \\
&= \frac{b - 1}{\lambda} + \frac{a_0 + a_1 b}{f}.
\end{aligned}
$$

# Controller design

Every control period of $\Delta = 50$ ms, Tidewater estimates the arrival rate $\hat\lambda$ with an exponentially weighted moving average and solves

$$
\min_{b \in \mathcal{B},\ f \in \mathcal{F}} \; e(b, f) \quad \text{s.t.} \quad T(b, f, \hat\lambda) \le \tau
$$

where $\mathcal{B} = \{1, 2, 4, 8, 16\}$ and $\mathcal{F}$ is the device's set of discrete frequency levels (between 6 and 14 levels). The search space has at most 70 points, so exhaustive enumeration takes under 20 µs on the device's host CPU.

## Algorithm

At each control period:

1. update $\hat\lambda \leftarrow \gamma \hat\lambda + (1 - \gamma) \, n / \Delta$, where $n$ is the number of arrivals in the last period;
2. for each $(b, f)$, compute $T$ and $e$; discard pairs with $T > \tau$;
3. if no pair is feasible, choose the pair with the smallest $T$ (degraded mode);
4. otherwise choose the pair with the smallest $e$, breaking ties towards the larger $f$;
5. apply $f$ through the device's frequency interface and set the queue's batch target to $b$.

The frequency interface is a sysfs file on all three devices:

```c
static int set_freq(int dev, unsigned khz) {
    char path[96]; snprintf(path, sizeof path, "/sys/class/devfreq/%d.npu/userspace/set_freq", dev);
    FILE *f = fopen(path, "w"); if (!f) return -errno;
    int rc = fprintf(f, "%u\n", khz) < 0 ? -EIO : 0; fclose(f); return rc;
}
```

## Handling bursts

Arrival estimates lag behind sudden bursts. Tidewater therefore caps the batch wait at $\tau / 2$: if the oldest request in the queue has waited that long, the batch is dispatched regardless of its size.[^cap] The cap trades some energy for robustness and was triggered in 3.1 % of control periods on the retail trace.

# Evaluation

We compare Tidewater with three baselines: *Fixed-8* (batch size 8, maximum frequency), *Shoal* (latency-only adaptive batching [4]) and *Race-to-idle* (batch size 1, maximum frequency, then deep sleep).

![Energy per request on the retail trace over one day, normalised to Fixed-8.](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAeAAAAEOAgMAAAAs9Cz0AAAADFBMVEX////AUE1EREQ9b7bxqYjxAAAEAklEQVR42u3XPW4cMQwFYBmLrX0k5wguMvfJEdKkX8CdgSBV+smNtkm3gTKzmpnVv0SJpByErOzqw3ukBrZSMjIyMjIyMjIyjHMRWGCBBRZYYIEFFljgztF6Zob1PnywdocH1gWVBC6JJHAViQ7Xo6gwBMWDgSgWDFdR4Ca2H25T++FWthNuZ7vgHrYH7nPb4T62Ge5lW+F+tw1GcJtgBLYJRnEbYBwXDiO5YBjLhcJoLhDGc2EwoguCMV0I/IzpQmBUFwDr25j/jzVu4Gr4GdmthrHdWhh5wdUwetG1ML5bB+MXXQcTFF0HU7g18DNB0VUwSeAKmCZwBUwTuAwTBS7DRIGLMFXgIkwVuASTBS7BZIELMF7g6RMIRgo8LQOCUQJPZkBwf+Apwebh7sBJNQ+f+gLn1DzcFTiv5mF9pWNzcHvTZTULtzZdxWbgU1vTlWwGbgpczWbghsAANg03nBaETcPgpmFsEoaeFpRNwsDAcDcFgwI3sCkYdFotbAqGNN3mJuD6phvZBFzfdLMbh6ubbnfjcGXTHWwcrmy6y43CdU33uVG4quk+NgpXNd3rxuCaprvdGPxyZXBjcLlpBDcCnzSHG4GLK0ZxI3DpMeG4IVx6TEhuCBeaxnJDOP+Y0NwQzjaN5wZw9jEhugGcWzGmG8CZx4Tq+nDmMZ1RXR/ONI3r+nD6MU2fFSWcbHpCDuzByceE7npwasVndNeDUyvGdz04sWLswwrgxIongsAuHF/xmcJ14fiKSVwPnpkW7MOarWgXjt4WkevAsdsiKtqFI7dFVbQLRz4fZK4NR1ZMVrQDhyumK9qBwxUTujYcrPhMV7QNhyumDGzBwYonysAW7K/4TBrYhmfGom1YM16WDfu3RRz4AXu3RR34AXu3RR3Ygme+p+TAmvEp2bB7W/TuATu3RX5ZFuzcFkPgBzzzBj5gzRx4h+3bYgm8w/ZtsQQ+4Ctz4B22bosn8A4//t5iCnzA++9PTIE3+HTjDrzBj6OeXlnh44PJ1vQOz9xNb7Bmb9rAxweTL7CBj9ti2/AOX9kDG3i7rSfGwAbePpicgTeY+6Q3ePtgsjZ9h7ejZm3awFcT+JUbNkfNG/gOm6PmDWxg/tO6w+aomZte4ftRM5+Wga8DAq/w/ai5A6/wetTcp2XgEU0v8HrU7Ke1w/yBF3g9av7AKzwPOK0VfhnStIEHNL3AtyFNq8ty1COaVpflqEc0vcJDmlaXl3lI0+qifw1peoHHBFZvtzGB1dufIae1wL/HNK1+DGpafR/UtPo5qGn1bVDTalTTT9OgwKdRK1ZfR8EXgQUWWGCBBf6Y8JfjV46fBGaG37nmw8BqVNX/KSwjIyMjIyMjIyMj8w/NXw+3DbeZQfBOAAAAAElFTkSuQmCC){width=100%}

TABLE II. Energy per request (mJ) and p99 latency (ms) at $\tau = 100$ ms, averaged over models.

| Device | Method | Energy | p99 | Violations |
|---|---|---:|---:|---:|
| Jetsam X2 | Fixed-8 | 41.2 | 138 | 11.4 % |
| | Shoal | 31.8 | 92 | 0.3 % |
| | Race-to-idle | 36.5 | 41 | 0.0 % |
| | Tidewater | **27.4** | 96 | 0.4 % |
| Corvid NPU | Fixed-8 | 18.9 | 121 | 7.2 % |
| | Shoal | 14.6 | 88 | 0.2 % |
| | Tidewater | **12.1** | 95 | 0.5 % |

Across devices, Tidewater saves the most energy at moderate load (between 20 and 60 requests per second), where the choice of frequency matters most. At very low load, all adaptive methods converge to small batches; at saturation, all converge to the largest batch at the highest frequency.

TABLE III. Per-model results on Lumen M4. Columns are the four models; each cell gives energy per request (mJ) / p99 latency (ms).

| Method | ResNet-50 | MobileViT-S | Whisper-tiny | YOLO-n |
|---|---|---|---|---|
| Fixed-8 | 22.4 / 131 | 9.8 / 117 | 64.0 / 149 | 12.1 / 125 |
| Shoal | 17.0 / 90 | 7.6 / 85 | 51.2 / 94 | 9.4 / 89 |
| Tidewater | **14.3** / 97 | **6.4** / 93 | **43.9** / 98 | **7.9** / 96 |

## Overhead

The controller adds 0.6 % CPU utilisation on the host and no measurable energy beyond the noise floor of our meter. Frequency changes take 80–200 µs and occur in 9 % of control periods; we found no benefit in adding hysteresis.

# Related work

Shoal [4] and its successors adapt batch size to meet latency objectives in the datacenter. DVFS for inference has been studied for mobile GPUs [6], [7], but without batching. Closest to our work, Ember [8] co-optimises batch size and frequency offline for a known arrival rate; Tidewater does so online under changing load.

# Conclusion

Joint control of batch size and frequency is a simple, cheap way to cut energy at the edge. Tidewater's model has four parameters per device and fits in a few hundred lines of code; we release it with our traces.[^code]

# References

1. M. Rinaldi and K. Ostrowski, "Battery-powered vision at the edge: A measurement study," in *Proc. ACM MobiSys*, 2024, pp. 211–224.
2. L. Haddad *et al.*, "Energy harvesting for always-on inference," *IEEE Trans. Sustain. Comput.*, vol. 9, no. 3, pp. 401–415, 2025.
3. J. Brenner, A. Iqbal, and S. Varga, "Throughput-optimal batching for deep learning inference," in *Proc. USENIX NSDI*, 2023, pp. 77–92.
4. D. Crane *et al.*, "Shoal: Adaptive batching for low-latency prediction serving," in *Proc. EuroSys*, 2024.
5. P. Nakamura and R. Delgado, "SLO-aware request scheduling for multi-model inference," *Proc. VLDB Endow.*, vol. 17, no. 9, pp. 2210–2223, 2024.
6. Y. Tanaka and F. Moreau, "Frequency scaling for mobile GPU inference," in *Proc. IEEE ISLPED*, 2023.
7. A. Petrov, "Learning DVFS policies for on-device neural networks," *IEEE Embedded Syst. Lett.*, vol. 16, no. 2, pp. 98–101, 2024.
8. S. Okafor and H. Lindqvist, "Ember: Offline co-optimisation of batching and DVFS," in *Proc. ACM SenSys*, 2025, pp. 340–353.

[^cap]: With the cap, the latency bound becomes $T \le \tau/2 + L(b, f)$, which the controller accounts for when it checks feasibility.

[^code]: Source code and traces: `https://tidewater.example.org`.
