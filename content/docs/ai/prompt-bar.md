---
title: Write with the AI prompt bar
description: Ask the AI to draft, rewrite, or restructure - it joins your document as a collaborator and you watch it type.
category: ai
order: 2
icon: i-lucide-sparkles
updated: '2026-10-29'
---

# Write with the AI prompt bar

The AI bar floats at the bottom of every document. Type what you want, send
it, and the AI joins as another collaborator. It can draft new sections,
rewrite passages, restructure outlines, adjust the theme, leave comments,
look things up on the web and, if you've set it up, draw images. You watch
the edits land in real time, just like a human collaborator's.

You need to be signed in, and a writing assistant provider has to be
available: connect your own under [Settings → AI provider](/docs/ai/provider)
(the key icon in the bar takes you there), or use the instance default if
there is one. See [what the AI needs](/docs/ai/overview).

::flow{id="write-with-ai" hide-title}
::

## How it works

The AI reads your document, decides what to do and makes its edits directly
in the shared document, so collaborators see them live next to any edits of
their own, with no "wait for it to finish". Everything it changes shows in
the [activity log](/docs/import-export) as an AI edit. To take an edit back,
[restore the version from before it](/docs/import-export/restore); Cmd / Ctrl + Z
only undoes your own typing, not the AI's changes. While it works, the AI
appears in the presence bar as working; only you see what it is doing. You
can stop it at any time.

It picks its tools turn by turn from your prompt; you don't tell it which
to use. Prompts can be dictated: with a transcription provider connected,
the microphone in the bar turns speech into a prompt.

Your prompt, the AI's status and its answers are shown only to you.
Collaborators see that markoto is working for you, not what you asked or
what it is reading.

## When the AI asks first

Text written by other people (in a shared document, their comments, a web
page, someone else's knowledge file) could contain instructions aimed at
the AI. So once the AI has read such text in a session, it asks you
before it reaches beyond the document: reading or listing your other
documents, searching or opening workspace knowledge, creating or copying
a document, searching the web, or opening a web address you didn't type
yourself. A card above the prompt bar says exactly what it wants, for
example *markoto wants to read "Q3 plan"*, with **Allow** and **Deny**.

- **Allow** runs that one step; the same request isn't asked again in this session.
- **Deny**, or no answer within about a minute and a half, skips it. The AI carries on without it and tells you what it couldn't do.

In a private document only you have written, the AI never needs to ask.
What you type or dictate counts as yours, and so does text the AI wrote for
you, unless that session read a web page or someone else's text: such text
can carry hidden instructions, so the AI keeps asking first in that
document.

## Tips for good prompts

- **Be specific about location**: "add at the end", "after the section about X", "rewrite the first paragraph".
- **Trust the document context.** Title, description, audience and language are sent on every prompt, so you don't need to repeat "this is a marketing piece" ([document context](/docs/ai/document-context)).
- **Iterate.** Short prompts that refine the previous turn beat one mega-prompt: "shorten that", "make it more formal", "add a code example".
- **Select first to scope it.** With text selected, the AI edits just that passage ([rewrite a selection](/docs/ai/rewrite-selection)).
- **Use markdown's own tools.** Ask for a table, an alert, a Mermaid diagram or a table of contents; the AI knows the [markdown markoto renders](/docs/writing/markdown-reference).

## What's next

- [Summon the AI inside a comment](/docs/ai/comments): ask about a specific passage and it replies on the thread.
- [What the AI can do, and what it needs](/docs/ai/overview).
- [Discuss in your document](/docs/collaborate/comments).
