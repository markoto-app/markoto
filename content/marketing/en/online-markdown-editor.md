---
title: Online Markdown editor with live page preview
description: Write Markdown in your browser and see it as printed pages while you type. No sign-up. Share a link, edit together, download .md or PDF.
keywords:
  - online markdown editor
  - markdown editor online free
  - markdown editor with preview
  - markdown live preview
updated: '2026-11-04'
navGroup: use-cases
navLabel: Online Markdown editor
navOrder: 20
---

# An online Markdown editor with a page preview

Type Markdown and the preview next to it shows the text as pages, as they will print. It runs in your browser and needs no account. Try it here:

::try-it{theme="modern"}
---
source: |
  # Meeting notes

  **Date:** 4 November · **With:** Maya, Sam

  ## Decisions

  1. Ship the beta on ==Monday==.
  2. Keep the old export for one more release.

  ## Action items

  - [ ] Maya: write the release notes
  - [ ] Sam: check the PDF on Letter paper
  - [x] Book the room

  | Topic   | Owner | Due    |
  |:--------|:------|:-------|
  | Beta    | Maya  | Mon    |
  | Pricing | Sam   | Fri    |
---
::

When you want to keep the text, **Open as a document** turns it into a real document with its own link. The full editor adds a formatting toolbar, menus, themes, comments and history.

## What you can do without an account

On markoto.app you can start writing straight away. Without an account you can:

- create documents and edit them with the full editor,
- share the link: anyone who has it can read and edit, live,
- import files and download Markdown or a PDF.

A document created without an account is deleted after 30 days without edits. The first time, markoto asks you to accept the terms and runs a short bot check in your browser.

A free account adds documents that belong to you and stay private until you share them, view-only and password-protected links, workspaces for a team, image uploads and the AI assistant. The [pricing page](/pricing) lists the limits.

## The preview shows pages

Most online Markdown editors show one long web page. markoto shows A4 or Letter pages with margins, headers, footers and page numbers, so you see where a table breaks or a heading lands before you print. The PDF uses the same layout.

::tour-clip{scene="write"}
::

## More than basic Markdown

Besides CommonMark and GitHub Markdown (tables, task lists, footnotes, alerts), the editor renders LaTeX math, Mermaid diagrams, highlighted code, a table of contents and page breaks. The **Insert** menu adds each of them for you if you don't remember the syntax. The [Markdown cheat sheet](/markdown-cheat-sheet) shows every example next to its result.

::flow-strip{id="rich-content" frames="20" caption="A code block, an alert, a formula and a Mermaid chart, rendered as you type."}
::

## Share a link

Every document has its own link. Copy it from the share dialog and send it; whoever opens it sees your changes as you type. Owners can make the link read-only or put a password on it, and the dialog also shows the link as a QR code. Details in the [sharing docs](/docs/sharing).

::flow-strip{id="quick-share" frames="13"}
::

## Your text stays Markdown

The document is plain Markdown, and **File › Export › Markdown** downloads it as a `.md` file. The theme and document settings go into a short frontmatter block at the top, which other tools ignore and markoto reads back when you import the file. **File › Import** opens `.md` files and converts Word, PDF, PowerPoint, Excel, HTML and EPUB files to Markdown.

## Limits

- **No offline mode.** The editor needs a connection to open a document. A short drop while you type is fine: your edits sync when you're back.
- **You edit the source.** The left side is Markdown text with a toolbar, not a word-processor view. The preview is read-only.
- **No suggestion mode.** Everyone with edit access changes the text directly. Every change is kept in the history with a diff and can be restored.
- **No desktop app.** markoto runs in the browser, on a computer or a phone.

Comparing editors? See markoto next to [HackMD](/compare/hackmd) and [HedgeDoc](/compare/hedgedoc).

## Questions

::faq{json-ld}
---
items:
  - q: Is the online Markdown editor free?
    a: Yes. Writing, sharing and exporting are free on markoto.app, with or without an account.
  - q: Do I need to sign up?
    a: No. You can create and share documents without an account. They are deleted after 30 days without edits. With a free account your documents are kept and private until you share them.
  - q: Is my text saved?
    a: The example on this page is not saved. A document is saved on the server as you type, and every change is kept in its history.
  - q: Can several people edit at the same time?
    a: Yes. Everyone who opens the link sees the others' cursors and changes live, without an account.
  - q: Can I download my document?
    a: Yes, as a Markdown file or as a PDF, from the File menu.
  - q: Does it work on a phone?
    a: Yes. On a phone the editor switches between writing and the page preview.
---
::

::cta{title="Start writing in your browser." secondary-label="Read the docs" secondary-to="/docs/getting-started/quick-share"}
A new document opens in a few seconds. No sign-up needed.
::
