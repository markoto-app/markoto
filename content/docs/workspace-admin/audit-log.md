---
title: Audit log of a workspace
description: See and download who changed what in a workspace (members, invitations, sharing, deletions, billing and single sign-on) as a workspace admin.
category: workspace-admin
order: 3
updated: '2026-11-25'
---

# Audit log of a workspace

> **Availability.** On markoto.app the audit log is part of the **Business**
> plan. On a self-hosted instance every workspace has it.

Workspace admins find the **Audit log** tab on the workspace page. It lists,
newest first, the security-relevant things that happened in the workspace:

- members removed and roles changed, invitations sent, withdrawn, accepted
  or declined;
- sharing changes, passwords set or removed, documents moved out or deleted;
- plan, seats, billing admin and member AI limits;
- single sign-on: settings, domains, sign-ins, members joined or removed by
  provisioning;
- downloads of the audit log itself.

::flow{id="see-who-changed-what-in-a-workspace" hide-title}
::

Each entry shows when it happened, what happened and who did it, plus the
person's network address with the last part removed (for example
`203.0.113.0`). Click an entry to see its details. Edits to the text of a
document are not in the audit log; they are in the document's
[history](/docs/import-export/see-changes).

## Filter and download

Choose a kind of event and a date range to narrow the list. **CSV** downloads
the selected events as a spreadsheet file; **JSON Lines** gives one JSON
object per line for your own tools or a SIEM. A download covers at most
100 000 events; choose a shorter period for more. Every download is itself
recorded in the audit log.

## How long entries are kept

Entries are kept for two years (on a self-hosted instance: as long as the
operator configured) and then deleted automatically. The page shows the
current period. The audit log can't be edited or shortened by workspace
admins.

## What's next

- [Single sign-on for a workspace](/docs/workspace-admin/single-sign-on).
- [Team and Business for a workspace](/docs/plans/team-plan).
