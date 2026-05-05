---
title: Set a default theme for your workspace
description: Pick a theme as the workspace default — every new doc your team creates starts already styled.
category: workspaces
order: 6
---

# Set a default theme for your workspace

Once your team has tuned a theme that matches your brand, set it as
the workspace default. Every new doc anyone creates inside the
workspace starts with that theme already applied. Members can still
override per-doc; the default is the starting point, not a constraint.

::flow{id="set-a-default-theme-for-your-workspace" hide-title}
::

## What just happened

Workspace admins see a "Default theme" picker on the workspace
settings page that lists the built-in presets, the admin's saved
personal presets, and the current workspace default. The choice
writes to the workspace row and is read by the new-doc API — the
seeded `theme` JSONB on a fresh doc inside the workspace pulls from
the workspace default rather than the global default.

Existing docs aren't retroactively re-themed. The workspace default
applies only to docs created AFTER it was set.

## What's next

- [Save your own preset](/docs/themes/save-preset) — admins can promote a personal preset to workspace default.
- [Tune the underlying theme](/docs/themes/customize) — find the look first, then promote.
