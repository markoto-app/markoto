---
title: Summon markoto inside a comment
description: Mention @markoto in any comment thread to ask a question about a specific passage. markoto reads the anchor, replies, or edits the doc.
category: writing
order: 5
icon: i-lucide-message-square-dashed
updated: '2026-11-04'
---

# Summon markoto inside a comment

The prompt bar at the bottom suits "rewrite the whole section"
prompts. For a question about one specific passage, use a comment so
the anchor stays attached. Mention `@markoto` inside
any comment and markoto joins the thread, reads the anchored text
and the conversation so far, and replies in the same place.

::flow{id="summon-ai-from-a-comment" hide-title}
::

## When to use this vs the prompt bar

- **Comment with @markoto**: when the question is about a *specific
  passage*. "What does this even mean?", "rewrite this clearer",
  "expand this into a paragraph". markoto sees the anchored text
  as the focus of the conversation.
- **Prompt bar**: when the change spans the whole document or
  doesn't have a single anchor point. "Add a section on X", "make
  the tone more formal across the board", "structure this as a
  meeting agenda".

Both work the same way; they differ in what markoto looks at first.

## How it works

1. Type `@markoto` in a comment and pick **markoto** from the mention
   list (or type the word in full).
2. When you post the comment, markoto reads the passage the thread is
   attached to, as if you had selected it.
3. The thread shows a rainbow ring while markoto works.
4. markoto reads the document, looks things up if it needs to, and posts
   its reply in the thread. If the thread has other participants and
   markoto wants to reach beyond the document (your other documents,
   workspace knowledge, the web), it asks you first in the prompt bar
   ([when the AI asks first](/docs/writing/ai-prompt-bar#when-the-ai-asks-first)).
   If you asked for an edit, it edits the passage directly and the reply
   summarises what changed.

## Good to know

- markoto only answers a mention in a comment **you** wrote; a mention
  inside someone else's comment does nothing. It runs on your AI provider
  and with your access, so it starts only when you ask.
- markoto never triggers itself: its own replies can't start another run.

## What's next

- [Write with the AI prompt bar](/docs/writing/ai-prompt-bar): the
  full-document version of the same AI.
- [Discuss in your document](/docs/writing/comments): the
  human-only side of the comments system.
