---
title: Novel manuscript template in Markdown
description: A manuscript template for a novel or story collection in Markdown. Title page, epigraph, chapters on new pages, scene breaks, ready as a PDF to share.
keywords:
  - novel manuscript template
  - manuscript template markdown
  - fiction manuscript format
  - novel template pdf
  - write a novel in markdown
updated: '2026-11-19'
navGroup: templates
navLabel: Novel manuscript template
navOrder: 110
---

# Novel manuscript template in Markdown

A manuscript has a few formatting rules that matter and many that don't. This template follows the ones that do: a title page, chapters that start on a new page, a scene break between scenes, and the book's title running at the top of the pages. You write the story in plain Markdown and the **Manuscript** theme does the layout.

Below is the opening of a made-up novel. Edit it and the pages follow.

::try-it{theme="manuscript" height="760"}
---
source: |
  # The Salt Road

  > The road remembers every foot that has left it.
  >
  > Old proverb

  # The Ferryman's Daughter

  Mara counted the lamps on the far bank twice before she let herself believe one was missing.

  "Father," she said. "The Ostler's light is out."

  He did not look up from the rope he was mending. "Then the Ostler is asleep."

  * * *

  By midnight the whole village knew. By morning the ferry had been taken.

  # What the Water Kept

  The river gave back the boat on the ninth day, empty, with a single coat folded on the seat.
---
::

::page-shots{caption="The first page of the manuscript template: the title page with the title, subtitle and author."}
---
pages:
  - src: /template-thumbs/manuscript.webp
    alt: Title page of the manuscript template with a book title, the subtitle A novel and an author name.
---
::

::cta{title="Start your manuscript from this template." label="Use this template" template="manuscript" secondary-label="All templates" secondary-to="/templates"}
Opens the new-document dialog with the manuscript template selected: the text and the Manuscript theme in one. It starts with a title page, an optional epigraph and two chapters.
::

## What's in it

- **Title page.** The title, the subtitle ("A novel") and the author, set under **Cover page** in the document theme. The book title also runs at the top of the pages.
- **Epigraph.** An optional quotation alone on its page, with its source in its own paragraph.
- **Chapters.** Every chapter is a top-level heading without a number. The design numbers the chapters, starts each on a new page and sets its first words in small capitals. Add `[[toc]]` where the book needs a contents page.
- **Scene breaks.** A line with `* * *` or `---` inside a chapter becomes three spaced asterisks, and the next paragraph starts flush.
- **Briefs.** A short note under each heading on how to open a chapter, how to end it and how to set dialogue. They are Markdown comments: visible in the editor and to the AI assistant, never on the page.

## Writing the book in markoto

- **Moving chapters.** Ask the AI to swap two chapters and it moves each with all its scenes, in one edit you can undo.
- **Word and page count.** The status bar shows the words in the document and, in the preview, the number of pages.
- **Every draft kept.** Every edit is recorded and you can restore an earlier state. On markoto.app's free plan history reaches back 30 days; a self-hosted instance has no limit.
- **A file you own.** The text is a Markdown file you can download whenever you like.

## What it doesn't do

A manuscript here is one document. There is no manuscript folder that assembles chapter files into one book, and no corkboard or writing targets. markoto makes a PDF, a Markdown file and, if you wish, a published web page. For a longer comparison with a dedicated novel-writing tool, see [markoto vs Scrivener](/compare/scrivener).

## Questions

::faq{json-ld}
---
items:
  - q: Does each chapter start on a new page?
    a: Yes. The Manuscript theme starts every top-level heading on a new page, numbers it and sets the first words in small capitals.
  - q: How do I mark a scene break?
    a: Put a line with * * * or --- between the scenes. The theme sets three spaced asterisks and starts the next paragraph flush.
  - q: Can I keep every chapter in its own file?
    a: Not as one book. A manuscript is one document, with chapters as headings. You can keep chapters as separate documents in a folder, but markoto doesn't combine them into one PDF.
  - q: Can beta readers comment on a chapter?
    a: Yes. Anyone with edit access to the document can comment on a passage, reply and resolve threads. A read-only link lets people read but not comment.
---
::

::cta{title="Write the book. The pages take care of themselves." label="Use this template" template="manuscript"}
Free on markoto.app, no sign-up needed.
::
