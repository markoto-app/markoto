---
title: Citations and cross-references
description: Cite sources with [@key], get a bibliography in APA, Chicago, Harvard, IEEE, Vancouver or DIN 1505-2, and refer to figures and tables by number.
category: writing
order: 7
updated: '2026-11-19'
---

# Citations, bibliography and cross-references

Every document has its own bibliography. You add sources once (by DOI,
by pasting BibTeX, or from a Zotero export), cite them in the text with
`[@key]`, and markoto writes the citations and the reference list in the
style you pick. Labelled figures, tables, equations and sections get
numbers, and references to them stay right when you move things around.
The preview, the PDF and a published web page all show the same result.

This walkthrough pastes one BibTeX entry, cites it and checks the
reference list in the preview and the PDF. About one minute.

::flow{id="cite-sources" hide-title}
::

## The References panel

Open it with the book icon in the strip above the sidebar, from
**View › References**, or with **Insert › References › Citation**. The
panel holds everything about the document's sources:

- **Citation style.** Applies to the whole document.
- **Add by DOI.** Paste a DOI (`10.1000/xyz123`) or a doi.org link.
  markoto looks the work up at Crossref and adds the entry it finds.
  You need to be signed in for this.
- **Paste BibTeX.** Paste one or many entries in BibTeX, BibLaTeX, CSL
  JSON or CSL YAML, for example from Google Scholar, a publisher page or
  your reference manager.
- **Import file.** A `.bib`, `.json` or `.yaml` file. An entry whose key
  is already in the bibliography is updated.
- **The entry list.** Search it, insert a citation at the cursor with
  the quote button, or remove an entry.
- **Problems.** Citations of keys that are not in the bibliography, and
  references to labels that don't exist, are listed at the top.

Everyone who can edit the document shares its bibliography, and every
change shows up for the others right away.

### Zotero

In Zotero, right-click your library or a collection, choose **Export**,
and pick **Better BibTeX**, **BibTeX** or **CSL JSON**. Import the file
in the References panel. When your Zotero library changes, export and
import again: entries with the same key are updated. A live connection
to your Zotero account is not available yet.

## Cite in the text

The syntax is the one Pandoc and Quarto use, so documents move between
the tools without changes.

| You write | Means | APA prints |
|---|---|---|
| `[@smith2020]` | a citation in parentheses | (Smith, 2020) |
| `[@smith2020, p. 12]` | with a page (also `pp.`, `chap.`, `sec.`, `S.`, `Kap.` …) | (Smith, 2020, p. 12) |
| `[see @smith2020; @jones2019]` | several sources, with a prefix | (see Smith, 2020; Jones, 2019) |
| `[-@smith2020]` | the year only | (2020) |
| `@smith2020` | in the running text | Smith (2020) |
| `@smith2020 [p. 12]` | in the text, with a page | Smith (2020, p. 12) |

Type `@` and markoto suggests the keys of your bibliography and the
labels in the document. Point at a `@key` in the editor to see the
entry it stands for.

A `@word` that is not a key in your bibliography, like a mention of a
team or a handle, stays plain text. A key in square brackets that is
not in the bibliography is shown with a red marker in the preview and
the PDF, so you notice it before you hand the document in.

## Citation styles

- **APA** (7th edition)
- **Chicago** (author-date)
- **Harvard** (Cite Them Right)
- **IEEE** (numbered in order of first citation)
- **Vancouver** (numbered)
- **DIN 1505-2** (author-year)

The document language (Document panel) sets the words: in a German
document the page is "S.", editors are "Hrsg.", and the generated
heading is "Literatur". Other style files and footnote styles are not
available.

## Where the bibliography goes

Only works you cite appear. markoto places the list:

1. where you put `[[bibliography]]` on a line of its own (Insert ›
   References › Bibliography);
2. otherwise under an empty heading called "References",
   "Bibliography", "Literatur" or similar;
3. otherwise at the end of the document, under a new heading in the
   document language.

## Cross-references

Give a figure, table, equation or section a label, then refer to it.
markoto writes the number in the document language and links it.

| Label | Write |
|---|---|
| Figure | `![A cat on a mat](cat.png){#fig:cat}` |
| Table | `Table: Results per group {#tbl:results}` (on the caption line) |
| Equation | `$$ E = mc^2 $$ {#eq:energy}` (the equation gets "(1)" at the right margin) |
| Section | `# Methods {#sec:methods}` |

| Reference | English | German |
|---|---|---|
| `@fig:cat` | Figure 1 | Abbildung 1 |
| `[@tbl:results]` | Table 1 | Tabelle 1 |
| `[@fig:a; @fig:b]` | Figures 1 and 2 | Abbildungen 1 und 2 |
| `@eq:energy` | Equation (1) | Gleichung (1) |
| `@sec:methods` | Section 2 | Abschnitt 2 |

Numbers follow your theme: with caption numbering by chapter (as in the
thesis design) a figure is "Figure 3.2". A section reference uses the
heading number when the theme numbers headings, otherwise the heading
text. A reference to a label that doesn't exist gets the red marker and
appears under Problems.

`[[lof]]` and `[[lot]]` on a line of their own print a list of figures
and a list of tables with page numbers (Insert › References).

## Download and import

**File › Export › Markdown (.md)** writes the bibliography into the file's
frontmatter as `references:`, the format Pandoc reads, so
`pandoc --citeproc` can format the same file. Importing that file into
markoto restores the bibliography and the citation style.

## With the AI

The AI cites only works that are in the document's bibliography; an
edit that cites any other key is refused. To add a work, it needs a DOI
from a real source, which markoto checks at Crossref (the title must
match) before the entry is added. It never writes a reference entry by
hand. Ask it to "check the citations" to get a list of missing entries,
uncited entries and broken cross-references.
