---
title: Ask the AI about a file you uploaded
description: Upload PDFs, Word documents and more to a workspace, then let the AI answer from your files.
category: ai
order: 12
updated: '2026-11-03'
---

# Ask the AI about a file you uploaded

Every workspace has a **Knowledge** tab (also in the editor's right sidebar):
drop in PDFs, Word documents, slide decks, spreadsheets, HTML exports, the
team's RFCs and customer FAQs. When a prompt looks like a question about
those files, the AI searches them and answers from what it finds, including
facts that exist nowhere else.

This walkthrough uploads a launch postmortem and asks the AI to summarise
what it says about staged rollouts.

::flow{id="knowledge-grounded-ai" hide-title}
::

## What just happened

You uploaded a file, watched it process, then asked a question only the file
knows the answer to:

1. The file was converted to text, split into sections and indexed for both meaning-based and keyword search.
2. Your original upload was then deleted from storage. Only the extracted text and its index remain.
3. When you asked, the AI searched the index, got the most relevant passages and wrote its reply from them.

You can also ask the AI to open a whole file. Files are listed to the AI by
name, so it can't invent one that isn't there.

## What it needs

- **A writing assistant provider** to write the answer ([what the AI needs](/docs/ai/overview)).
- **Embeddings, which the instance provides.** On markoto.app they are provided for you. On a self-hosted instance the operator sets them up (a Mistral key by default, or any other embeddings provider); without them uploads fail with an error ([self-hosting guide](https://github.com/markoto-app/markoto/blob/main/docs/SELF-HOSTING.md#ai)).
- **Editor or admin role** in the workspace to upload files. The AI works for people who can edit a document, so workspace viewers can read documents but not use the AI.
- **It may ask first.** If the AI has already read text other people wrote in this session, a **markoto asks first** card appears above the prompt bar with **Allow** and **Deny**. [Why it asks](/docs/ai/prompt-bar#when-the-ai-asks-first).

## Supported files and limits

Supported: PDF, DOCX, PPTX, XLSX, HTML, EPUB, Markdown and plain text. Each
file can be up to 25 MB, and very long files are truncated after about 300
sections.

How much you can store depends on the instance. The hosted free plan is
small (a handful of files, tens of megabytes), and self-hosted instances
default to far more (500 files, 1 GiB per workspace, 10 GiB per person);
operators can change all of it. The Knowledge tab shows what you have used,
and uploads that would exceed a limit are refused with a message saying
which one.

Knowledge is workspace-scoped: only members can search it, and removing
someone from the workspace removes their access to it immediately.

## What's next

- [Polish the AI's grounded answer as a PDF](/docs/import-export/polished-pdf).
- [Tell the AI who you're writing for](/docs/ai/document-context): combine audience steering with your own sources.
- [Start a workspace](/docs/workspaces/start).
