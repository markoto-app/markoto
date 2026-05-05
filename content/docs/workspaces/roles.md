---
title: Roles inside a workspace
description: Three roles — admin, editor, viewer — gate edit, sharing, and management. Last-admin invariant prevents lockout.
category: workspaces
order: 2
---

# Roles inside a workspace

Every workspace member has one of three roles. **Admins** can do
everything; **editors** can write and create new docs but can't change
permissions; **viewers** are read-only across the whole workspace.

::flow{id="roles-inside-a-workspace" hide-title}
::

## What just happened

The role-edit UI pivots off `workspace_members.role` — three text-enum
values: `admin`, `editor`, `viewer`. Endpoints check the role through
`canEditDoc` / `canManageDoc` / `canManageWorkspace` helpers; mixing
those concerns leaks permissions, so each helper has exactly one
question to answer.

The **last-admin invariant** is enforced at the API level: demoting or
removing the only admin returns 409. This prevents accidental
self-lockout.

| Action | Viewer | Editor | Admin |
|---|:-:|:-:|:-:|
| Read docs | ✓ | ✓ | ✓ |
| Edit, create docs | — | ✓ | ✓ |
| Change access mode, password | — | — | ✓ |
| Delete docs | — | own only | any |
| Invite/remove members | — | — | ✓ |
| Rename/delete workspace | — | — | ✓ |

## What's next

- [Invite a teammate](/docs/workspaces/invite) — exact-email invite with role pick.
- [Sponsor AI for the team](/docs/workspaces/sponsor-ai) — admin-set, members benefit.
