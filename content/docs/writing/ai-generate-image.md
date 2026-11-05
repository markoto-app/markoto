---
title: Ask the AI to draw an image
description: Describe what you want - the AI generates it, stores it with your document and inserts the markdown image.
category: writing
order: 11
updated: '2026-11-02'
---

# Ask the AI to draw an image

Need a hero image or a quick illustration? Ask the AI. It generates the image
from your description, stores it with your document like any uploaded image,
and inserts it where it belongs, the same result as dragging a file in.
(For diagrams, ask for a Mermaid diagram instead: it stays editable text.)

::flow{id="ask-the-ai-to-draw-an-image" hide-title}
::

## What just happened

The AI wrote an image prompt from your request, sent it to the image provider,
saved the result as an image of your document, and added the markdown image
with a caption. You can resize it with `{width=50%}` like any other image
([Markdown reference](/docs/writing/markdown-reference#images)).

## Good to know

- **Image generation is optional and needs its own provider.** Connect one under [Settings -> AI provider](/docs/account/ai-provider) (for example OpenAI's image models), or use the instance default if there is one. Without an image provider the AI doesn't offer to draw.
- **Cost.** On your own provider, that provider bills you for each image. If the instance operator pays for the default image model, each image uses [AI Points](/docs/writing/ai-budget).
- **At most 5 images per AI session**, so a prompt like "more, but better" can't run away.
- **Images use your storage.** Generated images count toward your image storage, like the images you upload (100 MB on the free plan at markoto.app; a self-hosted instance sets its own limit). Your profile page shows how much you use. When it's full, new images are refused; images you remove from your documents free up space once they are cleaned up.
- Generated images are stored with your document and removed with it.

## What's next

- [Drop in your own image](/docs/writing/markdown-reference#images): drag-and-drop or paste works in the editor.
- [Markdown reference](/docs/writing/markdown-reference#images): image sizing and captions.
