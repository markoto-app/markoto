---
title: 'markoto vs Typst: Markdown or typesetting?'
description: markoto and Typst side by side - Markdown or Typst markup, citations, layout control, comments, collaboration, prices and data location. Checked facts.
keywords:
  - markoto vs typst
  - typst alternative
  - typst vs markdown
  - typst markdown
  - typst web app alternative
updated: '2026-11-19'
navGroup: compare
navLabel: markoto vs Typst
navOrder: 70
---

# markoto vs Typst

Both turn plain text into well-set PDF pages, and both have a web app where several people edit at once. They ask different things of you.

**Typst** is a typesetting language, a modern alternative to LaTeX. You write in Typst markup, which has its own syntax for headings, math and layout, plus a real scripting language with functions, loops and conditionals. Templates control every detail of the page, and it handles bibliographies and citations. The compiler is open source (Apache-2.0); the web app at typst.app stores data in Germany.

**markoto** is a Markdown editor. You write the Markdown you probably already know, pick a print theme, and get paged output that matches the preview. Nothing new to learn, but much less control over layout than a typesetting language gives you.

## Feature comparison

::compare-facts{competitor="typst"}
::

## Where Typst is better

- **Layout control.** Typst is a programming language for documents: you can define functions, loop over data, compute values and build any layout a template author can imagine. markoto gives you themes, a theme editor and custom CSS, but you can't script the document.
- **Citation styles.** Typst reads BibLaTeX `.bib` and Hayagriva files and formats citations in any CSL style. markoto reads BibTeX and CSL JSON too, but formats only its six built-in styles (APA, Chicago author-date, Harvard, IEEE, Vancouver, DIN 1505-2).
- **Templates.** Typst Universe, its package collection, has templates for journal and conference papers, theses, reports, CVs and posters. markoto has a handful of templates and eight print themes.
- **Slides.** Typst has presentation templates, and Pro adds a presentation mode in the web app. markoto makes documents, not slide decks.
- **Offline and local.** The Typst compiler runs on your own computer from the command line, and its source is open. markoto runs only in the browser and needs a connection.
- **More output formats.** PDF, PNG and SVG, and HTML as an experiment. markoto exports PDF and Markdown.
- **Git sync.** Typst Pro syncs projects with GitHub and GitLab (marked experimental). markoto has no Git integration.
- **More room on the free plan.** 200 MB and up to 100 files per project.

## Where markoto is better

- **Nothing to learn.** If you know Markdown, you can write in markoto. Typst has its own syntax, including its own math notation; LaTeX formulas don't paste in as they are. markoto uses LaTeX math syntax.
- **Markdown stays Markdown.** Your text works in GitHub, other editors and static site generators. Typst reads Markdown only through packages such as cmarker.
- **Comments on the free plan.** Threads anchored to the text, for everyone in the document. Typst has comments on Pro.
- **Every change, with a diff.** markoto records every edit, shows what changed and restores any earlier state.
- **Mermaid diagrams built in.** A fenced `mermaid` block becomes a diagram on the page.
- **Join without an account.** Anyone with the link can edit a document, if the owner allows it.
- **AI assistant.** markoto's assistant edits the document, answers in comments and can use files uploaded to a workspace.
- **Import.** markoto converts Word, PDF, PowerPoint, Excel, HTML and EPUB into Markdown.
- **Self-hosting for anyone.** markoto installs on your own server with Docker Compose, free. Typst's on-premises web app is offered for organisations from five members.

## Prices

On markoto.app the free plan has no price but has limits (for example 30 days of history and 3 members per workspace); paid plans are planned but not launched ([pricing](/pricing)). Self-hosted instances have no plan limits. Typst's web app is free with limits; Pro costs $7.99 a month, less with annual billing. See [Typst's pricing page](https://typst.app/pricing/) for the current annual price.

## Who should pick which

Pick **Typst** for papers, theses and books where layout control and a specific citation style matter, if you are happy to learn a new language for it, or if you are leaving LaTeX.

Pick **markoto** if you would rather write plain Markdown, if a print theme gives you the layout you need, or if your co-authors need comments and history without a paid plan.

## Moving between them

There is no direct converter. Typst and Markdown share ideas (headings, emphasis, lists), but the syntax differs: in Typst a heading is `= Title` and emphasis is `_text_`. To move a Markdown document to Typst, the open-source tool Pandoc can convert it; to bring Typst text into markoto, rewrite the markup as Markdown. Export a markoto document as Markdown to take it anywhere.

## Questions

::faq{json-ld}
---
items:
  - q: Can Typst read Markdown?
    a: Not by itself. Packages such as cmarker convert Markdown inside a Typst document. markoto works with Markdown directly.
  - q: Does markoto support citations or BibTeX?
    a: Yes. Import a BibTeX or CSL JSON file (for example a Zotero export), add works by DOI, cite them as [@key] and pick APA, Chicago author-date, Harvard, IEEE, Vancouver or DIN 1505-2. Other CSL styles are not available.
  - q: Is markoto easier than Typst?
    a: For people who know Markdown, yes, because there is nothing new to learn. Typst asks you to learn its markup and gives you much more control over the layout in return.
  - q: Where do the two services store data?
    a: markoto.app stores data with OVHcloud in France. Typst states that its web app stores data in a data centre in Germany.
  - q: Is markoto free?
    a: Yes. markoto.app is free, including comments, history, collaboration and PDF export. Paid plans with higher limits are planned but not launched. Self-hosting is free too.
---
::

::cta{title="Write in Markdown, get pages." secondary-label="All comparisons" secondary-to="/compare"}
Start a document, pick a print theme and download the PDF. No sign-up needed.
::

<!-- Sources for our own periodic fact checks (content/compare/typst.yml), not shown on the page:
::compare-sources{competitor="typst"}
::
-->

::compare-note{competitor="typst"}
::
