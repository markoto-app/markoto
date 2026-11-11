# Document templates

A document template is a starting text plus the design it is written for (a built-in theme preset). The new-document dialog offers them as one choice; the design can be changed later in the theme panel. Building a new design (theme preset) is a separate task: see [TEMPLATE-WORKFLOW.md](TEMPLATE-WORKFLOW.md). Agent rules for this folder are in [`shared/templates/AGENTS.md`](../../shared/templates/AGENTS.md).

## Files

| File | Role |
|---|---|
| `shared/templates/index.ts` | Client-safe registry: `TEMPLATES`, `TEMPLATE_IDS`, `DEFAULT_TEMPLATE_ID`, aliases, `TEMPLATE_LOCALES`, `templateLocale`, `isTemplateId` / `resolveTemplateId` / `getTemplate`, cover placeholders, `TEMPLATE_TOOL_HINT` |
| `shared/templates/content/<id>/<locale>.md` | Template text per locale |
| `server/utils/documents/templateRenderer.ts` | Server-only `renderTemplate(id, ctx)` |
| `server/utils/documents/createDocument.ts` | Picks the new document's theme |
| `shared/templates/thumbnails.ts`, `shared/templates/templateThumbnails.manifest.json` | Picture URLs and the hashes they were rendered from |
| `public/template-thumbs/<id>.webp` | Pictures shown in the dialog |

## Registry entries

Each `TEMPLATES` entry has an `id` (stored in `documents.template_id`, never renamed), a `content` directory, a `design` (theme preset id; `null` only for `blank`, which uses the workspace default design or markoto), a `category` (picker tab: `general`, `engineering`, `academic`, `business`, `writing`), an icon, and optional `cover` placeholders per locale (subtitle, authors, affiliations, `showDate`) for designs whose cover or title block prints them. Labels and descriptions are the i18n keys `templates.<id>.label` / `.description` in all six UI locales.

`demo` is what the dialog pre-selects for a browser's first document (`DEFAULT_TEMPLATE_ID`); an empty `POST /api/docs` gets `blank`. `blank` has no text (`hasContent: false`). `resume` is a filled-in one-page CV, not a skeleton. The other templates are skeletons: the heading structure of the genre, a `<!-- … -->` hint under each section telling the writer or the AI what goes there (hidden in preview and PDF, visible in the source and to the AI), and short visible scaffolding where the genre has a fixed format (tables, captions, run-in labels, alerts).

Retired ids stay in `TEMPLATE_ALIASES` (`academic-paper` → `arxiv`). `isTemplateId` accepts them, `resolveTemplateId` / `getTemplate` map them, and documents are stored with the current id. `TEMPLATE_IDS` and the AI/MCP `template_id` enum list current ids only.

## Rendering and seeding

`renderTemplate` reads `shared/templates/content/<content>/<locale>.md` with `fs.readFileSync` (relative to the process working directory; the Dockerfile copies the files into the image), caches each file, and substitutes `{{title}}` and `{{description}}` — the only placeholders. Locale resolution: exact match, then the BCP-47 base (`de-CH` → `de`), then English. It returns null for `blank` and unknown ids.

The body is not part of `POST /api/docs` (which answers `{ docId }`). The editor's `GET /api/docs/:docId/token` renders it with the document's title, description and language and returns it as `initialBody`. The editor inserts it only after the first sync, and only when the text is empty (`app/composables/document/useDocument.ts`), so refetching the token on a document with content is harmless.

## Choosing the theme

`createDocument` resolves the theme in this order: `themeId` (a saved theme of the caller) → `themePreset` → the template's design → the workspace default → the schema default. `themeId` and `themePreset` together are a 400. The template's cover placeholders are filled into empty cover fields only when the document gets the template's own design, in the document language. So `POST /api/docs { templateId }` gives the bundle, and `templateId` + `themePreset` puts another design on the text.

## Adding a template

1. Write `shared/templates/content/<id>/en.md` and `de.md` (both required; German without `ß`; at least one `<!-- … -->` hint unless the text is a filled-in example). If the design prints the title on a cover or title block, don't start the text with `# {{title}}`.
2. Add a `TEMPLATES` entry in `shared/templates/index.ts` with an existing preset as `design`, and cover placeholders in `en` and `de` if the design shows them.
3. Add `templates.<id>.label` and `.description` to every locale in `i18n/locales/`.
4. Add a sample title to `tests/fixtures/theme-shots/template-thumbs.json`.
5. Render the picture: start an app in test mode with `NUXT_ANON_GATE_ENABLED=false`, then `make template-thumbs URL=<app url> IDS=<id>`. This writes `public/template-thumbs/<id>.webp` and updates the manifest.
6. Run `tests/unit/documents/templates.test.ts` and `tests/unit/theme/templateThumbnails.test.ts`. The first checks the registry, locale files, hints and cover placeholders, and that every built-in design has at least one template; the second fails when a template's text, design or placeholders changed without a new picture.

Adding a locale for an existing template: add `<locale>.md` with the same outline. Adding a template locale for all templates: extend `TEMPLATE_LOCALES` and add cover placeholders for it.
