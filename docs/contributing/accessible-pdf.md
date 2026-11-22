# Accessible PDF

The server PDF (`GET /api/docs/:docId/pdf`, [preview pipeline](preview-pipeline.md#server-rendered-pdf)) is a tagged PDF. This page lists what that covers, how to check it against PDF/UA-1, and which PDF/UA rules it cannot meet and why.

## What the renderer does

| Piece | Where | Result in the PDF |
|---|---|---|
| `page.pdf({ tagged: true, outline: true })` | `renderer/src/render.ts` | Structure tree (`/StructTreeRoot`, `/MarkInfo /Marked true`) built by Chromium from the accessibility tree; bookmarks (`/Outlines`) from the headings |
| `<title>` from the document title, never empty (`pdfDocumentTitle`) | `app/pages/_internal/render/[docId].vue`, `shared/utils/documents/pdfMetadata.ts` | `/Title` in the Info dictionary; Chromium also writes `/ViewerPreferences /DisplayDocTitle true` |
| `<html lang>` from the document's `language` field (`documentLanguageTag`) | same | `/Lang` on the catalog |
| paged.js margin boxes `aria-hidden`, footnotes `role="note"` (`prepareForTaggedPdf`) | `app/utils/preview/pdfAccessibility.ts` | Running headers, footers and page numbers stay out of the structure tree; a footnote is no longer a list item without a list |

The `language` field is free text. `documentLanguageTag` keeps a BCP 47 tag (`de`, `de-CH`), maps language names in the UI languages and in the language itself (`Deutsch`, `français`, `Schwiizerdütsch`), treats an empty field as English (the schema default) and writes `und` (undetermined) for anything it cannot identify, rather than claiming English.

Chromium maps the HTML to structure types: `h1`-`h6` to `H1`-`H6`, lists to `L` / `LI` / `Lbl`, tables to `Table` / `TR` / `TH` / `TD`, images to `Figure` with the `alt` text as `/Alt`, links to `Link` with the link annotation, figure captions to `Caption`. Generic `div` / `span` become `NonStruct`.

The published web page (`mode=web` on the same print page) is not affected: it returns before pagination and the snapshot already carries its own language.

## Checking a PDF

```sh
bun run test:integration:up           # once, see testing.md
bash scripts/pdf-a11y-check.sh        # render tests/fixtures/pdf-a11y/fixture.md, validate
bash scripts/pdf-a11y-check.sh x.pdf  # validate any PDF
```

The script runs `tests/integration/endpoints/pdfAccessibility.test.ts` with `PDF_A11Y_OUT_DIR` set (the test keeps the PDFs it renders there), then [veraPDF](https://verapdf.org) 1.30.3 (`docker.io/verapdf/cli:v1.30.3`, Docker or Podman) with the PDF/UA-1 profile, and prints one line per failed rule. veraPDF's PDF/UA-1 profile implements the machine-checkable Matterhorn Protocol conditions, the same set PAC checks; the human checks (reading order makes sense, alt text is meaningful) stay manual.

The integration test is the regression guard: the PDF has `/StructTreeRoot`, `/MarkInfo /Marked true`, `/Lang`, `/Title`, `/DisplayDocTitle true`, `/Outlines`, the structure types of the fixture (headings, lists, table, figure, link) and the image's `/Alt`.

## Result (Chromium of Playwright 1.65.1, veraPDF 1.30.3)

The fixture passes 99 of 106 PDF/UA-1 rules. Passing, among others: tagged-PDF markers, document language, title and `DisplayDocTitle`, heading nesting, table structure (`TR` in `Table`, cells in rows), list items in lists (after the footnote fix), alt text on images that have one, fonts embedded with Unicode mappings.

Failing, and why:

| Rule (ISO 14289-1) | What | Why it can't pass today |
|---|---|---|
| 7.1-3 (about 30 checks) | Content neither tagged nor marked as `/Artifact` | Chromium writes no `/Artifact` marked content at all. Page backgrounds, table borders, cover decoration and the `aria-hidden` margin boxes are left untagged instead of being artifacts. Needs a Chromium change or post-processing of the content streams. |
| 7.1-5 | Non-standard structure type `Strong` without a role map | Chromium tags `<strong>` as `Strong` (a PDF 2.0 type) and writes no `/RoleMap` to a PDF 1.7 type. |
| 7.1-8 | No XMP metadata stream (and so no `pdfuaid:part` identification) | Chromium writes the Info dictionary only. Adding XMP would need a PDF post-processing step in the renderer (a PDF library rewriting the catalog). |
| 7.2-20 | `LI` holds `L` (nested list) or content directly instead of `Lbl` + `LBody` | Chromium emits `LI` > `Lbl` + content without an `LBody` wrapper. |
| 7.18.1-2, 7.18.5-2 | Link annotations without `/Contents` | Chromium links the annotation into the `Link` element but writes no `/Contents` alternate description. |
| 7.3-1 | `Figure` without alternative text | Only when an image has no alt text (`![](...)`), which the fixture includes on purpose. The editor's accessibility check (status bar) flags such images; with alt text the rule passes. |

So the PDF is a properly tagged, navigable PDF for screen readers (structure, reading order, language, title, bookmarks, alt text), but not formally PDF/UA-1 conformant. The remaining failures are all in Chromium's PDF writer; closing them means a post-processing step (XMP, role map, `/Contents`, artifact marking), which is not worth its complexity until a customer needs certified PDF/UA.

## Editor check

`app/utils/editor/accessibilityCheck.ts` scans the Markdown for images without alt text, links without text and skipped heading levels (fenced code, inline code and comments are ignored). `app/components/editor/layout/A11yStatus.vue` shows the count in the status bar for editors; the popover lists the issues and a click jumps to the line. Strings live under `a11yCheck` in `i18n/locales/`.
