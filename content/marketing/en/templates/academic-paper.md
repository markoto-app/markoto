---
title: Academic paper Markdown template with math
description: An academic paper template in Markdown with abstract, LaTeX math and footnotes, set like an arXiv preprint. No BibTeX; you type the references.
keywords:
  - academic paper markdown template
  - markdown thesis template
  - scientific paper in markdown
  - markdown latex math
  - markdown paper to pdf
updated: '2026-11-08'
navGroup: templates
navLabel: Academic paper template
navOrder: 40
---

# Academic paper template in Markdown

This template follows the usual structure of a research paper: abstract, introduction, related work, methods, results, discussion, conclusion and references. You write Markdown, with formulas in LaTeX syntax and footnotes, and the **arXiv preprint** theme sets it like a LaTeX preprint: Times, justified, numbered sections, and the title and abstract in a block at the top of page 1.

Below is a short paper written with the template. Its first line, `# Reading speed on paper and on screen`, is the title: the theme puts it in the title block, between two rules.

::try-it{theme="arxiv" height="760"}
---
source: |
  # Reading speed on paper and on screen

  ## Abstract

  We compared reading speed and recall for 120 students who read the same texts on paper and on a tablet. Reading speed did not differ, but recall of details was 9% lower on screen. The gap was largest for texts longer than 2,000 words.

  ## Introduction

  Many studies report that people understand printed text better than text on a screen.[^1] Fewer separate speed from recall. In this paper, we measure both in one design.

  ## Methods

  Each participant read four texts, two per medium, in a random order. Recall was scored as the share of correct answers, and we report the effect size as

  $$
  d = \frac{\bar{x}_{\text{paper}} - \bar{x}_{\text{screen}}}{s_{\text{pooled}}}
  $$

  where $s_{\text{pooled}}$ is the pooled standard deviation.

  ## Results

  | Measure | Paper | Screen | $d$ |
  |---|--:|--:|--:|
  | Words per minute | 238 | 241 | 0.03 |
  | Recall (%) | 71 | 62 | 0.41 |

  ## Discussion

  The medium changed what readers remembered, not how fast they read. A limitation is that all texts were expository; narrative texts may behave differently.[^2]

  ## References {.unnumbered}

  1. Clinton, V. (2019). Reading from paper compared to screens. *Journal of Research in Reading*, 42(2), 288–325.
  2. Delgado, P. et al. (2018). Don't throw away your printed books. *Educational Research Review*, 25, 23–38.

  [^1]: See the meta-analyses by Clinton (2019) and Delgado et al. (2018).
  [^2]: Narrative texts were left out to keep the reading time under one hour.
---
::

::cta{title="Write your paper from this template." label="Use this template" template="academic-paper" theme="arxiv" secondary-label="All templates" secondary-to="/templates"}
Opens the new-document dialog with the academic paper template and the arXiv preprint theme selected. It starts with the same headings and a short brief in each section.
::

## What's in it

- **Title, authors and affiliations.** A note under the title says how to lay out the author line. In the arXiv preprint theme, enter the authors and their affiliations under **Cover page** in the document theme instead: they are set side by side under the title.
- **Abstract.** A brief for 150 to 250 words: context, gap, what you did, what you found, why it matters.
- **Introduction, related work, methods, results, discussion, conclusion.** Each section has a note on what goes there, such as "report what you found, not what it means" under Results.
- **References.** Typed by hand in the style the venue asks for.

The notes are Markdown comments: they show in the editor and to the AI assistant, never on the page or in the PDF.

## What Markdown gives you here

- **Math.** Inline `$...$` and display `$$...$$` formulas in LaTeX syntax, rendered with KaTeX in the preview and the PDF.
- **Footnotes.** `[^1]` in the text and the note below; it prints at the foot of the page where it is cited.
- **Table of contents.** `[[toc]]` lists the headings with their page numbers.
- **Tables, figures and diagrams.** Markdown tables, images with captions (with an account) and Mermaid diagrams.
- **One or two columns.** The arXiv preprint theme sets one column; the IEEE conference paper theme sets two. Any theme can be changed to either.

## What it doesn't do

markoto has **no BibTeX, no citation manager and no automatic reference list**. You type the references as a numbered list and cite them by hand, as [1] or with footnotes. Apart from the arXiv preprint and IEEE conference paper looks there are no journal or university templates, and no LaTeX beyond math formulas. If you need those, [Overleaf](/compare/overleaf) or [Typst](/compare/typst) are the better tools.

## Who it's for

Students writing a term paper or a short thesis, researchers drafting a working paper or a report with co-authors, and anyone whose venue accepts a PDF without a prescribed template. Co-authors can edit the same document at the same time, leave comments, and restore earlier versions.

## Questions

::faq{json-ld}
---
items:
  - q: Can I write LaTeX math in Markdown here?
    a: Yes. Inline math goes between single dollar signs and display math between double dollar signs, in LaTeX syntax. KaTeX renders it in the preview and in the PDF.
  - q: Does the template support BibTeX or Zotero?
    a: No. markoto has no citation support. Type the reference list by hand and cite with numbers or footnotes.
  - q: Can I set the paper in two columns?
    a: Yes. Pick the IEEE conference paper theme, or set the layout to two columns in the document theme.
  - q: Can I submit the PDF to a journal?
    a: If the journal accepts a PDF in any layout, yes. If it requires its own LaTeX or Word template, use that template instead.
---
::

::cta{title="Markdown in, a typeset paper out." label="Use this template" template="academic-paper" theme="arxiv"}
Free on markoto.app, no sign-up needed.
::
