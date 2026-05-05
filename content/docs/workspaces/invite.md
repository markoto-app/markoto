---
title: Invite a teammate to your workspace
description: Type their exact email, pick a role, send. They sign in and the workspace appears in their sidebar.
category: workspaces
order: 3
---

# Invite a teammate to your workspace

Invites are exact-email — markoto won't typeahead, won't auto-suggest.
That's deliberate: typeahead would let an attacker enumerate registered
users by typing letters and watching what surfaces. The flip side is
you have to type the email exactly; no fuzzy matching.

::flow{id="invite-a-teammate-to-your-workspace" hide-title}
::

## What just happened

`POST /api/workspaces/:wsId/members` resolves the email to a `users.id`
exactly (404 if no such user, 409 if they're already a member, 403 if
you're not an admin), then inserts a `workspace_members` row with
`role='editor'` by default.

The invitee doesn't get a notification email today — they see the
workspace appear in their sidebar next time they sign in. (Email
invites are on the roadmap.)

## What's next

- [Pick the right role](/docs/workspaces/roles) — admin / editor / viewer side-by-side.
- [Sponsor their AI usage](/docs/workspaces/sponsor-ai) — billing follows the workspace owner, not the member.
