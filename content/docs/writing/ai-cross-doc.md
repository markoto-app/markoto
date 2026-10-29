---
title: Ask the AI about another doc
description: Reference another document by URL or title - the AI reads it, within the access you already have, and uses it in its reply.
category: writing
order: 8
---

# Ask the AI about another doc

The AI can read another document you have access to. Reference one by URL
("summarise the meeting notes at /d/abc123") or by title ("pull in the spec
doc") and the AI fetches it and folds the content into its reply.

::flow{id="ask-the-ai-about-another-doc" hide-title}
::

## What just happened

The AI looked up the document you mentioned and read its markdown. It follows
the same rules you do: if you couldn't open that document yourself (it is
private, password-protected or in a workspace you aren't in), neither can the
AI. A link or document id works for any document you can open. To find a
document by title or topic, the AI browses the other documents in the
workspace the current document belongs to, so that part needs a workspace.

If the AI has already read text other people wrote in this session, it
asks first: a **markoto asks first** card appears above the prompt bar with
**Allow** and **Deny**. [Why it asks](/docs/writing/ai-prompt-bar#when-the-ai-asks-first).

## What's next

- [Ask the AI about a file you uploaded](/docs/writing/knowledge-rag): same idea for workspace knowledge files.
- [Ask the AI to read a URL](/docs/writing/ai-fetch-url): pull in any public page.
