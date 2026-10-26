---
title: Tables, alerts, math, and diagrams
description: Markdown that's not just headings and lists — code with syntax highlighting, KaTeX math, alert callouts, Mermaid diagrams.
category: writing
order: 3
featured: true
---

# Tables, alerts, math, and diagrams

Plain markdown gets you headings, lists, and links. markoto extends
that with the things people actually need to publish real documents —
syntax-highlighted code, KaTeX math, GitHub-style alert callouts, and
eight kinds of Mermaid diagram. Everything renders in the live preview
and survives PDF export.

This walkthrough drops one of each into a fresh doc. About one minute.
Desktop only — the Insert menu is in the menubar (hidden on mobile);
mobile editors get a subset via the bottom Editor drawer instead.

::flow{id="rich-content" hide-title}
::

## What just happened

You used the Insert menu to add four non-trivial markdown extensions:

- **A code block** with a Python language hint. highlight.js loads the
  appropriate stylesheet from CDN; languages with grammars baked in
  pick up keyword + string highlighting automatically.
- **A GitHub-style "Tip" alert.** Five flavours (Note, Tip, Important,
  Warning, Caution) each have their own coloured stripe + icon.
- **A KaTeX block equation.** Inline math (`$...$`) and block math
  (`$$...$$`) both render in the preview the moment you finish
  typing.
- **A Mermaid pie chart.** Eight diagram kinds — flowchart, sequence,
  class, ER, Gantt, pie, mind-map, state. The Insert menu seeds a
  working starter snippet for each so you don't need to learn
  Mermaid's syntax cold.

## What's next

- [Markdown reference](/docs/writing/markdown-reference) — the full syntax list, including attributes, images and footnotes.
- [Have a discussion in your document](/docs/writing/comments) — comment on a passage you just wrote.
- [Pick a theme](/docs/themes/pick-a-theme) — make the rendered output look the part.
