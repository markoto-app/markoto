---
title: Sponsor AI for your team
description: Toggle "AI on" for your workspace — every member's AI usage bills against your plan, not theirs.
category: workspaces
order: 5
---

# Sponsor AI for your team

By default, AI usage bills to whoever runs the prompt — your AI cap
counts your prompts, your teammate's cap counts theirs. For teams
where one person upgrades to Max or Ultra and wants to share, **AI
sponsoring** flips that: the workspace owner's plan covers everyone's
AI calls inside the workspace.

::flow{id="let-your-team-use-the-ai-on-your-dime" hide-title}
::

## What just happened

The workspace settings page has an "AI for the team" toggle (only
admins see it; only Max / Ultra owners can flip it on). When enabled,
`workspaces.ai_enabled = true` and `billing_owner_id` points at the
admin who turned it on. From then on, every AI prompt run inside the
workspace is attributed to `workspace:{wsId}` instead of
`user:{userId}` in the billing resolver.

The toggle auto-disables if the billing owner's plan lapses or
downgrades — the resolver checks the owner's `(plan, planValidUntil)`
on every call so a state change is reflected immediately. No
surprise charges, no surprise lockouts.

The `(+)` badge next to AI features inside the workspace is the
visible signal: "this is sponsored, your personal cap doesn't apply."

## What's next

- [Plans side-by-side](/docs/account/plans) — see which plans can sponsor.
- [Hit the AI cap?](/docs/writing/ai-budget) — sponsored AI never hits a member's personal cap.
