---
title: Tune your typography and colors
description: Open the Theme tab and tweak fonts, colors, page geometry, header/footer tokens — see the preview repaginate live.
category: themes
order: 2
updated: '2026-11-06'
---

# Tune your typography and colors

A preset sets the overall look; the Theme tab is where you adjust the
details. It has sixteen sections: cover page, page, body text, headings, meta
voice, colors, layout, page header, page footer, code blocks, tables,
images and quotes, table of contents, diagrams, admonitions and custom
CSS. Every change drives both the
live preview and the PDF export.

::flow{id="tune-your-typography-and-colors" hide-title}
::

## Headings, code and pages

A few settings worth knowing:

- **Heading size.** *Scale ratio* in the Headings section sets how much
  each heading level grows: level 4 is as large as the body text, level 3
  one step larger, level 1 three steps. Each option tells you what level
  1 ends up as, for example *1.25 (heading 1 = 2.0× body)*. Large display
  sizes are for the cover page; set them with the cover's title size.
- **Numbered sections.** *Numbering* puts 1, 1.1, 1.1.1 in front of
  headings 1 to 4, and the same numbers in the table of contents. The
  cover title and a leading *Abstract* section get none. To leave out
  another heading, such as the references, write `{.unnumbered}` after
  it: `# References {.unnumbered}`. The sections after it keep counting
  as if it weren't there.
- **One heading level at a time.** *Per level*, at the end of the
  Headings section, sets the size (as a multiple of the body text), the
  weight, italics or small capitals for heading 1, 2, 3 or 4 on its own,
  for formats that prescribe them: an arXiv preprint has 12 pt bold
  sections over 10 pt text, an IEEE paper small-capital sections and
  italic subsections. A level you don't touch follows the scale ratio;
  *Use defaults* hands a level back to it.
- **A rule under the header.** *Rule under the header* in the Page header
  section draws a thin line across the full text width, right under the
  header text, and moves the header close to the text, as in a journal or
  a LaTeX document. *Rule above the footer* does the same for the footer.
  Pages without a header (the cover page, page 1 of a paper) get no rule.
- **Code blocks.** Pick a color theme and a code font (Latin Modern Mono
  gives the LaTeX typewriter look). Light themes get a faint background
  so a block doesn't float on the page; *Background* and *Frame* (an
  accent line on the left or a thin border) change that. Long lines wrap,
  because a printed page can't scroll; switch *Wrap long lines* off to
  keep them on one line. *Line numbers* numbers every line. Name a block
  by adding a title after the language, and it shows above the block:

  ````markdown
  ```ts title="replay.ts"
  export async function replay() { … }
  ```
  ````

  Short blocks stay on one page; long ones continue on the next.
- **Page size.** A4, A5 (books and manuscripts), Letter and Legal, each
  portrait or landscape.
- **Fonts.** Besides the web fonts, the pickers offer TeX Gyre Termes (a
  Times design), TeX Gyre Heros (a Helvetica design) and Latin Modern
  Roman (the classic LaTeX face), for documents that should look like
  they came out of LaTeX. They load from markoto itself, in the preview
  and in the PDF, and include Greek letters, so "3 μm" or "λ = 532 nm"
  in the text matches the rest of the line. Fonts are embedded in the PDF
  as real fonts, which print shops expect.
- **Charts.** With the "Match document" diagram colors, chart and pie colors
  follow your accent color and also differ in lightness, so neighboring
  slices stay distinguishable when the PDF is printed in black and white.

## What just happened

Each change applies to the live preview and the PDF export at the same
time, and everyone else in the document sees it immediately.

Theme changes are recorded in the activity log, so you can
[restore](/docs/history/restore) an earlier look like any other edit.

## What's next

- [Save what you tuned as a preset](/docs/themes/save-preset) — reuse on the next doc with one click.
- [Set it as your workspace default](/docs/workspaces/default-theme) — every new workspace doc inherits it.
- [Edit the cover page](/docs/themes/cover-page) — the front-page treatment is its own subsection.
