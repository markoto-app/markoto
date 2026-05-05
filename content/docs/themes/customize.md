---
title: Tune your typography and colors
description: Open the Theme tab and tweak fonts, colors, page geometry, header/footer tokens — see the preview repaginate live.
category: themes
order: 2
---

# Tune your typography and colors

Pick-a-theme gets you 80% of the way; the Theme tab is where you go
when you want the other 20%. Eleven sections — typography, colors,
page geometry, headers, footers, code blocks, callouts, tables,
lists, table of contents, mermaid diagram theme — every change drives
both the live preview AND the PDF export.

::flow{id="tune-your-typography-and-colors" hide-title}
::

## What just happened

The Theme tab is an in-doc editor for a JSONB column on the document.
Each change goes through `themeToCss()` (the single function that
drives both preview and export), broadcasts to other live editors via
the `ymeta.theme` Y.js field, and validates server-side against the
font allowlist + numeric ranges.

Changing the theme is a tracked activity — the row in the activity
log carries the theme diff so you can revert with the same Restore
machinery as any other edit.

## What's next

- [Save what you tuned as a preset](/docs/themes/save-preset) — reuse on the next doc with one click.
- [Set it as your workspace default](/docs/workspaces/default-theme) — every new workspace doc inherits it.
- [Edit the cover page](/docs/themes/cover-page) — the front-page treatment is its own subsection.
