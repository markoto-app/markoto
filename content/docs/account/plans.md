---
title: What you get on each plan
description: Free, Pro, Max, Ultra side-by-side — features, AI interactions per month, sponsoring eligibility.
category: account
order: 1
featured: true
---

# What you get on each plan

markoto's free plan is genuinely generous — anonymous + signed-in docs,
unlimited storage, every theme, every markdown extension, voice
dictation, the full agentic AI loop. The paid tiers raise the AI
budget and unlock workspace AI sponsoring.

::flow{id="what-you-get-on-each-plan" hide-title}
::

## What just happened

The pricing page is fed from `app/utils/pricing.ts` — single source of
truth for tier names, monthly costs, AI interaction caps, and feature
flags. The Stripe price ids per tier live in env (`NUXT_STRIPE_PRICE_*`)
so we can rotate prices without code changes.

What scales with the plan:
- **AI interactions per month** — Free: tight; Pro: comfortable; Max:
  generous; Ultra: enough that you'll never see the cap.
- **Workspace AI sponsoring** — Max + Ultra only. Lower tiers can have
  workspaces, but `(+)` AI sponsoring requires Max+.

What doesn't scale: every plan ships full editor features, full theme
system, full collaboration. We don't gate the writing experience on
the price tier.

## What's next

- [Upgrade to Pro](/docs/account/upgrade) — Stripe Checkout, instant credit.
- [Sponsor AI for the team](/docs/workspaces/sponsor-ai) — Max+ feature.
