---
title: Roles inside a workspace
description: Three roles (admin, editor, viewer) decide who can edit, share and manage. A workspace always keeps at least one admin.
category: workspaces
order: 2
updated: '2026-10-29'
---

# Roles inside a workspace

Every workspace member has one of three roles. **Admins** can do
everything; **editors** can write and create new docs but can't change
permissions; **viewers** are read-only across the whole workspace.

::flow{id="roles-inside-a-workspace" hide-title}
::

## What just happened

Admins change a member's role from the members panel; the change applies
the next time that member opens a workspace document.

A workspace always keeps at least one admin: markoto refuses to demote
or remove the last one, so nobody can lock the team out by accident.

| Action | Viewer | Editor | Admin |
|---|:-:|:-:|:-:|
| Read docs | ✓ | ✓ | ✓ |
| Edit, create docs | - | ✓ | ✓ |
| Change access mode, password | - | own only | any |
| Delete docs | - | own only | any |
| Invite/remove members | - | - | ✓ |
| Rename/delete workspace | - | - | ✓ |

## What's next

- [Invite a teammate](/docs/workspaces/invite): invite by email; they join once they accept.
- [Plans](/docs/account/plans): the Team plan covers every member of a workspace.
