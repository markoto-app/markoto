---
title: Ask the AI for current information
description: The AI can search the web and answer from live results, with sources - names, prices, news, anything time-sensitive.
category: ai
order: 9
updated: '2026-11-15'
---

# Ask the AI for current information

When your prompt asks something time-sensitive ("what's the current Stripe
pricing for seats?", "who won the F1 race last weekend?"), the AI searches
the web, reads the results and answers with sources. You don't have to ask
for a search: it decides from your prompt.

::flow{id="ask-the-ai-for-current-information" hide-title}
::

## What just happened

The AI sent a search query to a European search provider (Staan), got back a
ranked list of results, and wrote a short answer from them. The reply
carries links to the sources it used, so you can verify anything it claims.
When in doubt, ask it to cite.

## Good to know

- **It needs to be set up.** Web search only appears when the instance has a search key. On a self-hosted instance the operator adds a search key ([self-hosting guide](https://github.com/markoto-app/markoto/blob/main/docs/SELF-HOSTING.md#ai)); without it the AI doesn't offer search.
- **Each search uses 5 AI Points.** The search itself is paid for by the instance, so it counts against your monthly [AI Points](/docs/plans/ai-budget), also when you use your own provider. When your points are used up, the AI tells you and searches no more until they refill.
- **You still need a writing assistant provider.** The AI that reads the results and writes the answer runs on your own provider or the instance default ([what the AI needs](/docs/ai/overview)). Without a provider, the raw results come back unsummarised.
- **There is an allowance.** Search and page reading share a limit per person: by default 30 calls an hour and 100 a day (on markoto.app's free plan 30 an hour and 20 a day). When it is used up the AI tells you and carries on without the web. An instance operator can change the numbers.
- **Per session** the AI searches at most 10 times, so one prompt can't run away.
- Searches are English-market searches today; the AI can still write the answer in your document's language.
- **It may ask first.** If the AI has already read text other people wrote in this session, a **markoto asks first** card appears above the prompt bar with **Allow** and **Deny**. [Why it asks](/docs/ai/prompt-bar#when-the-ai-asks-first).

## What's next

- [Ask the AI to read a specific URL](/docs/ai/fetch-url): skip search when you already know the source.
- [Ask the AI about a file you uploaded](/docs/ai/knowledge-rag): for facts that live inside your workspace, not on the open web.
