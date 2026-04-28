---
title: Write with the AI prompt bar
description: Ask the AI to draft, rewrite, or restructure — it joins your document as a collaborator and you watch it type.
category: writing
order: 4
icon: i-lucide-sparkles
---

# Write with the AI prompt bar

The AI bar floats at the bottom of every document — type what you
want, hit send, and the AI joins as another collaborator. It can
draft new sections, rewrite passages, restructure outlines, or
fetch sources from the web before it writes. You watch the edits
land in real time, just like a human collaborator.

::flow{id="write-with-ai" hide-title}
::

## How it works

When you send a prompt, the server opens an agentic loop with
Gemini and authenticates the AI as a Y.js client on your document.
Every edit broadcasts through the same sync layer humans use, so
the AI's changes appear live alongside any concurrent edits from
your collaborators — no batch updates, no "wait for it to finish".

The AI has tools for reading the document, finding the right place
to insert text, replacing existing passages, generating images,
fetching URLs, and searching the web. It picks tools turn by turn
based on what you asked for; you don't have to tell it which to
use.

## Tips for good prompts

- **Be specific about location** — "add at the end", "after the
  section about X", "rewrite the first paragraph". The AI can
  figure it out from context, but explicit is faster.
- **Trust the doc context** — title, description, audience, and
  language are all sent on every prompt. You don't need to repeat
  "this is a marketing piece" each time.
- **Iterate** — short prompts that refine the previous turn beat
  one mega-prompt. Send "shorten that", "make it more formal", or
  "add a code example" rather than rewriting the whole brief.

## What's next

- [Summon AI inside a comment](/docs/writing/ai-comments) — ask the
  AI a question about a specific passage and it'll reply on the
  thread.
- [Discuss in your document](/docs/writing/comments) — comments
  work the same way, just with humans on the other end.
