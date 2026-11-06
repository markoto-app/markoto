# Building a design template

How a design template (a built-in theme preset in
`shared/utils/themePresets.ts`) gets made. The arXiv preprint preset was the
pilot; follow the same steps for the next one. The theme system itself is
described in `app/utils/AGENTS.md` (theme system, optional fields, heading
scale, numbering, title block, bundled fonts, custom CSS, theme shots).

A template is a theme: preset values first, a small block of template CSS
for what no theme field covers, and a Markdown fixture that shows it off.

## The process

1. **Reference.** Know exactly what you are rebuilding.
   - Format templates (a journal, arXiv, IEEE, a thesis class): compile the
     original LaTeX and rasterise it at 144 dpi, which is 2 px per pt:

     ```bash
     tectonic template.tex                          # → template.pdf
     pdftoppm -r 144 -png template.pdf ref/ref      # → ref/ref-1.png …
     ```

     (`pdftoppm` zero-pads for documents over 9 pages: rename to
     `ref-1.png`, `ref-2.png`, … .) Keep the class/style file next to it:
     it is the spec.
   - Design templates without an original (a report, a newsletter): write a
     short design brief first (purpose, reader, page size, type pairing,
     colour, mood, two or three reference documents) and get it agreed.
2. **Fixture.** The same content as Markdown in
   `tests/fixtures/theme-shots/<id>.md` (images as small PNG data URIs),
   plus `<id>-patch.json` for what is per document (authors,
   affiliations, date) — everything else must come from the preset. Use
   plain portable Markdown: a leading `# Abstract` section,
   `# References {.unnumbered}`, footnotes, a table, a figure, a list.
3. **Values from the spec.** Take every number from the original, not from
   the picture: page size and margins, body font, size and leading,
   paragraph spacing and indent, heading sizes per level, rules, running
   head and foot. Write the source next to each value in the preset
   comment.
4. **Render and compare.** Build and start the app with test mode (so
   `--patch` works), then:

   ```bash
   bun scripts/render-theme-shots.ts --base http://127.0.0.1:3309 --out /tmp/<id> \
     --md tests/fixtures/theme-shots/<id>.md --title "<title>" \
     --patch tests/fixtures/theme-shots/<id>-patch.json <id>
   scripts/compare-template-reference.sh ref /tmp/<id> <id> <pages>
   ```

   Look at every `side-N.png` (reference left, ours right) and
   `overlay-N.png` (cyan = only in the reference, red = only ours, black =
   both). While iterating on template CSS, put it into the patch JSON as
   `customCss`: no rebuild needed.
5. **List the differences** and classify each one:
   - **preset value** — a theme field set wrong (size, spacing, margin);
   - **template CSS** — something only this template does (booktabs table
     rules, a run-in abstract, the label format of a caption);
   - **engine variable** — something CSS can't do cleanly, or several
     templates need (a running-head rule, per-level heading sizes):
     propose a theme field to the owner;
   - **can't do** — a limit of Markdown or of the medium (floats,
     `\thanks` footnotes on authors, microtype font expansion,
     cross-reference labels).
6. **Iterate** until only "can't do" remains.
7. **Bake** it into a preset: values in `THEME_PRESETS`, template CSS as
   the preset's `customCss` (a commented constant next to the preset; each
   rule names its source in the original), i18n
   `theme.presets.<id>.{name,description}` in all six locales, the
   fixture committed. Every optional field spelled out
   (`tests/unit/themeFoundation.test.ts` checks it); template CSS passes
   the sanitizer without issues and follows the CSS rules below
   (`tests/unit/themePresetCss.test.ts`).
8. **Real renderer.** Add a case to
   `tests/integration/endpoints/docPdf.test.ts`: the server PDF of the
   fixture has the expected page count and its fonts are embedded
   TrueType/OpenType (`pdffonts`), never Type 3 (a Type 3 font means the
   web font did not load and Chromium rasterised glyphs).
9. **Before/after for the owner.** Post the side-by-side and overlay
   images of the final version (and the previous one if this replaces a
   look) with the list of remaining "can't do" differences.

## Template CSS rules

The preset's `customCss` runs through the same sanitizer as an author's
custom CSS (`shared/utils/customCss.ts`) and is appended after the
generated theme CSS.

- **Prefix every document rule with `.paged-doc`.** The engine's own
  selectors are `.paged-doc .x …`; an unprefixed rule loses on
  specificity. Running heads and feet live outside `.paged-doc` (paged.js
  margin boxes): target them as `.pagedjs_pages .pagedjs_page
  .pagedjs_margin-top-right` and so on.
- **Never redefine `@page` margin boxes** (`@top-center { … }`). The new
  rule replaces paged.js's margin box including its `content` — the
  running head disappears. Style the generated boxes through the classes
  above instead.
- **Never `counter-reset` on `.paged-doc`.** It wipes the engine's
  counters (headings, footnotes). For a counter of your own use
  `counter-increment` alone (`figure { counter-increment: mk-fig }`).
- **No commas inside `:is()`, `:not()`, `:has()`.** paged.js splits every
  selector list at commas, and a comma inside parentheses breaks its
  `querySelectorAll` — the whole render fails. Top-level selector lists
  (`.paged-doc ul, .paged-doc ol`) are fine.
- No `@import`, `@font-face`, external `url()`: the sanitizer refuses them.
  Fonts come from the bundled / self-hosted families (`themeFonts.ts`).
- **Follow the author's choices: use the variables, not names.** The
  engine sets these on `.paged-doc` and on every `.pagedjs_page` (so they
  reach the running heads too): `--doc-body-font`, `--doc-heading-font`,
  `--doc-meta-font`, `--doc-mono-font` (full font stacks), `--doc-accent`
  (= `--doc-brand`), `--doc-secondary`, `--doc-text`, plus on `.paged-doc`
  `--doc-bg` and `--doc-heading-color`. A pull quote in
  `font-family: var(--doc-heading-font)` changes with the heading font; one
  in `"Source Serif 4"` does not. `--doc-reference-indent` (default
  1.5em) sets the hanging indent of the reference list.
- **Target structure through the engine's markers, not position.**
  paged.js clones `.paged-doc` (and every parent of split content) onto
  each page, so `:first-of-type`, `:first-child` and sibling selectors
  across a page break match once PER PAGE. Use:
  `.markoto-first-section` (the document's first top-level heading),
  `.markoto-section-heading` (every top-level heading),
  `.markoto-references` (lists + paragraphs of the References /
  Bibliography / Literatur … section; heading
  `.markoto-references-heading`), `table > caption` (Pandoc `Table: …`),
  and the counters `mk-h1…mk-h4` (headings), `mk-table`, `mk-figure`
  (captions, when the theme numbers them). Change a caption label's format
  through `::before { content: … }` on `table > caption` / `figcaption`.
- **Engine fields first:** heading numbers (`decimal`, `decimal-dot`,
  `ieee`), per-level alignment, per-side page margins, caption position +
  labels, the reference-list style and the `{section}` running-head token
  are theme fields — don't rebuild them in CSS.
- Comment every rule with the line of the original it reproduces.

**Variables before CSS.** If a template needs more than about 40 lines of
CSS, or several templates need the same thing, propose a theme variable
instead (owner approval). That is how `header.rule` / `footer.rule`,
`headings.levels`, `cover.titleWeight` and `{.unnumbered}` headings came
about: the arXiv pilot needed them in CSS, and they were brittle there.
The IEEE, corporate-report and tech-docs templates added numbering
styles, heading alignment, per-side margins, table captions, figure and
table numbers, the reference-list class + style, `{section}` and the font
variables the same way.

## Design checklist

- **Body:** size and leading (10–12 pt, 1.1–1.5), measure 60–80 characters
  per line, justified only with hyphenation.
- **Leading and rhythm:** paragraph spacing or first-line indent, not
  both; space around headings in body lines, more above than below.
- **Heading scale:** h1 within 1.6–2.2× body via the scale; format
  templates that prescribe sizes set them per level (`headings.levels`).
- **Page breaks:** headings stay with their text, no single lines at the
  top or bottom, tables split between rows with repeated headers — check
  the page ends in every rendering.
- **Code:** font, size relative to body, background and frame quiet
  enough for print, long lines wrapped.
- **Tables:** borders, header row, padding, alignment of numbers.
- **Footnotes:** size, rule, marker.
- **Running head and foot:** what is on which side, size, rule, none on
  the title page.
- **Title page or title block:** title size and weight, authors,
  affiliations, date, abstract.
- **Colour:** restraint — one accent at most; links, alerts and diagrams
  readable in black-and-white print.
