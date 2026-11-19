---
title: Mermaid diagrams and math in Markdown
description: Write Mermaid diagrams and LaTeX math (KaTeX) in Markdown and get them on printed pages and in the PDF, in your document's fonts and colours.
keywords:
  - markdown mermaid
  - mermaid diagram in markdown
  - markdown math katex
  - latex math in markdown
  - markdown with diagrams pdf
updated: '2026-11-19'
navGroup: use-cases
navLabel: Diagrams and math
navOrder: 50
---

# Mermaid diagrams and math in Markdown

In markoto, a diagram is a fenced code block with the language `mermaid`, and a formula is LaTeX between dollar signs. Both are drawn in the live preview while you type, on the same pages as the rest of the document, and the PDF has them exactly where the preview put them. The text stays plain Markdown that other tools can read.

Change the example below and watch the pages update.

::try-it{theme="modern" height="620"}
---
source: |
  # Release review

  ## How a change ships

  ```mermaid
  flowchart LR
    PR[Pull request] --> CI{Checks pass?}
    CI -->|yes| Review[Review]
    CI -->|no| PR
    Review --> Release[Release]
  ```

  ## Error budget

  With an availability target of $99.9\%$, a 30-day month allows

  $$
  (1 - 0.999) \times 30 \times 24 \times 60 \approx 43.2 \text{ minutes}
  $$

  of downtime.

  ```mermaid
  pie title Where the downtime went
    "Deploys" : 18
    "Database" : 12
    "Network" : 6
  ```
---
::

## Diagrams with Mermaid

[Mermaid](https://mermaid.js.org/) turns a few lines of text into a diagram. markoto supports flowcharts, sequence, class, state and ER diagrams, Gantt charts, pie charts, mind maps, Git graphs and timelines. The **Insert › Diagram** menu adds a working starter for the common kinds, so you don't have to remember the syntax.

A flowchart:

::sample{kind="gfm"}
---
source: |
  ```mermaid
  flowchart TD
    A[Draft] --> B{Approved?}
    B -->|yes| C[Publish]
    B -->|no| D[Revise]
    D --> A
  ```
---
::

A sequence diagram:

::sample{kind="gfm"}
---
source: |
  ```mermaid
  sequenceDiagram
    Browser->>Server: GET /report
    Server->>Database: query
    Database-->>Server: rows
    Server-->>Browser: 200 OK
  ```
---
::

A state diagram:

::sample{kind="gfm"}
---
source: |
  ```mermaid
  stateDiagram-v2
    [*] --> Draft
    Draft --> InReview : submit
    InReview --> Draft : changes requested
    InReview --> Published : approve
    Published --> [*]
  ```
---
::

### Diagrams that fit the page

A diagram in markoto is part of a printed document, so it follows the document's theme:

- **The document's font.** Labels are set in the body font and stay real text in the PDF, so they are sharp at any zoom and can be selected and searched.
- **The document's colours.** The default diagram style takes its colours from the theme (accent, headings, text, paper). You can switch to one of Mermaid's own styles in the theme panel.
- **Kept on one page.** A diagram is never split across a page break. Large diagrams are scaled to the text width and to under half the page height; pie charts are drawn smaller.

::flow-strip{id="rich-content" frames="20" caption="A code block, an alert, a formula and a Mermaid pie chart: the Markdown on the left, the page on the right."}
::

## Math with KaTeX

Write LaTeX math between single dollar signs for a formula inside a sentence, or between `$$` lines for a formula on its own line. markoto draws it with [KaTeX](https://katex.org/), which covers the LaTeX math most people use: fractions, sums and integrals, matrices, Greek letters, aligned equations.

::sample{kind="gfm"}
---
source: |
  The area of a circle is $A = \pi r^2$.

  $$
  \int_0^1 x^2 \, dx = \frac{1}{3}
  $$
---
::

Aligned steps and matrices:

::sample{kind="gfm"}
---
source: |
  $$
  \begin{aligned}
  (a + b)^2 &= (a + b)(a + b) \\
            &= a^2 + 2ab + b^2
  \end{aligned}
  $$

  $$
  M = \begin{pmatrix}
    1 & 0 \\
    0 & 1
  \end{pmatrix}
  $$
---
::

Write `\$` when you mean a literal dollar sign. A formula with a mistake is shown in red instead of breaking the rest of the page.
## Around the diagrams

The same documents usually need more than a diagram. markoto also renders:

- **Alerts**: `> [!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]` and `[!CAUTION]` callouts, as on GitHub.
- **Footnotes**, placed at the foot of the page they belong to.
- **Highlighted code blocks** for most languages.
- **A table of contents** with page numbers, written as `[[toc]]`.
- **Page breaks** where you put `<!-- pagebreak -->`.

The [Markdown cheat sheet](/markdown-cheat-sheet) lists every syntax with examples.

## Where it falls short

- **Mermaid only.** Graphviz, PlantUML, Vega-Lite and music notation are not rendered; they show as code blocks.
- **KaTeX, not full LaTeX.** KaTeX draws LaTeX math, but there are no LaTeX packages, document classes or macro files. For papers that need those, LaTeX or Typst fits better; see [markoto vs Overleaf](/compare/overleaf) and [markoto vs Typst](/compare/typst).
- **No drawing tool.** Diagrams are written as text. There is no canvas to drag boxes around.
- **Six citation styles.** Citations from BibTeX work ([Citations, bibliography and cross-references](/docs/writing/citations)), but only in the built-in styles.

## Questions

::faq{json-ld}
---
items:
  - q: How do I add a Mermaid diagram to Markdown?
    a: Start a fenced code block with three backticks and the word mermaid, write the diagram, and close the block. In markoto the diagram appears in the preview right away. The Insert menu adds a starter diagram if you don't know the syntax.
  - q: Which Mermaid diagram types work?
    a: Flowcharts, sequence, class, state and ER diagrams, Gantt charts, pie charts, mind maps, Git graphs and timelines.
  - q: Do the diagrams and formulas appear in the PDF?
    a: Yes. The PDF is made from the same pages as the preview, so diagrams and formulas are where you saw them, with diagram labels as real text.
  - q: Is the math syntax LaTeX?
    a: Yes, the LaTeX math syntax, drawn with KaTeX. Inline math goes between single dollar signs, a formula on its own line between double dollar signs.
  - q: Will my Markdown still work in other editors?
    a: Mostly. Mermaid code blocks and dollar-sign math are understood by GitHub and many editors. Where they are not, they show as plain text, and nothing is lost.
  - q: Do I need an account?
    a: No. You can write, preview and download a PDF without signing in.
---
::

::cta{title="Write a document with diagrams and math." secondary-label="Read the docs" secondary-to="/docs/writing/rich-content"}
Start a document, add a diagram from the Insert menu, and download the PDF when the pages look right. No sign-up needed.
::
