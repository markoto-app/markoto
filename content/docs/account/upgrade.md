---
title: Upgrade to Pro
description: One click takes you to Stripe Checkout; the upgrade is live the moment the webhook fires.
category: account
order: 2
---

# Upgrade to Pro

Hit "Upgrade" anywhere in the app — the prompt-bar exhausted-budget
notice, the pricing page, the profile page — and you land in Stripe
Checkout. Pay; the webhook fires; the upgrade is reflected in your
account before you're back on the markoto tab.

::flow{id="upgrade-to-pro" hide-title}
::

## What just happened

`POST /api/billing/checkout` opens a Stripe Checkout session keyed on
your user id and the chosen tier. After payment, Stripe fires
`checkout.session.completed`, which the webhook handler dedups via
`processed_webhook_events` and applies. The handler also drains any
`pending_stripe_events` rows that arrived out of order (e.g. a
`subscription.created` that beat the checkout event).

Cancellation + plan management is handled the same way through
`/api/billing/portal` — opens a Stripe-hosted billing portal; the
webhook handles the rest.

## What's next

- [What you get on each plan](/docs/account/plans) — confirm you picked the right tier.
- [Sponsor AI for the team](/docs/workspaces/sponsor-ai) — only available Max+.
- [Hit the AI cap?](/docs/writing/ai-budget) — what triggered the upgrade flow.
