# Preview and PDF pipeline

How Markdown becomes paged preview, browser print and server-rendered PDF. Agent rules for this area are in [`app/utils/AGENTS.md`](../../app/utils/AGENTS.md). Building a design (theme preset): [TEMPLATE-WORKFLOW.md](TEMPLATE-WORKFLOW.md).

## Three consumers, one pipeline

| Consumer | Host | Entry |
|---|---|---|
| Live preview | Sandboxed srcdoc iframe in the editor | `app/composables/preview/usePagedPreview.ts` |
| Browser print (`Cmd/Ctrl+P`, fallback) | Hidden sandboxed iframe + `window.print()` | `app/utils/preview/printPdf.ts` |
| Server PDF / PNG | Renderer sidecar (Playwright) loading an app page | `app/pages/_internal/render/[docId].vue` |

All three run the same steps:

1. **Markdown → HTML.** `app/utils/markdown/renderMarkdown.ts` holds one markdown-it instance (plugins imported lazily on first use, `html: false`) and sanitises the result with `app/utils/markdown/sanitizeHtml.ts` (DOMPurify with tag / attribute / URI allowlists; inline `style` values go through a property allowlist, `filterInlineStyle`). Code fences always get `language-<lang>` so Mermaid blocks are found as `pre code.language-mermaid`.
2. **Footnotes.** `transformFootnotesForPagedMedia` moves markdown-it-footnote's end-of-document list to inline `<span class="footnote">` at each reference, which paged.js needs for `float: footnote`.
3. **Compose.** `app/utils/preview/composeFinalHtml.ts` assembles cover + body (+ drop cap, structure markers) and **sanitises the composed result again**: the cover is built from theme values, and a theme can arrive over Y.js without passing the HTTP validation. DOM work (drop cap, markers) runs on parsed DOM, never on regexes over the HTML string.
4. **Theme → CSS.** `shared/utils/theme/themeToCss.ts` (composed from one module per CSS concern in `shared/themeCss/`; output pinned per preset and option by `tests/unit/theme/themeToCssGolden.test.ts`) compiles a `DocTheme` (`shared/types/theme.ts`) into the whole stylesheet: `@page` and margin boxes, body, headings, TOC page numbers (`target-counter`), code, tables, KaTeX, Mermaid, custom CSS last.
5. **Paginate.** paged.js (vendored) lays the document out into pages; `app/utils/preview/pagedHandlers.ts` adjusts the breaks (below).

At render time every consumer also checks the theme: `isValidTheme` (an invalid theme renders as `defaultTheme`) and `themeImagesForDoc(theme, docId)` (`shared/utils/theme/themeImages.ts`), which blanks image URLs that are not a bundled `/markoto-logos/*` asset or an upload of this document.

### Server-rendered PDF

`GET /api/docs/:docId/pdf` (`server/api/docs/[docId]/pdf.get.ts`) calls the renderer sidecar through `server/utils/rendering/renderClient.ts`. The renderer opens `app/pages/_internal/render/[docId].vue`, which gets its data from `server/api/_internal/render-bootstrap.get.ts`: the document is replayed from Y.js, and theme, title and context come from the replayed `ymeta` first and the `documents` row only as fallback (`resolveDocProperties`, `server/utils/documents/docProperties.ts`) — only the owner's editor writes properties to the row, so an anonymous document's theme exists only in Y.js. The page never connects to the sync server. If the renderer is down the request fails; there is deliberately no silent fallback to the browser path, because the two outputs differ.

The server path exists because AI tools (`view_pages`) and PDF downloads need one deterministic render, independent of the viewer's fonts, zoom and browser.

## Preview isolation

The preview and print iframes are sandboxed `allow-scripts` (print adds `allow-modals`) **without `allow-same-origin`** (`PREVIEW_SANDBOX` / `PRINT_SANDBOX` in `app/utils/preview/previewFrame.ts`). They run in an opaque origin, so script in rendered content cannot reach the app's cookies, storage, DOM or same-origin APIs.

- **Bootstrap.** The iframe document is `app/composables/preview/pagedPreviewIframe.html`, imported as a raw string; `buildPreviewSrcdoc` fills in the CSP nonce, the parent origin, the initial colour mode and the vendored asset URLs + SRI hashes, and inlines the pagination handlers and the zoom engine as strings (`__PAGED_HANDLERS_SCRIPT__`, `__PREVIEW_ZOOM_SCRIPT__`).
- **Messages only.** Parent → iframe: `render`, `color-mode`, `zoom`. Iframe → parent: `iframe-ready`, `paginated`, `iframe-error`, `print-shortcut`, `print-done`, `zoom-state`, `zoom-request`, `zoom-gesture`. The parent accepts only messages from the iframe's window with origin `'null'` and a valid shape (`parseFrameMessage`); the iframe accepts only the parent window and origin and posts only to it.
- **Links** inside the iframe never navigate it: fragment links scroll, everything else is inert.
- **Images.** Requests from the opaque origin carry no session cookie. Exact own-upload URLs (`/api/files/<thisDoc>/<fileId>`) get `?token=<file-access JWT>`, minted by `GET /api/docs/:docId/file-token` (same access check as `/api/files`, 15 min, cached by `createFileTokenSource`). Only `/api/files` and the brand-kit route `/api/docs/:docId/brand/:file` accept that token. The server render page does the same for the document's confirmed uploads only (`app/utils/preview/renderFileTokens.ts`) — never for links, other documents' files or URLs that merely contain the path.
- **Headers.** `/api/files`, `/vendor/*`, the bundled logos and the brand-kit route answer with `Cross-Origin-Resource-Policy: cross-origin` (`crossOriginResourcePolicyFor` in `server/utils/rendering/csp.ts`; published-page files `same-origin`, everything else `same-site`); `/vendor/*` also sends `Access-Control-Allow-Origin: *` (`server/utils/rendering/vendorAssetHeaders.ts`).
- **CSP.** The srcdoc inherits the page's CSP: inline scripts carry the page nonce (`currentCspNonce()`), there are no inline event handlers, and `'self'` still means the app origin, which is how `/vendor/` assets load.

`scripts/measure-preview-perf.ts` measures keystroke-to-repaint against the flow test stack.

## Preview zoom

Fit width (default), fixed steps, free pinch / Ctrl+wheel zoom, and an "All pages" overview. Three layers: `app/utils/preview/previewZoom.ts` (pure state, steps, shortcuts, the `markoto:preview-zoom` localStorage key), `app/composables/preview/usePreviewZoom.ts` (shared state for the pane control `app/components/preview/ZoomControl.vue`, the mobile bar and the View menu) and `app/utils/preview/previewZoomFrame.ts` (the engine inside the iframe, inlined as a string; `tests/dom/previewZoomFrame.test.ts` evaluates it). The engine only sets CSS `zoom` and classes; it never re-paginates. Print resets zoom; the server renderer doesn't use this bootstrap.

## Vendored third-party assets

paged.js, KaTeX (stylesheet + fonts), highlight.js themes, Mermaid and all web fonts are served from the app's own origin under `/vendor/`, never from a CDN, so visitors and the renderer make no third-party request and air-gapped self-hosts still render.

- `modules/vendor-assets.ts` copies them from the pinned npm packages on every `nuxt dev` / `build` / `prepare` (logic in `scripts/lib/vendorAssets.ts`, output in `node_modules/.cache/markoto-vendor-assets`, served as a Nitro public-asset directory). Paths are versioned (`/vendor/<pkg>@<version>/…`) and served `immutable`; the per-family font stylesheets `/vendor/fonts/<slug>.css` are unversioned and `no-cache`.
- Version, URL and SRI hash live in `shared/utils/vendor/{pagedjs,katex,hljs,mermaid}Assets.ts`. The build fails when an installed package's version or bytes differ from them; `tests/unit/rendering/vendorAssets.test.ts` checks the same.
- **Bumping a vendored package:** change `package.json` and the `*_VERSION` constant, then recompute the hash with `openssl dgst -sha384 -binary node_modules/<pkg>/<file> | openssl base64 -A`.
- Mermaid is the single-file IIFE build (`mermaid.min.js`): the ESM build loads lazy chunks that can't be SRI-checked.
- Every SRI tag keeps `crossorigin="anonymous"` (SRI only applies in CORS mode).
- The service worker does not precache `/vendor/**`; it caches it at runtime (`nuxt.config.ts`).

## Fonts

`shared/utils/theme/themeFonts.ts` is the registry: Fontsource families (exact-pinned packages) plus bundled families in `fonts/<slug>/` (TeX Gyre Termes / Heros, Latin Modern Roman / Mono, GUST Font License, built by `scripts/build-bundled-fonts.py`). `themeFontsImport(theme)` emits one `@import url('/vendor/fonts/<slug>.css')` per family a theme uses.

- **Documents use static font cuts only.** Chromium embeds variable fonts (and CFF outlines) in PDFs as Type 3 glyphs. The app shell's variable Inter / JetBrains Mono / Fraunces are registered under their own family names (`uiFontFamilyName`, e.g. `'Inter Variable'`) so they never take part in document font matching. `tests/integration/endpoints/docPdf.test.ts` checks that no built-in preset embeds a Type 3 font.
- Headless Chromium runs with `--font-render-hinting=none` (renderer and `scripts/render-theme-shots.ts`); hinted advances misplace letters in the PDF.
- Adding a Fontsource family: install the package with an exact version and add a `font(...)` line. Adding a bundled family: files + licence in `fonts/<slug>/` and a `font(..., bundled(...))` line; a changed subset needs a new version suffix because files are served `immutable`.

## Themes

Per-document theme JSON is stored in `documents.theme` and mirrored to `ymeta.theme`; it is validated by `shared/utils/theme/themeValidation.ts`. Presets: `shared/utils/theme/themePresets.ts`. Editor panel: `app/components/document/ThemeEditorPanel.vue` (saved themes, presets, design import) with one component per section in `app/components/document/theme/`, each bound to the panel's draft through `v-model:theme`. Page sizes: `shared/utils/theme/pageDimensions.ts`.

- **Optional fields.** Many theme fields are `.optional()` so stored themes stay valid without a migration. Every reader resolves them through `shared/utils/theme/themeOptions.ts`; presets and `defaultTheme` spell them out (`tests/unit/theme/themeFoundation.test.ts`). The panel binds them with defaults so opening it never rewrites a stored theme.
- **Heading scale.** `headings.scale` is the ratio between neighbouring levels from h4 up: h4 = body, h1 = body × scale³ (`HEADING_SCALE_EXPONENTS`). Display sizes belong to the cover. `headings.levels` overrides size / weight / style per level.
- **Heading numbers** use CSS counters on h1–h4 and the TOC; `app/utils/preview/headingStructure.ts` marks section headings and numbering bases, `.unnumbered` / `{-}` headings are skipped (`app/utils/markdown/markdownUnnumbered.ts`).
- **Title block** (`cover.layout: 'title-block'`): `app/utils/preview/coverHtml.ts` + `app/utils/preview/titleBlock.ts`. The document's leading section headed "Abstract" (or its translation) is moved into the title block; a leading `# Title` equal to the document title is dropped.
- **Document language** drives in-document text (dates, TOC title, caption labels, number formats) through `documentTexts` (`shared/utils/documents/documentLocale.ts`), never the viewer's UI locale.
- **Structure markers for template CSS** (so presets don't need `:has()` or sibling selectors, which paged.js rewrites): `app/utils/markdown/markdownMarkers.ts`, `app/utils/preview/documentMarkers.ts`, `app/utils/markdown/references.ts`, `app/utils/markdown/tableCaptions.ts`, `app/utils/markdown/captionNumbers.ts`.
- **Mermaid** config comes from `buildMermaidConfig(theme)` (`shared/utils/markdown/mermaidConfig.ts`): the body font, label sizes, chart widths fitted to the text column, and the document palette (`shared/utils/theme/themeColors.ts`). Diagrams are laid out as `<img>` (paged.js would split an inline SVG) and swapped for the inline SVG after pagination; the body font is loaded before Mermaid measures labels.

### Custom CSS

`theme.customCss` (≤ 64 KB, documents only) goes through one sanitizer, `shared/utils/theme/customCss.ts` (css-tree), at write time (`PUT /meta`, saved themes, workspace default, AI / MCP `update_theme` → 400 `theme/custom-css-invalid` with line and column) **and** at render time in all three consumers, because `ymeta.theme` is writable over Y.js. `themeToCss` appends the sanitizer's output, never the raw string. The sanitizer allow-lists at-rules, refuses script-like values, allows `url()` only to this document's uploads or base64 raster `data:image`, fails closed on parse errors or deep nesting, and escapes every `<` in its output. Browser code loads it lazily (`app/utils/preview/customCssLoader.ts`). Applying a saved theme to another document drops rules pointing at the old document's files (`adaptCustomCssToDoc`).

## Pagination handlers

`app/utils/preview/pagedHandlers.ts` is a paged.js handler registered once per window. It keeps headings and lead-ins with the next block, splits or moves code blocks, tables and lists with minimum line / row counts on each side, avoids widows and orphans, shrinks a diagram (down to 75 %) before moving it, spans wide content across columns in multi-column themes, repeats table headers on continued pages, and fixes paged.js's footnote handling on multi-column pages. Display math wraps before relations and shrinks no further than `MIN_MATH_SCALE`.

One part per concern lives in `app/utils/preview/paged/`, each a factory that gets the parts it builds on as arguments:

| Part | Concern |
|---|---|
| `blockQueries.ts` | what a block is, what comes before it, the shared minimums |
| `lineGeometry.ts` | line boxes on the page vs. in the overflow column, widow fix, heading-near-break |
| `tableCodeRules.ts` | table row splits (incl. totals blocks), code-line splits |
| `breakRules.ts` | `adjustedBreak`: unbreakable blocks → tables / code → lists → orphans / widows → keep-with-next |
| `columnRules.ts` | multi-column pages: spanning wide blocks, forced column breaks |
| `keptBlocks.ts` | splitting a short kept block instead of a gap, shrinking diagrams |
| `displayMath.ts` | breaking display math before relations, hanging indent, shrinking |
| `pageMarks.ts` | the unpaginated source, repeated table headers, page-edge marks |
| `boxlessRects.ts` | hidden nodes no longer count as overflow |
| `pagedFixes.ts` | paged.js fixes: selector specificity, multi-column footnotes |
| `paginationHandler.ts` | the handler class: one method per paged.js hook, each guarded |

`runPagedHandlers` in `pagedHandlers.ts` wires them in a fixed order (the hidden-node fix before the handler registers, paged.js's own handlers patched after). The parts are delivered into the iframe via `toString()` as one nonce'd inline script (`PAGED_HANDLERS_SCRIPT`: the runner applied to the stringified parts), so every part must stay self-contained (no imports except types, no module references, no references to another part by name). The server render page calls `registerPagedHandlers`, which passes the same functions directly. `tests/dom/pagedHandlers.test.ts` evaluates the string and checks the direct path.

## Markdown comments

`<!-- … -->` is stripped from preview, PDF and shared views but stays in the source. Two custom rules in `renderMarkdown.ts` (`commentPlugin`) do it: a block rule for lines that contain only a comment, an inline rule for comments inside a paragraph. The pagebreak rule (`<!-- pagebreak -->`) is registered first and wins. Templates use comments as per-section writing hints, and `server/utils/agentic/markdownReference.ts` tells the AI about them. `scripts/audit-markdown-pipeline.mjs` runs the full pipeline over syntax cases; run it before documenting new syntax in `markdownReference.ts`.

## Reviewing output

- `make theme-shots` (`scripts/render-theme-shots.ts`) renders Markdown fixtures from `tests/fixtures/theme-shots/` per preset through the real preview into per-page PNGs; it needs a running app with `NUXT_ANON_GATE_ENABLED=false`.
- `scripts/compare-template-reference.sh` compares a render with a reference rendering ([TEMPLATE-WORKFLOW.md](TEMPLATE-WORKFLOW.md)).

## Tests

| Concern | File |
|---|---|
| Iframe bootstrap contract (nonce on every inline script, no inline handlers, origin-checked messaging) | `tests/unit/rendering/pagedPreviewIframe.test.ts` |
| Sandbox / message handling | `tests/nuxt/previewFrame.test.ts`, `tests/e2e/flows/preview-isolation.spec.ts` |
| XSS and KaTeX output vs. sanitiser | `tests/dom/renderMarkdownXss.test.ts` |
| Heading ids, code rendering | `tests/dom/renderMarkdownHeadingsCode.test.ts` |
| Generated CSS | `tests/unit/theme/themeToCss.test.ts`, `tests/unit/theme/themeFoundation.test.ts`, `tests/unit/theme/themePresetCss.test.ts` |
| Vendored assets | `tests/unit/rendering/vendorAssets.test.ts` |
| Real renderer output | `tests/integration/endpoints/docPdf.test.ts` |
