<!--
  Fixture: lecture-notes — template "Lecture notes" (Academic).
  Stresses: definition lists for definitions; theorems / examples / remarks
  as alerts (IMPORTANT = theorem, NOTE = remark, TIP = intuition) and as bold
  run-in labels; worked examples with inline + display math (cases, sums,
  aligned derivations); short python snippets; exercises as an ordered list
  with nested sub-parts; a small table; a Mermaid flowchart; ==mark==,
  sub/superscript (H~2~O-style) and abbreviations.
  Suggested title: "Probability for Computer Scientists — Lecture 7: Expectation
  and Linearity". Patch: lecture-notes-patch.json.
-->

*[PMF]: probability mass function
*[i.i.d.]: independent and identically distributed

# Expectation

Last week we described a random variable completely by its PMF. A PMF is often more than we need: to decide whether an algorithm is fast *on average*, or how much a game pays *in the long run*, a single number suffices. That number is the expectation.

Expectation
: For a discrete random variable $X$ with values in a countable set $\Omega_X$, the **expectation** (or mean) is
  $$\mathbb{E}[X] = \sum_{x \in \Omega_X} x \cdot \Pr[X = x],$$
  provided the sum converges absolutely. Otherwise we say $\mathbb{E}[X]$ does not exist.

Indicator variable
: For an event $A$, the indicator $\mathbf{1}_A$ is $1$ if $A$ occurs and $0$ otherwise. Its expectation is $\mathbb{E}[\mathbf{1}_A] = \Pr[A]$.

> [!TIP]
> Think of $\mathbb{E}[X]$ as the centre of mass of the PMF: put a weight of $\Pr[X = x]$ at position $x$ on a ruler; the ruler balances at $\mathbb{E}[X]$.

**Example 7.1 (fair die).** Let $X$ be the result of rolling a fair six-sided die. Then

$$
\mathbb{E}[X] = \sum_{x=1}^{6} x \cdot \frac{1}{6} = \frac{1 + 2 + \dots + 6}{6} = \frac{21}{6} = 3.5 .
$$

Note that $3.5$ is not a value $X$ can take. The expectation is a property of the distribution, not a typical outcome.

**Example 7.2 (geometric distribution).** We flip a coin with heads probability $p$ until the first head. Let $X$ be the number of flips. Then $\Pr[X = k] = (1 - p)^{k-1} p$ for $k \ge 1$ and

$$
\begin{aligned}
\mathbb{E}[X] &= \sum_{k=1}^{\infty} k (1 - p)^{k-1} p
= p \sum_{k=1}^{\infty} k q^{k-1} \qquad (q = 1 - p) \\
&= p \cdot \frac{1}{(1 - q)^2} = \frac{p}{p^2} = \frac{1}{p}.
\end{aligned}
$$

So a fair coin needs two flips on average, and a die needs six rolls on average to show a six.

> [!NOTE]
> **Remark.** The step $\sum_k k q^{k-1} = 1/(1-q)^2$ is the derivative of the geometric series $\sum_k q^k = 1/(1-q)$. You may use it without proof in exercises.

# Linearity of expectation

> [!IMPORTANT]
> **Theorem 7.3 (linearity).** For any random variables $X_1, \dots, X_n$ on the same probability space and constants $a_1, \dots, a_n$,
> $$\mathbb{E}\Big[\sum_{i=1}^{n} a_i X_i\Big] = \sum_{i=1}^{n} a_i \, \mathbb{E}[X_i].$$
> The variables do **not** need to be independent.

*Proof (for two variables).* Write the expectation as a sum over outcomes $\omega$ of the sample space:

$$
\mathbb{E}[aX + bY] = \sum_{\omega} \big(aX(\omega) + bY(\omega)\big) \Pr[\omega] = a \sum_{\omega} X(\omega) \Pr[\omega] + b \sum_{\omega} Y(\omega) \Pr[\omega] = a\,\mathbb{E}[X] + b\,\mathbb{E}[Y]. \qquad \blacksquare
$$

The power of the theorem is that we can compute the mean of a complicated variable by splitting it into simple pieces — usually indicators — ==without ever computing its distribution==.

**Example 7.4 (fixed points of a random permutation).** $n$ students drop their homework into a pile, and the pile is handed back in random order. How many students get their own homework back, on average?

Let $X_i = \mathbf{1}[\text{student } i \text{ gets their own}]$, so the count is $X = \sum_i X_i$. Each student is equally likely to receive any of the $n$ papers, so $\mathbb{E}[X_i] = 1/n$, and

$$
\mathbb{E}[X] = \sum_{i=1}^{n} \frac{1}{n} = 1 .
$$

The answer does not depend on $n$. The $X_i$ are dependent (if $n - 1$ students have their own, so does the last), but linearity does not care.

We can check this by simulation:

```python
import random

def fixed_points(n: int) -> int:
    perm = list(range(n))
    random.shuffle(perm)
    return sum(1 for i, p in enumerate(perm) if i == p)

trials = 100_000
for n in (3, 10, 1000):
    mean = sum(fixed_points(n) for _ in range(trials)) / trials
    print(f"n = {n:>4}: average fixed points = {mean:.3f}")
```

**Example 7.5 (coupon collector).** A cereal brand hides one of $n$ different stickers in each box, uniformly at random. How many boxes must we buy to collect all $n$?

Split the process into phases: phase $i$ starts once we hold $i - 1$ distinct stickers and ends when we get a new one. In phase $i$, each box is new with probability $p_i = (n - i + 1)/n$, so the phase length $T_i$ is geometric and $\mathbb{E}[T_i] = n / (n - i + 1)$ by Example 7.2. By linearity,

$$
\mathbb{E}[T] = \sum_{i=1}^{n} \frac{n}{n - i + 1} = n \sum_{j=1}^{n} \frac{1}{j} = n H_n \approx n \ln n .
$$

For $n = 50$ stickers that is about $225$ boxes.

| $n$ | $n H_n$ (exact) | $n \ln n$ | Ratio |
|---:|---:|---:|---:|
| 10 | 29.3 | 23.0 | 1.27 |
| 50 | 225.0 | 195.6 | 1.15 |
| 100 | 518.7 | 460.5 | 1.13 |
| 1000 | 7485.5 | 6907.8 | 1.08 |

# Expectation in algorithm analysis

Linearity is the main tool for average-case analysis. The recipe is always the same:

```mermaid
flowchart LR
  A[Quantity of interest] --> B[Write as a sum of indicators]
  B --> C[Compute each probability]
  C --> D[Add them up]
```

**Example 7.6 (comparisons in randomised quicksort).** Let $z_1 < z_2 < \dots < z_n$ be the sorted input. Elements $z_i$ and $z_j$ ($i < j$) are compared at most once, and exactly when the first pivot chosen from $\{z_i, \dots, z_j\}$ is $z_i$ or $z_j$. Each of the $j - i + 1$ elements is equally likely to be that first pivot, so

$$
\Pr[z_i \text{ and } z_j \text{ compared}] = \frac{2}{j - i + 1}.
$$

Summing over all pairs,

$$
\mathbb{E}[C] = \sum_{i=1}^{n-1} \sum_{j=i+1}^{n} \frac{2}{j - i + 1} \le 2n \sum_{k=2}^{n} \frac{1}{k} \le 2 n \ln n = O(n \log n).
$$

> [!WARNING]
> Linearity gives the **mean** only. Quicksort's running time is $O(n \log n)$ in expectation, but a single run can still take $\Theta(n^2)$; bounding how *likely* that is needs the concentration inequalities of Lecture 9.

## Conditional expectation (preview)

For an event $B$ with $\Pr[B] > 0$, define $\mathbb{E}[X \mid B] = \sum_x x \Pr[X = x \mid B]$. The **law of total expectation** splits a mean over a partition $B_1, \dots, B_m$:

$$
\mathbb{E}[X] = \sum_{j=1}^{m} \mathbb{E}[X \mid B_j] \Pr[B_j].
$$

We will use it next week to analyse randomised algorithms with branching, such as skip lists.

# Summary

- $\mathbb{E}[X] = \sum_x x \Pr[X = x]$; for indicators, $\mathbb{E}[\mathbf{1}_A] = \Pr[A]$.
- Linearity holds for **any** random variables, dependent or not.
- To compute a mean, decompose into indicators, compute probabilities, add.
- Typical results: geometric $1/p$; fixed points $1$; coupon collector $n H_n$; quicksort $O(n \log n)$ comparisons.
- Notation used in the tutorials: H~n~ is the *n*-th harmonic number, and 2^10^ = 1024 coupons is the largest case we simulate.

# Exercises

Exercises marked ★ are harder. Solutions to the unmarked ones will be discussed in the tutorial on Thursday.

1. A fair coin is flipped $n$ times. Find the expected number of runs (maximal blocks of equal results). *Hint:* a new run starts at flip $i > 1$ exactly when flip $i$ differs from flip $i - 1$.
2. In a class of $m$ students with i.i.d. uniformly random birthdays (ignore 29 February):
   1. find the expected number of pairs that share a birthday;
   2. find the smallest $m$ for which this expectation exceeds $1$;
   3. explain why your answer to (b) differs from the classical "23 people" answer.
3. Let $X$ be the number of empty bins after throwing $m$ balls into $n$ bins uniformly at random. Show that $\mathbb{E}[X] = n (1 - 1/n)^m$ and that this is about $n e^{-m/n}$.
4. Write a Python function that estimates $\mathbb{E}[T]$ for the coupon collector by simulation and compare it with $n H_n$ for $n \in \{10, 100\}$.
5. ★ A random graph on $n$ vertices includes each of the $\binom{n}{2}$ possible edges independently with probability $p$. Find the expected number of triangles. For which $p$ (as a function of $n$) does it stay bounded as $n \to \infty$?
6. ★ Show that linearity can fail for infinitely many variables: find $X_1, X_2, \dots$ with $\sum_i \mathbb{E}[X_i]$ convergent but $\mathbb{E}[\sum_i X_i] \neq \sum_i \mathbb{E}[X_i]$. Which condition of the dominated convergence theorem is violated?
