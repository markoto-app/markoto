# app/utils

Client utilities, grouped by domain (`markdown/`, `preview/`, `editor/`, `collab/`, `comments/`, `marketing/`, `platform/`, `billing/`, `workspace/`). How the preview, print and server PDF pipeline works: [`docs/contributing/preview-pipeline.md`](../../docs/contributing/preview-pipeline.md).

## Preview isolation (security)

- **Never give the preview or print iframe `allow-same-origin`**, and never read `iframe.contentDocument` or call into `contentWindow` from the app or tests (Playwright: `frameLocator('iframe')` / `EditorPage.previewRoot()`). Talk to it only through the typed messages in `app/utils/preview/previewFrame.ts`, and keep both origin checks. Pinned by `tests/nuxt/previewFrame.test.ts` + `tests/e2e/flows/preview-isolation.spec.ts`.
- **The iframe bootstrap lives in `app/composables/preview/pagedPreviewIframe.html`** (imported `?raw`), not a template literal. Every inline script carries the `__CSP_NONCE__` nonce; no inline `on*=` handlers; no `parent.document`. Pinned by `tests/unit/rendering/pagedPreviewIframe.test.ts`.
- **Sanitise twice.** `renderMarkdown` output is sanitised, and `composeFinalHtml` sanitises the composed HTML again (the cover comes from theme values that can arrive over Y.js unvalidated). DOM rewrites work on parsed DOM, never regexes over HTML.
- **Validate the theme at render time in all three consumers** (`isValidTheme`, `themeImagesForDoc`, `sanitizeCustomCssForRender`). `ymeta.theme` is writable over Y.js, so write-time validation is not enough.
- **`themeToCss` never reads `theme.customCss`.** It only appends the sanitizer's result (`runtime.customCss`).
- **File-access tokens go only on exact own-upload URLs** (`/api/files/<thisDoc>/<fileId>`, and on the render page only for the doc's confirmed uploads, `renderFileTokens.ts`). Never on links, text, other docs' files or URLs that merely contain the path.
- **Keep `html: false` in markdown-it.** Comments are stripped by custom block + inline rules (`commentPlugin`), not by enabling HTML and letting DOMPurify strip them. Custom rules that `state.push('html_block')` render verbatim, so emit only controlled HTML that way.
- **Inline `style` values are allow-listed** (`ALLOWED_STYLE_PROPERTIES` in `app/utils/markdown/sanitizeHtml.ts`). If KaTeX starts emitting a new property, add it there; `tests/dom/renderMarkdownXss.test.ts` compares against raw KaTeX. SVG is allowed only as KaTeX emits it.

## Vendored assets

- **No CDN, no new third-party origin.** Browser assets for preview/print/render are copied from pinned npm packages to `/vendor/` (`modules/vendor-assets.ts`). A new asset is vendored there, never allowed as a new CSP or renderer origin.
- **Bumping one:** change `package.json` and the `*_VERSION` + `*_SRI` constants in `shared/utils/vendor/*Assets.ts`; the build refuses mismatches. Keep `crossorigin="anonymous"` on every SRI tag.
- **Documents use static font cuts only** (variable fonts become Type 3 in Chromium PDFs). Never register the app shell's variable fonts under a theme family name. A changed bundled-font subset needs a new version suffix (files are `immutable`).

## paged.js and the pagination handlers

- **Never put a comma inside `:is()` / `:not()` / `:has()` in generated CSS.** paged.js splits selector lists at every comma and the render fails. `tests/unit/theme/themeFoundation.test.ts` checks all generated CSS.
- **Template CSS should target marker classes, not `:has()` or sibling selectors**, which paged.js rewrites.
- **`pagedHandlers.ts` and `previewZoomFrame.ts` are shipped as `toString()` strings into the iframe.** Keep them self-contained: no imports, no module-level references. `tests/dom/pagedHandlers.test.ts` / `tests/dom/previewZoomFrame.test.ts` evaluate the strings.
- paged.js Polisher only processes `@page` rules passed in its `stylesheets` argument. Margin boxes are siblings of `.paged-doc`, so custom properties set on it don't reach them; bake values into the CSS string.
- **Column-spanning cover / spanners only when `layout.columns > 1`.** In single-column themes a spanning element makes paged.js drop everything after it. Pinned by `tests/unit/theme/themeToCss.test.ts` + `tests/integration/endpoints/docPdf.test.ts`.
- **Use CSS `zoom`, not `transform: scale`,** to shrink pages or diagrams: `scale` leaves the layout box full size.
- User CSS that targets `.mermaid img` only applies during layout (diagrams are swapped to inline SVG after pagination); target `.mermaid > svg` too.

## markdown-it

- **Register `markdown-it-anchor` before `markdown-it-toc-done-right`** and share one slugify (`defaultSlugify` → `clobberSafeId`, which suffixes ids DOMPurify would drop as DOM-clobbering, like `method` or `title`).
- **`markdown-it-emoji`** needs `.full` (the `unwrap` helper handles it).
- **`@mdit/plugin-img-size` does not parse `=WIDTHxHEIGHT` here.** Image sizes use attrs syntax: `![alt](url){width=50%}`.
- Keep Mermaid labels `htmlLabels: false` (plain SVG text): `<foreignObject>` doesn't survive the sanitiser or inlining.
- Before documenting new syntax in `server/utils/agentic/markdownReference.ts`, run `scripts/audit-markdown-pipeline.mjs` to confirm it renders.

## Editor utilities

- `app/utils/editor/keyboardShortcuts.ts` feeds Help → Keyboard shortcuts; editor rows are looked up by command in the keymaps `EditorPane.vue` installs. **Add a row when you add a binding** (`tests/unit/editor/keyboardShortcuts.test.ts`).
- `app/utils/collab/activityFeedHelpers.ts#safeLinkUrl`: only http(s) or relative URLs from activity metadata may become an `href` / `src`.
- `app/utils/comments/commentAnchors.ts` encodes `Y.RelativePosition` with `btoa` (browser); server code uses `Buffer`.
- Markdown export / import round-trips markoto frontmatter (`shared/utils/markdown/markdownFrontmatter.ts`, `server/utils/documents/markdownImport.ts`). Import keeps foreign frontmatter as body text and validates every imported field; don't loosen that.
