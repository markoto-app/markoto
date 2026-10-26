---
title: Add your own CSS
description: When the theme settings don't go far enough, write CSS rules for your document. They apply to the preview, printing and the PDF.
category: themes
order: 5
---

# Add your own CSS

The theme settings cover fonts, colors, page geometry, headers and
footers. When you need something they don't offer, such as a page number
that says "3 / 12", a ruled first-level heading or shaded quotes, add your
own CSS rules to the document.

Open the **Theme** tab and expand **Custom CSS** at the bottom. Type your
rules, and the preview updates after a short pause. Your rules come after
the theme settings, so they win when both style the same thing.

Custom CSS styles the document only: the live preview, printing
(`Cmd/Ctrl+P`) and the PDF export. The editor and the rest of markoto stay
as they are.

## Examples

Page number and page count in the footer:

```css
@page {
  @bottom-center {
    content: counter(page) " / " counter(pages);
  }
}
```

Larger first-level headings with a rule underneath:

```css
.paged-doc h1 {
  font-size: 2.4em;
  letter-spacing: -0.02em;
  border-bottom: 1px solid currentColor;
}
```

No header or footer on the first page:

```css
@page :first {
  @top-center { content: none; }
  @bottom-center { content: none; }
}
```

The section in the Theme tab has these examples ready to insert.

## What you can write

- The document text sits inside `.paged-doc`. Headings, paragraphs,
  tables, quotes, code blocks and images inside it are ordinary HTML
  elements (`h1`, `p`, `table`, `blockquote`, `pre`, `img`).
- Pages are styled with `@page`, including `:first`, `:left` and `:right`
  and the margin boxes `@top-left` to `@bottom-right`.
- `@media`, `@supports`, `@keyframes`, `@container` and `@layer` work as
  usual. Use `@media print` for rules that should only apply to the PDF.

## What isn't allowed, and why

Your CSS also runs for everyone who opens or exports the document, so
some things are turned off:

- **Loading from other websites.** `url()` can only use images uploaded to
  this document or `data:image/png`, `jpeg`, `gif` or `webp` URLs. To use
  an image, drop it into the document first, then copy its `/api/files/…`
  address into `url()`. Images from other documents don't carry over, and
  SVG data URLs aren't allowed.
- **`@import` and `@font-face`.** Pick fonts in the theme's font settings
  instead.
- **Script-like constructs** such as `expression()`, `behavior`,
  `-moz-binding` and `javascript:` URLs.
- **More than 64 KB** of CSS.

If a rule isn't allowed, the Custom CSS section lists it with its line and
column, and your changes aren't applied until it's fixed. The rules that
were already applied stay in place in the meantime.

## Themes, presets and copies

- Custom CSS is part of the theme. Saving the theme as a preset, or
  setting it as a workspace default, keeps the CSS with it.
- Applying a built-in preset keeps your custom CSS. Applying a saved
  theme replaces it with the saved theme's CSS, and new documents in a
  workspace start with the workspace default's CSS.
- When you duplicate a document, image addresses in the CSS point at the
  copy's images.
- The markoto assistant can read and change your custom CSS too. The same
  rules apply to it.

## What's next

- [Tune your typography and colors](/docs/themes/customize) — try the theme settings first.
- [Save your custom theme as a preset](/docs/themes/save-preset) — reuse your CSS in other documents.
