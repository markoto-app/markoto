---
title: Ask the AI for current information
description: The AI's grounded-search tool answers from live web results — names, prices, news, anything time-sensitive.
category: writing
order: 10
---

# Ask the AI for current information

Gemini ships with a Google-grounded search tool. When your prompt asks
something time-sensitive — "what's the current Stripe pricing for
seats?", "who won the F1 race last weekend?" — the AI calls
`google_search`, gets back the live grounded result with citations,
and writes its reply attributing the source.

::flow{id="ask-the-ai-for-current-information" hide-title}
::

## What just happened

The grounded-search tool runs through Google's search infrastructure
on the AI side — your prompt was sent, search results were retrieved
+ summarised, and the reply you see carries citations to the sources
the model used. The citations render as inline links so you can verify
anything the AI claims.

When in doubt, ask the AI to cite. Gemini is good at it; we don't
post-process those citations away.

## What's next

- [Ask the AI to read a specific URL](/docs/writing/ai-fetch-url) — bypass search when you already know the source.
- [Ask the AI about a file you uploaded](/docs/writing/knowledge-rag) — for facts that live inside your workspace, not on the open web.
