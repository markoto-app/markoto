<!-- A research paper as an arXiv preprint. The title block at the top of page 1 (document theme › Cover page) prints the title, "A Preprint", the authors with their affiliations and the date; edit them there, not in the text. Section numbers come from the theme: never type them. -->

# Abstract

<!-- 150–250 words in one paragraph, no citations. One or two sentences of context, one on the gap, one or two on what you did, two or three on what you found (with the main number), one on why it matters. This section moves into the title block. -->

***Keywords*** First keyword · Second keyword · Third keyword

# Introduction

<!-- Funnel from the broad context to the narrow problem to your contribution. Cite landmark works only; the detail belongs in Related work. End with a paragraph that starts "In this paper, we …" and, if it helps, a numbered list of two to four contributions. -->

# Related work

<!-- Two to four themes, one paragraph each: what has been done, what is missing, where your work fits. Synthesise rather than list ("X did A. Y did B."). Cite with [@key], [@key, p. 12] or [@a; @b], using the keys of the sources you added in the References panel. -->

# Method

<!-- Enough detail that someone else could reproduce the work: data, model or procedure, assumptions, and the tools you used. Give an equation you refer to later a label such as {#eq:model} after its closing $$; it is numbered for you, and @eq:model in the text prints its number. -->

$$
y = f(x; \theta)
$$ {#eq:model}

## Data

<!-- Where the data comes from, how much of it there is, how it was split or sampled, and what was excluded and why. -->

## Procedure

<!-- The steps of the method, in order. Side remarks go into footnotes, which print at the foot of their page. -->

Step one.[^1]

# Experiments

<!-- Report what you found, not what it means. Tables and figures carry the results; the prose points the reader to them. A table's caption goes on a "Table:" line directly above it; a label at its end ({#tbl:name}) lets you write @tbl:name, which prints "Table 1". A figure is an image alone in its paragraph; its alt text becomes the caption. -->

## Setup

<!-- Baselines, metrics, hardware and the settings needed to repeat each experiment. -->

## Results

@tbl:results compares our method with the baseline.

Table: Main results. {#tbl:results}

| Method | Metric A | Metric B |
|---|--:|--:|
| Baseline | - | - |
| Ours | - | - |

# Discussion

<!-- Now interpret. Restate the headline finding, compare it with prior work, say what surprised you, and name the limitations explicitly. -->

# Conclusion

<!-- One or two paragraphs in plain language for a reader who only reads the abstract and the conclusion: the takeaway and what comes next. -->

# References {.unnumbered}

<!-- Generated from the sources you cite. Add them in the References panel (book icon above the sidebar): by DOI, by pasting BibTeX, or by importing a .bib or CSL JSON export from Zotero. Pick the venue's style there (APA, Chicago, Harvard, IEEE, Vancouver, DIN 1505-2). -->

[[bibliography]]

[^1]: Footnote text.
