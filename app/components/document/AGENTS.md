# Document components

Document context, the new-document dialog, the theme panel and the anonymous gate. Templates: [`docs/contributing/templates.md`](../../../docs/contributing/templates.md).

## Document context

Every document has `description` (≤ 500 chars), `audience` (`technical` / `marketing` / `academic` / `casual` / `business` / `creative`, `shared/audiences/index.ts`), `language` (an ISO code or any typed name, ≤ 50 chars) and `templateId`. All four are NOT NULL with defaults (`''`, `casual`, `en`, `blank`), and `server/utils/agentic/documentContextPrompt.ts` puts them into every AI prompt.

- **Keep the four columns NOT NULL.** A nullable one needs a null branch in `buildDocumentContext`, or the AI sees `null` literally.
- **Audience tone fragments stay English and are not user-editable.** Output language follows `language`; only the labels (`audiences.<id>.label` / `.description`) are translated.
- **Writes go through the `useDocument` setters**: read-only users can't write, every editor writes `ymeta`, only the owner's editor persists to the database (on ownerless documents Y.js is the only record).
- **`UInputMenu` `create-item` does not set the model.** The `@create` handler must assign it (`languageModel = onCreateLanguage(text)` in `DocumentEditorPanel.vue`), or Enter clears the input.

## New-document dialog (`NewDocumentDialog.vue`)

- **Mount it lazily.** On `/` and in `MarketingStartButton` it is `LazyDocumentNewDocumentDialog`, mounted on first use via `useNewDocDialog` (warmed on pointer over / focus). It links every theme font; never put it in the initial load of a page logged-out visitors land on.
- **Every interactive element has a `data-testid`**: `newdoc-title-input`, `newdoc-section-{template,details}` (+ `-summary`), `newdoc-template-card-<id>`, `newdoc-template-card-saved-<themeId>`, `newdoc-description-input`, `newdoc-language-input`, `newdoc-audience-select`, `newdoc-submit-create`. Tests go through these (`EditorPage.newDocDialog`), never `getByRole({ name })`: i18n-fragile, and it can match the home page's own "New document" button. A card's accessible name is heading + description, so an anchored text regex never matches.
- **Collapsed rows unmount their content.** Open a row first (`EditorPage.openNewDocSection(id)`) before touching its cards or inputs.
- **Send a preset id, never a theme object.** The dialog posts `templateId` + `themePreset` (or `themeId` for a saved design); the server resolves the theme, so creation can't inject arbitrary theme JSON.
- **Blank in a workspace with a default theme sends no `themePreset`**, so the server applies the workspace default.
- **A new built-in preset needs** a `category`, an entry in `tests/fixtures/theme-shots/thumbnails.json`, a picture (`make theme-thumbs URL=… PRESETS=<id>`) and a template that uses it. `tests/unit/theme/themeThumbnails.test.ts` fails when a preset has no picture or changed since it was rendered.

## Anonymous gate (`AnonGateDialog.vue`)

- **Every create path goes through `useAnonDocCreate().createDocument(body)`** (`app/composables/account/useAnonGate.ts`). It shows the terms dialog when needed, attaches a fresh ALTCHA solution and retries once on an expired one. Don't call `POST /api/docs` directly from a component.
- A cancelled dialog throws `AnonGateCancelled`; treat it as a cancel, not an error toast.
- Flows pass the gate with `EditorPage.clickCreateAndPassGate()`.

## Theme panel

Custom CSS (`ThemeCustomCssSection.vue`) emits only CSS that passed the sanitizer. The rendering rules for themes are in `app/utils/AGENTS.md`.
