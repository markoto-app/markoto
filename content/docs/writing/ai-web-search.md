---
title: Ask the AI for current information
description: The AI's grounded-search tool answers from live web results — names, prices, news, anything time-sensitive.
category: writing
order: 10
---

# Ask the AI for current information

When your prompt asks something time-sensitive — "what's the current
Stripe pricing for seats?", "who won the F1 race last weekend?" — the
AI calls its `web_search` tool. The tool fetches live web results via
Jina Reader, hands them to Mistral for synthesis, and writes its reply
attributing the source.

::flow{id="ask-the-ai-for-current-information" hide-title}
::

## What just happened

The grounded-search tool runs as a 2-call sub-pipeline on the AI side
— Jina Reader pulls in fresh web results for your query, Mistral
synthesises a 3–6 sentence answer, and the reply you see carries
citations to the sources the model used. The citations render as
inline links so you can verify anything the AI claims.

When in doubt, ask the AI to cite. The model is good at it; we don't
post-process those citations away.

## What's next

- [Ask the AI to read a specific URL](/docs/writing/ai-fetch-url) — bypass search when you already know the source.
- [Ask the AI about a file you uploaded](/docs/writing/knowledge-rag) — for facts that live inside your workspace, not on the open web.
