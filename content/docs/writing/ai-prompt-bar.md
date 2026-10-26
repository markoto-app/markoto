---
title: Write with the AI prompt bar
description: Ask the AI to draft, rewrite, or restructure - it joins your document as a collaborator and you watch it type.
category: writing
order: 4
icon: i-lucide-sparkles
---

# Write with the AI prompt bar

The AI bar floats at the bottom of every document. Type what you want, send
it, and the AI joins as another collaborator. It can draft new sections,
rewrite passages, restructure outlines, adjust the theme, leave comments,
look things up on the web and, if you've set it up, draw images. You watch
the edits land in real time, just like a human collaborator's.

You need to be signed in, and a writing assistant provider has to be
available: connect your own under [Settings -> AI provider](/docs/account/ai-provider)
(the key icon in the bar takes you there), or use the instance default if
there is one. See [what the AI needs](/docs/writing/ai-overview).

::flow{id="write-with-ai" hide-title}
::

## How it works

The AI reads your document, decides what to do and makes its edits directly
in the shared document, so collaborators see them live next to any edits of
their own, with no "wait for it to finish". Everything it changes shows in
the [activity log](/docs/history) as an AI edit, and you can undo or
[restore an earlier version](/docs/history/restore). While it works, the AI
appears in the presence bar with a status. You can stop it at any time.

It picks its tools turn by turn from your prompt; you don't tell it which
to use. Prompts can be dictated: with a transcription provider connected,
the microphone in the bar turns speech into a prompt.

## Tips for good prompts

- **Be specific about location**: "add at the end", "after the section about X", "rewrite the first paragraph".
- **Trust the document context.** Title, description, audience and language are sent on every prompt, so you don't need to repeat "this is a marketing piece" ([document context](/docs/writing/document-context)).
- **Iterate.** Short prompts that refine the previous turn beat one mega-prompt: "shorten that", "make it more formal", "add a code example".
- **Select first to scope it.** With text selected, the AI edits just that passage ([rewrite a selection](/docs/writing/ai-rewrite-selection)).
- **Use markdown's own tools.** Ask for a table, an alert, a Mermaid diagram or a table of contents; the AI knows the [markdown markoto renders](/docs/writing/markdown-reference).

## What's next

- [Summon the AI inside a comment](/docs/writing/ai-comments): ask about a specific passage and it replies on the thread.
- [What the AI can do, and what it needs](/docs/writing/ai-overview).
- [Discuss in your document](/docs/writing/comments).
