---
title: Tell the AI who you're writing for
description: Set audience, language, and a one-line description once and every AI prompt picks them up automatically.
category: ai
order: 5
updated: '2026-11-04'
---

# Tell the AI who you're writing for

Every doc carries four context fields beyond the title: a description,
a target audience, a language, and the template it was created from.
The AI sees them on every prompt, so a minute spent setting them up
saves you re-typing context in every "rewrite this", "extend this" or
"draft a section" prompt.

This walkthrough sets the audience to **Marketing**, the language to
**Deutsch**, and a one-line description, then asks the AI to write a
welcome intro. The AI returns marketing-tone Deutsch, without the
prompt mentioning audience or language.

::flow{id="tell-the-ai-who-you-re-writing-for" hide-title}
::

## What just happened

The Document tab in the right sidebar exposes three editable fields
that the AI reads on every turn:

- **Description**: one line that tells the AI what this document IS.
  Free text, ≤500 chars.
- **Audience**: one of six writing registers (technical, marketing,
  academic, casual, business, creative), each with its own tone. It is
  a fixed list on purpose: audience is for the durable tone of the whole
  document, while one-off steering ("make this friendlier") belongs in
  your prompt.
- **Language**: free text with a few presets, so even "Romansh" works.
  The AI is told to write all prose in that language.

These fields are sent along with the title on every prompt. That's why
the AI shifted languages without you mentioning the language in your
prompt.

## What's next

- [Pick a theme that matches the audience](/docs/themes/pick-a-theme).
- [Ask the AI about a file you uploaded](/docs/ai/knowledge-rag).
