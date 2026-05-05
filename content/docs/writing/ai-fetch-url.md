---
title: Ask the AI to read a URL
description: Paste any URL into your prompt — the AI fetches the page and grounds its answer in the content.
category: writing
order: 9
---

# Ask the AI to read a URL

Models drift; the web doesn't. When you need an answer grounded in a
specific page — a release note, a docs page, a blog post — drop the
URL into your prompt and the AI's `fetch_url` tool retrieves the
content server-side and feeds it back into the conversation.

::flow{id="ask-the-ai-to-read-a-url" hide-title}
::

## What just happened

The AI saw a URL in your prompt and called `fetch_url`. The tool
fetches the page server-side (so the AI never sees your IP), strips
chrome, converts the body to markdown via the same markitdown sidecar
that handles imports, and returns it as a tool result. The AI then
writes its reply using that markdown as ground truth.

Limits: 10 MB per fetch, follows up to three redirects, respects
`robots.txt` directives that disallow user-agent scraping.

## What's next

- [Ask the AI to search the web](/docs/writing/ai-web-search) — for when you don't have a specific URL.
- [Ask the AI about another doc](/docs/writing/ai-cross-doc) — same idea, but inside markoto.
