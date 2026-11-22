---
title: Keep a project bible for the AI
description: Mark documents as AI context (characters, glossary, style guide, product facts) and the AI respects them in every document they apply to.
category: ai
order: 8
updated: '2026-11-19'
---

# Keep a project bible for the AI

Some facts should hold in every document of a project: who your
characters are and how old, what the town is called, which product names
you use and which words you avoid, the level of your course. Keep them in
ordinary documents and mark those as **AI context**. Whenever you ask the
AI for help in a document they apply to, it reads them first, so you
don't have to repeat them in every prompt.

This walkthrough marks a story bible as AI context for a whole workspace,
checks that a chapter uses it, and asks the AI for an opening scene that
names a town and a ferry only the bible mentions.

::flow{id="keep-a-project-bible" hide-title}
::

## Mark a document as AI context

Any document can be AI context. Right-click it in the documents list and
choose **Use as AI context**, or open it and pick a choice under
**AI context** in the Document tab:

- **For this folder**: the AI reads it in every document of its folder
  and the folders below it. A document at the top level of a workspace
  applies to the whole workspace.
- **For the whole workspace**: the AI reads it in every document of the
  workspace, wherever the context document itself is filed. Keep all your
  bible documents in one "Bible" folder and mark each of them this way.
- For your personal documents the same choices apply to your own folders,
  or to **all my documents**.

Marked documents carry an **AI context** badge in the documents list.
Anyone who may edit a document can mark or unmark it.

Typical context documents:

- a novel: characters, places, a timeline, the style of the narration;
- a company: a glossary, a style guide, product facts and prices;
- a course: the audience, their level, the curriculum it follows;
- a thesis: the terminology and the citation style.

## Attach context to one document

To use a document as context in just one other document, open that
other document's Document tab and search for it under **Attach a
document**. You can attach up to ten. The list under **Context the AI
reads here** shows everything the AI uses in the current document and
why: the whole workspace, the folder, or attached here.

## What the AI does with it

The AI treats the facts, names, terminology and style in your context
documents as authoritative for what it writes, unless your request says
otherwise. If your document or your request contradicts the bible, it
follows your request and points out the conflict.

Context documents are reference material, not commands: the AI ignores
instructions written inside them, such as "read the other documents" or
"open this link".

Long context documents are not sent whole. The AI gets their outline and
reads the sections it needs. Up to twelve context documents apply to one
document; the Document tab tells you when more are left out.

## Update the bible from a chapter

Ask the AI to change a context document, for example "add the new
character Jonas to the bible". It edits that document like any other AI
edit, visible and undoable in its Activity Log. When the AI has read
text other people wrote in the current session, it asks you first, as it
does before it reaches any of your other documents. When the AI
[suggests instead of editing](/docs/collaborate/suggestions#let-the-ai-suggest),
or the context document requires suggestions of you, the change arrives
there as suggestions to accept or reject.

## Who sees what

The AI only uses a context document for people who may open it
themselves. A guest who was given one chapter doesn't get the workspace's
bible in their AI requests unless it was shared with them too. Marking a
document as context never gives anyone access to it.

Tools connected over [MCP](/docs/ai/mcp) can read a document's project
context too, with the same rule.

## What's next

- [Tell the AI who you're writing for](/docs/ai/document-context): the
  audience and language of each document.
- [Ask the AI about a file you uploaded](/docs/ai/knowledge-rag): large
  sources the AI searches instead of reading in full.
