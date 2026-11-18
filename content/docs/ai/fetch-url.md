---
title: Ask the AI to read a URL
description: Paste any public URL into your prompt - the AI reads the page and grounds its answer in the content.
category: ai
order: 9
updated: '2026-11-15'
---

# Ask the AI to read a URL

When you need an answer grounded in a
specific page (a release note, a docs page, a blog post), drop the URL into
your prompt and the AI reads the page before it answers.

::flow{id="ask-the-ai-to-read-a-url" hide-title}
::

## What just happened

The AI saw a URL in your prompt and fetched the page through a page-reader
service (Jina Reader). The page is converted to clean text, and the AI
summarises it and uses it as the source for its reply. The page is fetched
by the server, so the site never sees your own address.

## Good to know

- **Public pages only.** Addresses on private networks, local addresses and non-web schemes (`file:`, `ftp:`) are refused. A page behind a login can't be read; paste the text into your document instead.
- **It needs to be set up.** Page reading only appears when the instance has a Jina key (`JINA_AI_API_KEY` on a self-hosted instance). Without one the AI doesn't offer it.
- **Each page uses 1 AI Point.** Reading the page is paid for by the instance, so it counts against your monthly [AI Points](/docs/plans/ai-budget), also when you use your own provider. When your points are used up, the AI tells you and reads no more pages until they refill.
- **You still need a writing assistant provider** to summarise the page ([what the AI needs](/docs/ai/overview)). Without one, the raw page text comes back.
- **Shared allowance.** Page reading and web search share a per-person limit, by default 30 calls an hour and 100 a day. At most 10 pages per AI session.
- Scheme-less addresses such as `example.org/page` work; `https://` is assumed.
- **It may ask first.** If the AI has already read text other people wrote in this session, a **markoto asks first** card appears above the prompt bar with **Allow** and **Deny**. [Why it asks](/docs/ai/prompt-bar#when-the-ai-asks-first).

## What's next

- [Ask the AI to search the web](/docs/ai/web-search): for when you don't have a specific URL.
- [Ask the AI about another doc](/docs/ai/cross-doc): same idea, but inside markoto.
