---
title: 'markoto vs HedgeDoc: features, hosting, licence'
description: markoto and HedgeDoc compared - licence, self-hosting, hosted option, slide mode, PDF export and history. Facts checked at the source.
keywords:
  - markoto vs hedgedoc
  - hedgedoc alternative
  - self-hosted markdown editor
  - hedgedoc pdf export
updated: '2026-11-25'
navGroup: compare
navLabel: markoto vs HedgeDoc
navOrder: 20
---

# markoto vs HedgeDoc

HedgeDoc and markoto are both real-time collaborative Markdown editors you can run on your own server.

**HedgeDoc** is an open source project under the AGPL-3.0, run by its community. It is a common choice for shared notes and slides on your own server. There is no official hosted service, only a demo instance. Version 1.x is stable and in maintenance; version 2 is a rewrite in development.

**markoto** is source-available and also runs as a hosted service, markoto.app, with data stored in the EU. It is aimed at documents that are printed or sent as PDF: its preview shows the document as pages, and the PDF matches it.

## Feature comparison

::compare-facts{competitor="hedgedoc"}
::

## Where HedgeDoc is better

- **Open source licence.** HedgeDoc is AGPL-3.0, an OSI-approved open source licence. markoto uses the Functional Source License (FSL-1.1): you may read, change and self-host it, but not offer it as a competing service. Each release becomes Apache-2.0 two years after publication.
- **Slide mode.** HedgeDoc presents a note as slides with reveal.js. markoto has no slide mode.
- **More diagram types.** HedgeDoc renders Graphviz, flow charts, sequence diagrams and ABC music notation besides Mermaid. markoto renders Mermaid only.
- **HTML download.** HedgeDoc saves notes as HTML as well as Markdown.
- **Community project.** HedgeDoc is developed in the open by a community. markoto is a new product developed by one company.
- **Smaller install.** HedgeDoc's example Docker setup is the app and a Postgres database. markoto runs several services (app, sync server, Postgres, Valkey, S3 storage, an AI gateway, a PDF renderer and a document converter) and needs about 6 GB of RAM. If you only need shared notes, HedgeDoc is less to run.

## Where markoto is better

- **PDF export.** markoto renders a paged PDF on the server, with print themes, cover page, headers, footers and page numbers. HedgeDoc removed its PDF export for security reasons and suggests the browser's print function; its FAQ names HedgeDoc 2.1 as the earliest version to bring it back.
- **Paged preview and themes.** markoto shows A4 or Letter pages as you type. Themes set fonts, colours, margins and columns, and can be saved and shared in a workspace.
- **A hosted option.** If you don't want to run a server, markoto.app has a free plan and stores your data in the EU (OVHcloud, France).
- **Workspaces and comments.** Teams share documents in workspaces with admin, editor and viewer roles, and discuss passages in comment threads.
- **AI writing assistant.** markoto's assistant edits the document, answers in comments and can use files uploaded to a workspace. Self-hosters choose the AI provider, including local models.
- **Import.** markoto converts DOCX, PDF, PPTX, XLSX, HTML and EPUB into Markdown.

## Who should pick which

Pick **HedgeDoc** if you need an OSI open source licence, want slides from your notes, or want the lightest possible server for shared notes.

Pick **markoto** if your documents have to come out as good-looking PDFs, if you want a hosted option next to self-hosting, or if you want workspaces and an AI assistant in the same tool.

## Moving from HedgeDoc to markoto

Download a note as Markdown from HedgeDoc and import it with **File › Import**, or paste it into a new document. Standard Markdown, tables, footnotes, LaTeX math and Mermaid diagrams carry over. HedgeDoc-specific syntax, such as slide separators or embeds, shows as plain text.

## Questions

::faq{json-ld}
---
items:
  - q: Is markoto open source like HedgeDoc?
    a: No. markoto is source-available under the Functional Source License (FSL-1.1), which becomes Apache-2.0 two years after each release. HedgeDoc is open source under the AGPL-3.0.
  - q: Can I self-host markoto?
    a: Yes, for free. One install script sets it up with Docker Compose on a Linux server with about 6 GB of RAM.
  - q: Does markoto export PDF?
    a: Yes. The PDF is rendered on the server from the same paged layout you see in the preview.
  - q: Does markoto have slide mode?
    a: No. markoto makes paged documents, not presentations.
---
::

::cta{title="See your HedgeDoc notes as pages." label="Read the self-hosting guide" to="/docs/self-hosting" secondary-label="All comparisons" secondary-to="/compare"}
Or try markoto.app first: free, no sign-up needed.
::

<!-- Sources for our own periodic fact checks (content/compare/hedgedoc.yml), not shown on the page:
::compare-sources{competitor="hedgedoc"}
::
-->

::compare-note{competitor="hedgedoc"}
::
