# Document Context, Templates, New-Doc Dialog

Every doc has four first-class context properties beyond title/theme: `description` (one-line, ≤500 chars), `audience` (closed enum of writing registers), `language` (free-form ISO code or user-typed name), `templateId` (which template — text + design bundle — was picked at creation). They live as NOT NULL columns on `documents` with sensible defaults so legacy/blank-dialog flows always have real values.

## Three surfaces

### 1. AI prompt context

`server/utils/agentic/documentContextPrompt.ts` builds a `<document_context>` block prepended to every AI system prompt — title, description (omitted if empty), language (resolved via `Intl.DisplayNames`), and the audience-specific tone fragment from `shared/audiences/index.ts`. See `server/utils/agentic/AGENTS.md`.

### 2. The Document tab in the editor (`DocumentEditorPanel.vue`)

Right-sidebar tab (next to Activity / Theme / Knowledge — toggled via `i-lucide-info`). Three fields with the same write semantics as theme: read-only blocks all inputs, owners get debounced DB persist via `PUT /api/docs/:id/meta`, all editable users broadcast via `ymeta.observe()`. Language uses Nuxt UI's `UInputMenu` with `create-item` so the 6 curated presets are filterable suggestions AND any free-text input ("Romansh", "Schwiizerdütsch") commits with one Enter — the typed item gets pinned to the top of the suggestion list.

### 3. The new-doc dialog (`NewDocumentDialog.vue`)

On `/` and in `MarketingStartButton` it is a `LazyDocumentNewDocumentDialog` mounted on the first click (`useNewDocDialog`; warmed on pointer over / focus) — it costs ~60 KB gzip and links every theme font, too much for the product and marketing pages. Keep it out of any page a logged-out visitor lands on.

Opens when the user clicks "+ New Document" on `/` or `/w/:id`. Only the **title** is in view (users felt overwhelmed by five questions at once); everything else sits in two collapsed rows (`UCollapsible`, one open at a time) that show the current choice as a summary (`newdoc-section-{template,details}`, summary `…-summary`):

- **Template** — ONE choice of text + design (`shared/templates/AGENTS.md`; the owner merged the former Content and Design rows). `DocumentTemplateGrid` (`TemplateGrid.vue`): `UTabs` (All / Engineering / Academic / Business / Writing / My designs, from `TemplateMeta.category`; `general` only under All; testid `template-tabs`) over a 3-col grid of `DocumentPictureCard`s (`PictureCard.vue`, shared with `ThemePresetGrid.vue`) with a picture of each template's first page — its text in its design (`public/template-thumbs/<id>.webp`, `templateThumbnailUrl`). Cards `newdoc-template-card-<id>`. **Blank** = an empty page in the user's default design: in a workspace with a default theme its card shows that design's swatch + "An empty page in your workspace's design, …" and the dialog sends no `themePreset` (the server applies the default); otherwise markoto (`themePreset: 'markoto'`). **Saved designs** come first as "Blank in <name>" cards (`newdoc-template-card-saved-<themeId>`, description `newdoc-template-card-saved-description-<themeId>`; also under My designs) → `templateId: 'blank'` + `themeId`. Every other template sends `templateId` + `themePreset: <its design>`. Default: **Demo** for the first document created in this browser, **Blank** afterwards (`markoto-created-first-doc` in localStorage, set on a successful create; logout clears localStorage, so the demo may show once more — harmless). `initialTemplateId` (marketing `::cta template`, aliases resolved) wins; `initialThemePreset` (`::cta theme`) puts another built-in design on THAT template until the user picks another card. Summary: the template name, plus "· <design>" for Blank and for a `::cta` override ("Blank · Corporate report").
- **Details** — description, language (defaults to UI locale if it's a preset), audience (USelect + per-option description). The language also picks the template text's locale.

One submit button, **Create document**. Collapsed rows unmount their content, so flows/tests must open a row before touching its cards or inputs (`EditorPage.openNewDocSection(id)` / `newDocDialog.section(id)`, `newDocDialog.summary(id)`).

**Pictures** are rendered, not drawn. Template pictures: `make template-thumbs URL=… [IDS=…]` (see `shared/templates/AGENTS.md`; `tests/unit/templateThumbnails.test.ts`). Design pictures (the editor's theme panel + the workspace default picker, `ThemePresetGrid.vue`): `make theme-thumbs URL=… [PRESETS=…]` (`scripts/render-theme-thumbs.ts`) renders each preset's showcase fixture (`tests/fixtures/theme-shots/thumbnails.json`) through render-theme-shots and records a hash of preset + fixture in `shared/utils/themeThumbnails.manifest.json`; `tests/unit/themeThumbnails.test.ts` fails when a preset has no fixture mapping, no picture, or changed since its picture. A new preset needs a `category`, a `thumbnails.json` entry, a render — and a template that uses it.

### 4. The anonymous gate (`AnonGateDialog.vue`)

Anonymous visitors on an instance with the gate (`useInstanceConfig().anonGate`) accept the Terms + age ≥16 once per browser before their first document. Every create path goes through `useAnonDocCreate().createDocument(body)` (`app/composables/useAnonGate.ts`): NewDocumentDialog and File → New. It opens the dialog (mounted by `CommonAppOverlays` the first time `useAnonTermsPrompt().ask()` runs; the prompt state lives in `app/composables/useAnonTermsPrompt.ts`) only when the server hasn't seen this browser accept the current terms, attaches a fresh ALTCHA payload (solved invisibly in `app/workers/altchaPbkdf2.worker.ts` while the dialog is open — `prepare()` warms it up when NewDocumentDialog opens) and retries once on an expired / used check. A cancelled dialog throws `AnonGateCancelled` (not an error toast). Testids: `anon-gate-dialog`, `anon-gate-accept`, `anon-gate-continue`; flows pass it with `EditorPage.clickCreateAndPassGate()`.

## Audience enum

Six registers in `shared/audiences/index.ts`: technical, marketing, academic, casual, business, creative. Each resolves to a tuned English tone fragment used in the AI system prompt. Audience is for DURABLE tone that survives every prompt without re-typing — free-form audience steering belongs in the user's prompt. Fragments are NOT user-editable AND NOT i18n'd (the AI is multilingual at OUTPUT — output language is driven by `language`, not the prompt's language). User-facing labels/descriptions ARE i18n'd via `audiences.<id>.label` / `.description`.

## Language

Free-form ISO code or user-typed name like "Schwiizerdütsch". 6 curated presets cover the common case + free-text input handles the long tail. The AI handles arbitrary language strings natively. Cap at 50 chars to bound prompt-token cost. `Intl.DisplayNames` resolves the SELF-language name (`de` → "Deutsch", not "German") for the AI prompt; free-text values pass through verbatim.

## Templates

See `shared/templates/AGENTS.md` for the registry/renderer split.

## Gotchas

- **NewDocumentDialog uses `data-testid` for every interactive element.** Each form input has `data-testid="newdoc-{field}-input"`, each template card has `data-testid="newdoc-template-card-{id}"` (saved designs `newdoc-template-card-saved-{themeId}`), the submit button is `data-testid="newdoc-submit-create"`, each option row's trigger `newdoc-section-{template,details}`. The `EditorPage.newDocDialog` getter goes through these testids — NOT through `getByRole({ name })` which would (a) be i18n-fragile and (b) accidentally match the homepage's "+ New Document" button when scope leaks.
- **Anchored regex on a card button's accessible name doesn't match.** A card's button textContent is the heading + description concatenated. `hasText: /^Meeting notes$/` never hits. Use `data-testid` per card.
- **`UInputMenu` `create-item` callback returns the new item, doesn't auto-set the model.** First version of `DocumentEditorPanel.vue` assumed the callback would update `v-model`; it doesn't. The handler must explicitly assign `languageModel.value = onCreateLanguage(text)`. Symptom: typing "Romansh" + Enter clears the input instead of selecting the new value.
- **All 4 doc-context columns NOT NULL with defaults** (`description=''`, `audience='casual'`, `language='en'`, `templateId='blank'`) — the prompt builder is unconditional. If you ever add a nullable column in this group, update `buildDocumentContext` to handle the null branch, or the AI will see `Title: null` literally.
- **i18n new top-level keys require a dev-server restart, not just HMR.** Adding `documentPanel.title` / `audiences.*` / `templates.*` / `newDoc.*` namespaces to a locale JSON shows the literal keys in the browser until the dev server restarts.
- **`themePreset` validated server-side as an id, not as a full theme object.** The dialog ships only `themePreset: 'modern'` (a template's design), server resolves to the corresponding `THEME_PRESETS` entry's `theme` JSONB. Means the client never gets to inject arbitrary CSS via the theme JSONB column at creation time.
- **Always-show language badge on workspace doc table (not "show only if differs from UI locale").** Differ-only would let a French-UI viewer see "EN" badges that an English-UI viewer doesn't, which is confusing when collaborators compare screenshots. Always-show is more uniform; the badges are tiny.
