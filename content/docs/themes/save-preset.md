---
title: Save your custom theme as a preset
description: Once you've tuned a theme, save it — every new doc you create lists it next to the built-in presets.
category: themes
order: 3
---

# Save your custom theme as a preset

The six built-in theme presets (markoto, academic, business, casual,
report, slide) cover the common cases. Once you've customised one to
your liking, save it as a personal preset and it shows up in the
preset picker on every future doc.

::flow{id="save-your-custom-theme-as-a-preset" hide-title}
::

## What just happened

Saved presets live on your user account, not on the doc. The Theme tab
serializes the current theme JSONB, you give it a name, and the row
lands in the `themes` table keyed on `user_id`. The preset picker
queries it next to the built-ins so they're indistinguishable in the
UI — except that yours can be deleted from the picker and the
built-ins can't.

For shared team styling, you don't need to save personally — set the
preset as the [workspace default theme](/docs/workspaces/default-theme)
and every member sees it on every new doc.

## What's next

- [Set a workspace default](/docs/workspaces/default-theme) — same idea, but for a team.
- [Tune more knobs](/docs/themes/customize) — there's more to a theme than colors.
