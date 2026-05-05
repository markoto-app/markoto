---
title: Ask the AI about another doc
description: Reference a different doc by URL or title — the AI reads it and uses it in its reply.
category: writing
order: 8
---

# Ask the AI about another doc

The AI has a `read_document` tool that pulls another doc you can
access into its working context. Reference one by URL ("summarise
the meeting notes at /d/abc123") or by title ("pull in the spec doc")
and the AI fetches the markdown server-side, applies the same access
rules a human would hit, then folds the content into its reply.

::flow{id="ask-the-ai-about-another-doc" hide-title}
::

## What just happened

The AI invoked `read_document` with the doc id you mentioned. The tool
re-runs the same authorisation a `GET /api/docs/:id` would (your
session, doc access mode, workspace role if applicable), so the AI
can never reach a doc you wouldn't be able to open yourself.

The fetched markdown is added as a tool-result message, then the AI
generates its real reply. Per-session interaction caps still apply —
each `read_document` call is one interaction.

## What's next

- [Ask the AI about a file you uploaded](/docs/writing/knowledge-rag) — same retrieval shape, but for workspace knowledge.
- [Ask the AI to read a URL](/docs/writing/ai-fetch-url) — pull in any external page.
