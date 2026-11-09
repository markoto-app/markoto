---
title: Team and Business for a workspace
description: How a workspace admin buys Team or Business per seat, adds seats, sees the shared AI budget and sets member limits. Only where paid plans are live.
category: account
order: 3
updated: '2026-11-09'
---

# Team and Business for a workspace

> **Availability.** Paid plans are **coming soon** on markoto.app and never
> exist on self-hosted instances. This page describes how Team and Business
> work where paid plans are switched on.

Team and Business are bought for a **workspace**, not for a person. You pay
per seat, and everyone in the workspace gets the plan inside it: the plan's
features, shared storage for knowledge files and images, and one AI budget
for the month that the whole workspace shares.

::flow{id="put-a-workspace-on-the-team-plan" mode="slides" hide-title}
::

## Buying

Only workspace admins see the **Billing** tab on the workspace page. Choose
Team or Business, monthly or annual (two months free), the currency (euros
or Swiss francs) and the number of seats. You need at least three seats, and
at least one seat for everyone already in the workspace, including people
you have invited who haven't accepted yet. **Continue to payment** opens
Stripe Checkout; the invoice names the workspace, and you become its
billing admin.

## Seats

Every member and every open invitation takes a seat. When all seats are
taken, inviting someone asks first: **This adds a seat**, charged pro rata
on the next invoice. If another admin adds a seat, the billing admin gets
an email. You can also change the number of seats on the Billing
tab. Fewer seats are credited on the next invoice, but there can never be
fewer seats than people in the workspace: remove someone first.

## The shared AI budget

The workspace's AI budget is the per-seat amount times the seats, for the
month. Each member's AI use inside the workspace comes out of it. By
default a member may use up to two seats' worth of it; an admin can set a
different limit per person, or none (the workspace budget still applies).
The Billing tab shows what the workspace and each member used this month.

Admins get an email when the workspace has used 80 % and 100 % of the
month's budget. When the budget or your own limit is used up, the AI tells
you and asks you to contact an admin. In your personal documents and in other workspaces you
use your own plan and budget, as before. Someone who isn't a member but
edits an open document of the workspace uses their own budget too.

## Storage

Knowledge files and images in the workspace's documents count against the
workspace's shared storage (per-seat amount times seats), not against the
uploader's personal storage.

## Changing or ending the plan

- **Switch to Business / Team** or **to annual / monthly billing** on the
  Billing tab. The change applies straight away, prorated.
- **Manage billing** opens Stripe's billing portal: invoices, payment
  method, cancelling.
- If a payment fails, admins get an email and see a notice in the
  workspace while Stripe retries. If the subscription ends, the workspace falls back to the plan
  of the person who created it. Nothing is deleted.
- Deleting the workspace cancels its subscription.
- If the billing admin deletes their account, the role passes to the
  longest-serving other admin. With no admin left, the subscription ends at
  the end of the period.

## What's next

- [Invite a teammate](/docs/workspaces/invite)
- [Plans and limits](/docs/account/plans)
- [Upgrade your plan](/docs/account/upgrade): Pro for yourself.
