---
title: What the AI can do, and what it needs
description: A map of markoto's AI features - which need a provider you connect, what leaves your document and what it costs, on markoto.app and self-hosted.
category: ai
order: 1
icon: i-lucide-sparkles
featured: true
updated: '2026-11-25'
---

# What the AI can do, and what it needs

markoto's assistant works in your document like another collaborator: you
ask, it reads the page, edits it, and you watch the changes appear. This page
is the map. Each row links to a walkthrough.

## The features

| Feature | What it does | What it needs |
|---|---|---|
| [Prompt bar](/docs/ai/prompt-bar) | Draft, rewrite, restructure, add sections | A **writing assistant** provider |
| [Rewrite a selection](/docs/ai/rewrite-selection) | Select text, say what you want, it is replaced in place | A writing assistant provider |
| [Long documents](/docs/ai/long-documents) | Answers from the right section of a long document; renames a term everywhere in one edit | A writing assistant provider |
| [Translate or restyle a whole document](/docs/ai/document-jobs) | Works through many sections in the background, with an estimate first and one-step undo | A writing assistant provider |
| [`@markoto` in comments](/docs/ai/comments) | Ask about one passage; the answer lands in the thread | A writing assistant provider |
| [Look at another document](/docs/ai/cross-doc) | Reads other documents you can open | A writing assistant provider |
| [Workspace knowledge](/docs/ai/knowledge-rag) | Answers from files uploaded to a workspace | A writing assistant provider, and the instance's embeddings |
| [Web search](/docs/ai/web-search) | Current facts with cited sources | A writing assistant provider (for the summary) and web search enabled on the instance |
| [Read a URL](/docs/ai/fetch-url) | Summarises a page you link | A writing assistant provider and page fetching enabled on the instance |
| [Draw an image](/docs/ai/generate-image) | Generates an image and inserts it | An **image** provider |
| Voice prompt (microphone in the prompt bar) | Say your prompt instead of typing it | A **voice transcription** provider |
| [Live dictation](/docs/writing/voice-dictate) | Streams speech into the editor as you talk | A Mistral transcription provider |
| [Connected apps (MCP)](/docs/ai/mcp) | Claude Desktop, Cursor or scripts use the same document tools | A personal access token; the writing assistant is not involved |

You need to be signed in to use AI. If a capability isn't available, its
button is hidden or the AI bar tells you what to add. Nothing else in markoto
depends on AI.

## Where the provider comes from

For each of the three capabilities (writing assistant, image, voice
transcription) markoto picks, in this order:

1. **Your own provider**, connected under **Settings → AI provider** ([how](/docs/ai/provider)). Calls go to your account at that provider and are billed there.
2. **The instance default**, if whoever runs this markoto set one. On a self-hosted instance that is the operator's choice (including a local model). On markoto.app it is the **free AI allowance** for the writing assistant (see below); image generation and voice input are included from Pro up, and on the free plan need your own provider.
3. Otherwise the capability is unavailable.

On a self-hosted instance the AI may already work, or you connect your own.

## The free AI allowance on markoto.app

Signed in on markoto.app, the writing assistant works without a key of your
own: every account gets a monthly free allowance (500 AI Points, about 80 to 100
typical requests) on a model hosted by Mistral AI in the EU. It covers the
prompt bar, selection rewrite, `@markoto` in comments and the summaries of web
search and fetched pages.

- The allowance refills at the start of each month. The points meter in the top bar shows what is left.
- It is shared: all free accounts together have a monthly pool, and the allowance is available while that pool lasts. If it runs out before the month ends, the AI bar says *"This month's free AI allowance is used up"* and links to **Settings → AI provider**.
- Connect your own provider at any time and it is used instead; your own key is never limited by the allowance or the pool.

## What markoto provides itself

A few things are not tied to your own key:

- **Knowledge-base embeddings**, so uploaded files can be searched.
- **Web search and page fetching.** The instance pays for the search or page extraction, so each user gets an allowance (by default 30 calls an hour and 100 a day, or 20 a day on markoto.app's free plan, shared by the editor AI and connected apps). Summarising the results runs on your writing assistant provider. If your instance has no search or fetch key, the AI doesn't offer those tools.

## What leaves your document

When you use AI, your prompt and the parts of the document the assistant
reads are sent to the provider that handles the request: your own provider
if you connected one, otherwise the instance default. Web search sends the
search query to the instance's search provider, and page fetching sends the
URL. Knowledge uploads are converted and embedded by the instance's
embeddings provider. Nothing is sent anywhere unless you use one of these
features. On markoto.app the platform-side providers (embeddings, search,
page extraction) are located in the EU.

## Cost and limits

- On **your own provider**, your provider bills you and AI Points don't apply to those calls.
- **Web search and page reading** are always paid for by the instance, so they use AI Points for everyone: 5 points per search, 1 point per page.
- **AI Points** only exist when a capability is paid for by the instance operator (an instance default). They are a monthly allowance per person; see [What happens when you run out](/docs/plans/ai-budget).
- Every AI session has safety limits against runaway loops (for example at most 5 generated images and 10 web searches per session).

## What's next

- [Connect your own AI provider](/docs/ai/provider)
- [Write with the AI prompt bar](/docs/ai/prompt-bar)
- [Use the AI from Claude Desktop or Cursor](/docs/ai/mcp)
