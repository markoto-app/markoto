---
title: Getting Started
description: Your first ten minutes with YPad
order: 1
---

# Getting Started

Welcome! YPad is a collaborative markdown editor built around CRDT sync,
optional auth, and per-document themes that drive both the live preview
and the PDF export.

This guide walks you through your first session — creating a doc,
giving it a title, and sharing it with a collaborator.

## Create your first document

You can start a document anonymously — no signup required. The screenshots
below are captured directly from the running app, so they always reflect
the current UI.

::flow{id="create-a-new-document"}
::

Once you have a doc, you'll probably want to share it.

## Just want the highlights?

Same flow, paginated:

::flow{id="create-a-new-document" mode="slides" hide-title}
::

## Side-by-side comparison

Embedding the same flow twice with different presentations — useful when
you want a quick visual comparison without writing two tests:

::div{class="grid grid-cols-1 lg:grid-cols-2 gap-4 not-prose"}
  ::flow{id="create-a-new-document" images-only hide-title show-cursor="false"}
  ::

  ::flow{id="create-a-new-document" mode="slides" images-only hide-title}
  ::
::

## What's next?

- See [Sharing & Permissions](/docs/sharing) for the full access-mode reference.
- See [Workspaces](/docs/workspaces) for team collaboration.
- See [The AI assistant](/docs/ai) for prompts, voice input, and dictation.
