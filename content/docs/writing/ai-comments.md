---
title: Summon AI inside a comment
description: Mention @ai in any comment thread to ask a question about a specific passage. The AI reads the anchor, replies, or edits the doc.
category: writing
order: 5
icon: i-lucide-message-square-dashed
---

# Summon AI inside a comment

The prompt bar at the bottom is great for "rewrite the whole
section" prompts — but when you have a question about one specific
passage, you don't want to lose the anchor. Mention `@ai` inside
any comment and the AI joins the thread, reads the anchored text
and the conversation so far, and replies in the same place.

::flow{id="summon-ai-from-a-comment" hide-title}
::

## When to use this vs the prompt bar

- **Comment with @ai** — when the question is about a *specific
  passage*. "What does this even mean?", "rewrite this clearer",
  "expand this into a paragraph". The AI sees the anchored text
  as the focus of the conversation.
- **Prompt bar** — when the change spans the whole document or
  doesn't have a single anchor point. "Add a section on X", "make
  the tone more formal across the board", "structure this as a
  meeting agenda".

Both surfaces drive the same agentic loop server-side; the only
difference is what context the AI sees up front.

## How the trigger works

1. You type `@ai` in a comment composer. The mention typeahead
   includes a synthetic "AI Assistant" entry — pick it (or just
   type the bare word).
2. When you submit, the server detects `@ai` via a word-boundary
   regex, opens an agentic loop, and synthesizes an editor-state
   selection from the comment's anchor so the AI sees the
   passage as if you'd selected it.
3. The thread lights up with a rainbow ring while the AI works.
4. The AI uses tools to read the document, find sources if needed,
   and post a reply on the thread when it's done. If you asked
   for an edit, it edits the anchored span directly and the reply
   summarises what changed.

## Loop guards

- The AI's own messages are detected and excluded from re-triggering — it
  can't summon itself.
- AI-authored comment bodies have `@ai` stripped before they're
  posted, so the AI's reply can't accidentally re-trigger either.

## What's next

- [Write with the AI prompt bar](/docs/writing/ai-prompt-bar) — the
  full-document version of the same AI.
- [Discuss in your document](/docs/writing/comments) — the
  human-only side of the comments system.
