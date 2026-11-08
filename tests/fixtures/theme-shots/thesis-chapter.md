<!--
  Fixture: thesis-chapter — template "Thesis" (Academic).
  Stresses: one chapter (h1) with numbered sections down to h3 (meant for
  headings.numbering = decimal); long justified paragraphs; display equations
  incl. multi-line aligned + inline math; figures with captions (image-only
  paragraph → <figure>, sized with {width=…}); tables with Pandoc captions (the engine numbers both within the chapter: blocks.captionNumbering = chapter);
  many footnotes (some long); a block quotation; a definition list; a
  references list with long entries and URLs; an abbreviation.
  Suggested title: "Chapter 3 — Learning sparse sensor placements for urban
  flood forecasting". Patch: thesis-chapter-patch.json.
-->

*[RMSE]: root-mean-square error
*[DEM]: digital elevation model

# Learning sparse sensor placements

Urban flood forecasting depends on knowing, minutes in advance, how much water is moving through a drainage network that nobody can observe in full. Cities instrument a handful of manholes and outfalls with level sensors, and every additional sensor costs not only its purchase price but years of maintenance in a corrosive, confined environment.[^cost] The question this chapter addresses is therefore not how to forecast well with unlimited data, but where a small, fixed budget of sensors should go so that a forecasting model trained on their readings is as accurate as possible across the whole network.

Chapter 2 introduced the hydraulic surrogate model that serves as the forecaster throughout this thesis. Here we treat that model as given and turn to the placement problem. Section 1.1 states the problem formally and shows that it is a monotone but not submodular set function maximisation. Section 1.2 develops a relaxation in which placements are learned jointly with the surrogate through a differentiable gating mechanism. Section 1.3 evaluates the method on two catchments of the fictional city of Valmont, and Section 1.4 discusses its limits.

## Problem statement

Let $\mathcal{G} = (\mathcal{V}, \mathcal{E})$ be the drainage network with $|\mathcal{V}| = n$ nodes. A placement is a subset $S \subseteq \mathcal{V}$ with $|S| \le k$, and a forecaster $f_\theta$ maps the observed level history $\mathbf{y}_S^{(t-\tau:t)}$ to predicted levels at every node $h$ steps ahead. We seek

$$
S^\star = \operatorname*{arg\,min}_{S \subseteq \mathcal{V},\ |S| \le k} \; \min_{\theta} \; \mathbb{E}_{(\mathbf{x}, \mathbf{y}) \sim \mathcal{D}} \left[ \sum_{v \in \mathcal{V}} \ell\!\left( f_\theta(\mathbf{y}_S)_v,\ y_v^{(t+h)} \right) \right]
$$

where $\mathcal{D}$ is the distribution of rainfall events and $\ell$ is the squared error. Two features make this problem hard. First, the inner minimisation requires training a forecaster for every candidate set, which for the Valmont north catchment ($n = 1{,}284$, $k = 12$) means more than $10^{28}$ candidates. Second, the outer objective is not submodular: a sensor at a junction can be nearly useless alone and highly informative once its upstream neighbour is observed, because together they constrain the flow through the pipe between them.

### Why greedy selection falls short

The classical response to the first difficulty is greedy forward selection, which enjoys a $(1 - 1/e)$ approximation guarantee for submodular objectives (Lindqvist et al., 2008). Without submodularity the guarantee disappears, and we observed the failure mode in practice: greedy selection repeatedly chose sensors on the main trunk sewer, each of which reduces error at its own location substantially, and missed the pairs of lateral sensors that together reveal where surcharge begins.

> The value of a measurement is not a property of the place where it is taken but of what it allows us to infer about the places where it is not.
>
> — Harriet Okonkwo, *Observing Hidden Networks* (2019), p. 112

## Differentiable placement

We relax the binary choice of sensors into a continuous gate. Each node $v$ carries a logit $\alpha_v$, and during training the observed input is masked by a sample from a relaxed Bernoulli (Concrete) distribution (Halvorsen et al., 2017):

$$
\begin{aligned}
g_v &= \sigma\!\left( \frac{\alpha_v + \log u_v - \log(1 - u_v)}{\lambda} \right), \qquad u_v \sim \mathcal{U}(0, 1), \\
\tilde{\mathbf{y}}_v &= g_v \cdot \mathbf{y}_v .
\end{aligned}
$$

The temperature $\lambda$ is annealed from $2.0$ to $0.1$ over training, so that gates approach hard zero/one values. A budget term pushes the expected number of open gates towards $k$:

$$
\mathcal{L}(\theta, \boldsymbol{\alpha}) = \mathcal{L}_{\text{forecast}}(\theta, \boldsymbol{\alpha}) + \beta \left( \sum_{v \in \mathcal{V}} \sigma(\alpha_v) - k \right)^{2}.
$$

After training we keep the $k$ nodes with the largest $\alpha_v$ and retrain the forecaster on exactly those inputs, which removes the residual effect of partially open gates.[^retrain]

### Respecting installation constraints

Not every node can host a sensor. Some manholes lie under arterial roads where a permit requires lane closures; others are too shallow for the radar gauge. We encode these as a feasibility mask $m_v \in \{0, 1\}$ and set $\alpha_v = -\infty$ for infeasible nodes. Costs can be expressed by weighting the budget term, replacing $\sum_v \sigma(\alpha_v)$ with $\sum_v c_v \, \sigma(\alpha_v)$ and $k$ with a monetary budget $B$.

Feasible node
: A node with $m_v = 1$: accessible, deep enough, with a mobile-network signal at street level.

Candidate set
: All feasible nodes; 61 % of nodes in the north catchment and 48 % in the harbour catchment.

Effective budget
: The number of sensors the method actually selects, which can be lower than $k$ when additional sensors no longer reduce validation error.

## Evaluation

### Data

We used the two catchments described in Section 2.4. Rainfall forcing combined 14 years of radar-derived precipitation at 5-minute resolution with 200 synthetic design storms. Ground truth for every node came from a calibrated hydrodynamic simulation, which is the only way to obtain "observations" at locations where no sensor exists. The DEM and the pipe inventory were supplied by the Valmont water utility in 2024.[^data]

![Mean forecast error against the number of sensors for the north catchment. The learned placement (blue) reaches the error of a 12-sensor greedy placement with 7 sensors.](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAeAAAAEOAgMAAAAs9Cz0AAAADFBMVEX////AUE1EREQ9b7bxqYjxAAAEAklEQVR42u3XPW4cMQwFYBmLrX0k5wguMvfJEdKkX8CdgSBV+smNtkm3gTKzmpnVv0SJpByErOzqw3ukBrZSMjIyMjIyMjIyjHMRWGCBBRZYYIEFFljgztF6Zob1PnywdocH1gWVBC6JJHAViQ7Xo6gwBMWDgSgWDFdR4Ca2H25T++FWthNuZ7vgHrYH7nPb4T62Ge5lW+F+tw1GcJtgBLYJRnEbYBwXDiO5YBjLhcJoLhDGc2EwoguCMV0I/IzpQmBUFwDr25j/jzVu4Gr4GdmthrHdWhh5wdUwetG1ML5bB+MXXQcTFF0HU7g18DNB0VUwSeAKmCZwBUwTuAwTBS7DRIGLMFXgIkwVuASTBS7BZIELMF7g6RMIRgo8LQOCUQJPZkBwf+Apwebh7sBJNQ+f+gLn1DzcFTiv5mF9pWNzcHvTZTULtzZdxWbgU1vTlWwGbgpczWbghsAANg03nBaETcPgpmFsEoaeFpRNwsDAcDcFgwI3sCkYdFotbAqGNN3mJuD6phvZBFzfdLMbh6ubbnfjcGXTHWwcrmy6y43CdU33uVG4quk+NgpXNd3rxuCaprvdGPxyZXBjcLlpBDcCnzSHG4GLK0ZxI3DpMeG4IVx6TEhuCBeaxnJDOP+Y0NwQzjaN5wZw9jEhugGcWzGmG8CZx4Tq+nDmMZ1RXR/ONI3r+nD6MU2fFSWcbHpCDuzByceE7npwasVndNeDUyvGdz04sWLswwrgxIongsAuHF/xmcJ14fiKSVwPnpkW7MOarWgXjt4WkevAsdsiKtqFI7dFVbQLRz4fZK4NR1ZMVrQDhyumK9qBwxUTujYcrPhMV7QNhyumDGzBwYonysAW7K/4TBrYhmfGom1YM16WDfu3RRz4AXu3RR34AXu3RR3Ygme+p+TAmvEp2bB7W/TuATu3RX5ZFuzcFkPgBzzzBj5gzRx4h+3bYgm8w/ZtsQQ+4Ctz4B22bosn8A4//t5iCnzA++9PTIE3+HTjDrzBj6OeXlnh44PJ1vQOz9xNb7Bmb9rAxweTL7CBj9ti2/AOX9kDG3i7rSfGwAbePpicgTeY+6Q3ePtgsjZ9h7ejZm3awFcT+JUbNkfNG/gOm6PmDWxg/tO6w+aomZte4ftRM5+Wga8DAq/w/ai5A6/wetTcp2XgEU0v8HrU7Ke1w/yBF3g9av7AKzwPOK0VfhnStIEHNL3AtyFNq8ty1COaVpflqEc0vcJDmlaXl3lI0+qifw1peoHHBFZvtzGB1dufIae1wL/HNK1+DGpafR/UtPo5qGn1bVDTalTTT9OgwKdRK1ZfR8EXgQUWWGCBBf6Y8JfjV46fBGaG37nmw8BqVNX/KSwjIyMjIyMjIyMj8w/NXw+3DbeZQfBOAAAAAElFTkSuQmCC){width=80%}

Table 1.1 compares the learned placement with three baselines at the same budget. We report RMSE over all nodes for a 30-minute horizon, the error at the 50 nodes with the highest flood risk, and the share of surcharge events detected at least 10 minutes before onset.

| Placement ($k = 12$) | RMSE all (cm) | RMSE high-risk (cm) | Early detection | Training time |
|---|---:|---:|---:|---:|
| Utility's current sensors | 9.8 | 21.4 | 54 % | — |
| Uniform random (mean of 20) | 11.3 | 24.9 | 47 % | — |
| Greedy forward selection | 7.1 | 15.2 | 69 % | 41 h |
| Learned gates (ours) | **6.2** | **11.8** | **81 %** | 6 h |

Table: Forecast skill of four placements with the same budget ($k = 12$), north catchment, 30-minute horizon.

The learned placement improves most where it matters: error at high-risk nodes falls by 22 % relative to greedy selection, and early detection rises by twelve percentage points. Training is also faster, because a single model is trained instead of one per greedy step.

### Sensitivity to the budget

Figure 1.2 shows how error decreases with the budget. The decrease flattens beyond $k \approx 16$; after that, additional sensors mostly duplicate information that the surrogate can already infer from the network topology. This is consistent with the observability argument of Section 2.2, which predicts diminishing returns once every independent sub-catchment contains at least one sensor.[^subcatch]

![Forecast error at the 50 high-risk nodes for budgets k = 4, 6, …, 16 (blue) and for the utility's current twelve sensors (orange).](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAeAAAAEOAgMAAAAs9Cz0AAAADFBMVEX////gej9EREQ9b7ZgGbXOAAAAtElEQVR42u3NsQ1AUBSGUYmojWQJ9jGK2hRGMoDkqTyRoCHicb7uL+49WSZJkqQH68BgMBgcK5qlGgwGg8FgMBh8W1VYGsFgMBgMBoPBYDAY/Cc4j78DGAwGpwmvawCDwWAwGAwGg8Fg8Lfh7T0YDAanB5dxTWAwGAwGg8HgC/DZPRgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGLwL90/VvgWWJEmSJB00Awuysb3oMlM0AAAAAElFTkSuQmCC){width=70%}

### Where the method places sensors

Inspecting the selected nodes reveals a consistent pattern. Of the twelve sensors in the north catchment, five sit immediately downstream of confluences, four at the upstream end of pipes whose slope drops below 0.3 %, and three at outfalls. None sits on the trunk sewer between confluences, which is exactly where greedy selection placed half of its budget. Engineers at the utility recognised the slope-change locations as places where they have historically seen backwater effects, which lends the placement some physical credibility beyond its forecast skill.

Table 1.2 lists the selected nodes with their characteristics; node identifiers follow the utility's asset register.

| Node | Type | Depth (m) | Upstream area (ha) | Reason (post hoc) |
|---|---|---:|---:|---|
| N-0412 | Junction | 3.1 | 84.2 | Below confluence of two laterals |
| N-0877 | Manhole | 2.4 | 31.0 | Slope change, 1.1 % → 0.2 % |
| N-0903 | Manhole | 2.2 | 29.6 | Slope change, 0.8 % → 0.25 % |
| N-1120 | Outfall | 4.0 | 212.7 | River outfall with tidal backwater |
| N-1188 | Junction | 3.6 | 140.9 | Below confluence; known surcharge point |

Table: Five of the twelve nodes selected by the learned placement in the north catchment.

## Discussion

The results support the central hypothesis of this chapter: when the forecaster can exploit network structure, the most informative sensors are not those that best describe their own location but those that pin down the hydraulic state between them. This has a practical consequence for utilities, which typically place sensors where flooding has been reported. Our placements overlap with reported flood sites at only two of twelve locations, yet they forecast flooding at those sites more accurately than sensors placed there directly.[^direct]

Three limitations qualify this conclusion. First, all evaluation used simulated ground truth; a real sensor network adds noise, drift and outages, which Chapter 4 addresses. Second, the relaxation offers no optimality guarantee, and different seeds selected different nodes in 2 of 12 positions, although with nearly identical error. Third, the method assumes that the network topology is known and fixed. Blockages, which change the effective topology during an event, are the subject of Chapter 5.

## Summary

This chapter formulated sensor placement for flood forecasting as a joint optimisation over sensor locations and forecaster parameters, relaxed it through Concrete gates with an annealed temperature, and showed on two catchments that the learned placements reduce high-risk forecast error by 22 % compared with greedy selection at a seventh of the training cost.

## References {.unnumbered}

Halvorsen, C., Ito, R., & Bauer, T. (2017). Continuous relaxations of discrete choices for gradient-based learning. In *Proceedings of the Conference on Learning Representations*.

Lindqvist, A., Sato, M., & Brenner, K. (2008). Near-optimal sensor placement in spatial processes: Theory, algorithms and field studies. *Journal of Spatial Learning*, 9, 235–284.

Okonkwo, H. (2019). *Observing hidden networks: Measurement design for buried infrastructure*. Lisbon: Atlântica University Press.

Valmont Water Utility. (2024). *Sewer asset register and hydraulic model, release 2024.2* [Data set and technical report]. Internal distribution, available on request from the utility's data office.

Weiss, T., & Albrecht, M. (2023). Graph neural surrogates for real-time urban drainage simulation. *Journal of Urban Hydroinformatics*, 12(7), 1104–1121.

[^cost]: The Valmont utility estimates total cost of ownership for a radar level gauge at roughly €11,000 over ten years, of which the device itself is less than a third. Most of the remainder is confined-space entry for cleaning and battery replacement, which requires a team of three.

[^retrain]: Without retraining, the forecaster still receives slightly attenuated signals from nodes whose gates are almost but not entirely closed, and its error on the hard placement is about 9 % higher than after retraining.

[^data]: The asset register contains 1,284 nodes for the north catchment and 2,031 for the harbour catchment. Twenty-two nodes in the north catchment had missing invert levels, which we interpolated along the pipe as described in Appendix B.

[^subcatch]: The north catchment has 15 sub-catchments whose outlets do not share a downstream junction before the treatment plant.

[^direct]: Placing the twelve sensors directly at the reported flood sites gives an RMSE of 14.0 cm at high-risk nodes, against 11.8 cm for the learned placement.
