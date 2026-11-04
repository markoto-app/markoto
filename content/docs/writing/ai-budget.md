---
title: AI Points and what happens when you run out
description: AI Points are a monthly allowance that only applies when the instance pays for the AI. Calls on your own provider never use them.
category: writing
order: 12
---

# AI Points and what happens when you run out

**AI Points** are markoto's unit for AI that someone else pays for: 1000
points equal one US dollar of model usage. They only come into play when a
capability is paid for by the operator of the instance, that is, when the
operator set a default model with their own provider key.

- **Using your own provider** ([Settings -> AI provider](/docs/account/ai-provider)): your provider bills you directly and **nothing counts against AI Points**. There is no markoto-side cap on your own key.
- **Using an operator-paid default** (common on self-hosted instances): each person has a monthly allowance, set by the operator. It refills every 30 days.
- **On markoto.app** the writing assistant runs on the [free AI allowance](/docs/writing/ai-overview#the-free-ai-allowance-on-markotoapp) until you connect your own provider: 500 AI Points a month, refilled at the start of each month, while the shared monthly pool lasts.

The points meter in the top bar only appears when something you can do is
operator-paid. If you have both your own keys and an operator default, the
meter says that calls on your own key don't use points. If everything runs on
your own provider, the top bar shows **Your own AI provider** instead; click
it for a link to your provider settings. Either way, the panel that opens
also lists your [storage and workspace limits](/docs/account/plans#what-limits-a-plan-sets).

## When the allowance is used up

The AI bar says so plainly: no silent downgrade to a worse model and no
silent failure. It also writes a short note into the document where the AI
would have answered. What you can do:

- **Wait** until the next period starts and the allowance refills.
- On markoto.app the free allowance can also end for everyone at once when the shared monthly pool is used up; the AI bar then says *"This month's free AI allowance is used up"*. It comes back with the monthly refill, and your own provider keeps working in the meantime.
- **Connect your own provider** for the writing assistant; it is unaffected by the cap.
- **Ask the instance operator** to raise the allowance (the `TIER_FREE_LITELLM_BUDGET_USD` setting on a self-hosted instance).
- On markoto.app, paid plans with larger allowances are **coming soon** ([plans](/docs/account/plans)). Where paid plans are live, the AI bar shows an Upgrade button.

## Not the same as the safety limits

Each AI session also has fixed safety limits that protect against runaway
loops (at most 50 steps, 5 generated images, 10 web searches and 10 page
reads). They apply to everyone, on every provider, and are not tied to
points. A normal prompt uses a few steps.

## What's next

- [What the AI can do, and what it needs](/docs/writing/ai-overview)
- [Connect your own AI provider](/docs/account/ai-provider)
- [Plans](/docs/account/plans)
