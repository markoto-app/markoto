# Templates

Pure structural skeletons keyed off `templateId`. Six ship in v1: blank, business-plan, academic-paper, recipe, meeting-notes, project-readme. Each non-blank template has heading hierarchy + section-level `<!-- ... -->` instruction comments — invisible in preview/PDF (comment plugin in `app/utils/AGENTS.md`) but visible in the markdown source AND in the AI's `view_document` calls, so the model has section-level briefs to follow.

## Split between client-safe registry and server-only renderer

- **`index.ts` (this directory)** — registry only (id, icon, i18n keys, `hasContent` flag, `TEMPLATE_LOCALES` list, `isTemplateId` validator). Imports cleanly into client + server bundles.
- **`server/utils/templateRenderer.ts`** — `renderTemplate(id, ctx)` reads the `.md` files from `content/<id>/<locale>.md` via `fs.readFileSync` (cached at module load), substitutes `{{title}}` / `{{description}}` placeholders, returns null for `blank` and unknown ids.

**Why the split:** Vite's `?raw` import works for the client bundle but Nitro's rollup pipeline doesn't, so a unified `shared/` import would 500 SSR. Server-only rendering means the body is shipped as a fully-substituted string on the token endpoint — the client never has to load template files. The `?raw` symptom looks like `Error: Could not load .../en.md?raw — ENOENT`; if you see it, the import lives in `shared/` and needs to move to `server/`.

## Multilingual

Each template ships per-locale files (currently `en.md` + `de.md`). Locale resolution in `renderTemplate`: exact match → BCP-47 base (`de-CH` → `de`) → English fallback. Free-text languages drop to English without throwing; the AI handles output language via the doc-context block regardless. Adding a locale = drop new `.md` files + extend `TEMPLATE_LOCALES` once. Adding a template = drop the `<id>/en.md` file (mandatory) + register in `TEMPLATES` + add i18n keys for label/description.

## Seeding flow

Server token endpoint pre-renders the body (with the doc's title/description, locale-matched on doc.language) and ships it as `initialBody` on every fetch. Client uses it only when `ytext.length === 0` — same gate as `welcomeMarkdown`, so re-fetching the token on a doc with content is harmless and `blank` template (renders to null) falls through to the generic welcome doc.

## Gotchas

- **Templates use `fs.readFileSync` cached at module load, NOT lazy.** The body files are tiny (a few KB each) and frequently used. Reading once per process at first call beats both: re-reading per request (disk hit on every doc creation) and bundling them as JS strings (loses the human-readable `.md` authoring experience for translators).
- **Template body is shipped on the token endpoint, NOT the POST response.** POST response is just `{ docId }`. The client navigates to `/d/<id>`, the editor mounts, `useDocToken` calls the token endpoint, and `initialBody` rides back on that response. Putting the body on POST would lose it across the navigation. Re-fetching the token on a doc that already has content is harmless because the seed gate is `ytext.length === 0`.
- **`?raw` markdown imports work in Vite (client + Vitest) but NOT in Nitro/Rollup for `shared/`.** Fix: move the renderer to `server/utils/` and use `fs.readFileSync` with `import.meta.url`-relative paths. The body files stay in `shared/` for translator ergonomics + co-location with the registry.
