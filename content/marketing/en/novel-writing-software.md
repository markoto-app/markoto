---
title: Novel writing software in the browser
description: Write a novel in Markdown in the browser. Chapters on new pages, comments from readers, a PDF that matches the preview, and an AI editor that only acts when you ask.
keywords:
  - novel writing software
  - write a novel online
  - manuscript software
  - novel writing app browser
  - share manuscript with beta readers
updated: '2026-11-19'
navGroup: use-cases
navLabel: Novel writing
navOrder: 100
---

# Novel writing software that runs in the browser

You write the book as plain text, in Markdown. markoto lays it out as manuscript pages while you type, lets readers comment on the passages they mean, and gives you a PDF that looks like the preview. If you want help, an AI assistant can tighten a paragraph or answer a question about your notes. It does that when you ask, and every change it makes can be undone.

::tour-clip{scene="write"}
::

## A manuscript, not a web page

The **Novel manuscript** template sets the book the way a manuscript is set: a title page with the title and your name, an optional epigraph alone on its page, and chapters that each start on a new page, numbered by the layout. A chapter is a heading, so there is nothing to renumber when you move one. A scene break is a line with `* * *`; the layout sets it as three spaced asterisks and starts the next paragraph flush.

::page-shots{caption="The title page of the manuscript template."}
---
pages:
  - src: /template-thumbs/manuscript.webp
    alt: Title page of the manuscript template with the book title, the subtitle A novel and an author name.
---
::

The status bar shows your word count as you write and, in the preview, the page count. Fonts, margins and the running header are set in the document theme if you want a different look. Details: the [novel manuscript template](/templates/manuscript).

::cta{title="Start a manuscript." label="Use this template" template="manuscript" secondary-label="Read the docs" secondary-to="/docs/getting-started/templates"}
Opens the new-document dialog with the novel manuscript template selected. Free on markoto.app, no sign-up needed.
::

## Share chapters and collect comments

Send the link and your readers see the document in their browser: no install, no account for reading. Readers comment on a passage, you reply, and when the point is dealt with you resolve the thread. Comments stay attached to their words as you rewrite around them.

::flow-strip{id="have-a-discussion" frames="07,11"}
---
captions:
  - A comment lands on the passage it is about, with a yellow underline.
  - A reply appears under it as soon as it is sent.
---
::

A few things to know before you send the link:

- **Comments need edit access.** A read-only link lets people read but not comment. A link with edit access lets them comment, and also change the text; the history lets you see every change and restore an earlier state.
- **A password** can protect the link, so only people you give it to can open the document.
- **No account is needed to read.** Readers who want to comment still open the link in the browser.

## A PDF that matches the preview

**File › Export › PDF** downloads the pages you saw in the preview, with the title page, chapters on new pages and the running header. Send it to a reader who prefers paper, or print it. The PDF is made on our server from the saved document, so it takes a few seconds the first time.

::flow-strip{id="polished-pdf" frames="07" caption="A downloaded PDF: the cover and the first page of text, as they looked in the preview."}
::

## The AI as an editor, not a ghostwriter

The assistant sits in a prompt bar at the bottom of the document. It works on your text when you ask, in the places you point it to.

- **Rewrite a passage.** Select a paragraph and say what you want: shorter, calmer, less repetition. The selection is replaced in place, and the paragraphs around it are untouched.
- **Ask about a passage in a comment.** Mention `@markoto` in a comment on a sentence and it answers in the thread: does this paragraph sound like the character in chapter 2, what does this sentence assume the reader knows.
- **Change many chapters in one go.** Translate chapters 2 to 5, or change the register throughout. It tries the change on a sample, tells you how many sections it will touch and how long it takes, then works through them while you keep writing. You can cancel, and undo the whole job.
- **Check what you wrote.** Every AI edit shows in the Activity tab with a diff and a Restore button.

::flow-strip{id="rewrite-a-selection-with-the-ai" frames="07" caption="The wordy paragraph is now one short sentence, in place."}
::

The AI doesn't write a book from a prompt on its own initiative and never edits while you are not asking. Use it as little or as much as you like; the chat can also run on your own AI provider (Settings › AI provider), and without any AI the editor works the same.

## Research help

Notes, interviews, a historical source: upload them to a workspace's **Knowledge** tab (PDF, Word, slides, spreadsheets, HTML, Markdown and plain text). markoto reads them and indexes them by meaning and by exact words. When you ask the AI a question about them, it searches your files first and answers from what it finds, instead of from nothing.

::flow-strip{id="knowledge-grounded-ai" frames="20" caption="The AI answers from an uploaded file and quotes the facts that only the file contains."}
::

It can also search the web and read a page you link, and it says where the answer came from. Knowledge storage on the free plan on markoto.app is small, a handful of files; on a self-hosted instance it is as large as the operator sets it.

## Keep every draft

Every edit is recorded, whoever made it. Restore the book to how it was yesterday, or compare what a reader changed. On markoto.app's free plan history reaches back 30 days; a self-hosted instance has no limit. The text is a Markdown file that you can download at any time, and you can import a manuscript you already have in Word (File › Import).

## Where it stops

- **A manuscript is one document.** Chapters are headings in it. You can keep chapter drafts as separate documents in a folder, but markoto doesn't assemble them into one book.
- **No corkboard, binder or writing targets.** There are no index cards, no research folder beside the draft and no daily word goal. The status bar counts words.
- **Output is a PDF, a Markdown file or a published web page.** For a typeset book for print you will want a layout tool after the writing is done.
- **Images need an account.** Without one you can't upload images into a document.

See [markoto vs Scrivener](/compare/scrivener) for a longer comparison.

## Private by default, hosted in the EU

With an account, your documents are private until you share them. markoto.app is hosted in the EU and operated by a Swiss company; documents are stored in France. The AI uses EU-based providers and sends nothing to them unless you use an AI feature. Details are on the [EU hosting page](/eu-markdown-editor).

## Questions

::faq{json-ld}
---
items:
  - q: Can I write a whole novel in markoto?
    a: Yes. A manuscript is one Markdown document with chapters as headings, laid out as manuscript pages, with a title page and chapters that start on new pages. Every edit is kept in the history.
  - q: Can beta readers comment on my chapters?
    a: Yes. Anyone with edit access to the document can comment on a passage, reply and resolve threads. A read-only link doesn't allow comments. Because edit access also lets people change the text, the history lets you see and undo what they changed.
  - q: Will the AI write my book?
    a: Only if you ask it to write something. It works on your text when you prompt it or mention it in a comment: rewrite a paragraph, answer a question about a passage, translate chapters. Every change is recorded and can be undone, and you can use markoto without any AI.
  - q: Can I upload my research and ask questions about it?
    a: Yes, in a workspace. Upload files to its Knowledge tab and the AI answers from them when you ask. The free plan on markoto.app allows a few files; a self-hosted instance allows more.
  - q: Can I move my manuscript out of markoto?
    a: Yes. Download the text as a Markdown file at any time, or export the paged PDF.
  - q: Where is my manuscript stored?
    a: markoto.app is hosted in the EU, with documents stored in France, and operated by a Swiss company. You can also run markoto on your own server.
---
::

::cta{title="Write the book. Let the pages take care of themselves." secondary-label="All templates" secondary-to="/templates"}
Free on markoto.app, no sign-up needed to start.
::
