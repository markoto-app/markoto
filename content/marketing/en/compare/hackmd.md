---
title: 'markoto vs HackMD: a HackMD alternative compared'
description: markoto and HackMD side by side - collaboration limits, slide mode, GitHub sync, PDF export, self-hosting and where your data is stored. Checked facts.
keywords:
  - markoto vs hackmd
  - hackmd alternative
  - hackmd vs
  - collaborative markdown editor
updated: '2026-11-04'
navGroup: compare
navLabel: markoto vs HackMD
navOrder: 10
---

# markoto vs HackMD

HackMD and markoto are both collaborative Markdown editors in the browser: several people type in the same note at once and see each other's cursors. They differ in what the note is for.

**HackMD** is built for team notes and documentation: meeting notes, specs, READMEs, slide decks and books made from linked notes, with GitHub sync to keep notes next to code.

**markoto** is built for documents that end up as pages: reports, papers, proposals, handouts. Its preview shows the document as printed pages, and the PDF matches that preview. It can be self-hosted, and markoto.app stores your data in the EU.

## Feature comparison

::compare-facts{competitor="hackmd"}
::

## Where HackMD is better

- **Slide mode and book mode.** HackMD turns a note into a slide deck and links notes into a book. markoto has neither.
- **GitHub sync.** HackMD pushes notes to a GitHub repository (20 pushes a month on Free). markoto has no Git or GitHub integration; you download Markdown and commit it yourself.
- **Suggested edits.** HackMD has a "Suggest edit" mode (in beta). markoto has no suggestion or track-changes mode; it keeps every version with a diff and a restore button instead.
- **More diagram types.** HackMD renders Graphviz, PlantUML, Vega-Lite, music notation and more. markoto renders Mermaid only.
- **HTML download.** HackMD downloads notes as HTML as well as Markdown.
- **Maturity and certification.** HackMD is the longer-established product and states SOC 2 certification. markoto is new and has no certification.

## Where markoto is better

- **Paged preview and PDF on every plan.** markoto shows A4 or Letter pages as you type, with print themes, a cover page, headers, footers and page numbers. The PDF is rendered on the server from the same layout. HackMD lists PDF export on its Prime plan.
- **No collaborator cap on the free plan.** Anyone with the link can join a markoto document, without an account. HackMD's free plan allows up to 3 teammates and 3 invitees.
- **Full history on the free plan.** markoto records every edit, shows what changed and restores any earlier state. HackMD's free plan keeps the last 10 versions.
- **AI writing assistant.** markoto's assistant edits the document directly, answers in comments, and can use files you upload to a workspace. It runs on your own AI provider, or on a small monthly free allowance on markoto.app.
- **Self-hosting for everyone.** markoto is source-available and installs with one script and Docker Compose. HackMD offers on-premises deployment on its Enterprise plan.
- **EU data location.** markoto.app stores documents with OVHcloud in France and uses EU-based AI providers.
- **Import.** markoto converts DOCX, PDF, PPTX, XLSX, HTML and EPUB into Markdown.

## Who should pick which

Pick **HackMD** if your notes live next to code on GitHub, if you present from your notes, or if your team wants suggested edits.

Pick **markoto** if the result has to be a well laid-out PDF, if you work with more than three people on a free plan, or if your data has to stay in the EU or on your own server.

## Moving from HackMD to markoto

Download a note from HackMD as Markdown and open it in markoto with **File › Import**, or paste the text into a new document. Standard Markdown, tables, footnotes, KaTeX-compatible math and Mermaid diagrams carry over. HackMD-specific syntax, such as slide separators or embeds, shows as plain text.

## Questions

::faq{json-ld}
---
items:
  - q: Is markoto free?
    a: Yes. markoto.app is free, with no collaborator limit and PDF export included. Paid plans with higher limits are planned but not launched. Self-hosting is free too.
  - q: Does markoto have slide mode like HackMD?
    a: No. markoto makes paged documents and PDFs, not slide decks.
  - q: Can markoto sync with GitHub?
    a: No. You can download any document as a Markdown file and commit it yourself, but there is no automatic sync.
  - q: Is markoto open source?
    a: markoto is source-available under the Functional Source License (FSL-1.1). Each release becomes Apache-2.0 two years after it is published. It is not an OSI open source licence today.
  - q: Do I need an account?
    a: No. You can write and share a document without signing in. An account lets you own documents, use workspaces and use the AI assistant.
---
::

::cta{title="Try markoto with one of your HackMD notes." secondary-label="All comparisons" secondary-to="/compare"}
Paste the Markdown into a new document and see it as pages. Free on markoto.app, no sign-up needed.
::

<!-- Sources for our own periodic fact checks (content/compare/hackmd.yml), not shown on the page:
::compare-sources{competitor="hackmd"}
::
-->

::compare-note{competitor="hackmd"}
::
