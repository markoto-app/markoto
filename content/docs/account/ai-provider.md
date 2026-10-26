---
title: Use your own AI provider
description: Settings → AI provider. Connect your own Mistral, OpenAI or other OpenAI-compatible account for the writing assistant, images and voice.
category: account
order: 6
---

# Use your own AI provider

markoto's AI features can run on your own AI provider account. Open
**Settings → AI provider** (or the key icon in the AI prompt bar) and
connect a provider separately for each feature:

- **Writing assistant** — needed for every AI feature (the prompt bar,
  `@markoto` in comments, web-search summaries). The model must support
  tool calling.
- **Image generation** — optional. Without it the assistant doesn't
  create images.
- **Voice transcription** — optional. Turns on the microphone in the
  prompt bar. A Mistral key also turns on live dictation.

::flow{id="use-your-own-ai-provider" hide-title}
::

## What just happened

markoto checked the connection before saving: it sent a small test
request through the same path the assistant uses, so a wrong key or an
unknown model shows up right away. Your key is stored encrypted and is
never shown again — only its last four characters. Your provider bills
you directly for these calls; they don't use AI Points.

Your prompts, the relevant parts of your document and your recordings go
to the provider you chose, under your own agreement with it. Knowledge
base search, web search and page fetching always run on markoto's own
providers.

## Which providers work

Any service with an OpenAI-compatible API: Mistral AI, OpenAI,
OpenRouter, Groq, Together AI, DeepInfra, Fireworks AI, Scaleway and
more. On the hosted service you pick from that list. A self-hosted
markoto can also allow providers on your own network, such as Ollama.
