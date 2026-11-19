---
title: Newsletter template in Markdown with PDF export
description: A print newsletter template in Markdown with masthead, two columns, lead story, pull quote, dates table and short items, ready as a PDF for clubs and schools.
keywords:
  - newsletter template markdown
  - club newsletter template
  - school newsletter template pdf
  - printable newsletter template
  - newsletter pdf from markdown
updated: '2026-11-19'
navGroup: templates
navLabel: Newsletter template
navOrder: 90
---

# Newsletter template in Markdown

A newsletter for a club, a school or a neighbourhood is often printed or sent as a PDF. This template sets an issue like a small paper: a masthead with the newsletter's name, an issue line, a lead story with a pull quote, a table of dates and a list of short items, in two columns.

Below is an issue written with the **Newsletter** theme. Edit the text and the columns reflow.

::try-it{theme="newsletter" height="760"}
---
source: |
  # The Lindenhof Gazette

  **Issue 4 · November 2026 · Published by the Lindenhof Village Association**

  ---

  # The bakery opens in March

  After two years without a baker, Lindenhof will have bread again. The co-op reached its goal of 400 member shares last week, and the lease for the old dairy was signed on Monday.

  > "We will bake six days a week."

  Members can still join until the end of the year. A share costs 450 francs.

  # Dates for your diary

  | Date | Time | Event | Place |
  |---|---|---|---|
  | Sat 14 Nov | 10:00 | Apple pressing | Village green |
  | Wed 18 Nov | 19:30 | Association meeting | Community hall |

  > [!NOTE]
  > The community hall is closed for repairs until 16 November; the meeting moves to the school.

  # Briefly

  - **Bins:** Collection moves to Tuesdays from December.
  - **Choir:** New members are welcome on Thursday evenings.

  ---

  *The Lindenhof Gazette appears four times a year. Contributions to gazette@example.org.*
---
::

::page-shots{caption="The first page of the newsletter template: masthead, issue line and a lead story in two columns."}
---
pages:
  - src: /template-thumbs/newsletter.webp
    alt: First page of the newsletter template with a masthead, an issue line and a lead story set in two columns.
---
::

::cta{title="Start your next issue from this template." label="Use this template" template="newsletter" secondary-label="All templates" secondary-to="/templates"}
Opens the new-document dialog with the newsletter template selected: the text and the Newsletter theme in one.
::

## What's in it

- **Masthead and issue line.** The document title becomes the newsletter's name; the bold line below it carries the number, month and publisher, and the rule under it closes the masthead.
- **Lead story.** 250 to 400 words, with a pull quote that repeats a short line of the story in large type.
- **Second story.** A shorter piece that ends with how readers can take part.
- **Dates for your diary.** A table of events in date order, and a note box for a practical notice.
- **Briefly.** Short items opening with a bold label.
- **Footer.** Who writes the newsletter, how often it appears and where contributions go.

The briefs under the headings are Markdown comments: visible in the editor, never in the PDF.

## What Markdown gives you here

- **Photos.** Put an image right under a headline with `![Caption.](image){width=100%}`. Uploading images needs an account.
- **Two columns,** set by the theme, with each article's headline across both.
- **Several people writing.** The treasurer adds the dates, the editor the lead story, all in the same document at the same time.

## Sending it

Download the PDF and print it or email it. Or publish the issue as a web page: a snapshot at its own address that anyone can read in a browser, on a phone too. markoto does not send email; it makes the issue, you distribute it.

## Questions

::faq{json-ld}
---
items:
  - q: Does markoto send the newsletter by email?
    a: No. markoto makes the issue as a PDF or a web page. You send the PDF or the page address yourself.
  - q: Can several people write one issue?
    a: Yes. Everyone with the link edits the same document live and sees the others' cursors. Comments and the edit history are included.
  - q: Can I add photos?
    a: Yes, with an account. Drag an image into the document, or use the Markdown image syntax with a width. Without an account you can't upload images.
  - q: Can I use the same layout for the next issue?
    a: Yes. With an account, duplicate the last issue and replace the text, or keep the template's layout as a saved theme.
---
::

::cta{title="A club newsletter that prints like one." label="Use this template" template="newsletter"}
Free on markoto.app, no sign-up needed.
::
