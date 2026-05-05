---
title: Ask the AI to draw an image
description: Describe what you want — the AI generates it, uploads it to your doc, and inserts the markdown image link.
category: writing
order: 11
---

# Ask the AI to draw an image

Need a hero image, a diagram, a quick illustration? Ask the AI. The
`generate_image` tool routes the prompt through Gemini's image model,
uploads the result to S3 under your doc's prefix, and inserts the
markdown image at the cursor — same flow as if you'd drag-dropped a
file in.

::flow{id="ask-the-ai-to-draw-an-image" hide-title}
::

## What just happened

The AI called `generate_image` with the description you gave. The
generated image is uploaded to `docs/{docId}/{fileId}.png` (same
S3 prefix as user uploads), and the AI then writes the
`![alt text](/api/files/{docId}/{fileId})` markdown into your doc.

Each generation counts as 5 interactions on your AI budget — the
costs are higher than text-only calls. Hard cap of 4 images per
session prevents the AI from looping on "more, but better" requests.

## What's next

- [Drop in your own image](/docs/import-export/import-existing) — same upload pipeline, drag-and-drop or paste.
- [Hit the AI cap?](/docs/writing/ai-budget) — what happens when you run out of interactions.
