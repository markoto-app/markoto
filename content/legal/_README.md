# content/legal

Per-document, per-locale legal text. Rendered at `/legal/{slug}` via a single Vue page that picks the active locale and falls back to English.

## Layout

```
content/legal/
  privacy/
    _meta.json           # version, effective date, authoritative locale
    en.md                # AUTHORITATIVE
    fr.md, de.md, es.md  # translations
  dpa/
  terms/
  abuse-policy/
```

## Authoring rules

- **English is authoritative.** Bumping the English text on a material change requires bumping `PRIVACY_VERSION` (etc.) in `shared/legal/versions.ts`. Translations get the same version once they catch up.
- **Translation banner.** Non-English pages render a "translation for convenience; English is authoritative" notice automatically. The fr/de/es files SHOULD be reviewed by a privacy-law-trained native translator before publishing; DeepL first pass is acceptable for review draft only.
- **Material vs. cosmetic changes.** Adding a sub-processor, processing purpose, retention period, or user right is material → bump version. Typo fixes and pure-translation polish do NOT bump.
- **Sub-processor list and lawful-basis table.** Don't hard-code these in markdown: render them from `server/legal/{subProcessors,lawfulBasis}.ts` so a single edit propagates.

`tests/unit/legal/documents.test.ts` enforces that every translation has the registry version, the same `{{placeholders}}` and the same number of `##` sections as `en.md`. The privacy page's purposes table comes from `{{processingPurposesTable}}` (generated from `server/legal/lawfulBasis.ts`, English only). German uses Swiss orthography (`ss`, no `ß`), matching the imprint.

## Adding a translation

1. Copy `en.md` to `{locale}.md`.
2. Translate. Keep the same heading anchors (the page uses them for the TOC).
3. Frontmatter: keep `version` matching `_meta.json`'s `version`. Set `translationStatus: 'reviewed' | 'machine-translated' | 'pending'` so the page can show a banner if a translation is below review-grade.

## Adding a new legal document

1. Add a slug directory.
2. Add a `_meta.json` with `version: 1`, `effectiveDate`, `authoritativeLocale: "en"`, `slug`.
3. Add a version constant + effective date in `shared/legal/versions.ts`.
4. Add an i18n title key under `legal.{slug}.title` (and a footer link under `legal.footer.{slug}` if relevant).
5. Add a route in `app/pages/legal/{slug}.vue` (or extend the catch-all if we add one).
