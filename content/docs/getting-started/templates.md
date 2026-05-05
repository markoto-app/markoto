---
title: Start from a template
description: Pick a template at create time — markoto seeds your doc with structure, styling, and AI-context defaults.
category: getting-started
order: 4
---

# Start from a template

The "New document" dialog includes a template picker. Each template is
a multi-language markdown skeleton with an audience hint and a
suggested theme — picking one drops you into a doc that's already got
the bones of what you're writing.

::flow{id="start-from-a-template" hide-title}
::

## What just happened

The template registry (`shared/templates/`) ships a few starting
shapes: blank, blog post, technical spec, meeting notes, academic
paper, lecture handout. Each has its own markdown skeleton localised
to the target language. The picker passes the template id to the
new-doc API, the server reads the matching `<id>/<locale>.md`, and the
doc is created with that body, the template's audience hint, and the
suggested theme already applied.

You can change any of it after the fact — the template is a starting
point, not a constraint.

## What's next

- [Tell the AI who you're writing for](/docs/writing/document-context) — the audience field carries through every AI prompt.
- [Pick a theme](/docs/themes/pick-a-theme) — swap the suggested theme for one that matches the audience.
