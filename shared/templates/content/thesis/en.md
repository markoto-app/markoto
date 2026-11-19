<!-- A Bachelor's, Master's or doctoral thesis. The title page (document theme › Cover page) prints the title, the kind of thesis and the department as subtitle, your name, your institution and the date; edit them there. Every top-level heading is a chapter: it opens a new page under "Chapter 1", "Chapter 2" … from the theme, so never type numbers. Tables and figures are numbered within their chapter. -->

# Abstract

<!-- One page at most, written last. The question, why it matters, what you did, what you found (with the main numbers) and what follows from it. No citations. If your institution asks for a second abstract in another language, add it as its own heading with {.unnumbered}. -->

# Acknowledgements {.unnumbered}

<!-- Optional, a few sentences: supervisors, examiners, colleagues, funding, family. -->

<!-- pagebreak -->

[[toc]]

# Introduction

<!-- Five to ten pages. Lead from the field to the gap your thesis fills, then state the research questions and contributions exactly; later chapters refer back to them. -->

## Motivation

<!-- The problem and why it is worth a thesis: who is affected, what is unknown or unsolved, and what a solution would change. -->

## Research questions

<!-- Two to four questions, each answerable by a later chapter. -->

1. Research question one.
2. Research question two.

## Contributions

<!-- What is new in this thesis, one item per contribution, each with the chapter that delivers it. Name any published papers the chapters are based on. -->

## Outline

<!-- One or two sentences per chapter, in order. -->

# Background

<!-- The concepts, notation and prior work the reader needs, and nothing more. Group the literature by theme and end each theme with what is still missing. Define abbreviations on first use; a line like *[ABC]: Full name anywhere in the text explains ABC on hover. -->

## Concepts and notation

<!-- Definitions you rely on later. A definition list (a term on one line, ": its definition" on the next) keeps them easy to find. -->

## Related work

<!-- Two to four themes, one section each if they are long. Synthesise rather than summarise paper by paper. Cite with [@key] or [@key, p. 12], using the keys of the sources you added in the References panel. -->

# Method

<!-- How you answered the research questions, in enough detail to reproduce: design, data or materials, procedure, tools and how you evaluated. Justify each choice against the alternatives. Give a display equation you refer to a label such as {#eq:model} after its closing $$; it is numbered for you, and @eq:model in the text prints its number. -->

$$
y = f(x)
$$ {#eq:model}

## Data

<!-- Sources, size, collection or selection, cleaning, and what you excluded and why. -->

## Procedure

<!-- The steps, in order. Long side remarks go into footnotes, which print at the foot of their page. -->

Step one.[^1]

# Results

<!-- What you found, per research question, without interpretation. Each claim points to a table or figure. A table's caption goes on a "Table:" line directly above it, a figure is an image alone in its paragraph with its alt text as the caption; give each a label ({#tbl:name} at the end of the caption, {#fig:name} after the image) and write @tbl:name in the text, which prints "Table 4.1". -->

## First result

@tbl:results compares the conditions.

Table: Caption of the table. {#tbl:results}

| Condition | Measure | Measure |
|---|--:|--:|
| Baseline | - | - |
| Condition | - | - |

## Second result

# Discussion

<!-- Interpret the results against the research questions and the literature from Chapter 2: what they mean, what is surprising, what is robust. -->

## Limitations

<!-- What the results cannot show, and why: data, method, scope. Be specific. -->

# Conclusion

<!-- Two to four pages: answer each research question in one paragraph, summarise the contributions and name concrete future work. No new results. -->

# Bibliography {.unnumbered}

<!-- Generated from the sources you cite. Add them in the References panel (book icon above the sidebar): by DOI, by pasting BibTeX, or by importing a .bib or CSL JSON export from Zotero. Pick the style your department asks for there (APA, Chicago, Harvard, IEEE, Vancouver, DIN 1505-2). -->

[[bibliography]]

# Appendix {.unnumbered}

<!-- Material that supports but would interrupt the text: full tables, proofs, questionnaires, extra figures. Mark each part with a bold run-in label such as **A. Additional tables.** and refer to it from the chapter that needs it. -->

**A. Supplementary material.** Text.

[^1]: Footnote text.
