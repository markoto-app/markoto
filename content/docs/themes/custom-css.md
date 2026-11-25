---
title: Add your own CSS
description: When the theme settings don't go far enough, write CSS rules for your document. Which selectors exist, what is allowed, and examples to copy.
category: themes
order: 5
updated: '2026-11-25'
---

# Add your own CSS

The theme settings cover fonts, colors, page geometry, headers and
footers. When you need something they don't offer, such as a page number
that says "3 / 12", a colored line under every second-level heading or a
two-column glossary, add your own CSS rules to the document.

Open the **Theme** tab and expand **Custom CSS** at the bottom. Type your
rules, and the preview updates after a short pause. Your rules come after
the theme settings, so they win when both style the same thing.

Custom CSS styles the document only: the live preview, printing
(`Cmd/Ctrl+P`) and the PDF export. The editor and the rest of markoto stay
as they are.

Try the theme settings first. They keep working when you switch presets,
and the markoto assistant can change them for you. Reach for CSS when no
setting does what you want.

Custom CSS is available on every self-hosted instance. On markoto.app it is not part of the free plan: it is part of Pro, Team and Business.

## Where your CSS applies

Everything you write in the editor ends up inside one element,
`.paged-doc`. Start your selectors with it so they only touch the
document:

| Selector | What it styles |
|---|---|
| `.paged-doc` | The whole document body. Two- and three-column themes set `column-count` here. |
| `.paged-doc h1` … `h6` | Headings. Each one gets an id made from its text, so `#introduction` targets the heading "Introduction". |
| `.paged-doc p` | Paragraphs. |
| `.paged-doc a` | Links. |
| `.paged-doc blockquote` | Quotes (`>`). |
| `.paged-doc table` | Tables, with `th`, `td`, `thead` and `tbody tr` inside. |
| `.paged-doc pre` | Code blocks. Inline code is `.paged-doc :not(pre) > code`. Each line is a `.code-line` with its number in `data-line`. |
| `.paged-doc .code-block` | A code block with a title (```` ```ts title="app.ts" ````); the title bar is `.code-title`. |
| `.paged-doc img` | Images. |
| `.paged-doc figure` | The figure around an image; the caption is `figcaption`. |
| `.paged-doc hr` | Horizontal rules (`---`). |
| `.paged-doc li.task-list-item` | Items of a task list (`- [ ]`). |
| `.paged-doc .markdown-alert` | Alert boxes (`> [!NOTE]`). Each kind adds a class: `.markdown-alert-note`, `-tip`, `-important`, `-warning`, `-caution`. |
| `.paged-doc .markdown-alert-title` | The title line of an alert. |
| `.paged-doc .table-of-contents` | The table of contents from `[[toc]]`. |
| `.paged-doc .footnote` | Footnotes, printed at the foot of the page. |
| `.paged-doc .mermaid` | Diagrams. Style the drawing itself with `.paged-doc .mermaid > svg`. |
| `.paged-doc .katex` | Math. |
| `.paged-doc .page-break` | A `<!-- pagebreak -->` marker. |
| `.paged-doc .markoto-dropcap` | The large first letter, when the theme has a drop cap. |

### Your own classes

To style one part of the document, give it a class in the Markdown and
target that class. Put `{.name}` right after a heading, link, image or
inline code, or on the line after a paragraph, list, quote or table:

```markdown
## Method {.ruled}

- Term one
- Term two
{.two-columns}
```

Then `.paged-doc .ruled` and `.paged-doc .two-columns` style just those
parts. See [Markdown syntax](/docs/writing/markdown-reference) for the
attribute syntax.

### The cover page

When the cover page is on, its parts have their own classes. The cover
always spans the full page, also in multi-column themes.

| Selector | What it styles |
|---|---|
| `.paged-doc .markoto-cover` | The whole cover page. |
| `.paged-doc .markoto-cover-logo` | The logo. |
| `.paged-doc .markoto-cover-title` | The title. |
| `.paged-doc .markoto-cover-subtitle` | The subtitle. |
| `.paged-doc .markoto-cover-meta` | The block with authors and date. |
| `.paged-doc .markoto-cover-author` | One author line. |
| `.paged-doc .markoto-cover-date` | The date. |
| `.paged-doc .markoto-title-block` | The title block on page 1 (layout *Title block*), instead of a cover page. |
| `.paged-doc .markoto-cover-authors` | The row of authors in the title block; each is a `.markoto-cover-author-card` with `.markoto-cover-author` and `.markoto-cover-affiliation`. |
| `.paged-doc .markoto-abstract` | The abstract in the title block; its heading is `.markoto-abstract-title`. |

### Theme colors

The theme's colors are available as CSS variables. Use them instead of
fixed colors, and your rules follow the theme when you change it:

| Variable | Color |
|---|---|
| `--doc-brand` | Brand (accent) color |
| `--doc-secondary` | Muted color for hairlines, captions and borders |
| `--doc-text` | Body text |
| `--doc-bg` | Paper |
| `--doc-heading-color` | Headings |
| `--doc-accent` | Same as `--doc-brand` |

The fonts are variables too, so a rule can follow the fonts you pick:

| Variable | Font |
|---|---|
| `--doc-body-font` | Body text |
| `--doc-heading-font` | Headings |
| `--doc-meta-font` | Header, footer and captions |
| `--doc-mono-font` | Code |

For example `border-bottom: 2px solid var(--doc-brand)` or
`font-family: var(--doc-heading-font)`.

### Document structure

markoto marks parts of the text so that CSS can find them, also after the
text has been split into pages:

| Selector | What it styles |
|---|---|
| `.paged-doc .markoto-first-section` | The first top-level heading of the text (not the first one on every page). |
| `.paged-doc .markoto-section-heading` | Every top-level heading (heading 1, or heading 2 if the text has no heading 1). |
| `.paged-doc .markoto-references` | The lists and paragraphs of the *References* section; its heading is `.markoto-references-heading`. |
| `.paged-doc table > caption` | A table caption (`Table: …`). |
| `.paged-doc p.markoto-labelled` | A paragraph that opens with a bold label: `**Note.** …`, `**Pricing:** …`. An alert whose first paragraph is one is `.markoto-alert-labelled`. |
| `.paged-doc .markoto-endpoint` | A line holding only `POST /payments` (a paragraph or an `http` code block); the method is `.markoto-http-method`, the path `.markoto-http-path`. |
| `.paged-doc p.markoto-lead` | The paragraph right under the cover or title block. |
| `.paged-doc .markoto-opening` | The first few words of that paragraph and of the first paragraph after every top-level heading, for small-capital openings. |

`h1:first-of-type` does not work for "the first heading": every page
starts its own copy of the document, so it matches the first heading on
each page.

### Pages, headers and footers

Pages are styled with `@page`:

| Rule | What it styles |
|---|---|
| `@page` | Every page: size, margins, and the margin boxes. |
| `@page :first` | The first page. `:left` and `:right` work for facing pages. |
| `@page cover-page` | The cover page sheet. |
| `@top-center` | One of six header and footer boxes inside `@page`: `@top-left`, `@top-center`, `@top-right`, `@bottom-left`, `@bottom-center`, `@bottom-right`. Fill one with `content:`, e.g. `counter(page)`, `counter(pages)` or text in quotes. |

## Examples

Each example works on its own. Paste it into the Custom CSS section and
change the values.

A colored line under every second-level heading:

```css
.paged-doc h2 {
  padding-bottom: 0.2em;
  border-bottom: 2px solid var(--doc-brand);
}
```

Zebra stripes in one table (put `{.striped}` on the line after the table):

```css
.paged-doc table.striped tbody tr:nth-child(even) {
  background: color-mix(in srgb, var(--doc-secondary) 12%, transparent);
}
```

A quieter look for notes, with the title in small capitals:

```css
.paged-doc .markdown-alert-note {
  border-left: 3px solid var(--doc-brand);
  background: color-mix(in srgb, var(--doc-brand) 6%, transparent);
  border-radius: 0;
}
.paged-doc .markdown-alert-note .markdown-alert-title {
  font-variant: small-caps;
  letter-spacing: 0.04em;
}
```

A two-column section (put `{.two-columns}` on the line after a list or
quote):

```css
.paged-doc .two-columns {
  column-count: 2;
  column-gap: 8mm;
}
.paged-doc blockquote.two-columns {
  border: none;
  padding: 0;
  font-style: normal;
}
```

Page number and page count in the footer:

```css
@page {
  @bottom-center {
    content: counter(page) " / " counter(pages);
  }
}
```

No header or footer on the first page:

```css
@page :first {
  @top-center { content: none; }
  @bottom-center { content: none; }
}
```

A cover title in capitals with wide spacing:

```css
.paged-doc .markoto-cover-title {
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
```

Rules that only apply to the PDF and printing:

```css
@media print {
  .paged-doc a {
    color: var(--doc-text);
    text-decoration: none;
  }
}
```

The Custom CSS section in the Theme tab has some of these ready to insert.

## What you can write

- Ordinary style rules, with any selector inside `.paged-doc`.
- `@media`, `@supports`, `@page` (with its margin boxes), `@keyframes`,
  `@container`, `@layer` and `@font-feature-values`.

## What isn't allowed, and why

Your CSS also runs for everyone who opens or exports the document, so
some things are turned off:

- **Loading from other websites.** `url()` can only use images uploaded to
  this document or `data:image/png`, `jpeg`, `gif` or `webp` URLs. To use
  an image, drop it into the document first, then copy its `/api/files/…`
  address into `url()`. Images from other documents don't carry over, and
  SVG data URLs aren't allowed. A CSS variable inside `url()` or
  `image-set()` isn't allowed either, since its value can't be checked.
- **`@import` and `@font-face`.** Pick fonts in the theme's font settings
  instead. `@namespace`, `@property` and `@counter-style` are refused too.
- **Script-like constructs** such as `expression()`, `behavior`,
  `-moz-binding` and `javascript:` URLs.
- **More than 64 KB** of CSS.

If a rule isn't allowed, the Custom CSS section lists it with its line and
column, and your changes aren't applied until it's fixed. The rules that
were already applied stay in place in the meantime.

## Themes, presets and copies

- Custom CSS is part of the theme. Saving the theme as a preset, or
  setting it as a workspace default, keeps the CSS with it.
- Applying a built-in preset keeps your custom CSS. A few presets bring
  CSS of their own (arXiv preprint: the table rules, figure captions and
  reference list of the LaTeX template). It goes in front of yours, so
  your rules still win, and switching to another preset takes it out
  again as long as you haven't edited it. Applying a saved theme
  replaces your CSS with the saved theme's CSS, and new documents in a
  workspace start with the workspace default's CSS.
- When you duplicate a document, image addresses in the CSS point at the
  copy's images.
- [Saving the document as Markdown](/docs/import-export/save-markdown)
  keeps the CSS in the file; importing the file brings it back.
- The markoto assistant can read and change your custom CSS too. Ask it
  for a look the theme settings can't make ("underline the section
  headings in our brand color") and it writes the CSS, following the same
  rules.

## What's next

- [Tune your typography and colors](/docs/themes/customize): try the theme settings first.
- [Save your custom theme as a preset](/docs/themes/save-preset): reuse your CSS in other documents.
