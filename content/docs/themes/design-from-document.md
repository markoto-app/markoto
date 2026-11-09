---
title: Create a design from a document
description: Upload a PDF or Word file in your organisation's design and markoto builds a matching design for your new documents.
category: themes
order: 6
updated: '2026-11-09'
---

# Create a design from a document

Your organisation already has a look: a letter template, a report with a
coloured cover, a brochure. Upload one of those files and markoto builds
a design from it, with the same fonts (or the closest ones it offers),
colours, page size, margins, headings, header and footer.

## How to do it

1. Open the **Theme** tab of any document.
2. Click **Create a design from a document**.
3. Choose a PDF or Word (`.docx`) file of up to 20 MB.
4. Wait while markoto reads the file and designs. This takes about half a
   minute.
5. Compare your document with the new design, page by page.
6. Give the design a name and click **Save as my design**. It now appears
   under your themes and in the design picker for new documents. Or click
   **Apply to this document** to use it right away.

## What you need

The design runs on your AI provider, like any other AI request in markoto.
The model has to be able to read images, because markoto shows it pictures
of your pages. If yours can't, markoto says so and links to the AI
settings. A run makes up to three requests with page pictures.

## What gets carried over

- **Fonts.** markoto doesn't upload font files. Each font in your file is
  replaced by the closest font markoto offers. The dialog lists every
  replacement, for example "Calibri → Lato".
- **Colours, sizes and spacing** are measured from the file.
- **Word files** are read from their styles (Title, Heading 1, Normal and
  so on), so the result follows what the template defines. A PDF is read
  from its pages.
- **Logos and images** are not carried over. Add your logo afterwards in
  the theme's cover settings.

The text of your file is not copied into the design. Short fixed text in
the header or footer, such as your organisation's name, can be.

## Your file

Your file is read in an isolated converter and deleted from storage as
soon as markoto has read it. Its measured styles, pictures of its first
pages and a short sample of its text go to your AI provider to build the
design. Nothing is kept except the design you save.

## Not quite right?

The result is a normal theme. Open the theme settings and adjust what you
like, or add [your own CSS](/docs/themes/custom-css). You can also try
another file: a page with headings, body text and the header and footer
gives the best result.
