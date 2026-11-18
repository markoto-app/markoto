# Test document: Betriebshandbuch IT- und Netzbetrieb

A book-length German markoto document (about 82 000 words, 620 KB, an
estimated 170 to 190 A4 pages at 450 to 500 words per page; about 170 000
tokens by the benchmark's chars / 3.6 estimate) for testing and benchmarking what the AI and the editor do with large
documents. The AI benchmark (`tests/bench/ai/`, `bun run bench:ai`) runs its
tasks on it.

| File | What it is |
|---|---|
| `betriebshandbuch.md` | The document body. Title: **Betriebshandbuch IT- und Netzbetrieb**, language German (Switzerland). |

The file is **generated**, do not edit it by hand: change
`tests/fixtures/largeDocument/generate.ts` and run
`bun tests/fixtures/largeDocument/generate.ts`. The generator is deterministic
(seeded PRNG, no dependencies); `tests/unit/ai/largeDocumentFixture.test.ts`
fails when this copy and the generator disagree, and pins the document's shape.

## The organisation (all invented)

**Stadtwerke Aarenfeld AG**, a Swiss municipal utility (power, water, fibre;
about 48 000 households and 2300 businesses). The handbook belongs to its
operations department (Abteilung Betrieb). Sites: Birkenmatt (control room),
Hohwacht (data centre), Lindenbühl (fallback site), Seewil, Rotach, Aarenfeld
Ost. Systems: Aquila (SCADA), Lumen (monitoring), Kairos (tickets), Tessera
(CMDB), Boreas (backup), Nimbus (directory). Every person named is invented.

## Structure

- A preamble (title block, `[[toc]]`, page break) before the first heading.
- 14 chapters `# 1 Einleitung` to `# 14 Anhang`, each with 3 to 5 numbered
  sections (`## 3.2 Schalthandlungen`) and 2 to 4 subsections
  (`### 3.2.1 ...`). Some headings carry `{#id}`; internal links point at them.
- Section sizes vary; the largest H2 sections have 1600 to 1900 words.
- Chapter 13 (Qualitätssicherung und Audits) is the last full chapter, chapter
  14 the appendix (glossary as a definition list, abbreviations).

## Constructs

Tables with captions, fenced code (bash, yaml, sql, json, one Mermaid
flowchart, and bash blocks with lines that start with `#`), inline code,
inline and block math, six images with upload URLs of the form
`/api/files/BenchHandbook01/<fileId>.png` (the files do not exist), eight
footnotes, internal and external links (`example.org` / `.com` / `.net`),
alerts (`> [!NOTE]`, `[!WARNING]`, ...), `<!-- pagebreak -->` before each
chapter, a task list.

## Terminology target

The words *Kunde*, *Kunden*, *Kundin* and *Kundinnen* occur exactly 40 times
in 19 sections, and "Kund" occurs nowhere else (no compounds), so a "rename
Kunde to Klient in all forms" task has an exact expected result.

## Writing style

Swiss spelling (no sharp s), no em dash. The prose is assembled from about
200 hand-written sentence templates with slots, so it reads like a handbook
but is not a coherent text; do not use it where the content must make sense
to a reader.
