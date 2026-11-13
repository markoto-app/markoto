---
title: Tune your typography and colors
description: Open the Theme tab and tweak fonts, colors, page geometry, header/footer tokens, and see the preview repaginate live.
category: themes
order: 2
updated: '2026-11-08'
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
  headings 1 to 4, and the same numbers in the table of contents. Pick
  1., 1.1., 1.1.1. for numbers with a closing dot, or I., A., 1), a) for
  the IEEE style, where each level shows only its own number. If your
  sections start at heading 2, the numbers start there: the first is 1,
  not 0.1. The cover title and a leading *Abstract* section get none. To
  leave out another heading, such as the references, write
  `{.unnumbered}` after it: `# References {.unnumbered}`. The sections
  after it keep counting as if it weren't there. 01, 01.1 gives two-digit
  numbers. *Numbered levels* limits the numbers to the top level (or the
  top two or three), and *Chapter label* puts "Chapter 3" on a line of
  its own above each numbered top-level heading, in the document's
  language unless you type your own word.
- **One heading level at a time.** *Per level*, at the end of the
  Headings section, sets the size (as a multiple of the body text), the
  weight, italics or small capitals for heading 1, 2, 3 or 4 on its own,
  for formats that prescribe them: an arXiv preprint has 12 pt bold
  sections over 10 pt text, an IEEE paper small-capital sections and
  italic subsections. *Centred* centres a level, number included. A
  level you don't touch follows the scale ratio; *Use defaults* hands a
  level back to it.
- **Running heads.** The page header and footer take the tokens
  `{title}`, `{section}`, `{author}`, `{date}`, `{page}` and `{pages}`.
  `{section}` is the title of the current chapter (your top-level
  heading): the one that starts on the page, or the one still running
  from the page before. Choose *The section the page starts in* to name
  the chapter a page begins in instead, and *Section number* to show
  "3 Procedures" rather than "Procedures". `{author}` prints the cover's
  authors.
- **Captions and numbers.** Write a table's caption as a paragraph that
  starts with `Table:` right above or below the table (see
  [Markdown syntax](/docs/writing/markdown-reference#tables)). In the
  Tables section, *Caption position* puts captions above or below
  tables, and *Number table captions* adds "Table 1:" in the document's
  language. *Number figure captions* in the Images and quotes section
  does the same for images ("Figure 1:"). With numbers on, *Caption
  numbers* counts per chapter instead (Figure 3.1, 3.2), and *Caption
  label* can put a bold "Table 1" on its own line above the title, as
  APA wants.
- **Reference list.** A section headed *References* (or Bibliography,
  Literatur, Références, Referencias …) is your reference list. *Reference
  list* in the Images and quotes section gives it a hanging indent or
  numbers in brackets, [1], [2], also where the list continues on the
  next page.
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
  portrait or landscape. *Margins per side*, under the margin, sets the
  top, right, bottom or left margin on its own, for formats with a deeper
  bottom margin or a binding edge.
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

- [Save what you tuned as a preset](/docs/themes/save-preset): reuse on the next doc with one click.
- [Set it as your workspace default](/docs/workspaces/default-theme): every new workspace doc inherits it.
- [Edit the cover page](/docs/themes/cover-page): the front-page treatment is its own subsection.
