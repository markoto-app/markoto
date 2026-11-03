# Templates

Bodies keyed off `templateId`. Seven ship: demo (the new-document dialog's default, `DEFAULT_TEMPLATE_ID`: a markdown cheat sheet that also says where sharing, themes, cover page, comments + `@markoto`, the AI bar, dictation, activity/restore, PDF export and workspace knowledge live; all six UI locales), blank (truly empty — no body at all), business-plan, academic-paper, recipe, meeting-notes, project-readme. Each skeleton template has heading hierarchy + section-level `<!-- ... -->` instruction comments — invisible in preview/PDF (comment plugin in `app/utils/AGENTS.md`) but visible in the markdown source AND in the AI's `view_document` calls, so the model has section-level briefs to follow.

## Split between client-safe registry and server-only renderer

- **`index.ts` (this directory)** — registry only (id, icon, i18n keys, `hasContent` flag, `TEMPLATE_LOCALES` list, `isTemplateId` validator). Imports cleanly into client + server bundles.
- **`server/utils/templateRenderer.ts`** — `renderTemplate(id, ctx)` reads the `.md` files from `content/<id>/<locale>.md` via `fs.readFileSync` (cached at module load), substitutes `{{title}}` / `{{description}}` placeholders, returns null for `blank` and unknown ids.

**Why the split:** Vite's `?raw` import works for the client bundle but Nitro's rollup pipeline doesn't, so a unified `shared/` import would 500 SSR. Server-only rendering means the body is shipped as a fully-substituted string on the token endpoint — the client never has to load template files. The `?raw` symptom looks like `Error: Could not load .../en.md?raw — ENOENT`; if you see it, the import lives in `shared/` and needs to move to `server/`.

## Multilingual

Each template ships per-locale files (`demo` in all six UI locales, the skeletons `en.md` + `de.md`; `TEMPLATE_LOCALES` lists all six, a missing file falls back to English). Locale resolution in `renderTemplate`: exact match → BCP-47 base (`de-CH` → `de`) → English fallback. Free-text languages drop to English without throwing; the AI handles output language via the doc-context block regardless. Adding a locale = drop new `.md` files + extend `TEMPLATE_LOCALES` once. Adding a template = drop the `<id>/en.md` file (mandatory) + register in `TEMPLATES` + add i18n keys for label/description.

## Seeding flow

Server token endpoint pre-renders the body (with the doc's title/description, locale-matched on doc.language) and ships it as `initialBody` on every fetch. Client uses it only when `ytext.length === 0`, so re-fetching the token on a doc with content is harmless. `blank` renders to null and the document stays empty (there is no generic welcome text any more). An empty `POST /api/docs` ("Just give me a blank doc", File → New) gets the schema default `blank`. The Demo text names real UI labels per locale (menu paths, button names): when one of those labels changes, update the demo files too.

## Gotchas

- **Templates use `fs.readFileSync` cached at module load, NOT lazy.** The body files are tiny (a few KB each) and frequently used. Reading once per process at first call beats both: re-reading per request (disk hit on every doc creation) and bundling them as JS strings (loses the human-readable `.md` authoring experience for translators).
- **Template body is shipped on the token endpoint, NOT the POST response.** POST response is just `{ docId }`. The client navigates to `/d/<id>`, the editor mounts, `useDocToken` calls the token endpoint, and `initialBody` rides back on that response. Putting the body on POST would lose it across the navigation. Re-fetching the token on a doc that already has content is harmless because the seed gate is `ytext.length === 0`.
- **`?raw` markdown imports work in Vite (client + Vitest) but NOT in Nitro/Rollup for `shared/`.** Fix: move the renderer to `server/utils/` and use `fs.readFileSync` with `import.meta.url`-relative paths. The body files stay in `shared/` for translator ergonomics + co-location with the registry.
