---
title: Use your own AI provider
description: Settings → AI provider. Connect your own Mistral, OpenAI or other OpenAI-compatible account for the writing assistant, images and voice.
category: ai
order: 11
updated: '2026-11-15'
---

# Use your own AI provider

markoto's AI features can run on a provider account you connect. On
markoto.app the writing assistant also works without one, on a monthly
[free AI allowance](/docs/ai/overview#the-free-ai-allowance-on-markotoapp);
your own key takes over as soon as you add it, with no allowance or pool
limits. Images and voice need your own provider there. Self-hosted instances
work the same way, with whatever defaults the operator set ([what the AI
needs](/docs/ai/overview)).

Open **Settings → AI provider** (at `/settings/ai`, or the key icon in the AI
prompt bar) and connect a provider separately for each capability:

| Capability | Used for | Needed? |
|---|---|---|
| **Writing assistant** | The prompt bar, selection rewrite, `@markoto` in comments, and summaries of web search and fetched pages. The model must support **tool calling**. | Only if the instance has no default (on markoto.app: optional, the free allowance covers it) |
| **Image generation** | Lets the assistant create images. Uses the provider's OpenAI-compatible images API. | Optional. Without it the assistant doesn't draw. |
| **Voice transcription** | The microphone in the prompt bar. A **Mistral** key also turns on [live dictation](/docs/writing/voice-dictate). | Optional. Without it the microphone is hidden. |

::flow{id="use-your-own-ai-provider" hide-title}
::

## Connecting a provider

1. Pick a provider from the list (the base URL fills in), or choose **Other (OpenAI-compatible)** and enter the provider's API root, usually ending in `/v1`.
2. Enter a model id (the provider's name for the model; suggestions appear for the preset providers) and your API key.
3. For the writing assistant, tick **This model accepts images** if it can read images.
4. Press **Save and verify**.

markoto verifies the connection before relying on it, through the same path
the assistant uses:

- **Writing assistant:** a tiny request with a test tool. If the model answers without calling the tool you get a warning, because the assistant needs tool calling. Pick another model.
- **Voice transcription:** half a second of silence is transcribed (a fraction of a cent on your account).
- **Image generation:** no image is generated, since that would cost money on every save. markoto checks your key against the provider's model list instead.

The verify message tells you what went wrong: the key was rejected, the model
id is unknown, the provider can't be reached, or the URL isn't allowed.

## Which providers work

Any service with an OpenAI-compatible API. The settings page offers presets
for Mistral AI, OpenAI, OpenRouter, Groq, Together AI, DeepInfra, Fireworks AI
and Scaleway. Model suggestions and tested recommendations are in the
[AI models guide](https://github.com/markoto-app/markoto/blob/main/docs/AI-MODELS.md#recommended-models-for-bring-your-own-key).
Tips:

- The writing assistant needs **reliable tool calling** and works best at temperature 0. Mistral Small 4 is the model we test with.
- **Image generation** works with providers that offer an OpenAI-style images endpoint (for example OpenAI's `gpt-image-1`).
- **Transcription** works with providers that offer an OpenAI-style audio transcription endpoint (for example Mistral's `voxtral-mini-2602`, OpenAI's `gpt-4o-mini-transcribe`, Groq's Whisper).
- On a **self-hosted** instance the operator can also allow providers on the local network, such as **Ollama**; the page then says so. Without that setting, private addresses are refused.

## Fast or strong model

Where markoto's own AI runs your chat (you haven't added a chat key), the
page offers **Fast** and **Strong**. Fast answers quickly and uses less of
your AI budget; Strong is better at long, careful writing and tricky edits
and uses more. The strong model, image generation and voice input on
markoto's AI depend on your plan: where your plan doesn't include them,
the controls show a lock and explain how to get them. Your own key always
works for them.

## What happens to your key and your data

- Your key is stored encrypted and never shown again; you only see the host and its last four characters. It isn't included in your data export, and it is deleted with your account.
- Your prompts, the relevant parts of your document and your recordings go to the provider you chose, under your own agreement with that provider.
- Your provider bills you for these calls. They never use AI Points ([AI Points](/docs/plans/ai-budget)).
- Knowledge-base search, web search and page fetching always run on the instance's own providers ([what the AI needs](/docs/ai/overview)). Web search (5 AI Points per search) and page reading (1 AI Point per page) count against your AI Points even with your own key.

## If something doesn't work

| Message | What to check |
|---|---|
| "The provider rejected the API key" | The key, and that it belongs to that provider. |
| "The provider doesn't know this model id" | Model ids differ per provider; copy it from the provider's model list. |
| "This model didn't call the test tool" | Choose a model with tool calling. |
| "This URL is not allowed" / "not allowed on this instance" | Pick one of the listed providers; some instances restrict the list. Plain `http` is only for private-network providers on self-hosted instances. |
| The AI bar still says "Add your API key" | Save a provider for the **writing assistant**; the other two are optional. |

## What's next

- [What the AI can do, and what it needs](/docs/ai/overview)
- [Write with the AI prompt bar](/docs/ai/prompt-bar)
