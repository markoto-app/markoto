# Theme-shot fixtures

Markdown documents for reviewing theme presets and templates page by page with
`scripts/render-theme-shots.ts` (`make theme-shots`, see `docs/CHEATSHEET.md`).
Each fixture is a realistic document of one genre — invented organisations,
people and numbers — long enough to paginate, with the awkward cases that genre
runs into. Every file starts with a `<!-- … -->` comment (stripped from the
render) naming the template and what it stresses.

Render one fixture with its title and patch:

```bash
bun scripts/render-theme-shots.ts --base http://127.0.0.1:3000 --out /tmp/shots \
  --md tests/fixtures/theme-shots/design-doc.md \
  --title "RFC 0042: Regional failover for the payments ledger" \
  --patch tests/fixtures/theme-shots/design-doc-patch.json markoto
```

The app must run with `NUXT_ANON_GATE_ENABLED=false`; `--patch` also needs a
`TEST_MODE=1` instance with a loopback (or empty) `NUXT_SITE_URL`. A patch only
carries title-block data (subtitle, authors, affiliations, date) and, where the
genre needs it, the cover layout — never the template's design.

| Fixture | Template | Stresses | Title (`--title`) | Patch |
|---|---|---|---|---|
| `kitchen-sink.md` | any | every block type once | default | — |
| `paper.md` | paper / LaTeX look | title block + abstract | default | `paper-patch.json`, `latex-patch.json` |
| `tech-docs.md` | Technical documentation | TOC; code in ts/python/bash/yaml/json/sql/go, titled block, long-line block, block > 15 lines; config + API tables, wide 10-column table; all five alerts; Mermaid sequence diagram; changelog | Ferrule 3 — Developer Guide | `tech-docs-patch.json` |
| `design-doc.md` | Design doc / RFC | metadata key/value table; goals/non-goals; flowchart + state diagram; wide alternatives table; numbered decisions; rollout + risk tables; open questions task list | RFC 0042: Regional failover for the payments ledger | `design-doc-patch.json` |
| `runbook.md` | On-call runbook | numbered procedures with shell blocks inside list items; many inline commands; nested task lists; escalation table with long cells; alerts; quick-reference tables | Checkout platform — on-call runbook | — |
| `api-reference.md` | API reference | h1–h4 hierarchy (resource → endpoint → section → status); parameter tables; request/response JSON (one > 15 lines); curl with long lines; error-code table; auth + rate limits | Larkspur Payments API v2 — Reference | `api-reference-patch.json` |
| `thesis-chapter.md` | Thesis | one chapter with sections for decimal numbering; long paragraphs; aligned + display equations; captioned figures; tables; many (long) footnotes; block quote; definition list; abbreviations; references | Chapter 3 — Learning sparse sensor placements for urban flood forecasting | `thesis-chapter-patch.json` |
| `conference-paper.md` | Conference paper (IEEE-like, two columns) | leading Abstract (moved into the title block) + Index Terms; short sections; narrow and wide tables; equations; figure; code with a long line; numeric references | Tidewater: Energy-Proportional Batching for Edge Inference Servers | `conference-paper-patch.json` (title-block, 3 authors) |
| `ieee-conference.md` | IEEE conference paper (format template) | Markdown twin of IEEEtran's `bare_conf.tex` plus index terms, a `{.table-caption}` table caption, a figure, a list, a footnote and `{.references}` numeric references — compare against the compiled class (`docs/TEMPLATE-WORKFLOW.md`) | Bare Demo of IEEEtran.cls for IEEE Conferences | `ieee-conference-patch.json` (three author blocks) |
| `lecture-notes.md` | Lecture notes | definition lists; theorem/remark/tip/warning as alerts; bold run-in example labels; worked math; python snippet; Mermaid flowchart; exercises with nested parts; mark/sub/sup/abbr | Probability for Computer Scientists — Lecture 7: Expectation and Linearity | `lecture-notes-patch.json` |
| `business-report.md` | Business report | TOC; key-figure + KPI tables with total rows; 10-column regional table; Mermaid pie + xychart; CEO quote; nested outlook bullets; disclaimer note; page break; appendix | Halden Outdoor AG — Q3 2026 Quarterly Report | `business-report-patch.json` |
| `proposal.md` | Client proposal | prepared-for/by table; phases; timeline table + Mermaid gantt; pricing with subtotal/VAT/total; optional items; tip callout; page break; terms with nested clauses; signature block | Proposal: Customer portal relaunch for Rheintal Energie | `proposal-patch.json` |
| `memo.md` | Memo / letter (1–2 pages) | To/From/Date/Subject block with hard breaks; rule; short paragraphs; small table; bullet + numbered list; sign-off; cc line | Memo — Office move to Hardturmstrasse | `memo-patch.json` (cover off) |
| `one-pager.md` | One-pager (must fit 1 page) | dense h2 sections; bold lead; small table; important callout; lists; run-in facts paragraph | Fieldnote — field-service reports in one tap | `one-pager-patch.json` (title-block, no logo) |
| `essay.md` | Academic essay (APA-like) | author/course/instructor via title block; in-text citations; long block quotation; footnote; reference list for hanging indents | Who Owns the Shoreline? Public Access and Private Property on Alpine Lakes | `essay-patch.json` (title-block) |
| `manuscript.md` | Fiction manuscript | epigraph; three h1 chapters; long runs of dialogue; scene breaks (`---`, `* * *`); italic thoughts; quoted letter | The Salt Ledger | `manuscript-patch.json` |
| `newsletter.md` | Newsletter | masthead line; short articles; raster images (full width, sized, figure captions); pull quote; events table; links; note callout | The Commons | `newsletter-patch.json` (title-block masthead) |
| `structure.md` | engine (any) | numbering from h2, Pandoc table captions above/below, number + unit and SEV-1 in narrow cells, captioned figure, References as a numbered list | Quarterly review | `structure-patch.json` (numbering, caption + figure labels, [1] references, `{section}` header — engine options, not a template's design) |

Images are tiny palette PNG `data:` URIs: Markdown only accepts raster
`data:image/*` sources, so SVG data URIs would not render.
