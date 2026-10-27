---
title: Start a workspace
description: Create a workspace, name it, and pick its default theme — your shared home for team docs.
category: workspaces
order: 1
featured: true
---

# Start a workspace

A workspace is the unit of team collaboration: shared docs, shared
themes, shared knowledge base, member roles. You don't need a
workspace to write a doc (anonymous + personal docs are fine), but
the moment you want a teammate to see your shelf instead of just one
URL — start a workspace.

::flow{id="start-a-workspace" hide-title}
::

## What just happened

The "New workspace" dialog inserts a row in `workspaces` with you as
both `owner_id` and `billing_owner_id`, plus a `workspace_members` row
making you the first admin. The DPA acceptance modal fires here — DPA
is workspace-owner-only, and creating a workspace is the moment the
B2B contract relationship comes into existence.

You're capped at 20 owned workspaces per user (invited workspaces
don't count toward the cap).

## What's next

- [Invite a teammate](/docs/workspaces/invite) — invite by email; they join once they accept.
- [Roles inside a workspace](/docs/workspaces/roles) — what each role can do.
- [Set a default theme](/docs/workspaces/default-theme) — every new doc starts styled to your team.
