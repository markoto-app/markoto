---
title: 'markoto vs Obsidian: notes app or shared document?'
description: markoto and Obsidian side by side - local files or the browser, Sync and Publish, live co-editing, PDF export, plugins and prices. Facts checked at the source.
keywords:
  - markoto vs obsidian
  - obsidian alternative
  - obsidian collaboration
  - obsidian publish alternative
  - obsidian real-time collaboration
updated: '2026-11-25'
navGroup: compare
navLabel: markoto vs Obsidian
navOrder: 50
---

# markoto vs Obsidian

Both write Markdown, but they solve different problems.

**Obsidian** is a personal knowledge base. Your notes are plain Markdown files on your own device, linked to each other, and work offline. Thousands of community plugins and themes change almost everything about it. Obsidian Sync and Obsidian Publish are paid add-ons for syncing between devices and putting notes on a website.

**markoto** is for documents that several people write together and that end up as pages: reports, papers, proposals, handouts. It runs in the browser, people edit the same text at the same time, and the preview shows printed pages that the PDF matches.

Many people use both: Obsidian for their own notes, markoto when a note becomes a document someone else has to read, edit or print.

## Feature comparison

::compare-facts{competitor="obsidian"}
::

## Where Obsidian is better

- **Your files, on your device.** Obsidian keeps notes as plain Markdown files in a folder you own. You can back them up, put them in Git or open them in any editor. markoto stores documents on a server; you download Markdown to get a file.
- **Offline.** Obsidian works without a connection on desktop and mobile. markoto needs one; it only keeps edits made during a short drop.
- **Linked notes.** Links between notes, a graph view and Canvas for laying ideas out. markoto has separate documents and no links or graph between them.
- **Plugins.** Thousands of community plugins and themes add tasks, calendars, spaced repetition, other export formats and much more. markoto has no plugin system; you change a document's look with themes and custom CSS.
- **End-to-end encrypted sync.** Obsidian Sync encrypts your vault end to end, and you can pick a Frankfurt region. markoto is encrypted in transit and at rest, but its servers can read documents.
- **Free for any use, closed or not.** The Obsidian app costs nothing, for work too; the commercial licence is optional.

## Where markoto is better

- **Live co-editing.** Several people type in the same document at once and see each other's cursors. Obsidian's shared vaults sync files between up to 20 people and merge changes; Obsidian says live editing of the same file is not supported yet.
- **Nothing to install, no account needed to join.** A markoto document opens in any browser. Anyone with the link can edit it, without signing up, if the owner allows it.
- **Pages and PDF.** markoto shows A4 or Letter pages as you type, with print themes, cover page, headers, footers, page numbers and a table of contents with page numbers. Obsidian's built-in PDF export sets page size and margins; headers, footers and page numbers need plugins, and it doesn't export on mobile.
- **Comments and history for everyone in the document.** Threads anchored to the text, and every edit with a diff and restore (30 days back on the free plan on markoto.app, unlimited when you self-host). Obsidian keeps file versions with Sync (1 or 12 months).
- **AI assistant.** markoto's assistant edits the document, answers in comments and can use files uploaded to a workspace. It runs on your own AI provider, or on a small monthly allowance on markoto.app.
- **Self-hosting.** markoto is source-available and installs on your own server with Docker Compose. Obsidian Sync and Publish are services hosted by Obsidian.

## Prices

On markoto.app the free plan has no price but has limits (for example 30 days of history and 3 members per workspace); Pro lifts them for 9 euros or Swiss francs a month (90 a year), and Team and Business cost 12 and 20 a month per seat for a workspace ([pricing](/pricing)). Self-hosted instances have no plan limits. Obsidian's app is free; Sync costs $4 per user a month billed annually ($5 monthly), Sync Plus $8 ($10 monthly), and Publish $8 per site a month billed annually ($10 monthly). Prices checked on the date below.

## Who should pick which

Pick **Obsidian** for your own notes and knowledge base, especially if you want local files, offline use, links between notes or plugins.

Pick **markoto** when several people write one document at the same time, when the result has to be a laid-out PDF, or when the people you work with shouldn't have to install anything.

## Moving between them

Both use Markdown, so a note moves by copy and paste, or with **File › Import** of the `.md` file in markoto. Headings, lists, tables, footnotes, math between dollar signs and Mermaid diagrams carry over. Obsidian-specific syntax such as `[[wiki links]]` and embeds shows as plain text in markoto. Callouts like `> [!NOTE]` render as alerts when they have no custom title. To go back, download the document as Markdown.

## Questions

::faq{json-ld}
---
items:
  - q: Can several people edit an Obsidian note at the same time?
    a: Not live. Obsidian Sync can share a vault with up to 20 people and merges their changes, but Obsidian states that live co-editing of the same file is not supported yet. markoto is built for live co-editing.
  - q: Is markoto a replacement for Obsidian?
    a: Not for a personal knowledge base. markoto has no linked notes, no graph, no plugins and no offline mode. It replaces the step where a note becomes a shared document or a PDF.
  - q: Can I open my Obsidian vault in markoto?
    a: Not as a vault. You can import single Markdown files or paste their text into a document.
  - q: Is markoto free?
    a: Yes. markoto.app has a free plan, including live collaboration and PDF export. Paid plans (Pro for one person, Team and Business per seat for a workspace) raise the limits. Self-hosting is free too.
  - q: Is markoto open source?
    a: markoto is source-available under the Functional Source License (FSL-1.1). Each release becomes Apache-2.0 two years after it is published. Obsidian is proprietary.
---
::

::cta{title="Turn one of your notes into a shared document." secondary-label="All comparisons" secondary-to="/compare"}
Paste the Markdown into a new document, send the link, and see it as pages. No sign-up needed.
::

<!-- Sources for our own periodic fact checks (content/compare/obsidian.yml), not shown on the page:
::compare-sources{competitor="obsidian"}
::
-->

::compare-note{competitor="obsidian"}
::
