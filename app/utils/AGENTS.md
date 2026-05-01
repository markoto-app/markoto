# app/utils

Client-side utilities for the editor pane and preview pipeline.

## Preview Rendering & PDF Export

Right pane shows discrete A4/Letter pages inside a same-origin srcdoc iframe. PDF has TWO paths: client-side (the historical one — same pipeline in a hidden iframe + `window.print()`) and **server-side via the renderer sidecar** (Phase 5). Both share the same theme-CSS + markdown pipeline; only the host shell differs.

**Shared pipeline (`renderMarkdown.ts` → `shared/utils/themeToCss.ts` → `app/composables/usePagedPreview.ts` for client / `app/pages/_internal/render/[docId].vue` for server):**
1. `renderMarkdown.ts` — singleton markdown-it + DOMPurify. Plugins lazy-imported inside `init()`. Pipeline: core + task-lists + emoji + footnote + Batches 1–3 + custom pagebreak rule + comment plugin. Always emits `language-${lang}` class so the mermaid detector finds `pre code.language-mermaid`.
2. `transformFootnotesForPagedMedia(html)` lifts footnote `<li>` from end-of-doc `<section>` to inline `<span class="footnote">` at the ref site — required for paged.js `float: footnote`.
3. `shared/utils/themeToCss.ts` compiles `DocTheme` into the full stylesheet — `@page`, margin boxes, `.paged-doc` body, headings, TOC (with `target-counter` page numbers), page-break, column-span spanners.
4. `shared/utils/composeFinalHtml.ts` is the single point that assembles the final HTML document (paged.js bootstrap + theme CSS + markdown body + CDN script tags with SRI). Both the live preview iframe AND the server-rendered print page consume it.
5. **Live preview** — `app/composables/usePagedPreview.ts` mounts a persistent srcdoc iframe. Parent calls `iframe.contentWindow.__renderDoc(opts)` (250ms debounce). Iframe decodes images, pre-processes mermaid → SVG, then runs paged.js. Posts back `{type:'paginated', pageCount}`. Fragment links intercepted to prevent srcdoc iframe navigation.
6. **Client-side PDF** — `printPdf.ts` — hidden iframe, `window.PagedConfig = { auto: true, after: () => print() }`, 30s timeout. Mermaid pre-processed in parent context (different window = different module instance).
7. **Server-rendered PDF / PNG (Phase 5)** — `GET /api/docs/:docId/pdf` mints a single-use render token, calls the renderer sidecar (Playwright in a separate container), which navigates to `app/pages/_internal/render/[docId].vue?t=<token>`. That page SSRs via `server/api/_internal/render-bootstrap.get.ts`: replays Y.js to materialise the markdown body, runs the same pipeline above, returns headless-rendered PDF/PNG bytes. The page never connects to Hocuspocus — Y.Doc state is server-rendered. Failure mode: the API endpoint is the source of truth; if the renderer is down the request 503s and the UI surfaces the error (no fallback to client-side paged.js — they're not byte-identical and silently swapping is worse than a clear failure).

**Why the server path even with a perfectly good client path:** AI tools (`view_pages`, page-screenshot consumers) need a deterministic byte-stable render the model can ingest. A user's local fonts / display zoom / browser would otherwise produce different paged-media output per user. The renderer sidecar gives one canonical render per `(doc, theme, viewport)`.

**Why iframe:** paged.js mutates global head styles + `:root` vars and re-paginates on every call. Running on the host page caused unrecoverable layout contamination. Use CSS `zoom` (not `transform: scale`) for responsive shrinking — zoom shrinks layout box; scale doesn't.

**paged.js quirks:** Polisher only processes `@page` rules from `stylesheets` argument — pass `[{ 'theme.css': cssText }]`. Margin boxes are siblings of `.paged-doc`, not descendants; CSS custom properties don't propagate up. Bake `{title}`/`{date}` into the CSS string directly.

**CDN scripts ship with SRI hashes (Phase 1).** Paged.js, KaTeX, hljs, and Mermaid all load from jsDelivr; their pinned URL + Subresource Integrity hash live in `shared/utils/{pagedjsCdn,katexCdn,hljsCdn,mermaidCdn}.ts` as `*_URL` + `*_SRI` exports. Both must update together when bumping a CDN dep — to recompute: `curl -sSL <NEW_URL> | openssl dgst -sha384 -binary | openssl base64 -A`. The version constant + URL + SRI in each file is the bump checklist; a wrong SRI causes the browser to refuse the script (the iframe stays blank — symptom is "preview won't render" with a CSP-style console error). Workbox runtime-caches `cdn.jsdelivr.net/*` for 30 days, so a poisoned response would persist; SRI is the only defense.

**Theme system (`shared/types/theme.ts:DocTheme`):** Per-doc JSONB in `documents.theme`, mirrored to `ymeta.theme`. Validated by `shared/utils/themeValidation.ts`. Editor panel: `ThemeEditorPanel.vue` (11 accordion sections). Presets in `shared/utils/themePresets.ts` (Modern, Academic Paper 2-col, Tech Report, Business Report, Novel, Newsletter). Font picker from `shared/utils/themeFonts.ts` (20 fonts). Header/footer tokens: `{title}`, `{date}`, `{page}`, `{pages}` — inserted at cursor via `data-slot`/`data-position`. User-saved themes shipped (CRUD via `/api/user/themes`).

---

## Markdown Comments

`<!-- ... -->` comments are stripped from the rendered preview/PDF/share view but stay in the markdown source. Two markdown-it rules in `renderMarkdown.ts:commentPlugin`:

- **Block rule** — a line (or multi-line range) whose only non-whitespace content is a comment is consumed entirely. Closes on the line containing `-->`; trailing real content on the close line aborts the match (lets the inline rule handle it).
- **Inline rule** — `<!-- ... -->` mid-paragraph is stripped in place; surrounding prose flows around the gap.

Pagebreak (`<!-- pagebreak -->`) wins by registration order — the pagebreak rule runs first and short-circuits its exact pattern.

**Toolbar + menu:** `toggleComment` in `editorCommands.ts` wraps the selection in `<!-- ... -->` (toggleWrap-style: empty → drops `<!-- | -->` cursor inside; selection → wraps + re-selects inner; pre-wrapped → unwraps). Surfaced as `i-lucide-message-square-dashed` button in `EditorToolbar.vue` (after page-break + TOC) and as an "Comment (hidden from preview)" item in the `EditorMenuBar.vue` Insert menu.

**AI vocabulary:** `server/utils/agentic/markdownReference.ts` documents the syntax so the AI knows it can leave private notes for the writer. Templates use this heavily — every section in the recipe / business-plan / academic-paper / etc. templates has a `<!-- ... -->` brief telling the AI (or the user) what to write there.

**Audit script** (`scripts/audit-markdown-pipeline.mjs`) covers 11 cases including pagebreak precedence, multi-line blocks, mid-paragraph stripping, unterminated fallback (escapes to literal `&lt;!--`), code-fence preservation. Run before adding any syntax claim to `markdownReference.ts`.

---

## Other utilities here

- `editorCommands.ts` — toolbar + menu commands (toggleBold, toggleHeading, insertTable, toggleComment, etc.).
- `download.ts` — client-side `.md` download.
- `welcomeDoc.ts` — initial body when a doc is empty AND `initialBody` (template) is null.
- `dictationExtensions.ts` — CM6 ghost-text widget for live dictation. See `server/utils/agentic/AGENTS.md`.
- `editorSelection.ts` — `EditorSelectionSnapshot` builder for the AI's `<editor_state>` block.
- `commentAnchors.ts` — `Y.RelativePosition` ↔ base64 client-side (uses `btoa` — server side uses `Buffer`, see `server/utils/agentic/AGENTS.md`).
- `activityFeedHelpers.ts` — pure helpers extracted from `ActivityFeed.vue` for unit testability (`categoryOf`, `isExpandable`, `expansionToggleLabelKey`).
- `printPdf.ts` — see Preview Rendering above.
- `renderMarkdown.ts` — see Preview Rendering above.

## Gotchas

- **`markdown-it-emoji`** needs `.full`: `const emoji = (mod as any).full || (mod as any).default || mod`.
- **`highlight.js` CSS** must be dynamically imported inside `initMd()` — otherwise code blocks are all white.
- **Footnotes need `transformFootnotesForPagedMedia()`** — markdown-it-footnote puts all footnotes at end of doc; paged.js `float: footnote` needs inline `<span>` at the ref site.
- **Iframe bootstrap lives in `pagedPreviewIframe.html`, not a template literal** — imported as a raw string via `?raw`. URL placeholders (`__PAGEDJS_POLYFILL_URL__`, `__KATEX_CSS_URL__`, `__MERMAID_ESM_URL__`) substituted at mount.
- **Mermaid SVG overflow** — `overflow: visible` on `.mermaid svg` + `.mermaid foreignObject`, `white-space: nowrap` on inner elements. Use `htmlLabels: true` (foreignObject); `htmlLabels: false` undersizes SVG `<text>` nodes.
- **srcdoc fragment links navigate the iframe** — capture `<a href="#...">` clicks in iframe bootstrap; `preventDefault + target.scrollIntoView()`.
- **`html: false` doesn't block manually pushed tokens** — custom block rules that call `state.push('html_block')` render verbatim regardless. Use this for controlled HTML emission.
- **TOC: anchor plugin must load BEFORE toc plugin** — `markdown-it-anchor` assigns IDs; `markdown-it-toc-done-right` reads them. Share one `slugify`.
- **KaTeX inline `style`** — DOMPurify must allow `style` attribute; add `math`/`semantics`/`mrow`/etc. to the allowlist.
- **`@mdit/plugin-img-size` in our stack does NOT parse `=WIDTHxHEIGHT`** — despite the package's readme. Use `@mdit/plugin-attrs` syntax: `![alt](url){width=50%}`. The audit script catches mis-documented syntaxes.
- **CSS `zoom` not `transform: scale`** — `scale` leaves layout box full-size and overflows; `zoom` shrinks both.
- **Markdown comments via custom block + inline rules (NOT via `html: true` + DOMPurify-strip).** Flipping `html: false` → `html: true` to let DOMPurify strip `<!--...-->` would reopen XSS surface. Custom rules give us comment stripping without changing the html-escape gate.
