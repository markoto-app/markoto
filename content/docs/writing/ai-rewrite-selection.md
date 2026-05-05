---
title: Rewrite a selection with the AI
description: Highlight a paragraph, ask the AI to rewrite it — your prose tone, your audience, in place.
category: writing
order: 7
---

# Rewrite a selection with the AI

The AI prompt bar is the front door for "draft this from scratch", but
when you already have prose you like-but-not-quite, the rewrite path
is faster: select the text, hit the prompt bar, type what you want
changed. The AI rewrites in place, the original is undoable.

::flow{id="rewrite-a-selection-with-the-ai" hide-title}
::

## What just happened

Selecting before opening the prompt bar switches it into **selection
mode** — a small badge appears next to the input, and the system prompt
gets a `<selection>...</selection>` block prepended so the AI knows
*which* prose to rewrite. The reply replaces the selection rather than
inserting at the caret.

The same model + tools as a regular prompt; same per-tool caps; the
same `audience` / `language` / `description` from your Document tab.

## What's next

- [Tell the AI who you're writing for](/docs/writing/document-context) — set audience + language so rewrites land in the right register.
- [Have the AI extend a passage from a comment](/docs/writing/ai-comments) — same idea, different surface.
